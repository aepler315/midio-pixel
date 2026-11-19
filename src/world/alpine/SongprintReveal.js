// A recurring harmonic passage is a place on this range's measured skyline.
// Both the clock and the framing are sampled: no step depends on a past draw.
import { OPENING_ZOOM_START_MS, OPENING_ZOOM_MS } from '../../core/OpeningTimeline.js';
import { cameraBasis } from '../terrain/SceneTravel.js';

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const ease = x => { const t = clamp(x); return t * t * (3 - 2 * t); };
const EDGE_MS = 2000;
const CROP = .43;

export function compileSongprintReveal(songprint, throughMs, admittedMs = 0) {
  if (songprint?.version !== 1 || !Array.isArray(songprint.passages)) return null;
  const passages = songprint.passages.filter(p => Number.isFinite(p?.timeMs) && Number.isFinite(p.landmark01)
    && p.landmark01 >= 0 && p.landmark01 <= 1 && p.strength > 0 && p.strength <= 1)
    .sort((a, b) => a.timeMs - b.timeMs);
  if (!passages.length) return null;
  const startMs = Math.max(OPENING_ZOOM_START_MS + OPENING_ZOOM_MS, admittedMs);
  return t => {
    const gain = ease((t - startMs) / EDGE_MS) * ease((throughMs - t) / EDGE_MS);
    if (!gain) return null;
    let lo = 0, hi = passages.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (passages[mid].timeMs <= t) lo = mid + 1; else hi = mid;
    }
    const left = passages[lo - 1], right = passages[lo];
    const targets = [];
    const add = (p, factor) => {
      if (factor > 0) targets.push({ landmark01: p.landmark01, weight: gain * factor * p.strength });
    };
    // Consecutive 2 s analyses blend their crops. A gap releases to the
    // approved lens before taking up the next independently heard phrase.
    if (left && right && right.timeMs - left.timeMs <= EDGE_MS * 1.25) {
      const f = ease((t - left.timeMs) / (right.timeMs - left.timeMs));
      add(left, 1 - f); add(right, f);
    } else {
      const edge = left && right ? Math.min(EDGE_MS, (right.timeMs - left.timeMs) / 2) : EDGE_MS;
      if (left) add(left, ease(1 - (t - left.timeMs) / edge));
      if (right) add(right, ease(1 - (right.timeMs - t) / edge));
    }
    if (!targets.length) return null;
    const primary = targets.length === 1 || targets[0].weight >= targets[1].weight ? targets[0] : targets[1];
    return { landmark01: primary.landmark01, weight: targets.reduce((s, p) => s + p.weight, 0), targets };
  };
}

/** The crop lies inside the approved visible frustum. Its eye, aim and
 * terrain footprint stay on the active route. At an off-screen landmark
 * it returns smoothly to the original framing instead of chasing it. */
export function frameSongprintLandmark(pose, anchors, cue, { tanX, tanY, rise01 = 1,
  slotRise01 = null, baseM = 0 } = {}) {
  if (!anchors?.length || !cue?.targets?.length || !(tanX > 0 && tanY > 0)) return pose;
  const user = pose.viewOffset;
  const automatic = 1 - ease((user?.fx || 0) / .12);
  if (!automatic) return pose;
  const { forward, right, up } = cameraBasis(pose);
  let fx = 0, rx = 0, uy = 0, primary = null;
  for (const target of cue.targets) {
    const index = Math.min(anchors.length - 1, Math.floor(target.landmark01 * anchors.length));
    const anchor = anchors[index];
    const [x, y, z] = anchor.pointM;
    const h = baseM + (y - baseM) * (slotRise01?.[anchor.slotId] ?? rise01);
    const dx = x - pose.eyeM[0], dy = h - pose.eyeM[1], dz = z - pose.eyeM[2];
    const dot = v => dx * v[0] + dy * v[1] + dz * v[2];
    const depth = dot(forward);
    if (!(depth > 0)) continue;
    const px = dot(right) / (depth * tanX), py = dot(up) / (depth * tanY);
    const visible = ease((1 - Math.max(Math.abs(px), Math.abs(py))) / .2);
    const weight = automatic * target.weight * visible;
    if (!weight) continue;
    fx += CROP * weight;
    rx += weight * clamp(px, -CROP * .98, CROP * .98) * tanX;
    uy += weight * clamp(py - .15, -CROP * .98, CROP * .98) * tanY;
    if (primary?.index === index) primary.weight += weight;
    else if (!primary || weight > primary.weight) primary = { index, name: anchor.name ?? null,
      pointM: anchor.pointM, drawnM: [x, h, z], weight };
  }
  if (!primary) return pose;
  // Compose the listener's crop inside the automatic crop during takeover.
  // Both centres stay inside their respective parent image.
  const scale = 1 - fx;
  return { ...pose, viewOffset: { fx: fx + scale * (user?.fx || 0),
    rx: rx + scale * (user?.rx || 0), uy: uy + scale * (user?.uy || 0) }, songprintReveal: primary };
}
