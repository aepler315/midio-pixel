// Put a section boundary on the RELEASE, not on the run-up to it.
//
// Both boundary detectors answer the question "where does the material
// change?", and they answer it well -- Foote novelty over the self-similarity
// matrix is exactly unbiased on a clean boundary, and the band-energy
// fallback's trailing window puts its peak a few analysis steps late. But
// "where the material changes" is not the same question as "where the
// tension releases", and in produced music the two are reliably a bar apart:
// a drop is preceded by a build -- a riser, a filter sweep, a drum fill --
// and the energy vector starts changing when the BUILD starts. The detector
// dutifully marks the build. The show then fires its release a bar early,
// over material that is still winding up.
//
// So this is a correction pass, not a detector. Given a candidate boundary it
// looks a short distance either way for the largest upward STEP in energy --
// a build is a ramp, a drop is a step, and the step is the moment of release
// -- and moves the boundary onto it. That handles both errors with one
// mechanism: a boundary sitting early on the build moves forward onto the
// drop, and one sitting late (the fallback's trailing-window lag) moves back
// onto it.
//
// It deliberately cannot invent a boundary or move one far. If there is no
// clear step inside the window the candidate stands, because a detector that
// found a real change with no release in it has found something this pass
// has no opinion about -- a texture change, a key change, a breakdown.
//
// Pure: takes numbers, returns numbers. BiomeManager applies it to the cut
// indices it has already picked.

/** How far either side of a candidate to look, in analysis steps. Two bars
 *  covers the usual build length without letting a boundary wander into a
 *  neighbouring section's material. */
export const SNAP_SEARCH = 2;
// A step has to be this large, relative to the window's own energy range, to
// count as a release rather than as ordinary bar-to-bar variation. High
// enough that a steady groove's wobble never moves a boundary.
export const SNAP_MIN_STEP_FRAC = 0.35;

/**
 * The strength of the upward energy step landing AT index i.
 *
 * Measured as a short forward mean minus a short backward mean rather than a
 * single difference: one bar either side is noisy, and a drop is not a spike
 * but a change in level that persists. Two steps each way is enough to tell
 * "it got loud and stayed loud" from "one loud bar".
 */
export function releaseStep(energies, i, span = 2) {
  if (!Array.isArray(energies) && !ArrayBuffer.isView(energies)) return 0;
  const n = energies.length;
  if (i <= 0 || i >= n) return 0;
  let before = 0, bn = 0, after = 0, an = 0;
  for (let k = Math.max(0, i - span); k < i; k++) { before += energies[k]; bn++; }
  for (let k = i; k < Math.min(n, i + span); k++) { after += energies[k]; an++; }
  if (bn === 0 || an === 0) return 0;
  return (after / an) - (before / bn);
}

/**
 * Move one candidate boundary onto the nearest release.
 *
 * @param {number} candidateIdx  index into `energies`
 * @param {ArrayLike<number>} energies scalar energy per analysis step
 * @param {object} [opts]
 * @param {number} [opts.search] how far to look either way
 * @param {number} [opts.minStepFrac] how large a step must be to count
 * @returns {number} the corrected index -- the candidate itself when the
 *   window holds no clear release
 */
export function snapToRelease(candidateIdx, energies, {
  search = SNAP_SEARCH, minStepFrac = SNAP_MIN_STEP_FRAC,
} = {}) {
  const n = energies ? energies.length : 0;
  if (!n || !Number.isFinite(candidateIdx)) return candidateIdx;
  const lo = Math.max(1, candidateIdx - search);
  const hi = Math.min(n - 1, candidateIdx + search);
  if (hi < lo) return candidateIdx;

  // Scale the threshold to this window's own dynamics, so a quiet passage and
  // a loud one are judged on the same terms.
  let wLo = Infinity, wHi = -Infinity;
  for (let k = Math.max(0, lo - search); k <= Math.min(n - 1, hi + search); k++) {
    if (energies[k] < wLo) wLo = energies[k];
    if (energies[k] > wHi) wHi = energies[k];
  }
  const range = Math.max(1e-9, wHi - wLo);

  let bestIdx = candidateIdx, bestStep = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const step = releaseStep(energies, i);
    // Ties go to the candidate, then to the earlier index: with two equal
    // steps the detector's own answer is the better prior, and a release is
    // better slightly early than slightly late (the ear forgives an
    // anticipation more readily than a lag).
    if (step > bestStep + 1e-12
      || (Math.abs(step - bestStep) <= 1e-12 && Math.abs(i - candidateIdx) < Math.abs(bestIdx - candidateIdx))) {
      bestStep = step; bestIdx = i;
    }
  }
  if (bestStep < range * minStepFrac) return candidateIdx;
  return bestIdx;
}

/**
 * Apply the correction across a whole set of cut indices.
 *
 * Order and uniqueness are preserved: two candidates that snap onto the same
 * release collapse to one boundary, which is correct -- they were describing
 * the same moment.
 *
 * @param {object} [opts]
 * @param {Iterable<number>} [opts.pinned] indices that must not move.
 */
export function snapCutsToReleases(cuts, energies, opts = {}) {
  if (!Array.isArray(cuts) || cuts.length === 0) return cuts;
  // Structural cuts -- the song's start and end -- are pinned by the caller.
  // They are not describing a release, they are the edges of the schedule,
  // and moving one leaves a gap.
  const pinned = new Set(opts.pinned || []);
  const out = [];
  const seen = new Set();
  for (const c of cuts) {
    const s = pinned.has(c) ? c : snapToRelease(c, energies, opts);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  out.sort((a, b) => a - b);
  return out;
}
