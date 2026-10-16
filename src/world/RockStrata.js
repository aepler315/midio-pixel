// Sedimentary beds in the mountain faces.
//
// The first version of this traced the crest polyline and offset it downward,
// once per band. That is geometrically tidy and visually wrong: every band
// ends up exactly parallel to the summit above it, which is the definition of
// a CONTOUR MAP. Four concentric copies of the skyline across every range read
// as topographic wallpaper printed on the mountain rather than as rock, and it
// was the single loudest thing in the frame.
//
// Real beds are laid down flat, tilted by later tectonics, and then cut
// through by whatever erosion carved the mountain. So the line itself knows
// nothing about the skyline: it is near-horizontal, dipping at a shallow
// angle, gently folded -- and the mountain's own silhouette TRUNCATES it.
// That truncation is what makes a peak look carved out of layered rock, and
// it is free here because the whole pass already draws inside a clip of the
// range's body.
//
// Pure geometry. No canvas -- BiomeManager fills these, tests exercise the
// maths directly. Same split as GeoCrest.js / MountainChoreo.js.

// The dip, as a slope: how far a bed drops per px of width. Shallow (~3
// degrees) -- a steep dip reads as a slanted stripe rather than as bedding,
// and starts fighting the skyline.
//
// Deliberately a slope rather than a fraction of the range's height, which is
// what this was first written as. Height means `bottomY - crestY`, and the
// crest is deformed every frame by the dance, so scaling the dip by it put
// the kick drum back into the rock through the back door -- the beds stayed
// anchored at the foot but tilted a little further on every beat. Dip is a
// property of the bedding, not of how tall the mountain above it happens to
// be at this instant.
const DIP_SLOPE = 0.05;
// Gentle folding so the beds aren't drafting-table straight. Wavelengths in
// world px; the amplitudes are px, and they are deliberately small compared
// to the spacing between beds -- folds that approach the bed spacing read as
// wobbly noise instead of as strata.
const FOLD = [
  { len: 940, amp: 5.5, phase: 0 },
  { len: 397, amp: 2.5, phase: 2.2 },
];

/**
 * A bed's vertical offset from its own anchor at one world x.
 *
 * Keyed to world x rather than screen x so the beds travel with the range's
 * parallax instead of sliding across the rock as the camera pans -- the same
 * discipline ConnectorHills' `rollAt` and DistantWave's `swellAt` use.
 *
 * @param {number} worldX  scrollX + screen x
 * @param {number} dipPx   total drop across `width` px (may be negative)
 * @param {number} width   the width `dipPx` is measured over
 * @param {number} screenX screen x, for the linear dip term
 */
export function bedOffsetAt(worldX, screenX, dipPx, width) {
  let fold = 0;
  for (const f of FOLD) fold += f.amp * Math.sin(worldX / f.len + f.phase);
  return (screenX / Math.max(1, width)) * dipPx + fold;
}

/**
 * Every bed across one range, as polylines.
 *
 * Beds are anchored upward from the range's FOOT rather than down from its
 * crest: the foot is the stable edge (the crest is dancing every frame), so
 * anchoring there keeps the rock still while the summit above it moves --
 * which is the right way round. Rock does not breathe with the kick drum.
 *
 * Beds are generated across the range's full height and simply clipped away
 * where there is no mountain, so a tall summit shows many and a low shoulder
 * shows one or two, without either being computed specially.
 *
 * @returns {Array<{y0:number, pts:Array<{x:number,y:number}>, tone:number}>}
 *   top edge per bed, plus `tone` in [0,1]: how dark this particular bed is
 *   relative to the others (real bedding alternates hard and soft layers, and
 *   a uniform comb of identical bands is the other way to read as wallpaper).
 */
export function strataBeds({
  width, crestY, bottomY, scrollX = 0, spacingPx = 34, stepPx = 24, maxBeds = 8, dipSign = 1,
}) {
  const beds = [];
  const span = bottomY - crestY;
  if (!(span > spacingPx) || !(width > 0)) return beds;
  // One extra bed's worth of slack at the top: the dip and the fold both move
  // a bed off its anchor, and a bed whose anchor sits just below the crest can
  // still rise above it on one side. Generating it and letting the clip decide
  // is cheaper and more correct than trying to predict which ones show.
  const count = Math.min(maxBeds, Math.floor(span / spacingPx));
  const dipPx = width * DIP_SLOPE * (dipSign < 0 ? -1 : 1);
  for (let b = 1; b <= count; b++) {
    const y0 = bottomY - b * spacingPx;
    const pts = [];
    for (let x = 0; x <= width + stepPx; x += stepPx) {
      pts.push({ x, y: y0 + bedOffsetAt(scrollX + x, x, dipPx, width) });
    }
    // Alternating competence, on a 3-cycle so it doesn't read as stripes of
    // two. Deterministic in `b`, so a bed keeps its character frame to frame.
    beds.push({ y0, pts, tone: 0.55 + 0.45 * ((b % 3) === 1 ? 1 : (b % 3) === 2 ? 0.35 : 0.7) });
  }
  return beds;
}
