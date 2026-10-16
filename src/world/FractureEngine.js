// Progressive screen fracturing + terminal shatter (spec §4.2). The screen
// is a pane of glass the song slowly destroys: a stress accumulator births
// crack trees that subtly outline THE MONOLITH -- a single structure rising
// out of the far ocean over the length of the track. The final lead freezes
// the last frame, then shards ease apart and fade rather than detonating in
// a hard flash.
import { clamp, clamp01, mulberry32, hashSeed, lerp, smoothstep } from '../utils/math.js';
import { delaunayTriangulate, poissonDiscSample } from '../utils/delaunay.js';
import { ObjectPool } from '../utils/ObjectPool.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';
import { Role } from '../core/NoteEvent.js';
import {
  analyzeSongFinale, buildPeakProgress, FINALE_FREEZE_LEAD_MS,
} from '../core/SongFinale.js';
import { capFlashAlpha } from '../ui/Accessibility.js';
import { OCEAN_HORIZON_FRAC, OCEAN_NEAR_FRAC } from './Ocean.js';
import { BASELINE_FRAC as SPACE_RIDGE_BASELINE_FRAC } from './SpaceRidge.js';

// Many small ridge pieces, spaced evenly across song progress so the
// monolith draws itself gradually through the whole track (not a late pile-up).
export const RIDGE_GEN_COUNT = 16;
/** Even stress thresholds in [start, end] for progressive ridge birth. */
export function buildStressThresholds(count = RIDGE_GEN_COUNT, start = 0.04, end = 0.92) {
  const n = Math.max(1, count | 0);
  if (n === 1) return [start];
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = start + ((end - start) * i) / (n - 1);
  return out;
}
const THRESHOLDS = buildStressThresholds(RIDGE_GEN_COUNT);
// Slow grow: each ridge inks on over several seconds so births don't flash.
const GROW_MS = 3400;
const KICK_SYNC_WINDOW_MS = 120;
const FREEZE_LEAD_MS = FINALE_FREEZE_LEAD_MS;
// Shatter timing: a short hold on the frozen frame, then a long ease-out
// so the glass falls apart instead of exploding and vanishing in 600ms.
const FREEZE_HOLD_MS = 90;
const FLASH_AT_MS = 70; // soft white kiss right as shards begin to move
const FLASH_DUR_MS = 140;
const FADE_START_MS = 520;
const SHATTER_TOTAL_MS = 1600;
const SHATTER_BURST_MS = 380; // velocity eases from 0 → full over this window after hold

// Surface cracks: a small, short-lived burst where Broshi's burrow punches
// through the glass (dig-in and eruption) -- distinct from the permanent
// ridge cracks above (those accumulate for the whole song and feed the
// finale triangulation). These are a quick "he just broke the pane" tell,
// grown and faded independently, and never added to `cracks` so they never
// pollute the shatter geometry.
const SURFACE_CRACK_LEGS_MIN = 3, SURFACE_CRACK_LEGS_MAX = 4;
const SURFACE_CRACK_GROW_MS = 220;
const SURFACE_CRACK_FADE_MS = 650;
const SURFACE_CRACK_LIFE_MS = SURFACE_CRACK_GROW_MS + SURFACE_CRACK_FADE_MS;
const MAX_SURFACE_CRACKS = 6;

/**
 * Build polyline geometry from an ordered list of points.
 * @returns {{nodes:{x:number,y:number}[], lengths:number[], total:number, children:any[]}}
 */
export function polylineFromPoints(points) {
  const nodes = points.map((p) => ({ x: p.x, y: p.y }));
  const lengths = [];
  let total = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    const len = Math.hypot(nodes[i + 1].x - nodes[i].x, nodes[i + 1].y - nodes[i].y);
    lengths.push(len);
    total += len;
  }
  return { nodes, lengths, total, children: [] };
}

/**
 * Sample a jagged ridge chord between two points (integer midpoints, seeded
 * noise). Keeps polylines readable as ridgelines rather than smooth arcs.
 */
function jaggedChord(a, b, nMids, rand, ampPx) {
  const pts = [a];
  for (let i = 1; i <= nMids; i++) {
    const t = i / (nMids + 1);
    const x = lerp(a.x, b.x, t);
    const y = lerp(a.y, b.y, t);
    // Perpendicular jitter — ridge sawtooth, not soft noise.
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const j = (rand() * 2 - 1) * ampPx * (0.4 + 0.6 * Math.sin(t * Math.PI));
    pts.push({ x: x + nx * j, y: y + ny * j });
  }
  pts.push(b);
  return pts;
}

// --- The Monolith ----------------------------------------------------------
// The glass used to ink an impossible mountain range spread across the whole
// frame. It now inks ONE structure, and because the pieces are ordered
// bottom-to-top and birth in that order as the song's stress accumulates,
// the thing genuinely RISES over the length of the track rather than merely
// fading up in place. The whole point is a scale reveal, not a portrait: a
// player should never be sure they're looking at an actual ship, only that
// whatever it is, it's ABOUT that size -- so the moment it turns out to be
// vastly bigger lands as a surprise instead of confirming a drawing.
//
//   1. A small, rough, barely-there mark breaks the water -- roughly
//      ship-sized, ambiguous in shape. Not a technical hull/deck/mast
//      illustration; just something small out there.
//   2. It keeps going down, and keeps going UP, wider each course. It was
//      never boat-sized; that was the exposed tip of something with no
//      visible bottom, and it swells far past its first impression as it climbs.
//   3. The shaft climbs, course by course, out of the ocean and through the
//      whole sky, widening well past anything a ship could be before it
//      finally narrows to a spire.
//   4. It crosses the deep-sky altitude where the SpaceRidge hangs -- and
//      the last birth of the song is the tie line that joins them.
//
// Every altitude here is derived from the constants that actually define the
// world's vertical extremes -- the ocean plane (Ocean.js) and the space
// ridge's own baseline (SpaceRidge.js) -- so the structure genuinely spans
// "ocean to outer space" and genuinely meets the ridge, instead of
// approximating both with magic numbers that would drift out of sync the
// moment either system was retuned.

// How far down the ocean plane (0 = far horizon, 1 = near edge) it stands.
// Sits well out on the plane rather than right at the horizon line: anchored
// up at the horizon the whole structure crams into the top quarter of the
// frame and reads as a stubby lump, which is the opposite of the point. Out
// here it has most of the frame to climb through, and it is the SLENDERNESS
// (below), not the anchor, that keeps it reading as impossibly distant.
const MONOLITH_OCEAN_ANCHOR = 0.72;
// The crown carries on ABOVE the ridge -- meeting it is the story beat, but
// the structure does not stop there.
const MONOLITH_TOP_FRAC = 0.05;
// How far the final tie line reaches out along the ridge, each way.
const MONOLITH_TIE_REACH = 0.34;

/**
 * Pure: a deterministic plan for the monolith, as many *small* polylines
 * (one birth each) ordered from the waterline upward.
 *
 * @param {number} w canvas width
 * @param {number} h canvas height
 * @param {number} seed
 * @param {number} [count] number of polylines (matches THRESHOLDS)
 */
export function buildMonolithPolylines(w, h, seed, count = RIDGE_GEN_COUNT) {
  const rand = mulberry32((seed ^ 0xde7a11) >>> 0 || 1);

  // The three altitudes the whole structure is hung from.
  const waterY = h * (OCEAN_HORIZON_FRAC
    + MONOLITH_OCEAN_ANCHOR * (OCEAN_NEAR_FRAC - OCEAN_HORIZON_FRAC));
  const ridgeY = h * SPACE_RIDGE_BASELINE_FRAC;
  const topY = h * MONOLITH_TOP_FRAC;

  const cx = w * (0.38 + rand() * 0.24);
  // The scale reveal lives entirely in this progression: SEED is small
  // enough to read as "something roughly ship-sized," not a drawing of one.
  // PLINTH is already past what a ship's footprint could be. GIRTH is the
  // payoff -- by the time the shaft reaches the ridge's altitude it has
  // swollen far past anything nearby could be, before CROWN tapers the very
  // top back down to a needle so it still pierces the sky like a spire
  // rather than staying a wide slab.
  const seedHW = w * 0.011;   // the first, ambiguous mark on the water
  const plinthHW = w * 0.030; // already ~3x the first impression
  const girthHW = w * 0.115;  // the swell -- this is the "it's THAT big" beat
  const crownHW = w * 0.020;  // tapering to a spire above the ridge

  const plans = [];
  // Every piece gets re-jittered so it still reads as fracture in glass
  // rather than a drafted technical line.
  const pushPts = (pts, amp = 3) => {
    plans.push(polylineFromPoints(pts.map((p, i) => (i === 0 || i === pts.length - 1
      ? { x: p.x, y: p.y }
      : { x: p.x + (rand() - 0.5) * amp, y: p.y + (rand() - 0.5) * amp }))));
  };
  const pushChord = (a, b, mids = 2, amp = 5) => {
    plans.push(polylineFromPoints(jaggedChord(a, b, mids, rand, amp)));
  };

  // --- 1. A small, ambiguous mark (pieces 0-2) ----------------------------
  // Rough and small on purpose: two low, irregular bumps and a short stub,
  // jittered hard relative to their own size so nothing here reads as a
  // clean hull curve or a technical mast line. Roughly ship-sized, never
  // confirmed as a ship.
  const stubY = waterY - h * 0.02;
  pushPts([
    { x: cx - seedHW, y: waterY },
    { x: cx - seedHW * 0.5, y: waterY + h * 0.005 },
    { x: cx + seedHW * 0.3, y: waterY + h * 0.006 },
    { x: cx + seedHW, y: waterY },
  ], 3.5);
  pushPts([
    { x: cx - seedHW * 0.7, y: waterY },
    { x: cx - seedHW * 0.3, y: waterY - h * 0.009 },
    { x: cx + seedHW * 0.5, y: waterY - h * 0.007 },
  ], 3);
  pushChord({ x: cx + seedHW * 0.1, y: waterY - h * 0.006 }, { x: cx, y: stubY }, 1, 3);

  // --- 2. Already bigger than that (pieces 3-5) ---------------------------
  const plinthY = waterY - h * 0.075;
  pushChord({ x: cx - seedHW, y: waterY }, { x: cx - plinthHW, y: plinthY }, 3, 5);
  pushChord({ x: cx + seedHW, y: waterY }, { x: cx + plinthHW, y: plinthY }, 3, 5);
  pushChord({ x: cx - plinthHW, y: plinthY }, { x: cx + plinthHW, y: plinthY }, 2, 3);

  // --- 3. The shaft climbs, swelling (pieces 6-11) ------------------------
  // Three courses, each a left edge then a right edge, walking the structure
  // from the plinth up to the ridge's own altitude -- widening from plinth
  // width to full GIRTH as it goes, so the last course arrives at the
  // ridge already dwarfing anything the first mark could have been. Each
  // edge ends on a short inward course-tick, so banding accumulates with
  // height for free.
  const COURSES = 3;
  for (let c = 0; c < COURSES; c++) {
    const y0 = lerp(plinthY, ridgeY, c / COURSES);
    const y1 = lerp(plinthY, ridgeY, (c + 1) / COURSES);
    const hw0 = lerp(plinthHW, girthHW, c / COURSES);
    const hw1 = lerp(plinthHW, girthHW, (c + 1) / COURSES);
    for (const side of [-1, 1]) {
      const edge = jaggedChord(
        { x: cx + side * hw0, y: y0 },
        { x: cx + side * hw1, y: y1 },
        3, rand, 4,
      );
      edge.push({ x: cx + side * hw1 * 0.45, y: y1 - h * 0.004 });
      pushPts(edge, 0);
    }
  }

  // --- 4. The crown, out past the ridge (pieces 12-14) --------------------
  // Tapers back down from the full GIRTH swell to a spire tip -- still
  // reads as impossibly large (it just crossed the ridge at full width),
  // but narrows so it pierces the sky rather than staying a wide slab.
  pushChord({ x: cx - girthHW, y: ridgeY }, { x: cx - crownHW * 0.72, y: topY }, 3, 4);
  pushChord({ x: cx + girthHW, y: ridgeY }, { x: cx + crownHW * 0.72, y: topY }, 3, 4);
  pushChord({ x: cx - crownHW * 0.72, y: topY }, { x: cx + crownHW * 0.72, y: topY }, 2, 3);

  // --- 5. It connects (piece 15) -----------------------------------------
  // The last birth of the song meets SpaceRidge's underside (BASELINE_FRAC),
  // below its moving musical crest: the monolith becomes part of the immense
  // filled structure without chasing its notes.
  pushPts([
    { x: cx - w * MONOLITH_TIE_REACH, y: ridgeY + h * 0.012 },
    { x: cx - girthHW, y: ridgeY },
    { x: cx + girthHW, y: ridgeY },
    { x: cx + w * MONOLITH_TIE_REACH, y: ridgeY + h * 0.012 },
  ], 4);

  // Pad only if a caller asks for more generations than the script provides:
  // faint interior striations up the shaft.
  while (plans.length < count) {
    const f = (plans.length * 0.37) % 1;
    const xo = (rand() - 0.5) * girthHW * 1.2;
    pushChord(
      { x: cx + xo, y: lerp(plinthY, ridgeY, f) },
      { x: cx + xo * 0.7, y: lerp(plinthY, ridgeY, Math.min(1, f + 0.18)) },
      2, 3,
    );
  }
  return plans.slice(0, count);
}

// Branch density. This was tuned when the plan drew a mountain RANGE, where
// diagonal spurs read as couloirs running off a ridge. Against the monolith
// they read as noise: they spray off a structure whose whole legibility is
// its clean vertical silhouette, and at the ship stage a single long diagonal
// is enough to stop the hull reading as a hull. Kept non-zero so each piece
// is still visibly fracture in glass rather than a drafted outline.
const BRANCH_CHANCE = 0.05;

/**
 * Attach subtle branch cracks along a polyline so it still reads as glass
 * fracture, not a single stroked outline.
 */
function attachRidgeBranches(poly, rand, maxDepth = 1, depth = 0) {
  if (depth >= maxDepth || poly.nodes.length < 3) return poly;
  const children = [];
  let arc = 0;
  for (let i = 0; i < poly.lengths.length; i++) {
    arc += poly.lengths[i];
    if (rand() > BRANCH_CHANCE) continue; // keep the silhouette whisper-quiet
    const origin = poly.nodes[i + 1];
    const prev = poly.nodes[i];
    const heading = (Math.atan2(origin.y - prev.y, origin.x - prev.x) * 180) / Math.PI;
    const side = rand() < 0.5 ? -1 : 1;
    const branchHeading = heading + side * (40 + rand() * 35);
    // Branches tend downhill (positive y) like couloirs off a ridge.
    const downBias = side * 0 + 25 * (0.5 + rand());
    const hdg = branchHeading + downBias * 0.3;
    const segs = 2 + Math.floor(rand() * 3);
    const nodes = [origin];
    let hh = hdg;
    const lengths = [];
    let total = 0;
    for (let s = 0; s < segs; s++) {
      const len = 14 + rand() * 22;
      hh += rand() * 36 - 18;
      const rad = (hh * Math.PI) / 180;
      const p = nodes[nodes.length - 1];
      nodes.push({ x: p.x + Math.cos(rad) * len, y: p.y + Math.sin(rad) * len });
      lengths.push(len);
      total += len;
    }
    const child = attachRidgeBranches(
      { nodes, lengths, total, children: [] },
      rand,
      maxDepth,
      depth + 1,
    );
    child.parentArcFraction = arc / Math.max(poly.total, 1e-6);
    children.push(child);
  }
  poly.children = children;
  return poly;
}

function assignBirthTimes(crack, birthMs) {
  crack.birthMs = birthMs;
  for (const child of crack.children || []) {
    assignBirthTimes(child, birthMs + GROW_MS * (child.parentArcFraction ?? 0));
  }
}

function collectNodes(crack, out) {
  for (const n of crack.nodes) out.push(n);
  for (const c of crack.children || []) collectNodes(c, out);
}

function drawRevealedPolyline(ctx, nodes, lengths, total, revealLen, glow = true, alphaMul = 1) {
  if (revealLen <= 0 || total <= 0) return;
  const pts = [nodes[0]];
  let acc = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (acc + lengths[i] <= revealLen) { pts.push(nodes[i + 1]); acc += lengths[i]; }
    else {
      const f = (revealLen - acc) / lengths[i];
      const a = nodes[i], b = nodes[i + 1];
      pts.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      break;
    }
  }
  // Hairline glass stroke — subtle enough to read as frost, not scaffolding.
  if (glow) {
    ctx.strokeStyle = '#9fd9ff';
    ctx.globalAlpha = 0.07 * alphaMul;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
      else ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = '#ffffff';
  ctx.globalAlpha = 0.22 * alphaMul;
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const segLen = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const wStart = lerp(0.95, 0.3, s / total);
    s += segLen;
    const wEnd = lerp(0.95, 0.3, Math.min(1, s / total));
    ctx.lineWidth = (wStart + wEnd) / 2;
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
}

function drawCrackTree(ctx, crack, nowMs, glow = true) {
  const t = clamp01((nowMs - crack.birthMs) / GROW_MS);
  const eased = 1 - (1 - t) ** 3;
  drawRevealedPolyline(ctx, crack.nodes, crack.lengths, crack.total, crack.total * eased, glow);
  for (const child of crack.children || []) {
    if (nowMs >= child.birthMs) drawCrackTree(ctx, child, nowMs, glow);
  }
}

/** Pure fade envelope for the shatter: hold full, then smoothstep down. */
export function shatterFadeAlpha(ageMs) {
  if (ageMs < FADE_START_MS) return 1;
  return 1 - smoothstep(FADE_START_MS, SHATTER_TOTAL_MS, ageMs);
}

/** Pure motion ease: 0 during freeze hold, then ease-out to 1. */
export function shatterMotionU(ageMs) {
  if (ageMs < FREEZE_HOLD_MS) return 0;
  return smoothstep(FREEZE_HOLD_MS, FREEZE_HOLD_MS + SHATTER_BURST_MS, ageMs);
}

export class FractureEngine {
  constructor(conductor, { canvasWidth, canvasHeight, songSeed, durationMs, energyCurves = null, analyzedThroughMs = null }) {
    this.conductor = conductor;
    this.w = canvasWidth;
    this.h = canvasHeight;
    this.songSeed = songSeed;
    this.durationMs = durationMs;

    this.impactStress = 0;
    this._barAccum = 0;
    this._barSamples = 0;
    this._barEnergyHistory = [];
    this.stress = 0;
    this._nextThresholdIdx = 0;
    this._pendingBirths = [];
    this.cracks = [];
    this.surfaceCracks = []; // transient punch-through bursts (see spawnSurfaceCrack)
    this._surfaceCrackSeed = 0;

    // Precomputed monolith plan, ordered waterline-upward — progressive
    // births walk it across the whole song (one small piece per stress
    // threshold), so the structure rises as the track plays.
    this._monolithPlan = buildMonolithPolylines(this.w, this.h, songSeed, THRESHOLDS.length);

    this.flashAlpha = 0;
    // The Reel (Movement VI): set externally, persisted accessibility
    // toggle -- same field name/contract as BiomeManager.reducedFlash.
    this.reducedFlash = false;

    this.shatterState = 'idle'; // idle | about-to-freeze | frozen | done
    this.freezeMs = null;
    this.freezeFrame = null;
    this.fragments = new ObjectPool(() => ({}), (o, i) => Object.assign(o, i), 256);
    this._flashFired = false;
    // One-shot flags for Simulation / main (audio silence, etc.).
    this.justEnteredFinale = false;
    this.audioSilenced = false;

    // Musical finale: last impact note + late build peak (not silence pad).
    this.finale = analyzeSongFinale(
      conductor.timeline || [],
      durationMs,
      energyCurves,
      { analyzedThroughMs },
    );
    // about-to-freeze arms this far before freezeAtMs (last impact + ε).
    this._freezeArmMs = Math.max(0, this.finale.freezeAtMs - FREEZE_LEAD_MS);

    // conductor outlives every song (see main.js); dispose() must undo this
    // or a replay stacks a fresh FractureEngine's listener on top of every
    // previous one still firing.
    this._unsub = [conductor.onBar(() => {
      const e = this._barSamples > 0 ? this._barAccum / this._barSamples : 0;
      this._barEnergyHistory.push(e);
      if (this._barEnergyHistory.length > 8) this._barEnergyHistory.shift();
      this._barAccum = 0;
      this._barSamples = 0;
    })];
  }

  /** Undo the conductor subscription made at construction. */
  dispose() {
    for (const unsub of this._unsub) unsub();
    this._unsub.length = 0;
  }

  registerImpact(I) {
    this.impactStress = Math.min(1, this.impactStress + 0.02 * I);
  }

  /** A small, quick-fading crack burst radiating from (screenX, screenY) --
   *  the pane visibly taking a hit where Broshi's burrow punches through it
   *  (dig-in and eruption). Independent of the permanent ridge cracks: never
   *  added to `this.cracks`, so it never reaches the finale triangulation. */
  spawnSurfaceCrack(screenX, screenY, camera) {
    if (this.shatterState !== 'idle' && this.shatterState !== 'about-to-freeze') return;
    const rand = mulberry32(hashSeed(`${this.songSeed}:surface:${this._surfaceCrackSeed++}`));
    const legs = SURFACE_CRACK_LEGS_MIN + Math.floor(rand() * (SURFACE_CRACK_LEGS_MAX - SURFACE_CRACK_LEGS_MIN + 1));
    const trees = [];
    for (let i = 0; i < legs; i++) {
      const ang = (i / legs) * Math.PI * 2 + rand() * 0.7;
      const len = 24 + rand() * 30;
      const b = { x: screenX + Math.cos(ang) * len, y: screenY + Math.sin(ang) * len };
      trees.push(polylineFromPoints(jaggedChord({ x: screenX, y: screenY }, b, 2, rand, 4)));
    }
    this.surfaceCracks.push({ trees, bornMs: this._lastNowMs ?? 0 });
    if (this.surfaceCracks.length > MAX_SURFACE_CRACKS) this.surfaceCracks.shift();
    if (camera) camera.shake(1.4);
  }

  update(nowMs, dtSec, energyCurves, camera) {
    this._lastNowMs = nowMs;
    if (this.surfaceCracks.length) {
      this.surfaceCracks = this.surfaceCracks.filter((c) => nowMs - c.bornMs < SURFACE_CRACK_LIFE_MS);
    }
    if (this.shatterState === 'frozen' || this.shatterState === 'done') {
      this._updateShatter(nowMs, dtSec);
      return;
    }

    const gInstant = energyCurves ? energyCurves.globalEnergy(nowMs, FLAT_WEIGHTS) : 0;
    this._barAccum += gInstant;
    this._barSamples++;
    const eBar = this._barEnergyHistory.length
      ? this._barEnergyHistory.reduce((a, b) => a + b, 0) / this._barEnergyHistory.length
      : 0;

    // Mostly linear song progress so ridge pieces birth evenly from ~4% to
    // ~92% of the track. Energy and impacts only nudge timing slightly —
    // they no longer clump all cracks into the loud final third.
    // Progress is relative to musical freeze (last impact), not silence pad.
    const musicalDur = Math.max(1, this.finale.freezeAtMs || this.durationMs || 1);
    const tNorm = clamp01(nowMs / musicalDur);
    // Late build-up peak slightly accelerates crack birth near the climax.
    const peakBoost = 0.10 * buildPeakProgress(nowMs, this.finale.buildPeakMs);
    this.stress = clamp(0.88 * tNorm + 0.08 * eBar + 0.12 * this.impactStress + peakBoost, 0, 1);

    while (this._nextThresholdIdx < THRESHOLDS.length && this.stress >= THRESHOLDS[this._nextThresholdIdx]) {
      const generation = this._nextThresholdIdx;
      this._nextThresholdIdx++;
      const nearestKick = this.conductor.nearestEventMs((e) => e.role === Role.RHYTHM && e.kick, nowMs, KICK_SYNC_WINDOW_MS);
      const birthMs = nearestKick ? Math.max(nowMs, nearestKick.tMs) : nowMs;
      this._pendingBirths.push({ generation, birthMs });
    }

    for (let i = this._pendingBirths.length - 1; i >= 0; i--) {
      const pb = this._pendingBirths[i];
      if (nowMs >= pb.birthMs) {
        this._birthCrack(pb.generation, pb.birthMs, camera);
        this._pendingBirths.splice(i, 1);
      }
    }

    this.flashAlpha = Math.max(0, this.flashAlpha - dtSec / 0.04);
    this.justEnteredFinale = false;

    // Freeze arms on the last impact notes — not after empty duration padding.
    if (this.shatterState === 'idle' && this._freezeArmMs >= 0 && nowMs >= this._freezeArmMs) {
      this.shatterState = 'about-to-freeze';
      this.justEnteredFinale = true;
    }
  }

  _birthCrack(generation, birthMs, camera) {
    const rand = mulberry32(hashSeed(`${this.songSeed}:crack:${generation}`));
    const plan = this._monolithPlan[generation] || this._monolithPlan[this._monolithPlan.length - 1];
    // Clone plan geometry so birth/grow state is per-instance.
    const tree = attachRidgeBranches({
      nodes: plan.nodes.map((n) => ({ x: n.x, y: n.y })),
      lengths: plan.lengths.slice(),
      total: plan.total,
      children: [],
    }, rand, 1, 0);
    assignBirthTimes(tree, birthMs);
    this.cracks.push(tree);
    // Barely-there birth cue — no white-out, minimal shake.
    this.flashAlpha = 0.12;
    if (camera) camera.shake(1.2);
  }

  draw(ctx, canvas, { glow = true } = {}) {
    if (this.shatterState === 'frozen' || this.shatterState === 'done') return;
    ctx.save();
    for (const crack of this.cracks) drawCrackTree(ctx, crack, this._lastNowMs ?? 0, glow);
    this._drawSurfaceCracks(ctx, glow);
    if (this.flashAlpha > 0.01) {
      ctx.globalAlpha = capFlashAlpha(this.flashAlpha * 0.12, this.reducedFlash);
      ctx.fillStyle = '#cfefff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.restore();
  }

  _drawSurfaceCracks(ctx, glow) {
    if (!this.surfaceCracks.length) return;
    const nowMs = this._lastNowMs ?? 0;
    for (const sc of this.surfaceCracks) {
      const age = nowMs - sc.bornMs;
      const growU = clamp01(age / SURFACE_CRACK_GROW_MS);
      const eased = 1 - (1 - growU) ** 3;
      const fade = age < SURFACE_CRACK_GROW_MS
        ? 1
        : 1 - smoothstep(SURFACE_CRACK_GROW_MS, SURFACE_CRACK_GROW_MS + SURFACE_CRACK_FADE_MS, age);
      if (fade <= 0.01) continue;
      for (const leg of sc.trees) {
        drawRevealedPolyline(ctx, leg.nodes, leg.lengths, leg.total, leg.total * eased, glow, fade);
      }
    }
  }

  /** Renderer calls this once, right after drawing the frame the freeze should capture. */
  captureFreeze(sourceCanvas, nowMs) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(this.w, this.h) : document.createElement('canvas');
    if (!(c instanceof OffscreenCanvas)) { c.width = this.w; c.height = this.h; }
    const fctx = c.getContext('2d');
    fctx.drawImage(sourceCanvas, 0, 0, this.w, this.h);
    this.freezeFrame = c;
    this.freezeMs = nowMs;
    this.shatterState = 'frozen';
    this._triangulate();
  }

  _triangulate() {
    const nodePoints = [];
    for (const crack of this.cracks) collectNodes(crack, nodePoints);
    const rand = mulberry32(hashSeed(`${this.songSeed}:shatter`));
    // Slightly denser sampling so shards follow ridge density more finely.
    const interior = poissonDiscSample(this.w, this.h, 78, rand);
    const corners = [{ x: 0, y: 0 }, { x: this.w, y: 0 }, { x: this.w, y: this.h }, { x: 0, y: this.h }];
    const points = [
      ...nodePoints.filter((p) => p.x >= 0 && p.x <= this.w && p.y >= 0 && p.y <= this.h),
      ...interior,
      ...corners,
    ];

    const tris = delaunayTriangulate(points);
    const screenCx = this.w / 2, screenCy = this.h / 2;

    for (const t of tris) {
      const a = points[t[0]], b = points[t[1]], c = points[t[2]];
      const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3;
      let dx = cx - screenCx, dy = cy - screenCy;
      const dlen = Math.hypot(dx, dy) || 1;
      dx /= dlen; dy /= dlen;
      // Gentler burst speeds; motion ease multiplies these at runtime.
      const speed = 55 + rand() * 110;
      // Stagger: shards near the main summit (upper-center) move first.
      const peakX = this.w * 0.46, peakY = this.h * 0.18;
      const distPeak = Math.hypot(cx - peakX, cy - peakY);
      const maxDist = Math.hypot(this.w, this.h);
      const startDelayMs = FREEZE_HOLD_MS + distPeak / maxDist * 220;
      this.fragments.spawn({
        tri: [{ x: a.x - cx, y: a.y - cy }, { x: b.x - cx, y: b.y - cy }, { x: c.x - cx, y: c.y - cy }],
        cx, cy, x: cx, y: cy,
        vx0: dx * speed, vy0: dy * speed - 30,
        rot: 0, omega: (rand() * 2 - 1) * 2.2,
        age: 0,
        startDelayMs,
      });
    }
    this._flashFired = false;
  }

  _updateShatter(nowMs, dtSec) {
    const t = nowMs - this.freezeMs;
    this.fragments.step(dtSec, (f) => {
      f.age += dtSec * 1000;
      const localAge = f.age - (f.startDelayMs || 0);
      if (localAge > 0) {
        // Ease motion in: full velocity after SHATTER_BURST_MS of this shard's life.
        const u = smoothstep(0, SHATTER_BURST_MS, localAge);
        const drag = 1 - 0.35 * u; // gentle coast, not constant rocket
        f.x += f.vx0 * u * drag * dtSec;
        f.y += (f.vy0 * u * drag + 420 * u * u) * dtSec; // gravity eases in too
        f.rot += f.omega * u * dtSec;
      }
      return true;
    });

    if (!this._flashFired && t >= FLASH_AT_MS) {
      this._flashFired = true;
      this.flashAlpha = 0.18; // soft kiss, not a hard white frame
    }
    if (this._flashFired) this.flashAlpha = Math.max(0, this.flashAlpha - dtSec / (FLASH_DUR_MS / 1000));

    if (t >= SHATTER_TOTAL_MS && this.shatterState !== 'done') {
      this.shatterState = 'done';
      this.fragments.clear();
    }
  }

  get isFrozen() { return this.shatterState === 'frozen'; }
  get isAboutToFreeze() { return this.shatterState === 'about-to-freeze'; }
  get isDone() { return this.shatterState === 'done'; }

  drawShatter(ctx, canvas) {
    ctx.save();
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const t = (this._lastNowMs ?? this.freezeMs) - this.freezeMs;
    const fadeAlpha = shatterFadeAlpha(t);
    // Slight whole-shard shrink as they fade — eases the dissolve.
    const scale = lerp(1, 0.92, 1 - fadeAlpha);

    for (const f of this.fragments.active) {
      ctx.save();
      ctx.globalAlpha = fadeAlpha;
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      ctx.scale(scale, scale);
      ctx.beginPath();
      ctx.moveTo(f.tri[0].x, f.tri[0].y);
      ctx.lineTo(f.tri[1].x, f.tri[1].y);
      ctx.lineTo(f.tri[2].x, f.tri[2].y);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(this.freezeFrame, -f.cx, -f.cy);
      ctx.restore();
    }

    if (this.flashAlpha > 0.01) {
      // The two full-viewport fills in this class are the only flashes in
      // the game that bypassed capFlashAlpha -- this class didn't even
      // import Accessibility.js, unlike every other module with a flash.
      ctx.globalAlpha = capFlashAlpha(this.flashAlpha, this.reducedFlash);
      ctx.fillStyle = '#e8f4ff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.restore();
  }
}
