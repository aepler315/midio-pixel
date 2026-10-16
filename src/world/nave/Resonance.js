// The Nave's musical envelope.
//
// Architecture that rebuilds itself every chorus only works if a returning
// chorus is recognized. Sections already carry an integer `label` from
// SongForm / SSM. The same label lights the same stained-glass bays; a
// different label lights a different set. Weak evidence -- decorative
// pacing cuts, or a missing label -- does not invent a chorus: every bay
// follows bass equally (broad phrasing).
//
// Bass is the 1.2s low-band average, never a single-frame sample. Phrase
// openings (reveal × lift) open the lit bays. Provenance is the trust:
// detected keeps the motif, inferred halves it, decorative drops it.
//
// Pure and causal. Seeking back to an earlier chorus restores that chorus's
// bays; it cannot leave a later motif hanging.
import { clamp01 } from '../../utils/math.js';
import { boundaryLift01 } from '../WorldMusic.js';

export { boundaryLift01 };

/**
 * 0 = broad phrasing (no motif). 1 = a measured label we will honour.
 * Inferred structure is worth half -- a novelty peak is not a chorus.
 */
export function motifTrust(section) {
  if (!section || !Number.isFinite(section.label)) return 0;
  if (section.provenance === 'detected') return 1;
  if (section.provenance === 'inferred') return 0.5;
  return 0;
}

/**
 * Which of four bays belong to this label. Never all-off. Decorative
 * callers should ignore this and treat every bay the same.
 */
export function bayLit(label, bay) {
  const id = Number.isFinite(label) ? Math.abs(Math.round(label)) : 0;
  const bits = ((id * 5 + 3) % 15) + 1;
  return ((bits >> (((bay % 4) + 4) % 4)) & 1) === 1;
}

/**
 * Alpha for one bay. Bass is the resonance of the interior. Reveal opens
 * the motif bays only when trust says this section is real material.
 */
export function bayAlpha({ trust = 0, lit = false, bass = 0, reveal = 0 } = {}) {
  const resonance = 0.12 + 0.38 * clamp01(bass);
  const t = clamp01(trust);
  if (t <= 0) return clamp01(resonance);
  if (!lit) return clamp01(resonance * (0.32 + 0.18 * t));
  return clamp01(resonance + 0.50 * clamp01(reveal) * t);
}
