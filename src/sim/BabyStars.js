// Three baby stars — miniatures of Midasus's hexagram — who treat her as a
// secure base in the attachment-theory sense: they orbit close, and when the
// world feels safe (a calm stretch) exactly one at a time ventures out to
// explore, glancing home the whole way. The moment the song turns loud, or a
// trip runs its course, they rush back to the nest.
//
// They are HYPER CURIOUS: the explorer ventures readily and often, ranges
// far, lingers on whatever's interesting, and hops between points of interest
// mid-trip (Midio, Broshi, obstacles, and — because they are aware of the
// user — the mouse cursor). They render at the same visualization intensity
// as the three main characters (spectral glow halo, a stardust trail, and a
// pulse that breathes with Midasus's own note onsets). And they know what
// they are: every so often one whispers a small fourth-wall line — aware it
// is a digital artifact, and aware of the person watching.
//
// Pure logic apart from draw(); the secure-base state machine is unit-tested.
import { BABY_STAR_MESH } from '../render/meshes.js';
import { computeRestLengths, drawMeshPart, drawGlowHalo } from '../render/MeshDrawer.js';
import { ObjectPool } from '../utils/ObjectPool.js';
import { clamp, mulberry32 } from '../utils/math.js';

export const BABY_COUNT = 3;
export const NEST_RADIUS = 22;
const EXPLORE_RANGE = 230;       // how far a trip may roam (hyper curious: was 170)
const EXPLORE_MIN_CALM = 0.24;   // ventures more readily than before (was 0.3)
const RECALL_CALM = 0.15;        // below this the song is loud: everyone home
const TRIP_MIN_SEC = 2.6, TRIP_MAX_SEC = 6.0;   // longer trips (was 2.2..4.6)
const COOLDOWN_MIN_SEC = 0.5, COOLDOWN_MAX_SEC = 1.8; // barely rests (was 1.5..4)
const RETARGET_CHANCE_PER_SEC = 0.9; // mid-trip, this often re-aims at a fresh POI
const HOME_EPS = 12;             // close enough to the nest slot to re-latch
const KP = 55, KD = 9;


export class BabyStars {
  constructor(seed = 99) {
    this.rand = mulberry32(seed);
    this.stars = Array.from({ length: BABY_COUNT }, (_, i) => ({
      state: 'nest', // 'nest' | 'explore' | 'return'
      x: 0, y: 0, vx: 0, vy: 0,
      slotPhase: (i / BABY_COUNT) * Math.PI * 2, // nest orbit slot
      orbitHz: 0.30 + 0.14 * this.rand(),        // a touch quicker/eager than before
      bobPhase: this.rand() * Math.PI * 2,
      spin: this.rand() * Math.PI * 2,
      spinHz: (0.5 + 0.6 * this.rand()) * (this.rand() < 0.5 ? -1 : 1),
      cooldownSec: 0.5 + 1.5 * this.rand(),
      tripSec: 0,
      tripEndSec: 0,
      target: { x: 0, y: 0 },
      placed: false,
    }));
    this._t = 0;
    this._nowMs = 0;
    this._pulse = 1;
    this._epic = 0;
    this._poi = null; // the point the nest is currently "peering" toward (render lean)
    this._pointer = null;

    // Same visualization intensity as the mains: a stardust trail off each
    // moving star, additive and fading.
    this.trail = new ObjectPool(() => ({}), (o, init) => Object.assign(o, init, { age: 0 }), 240);
    this._emitAccum = 0;

  }

  get explorer() {
    return this.stars.find((s) => s.state === 'explore' || s.state === 'return') || null;
  }

  _slot(star, base) {
    const a = star.slotPhase + this._t * star.orbitHz * Math.PI * 2;
    return {
      x: base.x + NEST_RADIUS * Math.cos(a),
      y: base.y + NEST_RADIUS * 0.7 * Math.sin(a) + 2.5 * Math.sin(this._t * 2.1 + star.bobPhase),
    };
  }

  /** Pick a point of interest to venture toward: the pointer (when the user
   *  is present -- they're curious about the visitor) or a random one of the
   *  passed interests, else null (wander around the base). */
  _pickPoi(interests, pointer) {
    if (pointer && pointer.active && this.rand() < 0.5) return { x: pointer.x, y: pointer.y };
    if (interests && interests.length) return interests[Math.floor(this.rand() * interests.length)];
    return null;
  }

  /**
   * @param {{x:number,y:number}} base Midasus's position — the secure base
   * @param {number} calmLevel 0..1, 1 = calm (CalmDirector.level)
   * @param {object} ctx { epic, melt, pulse, interests:[{x,y}], pointer:{x,y,active} }
   */
  update(nowMs, dtSec, base, calmLevel = 0, ctx = {}) {
    this._t += dtSec;
    this._nowMs = nowMs;
    const { epic = 0, pulse = 1, interests = [], pointer = null } = ctx || {};
    this._epic = epic;
    this._pointer = pointer;
    this._pulse += (pulse - this._pulse) * Math.min(1, dtSec / 0.1);

    // What the nest peers toward: the pointer if the user's around, else the
    // first interest (usually Midio). Render-only lean; never moves star.x/y.
    this._poi = (pointer && pointer.active) ? { x: pointer.x, y: pointer.y }
      : (interests && interests.length ? interests[0] : null);

    const loud = calmLevel < RECALL_CALM;
    for (const star of this.stars) {
      if (!star.placed) { // first frame: materialize on the nest slot
        const s = this._slot(star, base);
        star.x = s.x; star.y = s.y; star.placed = true;
      }
      star.spin += star.spinHz * dtSec * Math.PI * 2;

      if (star.state === 'nest') {
        star.cooldownSec -= dtSec;
        // Secure base: still exactly one venture at a time -- but it happens
        // readily and often (hyper curious).
        const mayExplore = !this.explorer && calmLevel >= EXPLORE_MIN_CALM && star.cooldownSec <= 0;
        if (mayExplore) {
          star.state = 'explore';
          star.tripSec = 0;
          star.tripEndSec = TRIP_MIN_SEC + (TRIP_MAX_SEC - TRIP_MIN_SEC) * this.rand();
          star.target = this._exploreTarget(base, interests, pointer);
        }
      } else if (star.state === 'explore') {
        star.tripSec += dtSec;
        // Hyper-curious wander: the target drifts, and now and then the
        // explorer re-aims at a completely fresh point of interest mid-trip.
        star.target.x += 22 * dtSec * Math.sin(this._t * 1.7 + star.bobPhase);
        star.target.y += 16 * dtSec * Math.cos(this._t * 1.3 + star.bobPhase);
        if (!loud && this.rand() < RETARGET_CHANCE_PER_SEC * dtSec) {
          star.target = this._exploreTarget(base, interests, pointer);
        }
        if (loud || star.tripSec >= star.tripEndSec) star.state = 'return';
      } else if (star.state === 'return') {
        const s = this._slot(star, base);
        if (Math.hypot(star.x - s.x, star.y - s.y) < HOME_EPS) {
          star.state = 'nest';
          star.cooldownSec = COOLDOWN_MIN_SEC + (COOLDOWN_MAX_SEC - COOLDOWN_MIN_SEC) * this.rand();
        }
      }

      const goal = star.state === 'explore' ? star.target : this._slot(star, base);
      // Returning home under a loud sky is urgent; exploring is a saunter.
      const urgency = star.state === 'return' && loud ? 2.2 : star.state === 'explore' ? 0.6 : 1;
      star.vx += (KP * urgency * (goal.x - star.x) - KD * star.vx) * dtSec;
      star.vy += (KP * urgency * (goal.y - star.y) - KD * star.vy) * dtSec;
      star.x += star.vx * dtSec;
      star.y += star.vy * dtSec;
    }

    this._updateTrail(dtSec);
  }

  /** A fresh exploration target near a chosen point of interest (or wandering
   *  around the base when there's nothing to chase). */
  _exploreTarget(base, interests, pointer) {
    const poi = this._pickPoi(interests, pointer);
    const ax = poi ? base.x * 0.35 + poi.x * 0.65 : base.x;
    const ay = poi ? base.y * 0.45 + poi.y * 0.55 : base.y;
    const ang = this.rand() * Math.PI * 2;
    const reach = EXPLORE_RANGE * (0.45 + 0.55 * this.rand());
    return { x: ax + Math.cos(ang) * reach, y: ay + Math.sin(ang) * reach * 0.6 };
  }

  _updateTrail(dtSec) {
    // Emit from each moving star -- explorers stream more than nesters.
    for (const star of this.stars) {
      const speed = Math.hypot(star.vx, star.vy);
      const rate = (star.state === 'nest' ? 0.6 : 3) * Math.min(1, speed / 120) + 0.15;
      this._emitAccum += rate * dtSec * 60;
      while (this._emitAccum >= 1) {
        this._emitAccum -= 1;
        this.trail.spawn({ x: star.x, y: star.y, life: 0.3 + 0.25 * this.rand() });
      }
    }
    this.trail.step(dtSec, (o, dt) => { o.age += dt; return o.age < o.life; });
  }

  draw(ctx, hue, rest = 0) {
    if (!this._meshRest) this._meshRest = computeRestLengths(BABY_STAR_MESH);
    const sat = Math.round(52 - 22 * rest);
    const pulse = this._pulse;
    const epic = this._epic || 0;

    // Stardust trail (behind the cores), additive like Midasus's ribbon.
    if (this.trail.active.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const p of this.trail.active) {
        const u = p.age / p.life;
        ctx.fillStyle = `hsla(${hue},${sat}%,74%,${((1 - u) * 0.55).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8 * (1 - u), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    this.stars.forEach((star, i) => {
      const h = (hue + 24 * (i - 1) + 360) % 360;
      const away = star.state !== 'nest';
      // A nesting star "peers" toward whatever the nest is curious about --
      // a small render-only lean (a few px), never touching its physics.
      let dx = 0, dy = 0;
      if (!away && this._poi) {
        const px = this._poi.x - star.x, py = this._poi.y - star.y;
        const d = Math.hypot(px, py) || 1;
        dx = (px / d) * 5; dy = (py / d) * 5;
      }
      const cx = star.x + dx, cy = star.y + dy;

      // Same visualization intensity as the mains: a spectral glow halo that
      // breathes with Midasus's pulse and swells with the song's epic-ness.
      const glowR = (away ? 13 : 10) * pulse * (1 + 0.3 * epic);
      drawGlowHalo(ctx, cx, cy, glowR, glowR, h, 0.4 + 0.35 * epic, { sat, light: 80 });

      const scale = (away ? 1.15 : 1) * pulse;
      drawMeshPart(ctx, BABY_STAR_MESH, this._meshRest, {
        tx: cx, ty: cy, rot: star.spin, scaleX: scale, scaleY: scale,
      }, h, { satBase: sat, lightBase: 76, alpha: away ? 0.95 : 0.82, widthBase: 1.3, outline: true });
    });

    // Fourth-wall whisper text overlay removed (was drawing lines like
    // "i can feel the framerate" over the stage).
  }
}
