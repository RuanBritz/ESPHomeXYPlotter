import { ModalState, parseWords } from '../../shared/gcode.js';

/**
 * Estimates the pen position (work coordinates, mm) from the commands the controller
 * accepted, for firmware that doesn't send status reports. Real reports override it.
 */
export class PositionEstimate {
  constructor() {
    this.reset();
  }

  /** Fresh connection: assume the controller is at the work origin. */
  reset(x = 0, y = 0) {
    this.modal = new ModalState();
    this.modal.x = x;
    this.modal.y = y;
    this.known = true;
  }

  /** @returns {{x: number, y: number} | null} */
  get position() {
    return this.known ? { x: this.modal.x, y: this.modal.y } : null;
  }

  /** A status report told us where we are. */
  set(x, y) {
    this.modal.x = x;
    this.modal.y = y;
    this.known = true;
  }

  /** Soft reset: GRBL keeps its position but goes back to its default modes. */
  softReset() {
    const { x, y } = this.modal;
    const known = this.known;
    this.reset(x, y);
    this.known = known;
  }

  /**
   * Apply a line the controller accepted. Returns true if the estimate changed.
   * @param {string} line cleaned line
   */
  apply(line) {
    const before = this.known ? `${this.modal.x},${this.modal.y}` : null;
    this.#apply(line);
    const after = this.known ? `${this.modal.x},${this.modal.y}` : null;
    return before !== after;
  }

  #apply(line) {
    const m = this.modal;
    if (line.startsWith('$J=')) {
      // A jog's G90/G91, G20/G21 and F apply to that jog only.
      const { absolute, metric, motion, feed } = m;
      this.#move(line.slice(3));
      Object.assign(m, { absolute, metric, motion, feed });
      return;
    }
    if (line.startsWith('$')) {
      if (/^\$H/.test(line)) this.known = false; // homing: ends wherever the switches are
      return;
    }

    const words = parseWords(line);
    const g = words.filter(([l]) => l === 'G').map(([, v]) => v);
    const axis = (letter) => words.find(([l]) => l === letter)?.[1];
    const k = m.metric ? 1 : 25.4;

    // Set the current position to given coordinates (e.g. "Set zero").
    if (g.includes(92) || (g.includes(10) && axis('L') === 20)) {
      if (axis('X') !== undefined) m.x = axis('X') * k;
      if (axis('Y') !== undefined) m.y = axis('Y') * k;
      return;
    }
    // Moves to stored or machine positions, and offset changes: we can't follow these.
    if (g.some((v) => [28, 30, 53, 92.1, 92.2].includes(v)) || (g.includes(10) && axis('L') === 2)) {
      this.known = false;
      return;
    }
    this.#move(line, words);
  }

  #move(line, words = parseWords(line)) {
    const m = this.modal;
    const wasKnown = this.known;
    m.apply(line);
    // From an unknown position, only an absolute move with both X and Y tells us where we are.
    if (!wasKnown && m.absolute && words.some(([l]) => l === 'X') && words.some(([l]) => l === 'Y')) this.known = true;
  }
}
