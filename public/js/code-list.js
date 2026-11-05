import { cleanLine } from '/shared/gcode.js';

const ROW_HEIGHT = 20;
const OVERSCAN = 20;

/**
 * Virtualised G-code listing: only the visible rows exist in the DOM, so
 * files with hundreds of thousands of lines stay responsive.
 */
export class CodeList {
  #lines = [];
  #current = -1;
  #rows = new Map(); // index -> element

  /** @param {HTMLElement} el @param {(index: number) => void} onPick */
  constructor(el, onPick) {
    this.el = el;
    this.spacer = document.createElement('div');
    this.spacer.className = 'spacer-el';
    el.append(this.spacer);
    el.addEventListener('scroll', () => this.#render());
    new ResizeObserver(() => this.#render()).observe(el);
    this.spacer.addEventListener('click', (e) => {
      const row = e.target.closest('.code-row');
      if (row) onPick(Number(row.dataset.index));
    });
  }

  setLines(lines) {
    this.#lines = lines;
    this.#current = -1;
    this.spacer.style.height = `${lines.length * ROW_HEIGHT}px`;
    this.spacer.replaceChildren();
    this.#rows.clear();
    this.el.scrollTop = 0;
    this.#render();
  }

  /** Highlight the line being sent; lines before it are shown as done. */
  setCurrent(index, { follow = false } = {}) {
    if (index === this.#current) return;
    this.#current = index;
    if (follow && this.el.offsetParent !== null) {
      const top = index * ROW_HEIGHT;
      const { scrollTop, clientHeight } = this.el;
      if (top < scrollTop || top > scrollTop + clientHeight - ROW_HEIGHT * 2) {
        this.el.scrollTop = top - clientHeight / 2;
      }
    }
    this.#render(true);
  }

  /** Scroll the current line into the middle of the view. */
  reveal() {
    if (this.#current < 0) return;
    this.el.scrollTop = this.#current * ROW_HEIGHT - this.el.clientHeight / 2;
    this.#render(true);
  }

  #render(restyle = false) {
    const { scrollTop, clientHeight } = this.el;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(this.#lines.length - 1, Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + OVERSCAN);

    for (const [index, row] of this.#rows) {
      if (index < first || index > last) {
        row.remove();
        this.#rows.delete(index);
      }
    }
    for (let i = first; i <= last; i++) {
      let row = this.#rows.get(i);
      if (!row) {
        row = this.#createRow(i);
        this.#rows.set(i, row);
        this.spacer.append(row);
      } else if (!restyle) continue;
      row.classList.toggle('current', i === this.#current);
      row.classList.toggle('done', i < this.#current);
    }
  }

  #createRow(i) {
    const raw = this.#lines[i];
    const row = document.createElement('div');
    row.className = 'code-row';
    row.dataset.index = i;
    row.style.top = `${i * ROW_HEIGHT}px`;
    if (raw.trim() && !cleanLine(raw)) row.classList.add('comment');
    const ln = document.createElement('span');
    ln.className = 'ln';
    ln.textContent = i + 1;
    const tx = document.createElement('span');
    tx.className = 'tx';
    tx.textContent = raw; // textContent: file content is never parsed as HTML
    row.append(ln, tx);
    row.classList.toggle('current', i === this.#current);
    row.classList.toggle('done', i < this.#current);
    return row;
  }
}
