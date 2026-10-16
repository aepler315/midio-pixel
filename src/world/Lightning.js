// Fractal lightning: the midpoint-displacement construction. Start with
// one segment from cloud to ground, then repeatedly split every segment
// at its midpoint and displace that midpoint sideways by a random amount
// that halves each generation -- the classic 1/f construction that makes
// coastlines, mountain profiles, and lightning all look "right". A few
// interior points spawn shorter side branches built the same way.
import { mulberry32 } from '../utils/math.js';
import { capFlashAlpha } from '../ui/Accessibility.js';

export function generateBolt(x0, y0, x1, y1, { displace = 70, detail = 6, branches = 3, rand = Math.random } = {}) {
  let pts = [{ x: x0, y: y0 }, { x: x1, y: y1 }];
  let d = displace;
  for (let iter = 0; iter < detail; iter++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      next.push({
        x: (a.x + b.x) / 2 + (rand() * 2 - 1) * d,
        y: (a.y + b.y) / 2 + (rand() * 2 - 1) * d * 0.35, // mostly lateral jitter
      }, b);
    }
    pts = next;
    d /= 2;
  }

  const sideBranches = [];
  for (let k = 0; k < branches; k++) {
    const i = 2 + Math.floor(rand() * (pts.length - 6));
    const root = pts[i];
    const dir = rand() < 0.5 ? -1 : 1;
    const len = 40 + rand() * 80;
    const end = { x: root.x + dir * len, y: root.y + len * (0.5 + rand() * 0.6) };
    let bp = [{ ...root }, end];
    let bd = displace * 0.3;
    for (let iter = 0; iter < Math.max(2, detail - 2); iter++) {
      const nb = [bp[0]];
      for (let j = 0; j < bp.length - 1; j++) {
        const a = bp[j], b = bp[j + 1];
        nb.push({ x: (a.x + b.x) / 2 + (rand() * 2 - 1) * bd, y: (a.y + b.y) / 2 + (rand() * 2 - 1) * bd * 0.35 }, b);
      }
      bp = nb;
      bd /= 2;
    }
    sideBranches.push(bp);
  }
  return { main: pts, branches: sideBranches };
}

const COOLDOWN_MS = 1800; // strikes more often
const BOLT_MS = 260;
const FLASH_DECAY_SEC = 0.16;

/** Owns strike timing + rendering. Triggered by heavy kicks in STORM. */
export class LightningFX {
  constructor(seed = 1) {
    this.rand = mulberry32((seed ^ 0xb01f) >>> 0 || 1);
    this._bolt = null;
    this._boltUntilMs = -Infinity;
    this._nextAllowedMs = 0;
    this.flash = 0;
  }

  maybeTrigger(nowMs, vel, canvasWidth, groundY) {
    if (vel < 0.66 || nowMs < this._nextAllowedMs) return;
    this.strike(nowMs, canvasWidth, groundY);
  }

  /** Unconditional strike. maybeTrigger above is the music-driven path and
   *  keeps its velocity threshold and cooldown; a conductor-cued bolt
   *  (ConductorTrack.js) is authored rather than inferred, so it goes
   *  through here and always lands -- otherwise a bolt written at a soft
   *  dynamic, or too soon after a previous one, would silently do nothing.
   *  Still arms the cooldown so a cue can't machine-gun the music path. */
  strike(nowMs, canvasWidth, groundY) {
    this._nextAllowedMs = nowMs + COOLDOWN_MS * (0.8 + this.rand() * 0.5);
    const x = canvasWidth * (0.15 + this.rand() * 0.7);
    this._bolt = generateBolt(x, -10, x + (this.rand() * 2 - 1) * 210, groundY, {
      displace: 82, detail: 6, branches: 3 + Math.floor(this.rand() * 2), rand: this.rand,
    });
    this._boltUntilMs = nowMs + BOLT_MS;
    this.flash = 1;
  }

  update(dtSec) {
    this.flash = Math.max(0, this.flash - dtSec / FLASH_DECAY_SEC);
  }

  draw(ctx, canvas, nowMs, reducedFlash = false) {
    if (this.flash > 0.01) {
      ctx.save();
      ctx.globalAlpha = capFlashAlpha(0.30 * this.flash, reducedFlash);
      ctx.fillStyle = '#dfe9ff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
    if (!this._bolt || nowMs > this._boltUntilMs) return;
    const life = Math.max(0, Math.min(1, (this._boltUntilMs - nowMs) / BOLT_MS)); // 1 at strike -> 0 at expiry
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#eaf2ff';
    ctx.lineCap = 'round';
    for (const [pts, lw, alpha] of [[this._bolt.main, 2.6, 0.95], ...this._bolt.branches.map((b) => [b, 1.3, 0.6])]) {
      ctx.lineWidth = lw;
      ctx.globalAlpha = capFlashAlpha(alpha * (0.35 + 0.65 * life), reducedFlash);
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        if (i === 0) ctx.moveTo(pts[i].x, pts[i].y); else ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
