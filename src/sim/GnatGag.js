// Gnat Attack, as a rare calm-section gag: after the music has been
// quiet for a few seconds, a lone fly wanders in and buzzes around the
// mid-sky on a curl-noise flight path. On the next kick after it has
// buzzed long enough, a chunky white pixel glove snaps in from the edge
// of the screen and SWATS it exactly on the beat -- impact star, the fly
// spirals down, the glove withdraws. Then a long cooldown so it stays a
// treat, not a loop. State machine: idle -> buzz -> swat -> fall -> idle.
import { mulberry32 } from '../utils/math.js';
import { curl2 } from '../utils/fields.js';

const ARM_CALM = 0.6;      // calm level required...
const ARM_SEC = 3;         // ...sustained this long before a fly dares enter
const BUZZ_MIN_MS = 2400;  // minimum buzzing before a swat is allowed
const SWAT_MS = 110;       // glove travel time: fast enough to feel on-beat
const FALL_MS = 900;
const COOLDOWN_MS = 25000;

const GLOVE_GRID = [
  '002222220000',
  '021111120000',
  '211111112000',
  '211111112220',
  '211111111112',
  '211111111112',
  '211111111112',
  '021111111120',
  '002111111200',
  '000222222000',
];
const GLOVE_PX = 3;

export class GnatGag {
  constructor(seed = 1, { canvasWidth = 1280, canvasHeight = 720 } = {}) {
    this.rand = mulberry32((seed ^ 0x6a47) >>> 0 || 1);
    this.w = canvasWidth;
    this.h = canvasHeight;
    this.state = 'idle';
    this._armSec = 0;
    this._cooldownUntilMs = 0;
    this.fly = { x: 0, y: 0, vx: 0, vy: 0, rot: 0 };
    this._buzzStartMs = 0;
    this._swatStartMs = 0;
    this._fallStartMs = 0;
    this._gloveFrom = { x: 0, y: 0 };
    this._gloveCanvas = null;
  }

  onKick(evt) {
    if (this.state === 'buzz' && evt.tMs - this._buzzStartMs >= BUZZ_MIN_MS) {
      this.state = 'swat';
      this._swatStartMs = evt.tMs;
      this._gloveFrom = { x: this.w + 60, y: this.fly.y - 40 - this.rand() * 60 };
    }
  }

  update(nowMs, dtSec, calmLevel) {
    if (this.state === 'idle') {
      this._armSec = calmLevel >= ARM_CALM ? this._armSec + dtSec : 0;
      if (this._armSec >= ARM_SEC && nowMs >= this._cooldownUntilMs) {
        this.state = 'buzz';
        this._buzzStartMs = nowMs;
        this.fly.x = this.w * (0.35 + this.rand() * 0.35);
        this.fly.y = this.h * (0.2 + this.rand() * 0.2);
        this.fly.vx = 0; this.fly.vy = 0;
      }
    } else if (this.state === 'buzz') {
      // Erratic flight: curl-noise wander plus a high-frequency buzz jitter.
      const flow = curl2(this.fly.x * 0.006, this.fly.y * 0.006, nowMs / 1000 * 0.5);
      this.fly.vx += (flow.x * 220 - this.fly.vx) * Math.min(1, dtSec * 3);
      this.fly.vy += (flow.y * 160 - this.fly.vy) * Math.min(1, dtSec * 3);
      this.fly.x += (this.fly.vx + Math.sin(nowMs * 0.09) * 24) * dtSec;
      this.fly.y += (this.fly.vy + Math.cos(nowMs * 0.075) * 18) * dtSec;
      this.fly.x = Math.max(this.w * 0.12, Math.min(this.w * 0.85, this.fly.x));
      this.fly.y = Math.max(this.h * 0.08, Math.min(this.h * 0.5, this.fly.y));
    } else if (this.state === 'swat') {
      if (nowMs - this._swatStartMs >= SWAT_MS) {
        this.state = 'fall';
        this._fallStartMs = nowMs;
        this.fly.vx = -40 - this.rand() * 40;
        this.fly.vy = 60;
      }
    } else if (this.state === 'fall') {
      this.fly.vy += 500 * dtSec;
      this.fly.x += this.fly.vx * dtSec;
      this.fly.y += this.fly.vy * dtSec;
      this.fly.rot += 9 * dtSec;
      if (nowMs - this._fallStartMs >= FALL_MS) {
        this.state = 'idle';
        this._armSec = 0;
        this._cooldownUntilMs = nowMs + COOLDOWN_MS;
      }
    }
  }

  _ensureGlove() {
    if (this._gloveCanvas) return;
    const c = document.createElement('canvas');
    c.width = GLOVE_GRID[0].length * GLOVE_PX;
    c.height = GLOVE_GRID.length * GLOVE_PX;
    const g = c.getContext('2d');
    for (let y = 0; y < GLOVE_GRID.length; y++) {
      for (let x = 0; x < GLOVE_GRID[y].length; x++) {
        const v = GLOVE_GRID[y][x];
        if (v === '0') continue;
        g.fillStyle = v === '2' ? '#2b2b34' : '#f6f4ee';
        g.fillRect(x * GLOVE_PX, y * GLOVE_PX, GLOVE_PX, GLOVE_PX);
      }
    }
    this._gloveCanvas = c;
  }

  draw(ctx, nowMs) {
    if (this.state === 'idle') return;
    this._ensureGlove();
    ctx.save();

    // The fly: a dark speck with two flickering wing dashes.
    const { x, y } = this.fly;
    if (this.state !== 'swat' || nowMs % 60 < 40) { // brief occlusion as the glove lands
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(this.fly.rot);
      ctx.fillStyle = '#1c1c22';
      ctx.fillRect(-2, -1.5, 4, 3);
      if (this.state === 'buzz') {
        ctx.strokeStyle = 'rgba(220,228,255,0.7)';
        ctx.lineWidth = 1;
        const w = Math.sin(nowMs * 0.12) > 0 ? 3.5 : 1.5; // wing blur alternation
        ctx.beginPath();
        ctx.moveTo(-1, -2); ctx.lineTo(-4, -2 - w);
        ctx.moveTo(1, -2); ctx.lineTo(4, -2 - w);
        ctx.stroke();
      }
      ctx.restore();
    }

    // The glove: swats in, holds a beat, withdraws during the fall.
    if (this.state === 'swat' || this.state === 'fall') {
      let gx, gy;
      if (this.state === 'swat') {
        const u = Math.min(1, (nowMs - this._swatStartMs) / SWAT_MS);
        const e = 1 - (1 - u) ** 3; // ease-out: it arrives with a snap
        gx = this._gloveFrom.x + (x - this._gloveFrom.x) * e;
        gy = this._gloveFrom.y + (y - 20 - this._gloveFrom.y) * e;
      } else {
        const u = Math.min(1, (nowMs - this._fallStartMs) / 300);
        gx = x + (this._gloveFrom.x - x) * u * u;
        gy = (y - 20) + (this._gloveFrom.y - (y - 20)) * u * u;
      }
      ctx.drawImage(this._gloveCanvas, Math.round(gx - 18), Math.round(gy - 15));

      // Impact star for the first 200ms after contact.
      const sinceHit = nowMs - (this._swatStartMs + SWAT_MS);
      if (sinceHit >= 0 && sinceHit < 200) {
        const a = 1 - sinceHit / 200;
        ctx.strokeStyle = `rgba(255,240,140,${a})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * Math.PI * 2 + 0.3;
          ctx.moveTo(x + Math.cos(ang) * 4, y + Math.sin(ang) * 4);
          ctx.lineTo(x + Math.cos(ang) * (12 + 8 * (1 - a)), y + Math.sin(ang) * (12 + 8 * (1 - a)));
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
