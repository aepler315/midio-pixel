import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpaceRidge } from '../src/world/SpaceRidge.js';
import { BiomeManager } from '../src/world/BiomeManager.js';

function recordingCtx() {
  const fills = [];
  const heights = [];
  const stack = [];
  return {
    fills, heights, globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: null,
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation] = stack.pop(); },
    translate() {}, scale(_x, y) { heights.push(y); },
    createLinearGradient() { return { addColorStop() {} }; },
    fillRect() { fills.push({ alpha: this.globalAlpha, op: this.globalCompositeOperation }); },
  };
}

const canvas = { width: 1280, height: 720 };
const total = (ctx) => ctx.fills.reduce((sum, f) => sum + f.alpha, 0);

test('the aurora hangs from every ridge segment and is brightest at night', () => {
  const ridge = new SpaceRidge(315);
  const night = recordingCtx(), day = recordingCtx();
  ridge.drawAurora(night, canvas, '#9fe8c0', 10, { night01: 1 });
  ridge.drawAurora(day, canvas, '#9fe8c0', 10, { night01: 0 });
  assert.ok(night.fills.length >= 29 * 6, 'ray columns span the whole ridge');
  assert.ok(night.fills.every(f => f.op === 'lighter'), 'curtain light adds to the sky');
  assert.ok(total(day) > 0 && total(day) < total(night) * 0.5, 'a faint veil by day');
});

test('the aurora stands down with its presentation and is flash-safe', () => {
  const ridge = new SpaceRidge(315);
  const off = recordingCtx(), safe = recordingCtx();
  ridge.drawAurora(off, canvas, '#9fe8c0', 10, { presentation: 0 });
  assert.equal(off.fills.length, 0);
  ridge.drawAurora(safe, canvas, '#9fe8c0', 10, { reducedFlash: true });
  assert.ok(safe.fills.every(f => f.op === 'source-over'));
});

test('reduced motion holds the curtain\'s rays still, even through flashes', () => {
  const ridge = new SpaceRidge(315);
  const a = recordingCtx(), b = recordingCtx(), c = recordingCtx();
  ridge.drawAurora(a, canvas, '#9fe8c0', 3, { reducedMotion: true });
  ridge.drawAurora(b, canvas, '#9fe8c0', 9, { reducedMotion: true });
  assert.deepEqual(a.fills, b.fills);
  ridge._flashes = ridge.nodes.map((_, i) => ({ i, atMs: 9000 }));
  ridge.drawAurora(c, canvas, '#9fe8c0', 9, { reducedMotion: true });
  assert.deepEqual(c.heights, a.heights, 'a flash never stretches a ray');
  const live = recordingCtx();
  ridge.drawAurora(live, canvas, '#9fe8c0', 9);
  assert.ok(Math.max(...live.heights) > Math.max(...a.heights), 'with motion allowed, a flash does');
});

test('crest light draws nothing without terrain to land on', () => {
  let drawn = 0;
  const ctx = { save() {}, restore() {}, drawImage() { drawn++; } };
  const mgr = { _horizonEqPoints: () => [{ x: 0, y: 300 }, { x: 1280, y: 320 }], _landscapeGeometry: null };
  BiomeManager.prototype._drawCrestLight.call(mgr, ctx, canvas, 0, null, null, 1, null);
  BiomeManager.prototype._drawCrestLight.call(mgr, ctx, canvas, 0, null, null, 1, { image: null, width: 0, height: 0 });
  assert.equal(drawn, 0);
});

test('nothing painted after the aurora can reach into its tallest flaring rays', () => {
  const ridge = new SpaceRidge(315);
  ridge._tSec = 10;
  ridge._flashes = ridge.nodes.map((_, i) => ({ i, atMs: 10000 }));
  for (const n of ridge.nodes) n.level = 1; // every band at full
  const { pts, maxH } = ridge._samples(canvas);
  const flashes = ridge._flashLevels(10);
  const corridor = ridge.corridor(canvas);
  for (let i = 0; i < pts.length - 1; i++) {
    const x = (pts[i].x + pts[i + 1].x) / 2, y = (pts[i].y + pts[i + 1].y) / 2;
    const tallest = ridge._curtainHeight(canvas, maxH, pts[i], pts[i + 1], flashes, 1);
    assert.ok(corridor(x).top <= y - tallest + 1e-6, `segment ${i} crown stays inside the corridor`);
    assert.ok(corridor(x).bottom >= y + tallest * 0.12 - 1e-6, `segment ${i} skirt stays inside the corridor`);
  }
});

test('crest light owns its buffers in the shared graphics budget', () => {
  const made = [];
  globalThis.document = { createElement: () => { const c = { width: 0, height: 0 }; made.push(c); return c; } };
  try {
    const calls = [];
    const residency = {
      ok: true,
      release(key) { calls.push(['release', key]); },
      reserve(r) { calls.push(['reserve', r.key, r.bytes]); return this.ok ? r : null; },
      commit() { calls.push(['commit']); return true; },
    };
    const mgr = Object.assign(Object.create(BiomeManager.prototype), { residency, _serial: 7 });
    const got = mgr._crestLightBuffers(1280, 720, 160, 90);
    assert.deepEqual(calls.slice(0, 3), [['release', 'crest-light#7'], ['reserve', 'crest-light#7', (1280 * 720 + 160 * 90) * 4], ['commit']]);
    assert.equal(got.light.width, 1280);
    calls.length = 0;
    mgr._crestLightBuffers(1280, 720, 160, 90);
    assert.equal(calls.length, 0, 'an unchanged size reserves nothing');
    residency.ok = false;
    assert.equal(mgr._crestLightBuffers(3840, 2160, 480, 270), null, 'a refusal skips the light');
    assert.ok(made.every(c => c.width === 0 && c.height === 0), 'and frees what it held');
    calls.length = 0;
    mgr._releaseCrestLight();
    assert.deepEqual(calls, [['release', 'crest-light#7'], ['release', 'range-skyline#7']]);
  } finally {
    delete globalThis.document;
  }
});
