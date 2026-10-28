import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RAIL_PACE, RAIL_PACES, normalizeRailPace, compileSceneRailPlan,
  sceneRailPlanFromSnapshot, withSceneRailPace,
} from '../src/world/terrain/SceneRailPlan.js';
import { sceneProgressAt } from '../src/world/terrain/SceneTravel.js';

const choiceFor = name => name === 'missing' ? null : { view: { id: name === 'alias' ? 'A' : name } };
const section = (startMs, profile, extra = {}) => ({ startMs, profile, barMs: 1000, ...extra });
const compile = (extra = {}) => compileSceneRailPlan({
  sections: [section(0, 'A'), section(20000, 'B'), section(40000, 'A')],
  durationMs: 60000, choiceFor, ...extra,
});
const close = (actual, expected, epsilon = 1e-11) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
const state = (plan, index, timeMs) => plan.railStateAt(plan.occurrences[index].id, timeMs);
const json = value => JSON.parse(JSON.stringify(value));

// Break caught: invalid URL/storage inputs silently selecting a different pace.
test('pace normalizes supported numeric inputs and defaults invalid values', () => {
  assert.equal(DEFAULT_RAIL_PACE, 3);
  assert.deepEqual(RAIL_PACES, [1, 2, 3, 4]);
  assert.ok(Object.isFrozen(RAIL_PACES));
  for (const input of [1, 2, 3, 4, '1', '2', '3', '4']) assert.equal(normalizeRailPace(input), Number(input));
  for (const input of [undefined, null, '', true, false, {}, 0, 5, 2.5, Infinity, NaN, 'bad']) assert.equal(normalizeRailPace(input), 3);
});

// Break caught: rounding, upstream energy multiplication, or endpoint omission.
test('1x preserves the whole-song fitted base at off-grid samples', () => {
  const curves = { globalEnergyNorm: t => .5 + .4 * Math.sin(t / 2300) };
  const durationMs = 60007;
  const response = { smoothingMs: 780 };
  const plan = compile({ curves, durationMs, response, requestedMultiplier: 1 });
  for (const [i, timeMs] of [[0, 3.7], [0, 12009.3], [0, 26001.1], [1, 30000.9], [2, 56789.123], [2, durationMs]]) {
    close(state(plan, i, timeMs).progress01, sceneProgressAt({ timeMs, curves, durationMs, response }));
  }
  assert.equal(plan.snapshot.bases.length, 1, 'one table serves all occurrences');
  const base = plan.snapshot.bases[0];
  assert.equal(base.progress.length, Math.ceil(durationMs / 20) + 1);
  close(base.progress.at(-1), sceneProgressAt({ timeMs: durationMs, curves, durationMs, response }));
});

test('2x, 3x and 4x multiply an uncapped straight base derivative', () => {
  for (const requestedMultiplier of [2, 3, 4]) {
    const plan = compile({ requestedMultiplier });
    const baseline = compile({ requestedMultiplier: 1 });
    const speed = state(plan, 0, 6000).progress01 - state(plan, 0, 5000).progress01;
    const baseSpeed = state(baseline, 0, 6000).progress01 - state(baseline, 0, 5000).progress01;
    close(speed / baseSpeed, requestedMultiplier, .01);
    assert.equal(state(plan, 0, 5000).capped, false);
    close(state(plan, 0, 5000).coverage01, 1);
  }
});

test('expanded travel shifts its opening backward to fit without an early hold', () => {
  const curves = { globalEnergyNorm: () => .4 };
  const plan = compile({ sections: [section(0, 'A')], durationMs: 180000, curves, requestedMultiplier: 2 });
  assert.ok(sceneProgressAt({ curves, durationMs: 180000 }) > 0);
  close(state(plan, 0, 0).progress01, 0);
  const samples = [0, 20000, 100000, 179000, 180000].map(t => state(plan, 0, t));
  close(samples.at(-1).progress01, 1);
  assert.ok(samples.every(s => s.capped && s.effectiveMultiplier < 2 && s.coverage01 < 1));
  assert.ok(samples[3].progress01 < 1, 'cap compresses entire move, not just end');
  const speed = (samples[3].progress01 - samples[2].progress01) / 79000;
  const earlierSpeed = (samples[2].progress01 - samples[1].progress01) / 80000;
  close(speed / earlierSpeed, 1, .01);
});

test('zero/unknown duration previews midpoint with finite diagnostics', () => {
  for (const durationMs of [0, NaN, undefined, Infinity, -1]) {
    const plan = compile({ durationMs });
    assert.ok(plan.occurrences.length > 0);
    for (const t of [-1, 0, 100000]) {
      const s = state(plan, 0, t);
      assert.equal(s.progress01, .5);
      assert.equal(s.coverage01, 1);
      assert.ok(Number.isFinite(s.effectiveMultiplier));
      assert.equal(s.policy, 'rail');
    }
  }
});

test('JSON restoration samples independently after original energy curves are discarded', () => {
  let available = true;
  const curves = { globalEnergyNorm: t => { assert.ok(available); return .3 + .2 * Math.sin(t / 900); } };
  const plan = compile({ curves });
  const expected = [7000.1, 23001.3, 54009.8].map((t, i) => state(plan, i, t));
  const snapshot = json(plan.snapshot);
  available = false;
  const restored = sceneRailPlanFromSnapshot(snapshot);
  snapshot.bases[0].progress[0] = 999;
  assert.deepEqual([7000.1, 23001.3, 54009.8].map((t, i) => state(restored, i, t)), expected);
  assert.equal(restored.snapshot.id, plan.snapshot.id);
});

test('facade, snapshot tables, occurrences, fits, selection and rail states are frozen', () => {
  const plan = compile();
  for (const value of [plan, plan.snapshot, plan.snapshot.bases, plan.snapshot.bases[0], plan.snapshot.bases[0].progress,
    plan.occurrences, plan.occurrences[0], plan.occurrences[0].fit, plan.selectionAt(22000), state(plan, 0, 100)]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.equal(plan.occurrences, plan.snapshot.occurrences);
  assert.throws(() => { plan.occurrences[0].startMs = 400; }, TypeError);
});

test('snapshot restore explicitly rejects versions, nonfinite curves and invalid references', () => {
  const source = compile().snapshot;
  for (const mutate of [s => { s.version = 2; }, s => { s.bases[0].progress[2] = Infinity; },
    s => { s.occurrences[0].baseId = 'unknown'; }, s => { s.occurrences[0].fit.gain = NaN; }]) {
    const invalid = json(source); mutate(invalid);
    assert.throws(() => sceneRailPlanFromSnapshot(invalid), /invalid|unsupported/i);
  }
});

test('content identity is deterministic and changes with effective motion', () => {
  const plan = compile();
  assert.equal(compile().snapshot.id, plan.snapshot.id);
  assert.notEqual(withSceneRailPace(plan, 4).snapshot.id, plan.snapshot.id);
  assert.notEqual(compile({ curves: { globalEnergyNorm: () => .4 } }).snapshot.id, plan.snapshot.id);
  assert.equal(sceneRailPlanFromSnapshot(json(plan.snapshot)).snapshot.id, plan.snapshot.id);
});

test('merge consecutive actual views before padding and preserve separated A/B/A IDs', () => {
  const plan = compile({ sections: [section(0, 'A'), section(1000, { name: 'alias' }), section(20000, 'B'), section(40000, 'A')] });
  assert.deepEqual(plan.occurrences.map(o => [o.viewId, o.startMs, o.nominalEndMs, o.endMs]), [
    ['A', 0, 20000, 28200], ['B', 20000, 40000, 48200], ['A', 40000, 60000, 60000],
  ]);
  assert.notEqual(plan.occurrences[0].id, plan.occurrences[2].id);
  const forced = compile({ choiceFor: () => ({ view: { id: 'forced' } }) });
  assert.equal(forced.occurrences.length, 1);
  assert.equal(forced.occurrences[0].endMs, 60000);
});

test('unmapped gaps break adjacency and remain selectable on both transition sides', () => {
  const plan = compile({ sections: [section(0, 'A'), section(10000, 'missing'), section(20000, 'alias')] });
  assert.deepEqual(plan.occurrences.map(o => o.viewId), ['A', null, 'A']);
  assert.equal(plan.selectionAt(11000).to.viewId, null);
  assert.equal(plan.selectionAt(21000).from.viewId, null);
  assert.equal(plan.selectionAt(25000).to.viewId, 'A');
});

test('decorative and confidence-zero boundaries still switch actual views', () => {
  const plan = compile({ sections: [section(0, 'A'), section(10000, 'B', { confidence: 0, decorative: true, source: 'unsupported' })] });
  assert.equal(plan.selectionAt(15000).to.viewId, 'B');
  assert.equal(plan.occurrences[0].nominalEndMs, 10000);
});

test('normalize finite section bounds and keep an explicit section gap', () => {
  const plan = compile({ sections: [section(NaN, 'bad'), section(20000, 'B'), section(-100, 'A', { endMs: 12000 }), section(Infinity, 'bad'), section(90000, 'bad')] });
  assert.deepEqual(plan.occurrences.map(o => [o.viewId, o.startMs, o.nominalEndMs]), [
    ['A', 0, 12000], [null, 12000, 20000], ['B', 20000, 60000],
  ]);
});

test('selection uses the destination actual entering travel and collapses completed transitions', () => {
  const plan = compile({ sections: [section(0, 'A'), section(10000, 'B', { barMs: 750 }), section(59000, 'A', { barMs: 5000 })] });
  assert.equal(plan.occurrences[1].transitionMs, 3000);
  assert.equal(plan.occurrences[2].transitionMs, 7000);
  assert.equal(plan.occurrences[1].endMs, 60000, '8200 allowance clipped at song end');
  const start = plan.selectionAt(10000);
  assert.equal(start.from, plan.occurrences[0]);
  assert.equal(start.to, plan.occurrences[1]);
  assert.equal(start.travelP, 0);
  const middle = plan.selectionAt(10750);
  close(middle.travelP, .25);
  close(middle.transition01, .15625);
  const end = plan.selectionAt(13000);
  assert.equal(end.from, end.to);
  assert.equal(end.to, plan.occurrences[1]);
  assert.equal(end.travelP, 1);
  assert.equal(end.transition01, 1);
  assert.equal(plan.selectionAt(-100).to, plan.occurrences[0]);
  assert.equal(plan.selectionAt(90000).to, plan.occurrences[2]);
  assert.equal(compile({ sections: [] }).selectionAt(500), null);
  assert.equal(plan.railStateAt('unknown', 500), null);
});

test('sampling is bounded and independent of seek order', () => {
  const plan = compile();
  const first = state(plan, 1, 23001.3);
  state(plan, 1, 50000); state(plan, 2, 0); state(plan, 0, 999999);
  assert.deepEqual(state(plan, 1, 23001.3), first);
  assert.equal(state(plan, 1, -20000).progress01, state(plan, 1, 20000).progress01);
  assert.equal(state(plan, 1, 999999).progress01, state(plan, 1, 48200).progress01);
});

test('repace preserves every begun occurrence through its padded end after rewinds', () => {
  const old = compile({ requestedMultiplier: 2 });
  const updated = withSceneRailPace(old, 4, 22000);
  assert.equal(updated.snapshot.requestedMultiplier, 4);
  assert.deepEqual(updated.occurrences.slice(0, 2), old.occurrences.slice(0, 2));
  for (const t of [0, 21000, 25000, 48199]) for (const i of [0, 1]) assert.deepEqual(state(updated, i, t), state(old, i, t));
  assert.equal(updated.occurrences[2].requestedMultiplier, 4);
  assert.notEqual(state(updated, 2, 45000).progress01, state(old, 2, 45000).progress01);
  const atBoundary = withSceneRailPace(old, 4, 20000);
  assert.deepEqual(atBoundary.occurrences[1], old.occurrences[1], 'start at high-water is protected');
  assert.equal(withSceneRailPace(old, 2).snapshot.id, old.snapshot.id);
});

test('adoption preserves both begun transition sides and their old energy bases', () => {
  const old = compile({ curves: { globalEnergyNorm: () => .1 }, requestedMultiplier: 2 });
  const updated = compile({
    sections: [section(0, 'B'), section(5000, 'C'), section(25000, 'D'), section(45000, 'E')],
    curves: { globalEnergyNorm: () => .4 }, previous: old, committedThroughMs: 22000, requestedMultiplier: 4,
  });
  assert.deepEqual(updated.occurrences.slice(0, 2), old.occurrences.slice(0, 2));
  assert.equal(updated.occurrences[0].endMs, 28200);
  assert.equal(updated.occurrences[1].endMs, 48200);
  for (const t of [0, 21000, 25000, 47000]) for (const i of [0, 1]) assert.deepEqual(state(updated, i, t), state(old, i, t));
  assert.deepEqual(updated.occurrences.slice(2).map(o => [o.viewId, o.startMs, o.nominalEndMs]), [['A', 40000, 45000], ['E', 45000, 60000]]);
  assert.equal(updated.occurrences[2].transitionMs, old.occurrences[2].transitionMs);
  assert.equal(updated.snapshot.bases.length, 2);
  const restored = sceneRailPlanFromSnapshot(json(updated.snapshot));
  assert.deepEqual(state(restored, 1, 25000), state(old, 1, 25000));
  assert.deepEqual(state(restored, 3, 50000), state(updated, 3, 50000));
});

test('adoption anchor survives same-view fresh boundaries and merges only the future tail', () => {
  const old = compile();
  const updated = compile({ previous: old, committedThroughMs: 5000,
    sections: [section(0, 'C'), section(10000, 'D'), section(30000, 'B'), section(35000, 'alias'), section(50000, 'A')] });
  assert.deepEqual(updated.occurrences[0], old.occurrences[0]);
  assert.deepEqual(updated.occurrences.slice(1).map(o => [o.viewId, o.startMs, o.nominalEndMs]), [['B', 20000, 35000], ['A', 35000, 60000]]);
  assert.equal(updated.occurrences[1].transitionMs, old.occurrences[1].transitionMs);
});

test('adoption freezes a begun final run and cannot refit it across a same-view seam', () => {
  const old = compile();
  const final = compile({ previous: old, committedThroughMs: 45000, curves: { globalEnergyNorm: () => 1 } });
  assert.deepEqual(final.occurrences, old.occurrences);
  assert.deepEqual(final.snapshot.bases, old.snapshot.bases);
  const sameView = compile({ previous: old, committedThroughMs: 5000,
    choiceFor: () => ({ view: { id: 'A' } }) });
  assert.deepEqual(sameView.occurrences[0], old.occurrences[0]);
  assert.equal(sameView.occurrences[1].viewId, 'B', 'old scheduled anchor view is retained');
});

test('leading gaps and short final windows stay bounded through snapshot restoration', () => {
  const plan = compile({ durationMs: 19007, sections: [section(5000, 'A'), section(19000, 'B')] });
  assert.deepEqual(plan.occurrences.map(o => [o.viewId, o.startMs, o.endMs]), [[null, 0, 13200], ['A', 5000, 19007], ['B', 19000, 19007]]);
  const restored = sceneRailPlanFromSnapshot(json(plan.snapshot));
  for (const time of [-50, 0, 12000.7, 19003.5, 19007, 99999]) {
    assert.deepEqual(restored.selectionAt(time), plan.selectionAt(time));
    for (let i = 0; i < plan.occurrences.length; i++) {
      assert.deepEqual(state(restored, i, time), state(plan, i, time));
      assert.ok(state(plan, i, time).progress01 >= 0 && state(plan, i, time).progress01 <= 1);
    }
  }
});

test('empty and preview plans roundtrip without a live base sampler', () => {
  for (const plan of [compileSceneRailPlan(), compile({ durationMs: 0 })]) {
    const restored = sceneRailPlanFromSnapshot(json(plan.snapshot));
    assert.deepEqual(restored.snapshot, plan.snapshot);
    assert.deepEqual(restored.selectionAt(100000), plan.selectionAt(100000));
    if (plan.occurrences.length) assert.equal(state(restored, 0, 100000).progress01, .5);
  }
});

test('adopting a known duration treats an old midpoint preview as fresh uncommitted motion', () => {
  const preview = compile({ durationMs: 0 });
  const fresh = compile();
  assert.equal(state(preview, 0, 10000).progress01, .5);
  for (const committedThroughMs of [0, 5000]) {
    const adopted = compile({ previous: preview, committedThroughMs });
    assert.deepEqual(adopted.snapshot, fresh.snapshot);
    assert.equal(adopted.selectionAt(0).to, adopted.occurrences[0]);
    assert.equal(adopted.selectionAt(0).to.startMs, 0);
    assert.equal(adopted.selectionAt(20000).to.startMs, 20000);
    const restored = sceneRailPlanFromSnapshot(json(adopted.snapshot));
    assert.deepEqual(restored.snapshot, fresh.snapshot);
    close(state(restored, 0, 7000).progress01, state(fresh, 0, 7000).progress01);
  }
});
