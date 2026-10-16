// Aggregates SegmentationMetrics.evaluateSegmentation across a corpus of
// tracks -- the "measure on music" step the audit calls for (Phase 4).
// Deliberately decoupled from audio decoding: a `corpus` entry is just
// { id, reference, estimate, durationMs }, where `reference` is a
// human-annotated Segmentation and `estimate` is whatever StructureAnalyzer
// / SectionFusion produced for that track (run `sectionsToSegmentation` on
// their `sections` output first). That keeps this runnable today against
// synthetic fixtures, and later against real annotated tracks without any
// change to the scoring code -- only the corpus changes.
import { evaluateSegmentation } from './SegmentationMetrics.js';

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function summarize(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  return {
    mean: finite.length ? mean(finite) : null,
    median: finite.length ? median(finite) : null,
    n: finite.length,
  };
}

/** Scores every `{ id, reference, estimate, durationMs }` entry in
 *  `corpus` and reports both per-track results and corpus-wide mean/median
 *  for each metric. Reserve some tracks for evaluation and don't tune
 *  against them, per the audit's acceptance criteria for this phase. */
export function runBenchmark(corpus, opts = {}) {
  if (!Array.isArray(corpus) || corpus.length === 0) {
    throw new Error('runBenchmark needs a non-empty corpus of { id, reference, estimate, durationMs } entries');
  }

  const perTrack = corpus.map((track) => ({
    id: track.id,
    metrics: evaluateSegmentation(track.reference, track.estimate, track.durationMs, opts),
  }));

  const pick = (fn) => perTrack.map(fn);

  const aggregate = {
    boundaryF_0_5s: summarize(pick((t) => t.metrics.boundary['0.5s'].fMeasure)),
    boundaryP_0_5s: summarize(pick((t) => t.metrics.boundary['0.5s'].precision)),
    boundaryR_0_5s: summarize(pick((t) => t.metrics.boundary['0.5s'].recall)),
    boundaryF_3s: summarize(pick((t) => t.metrics.boundary['3s'].fMeasure)),
    boundaryP_3s: summarize(pick((t) => t.metrics.boundary['3s'].precision)),
    boundaryR_3s: summarize(pick((t) => t.metrics.boundary['3s'].recall)),
    refToEstMedianMs: summarize(pick((t) => t.metrics.deviation.refToEstMedianMs)),
    estToRefMedianMs: summarize(pick((t) => t.metrics.deviation.estToRefMedianMs)),
    pairwiseF: summarize(pick((t) => t.metrics.pairwise.fMeasure)),
    pairwiseP: summarize(pick((t) => t.metrics.pairwise.precision)),
    pairwiseR: summarize(pick((t) => t.metrics.pairwise.recall)),
    nceOver: summarize(pick((t) => t.metrics.nce.over)),
    nceUnder: summarize(pick((t) => t.metrics.nce.under)),
  };

  return { perTrack, aggregate };
}
