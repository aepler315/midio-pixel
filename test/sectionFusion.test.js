import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuseSections, epicBiasForKind } from '../src/lyrics/SectionFusion.js';

function makeBarGrid(count, stepMs) {
  return Array.from({ length: count }, (_, i) => ({ tick: i * 1920, ms: i * stepMs, numerator: 4, denominator: 4 }));
}

const novelty = [
  { startMs: 0, endMs: 10000, transition: 'fade', barMs: 2000, label: 0, profile: 'ARCTIC', hueBias: 5 },
  { startMs: 10000, endMs: 20000, transition: 'cut', barMs: 2000, label: 1, profile: 'EMBER', hueBias: -10 },
];

test('fuseSections: absent/empty lyricSections is a true no-op (same array reference)', () => {
  assert.equal(fuseSections(novelty, null, [], 20000), novelty);
  assert.equal(fuseSections(novelty, [], [], 20000), novelty);
  assert.equal(fuseSections(null, [{ startMs: 0, endMs: 1, kind: 'verse', intensity: 0.5, valence: 0, confidence: 1 }], [], 20000), null);
});

test('fuseSections (plain, no timing): boundaries never move; lyric labels order-match onto the existing novelty sections', () => {
  const lyricSections = [
    { kind: 'verse', intensity: 0.3, valence: 0, confidence: 0.4 },
    { kind: 'chorus', intensity: 0.8, valence: 0.6, confidence: 0.4 },
  ];
  const fused = fuseSections(novelty, lyricSections, [], 20000);
  assert.equal(fused.length, 2);
  assert.equal(fused[0].startMs, 0); assert.equal(fused[0].endMs, 10000);
  assert.equal(fused[1].startMs, 10000); assert.equal(fused[1].endMs, 20000);
  assert.equal(fused[0].kind, 'verse');
  assert.equal(fused[1].kind, 'chorus');
  assert.equal(fused[0].profile, 'ARCTIC', 'novelty-derived fields must survive untouched');
});

test('fuseSections (plain): fewer lyric blocks than novelty sections leaves the extras unlabeled, not throwing', () => {
  const fused = fuseSections(novelty, [{ kind: 'verse', intensity: 0.5, valence: 0, confidence: 0.4 }], [], 20000);
  assert.equal(fused[0].kind, 'verse');
  assert.equal(fused[1].kind, null);
});

test('fuseSections (synced): snaps to the bar grid, merges a lyric boundary within one bar of an existing cut, and inserts a distant one', () => {
  const barGrid = makeBarGrid(11, 2000); // bars at 0,2000,...,20000
  const lyricSections = [
    { startMs: 0, endMs: 8000, kind: 'verse', intensity: 0.3, valence: 0, confidence: 0.8 },
    { startMs: 8000, endMs: 15000, kind: 'chorus', intensity: 0.8, valence: 0.5, confidence: 0.9 },
    { startMs: 15000, endMs: 20000, kind: 'bridge', intensity: 0.9, valence: -0.2, confidence: 0.85 },
  ];
  const fused = fuseSections(novelty, lyricSections, barGrid, 20000);

  // The 8000ms lyric boundary is within one bar-width (2000ms) of the
  // existing 10000ms novelty cut and must NOT create a new section.
  // The 15000ms lyric boundary snaps to 14000 (nearest bar) and IS far
  // enough from every existing boundary to insert a new one.
  assert.deepEqual(fused.map((s) => s.startMs), [0, 10000, 14000]);
  assert.equal(fused[0].endMs, 10000);
  assert.equal(fused[1].endMs, 14000);
  assert.equal(fused[2].endMs, 20000);

  assert.equal(fused[0].kind, 'verse');
  assert.equal(fused[1].kind, 'chorus');
  assert.equal(fused[2].kind, 'bridge');
  // Novelty-derived fields (profile/hueBias) must still come from whichever
  // original novelty section the fused segment falls within.
  assert.equal(fused[0].profile, 'ARCTIC');
  assert.equal(fused[1].profile, 'EMBER');
  assert.equal(fused[2].profile, 'EMBER');
});

test('fuseSections (synced): every fused section carries a lyricIntensity/lyricValence/lyricConfidence field', () => {
  const barGrid = makeBarGrid(11, 2000);
  const lyricSections = [{ startMs: 0, endMs: 20000, kind: 'verse', intensity: 0.6, valence: 0.2, confidence: 0.7 }];
  const fused = fuseSections(novelty, lyricSections, barGrid, 20000);
  for (const s of fused) {
    assert.ok(Number.isFinite(s.lyricIntensity));
    assert.ok(Number.isFinite(s.lyricValence));
    assert.ok(Number.isFinite(s.lyricConfidence));
  }
});

test('fuseSections (synced): a low-confidence lyric boundary cannot insert a new authoritative cut', () => {
  const barGrid = makeBarGrid(11, 2000);
  const lyricSections = [
    { startMs: 0, endMs: 15000, kind: 'verse', intensity: 0.3, valence: 0, confidence: 0.9 },
    // Zero confidence: this boundary is a hypothesis, not evidence.
    { startMs: 15000, endMs: 20000, kind: 'bridge', intensity: 0.9, valence: -0.2, confidence: 0 },
  ];
  const fused = fuseSections(novelty, lyricSections, barGrid, 20000);
  assert.deepEqual(
    fused.map((s) => s.startMs), [0, 10000],
    'the zero-confidence lyric boundary at 15000 must not create a new section',
  );
});

test('epicBiasForKind: confidence gates the kind-based bonus so a zero-confidence label never escalates', () => {
  const confidentBridge = epicBiasForKind('bridge', 0.4, 1);
  const unconfidentBridge = epicBiasForKind('bridge', 0.4, 0);
  const verse = epicBiasForKind('verse', 0.4, 1);
  assert.ok(confidentBridge > unconfidentBridge, 'a confidently labeled bridge must escalate more than an unconfident one');
  assert.equal(unconfidentBridge, verse, 'a zero-confidence bridge must read exactly like an unbiased verse -- a quiet/uncertain bridge is representable');
  assert.equal(epicBiasForKind('bridge', 0.4), confidentBridge, 'omitting confidence must keep today\'s existing behavior');
});

test('epicBiasForKind: bridge > chorus > instrumental > verse > intro > outro, always within [-1,1]', () => {
  const order = ['bridge', 'chorus', 'instrumental', 'verse', 'intro', 'outro'];
  const values = order.map((k) => epicBiasForKind(k, 0.4));
  for (let i = 1; i < values.length; i++) assert.ok(values[i - 1] > values[i], `${order[i - 1]} (${values[i - 1]}) must exceed ${order[i]} (${values[i]})`);
  for (const v of values) assert.ok(v >= -1 && v <= 1);
  assert.ok(epicBiasForKind('made up kind', 0.4) >= -1);
});
