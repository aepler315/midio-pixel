import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParticleField, particleLightAmount, PARTICLE_LIGHT_CAP } from '../src/world/ParticleField.js';

test('firefly alpha is boosted during calm sections', () => {
  const a = new ParticleField({ kind: 'fireflies', color: '#fff', count: 10, speed: 10 }, 800, 600, 1);
  const b = new ParticleField({ kind: 'fireflies', color: '#fff', count: 10, speed: 10 }, 800, 600, 1);
  let maxA = 0, maxB = 0;
  for (let i = 0; i < 300; i++) {
    const t = i / 30;
    a.update(1 / 30, t, null, t * 1000, 0);
    b.update(1 / 30, t, null, t * 1000, 1);
    for (const p of a.particles) maxA = Math.max(maxA, p.alpha);
    for (const p of b.particles) maxB = Math.max(maxB, p.alpha);
  }
  assert.ok(maxB > maxA, `expected calm firefly alpha peak (${maxB}) to exceed energetic (${maxA})`);
  assert.ok(maxB <= 1, 'alpha must stay clamped to a valid range');
});

test('pollen alpha is boosted during calm sections', () => {
  const fakeEnergy = { sample: () => 0.4 };
  const a = new ParticleField({ kind: 'pollen', color: '#fff', count: 5, speed: 5 }, 800, 600, 2);
  const b = new ParticleField({ kind: 'pollen', color: '#fff', count: 5, speed: 5 }, 800, 600, 2);
  a.update(1 / 30, 0, fakeEnergy, 0, 0);
  b.update(1 / 30, 0, fakeEnergy, 0, 1);
  assert.ok(b.particles[0].alpha > a.particles[0].alpha);
  assert.ok(b.particles[0].alpha <= 1);
});

// --- The Wind (Movement II): every field that accepts a wind vector must
// actually be pushed by it, and a null/omitted wind must be a pure no-op
// (every consumer defaults wind to zero so existing callers are unaffected).

test('rain angle rides the wind: a strong rightward gust visibly slants the fall direction', () => {
  const calm = new ParticleField({ kind: 'rain', color: '#fff', count: 20, speed: 10 }, 800, 600, 5);
  const windy = new ParticleField({ kind: 'rain', color: '#fff', count: 20, speed: 10 }, 800, 600, 5);
  calm.update(1 / 60, 0, null, 0, 0, null);
  windy.update(1 / 60, 0, null, 0, 0, { x: 400, y: 0 });
  for (let i = 0; i < calm.particles.length; i++) {
    assert.ok(windy.particles[i].vx > calm.particles[i].vx, 'a rightward gust should push vx rightward relative to no wind');
  }
});

test('rain with no wind argument behaves exactly as before (defaults to zero)', () => {
  const a = new ParticleField({ kind: 'rain', color: '#fff', count: 10, speed: 10 }, 800, 600, 5);
  const b = new ParticleField({ kind: 'rain', color: '#fff', count: 10, speed: 10 }, 800, 600, 5);
  a.update(1 / 60, 0, null, 0, 0);
  b.update(1 / 60, 0, null, 0, 0, { x: 0, y: 0 });
  for (let i = 0; i < a.particles.length; i++) {
    assert.equal(a.particles[i].vx, b.particles[i].vx);
    assert.equal(a.particles[i].x, b.particles[i].x);
  }
});

// --- The Unraveling (Movement V): particle hues converge to the halo color ---

function fakeCtxCapturingFillStyle() {
  const styles = [];
  return {
    styles,
    set fillStyle(v) { styles.push(v); },
    get fillStyle() { return styles[styles.length - 1]; },
    save() {}, restore() {}, beginPath() {}, fill() {}, arc() {},
    createRadialGradient() { return { addColorStop() {} }; },
  };
}

test('with hueBlend=0 (or omitted), the field draws in its native color', () => {
  const field = new ParticleField({ kind: 'fireflies', color: '#ff0000', count: 3, speed: 1 }, 800, 600, 1);
  const ctx = fakeCtxCapturingFillStyle();
  field.draw(ctx, 1, '#0000ff', 0);
  assert.ok(ctx.styles.every((s) => s === '#ff0000'));
});

test('with hueBlend=1, the field draws fully in the halo color', () => {
  const field = new ParticleField({ kind: 'fireflies', color: '#ff0000', count: 3, speed: 1 }, 800, 600, 1);
  const ctx = fakeCtxCapturingFillStyle();
  field.draw(ctx, 1, '#0000ff', 1);
  for (const s of ctx.styles) assert.notEqual(s, '#ff0000');
});

test('hueBlend is computed once per draw call, not per particle (cheap even at high particle counts)', () => {
  const field = new ParticleField({ kind: 'fireflies', color: '#ff0000', count: 50, speed: 1 }, 800, 600, 1);
  const ctx = fakeCtxCapturingFillStyle();
  field.draw(ctx, 1, '#0000ff', 0.5);
  const unique = new Set(ctx.styles);
  assert.equal(unique.size, 1, 'every particle in one draw() call must share the same blended color');
});

test('snow drifts downwind: position shifts further in the wind direction than with no wind', () => {
  const calm = new ParticleField({ kind: 'snow', color: '#fff', count: 10, speed: 10 }, 800, 600, 7);
  const windy = new ParticleField({ kind: 'snow', color: '#fff', count: 10, speed: 10 }, 800, 600, 7);
  for (let i = 0; i < 30; i++) {
    calm.update(1 / 30, i / 30, null, i * 33, 0, null);
    windy.update(1 / 30, i / 30, null, i * 33, 0, { x: 300, y: 0 });
  }
  let anyFurtherRight = false;
  for (let i = 0; i < calm.particles.length; i++) {
    if (windy.particles[i].x > calm.particles[i].x) anyFurtherRight = true;
  }
  assert.ok(anyFurtherRight, 'a sustained rightward gust should carry at least one snowflake further right');
});

function fakeCtxFull() {
  return {
    save() {}, restore() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {},
    arc() {}, moveTo() {}, lineTo() {}, fillRect() {},
    createRadialGradient() { return { addColorStop() {} }; },
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {}, set globalAlpha(_v) {},
  };
}

test('sunshine/wind/fog: update+draw run without throwing and stay finite across a windy stretch', () => {
  for (const kind of ['sunshine', 'wind', 'fog']) {
    const field = new ParticleField({ kind, color: '#fff', count: 8, speed: 20 }, 800, 600, 3);
    const ctx = fakeCtxFull();
    for (let i = 0; i < 120; i++) {
      field.update(1 / 30, i / 30, null, i * 33, 0.4, { x: 40, y: -10 });
      assert.doesNotThrow(() => field.draw(ctx, 1, '#0000ff', 0.3));
    }
    for (const p of field.particles) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${kind} particle position must stay finite`);
    }
  }
});

test('wind particles blow rightward with a strong tailwind', () => {
  const field = new ParticleField({ kind: 'wind', color: '#fff', count: 10, speed: 20 }, 800, 600, 5);
  const startX = field.particles.map((p) => p.x);
  for (let i = 0; i < 30; i++) field.update(1 / 30, i / 30, null, i * 33, 0, { x: 200, y: 0 });
  let anyMovedRight = false;
  for (let i = 0; i < field.particles.length; i++) if (field.particles[i].x > startX[i]) anyMovedRight = true;
  assert.ok(anyMovedRight, 'wind particles should advance rightward under a rightward gust');
});

// --- Finish the Light: local lighting + rain that lands on the ground ---

test('particleLightAmount is a no-op on an empty or missing lights array', () => {
  assert.equal(particleLightAmount([], 10, 10), 0);
  assert.equal(particleLightAmount(null, 10, 10), 0);
  assert.equal(particleLightAmount(undefined, 10, 10), 0);
});

test('particleLightAmount is bounded, never negative, and ignores infinite-radius washes', () => {
  const local = { x: 0, y: 0, intensity: 4, radius: 80 };
  const onTop = particleLightAmount([local], 0, 0);
  assert.ok(onTop > 0, 'a local light at the particle should add some alpha');
  assert.ok(onTop <= PARTICLE_LIGHT_CAP, `boost must stay capped, got ${onTop}`);
  assert.ok(onTop >= 0, 'never negative');
  const far = particleLightAmount([local], 500, 500);
  assert.equal(far, 0, 'outside the radius contributes nothing');
  const celestial = particleLightAmount([{ x: 0, y: 0, intensity: 1 }], 0, 0); // no radius = Infinity
  assert.equal(celestial, 0, 'the celestial wash is not a particle catch');
});

test('draw() with no lights is a no-op on alpha (identical styles to today)', () => {
  const field = new ParticleField({ kind: 'snow', color: '#fff', count: 8, speed: 10 }, 800, 600, 3);
  const alphasA = [], alphasB = [];
  const ctxA = { ...fakeCtxFull(), set globalAlpha(v) { alphasA.push(v); } };
  const ctxB = { ...fakeCtxFull(), set globalAlpha(v) { alphasB.push(v); } };
  field.draw(ctxA, 1, null, 0);
  field.draw(ctxB, 1, null, 0, []);
  assert.deepEqual(alphasB, alphasA);
});

test('rain splash y-coordinate tracks a mocked heightAt() rather than a constant', () => {
  const field = new ParticleField({ kind: 'rain', color: '#fff', count: 12, speed: 10 }, 800, 600, 9);
  const shelf = 600 * 0.667;
  const terrainY = 510; // well off the old shelf, and above where rain will be after a few frames
  for (const p of field.particles) {
    p.y = 0;
    p.state = 'fall';
    p.splashT = 0;
  }
  // One long step so every drop crosses the mocked ground.
  field.update(2, 0, null, 0, 0, null, () => terrainY);
  for (const p of field.particles) {
    assert.equal(p.state, 'splash', 'every drop should have landed');
    assert.equal(p.y, terrainY, `splash y must follow heightAt, got ${p.y} (old shelf would be ${shelf})`);
    assert.notEqual(p.y, shelf);
  }
});

test('rain without a heightAt still lands on the original screen-fraction shelf', () => {
  const field = new ParticleField({ kind: 'rain', color: '#fff', count: 8, speed: 10 }, 800, 600, 4);
  for (const p of field.particles) { p.y = 0; p.state = 'fall'; }
  field.update(2, 0, null, 0, 0, null);
  const shelf = 600 * 0.667;
  for (const p of field.particles) {
    assert.equal(p.state, 'splash');
    assert.equal(p.y, shelf);
  }
});

test('an empty field draws nothing instead of throwing', () => {
  // The count is floored at 1 further down so a heavily shed field still
  // shows something. On an EMPTY field that floor read particles[0], which is
  // undefined, and the throw aborted the rest of the frame -- every frame,
  // for whatever world was holding the empty field. It only surfaced under
  // lighting, because that is the first branch to dereference the particle.
  const f = new ParticleField({ kind: 'fireflies', color: '#fff', count: 4, speed: 10 }, 800, 600, 1);
  f.particles = [];
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, prop) => (typeof prop === 'string' && prop !== 'then'
      ? (...args) => { calls.push(prop); return args[0]; }
      : undefined),
    set: () => true,
  });
  const lights = [{ x: 10, y: 10, r: 200, strength: 1 }];
  assert.doesNotThrow(() => f.draw(ctx, 1, null, 0, lights));
  assert.doesNotThrow(() => f.draw(ctx, 1));
  assert.equal(calls.length, 0, 'an empty field should not even open a save/restore pair');
});

// --- The caller's alpha is a scene-level fade, not a suggestion.
// BiomeManager sets globalAlpha twice around these fields: once for the
// opening gain, and again for the incoming half of a biome cross-blend,
// deliberately fading the field as a whole so individual particles don't
// pop as the gain rises. draw() used to ASSIGN globalAlpha per particle,
// which discarded both -- so neither fade did anything and particles
// arrived at full strength on their first frame.

/** Records the globalAlpha in force at each fill/stroke/drawImage, with
 *  save/restore semantics so the outer state can be checked afterwards. */
function alphaRecorder(startAlpha = 1) {
  const stack = [];
  const drawn = [];
  const ctx = {
    globalAlpha: startAlpha,
    save() { stack.push(this.globalAlpha); },
    restore() { this.globalAlpha = stack.pop(); },
    beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, closePath() {},
    translate() {}, rotate() {}, scale() {}, ellipse() {}, rect() {},
    fillText() {}, setLineDash() {},
    fill() { drawn.push(this.globalAlpha); },
    stroke() { drawn.push(this.globalAlpha); },
    drawImage() { drawn.push(this.globalAlpha); },
  };
  return { ctx, drawn };
}

test('a field scales through the alpha it is handed instead of replacing it', () => {
  const f = new ParticleField({ kind: 'snow', color: '#fff', count: 4, speed: 10 }, 800, 600, 1);

  const full = alphaRecorder(1);
  f.draw(full.ctx, 1);
  const faded = alphaRecorder(0.1);
  f.draw(faded.ctx, 1);

  assert.ok(full.drawn.length > 0, 'the control pass must actually draw');
  assert.equal(faded.drawn.length, full.drawn.length, 'the fade changes opacity, not particle count');
  for (let i = 0; i < full.drawn.length; i++) {
    assert.ok(
      Math.abs(faded.drawn[i] - full.drawn[i] * 0.1) < 1e-9,
      `particle ${i} drew at ${faded.drawn[i]}, expected a tenth of ${full.drawn[i]}`,
    );
  }
  assert.equal(faded.ctx.globalAlpha, 0.1, 'the outer alpha is left as it was found');
});

test('a field faded to nothing draws nothing', () => {
  const f = new ParticleField({ kind: 'snow', color: '#fff', count: 4, speed: 10 }, 800, 600, 1);
  const { ctx, drawn } = alphaRecorder(0);
  f.draw(ctx, 1);
  assert.deepEqual(drawn, [], 'a field at zero alpha is invisible -- it should not be drawn at all');
  assert.equal(ctx.globalAlpha, 0);
});

test('the light boost brightens the particle, then the scene fade scales the result', () => {
  const f = new ParticleField({ kind: 'snow', color: '#fff', count: 4, speed: 10 }, 800, 600, 1);
  const lights = [{ x: f.particles[0].x, y: f.particles[0].y, intensity: 1, radius: 400 }];

  const lit = alphaRecorder(1);
  f.draw(lit.ctx, 1, null, 0, lights);
  const litFaded = alphaRecorder(0.5);
  f.draw(litFaded.ctx, 1, null, 0, lights);

  assert.ok(lit.drawn[0] > 0.85, 'the nearest particle should carry a light boost above the base snow alpha');
  assert.ok(lit.drawn[0] <= 1, 'the boost stays clamped');
  assert.ok(
    Math.abs(litFaded.drawn[0] - lit.drawn[0] * 0.5) < 1e-9,
    'the scene fade applies on top of the boost, not instead of it',
  );
});

// --- A draw multiplier of zero means the field is shed, not thinned.
// The drawn count is floored at 1 so a heavily shed field still shows
// something; that floor used to apply at zero too, so a governor rung that
// had switched particles off still paid for, and drew, one particle per
// field per frame -- at full opacity, in a world that had asked for none.

test('a zero draw multiplier draws no particles at all', () => {
  const f = new ParticleField({ kind: 'snow', color: '#fff', count: 4, speed: 10 }, 800, 600, 1);
  const { ctx, drawn } = alphaRecorder(1);
  f.draw(ctx, 0);
  assert.deepEqual(drawn, [], 'a shed field should draw nothing');
});

test('a negative or NaN draw multiplier is treated as shed, not as one particle', () => {
  const f = new ParticleField({ kind: 'snow', color: '#fff', count: 4, speed: 10 }, 800, 600, 1);
  for (const mul of [-1, -0.5, NaN]) {
    const { ctx, drawn } = alphaRecorder(1);
    f.draw(ctx, mul);
    assert.deepEqual(drawn, [], `multiplier ${mul} should draw nothing`);
  }
});

test('a small but positive multiplier still shows at least one particle', () => {
  const f = new ParticleField({ kind: 'snow', color: '#fff', count: 40, speed: 10 }, 800, 600, 1);
  const { ctx, drawn } = alphaRecorder(1);
  f.draw(ctx, 0.001);
  assert.equal(drawn.length, 1, 'shedding hard thins the field to one, it does not switch it off');
});
