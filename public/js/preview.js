// Canvas toolpath preview with pan/zoom and incremental progress drawing.
// Three stacked canvases: base (grid + whole path), progress (plotted part), overlay (pen marker).

const COLORS = {
  grid: '#1a1e27',
  gridMajor: '#232835',
  axisX: '#7a3340',
  axisY: '#2f6a4c',
  pending: 'rgba(125, 134, 155, 0.75)',
  travel: 'rgba(245, 165, 36, 0.35)',
  done: '#5b8cff',
  doneTravel: 'rgba(91, 140, 255, 0.25)',
  simTravel: '#ff9f1c', // pen-up moves already made, while simulating
  bounds: 'rgba(230, 232, 238, 0.35)',
  label: '#8b93a7',
  pen: '#ffffff',
  penDown: '#5b8cff',
};

const STRIDE = 6; // x1, y1, x2, y2, down, lineIndex

export class Preview {
  #segments = new Float32Array(0);
  #bounds = null;
  #doneLine = 0; // lines < doneLine are plotted
  #doneSeg = 0; // segments drawn on the progress layer
  #marker = null; // {x, y}
  #head = null; // simulated pen: {x, y, down, partial: [x1, y1, x2, y2, down, ...]}
  #view = { scale: 2, ox: 40, oy: 400 }; // screen = (ox + x*scale, oy - y*scale) in CSS px
  #autoFit = true;
  #raf = 0;
  #dirty = { base: true, progress: true, overlay: true };

  constructor({ base, progress, overlay }) {
    this.canvases = { base, progress, overlay };
    this.ctx = {
      base: base.getContext('2d'),
      progress: progress.getContext('2d'),
      overlay: overlay.getContext('2d'),
    };
    this.showTravel = true;
    this.simulating = false;
    new ResizeObserver(() => this.#resize()).observe(base.parentElement);
    this.#bindInteraction(overlay);
  }

  /** @param {{segments: Float32Array, bounds: object|null}} analysis */
  setProgram({ segments, bounds }) {
    this.#segments = segments;
    this.#bounds = bounds;
    this.#doneLine = 0;
    this.#doneSeg = 0;
    this.#autoFit = true;
    this.fit();
  }

  clear() {
    this.setProgram({ segments: new Float32Array(0), bounds: null });
  }

  /** While simulating, pen-up moves already made get their own colour. */
  setSimulating(on) {
    this.simulating = on;
    this.#invalidate('progress', 'overlay');
  }

  setShowTravel(show) {
    this.showTravel = show;
    this.#invalidate('base', 'progress');
  }

  /** Lines before `line` have been sent. */
  setProgress(line) {
    if (line === this.#doneLine) return;
    if (line < this.#doneLine) this.#invalidate('progress'); // went backwards: redraw from scratch
    this.#doneLine = line;
    this.#invalidate('overlay');
    this.#schedule(true);
  }

  /** Current pen position from status reports (work coordinates), or null. */
  setMarker(pos) {
    this.#marker = pos;
    this.#invalidate('overlay');
  }

  /**
   * Simulated pen, drawn instead of the live marker: its position, whether the pen is down,
   * and the part of the current line drawn so far. null to go back to the live marker.
   */
  setHead(head) {
    this.#head = head;
    this.#invalidate('overlay');
  }

  fit() {
    const { width, height } = this.#size();
    if (!width || !height) return;
    const b = this.#bounds ?? { minX: 0, minY: 0, maxX: 200, maxY: 200 };
    this.#fitTo(b, width, height);
  }

  /** View from the origin to the drawing's far corner. */
  fitOrigin() {
    const { width, height } = this.#size();
    const b = this.#bounds ?? { minX: 0, minY: 0, maxX: 200, maxY: 200 };
    this.#fitTo({ minX: Math.min(0, b.minX), minY: Math.min(0, b.minY), maxX: Math.max(0, b.maxX), maxY: Math.max(0, b.maxY) }, width, height);
  }

  #fitTo(b, width, height) {
    const pad = 36;
    const w = Math.max(b.maxX - b.minX, 1), h = Math.max(b.maxY - b.minY, 1);
    const scale = Math.min((width - pad * 2) / w, (height - pad * 2) / h);
    this.#view = {
      scale,
      ox: (width - w * scale) / 2 - b.minX * scale,
      oy: (height + h * scale) / 2 + b.minY * scale,
    };
    this.#invalidate('base', 'progress', 'overlay');
  }

  // ---------------------------------------------------------------- internals

  #size() {
    const r = this.canvases.base.parentElement.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }

  #resize() {
    const { width, height } = this.#size();
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    for (const c of Object.values(this.canvases)) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    for (const ctx of Object.values(this.ctx)) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.#autoFit) this.fit();
    this.#invalidate('base', 'progress', 'overlay');
  }

  #invalidate(...layers) {
    for (const l of layers) this.#dirty[l] = true;
    if (layers.includes('progress')) this.#doneSeg = 0;
    this.#schedule();
  }

  #schedule() {
    if (this.#raf) return;
    this.#raf = requestAnimationFrame(() => {
      this.#raf = 0;
      this.#draw();
    });
  }

  #draw() {
    const { width, height } = this.#size();
    if (this.#dirty.base) this.#drawBase(width, height);
    this.#drawProgress(width, height, this.#dirty.progress);
    if (this.#dirty.overlay) this.#drawOverlay(width, height);
    this.#dirty = { base: false, progress: false, overlay: false };
  }

  #tx(x) { return this.#view.ox + x * this.#view.scale; }
  #ty(y) { return this.#view.oy - y * this.#view.scale; }

  #drawBase(width, height) {
    const ctx = this.ctx.base;
    ctx.clearRect(0, 0, width, height);
    this.#drawGrid(ctx, width, height);

    const s = this.#segments;
    const strokeAll = (down, color, dash) => {
      ctx.beginPath();
      for (let i = 0; i < s.length; i += STRIDE) {
        if ((s[i + 4] === 1) !== down) continue;
        ctx.moveTo(this.#tx(s[i]), this.#ty(s[i + 1]));
        ctx.lineTo(this.#tx(s[i + 2]), this.#ty(s[i + 3]));
      }
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (this.showTravel) strokeAll(false, COLORS.travel, [3, 3]);
    strokeAll(true, COLORS.pending, []);

    const b = this.#bounds;
    if (b) {
      const x = this.#tx(b.minX), y = this.#ty(b.maxY);
      const w = (b.maxX - b.minX) * this.#view.scale, h = (b.maxY - b.minY) * this.#view.scale;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = COLORS.bounds;
      ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.label;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${(b.maxX - b.minX).toFixed(1)} × ${(b.maxY - b.minY).toFixed(1)} mm`, x, y - 6);
    }
  }

  #drawGrid(ctx, width, height) {
    const { scale } = this.#view;
    const steps = [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const step = steps.find((st) => st * scale >= 14) ?? 1000;
    const major = step * 5;
    const x0 = (0 - this.#view.ox) / scale, x1 = (width - this.#view.ox) / scale;
    const y0 = (this.#view.oy - height) / scale, y1 = this.#view.oy / scale;

    const lines = (from, to, st, vertical, color) => {
      ctx.beginPath();
      for (let v = Math.ceil(from / st) * st; v <= to; v += st) {
        if (vertical) {
          const x = Math.round(this.#tx(v)) + 0.5;
          ctx.moveTo(x, 0); ctx.lineTo(x, height);
        } else {
          const y = Math.round(this.#ty(v)) + 0.5;
          ctx.moveTo(0, y); ctx.lineTo(width, y);
        }
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    lines(x0, x1, step, true, COLORS.grid);
    lines(y0, y1, step, false, COLORS.grid);
    lines(x0, x1, major, true, COLORS.gridMajor);
    lines(y0, y1, major, false, COLORS.gridMajor);

    // origin axes
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(this.#tx(0), this.#ty(0)); ctx.lineTo(width, this.#ty(0));
    ctx.strokeStyle = COLORS.axisX; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(this.#tx(0), this.#ty(0)); ctx.lineTo(this.#tx(0), 0);
    ctx.strokeStyle = COLORS.axisY; ctx.stroke();

    ctx.fillStyle = COLORS.label;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`grid ${step} mm`, width - 80, height - 12);
  }

  /** Draw newly plotted segments only (or everything after an invalidate). */
  #drawProgress(width, height, full) {
    const ctx = this.ctx.progress;
    if (full) {
      ctx.clearRect(0, 0, width, height);
      this.#doneSeg = 0;
    }
    const s = this.#segments;
    let i = this.#doneSeg;
    if (i >= s.length || s[i + 5] >= this.#doneLine) return;

    const draw = new Path2D(), travel = new Path2D();
    for (; i < s.length && s[i + 5] < this.#doneLine; i += STRIDE) {
      const p = s[i + 4] === 1 ? draw : travel;
      p.moveTo(this.#tx(s[i]), this.#ty(s[i + 1]));
      p.lineTo(this.#tx(s[i + 2]), this.#ty(s[i + 3]));
    }
    this.#doneSeg = i;
    ctx.lineCap = 'round';
    if (this.showTravel) this.#strokeTravel(ctx, travel);
    ctx.lineWidth = 1.75;
    ctx.strokeStyle = COLORS.done;
    ctx.stroke(draw);
  }

  #strokeTravel(ctx, path) {
    if (this.simulating) {
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = COLORS.simTravel;
      ctx.setLineDash([4, 3]);
    } else {
      ctx.lineWidth = 1;
      ctx.strokeStyle = COLORS.doneTravel;
    }
    ctx.stroke(path);
    ctx.setLineDash([]);
  }

  #drawOverlay(width, height) {
    const ctx = this.ctx.overlay;
    ctx.clearRect(0, 0, width, height);
    if (this.#head) return this.#drawHead(ctx, this.#head);
    let pos = this.#marker;
    if (!pos && this.#doneSeg > 0) {
      const s = this.#segments, i = this.#doneSeg - STRIDE;
      pos = { x: s[i + 2], y: s[i + 3] };
    }
    if (!pos) return;
    this.#drawCrosshair(ctx, this.#tx(pos.x), this.#ty(pos.y));
  }

  #drawCrosshair(ctx, x, y, color = COLORS.pen) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 11, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + 11, y);
    ctx.moveTo(x, y - 11); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + 11);
    ctx.stroke();
  }

  /** The line being drawn so far, then the pen: a filled dot when down, a crosshair when up. */
  #drawHead(ctx, { x, y, down, partial }) {
    const draw = new Path2D(), travel = new Path2D();
    for (let i = 0; i < partial.length; i += 5) {
      const p = partial[i + 4] === 1 ? draw : travel;
      p.moveTo(this.#tx(partial[i]), this.#ty(partial[i + 1]));
      p.lineTo(this.#tx(partial[i + 2]), this.#ty(partial[i + 3]));
    }
    ctx.lineCap = 'round';
    if (this.showTravel) this.#strokeTravel(ctx, travel);
    ctx.lineWidth = 1.75;
    ctx.strokeStyle = COLORS.done;
    ctx.stroke(draw);

    const sx = this.#tx(x), sy = this.#ty(y);
    if (!down) return this.#drawCrosshair(ctx, sx, sy, COLORS.simTravel);
    ctx.beginPath();
    ctx.arc(sx, sy, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(91, 140, 255, 0.25)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx, sy, 4, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.penDown;
    ctx.fill();
    ctx.strokeStyle = COLORS.pen;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  #bindInteraction(el) {
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, ox: this.#view.ox, oy: this.#view.oy };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.#autoFit = false;
      this.#view.ox = drag.ox + (e.clientX - drag.x);
      this.#view.oy = drag.oy + (e.clientY - drag.y);
      this.#invalidate('base', 'progress', 'overlay');
    });
    const end = () => {
      drag = null;
      el.classList.remove('dragging');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.#autoFit = false;
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = Math.exp(-e.deltaY * 0.0015);
      const v = this.#view;
      const scale = Math.min(500, Math.max(0.05, v.scale * k));
      const f = scale / v.scale;
      this.#view = { scale, ox: mx - (mx - v.ox) * f, oy: my - (my - v.oy) * f };
      this.#invalidate('base', 'progress', 'overlay');
    }, { passive: false });
    el.addEventListener('dblclick', () => {
      this.#autoFit = true;
      this.fit();
    });
  }
}
