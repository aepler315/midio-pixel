// Song range composition, Phase 4: each slot of a composed stage climbs with
// its part of the song (compileStageRise), on compileLandRise's clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLandRise, compileStageRise, stageSlotOrder, chorusLabel, LAND_RISE_START, LAND_RISE_CATCH_UP_MS }
  from '../src/world/alpine/LandRise.js';
import { compileLandscapeScore } from '../src/world/alpine/LandscapeScore.js';

const SLOTS = [
  { slotId: 'F1', row: 'front' }, { slotId: 'B2', row: 'back' }, { slotId: 'H1', row: 'horizon' }, { slotId: 'B1', row: 'back' },
  { slotId: 'H2', row: 'horizon' }, { slotId: 'F2', row: 'front' }, { slotId: 'B3', row: 'back' }, { slotId: 'H3', row: 'horizon' },
];
const read = (t) => 0.45 + 0.4 * Math.sin(t / 7300) * Math.cos(t / 1900);
const durationMs = 200000, cadenceMs = 196000, finaleMs = 7000;
// intro A, verse B, chorus C, verse B, chorus C, bridge D, chorus C, outro E.
const FORM = ['A', 'B', 'C', 'B', 'C', 'D', 'C', 'E'];
const sections = FORM.map((label, i) => ({ startMs: i * 24000, endMs: (i + 1) * 24000, label }));
const loudChorus = (t) => {
  const s = sections.find((x) => t >= x.startMs && t < x.endMs);
  return s?.label === 'C' ? 0.9 : 0.35;
};
const compile = (extra = {}) => compileStageRise({ slots: SLOTS, principal: 'B2', sections, read: loudChorus,
  durationMs, cadenceMs, finaleMs, ...extra });
const EPS = 1e-12;

test('slots run back to front; the chorus is the loudest repeated label', () => {
  assert.deepEqual(stageSlotOrder(SLOTS).map((s) => s.slotId), ['H1', 'H2', 'H3', 'B1', 'B2', 'B3', 'F1', 'F2']);
  assert.equal(chorusLabel(sections, loudChorus), 'C');
  assert.equal(chorusLabel(sections.map((s, i) => ({ ...s, label: `u${i}` })), loudChorus), null, 'no label repeats');
});

test('the principal climbs in the chorus; the other slots in their labels, back to front by first appearance', () => {
  const r = compile();
  assert.equal(r.mode, 'structure');
  assert.deepEqual(r.labels.B2, ['C']);
  // Remaining labels by first appearance: A, B, D, E over seven slots, cycled.
  assert.deepEqual(['H1', 'H2', 'H3', 'B1', 'B3', 'F1', 'F2'].map((id) => r.labels[id]), [['A'], ['B'], ['D'], ['E'], ['A'], ['B'], ['D']]);
  for (const s of sections) {
    const mid = (s.startMs + s.endMs) / 2;
    for (const id of r.slotIds) {
      const climbs = r.progressAt(id, mid + 2000) - r.progressAt(id, mid - 2000) > 1e-9;
      if (mid > r.endMs) continue;
      assert.equal(climbs, r.labels[id].includes(s.label), `${id} during ${s.label}`);
    }
  }
});

test('every slot starts one-third built, never sinks, and stands complete by the end', () => {
  for (const r of [compile(), compile({ sections: [] })]) {
    for (const id of r.slotIds) {
      assert.equal(r.at(id, 0), LAND_RISE_START, `${r.mode} ${id} at the first beat`);
      let prior = -Infinity;
      for (let t = 0; t <= durationMs; t += 137) {
        const v = r.at(id, t);
        assert.ok(v >= prior - EPS, `${r.mode} ${id} sinks at ${t}`);
        prior = v;
      }
      assert.equal(r.at(id, r.endMs), 1, `${r.mode} ${id} complete at endMs`);
    }
  }
});

test('a slot whose label only arrives after the climb ends makes it up in the final stretch', () => {
  // 27.5 s sections: the outro (E) starts at 192.5 s, after the climb ends.
  const late = FORM.map((label, i) => ({ startMs: i * 27500, endMs: Math.min(durationMs, (i + 1) * 27500), label }));
  const r = compile({ sections: late });
  assert.ok(late.find((s) => s.label === 'E').startMs >= r.endMs);
  assert.deepEqual(r.labels.B1, ['E']);
  assert.equal(r.at('B1', r.endMs - LAND_RISE_CATCH_UP_MS - 1), LAND_RISE_START);
  assert.ok(r.at('B1', r.endMs - LAND_RISE_CATCH_UP_MS / 2) > LAND_RISE_START);
  assert.equal(r.at('B1', r.endMs), 1);
});

test('seeks are pure: any order of queries, any recompile, the same rise', () => {
  const a = compile(), b = compile();
  const times = Array.from({ length: 400 }, (_, i) => (i * 7919) % durationMs);
  const forward = times.map((t) => a.slotsAt(t));
  const shuffled = [...times].reverse().map((t) => b.slotsAt(t)).reverse();
  assert.deepEqual(forward, shuffled);
});

test('without sections the slots rise back to front from the scalar curve', () => {
  const r = compile({ sections: [] });
  assert.equal(r.mode, 'stagger');
  const t = r.endMs * 0.45, ids = r.slotIds;
  for (let k = 1; k < ids.length; k++) assert.ok(r.at(ids[k - 1], t) >= r.at(ids[k], t), `${ids[k - 1]} ahead of ${ids[k]}`);
  assert.ok(r.at('H1', t) > r.at('F2', t));
});

test('one slot is compileLandRise exactly, with or without structure and across a handoff', () => {
  const one = [{ slotId: 'B2', row: 'back' }];
  for (const secs of [sections, []]) {
    const scalar = compileLandRise({ read, durationMs, cadenceMs, finaleMs });
    const slot = compileStageRise({ slots: one, principal: 'B2', sections: secs, read, durationMs, cadenceMs, finaleMs });
    for (let t = 0; t <= durationMs; t += 97) {
      assert.equal(slot.at('B2', t), scalar.at(t));
      assert.equal(slot.meanAt(t), scalar.at(t));
    }
    const read2 = (t) => read(t * 1.07 + 900);
    const scalar2 = compileLandRise({ read: read2, durationMs, cadenceMs, finaleMs, previous: scalar.progressAt, freezeThroughMs: 41000 });
    const slot2 = compileStageRise({ slots: one, principal: 'B2', sections: secs, read: read2, durationMs, cadenceMs, finaleMs,
      previous: slot.progressAt, freezeThroughMs: 41000 });
    for (let t = 0; t <= durationMs; t += 97) assert.equal(slot2.at('B2', t), scalar2.at(t));
  }
});

test('whole-song analysis takes over each slot from where it stood, never sooner than the catch-up', () => {
  const opening = compile({ sections: [] });
  const freeze = 52000;
  const full = compile({ previous: opening.progressAt, freezeThroughMs: freeze });
  for (const id of full.slotIds) {
    const before = opening.at(id, freeze);
    assert.equal(full.at(id, freeze), before, `${id} frozen through the handoff`);
    assert.ok(Math.abs(full.at(id, freeze + 50) - before) < 0.01, `${id} no jump`);
    let prior = before;
    for (let t = freeze; t <= durationMs; t += 101) { const v = full.at(id, t); assert.ok(v >= prior - EPS, `${id} sinks`); prior = v; }
    if (before < 1) assert.ok(full.at(id, freeze + LAND_RISE_CATCH_UP_MS * 0.9) < 1, `${id} takes at least the catch-up`);
    assert.equal(full.at(id, full.endMs), 1);
  }
  // A score with no stage before the handoff hands its scalar to every slot.
  const scalar = compileLandRise({ read: loudChorus, durationMs, cadenceMs, finaleMs });
  const fromScalar = compile({ previousScalar: scalar.progressAt, freezeThroughMs: freeze });
  for (const id of fromScalar.slotIds) assert.equal(fromScalar.at(id, freeze), scalar.at(freeze));
});

test('the score carries each slot and rises catalog views at the slots\' mean', () => {
  const curves = { globalEnergyNorm: loudChorus };
  const plain = compileLandscapeScore({ energyCurves: curves, sections, durationMs });
  const staged = compileLandscapeScore({ energyCurves: curves, sections: sections.map((s) => ({ ...s, provenance: 'detected' })),
    durationMs, stage: { slots: SLOTS, principal: 'B2' } });
  assert.equal(plain.at(60000).slotRise01, null);
  assert.equal(plain.stageRise, null);
  for (let t = 0; t <= durationMs; t += 5000) {
    const s = staged.at(t);
    const values = Object.values(s.slotRise01);
    assert.equal(values.length, 8);
    assert.ok(Math.abs(s.rise01 - values.reduce((a, b) => a + b, 0) / 8) < 1e-12);
  }
  assert.equal(staged.stageRise.mode, 'structure');
  const held = compileLandscapeScore({ energyCurves: curves, sections, durationMs, stage: { slots: SLOTS, principal: 'B2' }, riseOverride: 0.5 });
  assert.deepEqual(Object.values(held.at(30000).slotRise01), Array(8).fill(0.5));
  assert.equal(held.at(30000).rise01, 0.5);
  const preview = staged.at(30000, { preview: true });
  assert.equal(preview.rise01, 1);
  assert.deepEqual(Object.values(preview.slotRise01), Array(8).fill(1));
});
