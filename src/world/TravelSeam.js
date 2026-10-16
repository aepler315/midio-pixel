// Geographic travel between two biomes' scenery (BiomeSchedule.travelMs):
// the new biome's ranges come in from the right behind a soft seam, the
// nearest layer first -- the way the foreground changes before the far
// skyline when you cross a pass. Shared by the legacy strip stack and the
// Range v2 GPU partitions so both travel identically.

export const TRAVEL_FEATHER = 0.18;
export const TRAVEL_BANDS = 4;
// When each layer's seam has crossed the whole view, as a share of the
// travel: the nearest ranges change first, the back skyline last.
export const TRAVEL_ARRIVAL = { L5: 0.55, L4: 0.7, L3: 0.85, L2: 1 };

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Where the seam between the old biome (left) and the new one (right)
 *  stands on screen for one layer, `p` of the way through the travel. It
 *  starts past the right edge, feather and all, and leaves past the left. */
export function travelSeam(width, layerKey, p) {
  const span = TRAVEL_ARRIVAL[layerKey] ?? 1;
  const q = smoothstep(0, 1, Math.min(1, Math.max(0, p) / span));
  const feather = width * TRAVEL_FEATHER;
  return width + feather / 2 - q * (width + feather);
}

/**
 * The seam as screen spans: everything left of `lo` is the old side,
 * everything right of `hi` the new side, and between them `count` bands
 * (TRAVEL_BANDS by default) whose new-side weight rises from left to
 * right. The legacy strips use the default; Range v2's real terrain shows
 * four constant-weight steps as vertical stripes, so it asks for more.
 */
export function travelSpans(width, layerKey, p, count = TRAVEL_BANDS) {
  const seam = travelSeam(width, layerKey, p);
  const feather = width * TRAVEL_FEATHER;
  const lo = seam - feather / 2, hi = seam + feather / 2;
  const bands = [];
  for (let k = 0; k < count; k++) {
    const x0 = lo + (k * feather) / count;
    bands.push({ x0, x1: x0 + feather / count, weightB: (k + 0.5) / count });
  }
  return { lo, hi, bands };
}
