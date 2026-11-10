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
  getContext() { return { clearRect() {}, drawImage() { this.drawFilter=this.filter; }, save() {}, restore() {} }; }
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
const mirrored = { qualityLevel: 0, frameId: 1 };

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
    // A view without water releases the copy even at the lowest quality.
    s.prepared.get('lake').mirrorLevelM=NaN;
    assert.equal(s.captureBackdrop(ctx, stage, { qualityLevel: 6, frameId: 2 }), false);
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

test('the sky backdrop survives every quality rung and serves river-only views at q6', () => withCanvas(() => {
  const { s, uniforms } = scene();
  assert.equal(s.captureBackdrop(ctx, stage, mirrored), true);
  const copy=bind(s, uniforms);
  for(let qualityLevel=1;qualityLevel<=6;qualityLevel++){
    assert.equal(s.captureBackdrop(ctx, stage, { qualityLevel, frameId: qualityLevel+1 }), true, `q${qualityLevel} keeps reflected sky`);
    assert.equal(s.backdrop,copy,'the bounded copy is reused');
    assert.equal(uniforms.uBackdrop.value,copy.texture);
    assert.match(copy.ctx.drawFilter,/^blur\(/,'the sky reflection softens after the planar mirror sheds');
  }
  const river = scene();
  river.s.prepared.set('lake', { mirrorLevelM: NaN, riverStats: { triangles: 1200 }, uniforms: river.uniforms });
  assert.equal(river.s.captureBackdrop(ctx, stage, { qualityLevel: 6, frameId: 8 }), true, 'a river-only view reflects the sky at q6');
  river.s.prepared.set('lake', { mirrorLevelM: NaN, riverStats: { triangles: 0 }, uniforms: river.uniforms });
  assert.equal(river.s.captureBackdrop(ctx, stage, { qualityLevel: 6, frameId: 9 }), false, 'no water, no copy');
}));

test('the backdrop copy is skipped while no drawn view has water, and kept for the view that will', () => withCanvas(() => {
  const { s } = scene();
  s.prepared.set('dry', { mirrorLevelM: NaN, riverStats: { triangles: 0 }, uniforms: {} });
  let copies = 0;
  const counting = { canvas: {}, getTransform: () => ({ a: 1, d: 1, e: 0, f: 0 }) };
  assert.equal(s.captureBackdrop(counting, stage, mirrored, null, ['lake']), true);
  const kept = s.backdrop;
  const draw = kept.ctx.drawImage;
  kept.ctx.drawImage = (...args) => { copies++; return draw.apply(kept.ctx, args); };
  assert.equal(s.captureBackdrop(counting, stage, { qualityLevel: 0, frameId: 2 }, null, ['dry']), false, 'nothing drawn reflects it');
  assert.equal(copies, 0, 'no canvas copy or upload for a dry frame');
  assert.equal(s.backdrop, kept, 'the allocation survives for the prefetched lake');
  assert.equal(s.captureBackdrop(counting, stage, { qualityLevel: 0, frameId: 3 }, null, ['dry', 'lake']), true, 'travel into the lake captures again');
  assert.equal(copies, 1);
}));
