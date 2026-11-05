import net from 'node:net';
import { EventEmitter } from 'node:events';

/**
 * Splits a byte stream into lines. TCP gives no guarantees about chunk
 * boundaries: one `data` event may hold half a line or several lines.
 */
export class LineSplitter {
  #buffer = '';

  /** @param {string} chunk @returns {string[]} complete lines */
  push(chunk) {
    this.#buffer += chunk;
    const parts = this.#buffer.split(/\r?\n|\r/);
    this.#buffer = parts.pop() ?? '';
    return parts;
  }

  reset() {
    this.#buffer = '';
  }
}

/**
 * Line-oriented TCP connection to the plotter.
 *
 * Events: 'line' (string), 'close' ({ hadError, expected }), 'error' (Error)
 */
export class TcpConnection extends EventEmitter {
  #socket = null;
  #splitter = new LineSplitter();
  #closingOnPurpose = false;

  constructor({ connectTimeoutMs = 5000 } = {}) {
    super();
    this.connectTimeoutMs = connectTimeoutMs;
  }

  get isOpen() {
    return this.#socket !== null && !this.#socket.connecting && !this.#socket.destroyed;
  }

  /** Resolves once connected, rejects on error or timeout. */
  connect(host, port) {
    if (this.#socket) return Promise.reject(new Error('Connection already open or in progress'));

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.#socket = socket;
      this.#closingOnPurpose = false;
      this.#splitter.reset();
      let settled = false;
      let opened = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };

      socket.setTimeout(this.connectTimeoutMs, () => {
        fail(new Error(`Timed out connecting to ${host}:${port}`));
      });

      socket.setEncoding('utf8');
      socket.setNoDelay(true);

      socket.on('data', (chunk) => {
        for (const line of this.#splitter.push(chunk)) this.emit('line', line);
      });

      socket.on('error', (err) => {
        if (!opened) return fail(err);
        this.emit('error', err);
      });

      socket.on('close', (hadError) => {
        if (this.#socket === socket) this.#socket = null;
        if (!settled) {
          settled = true; // disconnect() called while still connecting
          reject(new Error('Connection cancelled'));
        }
        if (opened) this.emit('close', { hadError, expected: this.#closingOnPurpose });
      });

      socket.connect(port, host, () => {
        if (settled) return;
        settled = true;
        opened = true;
        socket.setTimeout(0);
        socket.setKeepAlive(true, 5000); // notice a vanished ESP sooner
        resolve();
      });
    });
  }

  disconnect() {
    if (!this.#socket) return;
    this.#closingOnPurpose = true;
    this.#socket.destroy();
  }

  /** @param {string} data */
  write(data) {
    if (!this.isOpen) throw new Error('Not connected');
    this.#socket.write(data);
  }
}
