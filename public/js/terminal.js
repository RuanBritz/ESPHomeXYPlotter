const MAX_LINES = 1000;
const HISTORY_KEY = 'xyplotter.history';

/** Console output with a capped line count and batched DOM updates. */
export class Terminal {
  #queue = [];
  #scheduled = false;

  constructor(el) {
    this.el = el;
    this.showJobTraffic = false;
  }

  /** @param {{dir: string, text: string, source?: string, t?: number}} entry */
  append(entry) {
    // Job lines and their `ok`s would flood the console; hide them unless asked.
    if (!this.showJobTraffic && entry.source === 'job' && (entry.dir === 'tx' || entry.dir === 'rx')) return;
    this.#queue.push(entry);
    if (!this.#scheduled) {
      this.#scheduled = true;
      requestAnimationFrame(() => this.#flush());
    }
  }

  info(text) {
    this.append({ dir: 'info', text, t: Date.now() });
  }

  clear() {
    this.el.replaceChildren();
  }

  #flush() {
    this.#scheduled = false;
    const stick = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const entry of this.#queue.splice(0).slice(-MAX_LINES)) {
      const row = document.createElement('div');
      row.className = `term-line ${entry.dir}`;
      const time = document.createElement('time');
      time.textContent = new Date(entry.t ?? Date.now()).toLocaleTimeString([], { hour12: false });
      const text = document.createElement('span');
      text.textContent = entry.text;
      row.append(time, text);
      frag.append(row);
    }
    this.el.append(frag);
    let excess = this.el.childElementCount - MAX_LINES;
    while (excess-- > 0) this.el.firstElementChild.remove();
    if (stick) this.el.scrollTop = this.el.scrollHeight;
  }
}

/** Up/down command history for an <input>, persisted in localStorage. */
export class History {
  #items;
  #pos = -1;
  #draft = '';

  constructor(input) {
    this.input = input;
    try {
      this.#items = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    } catch {
      this.#items = [];
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') this.#move(e, 1);
      else if (e.key === 'ArrowDown') this.#move(e, -1);
    });
  }

  push(cmd) {
    this.#items = [cmd, ...this.#items.filter((c) => c !== cmd)].slice(0, 50);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(this.#items));
    this.#pos = -1;
  }

  #move(e, delta) {
    e.preventDefault();
    if (this.#pos === -1) this.#draft = this.input.value;
    this.#pos = Math.max(-1, Math.min(this.#items.length - 1, this.#pos + delta));
    this.input.value = this.#pos === -1 ? this.#draft : this.#items[this.#pos];
  }
}
