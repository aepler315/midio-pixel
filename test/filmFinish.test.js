import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FilmFinish, vignetteTarget, gradeTarget, landscapeFinish } from '../src/render/FilmFinish.js';

function fakeHype({ surge = 0, slam = 0, fast = 0 } = {}) {
  return { surge, slam, fast };
}

test('vignetteTarget: bounded, monotonic, never fully vanishes when calm', () => {
  let prevOverHype = 1;
  for (let hypeOpen = 0; hypeOpen <= 1; hypeOpen += 0.1) {
    const v = vignetteTarget(1, hypeOpen);
    assert.ok(v >= 0 && v <= 1);
    assert.ok(v <= prevOverHype + 1e-9, 'must not increase as hypeOpen rises (fixed calm)');
    prevOverHype = v;
  }
  assert.ok(vignetteTarget(1, 1) > 0, 'a full hype punch must never fully zero out the vignette');

  let prevOverCalm = 0;
  for (let calm = 0; calm <= 1; calm += 0.1) {
    const v = vignetteTarget(calm, 0);
    assert.ok(v >= prevOverCalm - 1e-9, 'must not decrease as calm rises (fixed hypeOpen)');
    prevOverCalm = v;
  }
});

test('gradeTarget: bounded, rises with budget and with less calm', () => {
  for (let calm = 0; calm <= 1; calm += 0.25) {
    for (let budget = 0; budget <= 1; budget += 0.25) {
      const g = gradeTarget(calm, budget);
      assert.ok(g >= 0 && g <= 1);
    }
  }
  assert.ok(gradeTarget(0.5, 1) > gradeTarget(0.5, 0), 'higher budget should read warmer');
  assert.ok(gradeTarget(0, 0.5) > gradeTarget(1, 0.5), 'less calm (more energetic) should read warmer');
});

test('FilmFinish starts calm and cool, matching the intro\'s resting state', () => {
  const ff = new FilmFinish();
  assert.equal(ff.vignetteDepth, 1);
  assert.equal(ff.warmth, 0.3);
});

test('FilmFinish.update converges to the target under sustained conditions', () => {
  const ff = new FilmFinish();
  for (let i = 0; i < 600; i++) ff.update(i * 16.7, 1 / 60, 0.2, 0.9, fakeHype());
  const depthTarget = vignetteTarget(0.2, 0);
  const warmTarget = gradeTarget(0.2, 0.9);
  assert.ok(Math.abs(ff.vignetteDepth - depthTarget) < 1e-3, `vignetteDepth ${ff.vignetteDepth} vs target ${depthTarget}`);
  assert.ok(Math.abs(ff.warmth - warmTarget) < 1e-3, `warmth ${ff.warmth} vs target ${warmTarget}`);
});

test('FilmFinish.update: a hype surge measurably opens the vignette, then it recovers', () => {
  const ff = new FilmFinish();
  for (let i = 0; i < 300; i++) ff.update(i * 16.7, 1 / 60, 1, 0.5, fakeHype()); // settle fully calm/deep
  const preDropDepth = ff.vignetteDepth;
  assert.ok(preDropDepth > 0.9);

  ff.update(5000, 1 / 60, 1, 0.5, fakeHype({ surge: 1 }));
  assert.ok(ff.vignetteDepth < preDropDepth, 'a surge must measurably open the vignette');

  for (let i = 0; i < 300; i++) ff.update(5000 + i * 16.7, 1 / 60, 1, 0.5, fakeHype());
  assert.ok(Math.abs(ff.vignetteDepth - preDropDepth) < 0.01, 'should recover back to the pre-drop depth, no overshoot');
});

test('FilmFinish.update is resilient to degenerate dt and stays bounded across extreme swings', () => {
  const ff = new FilmFinish();
  ff.update(0, 0, 0.5, 0.5, fakeHype());
  assert.ok(Number.isFinite(ff.vignetteDepth) && Number.isFinite(ff.warmth));
  ff.update(1e9, 1e6, 0.5, 0.5, fakeHype({ surge: 1, slam: 1, fast: 1 }));
  assert.ok(ff.vignetteDepth >= 0 && ff.vignetteDepth <= 1);
  assert.ok(ff.warmth >= 0 && ff.warmth <= 1);

  let t = 1e9;
  for (let i = 0; i < 500; i++) {
    t += 16.7;
    const calm = i % 2 === 0 ? 1 : 0;
    const budget = i % 3 === 0 ? 1 : 0.4;
    ff.update(t, 1 / 60, calm, budget, fakeHype({ surge: (i % 5) / 5 }));
    assert.ok(Number.isFinite(ff.vignetteDepth) && ff.vignetteDepth >= 0 && ff.vignetteDepth <= 1);
    assert.ok(Number.isFinite(ff.warmth) && ff.warmth >= 0 && ff.warmth <= 1);
  }
});

test('FilmFinish.update tolerates a missing hype (defensive only)', () => {
  const ff = new FilmFinish();
  assert.doesNotThrow(() => ff.update(0, 1 / 60, 0.5, 0.5, null));
  assert.ok(Number.isFinite(ff.vignetteDepth));
});

test('FilmFinish.hit: an authored cut snaps immediately, bypassing the lowpass', () => {
  const ff = new FilmFinish();
  for (let i = 0; i < 300; i++) ff.update(i * 16.7, 1 / 60, 0, 0, fakeHype()); // settle open/cool
  const preDepth = ff.vignetteDepth;
  const preWarmth = ff.warmth;

  ff.hit('drop');
  assert.equal(ff.vignetteDepth, 1, 'vignette snaps to the hard extreme on the hit call itself');
  assert.notEqual(ff.warmth, preWarmth, 'warmth also snaps, not just vignette');
  assert.ok(preDepth < 1, 'sanity: it really was not already at 1 before the hit');
});

test('FilmFinish.hit: the frame right after a hit resumes easing toward the normal target, not stuck', () => {
  const ff = new FilmFinish();
  ff.hit('apotheosis');
  const hitWarmth = ff.warmth;
  ff.update(0, 1 / 60, 0, 0, fakeHype());
  assert.notEqual(ff.warmth, hitWarmth, 'update() must move it off the snapped value again');
});

test('FilmFinish.hit: an unknown kind snaps the vignette but leaves warmth untouched', () => {
  const ff = new FilmFinish();
  const before = ff.warmth;
  ff.hit('not-a-real-moment');
  assert.equal(ff.vignetteDepth, 1);
  assert.equal(ff.warmth, before);
});

// Landscape's vignette: a pure function of the shared score.
const SILENT = Object.freeze({ energy: 0, lift: 0, kick: 0, stormAmount: 0 });
const finish = (score, opts) => landscapeFinish(score, opts, {});

test('landscapeFinish is pure: equal inputs give equal outputs, written into the caller\'s object', () => {
  const score = { energy: 0.4, lift: 0.3, kick: 0.6, stormAmount: 0.5 };
  const out = { edgeAlpha: -1, onset: -1 };
  assert.equal(landscapeFinish(score, { vignetteDepthMul: 1.08 }, out), out, 'writes into out, no new object');
  assert.deepEqual(finish(score, { vignetteDepthMul: 1.08 }), { ...out });
  assert.deepEqual(finish({ ...score }, { vignetteDepthMul: 1.08 }), { ...out });
});

test('landscapeFinish: the silent score rests at the resting edge, and shedding keeps that edge', () => {
  const rest = finish(SILENT);
  assert.ok(Math.abs(rest.edgeAlpha - 0.32) < 1e-12, `resting edge ${rest.edgeAlpha}`);
  assert.equal(rest.onset, 0.56);
  assert.deepEqual(finish({}), rest, 'missing fields read as silence');
  const loud = { energy: 1, lift: 1, kick: 1, stormAmount: 1 };
  const shed = finish(loud, { heavy: false });
  assert.deepEqual(shed, rest, 'heavy off ignores the music and returns the resting edge');
  assert.ok(shed.edgeAlpha > 0, 'still a vignette, never zero');
});

test('landscapeFinish: a section lift strictly opens the edge', () => {
  for (const energy of [0, 0.4, 1]) {
    for (const stormAmount of [0, 1]) {
      const closed = finish({ energy, lift: 0, stormAmount }).edgeAlpha;
      const open = finish({ energy, lift: 1, stormAmount }).edgeAlpha;
      assert.ok(open < closed, `energy ${energy} storm ${stormAmount}: ${open} < ${closed}`);
    }
  }
});

test('landscapeFinish: a kick only widens the onset and never raises the edge', () => {
  for (const energy of [0, 0.3, 0.5, 1]) {
    const base = finish({ energy, lift: 0.2 });
    for (const kick of [0.1, 0.5, 1]) {
      const hit = finish({ energy, lift: 0.2, kick });
      assert.ok(hit.edgeAlpha <= base.edgeAlpha, 'kick never darkens the frame');
      assert.equal(hit.edgeAlpha, base.edgeAlpha);
      assert.ok(hit.onset > base.onset, 'kick pushes the onset outward');
    }
  }
});

test('landscapeFinish follows energy with several distinct edges, always within [.10, .36]', () => {
  const edges = new Set();
  for (let i = 0; i <= 20; i++) edges.add(finish({ energy: i / 20 }).edgeAlpha.toFixed(4));
  assert.ok(edges.size >= 3, `distinct edges across energy: ${[...edges]}`);
  assert.ok(finish({ energy: 1 }).edgeAlpha < finish({ energy: 0 }).edgeAlpha, 'quiet passages are deeper');
  for (const energy of [0, 0.3, 0.6, 1]) for (const lift of [0, 1]) for (const stormAmount of [0, 1])
    for (const kick of [0, 1]) for (const vignetteDepthMul of [0, 0.5, 1, 1.08, 3]) for (const heavy of [true, false]) {
      const { edgeAlpha, onset } = finish({ energy, lift, kick, stormAmount }, { heavy, vignetteDepthMul });
      assert.ok(edgeAlpha >= 0.10 && edgeAlpha <= 0.36, `edge ${edgeAlpha}`);
      assert.ok(onset >= 0.56 && onset <= 0.585 + 1e-12, `onset ${onset}`);
    }
});
