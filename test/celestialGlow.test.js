// The celestial halo (_drawOneCelestial's big radial gradient behind the
// sun/moon disc) was already cut to 0.55 alpha once (see git history:
// "Reduce sun glow/reflection intensity to ~55-65% of previous, same
// footprint") but left its footprint (gradient radius) untouched. Reported
// as still too intense afterward -- the footprint also scales up with
// CelestialApproach's own growth (up to 3.4x late in a song), so a wide
// radius multiplier compounds into a huge glow regardless of alpha. This
// pins both levers down from their prior state so neither regresses back.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.Path2D = class Path2D {
  moveTo() {} lineTo() {} closePath() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} rect() {}
};

class RecordingCtx {
  constructor() {
    this.gradients = []; // [{x0,y0,r0,x1,y1,r1}]
    this.arcs = []; // [{x,y,r}]
    this.alphaAtArc = []; // globalAlpha in effect when each arc's fill happened
    this._globalAlpha = 1;
    this._fillStyle = null;
    this._pendingArc = null;
  }
  get globalAlpha() { return this._globalAlpha; }
  set globalAlpha(v) { this._globalAlpha = v; }
  get fillStyle() { return this._fillStyle; }
  set fillStyle(v) { this._fillStyle = v; }
  set strokeStyle(v) {} set lineWidth(v) {} set lineJoin(v) {} set lineCap(v) {}
  set globalCompositeOperation(v) {}
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    this.gradients.push({ x0, y0, r0, x1, y1, r1 });
    const stops = [];
    return { stops, addColorStop: (offset, color) => stops.push({ offset, color }) };
  }
  createLinearGradient() { return this.createRadialGradient(0, 0, 0, 0, 0, 0); }
  beginPath() {}
  arc(x, y, r) { this._pendingArc = { x, y, r }; }
  moveTo() {} lineTo() {} closePath() {}
  fill() {
    if (this._pendingArc) { this.arcs.push(this._pendingArc); this.alphaAtArc.push(this._globalAlpha); this._pendingArc = null; }
  }
  stroke() {}
  save() {} restore() {} clip() {} rect() {} ellipse() {}
  quadraticCurveTo() {} bezierCurveTo() {} translate() {} rotate() {} scale() {}
  drawImage() {} fillRect() {} clearRect() {} strokeRect() {}
}

async function drawCelestial({ dominant = true } = {}) {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  const bm = Object.create(BiomeManager.prototype);
  const ctx = new RecordingCtx();
  const c = { radius: 40, color: '#ffdd88', haloColor: '#ffeecc', dominant };
  bm._drawOneCelestial(ctx, 300, 100, c, 1);
  return { ctx, c };
}

test('the halo footprint is meaningfully smaller than the previously-reported-too-intense radius', async () => {
  const { ctx, c } = await drawCelestial({ dominant: true });
  const haloArc = ctx.arcs[0];
  const priorRadius = c.radius * 3.2; // the old dominant multiplier
  assert.ok(
    haloArc.r < priorRadius * 0.85,
    `halo radius ${haloArc.r} should be meaningfully smaller than the prior ${priorRadius}`,
  );
});

test('the halo alpha is lower than the prior 0.55 (already-reduced) value', async () => {
  const { ctx } = await drawCelestial({ dominant: true });
  const haloAlpha = ctx.alphaAtArc[0];
  assert.ok(haloAlpha < 0.55, `halo alpha ${haloAlpha} should be below the prior 0.55`);
});

test('non-dominant (companion) bodies get a proportionally smaller halo than dominant ones', async () => {
  const dom = await drawCelestial({ dominant: true });
  const comp = await drawCelestial({ dominant: false });
  assert.ok(comp.ctx.arcs[0].r < dom.ctx.arcs[0].r);
});

test('a near-zero alpha (body below the horizon) draws nothing at all', async () => {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  const bm = Object.create(BiomeManager.prototype);
  const ctx = new RecordingCtx();
  bm._drawOneCelestial(ctx, 300, 100, { radius: 40, color: '#fff', haloColor: '#fff', dominant: true }, 0.01);
  assert.equal(ctx.arcs.length, 0);
});
