// Pure math for what lives on/over the far ocean: islands, drifting ships,
// sea life (fish leaps, dolphin pods, whale spouts), a rare surfacing sea
// monster, and occasional tsunami walls that approach from the far horizon
// toward the player (near edge of the ocean plane).
// No canvas here -- BiomeManager consumes these, tests exercise them
// directly. Everything is seeded and deterministic per song, following the
// same shape as MeteorShower/SkyEnsemble/FarVignettes: schedules built once
// at construction, pure placement/shape functions evaluated per frame.
import { clamp01, mulberry32 } from '../utils/math.js';

// World-x positions for islands/ships live in a periodic wrap space so a
// handful of features can be scattered "out there" without needing an
// unbounded seeded stream -- the same feature reappears every WRAP_PX of
// scroll, far enough apart (several screens) that the repeat never reads.
export const OCEAN_LIFE_WRAP_PX = 7000;
export const OCEAN_LIFE_RATIO = 0.06; // parallax: slower than L2 (0.10) but visibly scrolling -- it's ON the far water

/** Wrap `x0 - scroll` into (-WRAP/2, WRAP/2], the signed offset from the
 *  viewport-relative origin -- negative means "already behind/left". */
export function wrappedOffset(x0, scroll, wrap = OCEAN_LIFE_WRAP_PX) {
  let d = (x0 - scroll) % wrap;
  if (d <= -wrap / 2) d += wrap;
  if (d > wrap / 2) d -= wrap;
  return d;
}

/** Seeded island placements: {x0, rowFrac, w, h, kind, beacon, crownJag}.
 *  rowFrac 0 (nearest) .. 1 (at the horizon) matches Ocean.js's row
 *  convention. 'mesa' is weighted heavier than the others and stands much
 *  taller/steeper -- a solitary forested rock plateau rearing out of the
 *  sea (Forest Haven, not a gentle sandbar), the sea's signature landmark.
 *  crownJag bakes the mesa's ragged treeline deterministically so the draw
 *  path never needs its own per-frame RNG. */
export function islands(seed, count = 4) {
  const rand = mulberry32(seed >>> 0);
  const out = [];
  const KINDS = ['cone', 'mesa', 'mesa', 'palm'];
  for (let i = 0; i < count; i++) {
    const kind = KINDS[Math.floor(rand() * KINDS.length)];
    const isMesa = kind === 'mesa';
    out.push({
      x0: (i + rand()) * (OCEAN_LIFE_WRAP_PX / count),
      rowFrac: 0.25 + rand() * 0.6,
      w: (isMesa ? 34 : 40) + rand() * (isMesa ? 60 : 70),
      h: isMesa ? 26 + rand() * 30 : 10 + rand() * 12,
      kind,
      beacon: rand() < 0.35,
      crownJag: isMesa ? Array.from({ length: 6 }, () => rand()) : null,
    });
  }
  return out;
}

/** Seeded slow-drifting ships: {x0, rowFrac, driftPxS, size, kind}. */
export function ships(seed, count = 3) {
  const rand = mulberry32(seed >>> 0);
  const out = [];
  const KINDS = ['sail', 'sail', 'wreck'];
  for (let i = 0; i < count; i++) {
    out.push({
      x0: (i + 0.5 + rand()) * (OCEAN_LIFE_WRAP_PX / count),
      rowFrac: 0.15 + rand() * 0.45, // ships stay closer than islands
      driftPxS: (rand() < 0.5 ? -1 : 1) * (2 + rand() * 3),
      size: 0.7 + rand() * 0.6,
      kind: KINDS[Math.floor(rand() * KINDS.length)],
    });
  }
  return out;
}

/** Sorted seeded sea-life events across the song: {tMs, kind, u, rowFrac}.
 *  u is a fixed 0..1 horizontal placement (fraction of screen width at the
 *  moment it plays), kind one of 'fish'|'pod'|'spout'. Spaced 7-18s apart. */
export function seaLifeSchedule(seed, durationMs, opts = {}) {
  const rand = mulberry32(seed >>> 0);
  const minGap = opts.minGapMs ?? 7000, maxGap = opts.maxGapMs ?? 18000;
  const KINDS = ['fish', 'pod', 'spout'];
  const DUR = { fish: 900, pod: 4000, spout: 2500 };
  const out = [];
  let t = minGap * 0.5 + rand() * minGap;
  while (t < durationMs - 1000) {
    const kind = KINDS[Math.floor(rand() * KINDS.length)];
    out.push({ tMs: t, kind, durMs: DUR[kind], u: 0.1 + rand() * 0.8, rowFrac: 0.2 + rand() * 0.55 });
    t += minGap + rand() * (maxGap - minGap);
  }
  return out;
}

/** Rare sea-monster surfacing events: {tMs, durMs, u}. 1-2 per song, kept
 *  well clear of the very start/end, gap enforced between them. */
export function monsterSchedule(seed, durationMs, opts = {}) {
  const rand = mulberry32(seed >>> 0);
  const margin = opts.marginMs ?? 20000;
  const minGap = opts.minGapMs ?? 45000;
  const durMs = opts.durMs ?? 7000;
  const usable = durationMs - 2 * margin;
  if (usable <= 0) return [];
  const count = usable > minGap ? (rand() < 0.5 ? 2 : 1) : 1;
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < 50) {
    const tMs = margin + rand() * usable;
    if (out.every((e) => Math.abs(e.tMs - tMs) >= minGap)) out.push({ tMs, durMs, u: 0.2 + rand() * 0.6 });
  }
  out.sort((a, b) => a.tMs - b.tMs);
  return out;
}

/** 1-2 tsunami walls, anchored near the song's highest-energy moments
 *  (jittered) when hotspots are supplied, else spread seeded fallback.
 *  `dir` is a mild lateral bias for center X (-1 left, +1 right), not a
 *  sweep direction -- the wall always approaches horizon → player. */
export function tsunamiSchedule(seed, durationMs, hotspotMs = []) {
  const rand = mulberry32(seed >>> 0);
  const count = hotspotMs.length > 0 ? Math.min(2, hotspotMs.length) : (rand() < 0.5 ? 2 : 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = hotspotMs.length > 0
      ? hotspotMs[i % hotspotMs.length]
      : durationMs * (0.3 + i * 0.35);
    const tMs = clamp01((base + (rand() - 0.5) * 4000) / durationMs) * durationMs;
    out.push({ tMs, dir: rand() < 0.5 ? 1 : -1 });
  }
  out.sort((a, b) => a.tMs - b.tMs);
  return out;
}

export const TSUNAMI_SWEEP_MS = 7000; // long enough to read the approach
export const TSUNAMI_WIDTH_PX = 260;
// Depth approach: rowFrac 1 = horizon (far), 0 = nearest ocean edge (player).
export const TSUNAMI_ROW_FAR = 0.98;
export const TSUNAMI_ROW_NEAR = 0.06;
// Crest envelope peaks near arrival; overtop arms the flood shortly before.
export const TSUNAMI_APPROACH_UP_FRAC = 0.82;
export const TSUNAMI_OVERTOP_SCALE = 0.85;
export const FLOOD_DURATION_MS = 5000;

/** True when the event's approach window is live at `nowMs`. */
export function tsunamiActive(event, nowMs) {
  const age = nowMs - event.tMs;
  const half = TSUNAMI_SWEEP_MS / 2;
  return age >= -half && age <= half;
}

// Withdrawal telegraph: real tsunamis pull the water OUT first -- the sea
// drains from the shoreline in the seconds before the wave itself arrives,
// the single most legible real-world tell that one is coming. This window
// sits immediately BEFORE tsunamiActive's own approach window, so a wall's
// wave visibility and its withdrawal never overlap.
export const TSUNAMI_WITHDRAWAL_LEAD_MS = 2400;

/** True during the withdrawal window that immediately precedes the wall's
 *  own approach (tsunamiActive). */
export function tsunamiWithdrawalActive(event, nowMs) {
  const age = nowMs - event.tMs;
  const half = TSUNAMI_SWEEP_MS / 2;
  return age >= -(half + TSUNAMI_WITHDRAWAL_LEAD_MS) && age < -half;
}

/** 0..1 how far the sea has drawn back, 0 at the start of the withdrawal
 *  window, easing up to 1 right as the wall's own approach begins -- a
 *  held tension right before the payoff, not a linear drain. */
export function tsunamiWithdrawal01(event, nowMs) {
  if (!tsunamiWithdrawalActive(event, nowMs)) return 0;
  const age = nowMs - event.tMs;
  const half = TSUNAMI_SWEEP_MS / 2;
  const u = clamp01((age + half + TSUNAMI_WITHDRAWAL_LEAD_MS) / TSUNAMI_WITHDRAWAL_LEAD_MS);
  return Math.sin(u * Math.PI / 2); // ease-in: slow at first, sharp right before the wall appears
}

/** 0..1 progress through the approach window (0 = far/out-of-sight,
 *  1 = arrived at the near edge). Uses the same age convention as the old
 *  lateral sweep: age 0 is mid-window, age ∈ [-half, half]. */
export function tsunamiProgress(ageMs) {
  const half = TSUNAMI_SWEEP_MS / 2;
  return clamp01((ageMs + half) / TSUNAMI_SWEEP_MS);
}

/** Ocean-plane depth of the wall (rowFrac): starts at the far horizon and
 *  monotonically moves toward the near (player-facing) edge. */
export function tsunamiRowFrac(progress) {
  const p = clamp01(progress);
  return TSUNAMI_ROW_FAR + (TSUNAMI_ROW_NEAR - TSUNAMI_ROW_FAR) * p;
}

/** Perspective size (0..1): tiny while far, balloons as it nears the player.
 *  Power curve keeps early frames effectively out of sight. */
export function tsunamiPerspectiveScale(progress) {
  return Math.pow(clamp01(progress), 1.55);
}

/** Screen-space center X for the wall. Mild lateral bias from `event.dir`
 *  so successive walls don't always hit dead-center. */
export function tsunamiCenterX(event, w) {
  const bias = (event.dir || 0) * w * 0.12;
  return w * 0.5 + bias;
}

/** Falloff (0..1) of the wall's horizontal body at distance `dx` (px) from
 *  center -- 1 at the spine, tapering over half-width. Width may be scaled
 *  by perspective at the draw site. */
export function tsunamiLift(dx, halfWidthPx = TSUNAMI_WIDTH_PX) {
  const d = Math.abs(dx);
  if (d >= halfWidthPx) return 0;
  return clamp01(1 - d / halfWidthPx);
}

/** Falloff (0..1) of the swell along the depth axis: peaks when a wave
 *  row's rowFrac matches the tsunami's current depth, zero outside a band. */
export function tsunamiDepthLift(rowFrac, tsunamiRf, halfWidth = 0.18) {
  const d = Math.abs(rowFrac - tsunamiRf);
  if (d >= halfWidth) return 0;
  return clamp01(1 - d / halfWidth);
}

/** 0..1 crest envelope: small/invisible at the far start, full near
 *  arrival, slight recede as it "breaks" over the near edge. */
export function tsunamiHeightScale(ageMs) {
  const u = tsunamiProgress(ageMs);
  const rise = clamp01(u / TSUNAMI_APPROACH_UP_FRAC);
  const pastPeak = u > TSUNAMI_APPROACH_UP_FRAC
    ? (u - TSUNAMI_APPROACH_UP_FRAC) / (1 - TSUNAMI_APPROACH_UP_FRAC)
    : 0;
  const recede = 1 - 0.35 * clamp01(pastPeak);
  return rise * recede;
}

/** Vertical profile (0..1) of the wave-wall silhouette across its own
 *  width, s in [-1,1] (0 = spine): a tall curl with a foam tip, settling
 *  toward the trailing edges. */
export function tsunamiProfile(s) {
  const c = clamp01((s + 1) / 2);
  const rise = Math.exp(-((c - 0.55) ** 2) / 0.02);
  const settle = clamp01(1 - Math.max(0, c - 0.55) * 1.6);
  return clamp01(Math.max(rise, settle * 0.35));
}

/** Seeded spray-fleck descriptors riding just above the tsunami's crest --
 *  {sOff (position along the wall's own -1..1 profile axis), riseFrac (how
 *  far above the crest line, 0..1 of wall height), phase}. Pure/deterministic
 *  so the same wall always throws the same spray. */
export function sprayFlecks(seed, count = 7) {
  const rand = mulberry32(seed >>> 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ sOff: -0.25 + rand() * 0.7, riseFrac: 0.15 + rand() * 0.55, phase: rand() * Math.PI * 2 });
  }
  return out;
}

/** Height (px, >=0) of a fish's leap arc at progress u in [0,1]. */
export function fishArcY(u) {
  const c = clamp01(u);
  return 26 * Math.sin(c * Math.PI);
}

/** Vertical offset (px) of the sea monster's Nth trailing hump at body
 *  position u in [0,1] (0=head) and a per-hump phase. */
export function serpentHumpY(u, phase) {
  return 10 * Math.sin(u * Math.PI * 4 + phase);
}
