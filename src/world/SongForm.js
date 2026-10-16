// Song-form recognition: which sections are the SAME music. The section
// schedule (BiomeManager._buildSchedule) cuts boundaries at energy-novelty
// peaks, but a boundary list has no memory -- it never notices that verse 2
// is verse 1 again, or that the chorus has returned. This labels sections
// so recurrences can wear the same face: every chorus the same world/color,
// every verse another.
//
// The feature that says "same music" is a section's mean 7-band spectral
// SHAPE (its timbral fingerprint -- bass-heavy drop vs airy breakdown vs
// mid-forward verse), compared by cosine similarity so loudness alone
// doesn't decide identity, gated by a coarse energy-proximity check so two
// differently-voiced sections that happen to sit at the same loudness don't
// merge. Pure/DOM-free, like the other analysis modules (Dramaturgy,
// PhraseTracker, MountainChoreo).

/** Cosine similarity of two equal-length vectors, in [-1, 1]; 0 for a
 *  zero-magnitude vector (no shape to compare). */
export function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na * nb);
  return den > 1e-12 ? dot / den : 0;
}

// The energy gate, expressed against the song's OWN dynamic range.
//
// This used to be a flat absolute number (0.22 on a 0..1 energy scale), and
// that made the FORM a song reads as depend on its MASTERING. Measured on a
// V-C-V-C' form whose final chorus returns a little quieter, as final
// choruses do: compress the master and the two choruses land 0.04 apart and
// label correctly; give the same song real dynamic range and they land 0.25
// apart, trip the flat 0.22, and the returning chorus founds a THIRD label --
// so it wears a new biome instead of coming home.
//
// It is the same disease EnergyCurves.globalEnergyNorm was written to cure
// ("a brickwalled master sat pinned above every gate and a quiet one never
// crossed any"), and the cure is the same: ask the question against the
// track's own range. Two sections may merge while they sit within this
// FRACTION of the song's own spread of section energies, so "far apart in
// loudness" means the same musical thing on a whisper-quiet folk record and
// a mastered-to-ceiling club track.
export const ENERGY_TOL_FRAC = 0.45;
// ...but never a tighter window than this in absolute terms. On a song with
// essentially no dynamics the section energies differ only by noise, and
// noise-level differences must not be allowed to veto a clear shape match.
// Same reasoning as EnergyCurves.FLAT_SPREAD_MIN, and the reason a flat song
// degrades to the old behaviour rather than to hair-trigger splitting.
export const ENERGY_TOL_MIN = 0.12;

/** The gate width for one song: a fraction of its own section-energy spread,
 *  floored so a dynamics-free track can't drive it to zero. Exported so the
 *  tests can state the property rather than re-deriving the constant. */
export function energyToleranceFor(sectionFeatures) {
  if (!sectionFeatures || sectionFeatures.length === 0) return ENERGY_TOL_MIN;
  let lo = Infinity, hi = -Infinity;
  for (const f of sectionFeatures) {
    const e = f.energy;
    if (!Number.isFinite(e)) continue;
    if (e < lo) lo = e;
    if (e > hi) hi = e;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return ENERGY_TOL_MIN;
  return Math.max(ENERGY_TOL_MIN, ENERGY_TOL_FRAC * Math.max(0, hi - lo));
}

/**
 * Greedy agglomerative labelling of a section sequence into structural
 * classes (A=0, B=1, C=2, ...). A section joins the existing label whose
 * running centroid it most resembles when the band-shape cosine similarity
 * clears `simThreshold` AND the energy sits within the song's own energy
 * tolerance (see `energyToleranceFor`); otherwise it founds a new label.
 * First-appearance order, so an A-B-A-C-B song reads back exactly [0,1,0,2,1].
 *
 * @param {Array<{energy:number, shape:number[]}>} sectionFeatures
 * @param {object} [opts]
 * @param {number} [opts.simThreshold]
 * @param {number} [opts.energyTol] override the song-relative gate with a
 *   fixed width. Only for callers that genuinely have an absolute scale in
 *   hand; leaving it out is the right default.
 * @returns {number[]} one integer label per section
 */
export function analyzeSongForm(sectionFeatures, { simThreshold = 0.9, energyTol } = {}) {
  const tol = energyTol ?? energyToleranceFor(sectionFeatures);
  const labels = [];
  // Per-label running centroid: summed shape + summed energy + count, so the
  // centroid is the mean of every section assigned so far (a returning
  // chorus is matched against the average of all prior choruses, not just
  // the last one).
  const centroids = []; // { shapeSum:number[], energySum:number, count:number }

  for (const feat of sectionFeatures) {
    // Unknown spectra carry no evidence of a new identity. Inherit the
    // previous safe label without polluting any measured centroid.
    if (!Number.isFinite(feat.energy) || !Array.isArray(feat.shape)
      || !feat.shape.every(Number.isFinite) || !feat.shape.some(v => v > 1e-9)) {
      labels.push(labels.at(-1) ?? 0);
      continue;
    }
    let best = -1, bestSim = -Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const cen = centroids[c];
      const centroidShape = cen.shapeSum.map((s) => s / cen.count);
      const centroidEnergy = cen.energySum / cen.count;
      if (Math.abs(feat.energy - centroidEnergy) > tol) continue;
      const sim = cosineSim(feat.shape, centroidShape);
      if (sim >= simThreshold && sim > bestSim) { bestSim = sim; best = c; }
    }

    if (best === -1) {
      centroids.push({ shapeSum: [...feat.shape], energySum: feat.energy, count: 1 });
      labels.push(centroids.length - 1);
    } else {
      const cen = centroids[best];
      for (let k = 0; k < feat.shape.length; k++) cen.shapeSum[k] += feat.shape[k];
      cen.energySum += feat.energy;
      cen.count++;
      labels.push(best);
    }
  }

  return labels;
}
