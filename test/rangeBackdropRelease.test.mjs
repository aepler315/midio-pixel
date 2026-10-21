import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';

// The lake mirror copies the stage into a CanvasTexture. Releasing that copy
// empties its canvas. A material still holding the disposed texture makes
// three reallocate it at 0x0 on the next draw: in Chromium that is
// "texSubImage2D: no canvas" and "glTexStorage2D: ... dimensions are not
// positive", which the hardware tour route recorded after about 17 s.
class Canvas2D {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() { return { clearRect() {}, drawImage() {}, save() {}, restore() {} }; }
}

function scene(residency = null) {
  const s = Object.create(RangeScene.prototype);
  const uniforms = { uBackdrop: { value: null }, uBackdropAmount: { value: 0 } };
  Object.assign(s, { THREE, residency, contextLost: false, contextEpoch: 0, backdrop: null,
    size: { width: 320, height: 180 }, prepared: new Map([['lake', { mirrorLevelM: 1900, uniforms }]]) });
  return { s, uniforms };
}

const stage = { width: 320, height: 180 };
const ctx = { canvas: {}, getTransform: () => ({ a: 1, d: 1, e: 0, f: 0 }) };
const mirrored = { qualityLevel: 0, frameId: 1 }, shed = { qualityLevel: 5, frameId: 2 };

function withCanvas(run) {
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = Canvas2D;
  try { return run(); } finally { globalThis.OffscreenCanvas = previous; }
}

// _prepareMirror binds the copy for the frame that made it.
function bind(s, uniforms) {
  uniforms.uBackdrop.value = s.backdrop.texture;
  uniforms.uBackdropAmount.value = 1;
  return s.backdrop;
}

for (const ledger of [false, true]) {
  const name = ledger ? 'residency ledger' : 'no ledger';
  test(`releasing the mirror backdrop unbinds it from every view (${name})`, () => withCanvas(() => {
    const { s, uniforms } = scene(ledger ? new GraphicsResidency() : null);
    assert.equal(s.captureBackdrop(ctx, stage, mirrored), true);
    const copy = bind(s, uniforms);
    let disposed = 0;
    copy.texture.addEventListener('dispose', () => disposed++);
    // Quality sheds the mirror: the copy is released on this path.
    assert.equal(s.captureBackdrop(ctx, stage, shed), false);
    assert.equal(disposed, 1);
    assert.equal(s.backdrop, null);
    assert.equal(uniforms.uBackdrop.value, null, 'a released copy must not remain bound');
    assert.equal(uniforms.uBackdropAmount.value, 0);
  }));
}

test('an evicted mirror backdrop is unbound before its canvas is emptied', () => withCanvas(() => {
  const residency = new GraphicsResidency({ budgetBytes: 320 * 180 * 8 });
  const { s, uniforms } = scene(residency);
  assert.equal(s.captureBackdrop(ctx, stage, mirrored), true);
  const copy = bind(s, uniforms);
  // Another owner takes the whole budget; the optional copy is evictable.
  assert.ok(residency.reserve({ key: 'range:tour-window:test', bytes: 320 * 180 * 8, owner: 'range-tour-window' }));
  assert.equal(copy.canvas.width, 0, 'eviction empties the copy canvas');
  assert.equal(s.backdrop, null);
  assert.equal(uniforms.uBackdrop.value, null, 'an evicted copy must not remain bound');
  assert.equal(uniforms.uBackdropAmount.value, 0);
}));

test('a live backdrop bound to another view is not unbound by an unrelated release', () => withCanvas(() => {
  const { s, uniforms } = scene();
  assert.equal(s.captureBackdrop(ctx, stage, mirrored), true);
  bind(s, uniforms);
  const other = { uBackdrop: { value: new THREE.Texture() }, uBackdropAmount: { value: 1 } };
  s.prepared.set('other', { mirrorLevelM: 1900, uniforms: other });
  s.releaseBackdrop();
  assert.equal(uniforms.uBackdrop.value, null);
  assert.ok(other.uBackdrop.value, 'only the released texture is unbound');
  assert.equal(other.uBackdropAmount.value, 1);
}));
