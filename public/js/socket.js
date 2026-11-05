/**
 * WebSocket that reconnects on its own and dispatches typed server messages.
 * Usage: live.on('job', (msg) => ...); live.on('open'|'close', fn)
 */
export class LiveSocket {
  #handlers = new Map();
  #ws = null;
  #attempt = 0;

  constructor(path = '/ws') {
    this.url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
  }

  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, []);
    this.#handlers.get(type).push(fn);
    return this;
  }

  #emit(type, data) {
    for (const fn of this.#handlers.get(type) ?? []) fn(data);
  }

  connect() {
    const ws = new WebSocket(this.url);
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempt = 0;
      this.#emit('open');
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#emit(msg.type, msg);
    };
    ws.onclose = () => {
      this.#emit('close');
      const delay = Math.min(10000, 500 * 2 ** this.#attempt++);
      setTimeout(() => this.connect(), delay);
    };
  }
}
