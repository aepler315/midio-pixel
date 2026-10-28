// Trio's cast is lit by the celestial and the kick-glow ground pulses, and by
// each other's glow (never their own), and stands in contact shadows thrown
// away from the same light (Renderer._drawTrioCast).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render/Renderer.js';
import { MIDIO_IDENTITY_HUE } from '../src/render/ColorLaw.js';
import { SHADOW_ALPHA_MAX, contactShadow } from '../src/world/ContactShadow.js';

const MIDASUS_HUE = 212;

function stubTrio({ midioY = 0, voyageDepth = 0 } = {}) {
  const drawn = {};
  const trio = {
    midio: { screenX: 520, groundY: 600, y: midioY, halfWidth: 23 },
    broshi: { burrow: { depth: 0 }, renderX: 380, groundY: 610, hopY: 0, shadowWidthPx: 70,
      draw(_ctx, _pose, lights) { drawn.broshi = lights; } },
    midasus: { p: { x: 640, y: 520 }, hue: MIDASUS_HUE, pulse: 1.4, voyage: { depth: voyageDepth },
      yFloor: 600, shadowWidthPx: 40,
      draw(_ctx, _particleMul, lights) { drawn.midasus = lights; } },
    performer: { beatFlash: 0.8 },
    ensemble: null, gaze: null, clockMs: 1000,
    pose() {
      return { midioDrawX: 520, midioY: 600 - midioY, scaleX: 1, scaleY: 1, leanDeg: 0,
        worldX: 2000, midioX: 435, originX: 435 };
    },
  };
  return { trio, drawn };
}

function stubSim(trio, { perf = { rimLightEnabled: true, contactShadowsEnabled: true }, biomes } = {}) {
  const celestial = { x: 100, y: 60, colorHex: '#ffe0b0', intensity: 0.8, celestialYFrac: 0.2 };
  return {
    trio, perf, heardTimeMs: 1000,
    songBeat: { snapshotAt: () => ({ freeTime: true }) },
    biomes: biomes === undefined ? { _groundLight: celestial, light: { x: 0, y: 0, intensity: 1 }, currentHaloColor: () => '#ffcc66' } : biomes,
    groundField: { activeGlowScreenLights: (worldX, originX) => [{ x: originX + 60, y: 600, intensity: 1, worldX }] },
    celestial,
  };
}

/** Records contact-shadow ellipses drawn under 'multiply'. */
function shadowCtx() {
  const ellipses = [];
  const ctx = {
    globalCompositeOperation: 'source-over', globalAlpha: 1, fillStyle: '',
    save() {}, restore() {}, beginPath() {}, fill() {},
    createRadialGradient: () => ({ addColorStop(offset, color) {
      if (offset === 0) ellipses.alphas.push(Number(/,([\d.]+)\)$/.exec(color)[1]));
    } }),
    ellipse(cx, cy, rx, ry) { ellipses.push({ cx, cy, rx, ry, op: ctx.globalCompositeOperation }); },
  };
  ellipses.alphas = [];
  return { ctx, ellipses };
}

function cast(sim, drawn, r = Object.create(Renderer.prototype)) {
  r._drawMidio = (_ctx, _pose, _performer, _tSec, _melt, _apo, _hue, _ensemble, lights) => { drawn.midio = lights; };
  const { ctx, ellipses } = shadowCtx();
  r._drawTrioCast(ctx, sim, 1);
  return { r, ellipses };
}

const isCelestial = (sim) => (l) => l === sim.celestial;
const glowOf = (lights, hue) => lights.find(l => l.hueDeg === hue);

test('each character is lit by the celestial and the ground pulse, and by the others\' glow, never its own', () => {
  const { trio, drawn } = stubTrio();
  const sim = stubSim(trio);
  cast(sim, drawn);
  for (const name of ['midio', 'broshi', 'midasus']) {
    const lights = drawn[name];
    assert.ok(Array.isArray(lights), `${name} receives a light list`);
    assert.ok(lights.some(isCelestial(sim)), `${name} sees the ground-space celestial`);
    assert.ok(lights.some(l => l.colorHex === '#ffcc66' && l.radius > 0 && l.x === 435 + 60), `${name} sees the kick-glow pulse`);
  }
  // Midio: Midasus's core, not his own glow.
  const herCore = glowOf(drawn.midio, MIDASUS_HUE);
  assert.deepEqual({ x: herCore.x, y: herCore.y }, { x: 640, y: 520 });
  assert.ok(Math.abs(herCore.intensity - 0.7) < 1e-12, '.5 * pulse');
  assert.equal(glowOf(drawn.midio, MIDIO_IDENTITY_HUE), undefined);
  // Midasus: Midio at his identity hue scaled by his beat flash, not her own.
  const his = glowOf(drawn.midasus, MIDIO_IDENTITY_HUE);
  assert.ok(his && his.x === 520 && his.y < 600, 'Midio\'s core above his foot');
  assert.ok(Math.abs(his.intensity - 0.4) < 1e-12);
  assert.equal(glowOf(drawn.midasus, MIDASUS_HUE), undefined);
  // Broshi: both.
  assert.ok(glowOf(drawn.broshi, MIDASUS_HUE) && glowOf(drawn.broshi, MIDIO_IDENTITY_HUE));
});

test('Midasus away on a voyage no longer lights Midio or Broshi', () => {
  const { trio, drawn } = stubTrio({ voyageDepth: 0.5 });
  cast(stubSim(trio), drawn);
  assert.equal(glowOf(drawn.midio, MIDASUS_HUE), undefined);
  assert.equal(glowOf(drawn.broshi, MIDASUS_HUE), undefined);
});

test('light lists are renderer-owned: identity-stable across frames', () => {
  const { trio, drawn } = stubTrio();
  const sim = stubSim(trio);
  const { r } = cast(sim, drawn);
  const first = { ...drawn };
  cast(sim, drawn, r);
  for (const name of ['midio', 'broshi', 'midasus']) assert.equal(drawn[name], first[name], name);
  assert.notEqual(drawn.midio, drawn.broshi);
  assert.notEqual(drawn.midio, drawn.midasus);
});

test('the rim-light rung sheds the cast lights', () => {
  const { trio, drawn } = stubTrio();
  cast(stubSim(trio, { perf: { rimLightEnabled: false, contactShadowsEnabled: true } }), drawn);
  assert.deepEqual([drawn.midio, drawn.broshi, drawn.midasus], [null, null, null]);
});

test('the contact-shadow rung sheds all three shadows', () => {
  const { trio, drawn } = stubTrio();
  const on = cast(stubSim(trio), drawn);
  assert.equal(on.ellipses.filter(e => e.op === 'multiply').length, 3);
  const off = cast(stubSim(trio, { perf: { rimLightEnabled: true, contactShadowsEnabled: false } }), drawn);
  assert.equal(off.ellipses.filter(e => e.op === 'multiply').length, 0);
});

test('an airborne character\'s shadow is thrown away from the light', () => {
  const grounded = stubTrio(), airborne = stubTrio({ midioY: 50 });
  const midioShadow = (stub) => cast(stubSim(stub.trio), stub.drawn).ellipses[1]; // Broshi, Midio, Midasus
  const g = midioShadow(grounded), a = midioShadow(airborne);
  assert.equal(g.cx, 520, 'grounded: underfoot');
  assert.ok(a.cx > g.cx, `light at the left throws it right: ${a.cx}`);
  assert.equal(a.cy, 600, 'and keeps it on the ground');
});

test('shadow alpha follows the light\'s intensity, floored so a dim sky still grounds the cast', () => {
  const alphaAt = (intensity) => {
    const { trio, drawn } = stubTrio();
    const sim = stubSim(trio);
    sim.celestial.intensity = intensity;
    return cast(sim, drawn).ellipses.alphas[1]; // Midio, grounded
  };
  assert.equal(alphaAt(1), Number(SHADOW_ALPHA_MAX.toFixed(3)));
  assert.equal(alphaAt(0.8), Number((SHADOW_ALPHA_MAX * 0.8).toFixed(3)));
  assert.equal(alphaAt(0), Number((SHADOW_ALPHA_MAX * 0.45).toFixed(3)), 'night or noon-occluded light keeps the floor');
});

test('no biomes or no light: the cast still draws, unlit, with today\'s shadows', () => {
  const { trio, drawn } = stubTrio();
  const sim = stubSim(trio, { biomes: null });
  const { ellipses } = cast(sim, drawn);
  assert.equal(drawn.midio.some(l => l === sim.celestial), false);
  assert.equal(ellipses.length, 3);
  const today = contactShadow(520, 600, 0, 46);
  assert.deepEqual(ellipses[1], { cx: today.cx, cy: today.cy, rx: today.rx, ry: today.ry, op: 'multiply' });
  assert.equal(today.alpha, SHADOW_ALPHA_MAX);
});
