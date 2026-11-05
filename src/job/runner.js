import { EventEmitter } from 'node:events';
import { cleanLine, splitLines, stateBefore } from '../../shared/gcode.js';
import { CancelledError, ConnectionLostError, GrblError } from '../grbl/controller.js';

const PROGRESS_INTERVAL_MS = 100;
const AUTO_RESUME_DELAY_MS = 2000;
/** In char-count streaming, how many lines to hand the controller ahead of time (it limits by bytes). */
const LOOKAHEAD_LINES = 32;
let nextJobId = 1;

/**
 * Streams a G-code program through the controller, line by line.
 *
 * States: 'empty' (no job) | 'ready' | 'running' | 'paused' | 'done'
 * Events: 'state' (snapshot), 'progress' (progress()), 'log' ({dir, text, source})
 */
export class JobRunner extends EventEmitter {
  #loop = null;
  #progressTimer = null;
  #autoResumeTimer = null;
  #needsPreamble = false;
  #resumeOnReconnect = false;
  #activeSince = null;
  #generation = 0;
  #resumeMoved = 0; // bumped when the user moves the resume point

  /** @param {import('../grbl/controller.js').GrblController} controller */
  constructor(controller, { autoResume = true } = {}) {
    super();
    this.controller = controller;
    this.autoResume = autoResume;
    this.#reset();

    controller.on('reconnected', () => this.#onReconnected());
    controller.on('reset', () => {
      if (this.state === 'running' || this.state === 'paused') {
        this.machineWasReset = true;
        this.#pause('Controller reset — position may be lost. Check the plotter, then resume or restart.');
      }
    });
    controller.on('alarm', ({ code, message }) => {
      if (this.state === 'running') this.#pause(`ALARM:${code} — ${message}`);
    });
  }

  #reset() {
    this.state = 'empty';
    this.id = null;
    this.name = null;
    this.lines = [];
    this.text = '';
    this.next = 0; // index of the next line to send
    this.pauseReason = null;
    this.machineWasReset = false;
    this.elapsedMs = 0;
    this.#activeSince = null;
    this.#needsPreamble = false;
    this.#resumeOnReconnect = false;
  }

  get isBusy() {
    return this.state === 'running';
  }

  snapshot() {
    return {
      state: this.state,
      id: this.id,
      name: this.name,
      totalLines: this.lines.length,
      pauseReason: this.pauseReason,
      autoResume: this.autoResume,
      ...this.progress(),
    };
  }

  progress() {
    const elapsed = this.elapsedMs + (this.#activeSince ? Date.now() - this.#activeSince : 0);
    return { line: this.next, totalLines: this.lines.length, elapsedMs: elapsed };
  }

  load(name, text) {
    if (this.isBusy) throw new Error('Cannot load a file while a job is running');
    this.#clearAutoResume();
    this.#reset();
    this.id = nextJobId++;
    this.name = name || 'untitled.gcode';
    this.text = text;
    this.lines = splitLines(text);
    this.state = 'ready';
    this.#log('info', `Loaded ${this.name} (${this.lines.length} lines)`);
    this.#emitState();
  }

  unload() {
    if (this.isBusy) throw new Error('Stop the job first');
    this.#clearAutoResume();
    this.#reset();
    this.#emitState();
  }

  /** Start (or restart) from a given line. */
  start(fromLine = 0) {
    if (this.state === 'empty') throw new Error('No file loaded');
    if (this.isBusy) throw new Error('Job already running');
    if (!this.controller.isConnected) throw new Error('Plotter not connected');
    const from = Math.max(0, Math.min(Math.trunc(Number(fromLine) || 0), this.lines.length));
    this.#log('info', from > 0 ? `Starting from line ${from + 1}` : 'Starting job');
    this.#run(() => {
      this.next = from;
      this.elapsedMs = 0;
      this.machineWasReset = false;
      this.#needsPreamble = from > 0;
    });
  }

  resume() {
    if (this.state !== 'paused') throw new Error('Job is not paused');
    if (!this.controller.isConnected) throw new Error('Plotter not connected');
    this.#log('info', `Resuming at line ${this.next + 1}`);
    this.#run(() => {
      this.machineWasReset = false;
      this.#needsPreamble = true; // the pen may have been moved while paused
    });
  }

  pause() {
    if (this.state !== 'running') throw new Error('Job is not running');
    this.#pause('Paused by user');
  }

  stop() {
    if (this.state !== 'running' && this.state !== 'paused') throw new Error('No job in progress');
    this.#clearAutoResume();
    this.#stopClock();
    this.#generation++;
    this.controller.cancelQueued('job');
    this.#resumeOnReconnect = false;
    this.state = 'ready';
    this.pauseReason = null;
    this.#log('info', `Job stopped at line ${this.next + 1}`);
    this.#emitState();
  }

  setOptions({ autoResume }) {
    if (typeof autoResume === 'boolean') this.autoResume = autoResume;
    this.#emitState();
  }

  /**
   * Start a send loop. Only one loop ever runs: a new one first waits for the
   * previous loop to finish its in-flight line, so no line is sent twice or skipped.
   */
  #run(setup) {
    this.#clearAutoResume();
    this.#resumeOnReconnect = false;
    const gen = ++this.#generation;
    const previous = this.#loop ?? Promise.resolve();
    this.state = 'running';
    this.pauseReason = null;
    this.#emitState();
    this.#loop = previous.then(async () => {
      if (gen !== this.#generation || this.state !== 'running') return;
      setup();
      this.#activeSince = Date.now();
      this.#startProgress();
      try {
        await this.#sendLoop(gen);
      } finally {
        this.#stopProgress();
      }
    });
  }

  async #sendLoop(gen) {
    const live = () => gen === this.#generation && this.state === 'running';
    try {
      if (this.#needsPreamble) {
        this.#needsPreamble = false;
        const preamble = stateBefore(this.lines, this.next).preamble();
        this.#log('info', `Restoring position/state: ${preamble.join(' | ')}`);
        for (const cmd of preamble) {
          await this.controller.send(cmd, { source: 'job' });
          if (!live()) {
            this.#needsPreamble = true; // interrupted: redo it on resume
            return;
          }
        }
      }

      // Hand lines to the controller ahead of time (1 in send-response mode), then settle them in order.
      const ahead = this.controller.streaming === 'char-count' ? LOOKAHEAD_LINES : 1;
      const moved = this.#resumeMoved;
      const outstanding = []; // { index, promise | null } in send order
      let cursor = this.next;
      let failure = null;

      for (;;) {
        while (live() && !failure && cursor < this.lines.length && outstanding.length < ahead) {
          const cmd = cleanLine(this.lines[cursor]);
          const promise = cmd ? this.controller.send(cmd, { source: 'job' }) : null;
          promise?.catch(() => {}); // handled when awaited below; may be cancelled before that
          outstanding.push({ index: cursor, promise });
          cursor++;
        }
        if (!outstanding.length) break;
        const { index, promise } = outstanding.shift();
        try {
          if (promise) await promise;
          // Acknowledged: count it even if the user paused meanwhile, unless the resume point was moved.
          if (moved === this.#resumeMoved && this.next <= index) this.next = index + 1;
        } catch (err) {
          if (err instanceof CancelledError) continue; // never written
          failure ??= { err, index };
          // Stop feeding; lines already written are still answered, so keep draining them.
          this.controller.cancelQueued('job');
        }
      }

      if (failure) return this.#fail(failure.err, failure.index, gen);
      if (live() && this.next >= this.lines.length) {
        this.#stopClock();
        this.state = 'done';
        this.#log('info', `Job finished in ${formatDuration(this.elapsedMs)}`);
        this.#emitState();
      }
    } catch (err) {
      this.#fail(err, this.next, gen); // preamble failed
    }
  }

  #fail(err, index, gen) {
    if (gen !== this.#generation || this.state !== 'running') return; // paused/stopped meanwhile
    if (err instanceof GrblError) {
      const skipped = this.next > index; // char-count: later lines were already sent and ran
      this.#pause(
        `Line ${index + 1}: ${err.message}. ` +
          (skipped ? 'The controller skipped it; resuming continues after the lines it already ran.' : 'Fix or skip the line, then resume.'),
      );
    } else if (err instanceof ConnectionLostError) {
      this.#needsPreamble = true;
      const willRetry = this.autoResume && this.controller.autoReconnect && !this.machineWasReset;
      this.#resumeOnReconnect = willRetry;
      this.#pause(`${err.message} at line ${this.next + 1}.${willRetry ? ' Will resume after reconnecting.' : ''}`);
    } else {
      this.#pause(`Line ${this.next + 1}: ${err.message}`);
    }
  }

  #pause(reason) {
    this.controller.cancelQueued('job'); // don't write lines that are only queued
    if (this.state === 'running') this.#stopClock();
    if (this.state !== 'running' && this.state !== 'paused') return;
    this.state = 'paused';
    this.pauseReason = reason;
    this.#log(reason === 'Paused by user' ? 'info' : 'error', reason);
    this.#emitState();
  }

  #onReconnected() {
    if (this.state !== 'paused' || !this.autoResume || this.machineWasReset) return;
    if (!this.#resumeOnReconnect) return;
    this.#log('info', `Auto-resuming in ${AUTO_RESUME_DELAY_MS / 1000}s`);
    this.#autoResumeTimer = setTimeout(() => {
      this.#autoResumeTimer = null;
      // A reset banner may have arrived in the meantime.
      if (this.state === 'paused' && this.#resumeOnReconnect && !this.machineWasReset && this.controller.isConnected) {
        this.resume();
      }
    }, AUTO_RESUME_DELAY_MS);
  }

  #clearAutoResume() {
    clearTimeout(this.#autoResumeTimer);
    this.#autoResumeTimer = null;
  }

  #stopClock() {
    if (this.#activeSince) this.elapsedMs += Date.now() - this.#activeSince;
    this.#activeSince = null;
  }

  #startProgress() {
    this.#stopProgress();
    this.#progressTimer = setInterval(() => this.emit('progress', this.progress()), PROGRESS_INTERVAL_MS);
  }

  #stopProgress() {
    clearInterval(this.#progressTimer);
    this.#progressTimer = null;
    this.emit('progress', this.progress());
  }

  /** Move the resume point (e.g. to skip a bad line) while not running. */
  setNextLine(line) {
    if (this.isBusy) throw new Error('Pause the job first');
    if (this.state === 'empty') throw new Error('No file loaded');
    this.next = Math.max(0, Math.min(Math.trunc(Number(line) || 0), this.lines.length));
    this.#resumeMoved++;
    this.#needsPreamble = true;
    if (this.state === 'done') this.state = 'ready';
    this.#emitState();
  }

  #emitState() {
    this.emit('state', this.snapshot());
  }

  #log(dir, text) {
    this.emit('log', { dir, text, source: 'job' });
  }
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`;
}
