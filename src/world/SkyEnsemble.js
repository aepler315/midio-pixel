// The sky gets company: seeded planets hanging in each biome's heavens,
// and a schedule of rare astral artifacts -- a comet crossing, a moon
// eclipsing a planet, a satellite blinking by, an aurora ribbon, a pair of
// shooting stars. Planets are per-(song, biome) deterministic so a world
// keeps its sky; artifacts are per-song deterministic so replays of a file
// have the same cosmos on the same bars.
//
// Everything here draws BEFORE the celestial/mandala (BiomeManager.draw),
// so the sun/moon and the mountain ranges occlude it naturally -- these are
// background astronomy, never foreground fireworks.
import { mulberry32, hashSeed, clamp01 } from '../utils/math.js';
import { hexLerp } from '../utils/color.js';
import { capFlashAlpha } from '../ui/Accessibility.js';

const ARTIFACT_KINDS = ['comet', 'eclipse', 'satellite', 'auroraRibbon', 'starPair'];
const ARTIFACT_MIN_GAP_MS = 22000;
const ARTIFACT_GAP_SPAN_MS = 26000; // gaps land in [22s, 48s)
const ARTIFACT_FIRST_MS = 14000;    // let the world introduce itself first
const PLANET_KINDS = ['banded', 'ringed', 'cratered', 'crescent'];

/** Deterministic planet placements for one biome's sky. Kept clear of the
 *  celestial's corner (x ~0.78) so the sun/moon never gets crowded. */
export function planetsFor(songSeed, biomeName) {
  const rand = mulberry32(hashSeed(`${songSeed}:planets:${biomeName}`));
  const count = 1 + Math.floor(rand() * 3); // 1..3
  const planets = [];
  for (let i = 0; i < count; i++) {
    planets.push({
      xFrac: 0.05 + rand() * 0.56,          // left/central sky only
      yFrac: 0.05 + rand() * 0.24,
      r: 9 + rand() * 17,
      kind: PLANET_KINDS[Math.floor(rand() * PLANET_KINDS.length)],
      tilt: (rand() - 0.5) * 0.9,           // ring/band inclination
      mix: 0.3 + rand() * 0.4,              // silhouette<->sky color balance
      phase: rand() * Math.PI * 2,          // drift/glow phase
    });
  }
  return planets;
}

/** The whole song's artifact schedule: [{startMs, durMs, kind, seed}] --
 *  non-overlapping by construction (gap >= ARTIFACT_MIN_GAP_MS > any dur). */
export function buildArtifactSchedule(songSeed, durationMs) {
  const rand = mulberry32(hashSeed(`${songSeed}:artifacts`));
  const events = [];
  let t = ARTIFACT_FIRST_MS + rand() * 8000;
  while (t < Math.max(0, durationMs - 6000)) {
    events.push({
      startMs: t,
      durMs: 4000 + rand() * 5000,
      kind: ARTIFACT_KINDS[Math.floor(rand() * ARTIFACT_KINDS.length)],
      seed: Math.floor(rand() * 0xffffffff),
    });
    t += ARTIFACT_MIN_GAP_MS + rand() * ARTIFACT_GAP_SPAN_MS;
  }
  return events;
}

export class SkyEnsemble {
  constructor(songSeed, durationMs) {
    this.songSeed = songSeed;
    this.schedule = buildArtifactSchedule(songSeed, durationMs || 0);
    this._planetCache = new Map(); // biomeName -> planets
    this._cursor = 0;
  }

  _planets(biomeName) {
    let p = this._planetCache.get(biomeName);
    if (!p) {
      p = planetsFor(this.songSeed, biomeName);
      this._planetCache.set(biomeName, p);
    }
    return p;
  }

  /** The artifact active at nowMs, or null. Monotonic cursor for the
   *  ordinary forward-moving clock; a backward clock jump (a future
   *  seek/loop feature -- unreachable today) rewinds instead of silently
   *  skipping every remaining artifact for the rest of the run. */
  activeArtifact(nowMs) {
    // The frontier is the end of the last window we advanced past; a clock
    // at or before it means time moved backwards -- re-walk from the top.
    if (this._cursor > 0) {
      const prev = this.schedule[this._cursor - 1];
      if (nowMs <= prev.startMs + prev.durMs) this._cursor = 0;
    }
    while (this._cursor < this.schedule.length && nowMs > this.schedule[this._cursor].startMs + this.schedule[this._cursor].durMs) {
      this._cursor++;
    }
    const a = this.schedule[this._cursor];
    return a && nowMs >= a.startMs ? a : null;
  }

  /**
   * Draw planets (both blend profiles, crossfaded like the celestial) and
   * the active artifact. `colors` = already palette-rotated hex strings
   * {skyMid, silhouette, halo}; `groove` breathes the planet halos.
   */
  draw(ctx, canvas, nowMs, {
    fromName, toName, t = 0, colors, tSec = 0, groove = 0, reducedFlash = false,
    presentation = 1, maxPlanets = Infinity,
  } = {}) {
    const inherited = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
    const present = Number.isFinite(presentation) ? Math.min(1, Math.max(0, presentation)) : 1;
    const paint = inherited * present;
    const cap = Number.isFinite(maxPlanets) ? maxPlanets : Infinity;
    if (toName === fromName) {
      this._drawPlanetSet(ctx, canvas, this._planets(fromName), 1, colors, tSec, groove, paint, cap);
    } else {
      const outW = 1 - t;
      const inW = t;
      const sum = outW + inW || 1;
      this._drawPlanetSet(ctx, canvas, this._planets(fromName), outW / sum, colors, tSec, groove, paint, cap);
      this._drawPlanetSet(ctx, canvas, this._planets(toName), inW / sum, colors, tSec, groove, paint, cap);
    }

    const a = this.activeArtifact(nowMs);
    if (!a) return;
    const u = clamp01((nowMs - a.startMs) / a.durMs);
    // Ease the whole artifact in and out so nothing pops into the sky.
    const env = Math.sin(Math.PI * u) ** 0.7;
    switch (a.kind) {
      case 'comet': this._drawComet(ctx, canvas, u, env, a.seed, colors, paint); break;
      case 'eclipse': this._drawEclipse(ctx, canvas, u, env, this._planets(t > 0.5 ? toName : fromName), colors, paint); break;
      case 'satellite': this._drawSatellite(ctx, canvas, u, env, a.seed, tSec, paint); break;
      case 'auroraRibbon': this._drawAuroraRibbon(ctx, canvas, u, env, a.seed, tSec, colors, paint); break;
      case 'starPair': this._drawStarPair(ctx, canvas, u, env, a.seed, reducedFlash, paint); break;
      default: break;
    }
  }

  /** Colors + the limb-shading gradient are cached per planet, keyed on the
   *  (already palette-rotated) color triple: rebuilding a CanvasGradient
   *  and two hexLerp strings per planet at 60-120fps was the diff's only
   *  steady per-frame allocation churn, and planets only actually change
   *  color when the palette does. The gradient is authored in planet-LOCAL
   *  coordinates (under a translate) precisely so it can be reused while
   *  the planet's sub-pixel drift moves it around. */
  _planetColors(ctx, p, colors) {
    const key = `${colors.silhouette}|${colors.skyMid}|${colors.halo}`;
    if (!p._cc || p._cc.key !== key) {
      const body = hexLerp(colors.silhouette, colors.skyMid, p.mix);
      const lit = hexLerp(body, colors.halo, 0.35);
      const grad = ctx.createRadialGradient(p.r * 0.45, -p.r * 0.4, p.r * 0.15, 0, 0, p.r);
      grad.addColorStop(0, lit);
      grad.addColorStop(1, body);
      p._cc = { key, body, lit, grad };
    }
    return p._cc;
  }

  _drawPlanetSet(ctx, canvas, planets, alpha, colors, tSec, groove, paint = 1, maxPlanets = Infinity) {
    if (alpha <= 0.02) return;
    const shown = planets.slice(0, maxPlanets);
    for (const p of shown) {
      const cc = this._planetColors(ctx, p, colors);
      ctx.save();
      // A whisper of drift -- planets hang, they don't dart.
      ctx.translate(
        (p.xFrac + 0.004 * Math.sin(tSec * 0.05 + p.phase)) * canvas.width,
        (p.yFrac + 0.003 * Math.sin(tSec * 0.04 + p.phase * 1.7)) * canvas.height,
      );

      // Halo: barely-there, breathing with the groove.
      ctx.globalAlpha = paint * alpha * (0.10 + 0.08 * groove * (0.5 + 0.5 * Math.sin(tSec * 1.2 + p.phase)));
      ctx.fillStyle = colors.halo;
      ctx.beginPath();
      ctx.arc(0, 0, p.r * 1.9, 0, Math.PI * 2);
      ctx.fill();

      // Ring behind (upper arc) so the body occludes its middle.
      if (p.kind === 'ringed') {
        ctx.globalAlpha = paint * alpha * 0.5;
        ctx.strokeStyle = cc.lit;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.r * 1.75, p.r * 0.5, p.tilt, Math.PI, Math.PI * 2);
        ctx.stroke();
      }

      // Body with a lit limb toward the celestial (upper right).
      ctx.globalAlpha = paint * alpha * 0.9;
      ctx.fillStyle = cc.grad;
      ctx.beginPath();
      ctx.arc(0, 0, p.r, 0, Math.PI * 2);
      ctx.fill();

      if (p.kind === 'banded') {
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, p.r, 0, Math.PI * 2);
        ctx.clip();
        ctx.globalAlpha = paint * alpha * 0.30;
        ctx.strokeStyle = colors.skyMid;
        ctx.lineWidth = p.r * 0.22;
        for (let b = -1; b <= 1; b++) {
          ctx.beginPath();
          ctx.ellipse(0, b * p.r * 0.42, p.r * 1.1, p.r * 0.30, p.tilt * 0.4, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      } else if (p.kind === 'cratered') {
        ctx.globalAlpha = paint * alpha * 0.35;
        ctx.fillStyle = colors.silhouette;
        for (const [ox, oy, cr] of [[-0.35, -0.1, 0.2], [0.2, 0.3, 0.14], [0.05, -0.42, 0.11]]) {
          ctx.beginPath();
          ctx.arc(ox * p.r, oy * p.r, cr * p.r, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (p.kind === 'crescent') {
        // Shadow disc offset toward the dark side carves the crescent.
        ctx.globalAlpha = paint * alpha * 0.85;
        ctx.fillStyle = colors.skyMid;
        ctx.beginPath();
        ctx.arc(-p.r * 0.4, p.r * 0.28, p.r * 0.92, 0, Math.PI * 2);
        ctx.fill();
      }

      // Ring in front (lower arc).
      if (p.kind === 'ringed') {
        ctx.globalAlpha = paint * alpha * 0.65;
        ctx.strokeStyle = cc.lit;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.r * 1.75, p.r * 0.5, p.tilt, 0, Math.PI);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  _drawComet(ctx, canvas, u, env, seed, colors, paint = 1) {
    const rand = mulberry32(seed);
    const y0 = (0.06 + rand() * 0.16) * canvas.height;
    const dip = (0.05 + rand() * 0.1) * canvas.height;
    const ltr = rand() < 0.5;
    const x = (ltr ? u : 1 - u) * (canvas.width + 320) - 160;
    const y = y0 + Math.sin(u * Math.PI) * dip;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Tail: segments fading back along the travel direction, slightly arced.
    const dir = ltr ? -1 : 1;
    for (let i = 0; i < 14; i++) {
      const f = i / 14;
      ctx.globalAlpha = paint * env * 0.30 * (1 - f);
      ctx.strokeStyle = i % 3 === 0 ? colors.halo : '#cfe6ff';
      ctx.lineWidth = 2.4 * (1 - f) + 0.4;
      ctx.beginPath();
      ctx.moveTo(x + dir * i * 13, y - Math.sin(u * Math.PI) * i * 0.9);
      ctx.lineTo(x + dir * (i + 1) * 13, y - Math.sin(u * Math.PI) * (i + 1) * 0.9);
      ctx.stroke();
    }
    ctx.globalAlpha = paint * env * 0.85;
    ctx.fillStyle = '#eef7ff';
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawEclipse(ctx, canvas, u, env, planets, colors, paint = 1) {
    const p = planets[0];
    if (!p) return;
    const cx = p.xFrac * canvas.width, cy = p.yFrac * canvas.height;
    // A small dark moon transits the planet's face left to right.
    const mx = cx + (u * 2 - 1) * p.r * 2.4;
    ctx.save();
    ctx.globalAlpha = paint * env * 0.9;
    ctx.fillStyle = colors.silhouette;
    ctx.beginPath();
    ctx.arc(mx, cy - p.r * 0.1, p.r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    // At max overlap the planet's limb flares -- the "diamond ring" beat.
    const overlap = 1 - Math.min(1, Math.abs(mx - cx) / (p.r * 1.2));
    if (overlap > 0.6) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = paint * env * 0.35 * (overlap - 0.6) / 0.4;
      ctx.strokeStyle = colors.halo;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(cx, cy, p.r * 1.08, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawSatellite(ctx, canvas, u, env, seed, tSec, paint = 1) {
    const rand = mulberry32(seed);
    const y = (0.08 + rand() * 0.14) * canvas.height;
    const ltr = rand() < 0.5;
    const x = (ltr ? u : 1 - u) * (canvas.width + 60) - 30;
    const blink = (Math.sin(tSec * 7) > 0.55) ? 1 : 0.25; // slow strobe, mostly dim
    ctx.save();
    ctx.globalAlpha = paint * env * 0.7 * blink;
    ctx.fillStyle = '#dfe9ff';
    ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
    // Tiny solar panels: one dark pixel either side, barely readable -- a
    // satellite, not a star.
    ctx.globalAlpha = paint * env * 0.35;
    ctx.fillRect(x - 4.6, y - 0.7, 2.4, 1.4);
    ctx.fillRect(x + 2.2, y - 0.7, 2.4, 1.4);
    ctx.restore();
  }

  _drawAuroraRibbon(ctx, canvas, u, env, seed, tSec, colors, paint = 1) {
    const rand = mulberry32(seed);
    const cx = (0.15 + rand() * 0.5) * canvas.width;
    const w = (0.25 + rand() * 0.2) * canvas.width;
    const yBase = (0.10 + rand() * 0.12) * canvas.height;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let band = 0; band < 2; band++) {
      ctx.globalAlpha = paint * env * (0.10 - band * 0.03);
      ctx.strokeStyle = band === 0 ? colors.halo : '#7fe8c9';
      ctx.lineWidth = 14 - band * 5;
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const f = i / 24;
        const x = cx - w / 2 + f * w;
        const y = yBase + band * 12 + Math.sin(f * 5 + tSec * 0.8 + band) * 11 + Math.sin(f * 11 - tSec * 0.5) * 5;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawStarPair(ctx, canvas, u, env, seed, reducedFlash, paint = 1) {
    const rand = mulberry32(seed);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = paint;
    for (let s = 0; s < 2; s++) {
      // Each streak lives inside its own half of the window, staggered.
      const su = clamp01((u - s * 0.45) / 0.4);
      if (su <= 0 || su >= 1) continue;
      const x0 = (0.15 + rand() * 0.6) * canvas.width;
      const y0 = (0.05 + rand() * 0.1) * canvas.height;
      const len = 90 + rand() * 60;
      const ang = 0.5 + rand() * 0.35;
      const x = x0 + Math.cos(ang) * len * su;
      const y = y0 + Math.sin(ang) * len * su;
      const a = capFlashAlpha(0.5 * Math.sin(Math.PI * su), reducedFlash);
      ctx.strokeStyle = `rgba(238,247,255,${a.toFixed(3)})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - Math.cos(ang) * 26, y - Math.sin(ang) * 26);
      ctx.stroke();
    }
    ctx.restore();
  }
}
