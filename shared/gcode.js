// G-code helpers shared by the server (Node) and the browser.
// Keep this file dependency-free and environment-agnostic.

const INCH = 25.4;
const ARC_SEGMENT_MM = 1; // preview resolution for G2/G3 arcs

/**
 * Strip comments, line numbers, checksums and extra whitespace.
 * Returns '' for lines that contain nothing to send.
 * @param {string} raw
 * @returns {string}
 */
export function cleanLine(raw) {
  let s = String(raw);
  s = s.replace(/\([^)]*\)/g, ''); // ( parenthesis comments )
  const semi = s.indexOf(';'); // ; line comments
  if (semi !== -1) s = s.slice(0, semi);
  s = s.trim();
  if (s === '%') return ''; // program start/end marker
  s = s.replace(/\*\d+$/, ''); // checksum
  s = s.replace(/^N\d+\s*/i, ''); // line number
  return s.replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Split file contents into lines (handles \n, \r\n and \r).
 * @param {string} text
 */
export function splitLines(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Parse address words from a cleaned line, e.g. "G1 X10 Y-2.5" -> [['G',1],['X',10],['Y',-2.5]].
 * System commands ($...) return [].
 * @param {string} line cleaned line
 * @returns {Array<[string, number]>}
 */
export function parseWords(line) {
  if (!line || line[0] === '$') return [];
  const words = [];
  const re = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
  let m;
  while ((m = re.exec(line)) !== null) words.push([m[1], parseFloat(m[2])]);
  return words;
}

/**
 * Tracks the modal state of a G-code program (positioning mode, units, feed,
 * pen/spindle state, position) so we can preview it and safely resume mid-file.
 */
export class ModalState {
  constructor() {
    this.absolute = true; // G90 / G91
    this.metric = true; // G21 / G20
    this.motion = 0; // 0,1,2,3
    this.feed = null; // in file units
    this.spindle = null; // e.g. 'M3 S1000' or 'M5' (last command seen, verbatim)
    this.spindleOn = false;
    this.zDown = null; // pen state derived from Z, if the file uses Z
    this.x = 0;
    this.y = 0;
    this.z = null;
    this.maxZ = null;
  }

  get penDown() {
    return this.zDown ?? this.spindleOn;
  }

  /**
   * Apply one cleaned line. Returns a polyline for any XY motion
   * ({ points: [x0,y0,x1,y1,...], down, rapid }) or null.
   * @param {string} line
   */
  apply(line) {
    const words = parseWords(line);
    if (!words.length) return null;

    let x = null, y = null, z = null, i = null, j = null, s = null;
    let nonModal = false; // G10, G28, G92 ... take coordinates but are not moves
    let spindleCmd = null;

    for (const [letter, value] of words) {
      switch (letter) {
        case 'G':
          if (value === 0 || value === 1 || value === 2 || value === 3) {
            this.motion = value;
          } else if (value === 90) this.absolute = true;
          else if (value === 91) this.absolute = false;
          else if (value === 20) this.metric = false;
          else if (value === 21) this.metric = true;
          else if ([4, 10, 28, 30, 53, 92].includes(value)) nonModal = true;
          break;
        case 'M':
          if (value === 3 || value === 4) spindleCmd = 'on';
          else if (value === 5) spindleCmd = 'off';
          break;
        case 'X': x = value; break;
        case 'Y': y = value; break;
        case 'Z': z = value; break;
        case 'I': i = value; break;
        case 'J': j = value; break;
        case 'F': this.feed = value; break;
        case 'S': s = value; break;
      }
    }

    if (spindleCmd === 'on') {
      this.spindleOn = s === null || s > 0;
      this.spindle = s === null ? 'M3' : `M3 S${s}`;
    } else if (spindleCmd === 'off') {
      this.spindleOn = false;
      this.spindle = 'M5';
    }

    if (nonModal || (x === null && y === null && z === null)) return null;

    const k = this.metric ? 1 : INCH;
    const fromX = this.x, fromY = this.y;
    const toX = x === null ? fromX : this.absolute ? x * k : fromX + x * k;
    const toY = y === null ? fromY : this.absolute ? y * k : fromY + y * k;
    if (z !== null) {
      this.z = this.absolute || this.z === null ? z * k : this.z + z * k;
      this.maxZ = this.maxZ === null ? this.z : Math.max(this.maxZ, this.z);
      this.zDown = this.z <= 0;
    }
    this.x = toX;
    this.y = toY;

    if (toX === fromX && toY === fromY) return null;

    // A pen that is down draws regardless of G0/G1.
    const down = this.penDown;
    if ((this.motion === 2 || this.motion === 3) && (i !== null || j !== null)) {
      const points = arcPoints(fromX, fromY, toX, toY, (i ?? 0) * k, (j ?? 0) * k, this.motion === 2);
      return { points, down, rapid: false };
    }
    return { points: [fromX, fromY, toX, toY], down, rapid: this.motion === 0 };
  }

  /** Commands that restore this state on a machine whose state is unknown. */
  preamble({ penUp = 'M5' } = {}) {
    const out = [penUp, 'G21', 'G90'];
    if (this.z !== null && this.maxZ !== null) out.push(`G0 Z${fmt(this.maxZ)}`);
    out.push(`G0 X${fmt(this.x)} Y${fmt(this.y)}`);
    if (this.z !== null) out.push(`G0 Z${fmt(this.z)}`);
    if (this.spindle && this.spindleOn) out.push(this.spindle);
    if (!this.metric) out.push('G20');
    if (!this.absolute) out.push('G91');
    if (this.feed !== null) out.push(`F${fmt(this.feed)}`);
    out.push(`G${this.motion}`);
    return out;
  }
}

function fmt(n) {
  return String(Math.round(n * 1000) / 1000);
}

function arcPoints(x0, y0, x1, y1, i, j, clockwise) {
  const cx = x0 + i, cy = y0 + j;
  const r = Math.hypot(i, j);
  let a0 = Math.atan2(y0 - cy, x0 - cx);
  let a1 = Math.atan2(y1 - cy, x1 - cx);
  let sweep = a1 - a0;
  if (clockwise && sweep >= 0) sweep -= 2 * Math.PI;
  if (!clockwise && sweep <= 0) sweep += 2 * Math.PI;
  const steps = Math.max(2, Math.min(720, Math.ceil((Math.abs(sweep) * r) / ARC_SEGMENT_MM)));
  const pts = [x0, y0];
  for (let n = 1; n < steps; n++) {
    const a = a0 + (sweep * n) / steps;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  pts.push(x1, y1);
  return pts;
}

/**
 * Analyse a whole program: toolpath segments for the preview, bounds and stats.
 * segments is a flat Float32Array: [x1, y1, x2, y2, down(0|1), lineIndex, ...]
 * @param {string[]} lines raw lines
 */
export function analyze(lines) {
  const state = new ModalState();
  const segs = [];
  const all = emptyBounds();
  const drawn = emptyBounds();
  let commandCount = 0;
  let drawLength = 0;
  let travelLength = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = cleanLine(lines[idx]);
    if (!line) continue;
    commandCount++;
    const move = state.apply(line);
    if (!move) continue;
    const p = move.points;
    for (let n = 0; n + 3 < p.length; n += 2) {
      segs.push(p[n], p[n + 1], p[n + 2], p[n + 3], move.down ? 1 : 0, idx);
      const len = Math.hypot(p[n + 2] - p[n], p[n + 3] - p[n + 1]);
      if (move.down) drawLength += len; else travelLength += len;
      extend(all, p[n], p[n + 1]); extend(all, p[n + 2], p[n + 3]);
      if (move.down) { extend(drawn, p[n], p[n + 1]); extend(drawn, p[n + 2], p[n + 3]); }
    }
  }

  return {
    segments: Float32Array.from(segs),
    bounds: drawn.minX <= drawn.maxX ? drawn : all.minX <= all.maxX ? all : null,
    commandCount,
    drawLength,
    travelLength,
  };
}

/** Modal state right before `lineIndex` (used to resume a job mid-file). */
export function stateBefore(lines, lineIndex) {
  const state = new ModalState();
  for (let idx = 0; idx < lineIndex && idx < lines.length; idx++) {
    const line = cleanLine(lines[idx]);
    if (line) state.apply(line);
  }
  return state;
}

function emptyBounds() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function extend(b, x, y) {
  if (x < b.minX) b.minX = x;
  if (x > b.maxX) b.maxX = x;
  if (y < b.minY) b.minY = y;
  if (y > b.maxY) b.maxY = y;
}

/** Realtime (single byte, unbuffered) GRBL commands. */
export const REALTIME = Object.freeze({
  hold: '!',
  resume: '~',
  status: '?',
  reset: '\x18',
});
