// A fixed screen fit for real ranges. The source samples and the song's x
// travel are never changed: only the height of a whole strip above its foot
// changes. Preflight runs once per biome-side strip set, not on audio frames.
import { sampleHorizonRidge } from './RidgeMotion.js';
import { ridgeAdvectionPxAt } from '../RidgeMotionHistory.js';
import { stripOriginX, stripSampleX } from '../SilhouetteGenerator.js';

const STATIONS = 21;
const SAMPLE_COLUMNS = 40;
const MAX_FOREGROUND_AREA = 0.20;
const MIN_EXPOSED = 0.55;
const MIN_SUPPORT_SCALE = 0.35;
const MIN_FAR_SCALE = 0.62;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Exactly the sampled polyline painted by BiomeManager._drawHorizonEQ. */
export function horizonEqPoints({ width, height, crest = null, songP = 0, bands,
  tSec = 0, maxHeightFrac = 0.4, tuning = {}, activity01 = null, kick01 = 0,
  motionPresence01 = null, motionMelody = { activity: 0, pitch01: .5 } }) {
  const activity = activity01 ?? Math.max(0, ...(bands || []));
  const music = { bands: bands || Array(7).fill(0), sources: {}, kick01,
    activity01: activity, motionPresence01: motionPresence01 ?? activity, motionMelody };
  return sampleHorizonRidge({ viewport: { width, height }, crest, songP, advectionPx: ridgeAdvectionPxAt(tSec * 1000),
    heardTimeMs: tSec * 1000, tuning: { ...tuning, maxHeightFrac }, history: { sample: () => music } }).points;
}

/** Project the exact baked terrain contour with one foot-anchored draw height. */
export function projectStripCrest(strip, scrollX, drawHeight, stage, columns = SAMPLE_COLUMNS) {
  if (!strip?.ridge?.ridgeYs?.length) return [];
  const { ridge } = strip;
  const origin = stripOriginX(strip, scrollX, stage.width);
  const points = [];
  const count = Math.max(2, columns);
  for (let k = 0; k <= count; k++) {
    const x = stage.viewLeft + stage.viewWidth * k / count;
    const localX = stripSampleX(strip, x - origin);
    const at = Math.min(ridge.ridgeYs.length - 1, localX / ridge.step);
    const i = Math.min(ridge.ridgeYs.length - 2, Math.floor(at));
    const f = at - i;
    const ridgeY = ridge.ridgeYs[i] * (1 - f) + ridge.ridgeYs[i + 1] * f;
    points.push({ x, y: stage.footY - (strip.height - ridgeY) * drawHeight / strip.height });
  }
  return points;
}

function yAt(points, x) {
  if (!points?.length || x < points[0].x || x > points[points.length - 1].x) return null;
  if (x === points[0].x) return points[0].y;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x < x) lo = mid;
    else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const t = (x - a.x) / Math.max(1e-9, b.x - a.x);
  return a.y + (b.y - a.y) * t;
}

function visible(crest, masks) {
  if (!crest?.length) return { fraction: 0, longestRun: 0, dominant: 'empty-geometry' };
  let shown = 0, run = 0, longest = 0;
  const blockers = new Map();
  const blockedBy = {};
  for (const p of crest) {
    let blocked = null;
    for (const [key, samples] of Object.entries(masks)) {
      const y = yAt(samples, p.x);
      if (y != null && y < p.y - 0.5) {
        blocked ||= key;
        blockedBy[key] = (blockedBy[key] || 0) + 1;
      }
    }
    if (blocked) { blockers.set(blocked, (blockers.get(blocked) || 0) + 1); run = 0; }
    else { shown++; run++; longest = Math.max(longest, run); }
  }
  const dominant = [...blockers].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return { fraction: shown / crest.length, longestRun: longest / crest.length, dominant, blockedBy };
}

/** Metrics from actual screen-space polylines; partial masks keep their span. */
export function compositionMetrics({ horizon = null, massif = null, ridges = {}, width = 0,
  groundY = null, viewHeight = null }) {
  const masks = Object.fromEntries(Object.entries(ridges).filter(([, pts]) => pts?.length));
  const out = { width };
  if (horizon) out.horizon = visible(horizon, massif?.length ? { massif, ...masks } : masks);
  if (massif) out.massif = visible(massif, masks);
  if (masks.L2) out.L2 = visible(masks.L2, { L3: masks.L3, L4: masks.L4, L5: masks.L5 });
  if (groundY != null && viewHeight > 0) {
    out.area = {};
    out.relief = {};
    for (const [key, pts] of Object.entries(masks)) {
      out.area[key] = pts.reduce((sum, p) => sum + Math.max(0, groundY - p.y), 0)
        / (pts.length * viewHeight);
      const ys = pts.map((p) => p.y);
      out.relief[key] = (percentile(ys, .9) - percentile(ys, .1)) / viewHeight;
    }
    if (massif?.length) {
      out.area.massif = massif.reduce((sum, p) => sum + Math.max(0, groundY - p.y), 0)
        / (massif.length * viewHeight) * Math.min(1, (massif.at(-1).x - massif[0].x) / Math.max(1, width));
    }
  }
  return out;
}

/** A tall, locally flat summit needs less body area than a broken skyline.
 *  This reads only the scanned massif crest, once per song. The musical band
 *  response still multiplies the same real contour at every frame. */
export function massifShapeScale(crest) {
  if (!crest?.heights?.length || crest.heights.length < 10) return 1;
  const h = crest.heights;
  const innerStart = Math.floor(h.length * .14), innerEnd = Math.ceil(h.length * .86);
  const radius = Math.max(2, Math.floor(h.length * .045));
  let walls = 0, count = 0;
  for (let i = innerStart; i < innerEnd; i += radius) {
    let lo = Infinity, hi = -Infinity;
    for (let j = Math.max(0, i - radius); j <= Math.min(h.length - 1, i + radius); j++) {
      lo = Math.min(lo, h[j]); hi = Math.max(hi, h[j]);
    }
    if (lo > .6 && hi - lo < .15) walls++;
    count++;
  }
  const share = count ? walls / count : 0;
  return 1 - .32 * clamp01((share - .15) / .5);
}

const percentile = (values, q) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
};

/**
 * Source-aware, constant per-side fit. `scrollAt` is the existing song travel
 * evaluated at a station; the fitter never changes that timeline. Optional
 * `horizonAt` supplies the quiet shared EQ polyline for that same station.
 */
export function fitRidgeComposition({ strips, stage, baseHeights = {}, scrollAt = () => 0,
  horizonAt = null, massifAt = null, heightAt = null, stations = STATIONS }) {
  const scales = { L2: 1, L3: 1, L4: 1, L5: 1 };
  const heights = Object.fromEntries(['L2', 'L3', 'L4', 'L5'].map((key) => [key,
    baseHeights[key] ?? Math.min(strips[key]?.height || 0, key === 'L3' ? stage.height * .42
      : key === 'L4' ? stage.height * .30 : Infinity)]));
  const measure = () => {
    const samples = [];
    for (let i = 0; i < stations; i++) {
      const songP = stations > 1 ? i / (stations - 1) : 0;
      const ridges = {};
      for (const key of ['L2', 'L3', 'L4', 'L5']) {
        if (strips[key]?.ridge) {
          ridges[key] = projectStripCrest(strips[key], scrollAt(key, songP),
            heightAt ? heightAt(key, songP, scales) : heights[key] * scales[key], stage);
        }
      }
      const horizon = horizonAt ? horizonAt(songP) : null;
      const massif = massifAt ? massifAt(songP) : null;
      samples.push(compositionMetrics({ horizon, massif, ridges, width: stage.viewWidth,
        groundY: stage.groundY, viewHeight: stage.viewHeight }));
    }
    return {
      farAreaP90: percentile(samples.map((s) => s.area?.L2 || 0), .9),
      farReliefP50: percentile(samples.map((s) => s.relief?.L2 || 0), .5),
      midAreaP90: percentile(samples.map((s) => s.area?.L3 || 0), .9),
      nearAreaP90: percentile(samples.map((s) => s.area?.L4 || 0), .9),
      farVisibleP10: percentile(samples.map((s) => s.L2?.fraction ?? 1), .1),
      farVisibleMin: Math.min(...samples.map((s) => s.L2?.fraction ?? 1)),
      horizonVisibleP10: percentile(samples.map((s) => s.horizon?.fraction ?? 1), .1),
      massifVisibleP10: percentile(samples.map((s) => s.massif?.fraction ?? 1), .1),
      samples,
    };
  };
  let metrics = measure();
  // The highest fit that earns a supporting role keeps each source's size.
  for (const [key, metric] of [['L3', 'midAreaP90'], ['L4', 'nearAreaP90']]) {
    while (strips[key]?.ridge && metrics[metric] > MAX_FOREGROUND_AREA
      && scales[key] > MIN_SUPPORT_SCALE + 1e-9) {
      scales[key] = Math.max(MIN_SUPPORT_SCALE, scales[key] - .05);
      metrics = measure();
    }
  }
  // A broad, locally level L2 can become the biggest opaque wall even after
  // the nearer ranges yield. Give its actual scanned contour less body area;
  // broken high-relief sources keep the stage height they earned.
  const farAreaLimit = .24 + .10 * clamp01((metrics.farReliefP50 - .08) / .16);
  while (strips.L2?.ridge && metrics.farAreaP90 > farAreaLimit
    && scales.L2 > MIN_FAR_SCALE + 1e-9) {
    scales.L2 = Math.max(MIN_FAR_SCALE, scales.L2 - .05);
    metrics = measure();
  }
  while (horizonAt && metrics.horizonVisibleP10 < MIN_EXPOSED
    && scales.L2 > MIN_FAR_SCALE + 1e-9) {
    scales.L2 = Math.max(MIN_FAR_SCALE, scales.L2 - .05);
    metrics = measure();
  }
  // A percentile can hide a brief complete overlap. Preserve the far crest
  // at every sampled station, lowering the layer that actually obscures it.
  // L5 remains the authored footing; don't shrink unrelated middle scenery
  // when that non-adjustable foreground is the only remaining blocker.
  while (metrics.farVisibleMin < MIN_EXPOSED) {
    const adjustable = (key) => ['L3', 'L4'].includes(key)
      && scales[key] > MIN_SUPPORT_SCALE + 1e-9;
    const failing = metrics.samples.filter((s) => s.L2?.fraction < MIN_EXPOSED);
    // Preserve the dominant-first fit. If that layer has exhausted its
    // allowance, another real blocker can still recover visible crest width.
    const primary = failing.find((s) => adjustable(s.L2.dominant));
    const key = primary?.L2.dominant || failing.flatMap((s) => Object.entries(s.L2.blockedBy))
      .filter(([candidate]) => adjustable(candidate))
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!key) break;
    scales[key] = Math.max(MIN_SUPPORT_SCALE, scales[key] - .05);
    metrics = measure();
  }
  return { scales, metrics, heights };
}
