// Ambient connect-the-dots: unlike Midasus's rare, ExcursionDirector-gated
// SkyVoyage (at most 2 voyages a song), this weaves constellations out of
// ordinary melody notes for the whole song -- ordinary dots quietly
// connecting into shapes, holding, fading, sometimes crystallizing into
// permanent dim stars. Mirrors MeteorShowerFX's shape: seeded rand, plain
// state, no canvas ownership between calls. Pure position/timing helpers
// (nextDotPos, edgeRevealFrac) are exported so BiomeManager's draw-time
// choices stay testable without touching canvas.
import { mulberry32, clamp01 } from '../utils/math.js';
import { capFlashAlpha } from '../ui/Accessibility.js';
import { placeGlyph } from './LyricGlyph.js';
import { OCEAN_HORIZON_FRAC } from './Ocean.js';

// yMax used to stop at 0.58 -- barely past mid-screen -- and was widened to
// 0.95 on the theory that terrain, drawn after this layer, would occlude
// anything that dipped low. That reasoning doesn't hold for this game's
// actual look: ground-level landmarks (paintLatticeTower and friends,
// Landmarks.js) are drawn as bright STROKED wireframes, not filled
// silhouettes, so they never occlude anything behind them either -- and
// Midio's own groundY sits at 0.75 of the nominal stage, so 0.95 let dots
// land BELOW the ground line outright. The visible result: a figure's own
// lowest dot routinely plants itself right at the grass horizon, and since
// up to 3 figures can be alive at once (MAX_ACTIVE_FIGURES) for ~8 seconds
// each (HOLD_MS + FADE_MS), two of them doing that near the same moment reads
// as exactly the "stars bunched together" complaint this was meant to fix --
// now bunched by both resting on the same ground line instead of by X
// position. That regression got pulled back to 0.58, which killed the ground
// glitch but overcorrected: instrumenting a live 3-minute session (dumping
// every figure's and every crystallized star's own y-fraction) showed 100%
// of ~1600 dots landing between 0.05 and 0.575 -- literally zero dots ever
// below 58% of the frame, for the entire song, every time, by construction.
// Meanwhile actual terrain only peaks around 0.55 in valleys well below
// that; most of the screen's real open sky (roughly 0.58 up to the 0.75
// ground line) was sitting permanently empty. That's a second, independent
// mechanism for the exact same "everything's bunched in the middle"
// complaint: not a positional RNG bug, but every bright figure and star
// being structurally barred from most of the lower sky. Fixed properly this
// time by decoupling "how far down dots may be placed" from "how far down
// they render at full brightness": groundFadeAlpha (below) now fades
// exactly to 0 by yMax instead of flooring at a still-visible 0.15, so
// raising yMax back up to actually use the open sky can never reproduce the
// original grass-line glitch -- anything that drifts toward the new lower
// boundary just fades out first.
// yMax used to be a flat 0.70, tuned against ground-level terrain (Midio's
// own groundY sits at ~0.75, so 0.70 was "just above the grass"). That
// reasoning misses the far ocean (Ocean.js), which sits at the same depth
// as the ranges and starts at OCEAN_HORIZON_FRAC (~0.38) -- well above
// where terrain peaks. Terrain drawn after this layer occludes what it
// occludes, but water occludes nothing: a dot placed between the horizon
// and the ground line sat visibly IN the ocean in any gap between
// mountains, reading as a constellation sticking out of the sea. Sky ends
// at the horizon; nothing here should ever be placed below it.
export const REGION = { xMin: 0.03, xMax: 0.97, yMin: 0.04, yMax: OCEAN_HORIZON_FRAC };
const FIGURE_DOTS_MIN = 5;
const FIGURE_DOTS_MAX = 8;
const EDGE_GROW_MS = 250;
export const STALL_EDGE_MS = 1500;
// Last resort when neither a melody note nor a kick arrives. The ordinary
// stall used to reveal the next edge on this timer alone, which drew a
// bright line on a clock the music was not on. A kick claims it first.
const STALL_SAFETY_MS = 8000;
const HOLD_MS = 5000;
const FADE_MS = 3000;
const MAX_ACTIVE_FIGURES = 3;
// Hard ceiling on tracked figures (holding + fading), independent of the
// graceful per-figure fade -- see the comment at its one use in
// _commitBuilding for why this exists alongside MAX_ACTIVE_FIGURES.
const MAX_TRACKED_FIGURES = MAX_ACTIVE_FIGURES * 3;
const MAX_DOTS = 40;
const MAX_STAR_FIGURES = 6;
const CRYSTALLIZE_CHANCE = 0.45;
const PULSE_TAU_SEC = 0.25;
// Was 3. With lyric glyphs now firing on a line's theme as well as its
// literal nouns, lyrics were still only shaping one figure in four; two
// ordinary figures between symbols keeps them special without being rare.
const GLYPH_COOLDOWN_FIGURES = 2; // figures between glyph-shaped ones
const GLYPH_SIZE_FRAC = 0.18;     // fraction of sky width
// How long a glyph's interior detail strokes take to fade in once the
// outline finishes connecting (fig.holdStartMs). Held back until then
// rather than revealed alongside the outline -- a crack or a mast means
// nothing until the shape it belongs to is already recognizable, so the
// detail reads as confirmation rather than clutter arriving mid-guess.
const INTERIOR_REVEAL_MS = 450;
// Live melody is a handful of notes per second. A conductor catch-up is
// tens of the same notes in one frame. One visual-clock step is enough
// for the former and stops the latter painting a whole sky at once.
export const MELODY_STEPS_PER_UPDATE = 1;

// Terrain is drawn AFTER this layer and clips anything below its silhouette
// with a hard edge (see the REGION comment above). A star-atlas ambient dot
// just vanishes into that clip -- but a figure's edge or a crystallized
// star's polyline is a solid stroke, so a straight line sailing into the
// ground gets guillotined at a dead-flat height and reads as a glitch, not
// an occlusion. Since terrain height varies per song and isn't known here,
// fade every edge/dot toward the bottom of the field on a fixed curve so
// any clip lands on already-near-invisible content instead of a crisp line.
//
// This used to floor at 0.15 (never fully invisible), which is exactly what
// let a dot sitting at the old yMax=0.95 read as "resting on the grass"
// instead of fading away -- a real, visible artifact, not just a clipped
// line. It's the reason yMax got pulled defensively all the way back to
// 0.58 rather than just being trimmed. Tying the fade's endpoint to
// REGION.yMax itself (instead of a fixed denominator) means it always
// reaches true 0 exactly at the region's own lower boundary, so yMax can
// safely sit much closer to the real ground line -- nothing can ever again
// visibly plant itself there, because by definition nothing is visible
// there.
//
// Kept as the same fraction OF yMax it was tuned at (0.55 against the old
// 0.70) rather than the old absolute 0.55, now that yMax itself sits at the
// sea horizon instead of near the ground line -- an absolute 0.55 would sit
// PAST the new, much lower yMax, breaking groundFadeAlpha's own math
// (fading toward an endpoint that's already behind it).
export const GROUND_FADE_START = REGION.yMax * (0.55 / 0.70);
export function groundFadeAlpha(yFrac) {
  return 1 - clamp01((yFrac - GROUND_FADE_START) / (REGION.yMax - GROUND_FADE_START));
}

// Hop distance as a fraction of the field's diagonal, not a fixed pixel
// range: a fixed 40-110px hop produced a figure whose dots stayed within
// ~150px of each other regardless of screen size -- averaging out to only
// ~12-13% of the sky's width. A tight cluster of dots is exactly what reads
// as "the constellations are a chunk," even though REGION itself already
// spans nearly the whole sky (see above) -- the individual FIGURES were the
// chunk, wherever they landed. Scaling by the diagonal instead roughly
// doubles a figure's average span (~19-20% of width) and keeps that
// proportion consistent across any resolution/aspect ratio, matching how
// every other position in this file is stored as a fraction rather than an
// absolute pixel.
const HOP_DIST_FRAC_MIN = 0.05;
const HOP_DIST_FRAC_MAX = 0.11;

/** Seeded next dot position, a hop scaled to the field's diagonal from
 *  `prev` in a drifting direction, reflected back into the upper-sky region
 *  if it would step outside. `prev` null places the first dot anywhere in
 *  the region. Pure. */
export function nextDotPos(prev, rand, w, h) {
  const xMin = REGION.xMin * w, xMax = REGION.xMax * w;
  const yMin = REGION.yMin * h, yMax = REGION.yMax * h;
  if (!prev) return { x: xMin + rand() * (xMax - xMin), y: yMin + rand() * (yMax - yMin) };
  const diag = Math.hypot(w, h);
  const angle = rand() * Math.PI * 2;
  const dist = HOP_DIST_FRAC_MIN * diag + rand() * (HOP_DIST_FRAC_MAX - HOP_DIST_FRAC_MIN) * diag;
  let x = prev.x + Math.cos(angle) * dist;
  let y = prev.y + Math.sin(angle) * dist;
  if (x < xMin) x = xMin + (xMin - x);
  if (x > xMax) x = xMax - (x - xMax);
  if (y < yMin) y = yMin + (yMin - y);
  if (y > yMax) y = yMax - (y - yMax);
  x = Math.max(xMin, Math.min(xMax, x));
  y = Math.max(yMin, Math.min(yMax, y));
  return { x, y };
}

/** How much of a figure's edges are revealed, 0..1, monotone in nowMs: full
 *  edges already revealed plus the currently-growing edge's own progress
 *  (EDGE_GROW_MS line-grow), normalized by the total edge count. Pure. */
export function edgeRevealFrac(figure, nowMs) {
  const totalEdges = Math.max(1, figure.targetCount - 1);
  const partial = clamp01((nowMs - figure.edgeStartMs) / EDGE_GROW_MS);
  return clamp01((figure.edgeRevealedCount + partial) / totalEdges);
}

export class ConstellationWeaver {
  constructor(seed, w, h) {
    this.rand = mulberry32((seed ^ 0x5eed) >>> 0 || 1);
    this.w = w;
    this.h = h;
    this.building = null; // the one figure currently being seeded/connected
    this.figures = [];    // completed figures: holding, then fading
    this.stars = [];      // crystallized, persistent
    this.pulse = 0;
    this._lastNowMs = 0;
    this._pendingGlyph = null;     // { glyphId, deadlineMs } waiting to shape the next figure
    this._glyphCooldown = 0;       // figures remaining before another glyph is allowed
    this.fullness = 0;             // 0..1, driven by BiomeManager (update()) -- relaxes the concurrency/dot caps so the sky can go genuinely dense every now and then, especially late in the song
    // Melody steps are paced by the visual clock. A hitch, a seek, or the
    // conductor catching up can dump tens of notes in one dispatchUpTo; each
    // used to advance a figure, so three constellations would complete on the
    // same frame, hold for five seconds, and vanish together. One step per
    // update keeps live melody (a few notes a second) intact and turns a
    // dump into a single extra dot.
    this._melodyBudget = MELODY_STEPS_PER_UPDATE;
  }

  /** Queue a glyph shape for the next constellation figure, valid only
   *  until `deadlineMs` (song-clock ms; defaults to "no expiry" for callers
   *  that don't care, e.g. tests). A newer call always replaces whatever
   *  was pending -- once the lyric line that earned a hint has been
   *  superseded by the next one, the old hint has nothing left to confirm
   *  and should not get to fire just because it happened to arrive first.
   *
   *  Deliberately does NOT check the glyph cooldown here (that used to
   *  drop a hint on the floor forever if it landed while cooldown was
   *  still counting down, with no way to know that had happened): a hint
   *  is accepted unconditionally, and onMelody below is the one place that
   *  decides whether cooldown allows USING it yet, checking the deadline
   *  fresh each time so a hint that outlives its own line's relevance
   *  expires instead of firing late. */
  hintGlyph(glyphId, deadlineMs = Infinity) {
    this._pendingGlyph = { glyphId, deadlineMs };
  }

  onMelody(evt) {
    if (this._melodyBudget <= 0) return;
    this._melodyBudget--;
    const nowMs = evt.tMs;
    // A pending hint past its deadline belongs to a lyric line the song has
    // already moved on from (played past it, or a seek jumped over it) --
    // drop it here rather than at the next available building slot, so it
    // can never surface stale just because cooldown finally cleared.
    if (this._pendingGlyph && nowMs > this._pendingGlyph.deadlineMs) this._pendingGlyph = null;

    if (!this.building) {
      const hue = (evt.pitch % 12) * 30;

      // If a glyph hint is pending and cooldown allows it, use its shape
      // instead of random dots.
      if (this._pendingGlyph && this._glyphCooldown <= 0) {
        const glyphId = this._pendingGlyph.glyphId;
        this._pendingGlyph = null;
        const size = GLYPH_SIZE_FRAC * this.w;
        const xMin = REGION.xMin * this.w, xMax = REGION.xMax * this.w;
        const yMin = REGION.yMin * this.h, yMax = REGION.yMax * this.h;
        const cx = xMin + this.rand() * (xMax - xMin);
        const cy = yMin + this.rand() * 0.55 * (yMax - yMin);
        const shape = placeGlyph(glyphId, cx, cy, size, { xMin, xMax, yMin, yMax });
        if (shape && shape.outline.length >= 3) {
          this._glyphCooldown = GLYPH_COOLDOWN_FIGURES;
          this.building = {
            dots: shape.outline,
            interior: shape.interior,
            targetCount: shape.outline.length,
            hue,
            phase: 'connecting',
            edgeRevealedCount: 0,
            edgeStartMs: nowMs,
          };
          return;
        }
      }

      const targetCount = FIGURE_DOTS_MIN + Math.floor(this.rand() * (FIGURE_DOTS_MAX - FIGURE_DOTS_MIN + 1));
      this.building = {
        dots: [nextDotPos(null, this.rand, this.w, this.h)],
        interior: [],
        targetCount,
        hue,
        phase: 'seeding',
        edgeRevealedCount: 0,
        edgeStartMs: nowMs,
      };
      return;
    }
    const fig = this.building;
    if (fig.phase === 'seeding') {
      if (fig.dots.length < fig.targetCount) {
        fig.dots.push(nextDotPos(fig.dots[fig.dots.length - 1], this.rand, this.w, this.h));
      }
      if (fig.dots.length >= fig.targetCount) {
        fig.phase = 'connecting';
        fig.edgeRevealedCount = 0;
        fig.edgeStartMs = nowMs;
      }
      return;
    }
    if (fig.phase === 'connecting') {
      this._revealNextEdge(fig, nowMs);
      if (fig.edgeRevealedCount >= fig.targetCount - 1) this._commitBuilding(nowMs);
    }
  }

  onKick(vel, nowMs = this._lastNowMs) {
    this.pulse = Math.max(this.pulse, clamp01(vel));
    this._advanceStalledEdge(nowMs);
  }

  // A melody rest used to grow the next edge 1.5s later, wherever that
  // fell in the bar. Drums are still playing in that rest far more often
  // than the whole band is silent, so the edge waits for the next kick
  // and lands on it. The safety in update() only fires if no kick comes.
  _advanceStalledEdge(nowMs) {
    const fig = this.building;
    if (!fig || fig.phase !== 'connecting') return;
    if (!(nowMs - fig.edgeStartMs > STALL_EDGE_MS)) return;
    this._revealNextEdge(fig, nowMs);
    if (fig.edgeRevealedCount >= fig.targetCount - 1) this._commitBuilding(nowMs);
  }

  _revealNextEdge(fig, nowMs) {
    if (fig.edgeRevealedCount >= fig.targetCount - 1) return;
    fig.edgeRevealedCount++;
    fig.edgeStartMs = nowMs;
  }

  // Retiring a figure used to be `this.figures.shift()`: an outgoing figure
  // simply vanished from the array on the very next frame, no matter what
  // phase it was in -- a fully-drawn constellation could be present one
  // frame and gone the next, reading as a glitch rather than a night sky
  // losing a shape. Retiring it now means handing it to the SAME fading
  // state a figure enters on its own after HOLD_MS: the existing draw-time
  // fade (holdOrFadeFrac in draw(), over FADE_MS) then carries it out
  // gradually like every other figure that dies of old age, so there is
  // only ever one way a figure leaves the sky.
  _retire(fig, nowMs) {
    if (fig.phase !== 'fading') {
      fig.phase = 'fading';
      fig.fadeStartMs = nowMs;
    }
  }

  _commitBuilding(nowMs) {
    const fig = this.building;
    fig.phase = 'holding';
    fig.holdStartMs = nowMs;
    // fullness (0..1) relaxes how many figures may hold on screen at once --
    // the sky periodically (and especially late in the song) earns a denser
    // cap instead of always thinning back down to the same three.
    const maxActive = MAX_ACTIVE_FIGURES + Math.round(this.fullness * 3);
    const holding = this.figures.filter((f) => f.phase === 'holding');
    if (holding.length >= maxActive) this._retire(holding[0], nowMs);
    this.figures.push(fig);
    // Safety net: a fading figure normally still lingers up to FADE_MS after
    // being retired above, which is the whole point (a graceful exit instead
    // of vanishing), but a sustained onset spam can complete new figures
    // faster than FADE_MS drains old ones, so the tracked list would grow
    // without bound. Past this many tracked figures (holding + still-fading)
    // drop the single oldest outright rather than let memory grow -- this
    // never engages during ordinary play, only under spam far outside any
    // real melody's onset rate.
    if (this.figures.length > MAX_TRACKED_FIGURES) this.figures.shift();
    this.building = null;
    if (this._glyphCooldown > 0) this._glyphCooldown--;
    this._enforceDotCap(nowMs);
  }

  _enforceDotCap(nowMs) {
    const maxDots = MAX_DOTS + Math.round(this.fullness * 30);
    let total = this.building ? this.building.dots.length : 0;
    for (const f of this.figures) total += f.dots.length;
    while (total > maxDots) {
      const target = this.figures.find((f) => f.phase !== 'fading');
      if (!target) break; // everything left is already on its way out
      total -= target.dots.length;
      this._retire(target, nowMs);
    }
  }

  update(nowMs, dtSec, fullness = 0) {
    this._lastNowMs = nowMs;
    this._melodyBudget = MELODY_STEPS_PER_UPDATE;
    this.fullness = clamp01(fullness);
    this.pulse *= Math.exp(-dtSec / PULSE_TAU_SEC);

    if (this.building && this.building.phase === 'connecting'
        && nowMs - this.building.edgeStartMs > STALL_SAFETY_MS) {
      this._advanceStalledEdge(nowMs);
    }

    for (const f of this.figures) {
      if (f.phase === 'holding' && nowMs - f.holdStartMs > HOLD_MS) {
        f.phase = 'fading';
        f.fadeStartMs = nowMs;
      }
    }
    const survivors = [];
    for (const f of this.figures) {
      if (f.phase === 'fading' && nowMs - f.fadeStartMs > FADE_MS) {
        if (this.rand() < CRYSTALLIZE_CHANCE) {
          if (this.stars.length >= MAX_STAR_FIGURES) this.stars.shift();
          this.stars.push({
            dots: f.dots.map((d) => ({ x: d.x, y: d.y, phase: this.rand() * Math.PI * 2 })),
            hue: f.hue,
          });
        }
        continue; // drop
      }
      survivors.push(f);
    }
    this.figures = survivors;
  }

  draw(ctx, canvas, reducedFlash = false, alphaMul = 1, presentation = 1, maxHolding = 0,
    { maxFigures = Infinity, maxRetained = Infinity, allowPoint = () => true } = {}) {
    ctx.save();
    const inherited = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
    const present = Number.isFinite(presentation) ? Math.min(1, Math.max(0, presentation)) : 1;
    ctx.globalAlpha = inherited * present;
    ctx.globalCompositeOperation = 'lighter';

    // Dots are generated (nextDotPos) in this.w x this.h field space. A
    // camera pull-back or a canvas resize after construction means the
    // ACTUAL canvas handed to draw() is often a different size -- exactly
    // the mismatch StarCatalogue's xFrac/yFrac rescale already solves for
    // the ambient field. Without this, every dot stayed pinned to its
    // original span while the sky around it widened, shrinking every
    // constellation and every crystallized star into a box in one corner
    // of the real frame instead of the region they were actually seeded
    // across.
    const sx = canvas.width / this.w, sy = canvas.height / this.h;

    // Crystallized stars: dim and persistent, atlas-style. alphaMul lets
    // the night sky brighten them without touching the active figures
    // below (those are event-driven, not ambient starlight).
    const retained = maxRetained === 0 ? []
      : Number.isFinite(maxRetained) ? this.stars.slice(-maxRetained) : this.stars;
    for (const star of retained) {
      ctx.lineWidth = 0.8;
      for (let i = 0; i < star.dots.length - 1; i++) {
        const a = star.dots[i], b = star.dots[i + 1];
        if (!allowPoint(a.x * sx, a.y * sy) || !allowPoint(b.x * sx, b.y * sy)
          || !allowPoint((a.x + b.x) * sx / 2, (a.y + b.y) * sy / 2)) continue;
        const fade = groundFadeAlpha(Math.max(a.y, b.y) / this.h);
        ctx.strokeStyle = `hsla(${star.hue}, 32%, 80%, ${capFlashAlpha(0.07 * alphaMul * fade, reducedFlash)})`;
        ctx.beginPath();
        ctx.moveTo(a.x * sx, a.y * sy);
        ctx.lineTo(b.x * sx, b.y * sy);
        ctx.stroke();
      }
      for (const s of star.dots) {
        if (!allowPoint(s.x * sx, s.y * sy)) continue;
        const fade = groundFadeAlpha(s.y / this.h);
        ctx.fillStyle = `hsla(${star.hue}, 40%, 86%, ${capFlashAlpha(0.14 * alphaMul * fade, reducedFlash)})`;
        ctx.beginPath();
        ctx.arc(s.x * sx, s.y * sy, 1.0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    let holdingDrawn = 0;
    const limited = Number.isFinite(maxFigures)
      ? (this.building ? [this.building] : []).concat(this.figures.slice().reverse()).slice(0, maxFigures)
      : this.figures;
    for (const fig of limited) {
      if (maxHolding > 0 && fig.phase === 'holding') {
        if (holdingDrawn >= maxHolding) continue;
        holdingDrawn += 1;
      }
      const holdOrFadeFrac = fig.phase === 'fading'
        ? 1 - clamp01((this._lastNowMs - fig.fadeStartMs) / FADE_MS)
        : 1;
      this._drawFigure(ctx, fig, this._lastNowMs, holdOrFadeFrac, reducedFlash, sx, sy, allowPoint);
    }
    if (!Number.isFinite(maxFigures) && this.building) this._drawFigure(ctx, this.building, this._lastNowMs, 1, reducedFlash, sx, sy, allowPoint);

    ctx.restore();
  }

  _drawFigure(ctx, fig, nowMs, lifeAlpha, reducedFlash, sx = 1, sy = 1, allowPoint = () => true) {
    const pulseBoost = 1 + 1.2 * this.pulse;
    const frac = edgeRevealFrac(fig, nowMs);
    const edgeCount = fig.dots.length - 1;
    if (edgeCount > 0) {
      const revealedEdges = frac * edgeCount;
      for (let i = 0; i < edgeCount; i++) {
        const edgeAlpha = clamp01(revealedEdges - i);
        if (edgeAlpha <= 0) break;
        const a = fig.dots[i], b = fig.dots[i + 1];
        const ax = a.x * sx, ay = a.y * sy, bx = b.x * sx, by = b.y * sy;
        const x = ax + (bx - ax) * edgeAlpha, y = ay + (by - ay) * edgeAlpha;
        if (!allowPoint(ax, ay) || !allowPoint(x, y) || !allowPoint((ax + x) / 2, (ay + y) / 2)) continue;
        const fade = groundFadeAlpha(Math.max(a.y, b.y) / this.h);
        for (const [lw, base] of [[3, 0.08], [1, 0.30]]) {
          ctx.strokeStyle = `hsla(${fig.hue}, 60%, 82%, ${capFlashAlpha(base * lifeAlpha * pulseBoost * fade, reducedFlash)})`;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
      }
    }
    for (let i = 0; i < fig.dots.length; i++) {
      const d = fig.dots[i];
      const dx = d.x * sx, dy = d.y * sy;
      if (!allowPoint(dx, dy)) continue;
      const fade = groundFadeAlpha(d.y / this.h);
      ctx.fillStyle = `hsla(${fig.hue}, 70%, 88%, ${capFlashAlpha(0.5 * lifeAlpha * pulseBoost * fade, reducedFlash)})`;
      ctx.beginPath();
      ctx.arc(dx, dy, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `hsla(${fig.hue}, 40%, 90%, ${capFlashAlpha(0.12 * lifeAlpha * fade, reducedFlash)})`;
      ctx.beginPath();
      ctx.arc(dx, dy, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Interior detail strokes (LyricGlyph.js's `interior`): separate
    // polylines, each its own pen-down/pen-up, revealed together once the
    // outline itself has fully connected (fig.holdStartMs set) rather than
    // a still-forming figure's guessed outline gaining detail it hasn't
    // earned yet. A plain dot-chain figure has none of these -- the loop
    // below is a silent no-op for it.
    if (fig.interior && fig.interior.length && fig.holdStartMs != null) {
      const interiorAlpha = clamp01((nowMs - fig.holdStartMs) / INTERIOR_REVEAL_MS);
      if (interiorAlpha > 0) {
        for (const stroke of fig.interior) {
          for (let i = 0; i < stroke.length - 1; i++) {
            const a = stroke[i], b = stroke[i + 1];
            const ax = a.x * sx, ay = a.y * sy, bx = b.x * sx, by = b.y * sy;
            if (!allowPoint(ax, ay) || !allowPoint(bx, by) || !allowPoint((ax + bx) / 2, (ay + by) / 2)) continue;
            const fade = groundFadeAlpha(Math.max(a.y, b.y) / this.h);
            ctx.strokeStyle = `hsla(${fig.hue}, 55%, 84%, ${capFlashAlpha(0.22 * lifeAlpha * pulseBoost * fade * interiorAlpha, reducedFlash)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          }
        }
      }
    }
  }
}
