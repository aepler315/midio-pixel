import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectReviews, reviewResultErrors, journalState } from '../tools/lib/scenic-review.mjs';

const expected = new Map([['a', ['a1', 'a2']], ['b', ['b1']]]);
const shot = (id, verdict = 'good') => ({ row: 1, id, verdict, issue: '' });
const review = (region, shots, verdict = 'acceptable') => ({ region, verdict, railParity: 'same', shots, notes: '' });

test('a complete review counts only recognised verdicts of the expected shots', () => {
  const r = collectReviews([review('a', [shot('a1'), shot('a2', 'weak')]), review('b', [shot('b1', 'acceptable')])], expected);
  assert.equal(r.complete, true);
  assert.deepEqual(r.regions.a.counts, { good: 1, acceptable: 0, weak: 1, broken: 0 });
  assert.equal(r.regions.a.passing, 1);
  assert.equal(r.regions.b.passing, 1);
});

test('a missing region, a failed agent or a malformed result leaves the review incomplete', () => {
  const missing = collectReviews([review('a', [shot('a1'), shot('a2')])], expected);
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.problems.missingRegions, ['b']);
  const failed = collectReviews([review('a', [shot('a1'), shot('a2')]), null], expected);
  assert.equal(failed.problems.failed, 1);
  assert.equal(failed.complete, false);
  const malformed = collectReviews([review('a', [shot('a1'), shot('a2')]), { region: 'b', verdict: 'acceptable' }], expected);
  assert.equal(malformed.complete, false);
  assert.deepEqual(malformed.problems.malformed[0].errors, ['shots']);
});

test('an unknown or misspelled verdict is a problem, never a success', () => {
  assert.deepEqual(reviewResultErrors(review('a', [shot('a1', 'Good'), { row: 2, id: 'a2', issue: '' }])), ['shot a1: verdict "Good"', 'shot a2: verdict undefined']);
  const r = collectReviews([review('a', [shot('a1', 'fine'), shot('a2')]), review('b', [shot('b1')])], expected);
  assert.equal(r.complete, false);
  assert.equal(r.regions.a, undefined, 'a malformed region result is not counted at all');
  assert.equal(r.problems.malformed[0].region, 'a');
});

test('a review of another library (stale shot IDs) is reported, and only matching shots count', () => {
  const r = collectReviews([review('a', [shot('a1'), shot('old', 'good')]), review('b', [shot('b1')])], expected);
  assert.equal(r.complete, false);
  assert.deepEqual(r.problems.missingShots.a, ['a2']);
  assert.deepEqual(r.problems.unknownShots.a, ['old']);
  assert.equal(r.regions.a.current, false);
  assert.equal(r.regions.a.passing, 1, 'the stale shot is not counted');
});

test('duplicate results: identical ones are noted, conflicting ones void the region', () => {
  const same = collectReviews([review('a', [shot('a1'), shot('a2')]), review('a', [shot('a1'), shot('a2')]), review('b', [shot('b1')])], expected);
  assert.deepEqual(same.problems.duplicates, ['a']);
  assert.equal(same.complete, true);
  const clash = collectReviews([review('a', [shot('a1'), shot('a2')]), review('a', [shot('a1', 'broken'), shot('a2')]), review('b', [shot('b1')])], expected);
  assert.deepEqual(clash.problems.conflicts, ['a']);
  assert.equal(clash.regions.a, undefined);
  assert.equal(clash.complete, false);
  const twice = collectReviews([review('a', [shot('a1'), shot('a1', 'broken'), shot('a2')]), review('b', [shot('b1')])], expected);
  assert.deepEqual(twice.problems.duplicateShots.a, ['a1']);
  assert.equal(twice.regions.a.counts.good + twice.regions.a.counts.broken, 2, 'a shot reviewed twice counts once');
});

test('the journal shows which expected agents started, finished or are still running', () => {
  const lines = [{ type: 'launched' }, { type: 'started', agentId: 'x', label: 'review:a' }, { type: 'started', agentId: 'y', label: 'review:b' },
    { type: 'result', agentId: 'x', result: { region: 'a' } }, { type: 'result', agentId: 'z', label: 'review:c', result: null }].map((e) => JSON.stringify(e)).join('\n') + '\nnot json';
  const j = journalState(lines, ['review:a', 'review:b']);
  assert.deepEqual(j.finished, ['review:a']);
  assert.deepEqual(j.running, ['review:b']);
  assert.deepEqual(j.missing, ['review:b']);
  assert.deepEqual(j.unexpected, ['review:c']);
  assert.equal(j.other[0].type, 'unparsable');
});

test('a label that reported twice in the journal keeps both answers: different ones are a conflict', () => {
  const event = (o) => JSON.stringify(o);
  const a = review('a', [shot('a1'), shot('a2')]), b = review('b', [shot('b1')]), b2 = review('b', [shot('b1', 'broken')]);
  const lines = [event({ type: 'started', agentId: 1, label: 'review:a' }), event({ type: 'started', agentId: 2, label: 'review:b' }),
    event({ type: 'result', agentId: 1, result: a }), event({ type: 'result', agentId: 2, result: b }), event({ type: 'result', agentId: 2, result: b2 })].join('\n');
  const j = journalState(lines, ['review:a', 'review:b']);
  assert.deepEqual(j.duplicates, ['review:b']);
  assert.deepEqual(j.results.get('review:b'), [b, b2]);
  const r = collectReviews(['review:a', 'review:b'].flatMap((l) => j.results.get(l)), expected);
  assert.equal(r.complete, false);
  assert.deepEqual(r.problems.conflicts, ['b']);
  // The same answer twice is reported, not a conflict.
  const same = journalState(lines.replace(JSON.stringify(b2), JSON.stringify(b)), ['review:a', 'review:b']);
  const r2 = collectReviews(['review:a', 'review:b'].flatMap((l) => same.results.get(l)), expected);
  assert.deepEqual(r2.problems.duplicates, ['b']);
  assert.equal(r2.complete, true);
});
