import { EventEmitter } from 'node:events';
import { TcpConnection } from '../transport/tcp-connection.js';
import { parseResponse } from './protocol.js';
import { PositionEstimate } from './position.js';

export class GrblError extends Error {
  constructor(code, message, command) {
    super(`error:${code} (${message}) for "${command}"`);
    this.name = 'GrblError';
    this.code = code;
    this.command = command;
  }
}
export class ConnectionLostError extends Error {
  constructor(message = 'Connection to plotter lost') {
    super(message);
    this.name = 'ConnectionLostError';
  }
}
export class CancelledError extends Error {
  constructor(command) {
    super(`"${command}" was not sent (cancelled)`);
    this.name = 'CancelledError';
  }
}
export class CommandTimeoutError extends Error {
  constructor(command, ms) {
    super(`No response to "${command}" within ${Math.round(ms / 1000)}s`);
    this.name = 'CommandTimeoutError';
  }
}

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];
export const STREAMING_MODES = ['send-response', 'char-count'];
const DEFAULT_RX_BUFFER = 128; // GRBL's serial receive buffer on an ATmega328 (Uno/Nano)

/**
 * Talks to a GRBL-compatible controller. Two flow-control modes:
 *
 *  - 'send-response' (default): one line in flight; the next is written after `ok` / `error:N`.
 *    Works with anything that answers each line, but every line costs a network round trip.
 *  - 'char-count': GRBL's recommended streaming protocol. Lines are written as long as the bytes
 *    not yet acknowledged fit in the controller's receive buffer, so its planner never runs dry.
 *    `ok`/`error` replies arrive in order, so each one settles the oldest line in flight.
 *    `$` system commands (except `$J=`) are always sent alone, as GRBL requires.
 *
 * Events:
 *  'state'   connection state changed (snapshot())
 *  'log'     { dir: 'tx'|'rx'|'info'|'error', text, source }
 *  'status'  parsed '<...>' status report
 *  'alarm'   { code, message }
 *  'reset'   controller printed its welcome banner (rebooted or soft reset)
 */
export class GrblController extends EventEmitter {
  /** @type {Array<{line: string, source: string, bytes: number, exclusive: boolean, resolve: Function, reject: Function}>} */
  #queue = [];
  /** Lines written but not yet answered, oldest first. */
  #sent = [];
  #sentBytes = 0;
  #timer = null;
  #reconnectTimer = null;
  #reconnectAttempt = 0;
  #wco = { x: 0, y: 0, z: 0 };
  #address = null;
  #pollTimer = null;
  #position = new PositionEstimate();
  #estimateTimer = null;
  #lastStatusAt = 0;

  constructor({
    connection = new TcpConnection(),
    lineTimeoutMs = 300_000,
    reconnectDelaysMs = RECONNECT_DELAYS_MS,
    streaming = 'send-response',
    rxBufferSize = DEFAULT_RX_BUFFER,
  } = {}) {
    super();
    this.streaming = streaming;
    this.rxBufferSize = rxBufferSize;
    this.connection = connection;
    this.lineTimeoutMs = lineTimeoutMs;
    this.reconnectDelaysMs = reconnectDelaysMs;
    /** @type {'disconnected'|'connecting'|'connected'|'reconnecting'} */
    this.state = 'disconnected';
    this.target = null;
    this.autoReconnect = false;
    this.lastError = null;
    this.machine = null; // last status report
    this.statusPollMs = 0; // send '?' periodically (only if the firmware supports it)

    connection.on('line', (line) => this.#onLine(line));
    connection.on('error', (err) => this.#log('error', `TCP error: ${err.message}`));
    connection.on('close', ({ expected }) => this.#onClose(expected));
  }

  get isConnected() {
    return this.state === 'connected';
  }

  snapshot() {
    return {
      state: this.state,
      target: this.target,
      autoReconnect: this.autoReconnect,
      lastError: this.lastError,
      machine: this.machine,
      statusPollMs: this.statusPollMs,
      streaming: this.streaming,
      rxBufferSize: this.rxBufferSize,
      queued: this.#queue.length + this.#sent.length,
    };
  }

  /**
   * @param {string} host shown to the user
   * @param {number} port
   * @param {{autoReconnect?: boolean, address?: string}} [opts] address: resolved IP to dial
   */
  async connect(host, port, { autoReconnect = true, address = host, statusPollMs = this.statusPollMs, streaming, rxBufferSize } = {}) {
    if (this.state === 'connected' || this.state === 'connecting') {
      throw new Error(`Already ${this.state}`);
    }
    this.#cancelReconnect();
    this.target = { host, port };
    this.#address = address;
    this.autoReconnect = autoReconnect;
    this.statusPollMs = statusPollMs;
    if (streaming !== undefined || rxBufferSize !== undefined) this.setStreaming({ streaming, rxBufferSize });
    this.#setState('connecting');
    try {
      await this.connection.connect(address, port);
    } catch (err) {
      this.lastError = err.message;
      this.#setState('disconnected');
      this.#log('error', `Could not connect to ${host}:${port}: ${err.message}`);
      throw err;
    }
    this.lastError = null;
    this.#reconnectAttempt = 0;
    this.#position.reset();
    this.#lastStatusAt = 0;
    this.#setState('connected');
    this.#log('info', `Connected to ${host}:${port}`);
    this.#emitEstimate();
  }

  disconnect() {
    this.autoReconnect = false;
    this.#cancelReconnect();
    const wasOpen = this.state !== 'disconnected';
    this.connection.disconnect();
    if (this.state !== 'disconnected') {
      this.#failAll(new ConnectionLostError('Disconnected'));
      this.#setState('disconnected');
    }
    if (wasOpen) this.#log('info', 'Disconnected');
  }

  /**
   * @param {{streaming?: string, rxBufferSize?: number}} opts
   */
  setStreaming({ streaming, rxBufferSize } = {}) {
    if (streaming !== undefined) {
      if (!STREAMING_MODES.includes(streaming)) throw new Error(`streaming must be one of ${STREAMING_MODES.join(', ')}`);
      this.streaming = streaming;
    }
    if (rxBufferSize !== undefined) {
      const n = Math.trunc(Number(rxBufferSize));
      if (!(n >= 16 && n <= 16384)) throw new Error('rxBufferSize must be between 16 and 16384');
      this.rxBufferSize = n;
    }
    this.emit('state', this.snapshot());
    this.#pump();
  }

  /**
   * Queue a line; resolves when the controller acknowledges it with `ok`.
   * @param {string} line already cleaned G-code / $ command
   * @param {{source?: string}} [opts]
   */
  send(line, { source = 'manual' } = {}) {
    if (!this.isConnected) return Promise.reject(new ConnectionLostError('Plotter not connected'));
    return new Promise((resolve, reject) => {
      const bytes = Buffer.byteLength(line) + 1; // + '\n'
      const exclusive = line.startsWith('$') && !line.startsWith('$J=');
      this.#queue.push({ line, source, bytes, exclusive, resolve, reject });
      this.#pump();
    });
  }

  /** Drop queued lines that have not been written yet (e.g. when a job pauses). */
  cancelQueued(source) {
    const keep = [];
    for (const item of this.#queue) {
      if (source === undefined || item.source === source) item.reject(new CancelledError(item.line));
      else keep.push(item);
    }
    this.#queue = keep;
  }

  /** Write a realtime command byte immediately, bypassing the queue. */
  realtime(byte) {
    if (!this.isConnected) throw new ConnectionLostError('Plotter not connected');
    this.connection.write(byte);
    const names = { '!': 'feed hold', '~': 'cycle start/resume', '?': 'status', '\x18': 'soft reset' };
    if (byte !== '?') this.#log('tx', `[${names[byte] ?? JSON.stringify(byte)}]`);
    if (byte === '\x18') this.#failAll(new ConnectionLostError('Soft reset'));
  }

  /** Can the next queued line be written now? */
  #canSend(item) {
    if (!this.#sent.length) return true;
    if (this.streaming !== 'char-count') return false;
    if (item.exclusive || this.#sent[this.#sent.length - 1].exclusive) return false;
    return this.#sentBytes + item.bytes <= this.rxBufferSize;
  }

  #pump() {
    while (this.#queue.length && this.isConnected && this.#canSend(this.#queue[0])) {
      const item = this.#queue.shift();
      try {
        this.connection.write(item.line + '\n');
      } catch (err) {
        item.reject(new ConnectionLostError(err.message));
        return;
      }
      this.#sent.push(item);
      this.#sentBytes += item.bytes;
      this.#log('tx', item.line, item.source);
      if (this.#sent.length === 1) this.#armTimer();
    }
  }

  /** Time out if the oldest line in flight gets no answer. */
  #armTimer() {
    clearTimeout(this.#timer);
    if (this.lineTimeoutMs <= 0 || !this.#sent.length) return;
    this.#timer = setTimeout(() => {
      // Give up on everything in flight: we can no longer tell which reply belongs to which line.
      // Late replies arriving with nothing in flight are ignored.
      const timedOut = this.#sent;
      this.#sent = [];
      this.#sentBytes = 0;
      timedOut.forEach((item) => item.reject(new CommandTimeoutError(item.line, this.lineTimeoutMs)));
      this.#pump();
    }, this.lineTimeoutMs);
  }

  #settle(fn) {
    const item = this.#sent.shift();
    if (item) {
      this.#sentBytes -= item.bytes;
      fn(item);
    }
    this.#armTimer();
    this.#pump();
  }

  #onLine(raw) {
    const text = raw.trim();
    if (!text) return;
    const res = parseResponse(text);
    const source = this.#sent[0]?.source ?? 'manual';

    switch (res.kind) {
      case 'ok':
        this.#log('rx', text, source);
        this.#settle((item) => {
          if (this.#position.apply(item.line)) this.#scheduleEstimate();
          item.resolve(text);
        });
        break;
      case 'error':
        this.#log('error', `${text} — ${res.message}`, source);
        this.#settle((item) => item.reject(new GrblError(res.code, res.message, item.line)));
        break;
      case 'alarm':
        this.#log('error', `${text} — ${res.message}`);
        this.emit('alarm', { code: res.code, message: res.message });
        break;
      case 'status': {
        const s = res.status;
        if (s.wco) this.#wco = s.wco;
        if (!s.wpos && s.mpos) s.wpos = { x: s.mpos.x - this.#wco.x, y: s.mpos.y - this.#wco.y, z: s.mpos.z - this.#wco.z };
        this.machine = { state: s.state, wpos: s.wpos, mpos: s.mpos, feed: s.feed, at: Date.now() };
        this.#lastStatusAt = this.machine.at;
        if (s.wpos) this.#position.set(s.wpos.x, s.wpos.y);
        this.emit('status', this.machine);
        break;
      }
      case 'welcome':
        this.#log('info', text);
        this.#position.softReset();
        this.#failAll(new ConnectionLostError('Controller reset'));
        this.emit('reset');
        break;
      default:
        this.#log('rx', text, source);
    }
  }

  #onClose(expected) {
    this.#failAll(new ConnectionLostError());
    if (expected || this.state === 'disconnected') return;
    this.#log('error', 'Connection to plotter lost');
    if (this.autoReconnect && this.target) this.#scheduleReconnect();
    else this.#setState('disconnected');
  }

  #scheduleReconnect() {
    this.#setState('reconnecting');
    const delays = this.reconnectDelaysMs;
    const delay = delays[Math.min(this.#reconnectAttempt, delays.length - 1)];
    this.#reconnectAttempt++;
    this.#log('info', `Reconnecting in ${delay / 1000}s (attempt ${this.#reconnectAttempt})`);
    this.#reconnectTimer = setTimeout(async () => {
      this.#reconnectTimer = null;
      const { host, port } = this.target;
      try {
        this.#setState('connecting');
        await this.connection.connect(this.#address ?? host, port);
        this.#reconnectAttempt = 0;
        this.lastError = null;
        this.#setState('connected');
        this.#log('info', `Reconnected to ${host}:${port}`);
        this.#emitEstimate();
        this.emit('reconnected');
      } catch (err) {
        this.lastError = err.message;
        if (this.autoReconnect) this.#scheduleReconnect();
        else this.#setState('disconnected');
      }
    }, delay);
  }

  #cancelReconnect() {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #failAll(err) {
    clearTimeout(this.#timer);
    const items = [...this.#sent, ...this.#queue];
    this.#sent = [];
    this.#sentBytes = 0;
    this.#queue = [];
    for (const item of items) item.reject(err);
  }

  /** @param {number} ms 0 disables polling */
  setStatusPolling(ms) {
    this.statusPollMs = Math.max(0, Number(ms) || 0);
    if (this.statusPollMs) this.statusPollMs = Math.max(200, this.statusPollMs);
    this.#updatePolling();
    this.emit('state', this.snapshot());
  }

  #updatePolling() {
    clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    if (this.state !== 'connected' || !this.statusPollMs) return;
    this.#pollTimer = setInterval(() => {
      if (this.isConnected) this.connection.write('?');
    }, this.statusPollMs);
    this.#pollTimer.unref?.();
  }

  /** Coalesce estimate updates (a job acknowledges many lines a second). */
  #scheduleEstimate() {
    if (this.#estimateTimer) return;
    this.#estimateTimer = setTimeout(() => {
      this.#estimateTimer = null;
      this.#emitEstimate();
    }, 100);
    this.#estimateTimer.unref?.();
  }

  /**
   * Publish the estimated position as `machine` ('estimate' event), unless real
   * status reports are arriving.
   */
  #emitEstimate() {
    if (!this.isConnected) return;
    const reportsFresh = this.#lastStatusAt && Date.now() - this.#lastStatusAt < (this.statusPollMs || 1000) * 3 + 1000;
    if (reportsFresh) return;
    const p = this.#position.position;
    this.machine = { state: null, wpos: p && { x: p.x, y: p.y, z: null }, mpos: null, feed: null, estimated: true, at: Date.now() };
    this.emit('estimate', this.machine);
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (state !== 'connected') this.machine = null;
    this.#updatePolling();
    this.emit('state', this.snapshot());
  }

  #log(dir, text, source = 'manual') {
    this.emit('log', { dir, text, source });
  }
}
