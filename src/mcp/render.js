// Render a G-code toolpath to a PNG, so an AI agent can see what it is about to draw.
// Dependency-free: a tiny line rasteriser plus a grayscale PNG encoder.

import zlib from 'node:zlib';
import { analyze, splitLines } from '../../shared/gcode.js';

const INK = 0; // pen-down moves
const TRAVEL = 190; // pen-up moves
const AXIS = 150; // X/Y axes through the origin
const GRID = 232;
const PAPER = 255;

/**
 * @param {string} gcode
 * @param {{ size?: number, showTravel?: boolean }} [options] size = longest side in pixels
 * @returns {{ png: Buffer, width: number, height: number, gridMm: number,
 *             bounds: {minX:number,minY:number,maxX:number,maxY:number} | null,
 *             drawLength: number, travelLength: number, commandCount: number }}
 */
export function renderPreview(gcode, { size = 800, showTravel = true } = {}) {
  const { segments, bounds, drawLength, travelLength, commandCount } = analyze(splitLines(gcode));

  // View: everything that moves, plus the origin so placement is visible.
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (let i = 0; i < segments.length; i += 6) {
    if (!showTravel && !segments[i + 4]) continue;
    minX = Math.min(minX, segments[i], segments[i + 2]);
    maxX = Math.max(maxX, segments[i], segments[i + 2]);
    minY = Math.min(minY, segments[i + 1], segments[i + 3]);
    maxY = Math.max(maxY, segments[i + 1], segments[i + 3]);
  }
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);

  const margin = 16;
  const scale = (size - 2 * margin) / Math.max(spanX, spanY);
  const width = Math.max(64, Math.round(spanX * scale) + 2 * margin);
  const height = Math.max(64, Math.round(spanY * scale) + 2 * margin);
  const img = new Uint8Array(width * height).fill(PAPER);

  const px = (x) => margin + (x - minX) * scale;
  const py = (y) => height - margin - (y - minY) * scale; // Y up, like the machine

  // Grid: the smallest of 1/5/10/50/100/500 mm that leaves at least 8 px between lines.
  const gridMm = [1, 5, 10, 50, 100, 500, 1000].find((g) => g * scale >= 8) ?? 1000;
  for (let g = Math.ceil(minX / gridMm) * gridMm; g <= maxX; g += gridMm) {
    line(img, width, height, px(g), py(minY), px(g), py(maxY), GRID, 0);
  }
  for (let g = Math.ceil(minY / gridMm) * gridMm; g <= maxY; g += gridMm) {
    line(img, width, height, px(minX), py(g), px(maxX), py(g), GRID, 0);
  }
  line(img, width, height, px(minX), py(0), px(maxX), py(0), AXIS, 0);
  line(img, width, height, px(0), py(minY), px(0), py(maxY), AXIS, 0);

  if (showTravel) {
    for (let i = 0; i < segments.length; i += 6) {
      if (segments[i + 4]) continue;
      line(img, width, height, px(segments[i]), py(segments[i + 1]), px(segments[i + 2]), py(segments[i + 3]), TRAVEL, 0);
    }
  }
  for (let i = 0; i < segments.length; i += 6) {
    if (!segments[i + 4]) continue;
    line(img, width, height, px(segments[i]), py(segments[i + 1]), px(segments[i + 2]), py(segments[i + 3]), INK, 1);
  }

  return { png: encodePng(img, width, height), width, height, gridMm, bounds, drawLength, travelLength, commandCount };
}

/** Draw a line, keeping the darker value where lines overlap. radius 0 = 1 px wide. */
function line(img, w, h, x0, y0, x1, y1, value, radius) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let s = 0; s <= steps; s++) {
    const cx = Math.round(x0 + ((x1 - x0) * s) / steps);
    const cy = Math.round(y0 + ((y1 - y0) * s) / steps);
    for (let dy = -radius; dy <= radius; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= h) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= w) continue;
        const k = y * w + x;
        if (value < img[k]) img[k] = value;
      }
    }
  }
}

// ---- PNG ------------------------------------------------------------------

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 8-bit grayscale PNG. */
export function encodePng(gray, width, height) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
