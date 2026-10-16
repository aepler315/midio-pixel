// Watchability match: how well a song would play in a world's visual suite.
//
// Not "is this a city song." The question is: if we drive this world's
// channels with this song, does the show sit in a sweet spot — enough
// going on to watch, not so much that every window strobes and every
// peak clips. A drone leaves The Range sitting still (boring). A wall
// of sound in After Hours lights every window at once (too intense).
import { clamp01, clamp } from '../utils/math.js';
import { listWorlds, getWorld } from './Worlds.js';
import { buildSongProfile } from '../audio/SongProfile.js';
import { adaptWorld, responseConfigFor } from './WorldAdaptation.js';

/** Shared extraction lives in SongProfile. Kept here so existing callers
 *  and tests do not have to move; scoring still consumes `watch`. */
export function extractWatchFeatures(data = {}) {
  return buildSongProfile(data).watch;
}

function inRangeScore(value, range) {
  if (!range || range.length < 2) return 0.5;
  const [lo, hi] = range;
  if (value >= lo && value <= hi) {
    const mid = (lo + hi) / 2;
    const half = Math.max(0.04, (hi - lo) / 2);
    return 0.72 + 0.28 * (1 - Math.abs(value - mid) / half);
  }
  const dist = value < lo ? lo - value : value - hi;
  return clamp01(1 - dist / 0.45) * 0.7;
}

function comfortScore(drive, comfort) {
  const lo = comfort?.lo ?? 0.3;
  const hi = comfort?.hi ?? 0.8;
  const mid = (lo + hi) / 2;
  const half = Math.max(0.08, (hi - lo) / 2);
  if (drive >= lo && drive <= hi) {
    return 0.78 + 0.22 * (1 - Math.abs(drive - mid) / half);
  }
  // Comfort bands overlap heavily in the middle of drive-space (see
  // Worlds.js — up to five worlds' bands cover 0.30..0.52), so this
  // out-of-range falloff is the only thing that can actually separate a
  // well-matched world from a mismatched one for a typical song. The old
  // coefficient (1.35) plus a 0.08 floor meant even a badly-mismatched
  // world (dist ~0.3-0.4, common for real songs since drive rarely leaves
  // 0.15..0.85) never scored below ~0.3-0.4 — nearly as high as a
  // well-matched world's in-range floor of 0.78, which is what let
  // farside/fathom lose pickups they should have won. Steeper falloff, no
  // floor add-on: being outside a world's comfort band now costs real score.
  // Quadratic, not linear: a near-miss (drive just past the edge of the
  // band) barely costs anything -- other components can still carry a
  // genuinely close song -- but a real mismatch (a song whose drive sits
  // far from a world's band) is crushed hard, instead of settling into the
  // old formula's mid-0.3s floor that left every world looking plausible.
  const dist = drive < lo ? lo - drive : drive - hi;
  return clamp01(0.78 - dist * dist * 8) * 0.9;
}

const INVERTED = { centroidInv: 'centroid', onsetInv: 'onset', warmthInv: 'warmth', contrastInv: 'contrast' };

function affinityScore(features, world) {
  const w = world.affinity;
  if (!w) return 0.5;
  let acc = 0, sum = 0;
  for (const [key, weight] of Object.entries(w)) {
    const src = INVERTED[key];
    const v = clamp01(src ? 1 - (features[src] ?? 0.5) : (features[key] ?? 0.4));
    acc += v * weight;
    sum += weight;
  }
  return sum > 0 ? clamp01(acc / sum) : 0.5;
}

function coverageScore(features, channels) {
  if (!channels?.length) return 0.5;
  let wsum = 0, acc = 0;
  for (const ch of channels) {
    const v = clamp01(features[ch.reads] ?? 0.4);
    const w = ch.weight || 1;
    acc += v * w;
    wsum += w;
  }
  return wsum > 0 ? acc / wsum : 0.5;
}

function shapeFit(features, prefer) {
  if (!prefer) return 0.5;
  const keys = Object.keys(prefer);
  if (!keys.length) return 0.5;
  let s = 0;
  for (const k of keys) s += inRangeScore(features[k] ?? 0.4, prefer[k]);
  return s / keys.length;
}

/** Continuous fit gap treated as a tie, not a unique winner. */
export const TIE_EPS = 0.012;

function resolveScoreInputs(features, profile) {
  const prof = profile?.watch ? profile
    : (features?.watch && features?.version ? features : null);
  const feat = (features && typeof features.drive === 'number' && !features.watch)
    ? features
    : (prof?.watch || extractWatchFeatures(features || {}));
  return { feat, profile: prof };
}

/**
 * Drive used for comfort after the world's response config has had a
 * chance to absorb density. A dense mix that already filters accents
 * should not be rejected solely for raw onset. Sparse/quiet input is
 * never lifted — silence stays still.
 */
export function driveAfterResponse(feat, world, response) {
  const drive = clamp01(feat?.drive ?? 0);
  if (!response || !world?.comfort) return drive;
  if (response.quiet) return drive;
  if (response.band !== 'dense') return drive;
  const hi = world.comfort.hi ?? 0.8;
  if (!(drive > hi)) return drive;
  const overshoot = drive - hi;
  const absorb = clamp01(1 - (response.accentGain ?? 1)) * 0.5;
  return clamp01(hi + overshoot * (1 - absorb));
}

export function predictedProblems(feat, world, response, confidence) {
  const problems = [];
  if (Number.isFinite(confidence) && confidence < 0.28) {
    problems.push({
      code: 'low-confidence',
      severity: 'info',
      detail: 'tempo/key/structure is a fallback, not a measurement',
    });
  }
  const onset = clamp01(feat?.onset ?? 0);
  if (onset > 0.72 && (response?.accentGain ?? 1) > 0.85 && (response?.maxAccents ?? 4) >= 5) {
    problems.push({
      code: 'strobe-risk',
      severity: 'warn',
      detail: 'dense hits with little accent filtering',
    });
  }
  if (response?.quiet && (world?.comfort?.lo ?? 0) > 0.55) {
    problems.push({
      code: 'stillness',
      severity: 'warn',
      detail: 'quiet input in a world that wants high drive; ambient is not lifted',
    });
  }
  if (world?.manualOnly) {
    problems.push({
      code: 'manual-only',
      severity: 'block',
      detail: 'kept out of Choose-for-me',
    });
  }
  return problems;
}

export function formatFitDiagnostic(ranked = [], { confidence = null } = {}) {
  const pick = ranked.find((r) => r.recommended) || ranked[0];
  if (!pick) return ['=== WORLD FIT (heuristic, not quality) ===', '(no ranking)'];
  const tied = ranked.filter((r) => r.tied).map((r) => r.id);
  const lines = [
    '=== WORLD FIT (heuristic, not quality) ===',
    `pick: ${pick.id}  fit=${pick.fit.toFixed(3)}  ${pick.pickReason || 'unique'}`,
  ];
  if (tied.length > 1) lines.push(`tied with: ${tied.join(', ')}`);
  if (Number.isFinite(confidence)) lines.push(`analysis confidence: ${confidence.toFixed(2)} (not a probability)`);
  lines.push(`style affinity: ${(pick.parts?.styleAffinity ?? pick.parts?.affinity ?? 0).toFixed(2)}`);
  const problems = pick.parts?.problems || [];
  lines.push(problems.length
    ? `problems: ${problems.map((p) => p.code).join(', ')}`
    : 'problems: none');
  return lines;
}

/**
 * Score every registered world against this song. Returns a ranked list
 * of `{ id, name, tagline, kind, fit, score, parts, recommended, tied }`.
 *
 * `fit` is the continuous heuristic (0..1). `score` is the same value
 * mapped to 1–99 for the private review sheet — ranking uses `fit`,
 * never the rounded integer. Near ties stay tied; Choose-for-me still
 * needs one pick and records that as a tie-break, not certainty.
 *
 * Worlds flagged `manualOnly` are excluded from the default set. They are
 * chosen by hand or not at all. An explicit `worlds` argument is still
 * honored verbatim.
 *
 * Fit is evaluated after the world's response config, so a dense mix
 * already damped by accentGain is not rejected for raw intensity.
 */
export function scoreWorlds(features, worlds = listWorlds().filter((w) => !w.manualOnly), options = {}) {
  const { feat, profile } = resolveScoreInputs(features, options.profile);
  const confidence = Number.isFinite(profile?.confidence?.overall)
    ? profile.confidence.overall
    : (Number.isFinite(options.confidence) ? options.confidence : null);
  const exclude = options.exclude instanceof Set ? options.exclude : new Set(options.exclude || []);

  const ranked = worlds.map((w) => {
    const response = responseConfigFor(w.kind, profile || { watch: feat });
    const drive = driveAfterResponse(feat, w, response);
    const comfort = comfortScore(drive, w.comfort);
    const coverage = coverageScore(feat, w.channels);
    const shape = shapeFit(feat, w.prefer);
    const affinity = affinityScore(feat, w);
    const mixed = 0.38 * comfort + 0.24 * coverage + 0.16 * shape + 0.22 * affinity;
    const problems = predictedProblems(feat, w, response, confidence);
    const blocked = problems.some((p) => p.severity === 'block') || exclude.has(w.id);
    return {
      id: w.id,
      name: w.name,
      tagline: w.tagline,
      kind: w.kind,
      fit: mixed,
      score: clamp(Math.round(40 + 58 * mixed), 1, 99),
      eligible: !blocked,
      parts: {
        comfort,
        coverage,
        shape,
        affinity,
        drive: feat.drive,
        driveUsed: drive,
        styleAffinity: affinity,
        analysisConfidence: confidence,
        problems,
        responseBand: response.band,
      },
    };
  });
  ranked.sort((a, b) => (b.eligible - a.eligible) || (b.fit - a.fit) || a.name.localeCompare(b.name));
  const eligible = ranked.filter((r) => r.eligible);
  const bestFit = eligible[0]?.fit;
  if (Number.isFinite(bestFit)) {
    for (const r of eligible) {
      r.tied = Math.abs(r.fit - bestFit) <= TIE_EPS;
    }
    const tied = eligible.filter((r) => r.tied);
    eligible[0].recommended = true;
    eligible[0].pickReason = tied.length > 1 ? 'near-tie' : 'unique';
  }
  return ranked;
}

// ── World adaptation ───────────────────────────────────────────────
//
// Construction lives in WorldAdaptation.adaptWorld. Scoring stays here
// and is a heuristic, not a constructed 100. An adapted world keeps the
// base world's channels, affinity, prefer and comfort, so Choose-for-me
// can still compare apples to apples after adaptation.

const SCORABLE_KEYS = [
  'arc', 'form', 'contrast', 'texture', 'air', 'onset',
  'groove', 'warmth', 'spread', 'phrase', 'tempoHeat',
  'energyMean', 'dyn', 'bass', 'centroid',
];

const INVERTIBLE = new Set(['centroid', 'onset', 'warmth', 'contrast']);

function buildOptimalChannels(features) {
  const sorted = SCORABLE_KEYS
    .map((k) => ({ k, v: clamp01(features[k] ?? 0.4) }))
    .sort((a, b) => b.v - a.v);
  return sorted.slice(0, 6).map((f) => ({ id: f.k, reads: f.k, weight: 1 }));
}

function buildOptimalAffinity(features) {
  const candidates = [];
  for (const k of SCORABLE_KEYS) {
    const v = clamp01(features[k] ?? 0.4);
    candidates.push({ key: k, value: v });
    if (INVERTIBLE.has(k)) candidates.push({ key: k + 'Inv', value: 1 - v });
  }
  candidates.sort((a, b) => b.value - a.value);
  const aff = {};
  for (const c of candidates.slice(0, 5)) aff[c.key] = 1;
  return aff;
}

/**
 * Song-specific interpretation of one registered world. Worlds overlay as `custom`
 * with a stable `registeredId` and a per-song `instanceId`.
 */
export function buildWorldVariant(baseId, features, data = null) {
  const feat = features && typeof features.drive === 'number'
    ? features
    : extractWatchFeatures(features || {});
  const base = getWorld(baseId);
  if (base.id !== baseId) {
    throw new Error(`Cannot build a tailored variant for world ${baseId}`);
  }
  const adapted = adaptWorld(base, data?.profile || feat, { ...(data || {}), profile: data?.profile });
  const proof = proveScore(feat, adapted.world);
  proof.dna = adapted.proof?.dna || null;
  proof.degraded = adapted.degraded;
  return { world: adapted.world, proof, baseId: base.id };
}

export function pickRecommended(ranked = []) {
  return ranked.find((r) => r.recommended) || ranked.find((r) => r.eligible) || ranked[0] || null;
}

/**
 * Choose-for-me constructor: score, then adapt the winner. Not a privileged
 * gallery card — the chooser calls buildWorldVariant with the picked world.
 */
export function buildCustomWorld(features, data = null) {
  const feat = features && typeof features.drive === 'number'
    ? features
    : extractWatchFeatures(features || {});
  const ranked = scoreWorlds(feat, undefined, { profile: data?.profile });
  const pick = pickRecommended(ranked);
  return buildWorldVariant(pick.id, feat, data);
}

function proveScore(features, world) {
  const comfort = comfortScore(features.drive, world.comfort);
  const rawCoverage = coverageScore(features, world.channels);
  const shape = shapeFit(features, world.prefer);
  const rawAffinity = affinityScore(features, world);

  // Theoretical maximums: the best any channel/affinity layout could
  // achieve on these features. Adapted worlds keep the base world's
  // layout, so the ratios are a diagnostic, not a constructed 1.0.
  const maxCov = coverageScore(features, buildOptimalChannels(features));
  const maxAff = affinityScore(features, { affinity: buildOptimalAffinity(features) });

  const coverageNorm = maxCov > 0 ? rawCoverage / maxCov : 1;
  const affinityNorm = maxAff > 0 ? rawAffinity / maxAff : 1;

  const mixed = 0.38 * comfort + 0.24 * coverageNorm + 0.16 * shape + 0.22 * affinityNorm;
  const score = clamp(Math.round(100 * mixed), 1, 100);

  return {
    score,
    comfort,
    shape,
    rawCoverage,
    maxCoverage: maxCov,
    coverageNorm,
    rawAffinity,
    maxAffinity: maxAff,
    affinityNorm,
    mixed,
    drive: features.drive,
  };
}
