// Green country that rolls in where the dancing skyline goes missing.
//
// The far range is the dramatic one (MountainChoreo.DANCE_LAYERS -- the drama
// belongs at the back), so it spends a lot of its time behind the nearer
// hills. Wherever it ducks under them the eye loses the line entirely: the
// dance is still happening, but there's a dead band between the hill that
// hid it and the ground you're standing on, and nothing carries your gaze
// down through it.
//
// So: where the ridge is tucked away, soft forest-and-grassland hills roll
// down to bridge the gap. Only there, and only as deeply as it's actually
// buried -- these exist to rejoin a broken sightline, not to add another
// permanent range. Where the ridge is visible they don't exist at all.
//
// Pure geometry. No canvas -- BiomeManager strokes and fills these, tests
// exercise the maths directly, same split as GeoCrest.js / MountainChoreo.js.
import { clamp01 } from '../utils/math.js';

// A dip has to be this deep (px, ridge below the occluding skyline) before it
// counts as "tucked away" at all. Below it the ridge is only grazing the hill
// in front and the sightline is essentially intact.
export const MIN_OCCLUSION_PX = 10;
// ...and this deep before the hills reach full presence.
export const FULL_OCCLUSION_PX = 90;
// Spans narrower than this are a notch, not a valley. Filling them produces
// little green slivers winking in and out, which is exactly the visual noise
// this is supposed to avoid.
export const MIN_SPAN_PX = 70;
// Rolling profile: two slow, incommensurate spatial frequencies so the
// country never repeats on an obvious cycle. Wavelengths in strip-space px.
const ROLL_1_LEN = 420, ROLL_2_LEN = 173;
const ROLL_AMP_FRAC = 0.16; // of the span's own depth

/**
 * Where the dancing ridge is hidden behind the skyline in front of it.
 *
 * @param {Array<{x:number,y:number,stripX:number}>} ridge  the dancy range's crest
 * @param {number[]} skyline  the occluding crest y at each of those same x's
 *   (the per-x minimum y of the nearer ranges -- screen y, so smaller is higher)
 * @returns {Array<{from:number,to:number,fromX:number,toX:number,maxDepth:number,depth01:number}>}
 *   index spans, with how deeply buried the ridge gets inside each.
 */
export function occludedSpans(ridge, skyline, {
  minDepthPx = MIN_OCCLUSION_PX, minSpanPx = MIN_SPAN_PX,
} = {}) {
  const spans = [];
  if (!ridge || !skyline || ridge.length < 2) return spans;
  const n = Math.min(ridge.length, skyline.length);

  let start = -1, maxDepth = 0;
  const close = (endIdx) => {
    if (start < 0) return;
    const fromX = ridge[start].x, toX = ridge[endIdx].x;
    if (toX - fromX >= minSpanPx && maxDepth >= minDepthPx) {
      spans.push({
        from: start, to: endIdx, fromX, toX, maxDepth,
        depth01: clamp01((maxDepth - minDepthPx) / Math.max(1, FULL_OCCLUSION_PX - minDepthPx)),
      });
    }
    start = -1; maxDepth = 0;
  };

  for (let i = 0; i < n; i++) {
    // Screen y: the ridge is HIDDEN when it sits lower than the skyline.
    const depth = ridge[i].y - skyline[i];
    if (depth > 0) {
      if (start < 0) start = i;
      if (depth > maxDepth) maxDepth = depth;
    } else {
      close(i > 0 ? i - 1 : 0);
    }
  }
  close(n - 1);
  return spans;
}

/** The rolling country's own gentle undulation at a strip-space x, in
 *  [-1, 1]. Keyed to strip space rather than screen space so a hill stays put
 *  on the land as the world scrolls past it. */
export function rollAt(stripX) {
  return 0.6 * Math.sin(stripX / ROLL_1_LEN) + 0.4 * Math.sin(stripX / ROLL_2_LEN + 1.9);
}

/**
 * The top edge of the connector hills across one occluded span.
 *
 * Starts and ends exactly on the skyline at the span's edges, so it emerges
 * from behind the hill that did the hiding rather than appearing as a seam,
 * and swells to its full descent in the middle where the ridge is most deeply
 * buried. The result rolls DOWN from the occluding crest toward the ground,
 * which is the whole point: it carries the eye through the dead band.
 *
 * @returns {Array<{x:number,y:number}>} sampled top edge, span edges included
 */
export function hillCurve(span, ridge, skyline, { descendPx = 70 } = {}) {
  const pts = [];
  const width = Math.max(1, span.to - span.from);
  for (let i = span.from; i <= span.to; i++) {
    const u = (i - span.from) / width;              // 0..1 across the span
    // Raised cosine: zero at both edges, one in the middle. This is what makes
    // the hills grow out of the skyline instead of butting against it.
    const window = 0.5 - 0.5 * Math.cos(u * 2 * Math.PI);
    const roll = rollAt(ridge[i].stripX) * ROLL_AMP_FRAC;
    const drop = (descendPx * span.depth01) * window * (1 + roll);
    pts.push({ x: ridge[i].x, y: skyline[i] + Math.max(0, drop) });
  }
  return pts;
}
