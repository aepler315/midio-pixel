// Range v2 quality ladder (plan Task 16). PerfGovernor owns the level (0
// best .. 6) and its hysteresis: a rung sheds after ~1 s of sustained
// over-budget frames, returns after 10 clean seconds, and a rung that fails
// again after recovering waits twice as long before the next try. This
// table says what the Range's GPU scene gives up at each level, in order:
// the near trees' detail assets first (rung 2), then the stable foliage
// subset, then fog sampling and the sun shafts
// (level 3), the lake mirror (level 4; the water keeps its sky
// reflection), then the dormant rock-stage pool capability (Renderer, level 6;
// catalog views have no rock stage). Landform structure (terrain meshes
// and their LOD budget), ground contact, performer cores and the musical
// signatures are never touched by the ladder.
import { forestKeepFraction } from './ForestCover.js';
import { MIST_SAMPLES } from './RangeAtmosphere.js';

// Fog samples per pixel by level. Level 5 used to thin the mist's density
// instead, which changed the look without saving any work.
const MIST_STEPS = [MIST_SAMPLES, MIST_SAMPLES, MIST_SAMPLES, 4, 4, 3, 2];

/** Fade seconds for an optional layer the ladder sheds or restores. */
export const RUNG_FADE_SEC = 1.5;
/** Ease an optional layer's presence (0..1) toward a rung's target over
 *  heard time, so a shed or a recovery fades instead of popping. Holds
 *  while paused (dtSec 0); snaps on a seek or a first frame (current not
 *  finite, or dtSec outside (0, .5]). down: 'snap' drops at once when the
 *  target falls (a shed that must free its cost now), easing only up. */
export function easeRungAmount(current, target01, dtSec, { sec = RUNG_FADE_SEC, down = 'ease' } = {}) {
  const target = Number.isFinite(target01) ? Math.max(0, Math.min(1, target01)) : 0;
  if (!Number.isFinite(current)) return target;
  if (dtSec === 0) return current;
  if (!(dtSec > 0 && dtSec <= .5)) return target;
  if (down === 'snap' && target < current) return target;
  const step = dtSec / Math.max(1e-6, sec);
  return current < target ? Math.min(target, current + step) : Math.max(target, current - step);
}

/** What the scene draws at a governor level. */
export function rangeQuality(level = 0) {
  const q = Math.max(0, Math.min(6, level | 0));
  return {
    level: q,
    forestKeep: forestKeepFraction(q),
    // Detail-ring trees keep their full branch assets until rung 2, then
    // draw the mesh ring's lighter assets: same trees, same roots, a
    // fraction of the triangles, before any tree is dropped.
    nearDetail: q < 2,
    mistSteps: MIST_STEPS[q],
    poolReflections: q < 6,
    sunShafts: q < 3,
    waterMirror: q < 4,
    landscapeGiants: q < 4,
    // Fair-weather cloud shadows on the land (CloudOcclusion mode 1).
    cloudShadows: q < 4,
  };
}
