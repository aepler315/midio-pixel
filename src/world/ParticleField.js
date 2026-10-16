// Generic ambient particle field covering every biome's "particle signature"
// (spec §4.1.2 table): a fixed-size, ever-respawning field rather than a
// pooled emit-and-die burst, since these are continuous atmosphere, not FX.
import { mulberry32, clamp01 } from '../utils/math.js';
import { curl2 } from '../utils/fields.js';
import { hexLerpHsl } from '../utils/color.js';

// Cached radial-glow sprite for gradient-heavy particle kinds (embers, spores,
// sunshine, fog). One offscreen canvas per hex color holds a color-to-transparent
// radial gradient at a fixed size; draw() blits it at each particle's position,
// avoiding per-particle createRadialGradient calls.
const GLOW_SPRITE_SIZE = 64;
const _glowCache = new Map();
function glowSprite(color) {
  let c = _glowCache.get(color);
  if (c) return c;
  if (_glowCache.size > 16) _glowCache.clear();
  try {
    c = typeof document !== 'undefined'
      ? document.createElement('canvas')
      : new OffscreenCanvas(GLOW_SPRITE_SIZE * 2, GLOW_SPRITE_SIZE * 2);
    if (c.width === undefined) { c.width = GLOW_SPRITE_SIZE * 2; c.height = GLOW_SPRITE_SIZE * 2; }
    else { c.width = c.height = GLOW_SPRITE_SIZE * 2; }
    const g = c.getContext('2d');
    const r = GLOW_SPRITE_SIZE;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, r * 2, r * 2);
    _glowCache.set(color, c);
    return c;
  } catch {
    return null;
  }
}

// Particle lighting is a proximity wash, not a rim: motes have no edge
// normal to face a source. Same radius-falloff MeshDrawer uses on
// character edges, minus the facing term, and capped well below a full
// wash so a kick-glow warms nearby snow without announcing itself.
// Infinite-radius sources (the celestial) are skipped -- a scene-wide
// alpha bump is invisible as lighting and expensive at particle counts.
export const PARTICLE_LIGHT_GAIN = 0.16;
export const PARTICLE_LIGHT_CAP = 0.22;

/** Bounded 0..PARTICLE_LIGHT_CAP alpha add from local lights at (x, y).
 *  Empty / missing lights is a hard 0 (the draw path then becomes a
 *  no-op on alpha). Never negative. */
export function particleLightAmount(lights, x, y) {
  if (!lights || !lights.length) return 0;
  let total = 0;
  for (const L of lights) {
    if (!L || !(L.intensity > 0.01)) continue;
    const radius = L.radius ?? Infinity;
    if (!(radius < Infinity)) continue; // celestial wash -- not a catch
    const dist = Math.hypot(x - L.x, y - L.y) || 1;
    if (dist > radius) continue;
    total += L.intensity * Math.max(0, 1 - dist / radius);
  }
  if (!(total > 0)) return 0;
  return Math.min(PARTICLE_LIGHT_CAP, total * PARTICLE_LIGHT_GAIN);
}

export class ParticleField {
  constructor(config, canvasWidth, canvasHeight, seed = 1) {
    this.kind = config.kind;
    this.color = config.color;
    this.count = config.count;
    this.baseSpeed = config.speed;
    // Song-derived global drift (ShapeGrammar.deriveParticleMotion): a
    // constant px/s nudge layered on top of each kind's own physics, so a
    // song's register trajectory (rising/falling/bursty/neutral) is legible
    // across every particle kind rather than only the kinds whose baked-in
    // motion happens to already go up or down. Zero by default -- existing
    // callers that don't pass driftBias get byte-identical motion.
    this.driftBias = config.driftBias || null;
    // Scales the wind streaks' travel (a world drawn at landscape scale sets
    // it below 1); their drawn length keeps the unscaled speed.
    this.windSpeedScale = 1;
    this.w = canvasWidth;
    this.h = canvasHeight;
    this.rand = mulberry32(seed);
    this.particles = [];
    for (let i = 0; i < this.count; i++) this.particles.push(this._spawn());
  }

  _spawn(px, py) {
    const rand = this.rand;
    const p = {
      x: px ?? rand() * this.w,
      y: py ?? rand() * this.h,
      phase: rand() * Math.PI * 2,
      omega: 0.6 + rand() * 1.2,
      size: 1.5 + rand() * 2.5,
      spin: (rand() * 2 - 1) * 3,
      rot: 0,
      vx: 0, vy: 0,
      state: 'alive',
      alpha: 1,
    };
    if (this.kind === 'digitalrain') {
      const col = Math.floor(rand() * 40);
      p.x = (col / 40) * this.w;
      p.y = -rand() * this.h;
      p.glyphT = 0;
    }
    if (this.kind === 'rain') {
      p.y = -rand() * this.h;
      p.vx = -(70 + rand() * 50);
      p._rainVxBase = p.vx; // the wind field re-derives vx from this each frame
      p.vy = 380 + rand() * 170;
      p.state = 'fall';
      p.splashT = 0;
    }
    if (this.kind === 'flaresparks') {
      p.t = rand();
      p.origin = { x: rand() * this.w * 0.3, y: this.h * 0.25 };
      p.ctrl = { x: p.origin.x + rand() * 200, y: p.origin.y - 80 - rand() * 80 };
      p.end = { x: p.origin.x + 150 + rand() * 250, y: p.origin.y + rand() * 100 - 50 };
    }
    if (this.kind === 'wind') {
      p.x = -rand() * this.w * 0.2;
      p.vx = 140 + rand() * 90;
    }
    if (this.kind === 'sand') {
      p.y = rand() * this.h * 0.75;
      p.size = 0.8 + rand() * 1.6;
      p.vx = 40 + rand() * 50;
    }
    if (this.kind === 'bubbles') {
      p.y = this.h * 0.4 + rand() * this.h * 0.55;
      p.size = 1.2 + rand() * 3.5;
      p.vy = -(18 + rand() * 28);
      p.alpha = 0.25 + rand() * 0.45;
    }
    if (this.kind === 'spores') {
      p.size = 1.8 + rand() * 3.2;
      p.alpha = 0.35 + rand() * 0.5;
    }
    return p;
  }

  update(dtSec, tSec, energyCurves, nowMs, calmLevel = 0, wind = null, groundYAt = null) {
    const rand = this.rand;
    const wx = wind ? wind.x : 0, wy = wind ? wind.y : 0;
    for (const p of this.particles) {
      if (this.driftBias) {
        p.x += this.driftBias.vx * dtSec;
        p.y += this.driftBias.vy * dtSec;
      }
      switch (this.kind) {
        case 'fireflies':
          p.x += (Math.sin(tSec * 0.4 + p.phase) * this.baseSpeed + wx * 0.4) * dtSec;
          p.y += (Math.cos(tSec * 0.3 + p.phase * 1.3) * this.baseSpeed * 0.6 + wy * 0.4) * dtSec;
          // Calm sections: brighter, slightly faster blink -- ambient life
          // to lean on when the foreground has gone quiet.
          p.alpha = clamp01((0.5 + 0.5 * Math.sin((2 * Math.PI * tSec) / 3 * (1 + 0.3 * calmLevel) + p.phase)) * (1 + 0.4 * calmLevel));
          break;
        case 'embers': {
          p.vy = p.vy || -(40 + rand() * 50);
          p.vx += (rand() * 2 - 1) * 18 * dtSec;
          // Curl-noise updraft: a divergence-free gust field so the embers
          // swirl in eddies like real fire-lofted ash, never clumping.
          const gust = energyCurves ? 0.5 + clamp01(energyCurves.sample(1, nowMs)) : 1;
          const fl = curl2(p.x * 0.006, p.y * 0.006, tSec * 0.2);
          p.x += (p.vx + fl.x * 55 * gust + wx) * dtSec;
          p.y += (p.vy + fl.y * 55 * gust + wy) * dtSec;
          if (p.y < -20) Object.assign(p, this._spawn(rand() * this.w, this.h + 10));
          break;
        }
        case 'snow': {
          const drift = curl2(p.x * 0.004, p.y * 0.004, tSec * 0.12);
          p.y += (30 + p.size * 13 + drift.y * 25 + wy) * dtSec;
          p.x += (18 * Math.sin(tSec * p.omega + p.phase) + drift.x * 40 + wx) * dtSec;
          if (p.y > this.h + 10) Object.assign(p, this._spawn(rand() * this.w, -10));
          break;
        }
        case 'pollen': {
          p.x += (Math.sin(tSec * 0.5 + p.phase) * 6 + wx * 0.6) * dtSec;
          p.y += (Math.cos(tSec * 0.4 + p.phase * 1.7) * 6 + wy * 0.6) * dtSec;
          const air = energyCurves ? energyCurves.sample(6, nowMs) : 0.3;
          p.alpha = clamp01((0.3 + 0.5 * clamp01(air)) * (1 + 0.3 * calmLevel));
          break;
        }
        case 'antigrav':
          p.baseX = p.baseX ?? p.x;
          p.angle = (p.angle ?? rand() * Math.PI * 2) + 0.6 * dtSec;
          p.radius = p.radius ?? (10 + rand() * 40) * Math.max(0.15, (this.h - p.y) / this.h);
          p.y -= (20 + p.radius * 0.5) * dtSec;
          p.x = p.baseX + Math.cos(p.angle) * p.radius;
          if (p.y < -20) { Object.assign(p, this._spawn(rand() * this.w, this.h + 10)); p.baseX = p.x; p.radius = null; }
          break;
        case 'petals':
          p.vy = p.vy || (25 + rand() * 30);
          p.x += (22 * Math.sin(tSec * p.omega + p.phase) + wx) * dtSec;
          p.y += p.vy * dtSec;
          p.rot += p.spin * dtSec;
          if (p.state === 'alive' && p.y > this.h - 6) { p.state = 'piled'; p.pileT = 0; }
          if (p.state === 'piled') {
            p.pileT += dtSec;
            if (p.pileT > 1.2) Object.assign(p, this._spawn(rand() * this.w, -10));
          }
          break;
        case 'rain': {
          if (p.state === 'splash') {
            p.splashT += dtSec;
            if (p.splashT > 0.16) Object.assign(p, this._spawn(rand() * this.w));
            break;
          }
          // The fall angle itself rides the wind, not just a fixed slant.
          p.vx = p._rainVxBase + wx * 1.6;
          p.x += p.vx * dtSec;
          p.y += p.vy * dtSec;
          if (p.x < -20) p.x += this.w + 40;
          // Land on the real terrain when the caller handed us a height
          // function (BiomeManager passes GroundField.heightAt, remapped
          // to screen x). Fall back to the old screen-fraction shelf so
          // existing callers and tests stay byte-identical.
          const splashY = typeof groundYAt === 'function' ? groundYAt(p.x) : this.h * 0.667;
          if (p.y >= splashY) { p.state = 'splash'; p.splashT = 0; p.y = splashY; }
          break;
        }
        case 'flaresparks':
          p.t += dtSec * 0.6;
          if (p.t > 1) Object.assign(p, this._spawn());
          break;
        case 'digitalrain': {
          p.glyphT += dtSec;
          const speed = this.baseSpeed * (energyCurves ? 0.5 + energyCurves.sample(5, nowMs) : 1);
          p.y += speed * dtSec;
          if (p.y > this.h + 40) p.y = -40 - rand() * 200;
          break;
        }
        case 'sunshine':
          // Sparse bright motes drifting slowly, twinkling -- weather with
          // no ground consequence, just a warm, calm read.
          p.x += (Math.sin(tSec * 0.15 + p.phase) * 8 + wx * 0.3) * dtSec;
          p.y += (-4 + Math.cos(tSec * 0.2 + p.phase) * 3 + wy * 0.2) * dtSec;
          p.alpha = clamp01(0.5 + 0.5 * Math.sin(tSec * 0.6 + p.phase));
          if (p.y < -20) Object.assign(p, this._spawn(rand() * this.w, this.h + 10));
          break;
        case 'wind':
          // Directional streaks blown hard across the screen -- reads as
          // its own weather (dust/debris on the gust) rather than bending
          // whatever else might be falling.
          p.x += (p.vx + wx * 2) * this.windSpeedScale * dtSec;
          p.y += Math.sin(tSec * p.omega + p.phase) * 10 * dtSec;
          if (p.x > this.w + 20) Object.assign(p, this._spawn(-20, rand() * this.h));
          break;
        case 'fog': {
          // Slow, near-static drifting haze patches -- a still, becalmed sky.
          p.x += (6 * Math.sin(tSec * 0.1 + p.phase) + wx * 0.5) * dtSec;
          p.alpha = clamp01(0.3 + 0.15 * Math.sin(tSec * 0.2 + p.phase));
          break;
        }
        case 'sand': {
          // Horizontal sheet of grit: fast lateral drift, light vertical curl.
          const fl = curl2(p.x * 0.005, p.y * 0.008, tSec * 0.25);
          const gust = energyCurves ? 0.6 + clamp01(energyCurves.sample(2, nowMs)) : 1;
          p.x += (this.baseSpeed * 0.55 * gust + fl.x * 30 + wx * 1.4) * dtSec;
          p.y += (fl.y * 18 + Math.sin(tSec * p.omega + p.phase) * 8 + wy * 0.5) * dtSec;
          if (p.x > this.w + 20) Object.assign(p, this._spawn(-10, rand() * this.h * 0.75));
          if (p.y < -10 || p.y > this.h + 10) p.y = rand() * this.h * 0.75;
          break;
        }
        case 'bubbles': {
          p.x += (Math.sin(tSec * p.omega + p.phase) * 14 + wx * 0.5) * dtSec;
          p.y += (p.vy + wy * 0.3) * dtSec;
          p.alpha = clamp01((p.alpha ?? 0.5) + Math.sin(tSec * 2 + p.phase) * 0.02);
          if (p.y < -20) Object.assign(p, this._spawn(rand() * this.w, this.h + 10));
          break;
        }
        case 'spores': {
          // Soft bioluminescent floaters — firefly motion, slower, with a glow pulse.
          p.x += (Math.sin(tSec * 0.35 + p.phase) * this.baseSpeed + wx * 0.35) * dtSec;
          p.y += (Math.cos(tSec * 0.28 + p.phase * 1.1) * this.baseSpeed * 0.7 + wy * 0.35) * dtSec;
          p.alpha = clamp01(0.25 + 0.55 * (0.5 + 0.5 * Math.sin(tSec * 1.4 + p.phase)) * (1 + 0.3 * calmLevel));
          if (p.x < -20) p.x += this.w + 40;
          if (p.x > this.w + 20) p.x -= this.w + 40;
          if (p.y < -20) p.y += this.h + 40;
          if (p.y > this.h + 20) p.y -= this.h + 40;
          break;
        }
      }
    }
  }

  /** mul: draw-density multiplier (PerfGovernor). haloColor/hueBlend: the
   *  Unraveling (Movement V) -- as the song ends, particle hues converge
   *  toward the biome's own halo color. Blended once per draw call, not
   *  per particle. */
  draw(ctx, mul = 1, haloColor = null, hueBlend = 0, lights = null) {
    // An empty field has nothing to draw. Without this the Math.max below
    // floors the count at 1, `particles[0]` is undefined, and the first
    // property read off it throws -- which aborts the REST of the frame,
    // every frame, for whatever world happens to hold an empty field. It
    // only surfaced under lighting, because that is the first branch that
    // dereferences the particle.
    if (this.particles.length === 0) return;
    // A multiplier at or below zero means the caller has shed this field
    // outright -- the governor at its deepest rung, or a weather kind at
    // zero intensity. The Math.max below floors the drawn count at 1, so
    // "off" still cost a particle per field per frame AND drew one, at
    // full opacity, in a world that had asked for none. A NaN multiplier
    // lands here too rather than propagating into the count.
    const density = Math.min(1, mul);
    if (!(density > 0)) return;
    // The alpha the caller arrives with is a scene-level fade: BiomeManager
    // sets it for the opening gain and again for the incoming half of a
    // biome cross-blend, deliberately fading the field as a whole so
    // individual particles don't pop as the gain rises. Every setAlpha
    // below used to ASSIGN globalAlpha, which threw that fade away -- so
    // both fades did nothing and particles arrived at full strength on
    // their first frame. Scale through the inherited alpha instead. A
    // field faded to nothing is then nothing to draw.
    const inherited = ctx.globalAlpha ?? 1;
    if (!(inherited > 0)) return;
    const color = haloColor && hueBlend > 0.001 ? hexLerpHsl(this.color, haloColor, clamp01(hueBlend)) : this.color;
    const lighting = !!(lights && lights.length);
    ctx.save();
    const n = Math.max(1, Math.ceil(this.particles.length * density));
    for (let idx = 0; idx < n; idx++) {
      const p = this.particles[idx];
      const boost = lighting ? particleLightAmount(lights, p.x, p.y) : 0;
      const setAlpha = (a) => { ctx.globalAlpha = inherited * (boost ? clamp01(a + boost) : a); };
      switch (this.kind) {
        case 'fireflies':
        case 'pollen':
        case 'antigrav':
          setAlpha(p.alpha ?? 1);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'embers': {
          const r = p.size * 2.4;
          setAlpha(0.85);
          const sp = glowSprite(color);
          if (sp) { ctx.drawImage(sp, p.x - r, p.y - r, r * 2, r * 2); }
          else { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); }
          break;
        }
        case 'snow':
        case 'sand':
          setAlpha(this.kind === 'sand' ? 0.45 : 0.85);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (this.kind === 'sand' ? 0.55 : 0.7), 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'bubbles': {
          setAlpha(p.alpha ?? 0.4);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.stroke();
          // Specular highlight
          setAlpha((p.alpha ?? 0.4) * 0.7);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(p.x - p.size * 0.3, p.y - p.size * 0.3, p.size * 0.22, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'spores': {
          const r = p.size * 1.8;
          setAlpha((p.alpha ?? 0.6) * 0.85);
          const sp = glowSprite(color);
          if (sp) { ctx.drawImage(sp, p.x - r, p.y - r, r * 2, r * 2); }
          else { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); }
          break;
        }
        case 'petals': {
          setAlpha(p.state === 'piled' ? Math.max(0, 1 - p.pileT / 1.2) * 0.7 : 0.9);
          ctx.fillStyle = color;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.beginPath();
          for (let k = 0; k < 5; k++) {
            const ang = (k / 5) * Math.PI * 2;
            const r = p.size * 1.6;
            const px = Math.cos(ang) * r, py = Math.sin(ang) * r * 0.6;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'rain': {
          if (p.state === 'splash') {
            // A widening half-ring where the drop hit the ground plane.
            const t = p.splashT / 0.16;
            setAlpha(0.5 * (1 - t));
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, 3 + 7 * t, 1 + 2.2 * t, 0, Math.PI, Math.PI * 2);
            ctx.stroke();
          } else {
            setAlpha(0.55);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
            ctx.stroke();
          }
          break;
        }
        case 'flaresparks': {
          setAlpha(clamp01(1 - Math.abs(p.t - 0.5) * 2) * 0.9);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(p.origin.x, p.origin.y);
          const tt = clamp01(p.t);
          const qx = p.origin.x + (p.ctrl.x - p.origin.x) * tt;
          const qy = p.origin.y + (p.ctrl.y - p.origin.y) * tt;
          ctx.quadraticCurveTo(p.ctrl.x, p.ctrl.y, p.origin.x + (p.end.x - p.origin.x) * tt, p.origin.y + (p.end.y - p.origin.y) * tt);
          ctx.stroke();
          break;
        }
        case 'digitalrain': {
          // Soft falling mote (was a 2×14 hard rect — read as UI “vertical line” ticks).
          const flicker = 0.5 + 0.5 * Math.sin(p.glyphT * 9 + p.phase);
          setAlpha(0.18 + 0.28 * flicker);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(p.x + 1, p.y + 3, 1.4 + 0.6 * flicker, 0, Math.PI * 2);
          ctx.fill();
          // Short soft trail above the mote, not a solid bar.
          setAlpha(0.08 + 0.12 * flicker);
          ctx.beginPath();
          ctx.moveTo(p.x + 1, p.y);
          ctx.lineTo(p.x + 1, p.y + 8);
          ctx.lineWidth = 1.2;
          ctx.lineCap = 'round';
          ctx.strokeStyle = color;
          ctx.stroke();
          break;
        }
        case 'sunshine': {
          const r = p.size * 3;
          setAlpha((p.alpha ?? 1) * 0.7);
          const sp = glowSprite(color);
          if (sp) { ctx.drawImage(sp, p.x - r, p.y - r, r * 2, r * 2); }
          else { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); }
          break;
        }
        case 'wind':
          setAlpha(0.4);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.05, p.y);
          ctx.stroke();
          break;
        case 'fog': {
          const r = p.size * 14;
          setAlpha(p.alpha ?? 0.3);
          const sp = glowSprite(color);
          if (sp) { ctx.drawImage(sp, p.x - r, p.y - r, r * 2, r * 2); }
          else { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); }
          break;
        }
      }
    }
    ctx.restore();
  }
}
