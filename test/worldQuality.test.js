import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { listWorlds } from '../src/world/Worlds.js';
import { pickPreviewPassages } from '../src/ui/WorldPreview.js';
import {
  REQUIRED_FAMILIES, ACCEPTANCE_TARGET, EVAL_QUALITY, viewingOrder, evaluationSeed,
  pickEvaluationPassages, privateScores, seventyEightyCases, diagnosticsFromFeatures,
  evaluateTrack, evaluateCorpus, validateCorpus, applyReviews, summarizeAcceptance,
  autoExclusions,
} from '../src/eval/WorldQuality.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(await readFile(join(root, 'test/fixtures/world-evaluation.json'), 'utf8'));

test('the fixture is a 12–20 track corpus covering every required family in both splits', () => {
  const { ok, errors, n } = validateCorpus(corpus);
  assert.equal(ok, true, errors.join('; '));
  assert.ok(n >= 12 && n <= 20);
  const families = REQUIRED_FAMILIES.slice();
  for (const split of ['tune', 'holdout']) {
    const got = new Set(corpus.tracks.filter((t) => t.split === split).map((t) => t.family));
    for (const fam of families) assert.ok(got.has(fam), `${split} missing ${fam}`);
  }
  assert.ok(corpus.tracks.some((t) => t.split === 'tune' && t.representation === 'midi'));
  assert.ok(corpus.tracks.some((t) => t.split === 'tune' && t.representation === 'audio'));
  assert.ok(corpus.tracks.some((t) => t.split === 'holdout' && t.representation === 'midi'));
  assert.ok(corpus.tracks.some((t) => t.split === 'holdout' && t.representation === 'audio'));
});

test('tune and holdout ids are disjoint, and no track stores audio bytes', () => {
  const tune = new Set(corpus.tracks.filter((t) => t.split === 'tune').map((t) => t.id));
  const hold = new Set(corpus.tracks.filter((t) => t.split === 'holdout').map((t) => t.id));
  for (const id of tune) assert.ok(!hold.has(id), `id ${id} is in both splits`);
  for (const t of corpus.tracks) {
    assert.ok(t.source && t.source.kind, `${t.id} missing source`);
    assert.equal(t.source.bytes, undefined);
    assert.equal(t.audio, undefined);
  }
});

test('viewing order is the authored world list, with all surviving worlds, never a score ranking', () => {
  const order = viewingOrder();
  assert.deepEqual(order, listWorlds().map((w) => w.id));
  assert.deepEqual(order, ['alpine', 'trio']);
  const dense = corpus.tracks.find((t) => t.id === 'tune-wall-guitars');
  const sheet = evaluateTrack(dense);
  assert.deepEqual(sheet.viewingOrder, order);
  // Both authored orders are kept as given while the heuristic ranks once,
  // so at least one of them differs from the ranking: order is not a score.
  const ranked = sheet.heuristic.byWorld.map((w) => w.id);
  for (const worlds of [listWorlds(), [...listWorlds()].reverse()]) {
    const authored = worlds.map((w) => w.id);
    const reordered = evaluateTrack(dense, { worlds });
    assert.deepEqual(reordered.viewingOrder, authored);
    assert.deepEqual(reordered.reviews.map((r) => r.worldId), authored);
    assert.deepEqual(reordered.heuristic.byWorld.map((w) => w.id), ranked, 'the ranking ignores the viewing order');
  }
  assert.deepEqual([...ranked].sort(), [...order].sort(), 'only surviving worlds are scored');
});

test('private scores are heuristics; 70–80 cases sit beside the winner without changing order', () => {
  const warm = corpus.tracks.find((t) => t.id === 'tune-bass-helix7');
  const heuristic = privateScores(warm.features);
  assert.equal(heuristic.note.includes('not visual quality'), true);
  const band = seventyEightyCases(heuristic);
  const sheet = evaluateTrack(warm);
  assert.deepEqual(sheet.viewingOrder, viewingOrder());
  if (band.length) {
    assert.ok(band.every((c) => c.score >= 70 && c.score <= 80));
  }
  for (const row of heuristic.byWorld) {
    assert.ok(row.score >= 1 && row.score <= 99);
    assert.equal(typeof row.fit, 'number');
    assert.equal(typeof row.tied, 'boolean');
    assert.equal(typeof row.eligible, 'boolean');
    assert.ok(row.parts.styleAffinity != null);
    assert.ok(Array.isArray(row.parts.problems));
  }
  assert.ok(heuristic.pickReason === 'unique' || heuristic.pickReason === 'near-tie');
});

test('every world is offered the same quiet, transition and peak clock', () => {
  const track = corpus.tracks.find((t) => t.id === 'tune-wall-guitars');
  const sheet = evaluateTrack(track);
  const { quietMs, peakMs, transitionMs, spanMs } = sheet.passages;
  assert.ok(quietMs !== peakMs);
  assert.ok(Number.isFinite(transitionMs));
  assert.equal(sheet.capture.worlds.length, listWorlds().length);
  for (const world of sheet.capture.worlds) {
    assert.deepEqual(world.stills.map((s) => s.tMs), [quietMs, transitionMs, peakMs]);
    assert.equal(world.stills[0].passage, 'quiet');
    assert.equal(world.stills[2].passage, 'peak');
    assert.equal(world.seed ?? sheet.seed, sheet.seed);
  }
  assert.equal(sheet.capture.quality, EVAL_QUALITY);
  assert.equal(spanMs, 8000);
});

test('annotated passages win; derived quiet/peak agree with the chooser picker', () => {
  const annotated = corpus.tracks.find((t) => t.id === 'hold-piano-audio');
  const got = pickEvaluationPassages(annotated);
  assert.equal(got.source, 'annotated');
  assert.equal(got.quietMs, annotated.passages.quietMs);
  assert.equal(got.peakMs, annotated.passages.peakMs);
  assert.equal(got.transitionMs, annotated.passages.transitionMs);

  const durationMs = 120000;
  const ec = new EnergyCurves(durationMs, 50);
  for (let i = 0; i < ec.n; i++) {
    const t01 = i / (ec.n - 1);
    const e = 0.1 + 0.8 * Math.exp(-(((t01 - 0.7) / 0.08) ** 2) * 4);
    ec.setFrame(i, [e, e, e, e, e, e, e]);
  }
  const derived = pickEvaluationPassages({ durationMs, energyCurves: ec });
  const chooser = pickPreviewPassages({ energyCurves: ec, durationMs });
  assert.equal(derived.quietMs, chooser.quietMs);
  assert.equal(derived.peakMs, chooser.peakMs);
  assert.equal(derived.source, 'derived');
  assert.ok(derived.transitionMs !== derived.quietMs);
});

test('a backward seek of the same track reproduces the seed and the passages', () => {
  const track = corpus.tracks.find((t) => t.id === 'tune-piano-midi');
  const a = evaluateTrack(track);
  const b = evaluateTrack(track);
  assert.equal(a.seed, b.seed);
  assert.equal(a.seed, evaluationSeed(track));
  assert.deepEqual(a.passages, b.passages);
  assert.deepEqual(a.heuristic.byWorld.map((w) => w.score), b.heuristic.byWorld.map((w) => w.score));
});

test('diagnostics exist and are not ratings', () => {
  const track = corpus.tracks.find((t) => t.id === 'tune-drums-midi');
  const sheet = evaluateTrack(track);
  assert.ok(sheet.diagnostics.eventDensity > 0.5);
  assert.ok(sheet.diagnostics.saturation >= sheet.diagnostics.eventDensity);
  assert.equal(sheet.diagnostics.frameMs, null);
  assert.match(sheet.diagnostics.note, /not an automatic beauty score/);
  const diag = diagnosticsFromFeatures(track.features, sheet.passages);
  assert.equal(diag.transitionMs, sheet.passages.transitionMs);
  for (const review of sheet.reviews) {
    for (const axis of ['appeal', 'musicalTiming', 'identity', 'quietInterest', 'climaxHeadroom', 'clutter']) {
      assert.equal(review[axis], null);
    }
  }
});

test('empty ratings do not claim the acceptance target; filled holdout ratings can meet it', () => {
  const report = evaluateCorpus(corpus, { split: 'holdout' });
  assert.equal(report.summary.claimed, false);
  assert.equal(report.summary.met, null);
  assert.equal(report.summary.reviewed, 0);
  assert.equal(report.summary.calibration, 'empty-holdout');
  assert.deepEqual(report.summary.exclusions, []);
  assert.equal(report.acceptance.holdoutShare, 0.8);
  assert.match(ACCEPTANCE_TARGET.note, /Calmness is a legitimate outcome/);

  const filled = report.sheets.map((sheet) => applyReviews(sheet, {
    [sheet.heuristic.recommendedId]: {
      appeal: 5, musicalTiming: 4, identity: 4, quietInterest: 4, climaxHeadroom: 4, clutter: 5, blockingDefect: false,
    },
  }));
  const ok = summarizeAcceptance(filled, { split: 'holdout' });
  assert.equal(ok.reviewed, filled.length);
  assert.equal(ok.met, true);
  assert.equal(ok.claimed, false);
  assert.equal(ok.calibration, 'holdout-reviews');
  assert.deepEqual(ok.exclusions, []);

  const blocked = report.sheets.map((sheet, i) => applyReviews(sheet, {
    [sheet.heuristic.recommendedId]: {
      appeal: i < 3 ? 2 : 5,
      musicalTiming: i < 3 ? 2 : 5,
      identity: 4, quietInterest: 4, climaxHeadroom: 4, clutter: 4,
      blockingDefect: i < 2,
    },
  }));
  const fail = summarizeAcceptance(blocked, { split: 'holdout' });
  assert.equal(fail.claimed, false);
  assert.equal(fail.met, false);
  assert.ok(fail.passing < fail.reviewed);
  assert.equal(fail.calibration, 'holdout-reviews');
  assert.equal(fail.exclusions.length, 2);
  assert.ok(fail.exclusions.every((e) => e.reason === 'blocking-defect'));
  const fromHelper = autoExclusions(blocked);
  assert.equal(fromHelper.length, 2);
});

test('evaluateCorpus --split tune never peeks at holdout tracks', () => {
  const report = evaluateCorpus(corpus, { split: 'tune' });
  assert.ok(report.sheets.length);
  assert.ok(report.sheets.every((s) => s.track.split === 'tune'));
  assert.equal(report.summary.split, 'tune');
});

// --- E1: acceptance needs valid holdout evidence -----------------------------
const good = { appeal: 5, musicalTiming: 4, identity: 4, quietInterest: 4, climaxHeadroom: 4, clutter: 5, blockingDefect: false };
const reviewAll = (sheets, pick) => sheets.map((s, i) => {
  const r = pick(s, i);
  return r ? applyReviews(s, { [s.heuristic.recommendedId]: r }) : s;
});

test('eight passing tune reviews never certify holdout acceptance', () => {
  const all = evaluateCorpus(corpus, { split: 'all' }).sheets;
  const tuneReviewed = reviewAll(all, (s) => (s.track.split === 'tune' ? good : null));
  assert.equal(tuneReviewed.filter((s) => s.track.split === 'tune').length, 8);
  const overall = summarizeAcceptance(tuneReviewed, { split: 'all' });
  assert.deepEqual([overall.met, overall.calibration, overall.reviewed], [null, 'empty-holdout', 0]);
  const tune = summarizeAcceptance(tuneReviewed, { split: 'tune' });
  assert.equal(tune.met, null, 'tune reviews are diagnostics only');
  assert.equal(tune.calibration, 'tune-reviews');
  assert.equal(tune.reviewed, 8);
  assert.equal(summarizeAcceptance(all, { split: 'tune' }).calibration, 'empty-tune');
});

test('one blocked holdout case fails acceptance, even beside seven passing or when incomplete', () => {
  const holdout = evaluateCorpus(corpus, { split: 'holdout' }).sheets;
  assert.equal(holdout.length, 8);
  const sevenAndBlocked = summarizeAcceptance(reviewAll(holdout, (_s, i) => (i === 0 ? { ...good, blockingDefect: true } : good)), { split: 'holdout' });
  assert.equal(sevenAndBlocked.met, false);
  assert.equal(sevenAndBlocked.blocking.length, 1);
  assert.equal(sevenAndBlocked.claimed, false);
  const incompleteBlocked = summarizeAcceptance(reviewAll(holdout, (_s, i) => (i === 0 ? { blockingDefect: true, notes: 'blank frame' } : good)), { split: 'holdout' });
  assert.equal(incompleteBlocked.met, false, 'a known blocker vetoes even an incomplete review');
  assert.deepEqual(incompleteBlocked.blocking[0].complete, false);
});

test('empty reviews are unknown; out-of-range, fractional and non-finite ratings are invalid', () => {
  const holdout = evaluateCorpus(corpus, { split: 'holdout' }).sheets;
  const empty = summarizeAcceptance(holdout, { split: 'holdout' });
  assert.deepEqual([empty.met, empty.calibration, empty.coverage], [null, 'empty-holdout', { reviewed: 0, total: 8, complete: false }]);
  for (const bad of [0, 6, 99, NaN, Infinity, 4.5, '5']) {
    const s = summarizeAcceptance(reviewAll(holdout, () => ({ ...good, appeal: bad })), { split: 'holdout' });
    assert.equal(s.met, null, `appeal ${String(bad)} never passes`);
    assert.equal(s.reviewed, 0);
    assert.equal(s.invalid.length, 8);
    assert.equal(s.calibration, 'empty-holdout');
  }
  // One malformed review among passing ones keeps the result unknown.
  const mixed = summarizeAcceptance(reviewAll(holdout, (_s, i) => (i === 0 ? { ...good, clutter: 99 } : good)), { split: 'holdout' });
  assert.deepEqual([mixed.met, mixed.reviewed, mixed.invalid.length], [null, 7, 1]);
});

test('partial holdout coverage is explicit; >=80% of reviewed cases meets only that target', () => {
  const holdout = evaluateCorpus(corpus, { split: 'holdout' }).sheets;
  const low = { ...good, appeal: 3 };
  // Five reviewed (four passing, one low), three unreviewed.
  const partial = summarizeAcceptance(reviewAll(holdout, (_s, i) => (i < 4 ? good : i === 4 ? low : null)), { split: 'holdout' });
  assert.deepEqual(partial.coverage, { reviewed: 5, total: 8, complete: false });
  assert.equal(partial.share, 0.8);
  assert.equal(partial.met, true, 'meets the reviewed-case target');
  assert.equal(partial.claimed, false);
  const short = summarizeAcceptance(reviewAll(holdout, (_s, i) => (i < 3 ? good : i < 5 ? low : null)), { split: 'holdout' });
  assert.equal(short.met, false);
  // Null axes are an incomplete (not invalid) review: not counted.
  const incomplete = summarizeAcceptance(reviewAll(holdout, () => ({ ...good, identity: null })), { split: 'holdout' });
  assert.deepEqual([incomplete.met, incomplete.reviewed, incomplete.invalid.length], [null, 0, 0]);
});
