import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleEffectsMusic, blendEffectsMusic } from '../src/world/alpine/EffectsMusic.js';
import { atmosphereMusic, ATMOSPHERE_NEUTRAL } from '../src/world/alpine/RangeAtmosphere.js';
import { compileLandscapeScore } from '../src/world/alpine/LandscapeScore.js';
import { sampleSkyPerformance } from '../src/world/alpine/SkyPerformance.js';
import { compileLensCues, revealLensFromCues, NEUTRAL_LENS } from '../src/render/CameraLens.js';

const durationMs = 90000;
const sections = [
  { startMs: 0, endMs: 20000, role: 'verse', meanEnergy: .15, relEnergy01: .15 },
  { startMs: 20000, endMs: 50000, role: 'chorus', meanEnergy: .9, relEnergy01: .9 },
  { startMs: 50000, endMs: 90000, role: 'verse', meanEnergy: .15, relEnergy01: .15 },
].map(section => ({ ...section, provenance: 'detected', confidence: 1 }));
function analysis(read) {
  const rateHz = 50, n = durationMs * rateHz / 1000 + 1;
  return { rateHz, n, bands: Array.from({ length: 7 }, () => Float32Array.from({ length: n }, (_, i) => read(i * 20))),
    rmsBands: Array.from({ length: 7 }, () => Float32Array.from({ length: n }, (_, i) => read(i * 20) * .1)),
    globalEnergyNorm: read };
}
const curves = analysis(t => t >= 20000 && t < 50000 ? .9 : .15);
const at = timeMs => sampleEffectsMusic({ timeMs, energyCurves: curves, sections });

test('sustained energy opens valley light over seconds and quiet passages settle', () => {
  const quiet = at(19000), arrival = at(20100), full = at(28000), settled = at(65000);
  assert.ok(arrival.atmosphere < quiet.atmosphere + .01, 'a boundary cannot flash the atmosphere');
  assert.ok(full.atmosphere > quiet.atmosphere + .65);
  assert.ok(full.expansion > .85 && settled.expansion < .01);
  assert.ok(Math.abs(quiet.atmosphere - settled.atmosphere) < .02);
  const a = { ...atmosphereMusic(quiet) }, b = { ...atmosphereMusic(full) };
  assert.ok(b.mistDensityMul < a.mistDensityMul * .6, 'distant layers become materially clearer');
  assert.ok(b.keyLightGain > a.keyLightGain + .2);
  assert.ok(b.mistGlow > a.mistGlow * 5 && b.shaftGain > a.shaftGain + .7);
  let prior = { ...atmosphereMusic(at(19000)) };
  for (let t = 19000 + 1000 / 30; t < 31000; t += 1000 / 30) {
    const next = { ...atmosphereMusic(at(t)) };
    for (const key of ['mistDensityMul', 'mistGlow', 'shaftGain', 'keyLightGain']) {
      assert.ok(Math.abs(next[key] - prior[key]) < .01, `${key} stays smooth at ${t}`);
    }
    prior = next;
  }
});

test('an isolated drum cannot drive a camera-sized atmospheric pulse', () => {
  const energyCurves = analysis(t => t >= 20000 && t < 20100 ? .95 : .15);
  const before = sampleEffectsMusic({ timeMs: 19999.9, energyCurves });
  let peak = 0;
  for (let t = 20000; t <= 26000; t += 50) peak = Math.max(peak, sampleEffectsMusic({ timeMs: t, energyCurves }).atmosphere);
  assert.ok(peak - before.atmosphere < .03);
  const silent = analysis(t => t < 20000 ? 0 : .9);
  assert.equal(sampleEffectsMusic({ timeMs: 19999.9, energyCurves: silent }).atmosphere, 0, 'no unheard onset');
  const normal = sampleEffectsMusic({ timeMs: 28000, energyCurves: curves, sections, calmLevel: 0 });
  const calm = sampleEffectsMusic({ timeMs: 28000, energyCurves: curves, sections, calmLevel: 1 });
  assert.equal(calm.atmosphere, normal.atmosphere, 'a fast calm gate cannot snap the slow light envelope');
  assert.equal(calm.expansion, normal.expansion);
});

test('music direction survives seeks and generation blending without render history', () => {
  const wanted = at(24612.75);
  for (const t of [0, 70000, 21000, 24612.75, 1000]) at(t);
  assert.deepEqual(at(24612.75), wanted);
  const quiet = at(19000), loud = at(28000), blended = blendEffectsMusic(quiet, loud, .25);
  for (const key of ['atmosphere', 'expansion']) assert.ok(Math.abs(blended[key] - (quiet[key] * .75 + loud[key] * .25)) < 1e-12);
  assert.equal(atmosphereMusic(sampleEffectsMusic({ preview: true })), ATMOSPHERE_NEUTRAL);
  assert.equal(atmosphereMusic(sampleEffectsMusic()), ATMOSPHERE_NEUTRAL);
});

test('broad sky light follows phrase direction while percussion remains localized', () => {
  const common = { atmosphere: .75, expansion: .8 };
  const quiet = sampleSkyPerformance({ ...common, energy: .1, bass: .1, kick: 0 });
  const hit = sampleSkyPerformance({ ...common, energy: 1, bass: 1, kick: 1 });
  assert.equal(hit.open, quiet.open);
  assert.equal(hit.radiance, quiet.radiance);
  assert.ok(Math.max(...hit.glints) > Math.max(...quiet.glints));
});

test('scenic lens gathers and reveals scale without beat pumping or stage tilt', () => {
  const cues = compileLensCues(sections, durationMs);
  const lens = t => revealLensFromCues(cues, t);
  assert.equal(lens(16999), NEUTRAL_LENS);
  assert.ok(lens(19000).halfAngleScale < 1);
  assert.ok(lens(20000).halfAngleScale < .86);
  assert.ok(lens(23000).halfAngleScale > lens(21000).halfAngleScale);
  assert.equal(lens(25000), NEUTRAL_LENS);
  for (let t = 16000; t <= 26000; t += 16) {
    const a = lens(t), b = lens(t + 16);
    assert.equal(a.zoomPulse, 0);
    assert.ok(a.halfAngleScale >= .84 && a.halfAngleScale <= 1, 'only authored coverage is shown');
    assert.ok(Math.abs(a.halfAngleScale - b.halfAngleScale) < .0017, 'framing travels over seconds');
  }
  assert.equal(revealLensFromCues(cues, 20000, true), NEUTRAL_LENS);
  const score = compileLandscapeScore({ sections, durationMs, energyCurves: curves });
  assert.deepEqual(score.at(23000).revealLens, lens(23000));
  assert.deepEqual(score.at(23000).revealLens, score.at(23000).revealLens);
});

test('analysis adoption preserves a reveal already gathering before a chorus', () => {
  const first = compileLandscapeScore({ sections, durationMs, energyCurves: curves });
  const replacement = sections.map(s => s.startMs === 20000 ? { ...s, startMs: 21000 } : s);
  const next = compileLandscapeScore({ sections: replacement, durationMs, energyCurves: curves,
    previous: first, committedThroughMs: 18500 });
  for (let t = 18500; t <= 25000; t += 250) assert.deepEqual(next.at(t).revealLens, first.at(t).revealLens);
});
