// The opening's visual counterpart to FractureEngine's finale shatter: the
// same Delaunay-triangulated glass-shard language, run in reverse. Instead
// of a frozen frame exploding apart at the song's last note, a frame
// captured a beat into the very first one reassembles itself from shards
// scattered around the screen -- the world visibly piecing itself together
// as the song begins, not just fading or cutting in.
//
// The live game renders normally underneath the whole time (this never
// freezes it the way the finale does) -- the overlay is purely decorative,
// drawn on top and then dissolved away once the shards land, revealing
// whatever the actually-live frame looks like by then.
import { clamp01, mulberry32, hashSeed, lerp, smoothstep } from '../utils/math.js';
import { delaunayTriangulate, poissonDiscSample } from '../utils/delaunay.js';
import { ObjectPool } from '../utils/ObjectPool.js';

const CAPTURE_DELAY_MS = 200;   // let one real frame render before grabbing it as the target
const STAGGER_MAX_MS = 150;     // outermost shards start their travel this much later than the center
const BURST_MS = 650;           // each shard's own scattered -> landed travel time
const HOLD_MS = 90;             // a brief hold once every shard has landed, fully formed
const REVEAL_MS = 380;          // the assembled overlay's own fade, revealing the live game beneath
export const ASSEMBLE_TOTAL_MS = STAGGER_MAX_MS + BURST_MS + HOLD_MS + REVEAL_MS;
const SCATTER_MIN_PX = 150, SCATTER_MAX_PX = 320;
const MAX_ROT = Math.PI * 0.55;

/** Pure ease: 0 until this shard's own start delay, then a smoothstep
 *  scatter-to-landed envelope over BURST_MS. */
export function assembleMotionU(ageMs, delayMs) {
  if (ageMs < delayMs) return 0;
  return smoothstep(delayMs, delayMs + BURST_MS, ageMs);
}

/** Pure envelope: the fully-assembled overlay's own alpha -- opaque through
 *  the whole burst + a short hold, then eases to 0 to reveal the live frame
 *  underneath. Independent of any one shard's stagger. */
export function assembleFadeAlpha(ageMs) {
  const revealStart = STAGGER_MAX_MS + BURST_MS + HOLD_MS;
  if (ageMs < revealStart) return 1;
  return 1 - smoothstep(revealStart, revealStart + REVEAL_MS, ageMs);
}

export class WorldAssembly {
  constructor({ canvasWidth, canvasHeight, songSeed }) {
    this.w = canvasWidth;
    this.h = canvasHeight;
    this.songSeed = songSeed;
    this.state = 'waiting'; // waiting | assembling | done
    this._captureAtMs = CAPTURE_DELAY_MS;
    this.startMs = null;
    this.frame = null;
    this.fragments = new ObjectPool(() => ({}), (o, i) => Object.assign(o, i), 256);
  }

  get active() { return this.state !== 'done'; }

  /** True exactly once: the frame Renderer should grab as the assembly
   *  target. Renderer calls this right after the world+characters are
   *  composited (before post-FX/HUD), so the captured image is the clean
   *  scene, not last frame's bloom/vignette or a stale HUD strip. */
  wantsCapture(nowMs) {
    this.update(nowMs);
    if (this.state !== 'waiting') return false;
    return nowMs >= this._captureAtMs;
  }

  /** Grabs `sourceCanvas` (the REAL backing store -- device pixels, not the
   *  logical stage view) as the assembly target and triangulates it into
   *  shards, each starting scattered outward from screen center along its
   *  own home position's radial line -- a reverse of the finale's own
   *  explode-outward-from-center burst. */
  captureFrame(sourceCanvas, nowMs) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(this.w, this.h) : document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    const fctx = c.getContext('2d');
    fctx.drawImage(sourceCanvas, 0, 0, this.w, this.h);
    this.frame = c;
    this.startMs = nowMs;
    this.state = 'assembling';
    this._triangulate();
  }

  _triangulate() {
    const rand = mulberry32(hashSeed(`${this.songSeed}:assembly`));
    const interior = poissonDiscSample(this.w, this.h, 78, rand);
    const corners = [{ x: 0, y: 0 }, { x: this.w, y: 0 }, { x: this.w, y: this.h }, { x: 0, y: this.h }];
    const points = [...interior, ...corners];
    const tris = delaunayTriangulate(points);
    const screenCx = this.w / 2, screenCy = this.h / 2;
    const maxDist = Math.hypot(this.w, this.h) / 2;

    for (const t of tris) {
      const a = points[t[0]], b = points[t[1]], c = points[t[2]];
      const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3;
      let dx = cx - screenCx, dy = cy - screenCy;
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-6) { dx /= dist; dy /= dist; } else { const a0 = rand() * Math.PI * 2; dx = Math.cos(a0); dy = Math.sin(a0); }
      const scatter = SCATTER_MIN_PX + rand() * (SCATTER_MAX_PX - SCATTER_MIN_PX) + dist * 0.35;
      this.fragments.spawn({
        tri: [{ x: a.x - cx, y: a.y - cy }, { x: b.x - cx, y: b.y - cy }, { x: c.x - cx, y: c.y - cy }],
        cx, cy,
        startX: cx + dx * scatter, startY: cy + dy * scatter,
        startRot: (rand() * 2 - 1) * MAX_ROT,
        delayMs: (dist / maxDist) * STAGGER_MAX_MS,
      });
    }
  }

  /** Advances state (Simulation calls this once per step). Purely a
   *  clock -- the actual shard positions are computed fresh in draw() from
   *  age, so a render call between two update()s never desyncs. */
  update(nowMs) {
    // A seek/export may never draw the opening. Its lifetime belongs to the
    // song clock, so a first draw minutes later cannot start it again.
    if ((this.state === 'waiting' && nowMs >= CAPTURE_DELAY_MS + ASSEMBLE_TOTAL_MS)
      || (this.state === 'assembling' && nowMs - this.startMs >= ASSEMBLE_TOTAL_MS)) {
      this.state = 'done';
      this.frame = null;
      this.fragments.clear();
    }
  }

  draw(ctx, nowMs) {
    if (this.state !== 'assembling' || !this.frame) return;
    const ageMs = nowMs - this.startMs;
    const fadeAlpha = assembleFadeAlpha(ageMs);
    if (fadeAlpha <= 0.003) return;

    ctx.save();
    ctx.globalAlpha = fadeAlpha;
    for (const f of this.fragments.active) {
      const u = assembleMotionU(ageMs, f.delayMs);
      const eased = 1 - (1 - u) ** 3; // ease-out: fast start, settling into place
      const x = lerp(f.startX, f.cx, eased);
      const y = lerp(f.startY, f.cy, eased);
      const rot = lerp(f.startRot, 0, eased);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(f.tri[0].x, f.tri[0].y);
      ctx.lineTo(f.tri[1].x, f.tri[1].y);
      ctx.lineTo(f.tri[2].x, f.tri[2].y);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(this.frame, -f.cx, -f.cy);
      ctx.restore();
    }
    ctx.restore();
  }
}
