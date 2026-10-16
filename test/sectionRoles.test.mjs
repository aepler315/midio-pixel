import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionRoles, sectionLeadDensities } from '../src/world/terrain/SectionRoles.js';

function sections(labels, energies, durations = labels.map(() => 20000)) {
  let at = 0;
  return labels.map((label, i) => {
    const startMs = at; at += durations[i];
    return { startMs, endMs: at, label, relEnergy01: energies[i], lowBandShare: .2, provenance: 'detected', transition: 'fade' };
  });
}
const roles = result => result.map(s => s.role);

test('repeated highest-energy form labels become choruses and the last chorus is flagged', () => {
  const input = sections(['V', 'C', 'V', 'C', 'B', 'C', 'O'], [.35, .8, .5, .8, .65, .85, .2]);
  const result = sectionRoles({ sections: input });
  assert.deepEqual(roles(result), ['intro', 'chorus', 'verse', 'chorus', 'bridge', 'chorus', 'outro']);
  assert.deepEqual(result.map(s => s.finalChorus), [false, false, false, false, false, true, false]);
});

test('EDM builds lead into two bass-heavy cut drops and no repeated build is mislabeled chorus', () => {
  const input = sections(['I', 'A', 'D', 'A', 'D', 'O'], [.2, .6, .95, .6, .96, .2], [20000, 10000, 20000, 10000, 20000, 20000]);
  for (const i of [1, 3]) input[i].energySlope = .2;
  for (const i of [2, 4]) { input[i].transition = 'cut'; input[i].lowBandShare = .6; }
  const result = sectionRoles({ sections: input });
  assert.deepEqual(roles(result), ['intro', 'pre-chorus', 'drop', 'pre-chorus', 'drop', 'outro']);
});

test('decorative provenance does not invent chorus, drop or bridge identities', () => {
  const input = sections(['X', 'Y', 'X', 'Y', 'Z'], [.8, 1, .1, 1, .8]);
  for (const s of input) { s.provenance = 'decorative'; s.transition = 'cut'; s.energySlope = .4; s.lowBandShare = .9; }
  assert.deepEqual(roles(sectionRoles({ sections: input })), ['intro', 'verse', 'verse', 'verse', 'outro']);
});

test('trusted lyric kinds override inferred form and lower-confidence labels do not', () => {
  const input = sections(['V', 'C', 'V', 'C', 'O'], [.2, .8, .5, .8, .2]);
  Object.assign(input[1], { kind: 'bridge', kindConfidence: .8 });
  Object.assign(input[2], { kind: 'chorus', kindConfidence: .7 });
  Object.assign(input[3], { kind: 'verse', kindConfidence: .49 });
  assert.deepEqual(roles(sectionRoles({ sections: input })), ['intro', 'bridge', 'chorus', 'chorus', 'outro']);
});

test('conductor role cues override lyrics and decorative inference, while transition cues do not name roles', () => {
  const input = sections(['A', 'B', 'C'], [.3, .8, .2]);
  Object.assign(input[1], { kind: 'verse', kindConfidence: 1 });
  const conductorSchedule = [{ kind: 'section', tMs: 0, value: 'fade' }, { kind: 'section', tMs: 20000, value: 'cut', role: 'solo' }];
  const result = sectionRoles({ sections: input, conductorSchedule });
  assert.equal(result[0].role, 'intro');
  assert.equal(result[1].role, 'solo');
  assert.equal(result[1].confidence, 1);
});

test('lead density reads active NoteEvents cast to MIDIO, uses seconds, and assigns boundary onsets to the next section', () => {
  const input = sections(['A', 'B', 'C'], [.5, .6, .6], [10000, 20000, 10000]);
  const noteEvents = [
    { tMs: 1000, lane: 'MIDIO', vel: .8 }, { tMs: 10000, lane: 'MIDIO', vel: .8 },
    { tMs: 15000, lane: 'MIDASUS', vel: .8 }, { tMs: 16000, lane: 'MIDIO', vel: 0 },
    { tMs: 30000, lane: 'MIDIO', vel: .8 }, { tMs: 31000, lane: 'MIDIO', vel: .8 },
  ];
  assert.deepEqual(sectionLeadDensities(input, noteEvents), [.1, .05, .2]);
  for (const s of input) { s.kind = 'instrumental'; s.kindConfidence = .8; }
  assert.deepEqual(roles(sectionRoles({ sections: input, noteEvents })), ['interlude', 'interlude', 'solo']);
  assert.deepEqual(roles(sectionRoles({ sections: input })), ['interlude', 'interlude', 'interlude']);
});

test('short rising and settling links get pre/post-chorus roles and a mid-song energy collapse gets breakdown', () => {
  const input = sections(['I', 'V', 'P', 'C', 'Q', 'V', 'C', 'X', 'O'], [.2, .5, .6, .8, .75, .5, .8, .2, .2],
    [20000, 20000, 8000, 20000, 8000, 20000, 20000, 20000, 20000]);
  input[2].energySlope = .1;
  const result = sectionRoles({ sections: input });
  assert.equal(result[2].role, 'pre-chorus');
  assert.equal(result[4].role, 'post-chorus');
  assert.equal(result[7].role, 'breakdown');
});

test('a chorus-labelled drop needs a tenth more energy than the other choruses and drops are capped at four', () => {
  const input = sections(['A', 'C', 'A', 'C', 'A', 'C', 'A', 'C', 'A', 'C', 'A', 'C', 'O'],
    [.6, .8, .6, .95, .6, .96, .6, .97, .6, .98, .6, .99, .2]);
  for (let i = 0; i < input.length - 1; i += 2) input[i].energySlope = .1;
  for (let i = 1; i < input.length - 1; i += 2) Object.assign(input[i], { transition: 'cut', lowBandShare: .7 });
  const result = sectionRoles({ sections: input });
  assert.equal(result[1].role, 'chorus');
  assert.ok(result.filter(s => s.role === 'drop').length <= 4);
});

test('near-silent spans qualify before section clipping and gaps shorter than 1.5 seconds are ignored', () => {
  const input = sections(['V', 'C', 'O'], [.5, .8, .2]);
  const energyCurves = { rateHz: 50, globalEnergy: t => (t >= 19000 && t < 21200) || (t >= 25000 && t < 26000) ? 0 : 1 };
  const result = sectionRoles({ sections: input, energyCurves, durationMs: 60000 });
  assert.deepEqual(result[0].stops, [{ startMs: 19000, endMs: 20000 }]);
  assert.deepEqual(result[1].stops, [{ startMs: 20000, endMs: 21200 }]);
  assert.deepEqual(result[2].stops, []);
});

test('classification is pure and repeats identically, including empty and silent inputs', () => {
  const input = sections(['A', 'C', 'A', 'C', 'O'], [.2, .8, .5, .8, .1]), before = structuredClone(input);
  const first = sectionRoles({ sections: input });
  assert.deepEqual(sectionRoles({ sections: input }), first);
  assert.deepEqual(input, before);
  assert.deepEqual(sectionRoles({ sections: [] }), []);
  const silent = sectionRoles({ sections: input, energyCurves: { globalEnergy: () => 0 }, durationMs: 100000 });
  assert.deepEqual(silent[0].stops, [{ startMs: 0, endMs: 20000 }]);
  assert.ok(first.every(s => s.confidence >= 0 && s.confidence <= 1));
});

test('repeated long rising builds remain pre-choruses without turning repeated steady verses into builds', () => {
  const input = sections(['I', 'V', 'P', 'C', 'V', 'P', 'C', 'O'], [.2, .5, .6, .8, .5, .6, .8, .2]);
  input[2].energySlope = .1; input[5].energySlope = .1;
  const result = sectionRoles({ sections: input });
  assert.equal(result[1].role, 'verse');
  assert.equal(result[4].role, 'verse');
  assert.equal(result[2].role, 'pre-chorus');
  assert.equal(result[5].role, 'pre-chorus');
});

test('missing low-band evidence does not manufacture a bass-heavy drop', () => {
  const input = sections(['I', 'A', 'D', 'A', 'D', 'O'], [.2, .6, .95, .6, .96, .2]);
  for (const s of input) delete s.lowBandShare;
  for (const i of [1, 3]) input[i].energySlope = .2;
  for (const i of [2, 4]) input[i].transition = 'cut';
  assert.equal(sectionRoles({ sections: input }).filter(s => s.role === 'drop').length, 0);
});
