import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark } from '../src/eval/BenchmarkRunner.js';

test('runBenchmark: throws on an empty corpus instead of reporting a fake score', () => {
  assert.throws(() => runBenchmark([]), /non-empty corpus/);
  assert.throws(() => runBenchmark(null), /non-empty corpus/);
});

test('runBenchmark: reports per-track results and corpus-wide mean/median', () => {
  const perfect = {
    reference: { boundariesMs: [0, 10000, 20000], labels: ['A', 'B'] },
    estimate: { boundariesMs: [0, 10000, 20000], labels: ['A', 'B'] },
    durationMs: 20000,
  };
  const missedBoundary = {
    reference: { boundariesMs: [0, 10000, 20000, 30000], labels: ['A', 'B', 'C'] },
    estimate: { boundariesMs: [0, 10000, 30000], labels: ['A', 'B'] },
    durationMs: 30000,
  };
  const corpus = [
    { id: 'perfect', ...perfect },
    { id: 'missedBoundary', ...missedBoundary },
  ];

  const { perTrack, aggregate } = runBenchmark(corpus);

  assert.equal(perTrack.length, 2);
  assert.equal(perTrack[0].id, 'perfect');
  assert.equal(perTrack[0].metrics.boundary['0.5s'].fMeasure, 1);
  assert.equal(perTrack[1].id, 'missedBoundary');
  assert.equal(perTrack[1].metrics.boundary['0.5s'].recall, 0.5);

  // mean/median of [1, 2/3] for boundary F @0.5s across the two tracks.
  const expectedMean = (1 + 2 / 3) / 2;
  assert.ok(Math.abs(aggregate.boundaryF_0_5s.mean - expectedMean) < 1e-9);
  assert.equal(aggregate.boundaryF_0_5s.n, 2);
  assert.equal(aggregate.boundaryR_0_5s.median, (1 + 0.5) / 2);
});

test('runBenchmark: a null-deviation track (no interior boundaries on one side) is excluded from that aggregate, not treated as 0', () => {
  const noBoundaries = {
    reference: { boundariesMs: [0, 20000], labels: ['A'] },
    estimate: { boundariesMs: [0, 20000], labels: ['A'] },
    durationMs: 20000,
  };
  const withBoundary = {
    reference: { boundariesMs: [0, 10000, 20000], labels: ['A', 'B'] },
    estimate: { boundariesMs: [0, 11000, 20000], labels: ['A', 'B'] },
    durationMs: 20000,
  };
  const { aggregate } = runBenchmark([
    { id: 'noBoundaries', ...noBoundaries },
    { id: 'withBoundary', ...withBoundary },
  ]);
  assert.equal(aggregate.refToEstMedianMs.n, 1, 'the track with no interior boundaries contributes no deviation sample');
  assert.equal(aggregate.refToEstMedianMs.mean, 1000);
});
