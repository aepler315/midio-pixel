// Landing-impact FX fan-out (spec §2.2.1): crater flash, dust ring, dust
// motes, screen shake, ground scar. Pooled, zero allocation once warm.
// Positions are stored in world-space so short-lived bursts stay glued to
// the ground point where they were spawned as the world scrolls under them.
import { ObjectPool } from '../utils/ObjectPool.js';
import { clamp, mulberry32 } from '../utils/math.js';
import { capFlashAlpha, flashCompositeOp } from '../ui/Accessibility.js';

export class ImpactFX {
  constructor(seed = 1) {
    this.rand = mulberry32(seed);

    this.craters = new ObjectPool(() => ({}), (o, i) => Object.assign(o, i, { age: 0 }), 16);
    // Landing dust rings and judgment (tap-verdict) rings used to share one
    // 16-slot pool. In a dense passage -- judgment rings firing per note --
    // the ambient landing rings could exhaust it, and ObjectPool.spawn()
    // silently returns null at capacity: the player's "perfect" verdict
    // would just not appear, with no signal anything was dropped. Feedback
    // must never be starved by decoration, so it gets its own pool.
    const ringFactory = () => ({ jitter: new Float32Array(24) });
    const ringInit = (o, i) => { Object.assign(o, i, { age: 0 }); };
    this.rings = new ObjectPool(ringFactory, ringInit, 16);
    this.judgmentRings = new ObjectPool(ringFactory, ringInit, 16);
    this.motes = new ObjectPool(() => ({}), (o, i) => Object.assign(o, i, { age: 0 }), 400);
    this.polyRings = new ObjectPool(() => ({}), (o, i) => Object.assign(o, i, { age: 0 }), 8);
    this.splats = new ObjectPool(() => ({}), (o, i) => Object.assign(o, i, { age: 0 }), 20);
    this.ignitions = new ObjectPool(() => ({}), (o, i) => Object.assign(o, i, { age: 0 }), 8);
    this.scars = []; // small list, capped manually — decals persist seconds, not worth pooling

    this._sputterAccum = 0;
  }

  /** vLandPxMs -> normalized landing intensity I (spec §2.2.1). */
  static intensity(vLandPxMs, vRefPxMs) {
    return Math.pow(clamp(vLandPxMs / vRefPxMs, 0, 1), 0.7);
  }

  /** `color` (an "r,g,b" triplet, matching the judgment ring color format):
   *  tints the crater flash and landing dust with the active biome's
   *  ambient particle color, the same "world visibly answers back" color
   *  RippleFX's landingPuff already pulls from BiomeManager -- so a snowy
   *  world kicks up pale dust and a lava world kicks up embers, not the
   *  same warm-white regardless of song/world. Falls back to that
   *  warm-white when no color is given (e.g. sputter's tests, or callers
   *  that don't have a biome to ask). Judgment-tier and hazard/reward hues
   *  are untouched -- those carry verdict language and stay protected. */
  trigger(worldX, groundY, I, camera, particleMul = 1, color = null) {
    const rand = this.rand;

    this.craters.spawn({ wx: worldX, y: groundY, R: 14 + 66 * I, alpha: 0.85 * I, life: 0.12, color });

    // color: null — the dust ring itself is never biome-tinted (only the
    // crater/motes are); explicit since ObjectPool objects keep old fields
    // across reuse.
    const ring = this.rings.spawn({ wx: worldX, y: groundY, Rd: 40 + 120 * I, tau: 0.09, life: 0.42, color: null });
    if (ring) for (let i = 0; i < 24; i++) ring.jitter[i] = (rand() * 2 - 1) * 4 * I;

    const n = Math.round((6 + 18 * I) * particleMul);
    for (let i = 0; i < n; i++) {
      const theta = (rand() * 2 - 1) * (35 * Math.PI / 180);
      const dir = rand() < 0.5 ? -1 : 1;
      const speed = 60 + 160 * I * rand();
      this.motes.spawn({
        wx: worldX, y: groundY,
        vx: Math.cos(theta) * speed * dir,
        vy: -Math.abs(Math.sin(theta) * speed) - 20,
        size: 3, life: 0.26 + 0.16 * rand(), color,
      });
    }

    this.scars.push({ wx: worldX, y: groundY, width: 20 + 40 * I, age: 0, maxAge: 4 });
    if (this.scars.length > 60) this.scars.shift();

    // Hard landings additionally throw a rotating star polygon -- crisp
    // geometry cutting through the soft dust ring.
    if (I > 0.5) {
      this.polyRings.spawn({
        wx: worldX, y: groundY,
        n: 5 + Math.floor(rand() * 3), // pentagram / hexagram / heptagram
        Rd: 90 + 160 * I,
        spin: (rand() < 0.5 ? -1 : 1) * (1.5 + 2 * rand()),
        rot0: rand() * Math.PI * 2,
        star: 0.55, tau: 0.12, life: 0.5, I,
      });
    }

    if (camera) camera.shake(5.5 * I);
  }

  /** Mario Paint-style paint splat, stamped only on rhythm-clean landings:
   * a handful of chunky square blobs in one bright paint-pot color. */
  splat(worldX, groundY, particleMul = 1) {
    const rand = this.rand;
    const colors = ['#ff4d4d', '#ffd400', '#39c8ff', '#63e04d', '#ff7ad9', '#b06bff'];
    const blobs = [];
    const n = Math.max(2, Math.round((6 + Math.floor(rand() * 4)) * particleMul));
    for (let i = 0; i < n; i++) {
      blobs.push({
        dx: (rand() * 2 - 1) * 28,
        dy: -rand() * 9,
        s: 3 + Math.floor(rand() * 5),
      });
    }
    this.splats.spawn({ wx: worldX, y: groundY, color: colors[Math.floor(rand() * colors.length)], blobs, life: 2.8 });
  }

  /** Apotheosis-only: a bright gold ring stamped on every landing while transformed. */
  ignite(worldX, groundY) {
    this.ignitions.spawn({ wx: worldX, y: groundY, Rd: 150, life: 0.5 });
  }

  /** Tap-judgment burst at Midio: a tier-colored halo ring (its own pool,
   * separate from the ambient landing dust rings so a dense passage of
   * landings can never starve the player's verdict feedback -- see the
   * constructor -- lifted to body height) plus a few motes — rising for
   * hits, drooping for a sour press. The color alone carries the verdict,
   * so the shape stays language-free. */
  judgment(worldX, groundY, tier, particleMul = 1) {
    const style = {
      perfect: { col: '255,215,106', Rd: 150, motes: 10, up: true, jag: 2.5 },
      great: { col: '79,216,196', Rd: 110, motes: 6, up: true, jag: 2.5 },
      good: { col: '235,235,245', Rd: 75, motes: 3, up: true, jag: 2.5 },
      sour: { col: '158,132,168', Rd: 55, motes: 8, up: false, jag: 7 },
    }[tier];
    if (!style) return;
    const rand = this.rand;
    const ring = this.judgmentRings.spawn({ wx: worldX, y: groundY - 42, Rd: style.Rd, tau: 0.09, life: 0.38, color: style.col });
    if (ring) for (let i = 0; i < 24; i++) ring.jitter[i] = (rand() * 2 - 1) * style.jag;
    const n = Math.round(style.motes * particleMul);
    for (let i = 0; i < n; i++) {
      this.motes.spawn({
        wx: worldX + (rand() * 2 - 1) * 16,
        y: groundY - (style.up ? 6 : 46),
        vx: (rand() * 2 - 1) * 50,
        vy: style.up ? -70 - rand() * 90 : 10 + rand() * 30,
        size: 2.2, life: 0.3 + 0.2 * rand(), color: null, // never biome-tinted -- the ring alone carries the verdict
      });
    }
  }

  /** Pre-kick sputter dust at Midio's feet during telegraph anticipation (spec §2.2.3).
   *  `particleMul`: this is continuous/ambient, not a one-shot feedback burst, so it must
   *  shed under perf pressure the same as everything else rather than keeping a fixed rate
   *  while landing/judgment bursts around it thin out. */
  sputter(worldX, groundY, dtSec, particleMul = 1) {
    this._sputterAccum += dtSec * 120 * particleMul; // ~2 per rendered frame at 60fps == ~1 per sim step at 120Hz
    while (this._sputterAccum >= 1) {
      this._sputterAccum -= 1;
      const rand = this.rand;
      this.motes.spawn({
        wx: worldX + (rand() * 2 - 1) * 10, y: groundY,
        vx: (rand() * 2 - 1) * 20, vy: -20 - rand() * 20,
        size: 1.5, life: 0.15 + 0.1 * rand(), color: null,
      });
    }
  }

  step(dtSec) {
    this.craters.step(dtSec, (o, dt) => { o.age += dt; return o.age < o.life; });
    this.rings.step(dtSec, (o, dt) => { o.age += dt; return o.age < o.life; });
    this.judgmentRings.step(dtSec, (o, dt) => { o.age += dt; return o.age < o.life; });
    this.polyRings.step(dtSec, (o, dt) => { o.age += dt; return o.age < o.life; });
    this.splats.step(dtSec, (o, dt) => { o.age += dt; return o.age < o.life; });
    this.ignitions.step(dtSec, (o, dt) => { o.age += dt; return o.age < o.life; });
    this.motes.step(dtSec, (o, dt) => {
      o.vy += 300 * dt;
      o.wx += o.vx * dt;
      o.y += o.vy * dt;
      o.age += dt;
      return o.age < o.life;
    });
    for (let i = this.scars.length - 1; i >= 0; i--) {
      this.scars[i].age += dtSec;
      if (this.scars[i].age > this.scars[i].maxAge) this.scars.splice(i, 1);
    }
  }

  /** worldX: current scroll distance; originX: screen-space x that worldX=0
   *  maps to (Midio's screenX); canvasWidth: the visible logical width, so
   *  bursts scrolled well off-screen are skipped instead of drawn every
   *  frame regardless -- during a fast passage a large share of the pools
   *  (400 motes, 60 scars, 20 splats...) can be off-canvas. Defaults to
   *  Infinity (cull nothing) for callers that don't have a canvas width
   *  handy. Margin sized to each effect's own max radius/spread so nothing
   *  visibly pops in/out at the cull boundary. */
  draw(ctx, worldX, originX, reducedFlash = false, canvasWidth = Infinity) {
    const toScreen = (wx) => wx - worldX + originX;
    const inView = (x, margin) => x > -margin && x < canvasWidth + margin;

    for (const s of this.scars) {
      const x = toScreen(s.wx);
      if (!inView(x, s.width)) continue;
      const t = s.age / s.maxAge;
      ctx.fillStyle = `rgba(20,10,25,${0.35 * (1 - t)})`;
      ctx.fillRect(x - s.width / 2, s.y, s.width, 4);
    }

    for (const sp of this.splats.active) {
      const x = toScreen(sp.wx);
      if (!inView(x, 40)) continue; // blobs spread up to ~28px + their own size
      const t = sp.age / sp.life;
      ctx.fillStyle = sp.color;
      ctx.globalAlpha = 0.8 * (1 - t);
      for (const b of sp.blobs) {
        ctx.fillRect(Math.round(x + b.dx - b.s / 2), Math.round(sp.y + b.dy - b.s / 2), b.s, b.s);
      }
    }
    ctx.globalAlpha = 1;

    for (const c of this.craters.active) {
      const x = toScreen(c.wx);
      if (!inView(x, c.R)) continue;
      const t = c.age / c.life;
      const g = ctx.createRadialGradient(x, c.y, 0, x, c.y, c.R);
      const a = capFlashAlpha(c.alpha * (1 - t), reducedFlash);
      const rgb = c.color || '255,240,200';
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, c.y, c.R, c.R * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Landing dust rings and judgment rings are drawn from separate pools
    // (see the constructor) but render identically, so both pools feed the
    // same loop here.
    for (const r of [...this.rings.active, ...this.judgmentRings.active]) {
      const x = toScreen(r.wx);
      if (!inView(x, r.Rd)) continue;
      const t = r.age / r.life;
      const radius = r.Rd * (1 - Math.exp(-r.age / r.tau));
      const alpha = capFlashAlpha(Math.pow(1 - t, 2), reducedFlash);
      ctx.strokeStyle = `rgba(${r.color || '255,255,255'},${0.7 * alpha})`;
      ctx.lineWidth = Math.max(0.5, 3 * (1 - t));
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const ang = (i / 24) * Math.PI * 2;
        const rad = radius + r.jitter[i % 24];
        const px = x + Math.cos(ang) * rad;
        const py = r.y + Math.sin(ang) * rad * 0.35;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // Star-polygon shockwaves: 2n vertices alternating outer/inner radius,
    // spinning as they expand, spikes rippling with a 3-lobe wobble --
    // same ground-plane perspective squash as the dust ring above.
    for (const p of this.polyRings.active) {
      const x = toScreen(p.wx);
      if (!inView(x, p.Rd)) continue;
      const t = p.age / p.life;
      const envelope = p.Rd * (1 - Math.exp(-p.age / p.tau));
      const alpha = capFlashAlpha(Math.pow(1 - t, 2) * 0.55 * p.I, reducedFlash);
      const rot = p.rot0 + p.spin * p.age;
      ctx.strokeStyle = `rgba(255,235,170,${alpha})`;
      ctx.lineWidth = Math.max(0.5, 2.2 * (1 - t));
      ctx.beginPath();
      const verts = p.n * 2;
      for (let i = 0; i <= verts; i++) {
        const ang = rot + (i / verts) * Math.PI * 2;
        const spike = i % 2 === 0 ? 1 : p.star;
        const wobble = 1 + 0.08 * Math.sin(3 * ang + 12 * p.age);
        const rad = envelope * spike * wobble;
        const px = x + Math.cos(ang) * rad;
        const py = p.y + Math.sin(ang) * rad * 0.35;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    ctx.save();
    ctx.globalCompositeOperation = flashCompositeOp(reducedFlash);
    for (const g of this.ignitions.active) {
      const x = toScreen(g.wx);
      if (!inView(x, g.Rd)) continue;
      const t = g.age / g.life;
      const radius = g.Rd * (1 - (1 - t) ** 3);
      const alpha = capFlashAlpha((1 - t) ** 2, reducedFlash);
      ctx.strokeStyle = `rgba(255,225,140,${(0.8 * alpha).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.5, 4 * (1 - t));
      ctx.beginPath();
      ctx.ellipse(x, g.y, radius, radius * 0.4, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    for (const m of this.motes.active) {
      const x = toScreen(m.wx);
      if (!inView(x, 6)) continue; // motes are small and never drift far
      const t = m.age / m.life;
      const size = m.size * (1 - t);
      if (size <= 0) continue;
      ctx.fillStyle = `rgba(${m.color || '230,220,200'},0.9)`;
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.arc(x, m.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
