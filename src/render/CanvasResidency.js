import { sharedResidency } from './GraphicsResidency.js';

let nextId = 0;
const stages = new WeakMap();
const bytesFor = (w, h) => w * h * 4;

/** The persistent page stage: account existing storage, reserve before resize.
 * A denied resize keeps its current picture and charge. */
export function resizeStageCanvas(canvas, width, height, residency = sharedResidency()) {
  let entry = stages.get(canvas);
  if (!entry || entry.residency !== residency) {
    entry?.residency.release(entry.key);
    entry = { key: `canvas-stage:${++nextId}`, residency };
    stages.set(canvas, entry);
    residency.adopt({ key: entry.key, bytes: bytesFor(canvas.width, canvas.height), owner: 'canvas-stage', evictable: false });
  }
  if (canvas.width === width && canvas.height === height) return true;
  const oldBytes = bytesFor(canvas.width, canvas.height);
  residency.release(entry.key);
  const reservation = residency.reserve({ key: entry.key, bytes: bytesFor(width, height), owner: 'canvas-stage', evictable: false });
  if (!reservation) {
    residency.adopt({ key: entry.key, bytes: oldBytes, owner: 'canvas-stage', evictable: false });
    return false;
  }
  canvas.width = width; canvas.height = height;
  residency.commit(reservation, canvas);
  return true;
}

/** Optional post effects have no second budget. Refusal skips that effect;
 * resizing and disposal release both the pixels and their ownership. */
export class CanvasBuffers {
  constructor({ residency = sharedResidency(), makeCanvas = () => document.createElement('canvas'), owner = 'canvas-post' } = {}) {
    this.residency = residency;
    this.owner = owner;
    this.makeCanvas = makeCanvas;
    this.id = ++nextId;
    this.buffers = new Map();
  }
  ensure(name, width, height, count = 1) {
    return this.ensureSizes(name, Array.from({ length: count }, () => [width, height]));
  }
  ensureSizes(name, sizes) {
    const count = sizes.length;
    const signature = JSON.stringify(sizes);
    const old = this.buffers.get(name);
    if (old && old.signature === signature && this.residency.get(old.key) === old.canvas) return old.canvas;
    if (old) { this.residency.release(old.key); this.buffers.delete(name); }
    const key = `canvas-post:${this.id}:${name}`;
    const reservation = this.residency.reserve({ key, bytes: sizes.reduce((sum, [w, h]) => sum + bytesFor(w, h), 0), owner: this.owner, evictable: false });
    if (!reservation) return null;
    let canvas;
    try {
      const buffers = [];
      canvas = count === 1 ? null : buffers;
      for (let i = 0; i < count; i++) {
        const buffer = this.makeCanvas(); buffers.push(buffer);
        if (count === 1) canvas = buffer;
        buffer.width = sizes[i][0]; buffer.height = sizes[i][1];
      }
      if (!this.residency.commit(reservation, canvas, c => {
        for (const buffer of (Array.isArray(c) ? c : [c])) { buffer.width = 0; buffer.height = 0; }
      })) return null;
      this.buffers.set(name, { key, canvas, signature });
      return canvas;
    } catch (error) {
      this.residency.releaseReservation(reservation);
      if (canvas) for (const buffer of (Array.isArray(canvas) ? canvas : [canvas])) { buffer.width = 0; buffer.height = 0; }
      throw error;
    }
  }
  release(name) {
    const entry = this.buffers.get(name);
    if (!entry) return;
    this.buffers.delete(name); this.residency.release(entry.key);
  }
  dispose() {
    for (const { key } of this.buffers.values()) this.residency.release(key);
    this.buffers.clear();
  }
}
