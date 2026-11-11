// Phase 1a of the frame cost plan: the shed-mirror backdrop is softened by
// one filtered copy of the finished backdrop, never by a filter applied to
// every sky operation drawn into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangeScene, backdropBlur } from '../src/world/alpine/RangeScene.js';
import { rangeQuality } from '../src/world/alpine/RangeQuality.js';

/** A 2D context that records each drawing operation with the filter in effect. */
class RecordingCanvas {
  constructor(width, height) { this.width = width; this.height = height; this.ops = []; }
  getContext() {
    const canvas = this, stack = [];
    const ctx = { canvas, filter: 'none', globalCompositeOperation: 'source-over',
      save() { stack.push([this.filter, this.globalCompositeOperation]); },
      restore() { [this.filter, this.globalCompositeOperation] = stack.pop(); } };
    for (const name of ['clearRect', 'fillRect', 'fill', 'stroke', 'drawImage', 'fillText', 'arc']) {
      ctx[name] = function (...args) { canvas.ops.push({ name, filter: this.filter, op: this.globalCompositeOperation, self: args[0] === canvas }); };
    }
    return ctx;
  }
}

function scene() {
  const s = Object.create(RangeScene.prototype);
  Object.assign(s, { THREE, residency: null, contextLost: false, contextEpoch: 0, backdrop: null,
    size: { width: 320, height: 180 }, prepared: new Map([['lake', { mirrorLevelM: 1900, uniforms: { uBackdrop: { value: null }, uBackdropAmount: { value: 0 } } }]]) });
  return s;
}
const stage = { width: 320, height: 180 };
const ctx = { canvas: {}, getTransform: () => ({ a: 1, d: 1, e: 0, f: 0 }) };
// A sky of many operations, as RangeSkyRenderer draws (stars, clouds, aurora).
const sky = (target) => { for (let i = 0; i < 500; i++) target.fillRect(i, 0, 1, 1); target.drawImage({}, 0, 0); };

function capture(level) {
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = RecordingCanvas;
  try {
    const s = scene();
    const kept = s.captureBackdrop(ctx, stage, { qualityLevel: level, frameId: level + 1 }, sky);
    return { kept, ops: s.backdrop?.canvas.ops ?? [], width: s.backdrop?.width };
  } finally { globalThis.OffscreenCanvas = previous; }
}

test('at every level the backdrop issues at most one filtered operation', () => {
  for (let level = 0; level <= 6; level++) {
    const { kept, ops, width } = capture(level);
    if (!rangeQuality(level).waterBackdrop) { assert.equal(kept, false, `level ${level} keeps no backdrop`); continue; }
    assert.equal(kept, true);
    const filtered = ops.filter((o) => o.filter !== 'none');
    assert.ok(filtered.length <= 1, `level ${level}: ${filtered.length} filtered operations`);
    if (rangeQuality(level).waterMirror) assert.equal(filtered.length, 0, `level ${level} keeps the mirror and needs no blur`);
    else {
      assert.equal(filtered.length, 1, `level ${level} softens the shed-mirror backdrop`);
      assert.deepEqual(filtered[0], { name: 'drawImage', filter: backdropBlur(width), op: 'copy', self: true }, 'one filtered copy of the finished backdrop');
      assert.equal(ops.at(-1), filtered[0], 'after the sky and the grid copy');
    }
    assert.equal(ops.filter((o) => o.name === 'fillRect').length, 500, 'the sky itself is drawn unfiltered');
  }
});
