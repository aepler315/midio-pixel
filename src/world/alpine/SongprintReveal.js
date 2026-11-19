// A recurring harmonic passage is a place on this range's measured skyline.
// Both the clock and the framing are sampled: no step depends on a past draw.
import { OPENING_ZOOM_START_MS, OPENING_ZOOM_MS } from '../../core/OpeningTimeline.js';
import { cameraBasis } from '../terrain/SceneTravel.js';

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const ease = x => { const t = clamp(x); return t * t * (3 - 2 * t); };
const EDGE_MS = 2000;
const CROP = .43;
const PASSAGE_MS = 12000;
const landmarkIndex = (position, count) => Math.min(count - 1, Math.floor(position * count));

function orderedPassages(songprint) {
  if (songprint?.version !== 1 || !Array.isArray(songprint.passages)) return [];
  return songprint.passages.filter(p => Number.isFinite(p?.timeMs) && Number.isFinite(p.landmark01)
    && p.landmark01 >= 0 && p.landmark01 <= 1 && p.strength > 0 && p.strength <= 1)
    .sort((a, b) => a.timeMs - b.timeMs);
}

// The first non-overlapping, confident return can bring a summit into relief.
// Keep at most two of the stage's most recurrent visible summits in this
// schedule. The other measured pieces keep their individual musical builds.
function compileSlotEmergence(passages, stage, startMs, throughMs) {
  const anchors = stage?.songprintLandmarks;
  if (!anchors?.length) return null;
  const slots = new Map();
  for (const p of passages) {
    if (p.timeMs >= throughMs || p.strength < .4) continue;
    const id = anchors[landmarkIndex(p.landmark01, anchors.length)].slotId;
    if (!id) continue;
    let slot = slots.get(id);
    if (!slot) slots.set(id, slot = { id, firstMs: p.timeMs, returnMs: null, evidence: 0 });
    if (p.timeMs - slot.firstMs < PASSAGE_MS) continue;
    slot.evidence += p.strength;
    // Give an admitted summit its entire six-second gather after the title
    // or a live analysis handoff. It never jumps up partway through a rise.
    if (slot.returnMs === null && p.timeMs - PASSAGE_MS / 2 >= startMs) slot.returnMs = p.timeMs;
  }
  const limit = Math.min(2, Math.max(1, Math.floor(stage.slots.length / 3)));
  const leads = [...slots.values()].filter(s => s.returnMs !== null)
    .sort((a, b) => b.evidence - a.evidence || a.returnMs - b.returnMs).slice(0, limit);
  if (!leads.length) return null;
  return (timeMs, natural) => {
    let result = natural;
    for (const { id, returnMs } of leads) {
      const floor = .82 * ease(1 + (timeMs - returnMs) / (PASSAGE_MS / 2));
      if (natural[id] >= floor || natural[id] == null) continue;
      if (result === natural) result = { ...natural };
      result[id] = floor;
    }
    return Object.freeze(result);
  };
}

export function compileSongprintReveal(songprint, throughMs, admittedMs = 0, stage = null) {
  const passages = orderedPassages(songprint);
  if (!passages.length) return null;
  const startMs = Math.max(OPENING_ZOOM_START_MS + OPENING_ZOOM_MS, admittedMs);
  const cueAt = t => {
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
  return { cueAt, raiseSlots: compileSlotEmergence(passages, stage, startMs, throughMs) };
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
    const index = landmarkIndex(target.landmark01, anchors.length);
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
