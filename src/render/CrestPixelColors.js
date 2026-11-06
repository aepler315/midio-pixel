let nextOwner = 0;
const ALLOCATION_UNIT = 64;

// The completed compositor is opaque. Two GPU copies therefore produce the
// arithmetic mean of the physical pixels above and below each output pixel,
// without synchronizing the output canvas through a CPU readback.
export class CrestColorPattern {
  constructor({ makeCanvas = null, residency = null } = {}) {
    this.makeCanvas = makeCanvas;
    this.residency = residency;
    this.key = `range:crest-colors:${++nextOwner}`;
    this.canvas = null;
    this.sourceSize = null;
  }

  _ensure(width, height, outputWidth, outputHeight) {
    if (this.canvas && this.residency && this.residency.get(this.key) !== this.canvas) this.release();
    if (this.canvas && this.canvas.width >= width && this.canvas.height >= height) return this.canvas;
    this.release();
    const w = Math.min(outputWidth, Math.ceil(width / ALLOCATION_UNIT) * ALLOCATION_UNIT);
    const h = Math.min(outputHeight, Math.ceil(height / ALLOCATION_UNIT) * ALLOCATION_UNIT);
    const reservation = this.residency?.reserve({ key: this.key, bytes: w * h * 4,
      owner: 'range-crest-colors', evictable: false, protect: [...this.residency.entries.keys()] });
    if (this.residency && !reservation) return null;
    let canvas;
    try {
      canvas = this.makeCanvas(w, h);
      canvas.width = w; canvas.height = h;
      if (!canvas.getContext?.('2d')) throw new Error('crest color context unavailable');
      if (reservation && !this.residency.commit(reservation, canvas, value => {
        value.width = value.height = 0;
        if (this.canvas === value) this.canvas = null;
      })) return null;
      this.canvas = canvas;
      return canvas;
    } catch {
      if (reservation) this.residency.releaseReservation(reservation);
      if (canvas) canvas.width = canvas.height = 0;
      return null;
    }
  }

  prepare(ctx, fit, geometries = []) {
    const output = ctx?.canvas, width = output?.width || 0, height = output?.height || 0;
    if (!this.makeCanvas || !ctx?.createPattern || ctx.isContextLost?.() || !(width > 0 && height > 2)
      || !Number.isFinite(fit?.scale) || fit.scale <= 0 || !Number.isFinite(fit?.x) || !Number.isFinite(fit?.y)) {
      this.release(); return null;
    }
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const geometry of geometries) {
      const count = Math.min(geometry?.count || 0, geometry?.x?.length || 0, geometry?.y?.length || 0);
      for (let i = 0; i < count; i++) {
        const x = fit.x + geometry.x[i] * fit.scale, y = fit.y + geometry.y[i] * fit.scale;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    if (!Number.isFinite(left) || right < 0 || left >= width || bottom < 1 || top >= height - 1) { this.release(); return null; }
    // Include the widest current crest stroke. Copies remain clipped to rows
    // where both +/- one-pixel source neighbours exist; black bars stay intact.
    const pad = Math.ceil(4 * (fit.height || height) / 1080) + 2;
    left = Math.max(0, Math.floor(left) - pad); right = Math.min(width, Math.ceil(right) + pad + 1);
    top = Math.max(1, Math.floor(top) - pad); bottom = Math.min(height - 1, Math.ceil(bottom) + pad + 1);
    const size = `${width}x${height}`;
    if (this.sourceSize !== size) this.release();
    const scratch = this._ensure(right - left, bottom - top, width, height);
    if (!scratch) return null;
    this.sourceSize = size;
    try {
      const copy = scratch.getContext('2d'), w = right - left, h = bottom - top;
      if (copy.isContextLost?.()) { this.release(); return null; }
      copy.setTransform(1, 0, 0, 1, 0, 0);
      copy.imageSmoothingEnabled = false;
      copy.globalAlpha = 1; copy.globalCompositeOperation = 'copy';
      copy.clearRect(0, 0, scratch.width, scratch.height);
      copy.drawImage(output, left, top - 1, w, h, 0, 0, w, h);
      copy.globalAlpha = .5; copy.globalCompositeOperation = 'source-over';
      copy.drawImage(output, left, top + 1, w, h, 0, 0, w, h);
      copy.globalAlpha = 1;
      const pattern = ctx.createPattern(scratch, 'no-repeat');
      if (!pattern?.setTransform) { this.release(); return null; }
      pattern.setTransform({ a: 1, b: 0, c: 0, d: 1, e: left, f: top });
      return pattern;
    } catch {
      this.release(); return null;
    }
  }

  release() {
    const canvas = this.canvas;
    this.canvas = null; this.sourceSize = null;
    if (this.residency) this.residency.release(this.key);
    else if (canvas) canvas.width = canvas.height = 0;
  }
}
