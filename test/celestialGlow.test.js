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

// The Range sky's CelestialPainter plays along with the sky score: the slow
// radiance reaches only the wide glare, the note pulse only the tight sun
// bloom and the moon's night aureole. Gradients in creation order.
function bodyRecorder() {
  const gradients = [], faces = [];
  const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over',
    save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, beginPath() {}, arc() {}, ellipse() {},
    closePath() {}, clip() {}, fill() {},
    createRadialGradient(...args) { const g = { args, stops: [], addColorStop(at, color) { this.stops.push([at, color]); } }; gradients.push(g); return g; },
    fillRect(...rect) { if (typeof this.fillStyle === 'string') faces.push(this.globalAlpha); },
    drawImage() { faces.push(this.globalAlpha); },
  };
  return { ctx, gradients, faces };
}
const alphaOf = color => Number(/,([^,]+)\)$/.exec(color)[1]);
const SUN = Object.freeze({ xFrac: .5, yFrac: .3, altitude01: .5, visibility: 1, radiusFrac: .012, colorHex: '#ffeecc' });
const MOON = Object.freeze({ xFrac: .3, yFrac: .2, altitude01: .5, radiusFrac: .02, illumination: .9 });

async function paintSun(music, options = {}) {
  const { CelestialPainter } = await import('../src/world/alpine/CelestialPainter.js');
  const { ctx, gradients } = bodyRecorder();
  new CelestialPainter({ buffers: { ensure: () => null } }).drawSun(ctx, SUN, 1280, 720, 0,
    music === undefined ? options : { ...options, music });
  assert.equal(gradients.length, 3);
  const [glare, disc, bloom] = gradients.map(({ args, stops }) => ({ args, stops }));
  return { glare, disc, bloom };
}
async function paintMoon(music) {
  const { CelestialPainter } = await import('../src/world/alpine/CelestialPainter.js');
  const { ctx, gradients, faces } = bodyRecorder();
  const painter = new CelestialPainter({ buffers: { ensure: () => null } });
  if (music === undefined) painter.drawMoon(ctx, MOON, SUN, 1280, 720, 1, .5, 1, 0);
  else painter.drawMoon(ctx, MOON, SUN, 1280, 720, 1, .5, 1, 0, { music });
  assert.equal(gradients.length, 1);
  return { aureole: { args: gradients[0].args, stops: gradients[0].stops }, faces };
}

test('sun and moon without a score are unchanged, and an expired note is no score', async () => {
  const { sampleSkyPerformance } = await import('../src/world/alpine/SkyPerformance.js');
  const plain = await paintSun(undefined);
  assert.deepEqual(await paintSun(null), plain);
  for (const quiet of [false, true]) assert.deepEqual(await paintSun(null, { quiet }), await paintSun(undefined, { quiet }));
  const expired = sampleSkyPerformance({ accents: [{ ageSec: 1.1, kind: 'kick', seed: .3, strength: 1 }] });
  assert.equal(expired, null, 'a kick past its duration leaves no score');
  assert.deepEqual(await paintSun(expired), plain);
  assert.deepEqual(await paintMoon(null), await paintMoon(undefined));
});

test('a kick lifts only the tight sun bloom; radiance caps the glare; the disc never moves', async () => {
  const plain = await paintSun(null);
  const kick = await paintSun({ pulse: 1, detail: 1, radiance: 0, open: 1 });
  assert.deepEqual(kick.glare, plain.glare, 'kick and open never pump the wide glare');
  assert.deepEqual(kick.disc, plain.disc);
  assert.notDeepEqual(kick.bloom.stops, plain.bloom.stops);
  assert.deepEqual(kick.bloom.args, plain.bloom.args, 'the bloom brightens, it does not grow');
  for (const [i, [, color]] of kick.bloom.stops.entries()) {
    assert.ok(alphaOf(color) <= alphaOf(plain.bloom.stops[i][1]) * 1.5 + 1e-12);
  }
  const radiant = await paintSun({ pulse: 0, detail: 1, radiance: 1 });
  assert.deepEqual(radiant.bloom, plain.bloom);
  assert.deepEqual(radiant.disc, plain.disc);
  assert.ok(radiant.glare.args[5] > plain.glare.args[5]);
  assert.ok(radiant.glare.args[5] <= plain.glare.args[5] * 1.08 + 1e-9, 'glare extent within +8%');
  for (const [i, [, color]] of radiant.glare.stops.entries()) {
    assert.ok(alphaOf(color) <= alphaOf(plain.glare.stops[i][1]) * 1.15 + 1e-12, 'glare alpha within +15%');
  }
  const loud = await paintSun({ pulse: 1, detail: 1, radiance: 1 });
  for (const g of [loud.glare, loud.bloom, loud.disc]) for (const [, color] of g.stops) assert.ok(alphaOf(color) <= 1);
  // The quiet look halves both responses.
  const quietPlain = await paintSun(null, { quiet: true }), quietLoud = await paintSun({ pulse: 1, detail: 1, radiance: 1 }, { quiet: true });
  const lift = (a, b) => alphaOf(b.stops[0][1]) / alphaOf(a.stops[0][1]) - 1;
  assert.ok(Math.abs(lift(quietPlain.bloom, quietLoud.bloom) - .25) < 1e-3);
  assert.ok(Math.abs(lift(quietPlain.glare, quietLoud.glare) - .075) < 1e-3);
  // Reduced detail scales the bloom response.
  const reduced = await paintSun({ pulse: 1, detail: .7, radiance: 0 });
  assert.ok(Math.abs(lift(plain.bloom, reduced.bloom) - .35) < 1e-3);
});

test('a note pulse lifts only the moon aureole at night, never its face or radius', async () => {
  const plain = await paintMoon(null), hit = await paintMoon({ pulse: 1, detail: 1, radiance: 1 });
  assert.deepEqual(hit.faces, plain.faces, 'the face alpha is unchanged');
  assert.deepEqual(hit.aureole.args, plain.aureole.args, 'the aureole radius is unchanged');
  assert.notDeepEqual(hit.aureole.stops, plain.aureole.stops);
  assert.deepEqual(hit.aureole.stops.map(([at]) => at), plain.aureole.stops.map(([at]) => at));
  for (const [i, [, color]] of hit.aureole.stops.entries()) {
    const before = alphaOf(plain.aureole.stops[i][1]), after = alphaOf(color);
    assert.ok(after <= 1 && Math.abs(after - Math.min(1, before * 1.5)) < 1e-12);
  }
});
