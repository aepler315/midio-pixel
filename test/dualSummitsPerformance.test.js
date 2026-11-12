import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDualSummitsPerformance, dualSummitsPose } from '../src/world/alpine/DualSummitsPerformance.js';
import { projectPoint } from '../src/world/terrain/SceneTravel.js';

const durationMs = 120000;
const energyCurves = { globalEnergyNorm: t => t < 20000 ? .15 : t < 45000 ? .6 : t < 80000 ? .3 : t < 105000 ? 1 : .2 };
const song = { durationMs, energyCurves };
const summits = [{ id: 'A', slotId: 'B1', positionM: [-13000, 7000, -4000] },
  { id: 'B', slotId: 'B2', positionM: [6000, 6500, -4000] }];
const view = { signaturePerformance: 'dual-summits', signatureSummits: summits,
  camera: { eyeEndM: [-5500, 2220, 19200], fovYDeg: 40 } };

test('five acts are ordered around a measured sustained late arrival', () => {
  const score = compileDualSummitsPerformance(song);
  assert.ok(Math.abs(score.cues.climaxMs - 80000) < 1000);
  assert.deepEqual(score.acts.map(a => a.id), ['first-presence', 'emergence', 'interplay', 'convergence', 'afterglow']);
  assert.ok(score.acts.every((a, i) => a.endMs > a.startMs && (!i || a.startMs === score.acts[i - 1].endMs)));
  assert.equal(score.at(0).act, 'first-presence');
  assert.equal(score.at(durationMs).act, 'afterglow');
  assert.equal(score.at(score.cues.climaxMs).convergence01, 1);
});

test('direct seeks, repeated draws and analysis adoption retain the signature score', () => {
  const first = compileDualSummitsPerformance(song);
  const saved = [0, 35000, 79000, 80000, 115000].map(t => first.at(t));
  for (const t of [119000, 250, 99000, 1000]) first.at(t);
  assert.deepEqual(saved, [0, 35000, 79000, 80000, 115000].map(t => first.at(t)));
  const adopted = compileDualSummitsPerformance({ ...song, energyCurves: { globalEnergyNorm: () => .1 }, previous: first });
  assert.equal(adopted, first, 'a heard signature schedule is not replanned by late analysis');
  for (const t of [NaN, -10, Infinity]) assert.deepEqual(first.at(t), first.at(0));
});

test('both summits rise monotonically, meet at the climax and hold their complete relief', () => {
  const score = compileDualSummitsPerformance(song);
  let previous = { B1: 0, B2: 0 };
  for (let t = 0; t <= durationMs; t += 250) {
    const s = score.at(t);
    for (const id of ['B1', 'B2']) { assert.ok(s.slotRise01[id] >= previous[id]); assert.ok(s.slotRise01[id] <= 1); }
    previous = s.slotRise01;
  }
  assert.deepEqual(score.at(score.cues.climaxMs).slotRise01, { B1: 1, B2: 1 });
  assert.ok(score.at(0).slotRise01.B1 > score.at(0).slotRise01.B2);
});

test('measured guitar groups earn different emphasis without re-labelling the other instruments', () => {
  const music = { roleSource: 'measured-stems', at: t => ({ energy: energyCurves.globalEnergyNorm(t),
    cleanShare: t < 45000 ? .6 : .1, distortionShare: t < 45000 ? .1 : .6 }) };
  const score = compileDualSummitsPerformance({ ...song, music });
  assert.ok(score.at(42000).focus01 < score.at(65000).focus01);
  assert.ok(score.at(42000).cleanShare + score.at(42000).distortionShare < .8, 'remaining instruments keep their share');
  assert.equal(score.at(durationMs).focus01, .5, 'the ending balances both regardless of the last guitar texture');
});

test('camera teaches the pair, contains both risen peaks at payoff, and keeps a final hold', () => {
  const score = compileDualSummitsPerformance(song);
  const open = dualSummitsPose(view, score.at(0), { baseM: 2050 });
  const earlyB = projectPoint(open, 16 / 9, [6000, 2050 + (6500 - 2050) * score.at(0).slotRise01.B2, -4000]);
  assert.ok(!earlyB || Math.abs(earlyB.x) > 1, 'B stays outside the intimate opening');
  const final = dualSummitsPose(view, score.at(durationMs), { baseM: 2050 });
  for (const summit of summits) {
    const p = projectPoint(final, 16 / 9, summit.positionM);
    assert.ok(p && Math.abs(p.x) < .85 && Math.abs(p.y) < .8, `hero ${summit.id} inside final composition`);
  }
  assert.deepEqual(final, dualSummitsPose(view, score.at(durationMs - 5000), { baseM: 2050 }));
  assert.equal(dualSummitsPose({ ...view, signaturePerformance: null }, score.at(0)), null);
  assert.equal(dualSummitsPose({ ...view, signatureSummits: [] }, score.at(0)), null);
});

test('short, silent and unknown songs have bounded ordered fallback direction', () => {
  for (const ms of [0, 100, 4000, 30000]) {
    const score = compileDualSummitsPerformance({ durationMs: ms });
    for (const t of [0, ms / 2, ms]) {
      const s = score.at(t);
      assert.ok(['first-presence', 'emergence', 'interplay', 'convergence', 'afterglow'].includes(s.act));
      assert.ok([s.reveal01, s.convergence01, s.focus01, ...Object.values(s.slotRise01)].every(Number.isFinite));
    }
    assert.equal(score.evidence, 'timed-fallback');
  }
});
