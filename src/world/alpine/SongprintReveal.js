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

// Let the title's existing close-up widen first, then give the established
// pair one shot before the passage-specific framing takes over.
export function songprintEstablishAt(timeMs, admittedMs, throughMs) {
  const start = Math.max(OPENING_ZOOM_START_MS + OPENING_ZOOM_MS, admittedMs);
  const end = Math.min(22000, throughMs);
  if (end - start < 6000) return 0;
  return .8 * ease((timeMs - start) / 2400) * ease((end - timeMs) / 6200);
}

function project(anchor, eye, axes, tanX, tanY, baseM, rise01, slotRise01) {
  const [x, y, z] = anchor.pointM;
  const height = baseM + (y - baseM) * (slotRise01?.[anchor.slotId] ?? rise01);
  const dx = x - eye[0], dy = height - eye[1], dz = z - eye[2];
  const dot = v => dx * v[0] + dy * v[1] + dz * v[2];
  const depth = dot(axes.forward);
  if (!(depth > 0)) return null;
  const px = dot(axes.right) / (depth * tanX), py = dot(axes.up) / (depth * tanY);
  const visible = ease((1 - Math.max(Math.abs(px), Math.abs(py))) / .2);
  return { px, py, visible, drawnM: [x, height, z] };
}

function pairedCrop(lead, companion) {
  if (!lead?.visible || !companion?.visible) return null;
  const spanX = Math.abs(lead.px - companion.px), spanY = Math.abs(lead.py - companion.py);
  const visible = Math.min(lead.visible, companion.visible) * ease((spanX - .06) / .16);
  if (!visible) return null;
  const crop = clamp(1 - Math.max(spanX / 1.76, spanY / 1.68), 0, CROP);
  // Protect the box covering both crests, leaving more room for terrain
  // under them. When fit and taste disagree, keep both inside the frame.
  const center = (a, b, extra = 0) => clamp(.58 * a + .42 * b - extra,
    Math.max(-crop, Math.max(a, b) - (1 - crop)),
    Math.min(crop, Math.min(a, b) + (1 - crop)));
  return { crop, x: center(lead.px, companion.px), y: center(lead.py, companion.py, .16), visible };
}

/** The crop lies inside the approved visible frustum. Its eye, aim and
 * terrain footprint stay on the active route. At an off-screen landmark
 * it returns smoothly to the original framing instead of chasing it. */
export function frameSongprintLandmark(pose, anchors, cue, { tanX, tanY, rise01 = 1,
  slotRise01 = null, baseM = 0, composition = null, establish01 = 0 } = {}) {
  const targets = anchors?.length ? cue?.targets || [] : [];
  const establish = composition ? establish01 : 0;
  if ((!targets.length && !establish) || !(tanX > 0 && tanY > 0)) return pose;
  const user = pose.viewOffset;
  const automatic = 1 - ease((user?.fx || 0) / .12);
  if (!automatic) return pose;
  const axes = cameraBasis(pose);
  const at = anchor => project(anchor, pose.eyeM, axes, tanX, tanY, baseM, rise01, slotRise01);
  const opening = establish > 0 ? pairedCrop(at(composition.principal), at(composition.companion)) : null;
  const pairWeight = opening ? establish * opening.visible : 0;
  let fx = opening ? opening.crop * automatic * pairWeight : 0;
  let rx = opening ? opening.x * tanX * automatic * pairWeight : 0;
  let uy = opening ? opening.y * tanY * automatic * pairWeight : 0;
  let primary = null;
  for (const target of targets) {
    const index = landmarkIndex(target.landmark01, anchors.length), anchor = anchors[index];
    const sample = at(anchor);
    if (!sample?.visible) continue;
    const weight = automatic * (1 - pairWeight) * target.weight * sample.visible;
    if (!weight) continue;
    let crop = CROP, x = clamp(sample.px, -CROP * .98, CROP * .98),
      y = clamp(sample.py - .15, -CROP * .98, CROP * .98);
    const companion = anchor.slotId && anchor.slotId === composition?.principal.slotId ? composition.companion
      : anchor.slotId && anchor.slotId === composition?.companion.slotId ? composition.principal : null;
    if (companion) {
      const pair = pairedCrop(sample, at(companion));
      if (pair) {
        crop += (pair.crop - crop) * pair.visible;
        x += (pair.x - x) * pair.visible;
        y += (pair.y - y) * pair.visible;
      }
    }
    fx += crop * weight;
    rx += weight * x * tanX;
    uy += weight * y * tanY;
    if (primary?.index === index) primary.weight += weight;
    else if (!primary || weight > primary.weight) primary = { index, name: anchor.name ?? null,
      pointM: anchor.pointM, drawnM: sample.drawnM, weight };
  }
  if (!primary && !fx) return pose;
  // Compose the listener's crop inside the automatic crop during takeover.
  // Both centres stay inside their respective parent image.
  const scale = 1 - fx;
  return { ...pose, viewOffset: { fx: fx + scale * (user?.fx || 0),
    rx: rx + scale * (user?.rx || 0), uy: uy + scale * (user?.uy || 0) }, ...(primary ? { songprintReveal: primary } : {}) };
}
