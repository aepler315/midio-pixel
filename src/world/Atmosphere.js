// The Wind (Movement II): every particle system used to drift in its own
// private noise. A single global weather field unifies the whole frame's
// motion instead -- one slow curl-noise gust plus a smaller positional
// detail term. Callers sample W(x,y) once per system per frame (not per
// particle) and apply the returned px/s vector to their own particles.
import { curl2 } from '../utils/fields.js';
import { clamp01 } from '../utils/math.js';

const ENERGY_TAU_SEC = 3; // gusts build and fade over seconds, not beats
const GLOBAL_SCALE = 0.00028; // very low spatial frequency: one weather system spans the whole stage
const DETAIL_SCALE = 0.0022;
const DETAIL_WEIGHT = 0.35;
const BASE_GUST_PX_S = 64; // stronger weather -- particles and drift gust harder
// A prevailing bias on top of the curl swirl: without it, rain/embers/smoke
// drift in a soft eddy with no consistent lean, which reads as aimless
// rather than "weather coming from somewhere." The bias itself drifts very
// slowly (a full rotation takes minutes), so within any one song it reads
// as a fixed direction, not a spinning weathervane.
const PREVAILING_ROTATE_HZ = 1 / 240; // one full revolution per ~4 minutes
const PREVAILING_WEIGHT = 0.8; // relative to the curl swirl's own gustMag

export class Atmosphere {
  constructor(seed = 0) {
    this._ox = (seed % 997) * 3.7;
    this._oz = (seed % 991) * 1.9 + 250;
    this.energyEMA = 0;
    this.turbulence = 1; // the biome personality's dial, set by the caller each frame
    this.tSec = 0;
    // A per-instance phase so different songs don't all lean the same way.
    this._prevailingPhase = ((seed % 1000) / 1000) * Math.PI * 2;
  }

  update(dtSec, energyInstant = 0) {
    this.tSec += dtSec;
    const alpha = 1 - Math.exp(-dtSec / ENERGY_TAU_SEC);
    this.energyEMA += alpha * (clamp01(energyInstant) - this.energyEMA);
  }

  /** The prevailing direction right now, radians -- 0 = blowing due +x.
   *  Exposed so callers that want a consistent "which way is the wind
   *  blowing" (wildfire spread, precipitation streak angle) don't have to
   *  re-derive it from at()'s combined vector. */
  prevailingAngle() {
    return this._prevailingPhase + this.tSec * PREVAILING_ROTATE_HZ * 2 * Math.PI;
  }

  /** W(x,y,t): the wind vector (px/s) at a world position, right now. */
  at(x, y) {
    const gustMag = BASE_GUST_PX_S * (0.4 + 1.6 * this.energyEMA) * this.turbulence;
    const g = curl2(this._ox + x * GLOBAL_SCALE, this._oz + y * GLOBAL_SCALE, this.tSec * 0.05);
    const d = curl2(this._ox + 91.1 + x * DETAIL_SCALE, this._oz + y * DETAIL_SCALE, this.tSec * 0.35);
    const angle = this.prevailingAngle();
    const pMag = gustMag * PREVAILING_WEIGHT;
    return {
      x: (g.x + d.x * DETAIL_WEIGHT) * gustMag + Math.cos(angle) * pMag,
      y: (g.y + d.y * DETAIL_WEIGHT) * gustMag + Math.sin(angle) * pMag,
    };
  }
}
