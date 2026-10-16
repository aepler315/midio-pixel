// Far-distance vignettes: every so often, way out between the farthest
// ranges, something strange is quietly going on -- aliens having dinner
// under their parked saucer, two robots slow-dancing, a whale surfacing
// from the cloud sea, a lantern-city turtle on its way somewhere, an
// observatory tracking the celestial. Haze-tinted silhouettes at a deep
// parallax ratio, partially occluded by the nearer ranges, with tiny
// beat-linked motion so they live in the same music as everything else.
//
// Placement is seeded per song on a sector grid of SCROLLED space, so the
// same file always hides the same scenes in the same places -- something
// to point at on a replay: "the aliens are just past the second drop."
import { mulberry32, hashSeed, clamp01 } from '../utils/math.js';
import { hexLerp } from '../utils/color.js';

export const VIGNETTE_RATIO = 0.13;   // parallax: between L2 (0.10) and L3 (0.18)
export const SECTOR_PX = 1000;        // sector length in scrolled space
export const VIGNETTE_CHANCE = 0.5;   // fraction of sectors that host a scene
const KINDS = ['alienDinner', 'robotSlowDance', 'cloudWhale', 'lanternTurtle', 'observatory'];
// The saucer dinner is the star of the far distance -- weighted up.
const KIND_WEIGHTS = [0.3, 0.175, 0.175, 0.175, 0.175];

/** What (if anything) lives in one sector. Pure + deterministic:
 *  {kind, offset01, flip, seed} or null. */
export function vignetteForSector(songSeed, sectorIdx) {
  if (sectorIdx < 1) return null; // never inside the opening screenful
  const rand = mulberry32(hashSeed(`${songSeed}:vignette:${sectorIdx}`));
  if (rand() >= VIGNETTE_CHANCE) return null;
  let pick = rand(), kind = KINDS[KINDS.length - 1];
  for (let i = 0; i < KINDS.length; i++) {
    if (pick < KIND_WEIGHTS[i]) { kind = KINDS[i]; break; }
    pick -= KIND_WEIGHTS[i];
  }
  return {
    kind,
    offset01: 0.15 + rand() * 0.7, // where in the sector it stands
    flip: rand() < 0.5,
    seed: Math.floor(rand() * 0xffffffff),
  };
}

export class FarVignettes {
  constructor(songSeed) {
    this.songSeed = songSeed;
    this._cache = new Map(); // sectorIdx -> vignette|null
  }

  _sector(idx) {
    if (!this._cache.has(idx)) this._cache.set(idx, vignetteForSector(this.songSeed, idx));
    return this._cache.get(idx);
  }

  /**
   * Draw every vignette currently on screen. `env`: {tSec, kick (0..1
   * layer-delayed kickEnv), silhouette, sky, halo (hex)}.
   */
  draw(ctx, canvas, worldX, env) {
    const scroll = worldX * VIGNETTE_RATIO;
    const first = Math.floor((scroll - 300) / SECTOR_PX);
    const last = Math.floor((scroll + canvas.width + 300) / SECTOR_PX);
    for (let idx = first; idx <= last; idx++) {
      const v = this._sector(idx);
      if (!v) continue;
      const x = idx * SECTOR_PX + v.offset01 * SECTOR_PX - scroll;
      this._drawOne(ctx, canvas, v, x, env);
    }
  }

  _drawOne(ctx, canvas, v, x, env) {
    // Far things sit in the air: body color is the silhouette pulled well
    // toward the sky, accents are the halo at low alpha. Cached on the
    // color pair -- it only changes when the palette does, not per frame.
    if (!this._bodyCache || this._bodyCache.key !== env.silhouette + env.sky) {
      this._bodyCache = { key: env.silhouette + env.sky, body: hexLerp(env.silhouette, env.sky, 0.45) };
    }
    const body = this._bodyCache.body;
    const baseY = canvas.height * 0.565; // just above where L4/L5 ridges rise
    ctx.save();
    ctx.translate(x, baseY);
    if (v.flip) ctx.scale(-1, 1);
    ctx.globalAlpha = 0.85;
    switch (v.kind) {
      case 'alienDinner': this._alienDinner(ctx, v, body, env); break;
      case 'robotSlowDance': this._robotSlowDance(ctx, v, body, env); break;
      case 'cloudWhale': this._cloudWhale(ctx, v, body, env); break;
      case 'lanternTurtle': this._lanternTurtle(ctx, v, body, env); break;
      case 'observatory': this._observatory(ctx, v, body, env); break;
      default: break;
    }
    ctx.restore();
  }

  /** Three aliens at a long table, saucer parked overhead, candle lit.
   *  One raises a fork right on the kick. */
  _alienDinner(ctx, v, body, env) {
    const { tSec, kick, halo } = env;
    ctx.fillStyle = body;
    ctx.strokeStyle = body;
    // Parked saucer hovering above the table, bobbing a breath.
    const bobY = -46 + Math.sin(tSec * 0.7 + v.seed) * 1.5;
    ctx.beginPath();
    ctx.ellipse(6, bobY, 26, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(6, bobY - 4, 9, Math.PI, Math.PI * 2);
    ctx.fill();
    // A soft beam anchoring it to the party.
    ctx.save();
    ctx.globalAlpha = 0.10 + 0.05 * Math.sin(tSec * 1.3);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.moveTo(-2, bobY + 4); ctx.lineTo(14, bobY + 4);
    ctx.lineTo(22, 0); ctx.lineTo(-10, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // The table.
    ctx.fillRect(-16, -13, 44, 2.5);
    ctx.fillRect(-13, -11, 2, 11);
    ctx.fillRect(23, -11, 2, 11);
    // Three diners: teardrop bodies, big heads, antennae.
    for (let i = 0; i < 3; i++) {
      const ax = -10 + i * 16;
      const sway = Math.sin(tSec * 1.1 + i * 2.1) * 0.8;
      ctx.beginPath();
      ctx.ellipse(ax + sway * 0.3, -17, 3.2, 4.4, 0, 0, Math.PI * 2); // body
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ax + sway * 0.5, -24, 3.4, 0, Math.PI * 2); // head
      ctx.fill();
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(ax + sway * 0.5, -27);
      ctx.lineTo(ax + sway, -30);
      ctx.stroke();
      // Antenna tip glows in halo color.
      ctx.save();
      ctx.fillStyle = halo;
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(tSec * 2 + i);
      ctx.fillRect(ax + sway - 0.8, -31, 1.6, 1.6);
      ctx.restore();
      // The middle alien's fork arm rises exactly on the kick.
      if (i === 1) {
        const lift = 5 * kick;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(ax + 3, -19);
        ctx.lineTo(ax + 7, -21 - lift);
        ctx.stroke();
        ctx.fillRect(ax + 6.2, -23.5 - lift, 1.6, 2.5); // the fork
      }
    }
    // Candle: a warm flickering point on the table.
    ctx.fillRect(5, -16, 1.4, 3);
    ctx.save();
    ctx.fillStyle = halo;
    ctx.globalAlpha = 0.55 + 0.3 * Math.sin(tSec * 9 + v.seed);
    ctx.beginPath();
    ctx.arc(5.7, -17.5, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Two boxy robots, arms joined, swaying at slow-dance tempo; a tiny
   *  heart blinks above them. */
  _robotSlowDance(ctx, v, body, env) {
    const { tSec, halo } = env;
    const sway = Math.sin(tSec * 0.9 + v.seed) * 0.1;
    ctx.fillStyle = body;
    for (const [dx, dir] of [[-7, 1], [7, -1]]) {
      ctx.save();
      ctx.translate(dx, 0);
      ctx.rotate(sway * dir);
      ctx.fillRect(-4, -22, 8, 13);   // torso
      ctx.fillRect(-3, -29, 6, 6);    // head
      ctx.fillRect(-3, -9, 2.4, 9);   // legs
      ctx.fillRect(0.6, -9, 2.4, 9);
      // A single lit eye each, facing the partner.
      ctx.fillStyle = halo;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(dir > 0 ? 0.6 : -1.8, -27, 1.4, 1.4);
      ctx.restore();
    }
    // Joined arms.
    ctx.strokeStyle = body;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-3, -18);
    ctx.quadraticCurveTo(0, -15 + sway * 8, 3, -18);
    ctx.stroke();
    // The heart: blinks on the sway's beat.
    const beat = 0.5 + 0.5 * Math.sin(tSec * 1.8 + v.seed);
    if (beat > 0.55) {
      ctx.save();
      ctx.fillStyle = halo;
      ctx.globalAlpha = 0.7 * (beat - 0.55) / 0.45;
      ctx.translate(0, -36 - beat * 2);
      ctx.beginPath();
      ctx.arc(-1.2, 0, 1.5, 0, Math.PI * 2);
      ctx.arc(1.2, 0, 1.5, 0, Math.PI * 2);
      ctx.moveTo(-2.6, 0.8); ctx.lineTo(0, 3.6); ctx.lineTo(2.6, 0.8);
      ctx.fill();
      ctx.restore();
    }
  }

  /** A whale arcing out of the cloud sea, spout puffing on the kick. */
  _cloudWhale(ctx, v, body, env) {
    const { tSec, kick, sky } = env;
    const breach = Math.sin(tSec * 0.35 + v.seed) * 4;
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(-34, 0);
    ctx.quadraticCurveTo(-10, -26 - breach, 18, -8);
    ctx.quadraticCurveTo(24, -4, 30, -10 - breach * 0.5); // tail rise
    ctx.lineTo(34, -2);
    ctx.quadraticCurveTo(26, 2, 18, 0);
    ctx.closePath();
    ctx.fill();
    // Fluke.
    ctx.beginPath();
    ctx.moveTo(30, -10 - breach * 0.5);
    ctx.lineTo(38, -16 - breach * 0.5);
    ctx.lineTo(36, -6 - breach * 0.3);
    ctx.closePath();
    ctx.fill();
    // Eye.
    ctx.fillStyle = sky;
    ctx.beginPath();
    ctx.arc(-20, -10 - breach * 0.7, 1.2, 0, Math.PI * 2);
    ctx.fill();
    // Spout on the kick: a little fountain of sky.
    if (kick > 0.05) {
      ctx.save();
      ctx.strokeStyle = sky;
      ctx.globalAlpha = 0.7 * kick;
      ctx.lineWidth = 1.2;
      for (const a of [-0.5, 0, 0.5]) {
        ctx.beginPath();
        ctx.moveTo(-14, -22 - breach);
        ctx.quadraticCurveTo(-14 + a * 4, -30 - breach - 5 * kick, -14 + a * 7, -27 - breach);
        ctx.stroke();
      }
      ctx.restore();
    }
    // The cloud sea it swims in.
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = sky;
    ctx.beginPath();
    ctx.ellipse(-6, 2, 46, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** A great turtle carrying a tiny lantern city on its shell. */
  _lanternTurtle(ctx, v, body, env) {
    const { tSec, halo } = env;
    const step = Math.sin(tSec * 0.8 + v.seed);
    ctx.fillStyle = body;
    // Shell.
    ctx.beginPath();
    ctx.arc(0, -8, 20, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    // Head + legs, plodding.
    ctx.beginPath();
    ctx.arc(-24, -7 + step * 0.8, 4, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 3; i++) {
      const lx = -12 + i * 11;
      ctx.fillRect(lx + (i % 2 === 0 ? step : -step) * 1.2, -8, 4, 8);
    }
    // The city: three little houses, windows lit in halo color.
    for (const [hx, hw, hh] of [[-11, 7, 8], [-1, 8, 12], [9, 6, 7]]) {
      ctx.fillRect(hx, -8 - 14 - hh + 14, hw, hh); // house body above the shell crown
      ctx.beginPath(); // roof
      ctx.moveTo(hx - 1, -8 - hh);
      ctx.lineTo(hx + hw / 2, -12 - hh);
      ctx.lineTo(hx + hw + 1, -8 - hh);
      ctx.closePath();
      ctx.fill();
      ctx.save();
      ctx.fillStyle = halo;
      ctx.globalAlpha = 0.6 + 0.25 * Math.sin(tSec * 1.5 + hx);
      ctx.fillRect(hx + hw / 2 - 1, -5 - hh, 2, 2.4);
      ctx.restore();
    }
    // A lantern swinging from a pole at the bow.
    ctx.strokeStyle = body;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-18, -26);
    ctx.lineTo(-24, -30 + step);
    ctx.stroke();
    ctx.save();
    ctx.fillStyle = halo;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.arc(-24.5, -28 + step, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** An observatory dome; the telescope nods toward the sky on the kick. */
  _observatory(ctx, v, body, env) {
    const { tSec, kick, halo } = env;
    ctx.fillStyle = body;
    // Base + dome.
    ctx.fillRect(-12, -12, 24, 12);
    ctx.beginPath();
    ctx.arc(0, -12, 12, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    // The slit glows faintly -- somebody's working late.
    ctx.save();
    ctx.fillStyle = halo;
    ctx.globalAlpha = 0.35 + 0.15 * Math.sin(tSec * 0.9 + v.seed);
    ctx.fillRect(-1.5, -23.5, 3, 11);
    ctx.restore();
    // Telescope tube poking from the slit, nodding up on kicks.
    const aim = -0.9 - 0.25 * kick;
    ctx.save();
    ctx.translate(0, -16);
    ctx.rotate(aim);
    ctx.fillRect(0, -1.6, 15, 3.2);
    ctx.restore();
    // A dish on the lawn tilts with the same nod.
    ctx.beginPath();
    ctx.ellipse(19, -3, 4.5, 2 + kick, -0.5 - 0.3 * kick, 0, Math.PI * 2);
    ctx.fill();
  }
}
