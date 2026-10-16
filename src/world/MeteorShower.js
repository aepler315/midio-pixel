// Meteor shower reward bursts (The Light Show, pass 2): a staggered volley
// of biome-colored streaking meteors at deep-sky depth, behind the mountain
// silhouettes -- fired on combo milestones and HypeDirector drops, the sky
// itself celebrating alongside the player. Mirrors LightningFX's shape:
// seeded rand, plain state, no canvas ownership between calls.
import { mulberry32, clamp01 } from '../utils/math.js';
import { capFlashAlpha } from '../ui/Accessibility.js';

const MAX_ACTIVE_METEORS = 40;   // safety cap; far above any real single volley (max 14)
const STAGGER_BASE_MS = 90;      // average gap between launches in a volley
const STAGGER_JITTER = 0.7;      // +/-70% randomization so the stagger isn't metronomic
const LIFE_MS_MIN = 520;
const LIFE_MS_MAX = 820;
const SPEED_FRAC_MIN = 0.55;     // fraction of canvas dimension / sec
const SPEED_FRAC_MAX = 0.95;
const TRAVEL_DEG_MIN = 18;       // shallowest fall angle (degrees below horizontal)
const TRAVEL_DEG_MAX = 58;       // steepest -- stops short of straight-down
const TRAIL_SAMPLE_MS = 18;      // ~1 point/frame at 60fps
const TRAIL_MAX_POINTS = 10;
const HEAD_GLOW_RADIUS_PX = 3.2;

export class MeteorShowerFX {
  constructor(seed = 1) {
    this.rand = mulberry32((seed ^ 0x4a17) >>> 0 || 1);
    this._meteors = [];
  }

  /** Queues `count` meteors, staggered in launch time. `hue` < 0 is the
   *  achromatic sentinel (a near-white/gray biome halo) -- rendered
   *  desaturated instead of at a meaningless arbitrary hue. Never debounces
   *  its own calls (both real call sites are already edge-detected one
   *  level up in BiomeManager); MAX_ACTIVE_METEORS is the only safety valve,
   *  so two genuinely distinct near-simultaneous rewards both show up. */
  trigger(nowMs, count, hue) {
    const achromatic = hue < 0;
    const room = MAX_ACTIVE_METEORS - this._meteors.length;
    const n = Math.max(0, Math.min(Math.round(count), room));
    for (let i = 0; i < n; i++) {
      const rand = this.rand;
      const travelDeg = TRAVEL_DEG_MIN + rand() * (TRAVEL_DEG_MAX - TRAVEL_DEG_MIN);
      const dirSign = rand() < 0.5 ? 1 : -1;
      const angleRad = ((dirSign > 0 ? travelDeg : 180 - travelDeg) * Math.PI) / 180;
      const speedFrac = SPEED_FRAC_MIN + rand() * (SPEED_FRAC_MAX - SPEED_FRAC_MIN);
      this._meteors.push({
        launchInMs: i * STAGGER_BASE_MS * (1 - STAGGER_JITTER + rand() * STAGGER_JITTER * 2),
        ageMs: 0,
        lifeMs: LIFE_MS_MIN + rand() * (LIFE_MS_MAX - LIFE_MS_MIN),
        xFrac: 0.08 + rand() * 0.84,
        yFrac: 0.04 + rand() * 0.30, // upper sky band, above where the mountain layers paint
        vxFrac: Math.cos(angleRad) * speedFrac,
        vyFrac: Math.sin(angleRad) * speedFrac,
        hue: achromatic ? 0 : hue,
        hueJitter: achromatic ? 0 : (rand() * 2 - 1) * 10,
        achromatic,
        phase: rand() * Math.PI * 2,
        trail: [],
        _sinceSampleMs: 0,
      });
    }
  }

  update(dtSec) {
    const dtMs = dtSec * 1000;
    for (const m of this._meteors) {
      if (m.launchInMs > 0) { m.launchInMs -= dtMs; continue; }
      m.ageMs += dtMs;
      m.xFrac += m.vxFrac * dtSec;
      m.yFrac += m.vyFrac * dtSec;
      m._sinceSampleMs += dtMs;
      if (m._sinceSampleMs >= TRAIL_SAMPLE_MS) {
        m._sinceSampleMs = 0;
        m.trail.push({ x: m.xFrac, y: m.yFrac });
        if (m.trail.length > TRAIL_MAX_POINTS) m.trail.shift();
      }
    }
    this._meteors = this._meteors.filter((m) => m.launchInMs > 0 || m.ageMs < m.lifeMs);
  }

  draw(ctx, canvas, reducedFlash = false) {
    if (!this._meteors.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const m of this._meteors) {
      if (m.launchInMs > 0) continue; // still queued -- this is the stagger
      const fade = 1 - clamp01(m.ageMs / m.lifeMs);
      const hue = m.hue + m.hueJitter;
      const satGlow = m.achromatic ? 5 : 70, satCore = m.achromatic ? 6 : 85;
      const satHalo = m.achromatic ? 4 : 40, satHead = m.achromatic ? 3 : 20;
      const x = m.xFrac * canvas.width, y = m.yFrac * canvas.height;

      // Trail: soft wide glow underpass + bright thin core, same two-pass
      // technique as drawDeepSky's comet trail.
      const trail = m.trail;
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1], b = trail[i];
        const ax = a.x * canvas.width, ay = a.y * canvas.height;
        const bx = b.x * canvas.width, by = b.y * canvas.height;
        const u = i / trail.length;
        ctx.strokeStyle = `hsla(${hue}, ${satGlow}%, 80%, ${capFlashAlpha(0.5 * u * fade, reducedFlash)})`;
        ctx.lineWidth = 4.5 * u;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.strokeStyle = `hsla(${hue}, ${satCore}%, 92%, ${capFlashAlpha(0.9 * u * fade, reducedFlash)})`;
        ctx.lineWidth = 1.4 * u;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      }

      // Bright head: soft halo + hot core, gently twinkling.
      const twinkle = 0.85 + 0.15 * Math.sin(m.ageMs * 0.02 + m.phase);
      ctx.fillStyle = `hsla(${hue}, ${satHalo}%, 92%, ${capFlashAlpha(0.35 * fade * twinkle, reducedFlash)})`;
      ctx.beginPath(); ctx.arc(x, y, HEAD_GLOW_RADIUS_PX * 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `hsla(${hue}, ${satHead}%, 97%, ${capFlashAlpha(0.9 * fade * twinkle, reducedFlash)})`;
      ctx.beginPath(); ctx.arc(x, y, HEAD_GLOW_RADIUS_PX, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}
