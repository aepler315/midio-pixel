import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sectionsToSegmentation, boundaryFMeasure, boundaryDeviation, pairwiseFMeasure, segmentationNCE, evaluateSegmentation,
} from '../src/eval/SegmentationMetrics.js';

test('sectionsToSegmentation: converts a sections array into boundaries+labels', () => {
  const seg = sectionsToSegmentation([
    { startMs: 0, endMs: 10000, kind: 'verse' },
    { startMs: 10000, endMs: 20000, kind: 'chorus' },
  ]);
  assert.deepEqual(seg.boundariesMs, [0, 10000, 20000]);
  assert.deepEqual(seg.labels, ['verse', 'chorus']);
});

test('boundaryFMeasure: identical segmentations score a perfect 1/1/1', () => {
  const reference = { boundariesMs: [0, 10000, 20000, 30000], labels: ['A', 'B', 'A'] };
  const estimate = { boundariesMs: [0, 10000, 20000, 30000], labels: ['A', 'B', 'A'] };
  const r = boundaryFMeasure(reference, estimate, { windowMs: 500 });
  assert.deepEqual(r, {
    precision: 1, recall: 1, fMeasure: 1, matched: 2, refCount: 2, estCount: 2,
  });
});

test('boundaryFMeasure: the guaranteed start/end boundary is never scored, even if it differs', () => {
  const reference = { boundariesMs: [0, 10000, 30000], labels: ['A', 'B'] };
  const estimate = { boundariesMs: [0, 10000, 29500], labels: ['A', 'B'] };
  const r = boundaryFMeasure(reference, estimate, { windowMs: 500 });
  assert.equal(r.fMeasure, 1, 'only the interior boundary at 10000 is compared, and it matches exactly');
});

test('boundaryFMeasure: a boundary shifted 1500ms misses the 0.5s window but hits the 3s window', () => {
  const reference = { boundariesMs: [0, 10000, 20000], labels: ['A', 'B'] };
  const estimate = { boundariesMs: [0, 11500, 20000], labels: ['A', 'B'] };
  const tight = boundaryFMeasure(reference, estimate, { windowMs: 500 });
  const loose = boundaryFMeasure(reference, estimate, { windowMs: 3000 });
  assert.equal(tight.fMeasure, 0);
  assert.equal(loose.fMeasure, 1);
});

test('boundaryFMeasure: a missing boundary lowers recall but not precision', () => {
  const reference = { boundariesMs: [0, 10000, 20000, 30000], labels: ['A', 'B', 'C'] };
  const estimate = { boundariesMs: [0, 10000, 30000], labels: ['A', 'B'] };
  const r = boundaryFMeasure(reference, estimate, { windowMs: 500 });
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 0.5);
  assert.ok(Math.abs(r.fMeasure - (2 / 3)) < 1e-9);
});

test('boundaryFMeasure: an extra spurious boundary lowers precision but not recall', () => {
  const reference = { boundariesMs: [0, 10000, 30000], labels: ['A', 'B'] };
  const estimate = { boundariesMs: [0, 10000, 20000, 30000], labels: ['A', 'B', 'C'] };
  const r = boundaryFMeasure(reference, estimate, { windowMs: 500 });
  assert.equal(r.recall, 1);
  assert.equal(r.precision, 0.5);
});

test('boundaryFMeasure: no interior boundaries on either side is a trivial perfect match', () => {
  const reference = { boundariesMs: [0, 30000], labels: ['A'] };
  const estimate = { boundariesMs: [0, 30000], labels: ['A'] };
  const r = boundaryFMeasure(reference, estimate, { windowMs: 500 });
  assert.deepEqual(r, {
    precision: 1, recall: 1, fMeasure: 1, matched: 0, refCount: 0, estCount: 0,
  });
});

test('boundaryDeviation: reports the median two-way distance between interior boundaries', () => {
  const reference = { boundariesMs: [0, 10000, 20000], labels: ['A', 'B'] };
  const estimate = { boundariesMs: [0, 11500, 20000], labels: ['A', 'B'] };
  const d = boundaryDeviation(reference, estimate);
  assert.equal(d.refToEstMedianMs, 1500);
  assert.equal(d.estToRefMedianMs, 1500);
});

test('pairwiseFMeasure: an estimate that merges two distinct sections into one has recall 1, precision 1/3', () => {
  // reference: A [0,2000), B [2000,4000) -- two distinct 2s clusters.
  // estimate: a single label spanning the whole 4s -- every ref-same pair
  // is still est-same (recall 1), but many est-same pairs (A-with-B) are
  // not really the same section (precision drops).
  const reference = { boundariesMs: [0, 2000, 4000], labels: ['A', 'B'] };
  const estimate = { boundariesMs: [0, 4000], labels: ['A'] };
  const r = pairwiseFMeasure(reference, estimate, 4000, { frameMs: 1000 });
  assert.ok(Math.abs(r.recall - 1) < 1e-9);
  assert.ok(Math.abs(r.precision - 1 / 3) < 1e-9);
  assert.ok(Math.abs(r.fMeasure - 0.5) < 1e-9);
});

test('pairwiseFMeasure: an estimate that splits one section into two has precision 1, recall 1/3', () => {
  const reference = { boundariesMs: [0, 4000], labels: ['A'] };
  const estimate = { boundariesMs: [0, 2000, 4000], labels: ['A', 'B'] };
  const r = pairwiseFMeasure(reference, estimate, 4000, { frameMs: 1000 });
  assert.ok(Math.abs(r.precision - 1) < 1e-9);
  assert.ok(Math.abs(r.recall - 1 / 3) < 1e-9);
  assert.ok(Math.abs(r.fMeasure - 0.5) < 1e-9);
});

test('pairwiseFMeasure: identical family structure (repeats keep the same label) scores 1/1/1', () => {
  const reference = { boundariesMs: [0, 2000, 4000, 6000], labels: ['A', 'B', 'A'] };
  const estimate = { boundariesMs: [0, 2000, 4000, 6000], labels: ['A', 'B', 'A'] };
  const r = pairwiseFMeasure(reference, estimate, 6000, { frameMs: 500 });
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
  assert.equal(r.fMeasure, 1);
});

test('segmentationNCE: merging two sections into one scores under=0 (worst) but over=1 (trivial)', () => {
  const reference = { boundariesMs: [0, 2000, 4000], labels: ['A', 'B'] };
  const estimate = { boundariesMs: [0, 4000], labels: ['A'] };
  const r = segmentationNCE(reference, estimate, 4000, { frameMs: 1000 });
  assert.ok(Math.abs(r.under - 0) < 1e-9);
  assert.equal(r.over, 1);
});

test('segmentationNCE: splitting one section into two scores over=0 (worst) but under=1 (trivial)', () => {
  const reference = { boundariesMs: [0, 4000], labels: ['A'] };
  const estimate = { boundariesMs: [0, 2000, 4000], labels: ['A', 'B'] };
  const r = segmentationNCE(reference, estimate, 4000, { frameMs: 1000 });
  assert.ok(Math.abs(r.over - 0) < 1e-9);
  assert.equal(r.under, 1);
});

test('segmentationNCE: a perfect match scores 1/1', () => {
  const reference = { boundariesMs: [0, 2000, 4000, 6000], labels: ['A', 'B', 'A'] };
  const estimate = { boundariesMs: [0, 2000, 4000, 6000], labels: ['A', 'B', 'A'] };
  const r = segmentationNCE(reference, estimate, 6000, { frameMs: 500 });
  assert.ok(Math.abs(r.over - 1) < 1e-9);
  assert.ok(Math.abs(r.under - 1) < 1e-9);
});

test('evaluateSegmentation: bundles boundary/deviation/pairwise/nce for both standard tolerances', () => {
  const reference = { boundariesMs: [0, 10000, 20000], labels: ['A', 'B'] };
  const estimate = { boundariesMs: [0, 10000, 20000], labels: ['A', 'B'] };
  const r = evaluateSegmentation(reference, estimate, 20000);
  assert.equal(r.boundary['0.5s'].fMeasure, 1);
  assert.equal(r.boundary['3s'].fMeasure, 1);
  assert.equal(r.deviation.refToEstMedianMs, 0);
  assert.equal(r.pairwise.fMeasure, 1);
  assert.equal(r.nce.over, 1);
  assert.equal(r.nce.under, 1);
});
