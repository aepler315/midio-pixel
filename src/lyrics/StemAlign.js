// Stem-gated syllable-alignment fallback (experimental): when lyrics exist
// only as plain, untimed text AND the user dropped a stem whose filename
// reads as a true vocal track (Casting.js's LEAD_RE already recognizes the
// same vocabulary for lane assignment), estimate each block's start time by
// matching its cumulative syllable count against vocal-activity onsets
// detected in that stem. This is the user's original "pin each syllable to
// a spike" idea, demoted to a last resort: framed honestly, it's line/
// block-level at best -- melisma, growls, and layered harmonies will make
// real onsets wander from a syllable count. LyricsClient's synced lyrics
// (per-line timestamps straight from LRCLIB) are the real mechanism; this
// only runs when even a plain-text match is all that's available. Pure,
// deterministic, no LLM/DTW library -- just cumulative-count proportional
// mapping, which stays monotone by construction.
import { syllableCount } from './LyricStructure.js';

const VOCAL_NAME_RE = /vox|vocal|voice|sing/i;

/** True when `name` (a dropped stem's filename) reads as an actual vocal
 *  track. A narrower, single-purpose vocabulary than Casting.js's LEAD_RE
 *  (which also matches leads/solos/brass) -- StemAlign only wants to gate
 *  on tracks that are plausibly a human voice. */
export function isVocalStemName(name) {
  return VOCAL_NAME_RE.test(String(name || ''));
}

const ENVELOPE_HZ = 50;

/** ~50Hz RMS envelope of a mono channel: cheap enough to run over a whole
 *  song's vocal stem, dense enough (20ms frames) to place an onset within
 *  about a syllable's width. Returns { values: Float32Array, hopMs }. An
 *  empty/invalid input returns an empty envelope rather than throwing. */
export function vocalActivity(monoData, sampleRate) {
  const hopMs = 1000 / ENVELOPE_HZ;
  if (!monoData || !monoData.length || !sampleRate) return { values: new Float32Array(0), hopMs };
  const hopSamples = Math.max(1, Math.round(sampleRate / ENVELOPE_HZ));
  const frames = Math.ceil(monoData.length / hopSamples);
  const values = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * hopSamples;
    const end = Math.min(monoData.length, start + hopSamples);
    let sum = 0;
    for (let i = start; i < end; i++) sum += monoData[i] * monoData[i];
    values[f] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return { values, hopMs };
}

const REFRACTORY_MS = 120; // a human syllable can't repeat faster than this

/** Peak-picks syllable onsets out of a `vocalActivity` envelope: a local
 *  maximum above an adaptive floor (mean plus a quarter of the peak-to-mean
 *  spread -- quiet, thin evidence shouldn't spray onsets everywhere), at
 *  least REFRACTORY_MS apart. Returns onset times in ms, ascending. Pure;
 *  an empty/flat envelope returns an empty list rather than throwing. */
export function syllableOnsets(env) {
  const values = env?.values, hopMs = env?.hopMs;
  if (!values || values.length === 0) return [];
  let mean = 0, max = 0;
  for (const v of values) { mean += v; if (v > max) max = v; }
  mean /= values.length;
  if (max - mean < 1e-9) return []; // perfectly flat -- no peaks to find, not "a peak everywhere"
  const floor = mean + 0.25 * (max - mean);
  const minGapFrames = Math.max(1, Math.round(REFRACTORY_MS / hopMs));

  const onsets = [];
  let lastOnsetFrame = -Infinity;
  for (let i = 1; i < values.length - 1; i++) {
    if (values[i] < floor) continue;
    if (values[i] < values[i - 1] || values[i] < values[i + 1]) continue; // local max only
    if (i - lastOnsetFrame < minGapFrames) continue;
    onsets.push(i * hopMs);
    lastOnsetFrame = i;
  }
  return onsets;
}

/** Estimates each block's {startMs,endMs} by walking cumulative syllable
 *  counts (LyricStructure.syllableCount over each block's lines) against
 *  the onset list in the same order: block i's start is whichever onset
 *  sits at its running syllable fraction of the total. Monotone by
 *  construction (the fraction only grows), so blocks never overlap or
 *  reorder even when the syllable/onset counts don't match up perfectly.
 *  Returns the input blocks with `startMs`/`endMs`/`confidence` set (always
 *  0.3 -- this fallback is never more confident than that) so the result
 *  can be handed straight to LyricStructure.labelBlocks or SectionFusion.
 *  No onsets at all -- e.g. a silent/instrumental "vocal" stem -- leaves
 *  every block's timing null rather than guessing. */
export function alignBlocks(blocks, onsets) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  if (!Array.isArray(onsets) || onsets.length === 0) {
    return blocks.map((b) => ({ ...b, startMs: null, endMs: null, confidence: 0 }));
  }

  const counts = blocks.map((b) => Math.max(1, (b.lines || []).reduce((sum, l) => sum + syllableCount(l), 0)));
  const total = counts.reduce((a, c) => a + c, 0);

  let cumulative = 0;
  const starts = blocks.map((_, i) => {
    const idx = Math.min(onsets.length - 1, Math.floor((cumulative / total) * onsets.length));
    cumulative += counts[i];
    return onsets[idx];
  });
  const lastOnset = onsets[onsets.length - 1];

  return blocks.map((b, i) => ({
    ...b,
    startMs: starts[i],
    endMs: i + 1 < blocks.length ? Math.max(starts[i + 1], starts[i] + 1) : lastOnset + REFRACTORY_MS,
    confidence: 0.3,
  }));
}
