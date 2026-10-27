// Where the Trio cast goes between the beats. The music still owns what
// they DO (Midio's kick jumps, Broshi's bass hops, Midasus's melody darts,
// voyages and flourishes); this owns where they potter about while doing
// it: meandering to a new spot, stopping to idle, turning to watch a
// companion or the sky, wandering over to investigate one another.
//
// Everything here is a pure function of (seed, time, the song's energy
// curve): each character's life is cut into intent segments whose
// boundaries and choices are hashed from the seed and the segment index,
// and a position inside a segment is a closed-form ease from the previous
// segment's goal to this one's. Nothing integrates, so a seek lands on
// exactly the plan continuous play would have reached, and nothing draws
// from Math.random or the wall clock. The per-segment cache only skips
// recomputing what the same index always yields.
import { clamp, clamp01, smoothstep } from '../utils/math.js';

export const MIDIO = 0, BROSHI = 1, MIDASUS = 2;

/** What a character is paying attention to. */
export const Look = Object.freeze({
  FORWARD: 'forward', // where they are going
  SCAN: 'scan',       // idly looking around
  MIDIO: 'midio', BROSHI: 'broshi', MIDASUS: 'midasus',
  SKY: 'sky',
  GROUND: 'ground',   // nose down, sniffing
});

// Rows: a name, a base weight, whether it travels (a stay holds the last
// goal), who it walks over to (if anyone) and what it looks at. Travelling
// rows grow likelier with the song's energy, staying rows with its quiet.
const TABLES = [
  [ // Midio
    { name: 'wander', w: .28, move: true, look: Look.SCAN },
    { name: 'investigate', w: .14, move: true, approach: BROSHI, look: Look.BROSHI },
    { name: 'pause', w: .16, move: false, look: Look.SCAN },
    { name: 'watchBroshi', w: .14, move: false, look: Look.BROSHI },
    { name: 'watchMidasus', w: .13, move: false, look: Look.MIDASUS },
    { name: 'skyGaze', w: .15, move: false, look: Look.SKY },
  ],
  [ // Broshi
    { name: 'wander', w: .28, move: true, look: Look.SCAN },
    { name: 'investigate', w: .16, move: true, approach: MIDIO, look: Look.MIDIO },
    { name: 'sniff', w: .2, move: false, look: Look.GROUND },
    { name: 'watchMidio', w: .14, move: false, look: Look.MIDIO },
    { name: 'watchMidasus', w: .1, move: false, look: Look.MIDASUS },
    { name: 'skyGaze', w: .12, move: false, look: Look.SKY },
  ],
  [ // Midasus
    { name: 'drift', w: .3, move: true, look: Look.SCAN },
    { name: 'visitMidio', w: .14, move: true, approach: MIDIO, look: Look.MIDIO },
    { name: 'visitBroshi', w: .14, move: true, approach: BROSHI, look: Look.BROSHI },
    { name: 'hover', w: .16, move: false, look: Look.SCAN },
    { name: 'stargaze', w: .12, move: false, look: Look.SKY },
    { name: 'watchMidio', w: .14, move: false, look: Look.MIDIO },
  ],
];
// Mean segment length per character (ms); each boundary is jittered by up
// to SEG_JITTER of it, so segments run roughly 0.4x..1.6x this long.
const SEG_MS = [5200, 4300, 6100];
const SEG_JITTER = .3;
// Unhurried travel (px/s at the mean), a little brisker when the song is.
const WALK_PX_S = [80, 115, 105];
const LOOK_IN_MS = 600, LOOK_OUT_MS = 550;

// Stage windows, as fractions of the stage.
const MIDIO_LO = .2, MIDIO_HI = .56;          // where his goals sit
export const MIDIO_MIN = .18, MIDIO_MAX = .6; // where he can ever be
const BROSHI_LO = .08, BROSHI_HI = .92;
const SKY_X_LO = .1, SKY_X_HI = .92, SKY_Y_LO = .14, SKY_Y_HI = .46;
const MIDASUS_SEP = .17; // she keeps this far (x) from Midio when lingering
// Broshi's keep-out half-width around Midio's landing column (Broshi.js
// KEEPOUT_HALF): inside it, which side he settles on comes from the plan.
const BROSHI_KEEPOUT = 165;
// A stay holds the spot of the latest travelling segment this far back;
// a longer run of stays settles on a hashed home spot instead.
const STAY_LOOKBACK = 6;

/** Stateless 0..1 hash of four integers. */
export function hash01(a, b, c, d) {
  let h = (a ^ Math.imul(b | 0, 0x9e3779b1) ^ Math.imul((c | 0) + 0x632be5ab, 0x85ebca6b)
    ^ Math.imul((d | 0) + 0x5bd1e995, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smoother = u => u * u * u * (u * (u * 6 - 15) + 10);
const smootherD = u => 30 * u * u * (1 - u) * (1 - u);

function makeSeg() {
  return { k: NaN, start: 0, end: 0, row: null, x0: 0, y0: 0, x1: 0, y1: 0,
    travelMs: 1, phase: 0, side: 1, skyX: 0, near: 1 };
}

export class TrioWander {
  constructor(seed = 1, { stageW = 1280, stageH = 720, energyCurves = null } = {}) {
    this.seed = (seed >>> 0) ^ 0x5eed7a1d;
    this.w = stageW; this.h = stageH;
    this.groundY = stageH * 625 / 720;
    this.energyCurves = energyCurves;
    this._off = [0, 1, 2].map(c => hash01(this.seed, c, 0, 99) * SEG_MS[c]);
    this._segs = [makeSeg(), makeSeg(), makeSeg()];
    // The plan at the last update(). Preallocated, written in place.
    this.midio = { x: stageW * .34, vx: 0, leanDeg: 0, intent: 'wander', look: Look.SCAN, lookW: 0, phase: 0, skyX: 0 };
    this.broshi = { x: stageW * .6, vx: 0, facing: 1, side: 1, look: 0, intent: 'wander', lookAt: Look.SCAN, lookW: 0 };
    this.midasus = { x: stageW * .7, y: stageH * .3, tilt: 0, intent: 'drift', look: Look.SCAN, lookW: 0 };
  }

  _energy(tMs) {
    const c = this.energyCurves;
    let v = .5;
    try {
      if (c && typeof c.globalEnergyNorm === 'function') v = c.globalEnergyNorm(tMs);
    } catch { v = .5; }
    return Number.isFinite(v) ? clamp01(v) : .5;
  }

  /** Start of segment k for character c (monotone in k). */
  _boundary(c, k) {
    const L = SEG_MS[c];
    return (k + SEG_JITTER * (2 * hash01(this.seed, c, k, 1) - 1)) * L + this._off[c];
  }

  _segIndex(c, t) {
    const k0 = Math.floor((t - this._off[c]) / SEG_MS[c]);
    for (let k = k0 - 1; k <= k0 + 1; k++) {
      if (this._boundary(c, k) <= t && t < this._boundary(c, k + 1)) return k;
    }
    return k0;
  }

  _row(c, k) {
    const table = TABLES[c];
    const e = this._energy(Math.max(0, this._boundary(c, k)));
    let total = 0;
    for (const r of table) total += r.w * (r.move ? .7 + .6 * e : 1.3 - .6 * e);
    let pick = hash01(this.seed, c, k, 2) * total;
    for (const r of table) {
      pick -= r.w * (r.move ? .7 + .6 * e : 1.3 - .6 * e);
      if (pick < 0) return r;
    }
    return table[table.length - 1];
  }

  /** Where a stay idles: the goal of the latest travelling segment (stays
   *  chain, so a quiet stretch can idle through several looks in a row),
   *  or a hashed home spot after a long run of them. */
  _stayBase(c, k, approach) {
    for (let j = 1; j <= STAY_LOOKBACK; j++) {
      if (this._row(c, k - j).move) return this._goal(c, k - j, approach);
    }
    const s = this.seed, w = this.w, h = this.h, bucket = Math.floor(k / 8);
    if (c === MIDIO) return { x: w * (MIDIO_LO + (MIDIO_HI - MIDIO_LO) * hash01(s, c, bucket, 16)), y: 0 };
    if (c === BROSHI) return { x: w * (BROSHI_LO + (BROSHI_HI - BROSHI_LO) * hash01(s, c, bucket, 16)), y: 0 };
    return { x: w * (SKY_X_LO + (SKY_X_HI - SKY_X_LO) * hash01(s, c, bucket, 16)),
      y: h * (SKY_Y_LO + (SKY_Y_HI - SKY_Y_LO) * hash01(s, c, bucket, 17)) };
  }

  /** Where character c is heading in segment k. `approach` false treats a
   *  visit as plain wandering, so mutual visits never chase each other. */
  _goal(c, k, approach = true) {
    const row = this._row(c, k);
    const w = this.w, h = this.h, s = this.seed;
    const end = this._boundary(c, k + 1);
    if (!row.move) {
      const prev = this._stayBase(c, k, approach);
      const dx = (2 * hash01(s, c, k, 3) - 1) * 28;
      if (c === MIDIO) return { x: clamp(prev.x + dx, w * MIDIO_LO, w * MIDIO_HI), y: 0 };
      if (c === BROSHI) return { x: clamp(prev.x + dx, w * BROSHI_LO, w * BROSHI_HI), y: 0 };
      const y = row.look === Look.SKY ? h * (.1 + .06 * hash01(s, c, k, 4))
        : clamp(prev.y + (2 * hash01(s, c, k, 4) - 1) * 22, h * SKY_Y_LO, h * SKY_Y_HI);
      return { x: this._clearOfMidio(clamp(prev.x + dx, w * SKY_X_LO, w * SKY_X_HI), end), y };
    }
    if (c === MIDIO) {
      if (approach && row.approach === BROSHI) {
        // Wander over to where Broshi will be, stopping a body or two short
        // on the side with room, to peer at him.
        const b = this._goal(BROSHI, this._segIndex(BROSHI, end), false).x;
        const side = b > w * .38 ? -1 : 1;
        return { x: clamp(b + side * (175 + 30 * hash01(s, c, k, 5)), w * MIDIO_LO, w * (MIDIO_HI + .02)), y: 0 };
      }
      return { x: w * (MIDIO_LO + (MIDIO_HI - MIDIO_LO) * hash01(s, c, k, 6)), y: 0 };
    }
    if (c === BROSHI) {
      const m = this._goal(MIDIO, this._segIndex(MIDIO, end), false).x;
      const side = hash01(s, c, k, 7) < .5 ? -1 : 1;
      let x;
      if (approach && row.approach === MIDIO) x = m + side * (185 + 25 * hash01(s, c, k, 8));
      else if (hash01(s, c, k, 9) < .65) x = m + side * (210 + 200 * hash01(s, c, k, 8)); // pottering near his friend
      else x = w * (BROSHI_LO + (BROSHI_HI - BROSHI_LO) * hash01(s, c, k, 8));
      if (x < w * BROSHI_LO || x > w * BROSHI_HI) x = m - (x - m); // no room that side: try the other
      return { x: clamp(x, w * BROSHI_LO, w * BROSHI_HI), y: 0 };
    }
    // Midasus
    let x, y;
    if (approach && row.approach === MIDIO) {
      const m = this._goal(MIDIO, this._segIndex(MIDIO, end)).x;
      const off = w * MIDASUS_SEP + 50 * hash01(s, c, k, 10);
      x = m + (m + off <= w * SKY_X_HI && hash01(s, c, k, 11) < .7 ? off : -off);
      y = this.groundY - 290 + 40 * (hash01(s, c, k, 12) - .5);
    } else if (approach && row.approach === BROSHI) {
      const b = this._goal(BROSHI, this._segIndex(BROSHI, end)).x;
      x = b + 120 * (hash01(s, c, k, 10) - .5);
      y = this.groundY - 270 + 40 * (hash01(s, c, k, 12) - .5);
    } else {
      x = w * (SKY_X_LO + (SKY_X_HI - SKY_X_LO) * hash01(s, c, k, 10));
      y = h * (SKY_Y_LO + (SKY_Y_HI - SKY_Y_LO) * hash01(s, c, k, 12));
    }
    x = clamp(x, w * SKY_X_LO, w * SKY_X_HI);
    return { x: this._clearOfMidio(x, end), y: clamp(y, h * SKY_Y_LO, h * .5) };
  }

  /** Midasus's goals keep clear of where Midio will really be standing
   *  (his own visits included), so she is not parked over him; update()
   *  also eases her aside if he strolls in under her. Passing over on the
   *  way is fine. (Midio's goal looks at most at Broshi's non-approach
   *  goal, which never comes back here, so this cannot recurse forever.) */
  _clearOfMidio(x, atMs) {
    const m = this._goal(MIDIO, this._segIndex(MIDIO, atMs)).x;
    const sep = this.w * MIDASUS_SEP;
    if (Math.abs(x - m) >= sep) return x;
    const right = m + sep, left = m - sep;
    const preferRight = x >= m ? right <= this.w * SKY_X_HI : left < this.w * SKY_X_LO;
    return preferRight ? right : left;
  }

  _seg(c, t) {
    const k = this._segIndex(c, t);
    const seg = this._segs[c];
    if (seg.k === k) return seg;
    const p0 = this._goal(c, k - 1), p1 = this._goal(c, k);
    seg.k = k;
    seg.start = this._boundary(c, k); seg.end = this._boundary(c, k + 1);
    seg.row = this._row(c, k);
    seg.x0 = p0.x; seg.y0 = p0.y; seg.x1 = p1.x; seg.y1 = p1.y;
    const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const speed = WALK_PX_S[c] * (.8 + .4 * this._energy(Math.max(0, seg.start)));
    seg.travelMs = clamp(400 + 1000 * dist / speed, 450, .8 * (seg.end - seg.start));
    seg.phase = hash01(this.seed, c, k, 13) * Math.PI * 2;
    seg.side = hash01(this.seed, c, k, 14) < .5 ? -1 : 1;
    seg.skyX = this.w * (.2 + .6 * hash01(this.seed, c, k, 15));
    // Broshi: the side of Midio he means to end up on (his goal against
    // Midio's at the end of the segment), for when the two come close.
    if (c === BROSHI) {
      const d = p1.x - this._goal(MIDIO, this._segIndex(MIDIO, seg.end)).x;
      seg.near = Math.abs(d) > 1 ? Math.sign(d) : seg.side;
    }
    return seg;
  }

  /** How much of the segment's attention is on its look target: eases in
   *  on arrival (or soon after a stay begins) and out before it ends. */
  _lookW(seg, t) {
    const from = seg.row.move ? seg.start + seg.travelMs * .85 : seg.start + 150;
    return smoothstep(from, from + LOOK_IN_MS, t) * (1 - smoothstep(seg.end - LOOK_OUT_MS, seg.end - 60, t));
  }

  /** Evaluate the plan at heard time t (ms). Allocation-free once each
   *  character's current segment has been entered. */
  update(tMs) {
    const t = Math.max(0, Number(tMs) || 0);
    const w = this.w, h = this.h;

    // Midio: a closed-form stroll with a little meander in its pace.
    const ms = this._seg(MIDIO, t);
    const mu = clamp01((t - ms.start) / ms.travelMs);
    const mdx = ms.x1 - ms.x0;
    const mAmp = Math.min(16, .1 * Math.abs(mdx));
    const mWob = Math.sin(Math.PI * mu) * Math.sin(3 * Math.PI * mu + ms.phase);
    const mWobD = Math.PI * Math.cos(Math.PI * mu) * Math.sin(3 * Math.PI * mu + ms.phase)
      + 3 * Math.PI * Math.sin(Math.PI * mu) * Math.cos(3 * Math.PI * mu + ms.phase);
    const m = this.midio;
    m.x = clamp(ms.x0 + mdx * smoother(mu) + mAmp * mWob, w * MIDIO_MIN, w * MIDIO_MAX);
    m.vx = mu < 1 ? (mdx * smootherD(mu) + mAmp * mWobD) * 1000 / ms.travelMs : 0;
    m.intent = ms.row.name; m.look = ms.row.look; m.lookW = this._lookW(ms, t);
    m.phase = ms.phase; m.skyX = ms.skyX;

    // Broshi: his plan; his own spring follows it, faces where he's going
    // and, once there, turns to whatever caught his attention.
    const bs = this._seg(BROSHI, t);
    const bu = clamp01((t - bs.start) / bs.travelMs);
    const bdx = bs.x1 - bs.x0;
    const b = this.broshi;
    b.x = bs.x0 + bdx * smoother(bu) + Math.min(14, .08 * Math.abs(bdx)) * Math.sin(Math.PI * bu) * Math.sin(2 * Math.PI * bu + bs.phase);
    b.vx = bu < 1 ? bdx * smootherD(bu) * 1000 / bs.travelMs : 0;
    b.intent = bs.row.name; b.lookAt = bs.row.look; b.lookW = this._lookW(bs, t);
    // Which side of Midio he keeps: plainly his plan's side when clear of
    // Midio's landing column, else the side he means to end up on. A pure
    // function of time (Broshi.js reads it in place of his own history), so
    // a seek puts him on the same side continuous play does.
    const bm = b.x - m.x;
    b.side = Math.abs(bm) >= BROSHI_KEEPOUT ? Math.sign(bm) : bs.near;

    // Midasus: a drifting sky path, bowed so she never flies rail-straight,
    // with a slow idle bob.
    const fs = this._seg(MIDASUS, t);
    const fu = clamp01((t - fs.start) / fs.travelMs);
    const fdx = fs.x1 - fs.x0, fdy = fs.y1 - fs.y0;
    const len = Math.hypot(fdx, fdy) || 1;
    const bow = Math.min(40, .18 * len) * Math.sin(Math.PI * fu) * fs.side;
    const f = this.midasus;
    f.x = clamp(fs.x0 + fdx * smoother(fu) - fdy / len * bow, w * .06, w * .94);
    f.y = clamp(fs.y0 + fdy * smoother(fu) + fdx / len * bow + 9 * Math.sin(t * .0013 + fs.phase), h * .08, h * .52);
    // Not parked over Midio: once she has (nearly) arrived somewhere and he
    // strolls in under her, she eases aside, on her own side of him or the
    // side with room. Pure in time like the rest, so seeks still agree.
    const sep = w * MIDASUS_SEP, fd = f.x - m.x;
    if (Math.abs(fd) < sep) {
      let side = Math.sign(fd) || Math.sign(fs.x1 - m.x) || 1;
      if (m.x + side * sep > w * SKY_X_HI) side = -1;
      else if (m.x + side * sep < w * SKY_X_LO) side = 1;
      const settle = fs.row.move ? smoothstep(.55, .95, fu) : 1;
      f.x += (m.x + side * sep - f.x) * settle;
    }
    f.intent = fs.row.name; f.look = fs.row.look; f.lookW = this._lookW(fs, t);

    // Midio's carriage: leaning into his stroll, tilting toward whatever
    // he is watching (a companion's plan, so the pose stays a pure
    // function of time), and a curious peer forward when he arrives.
    let lookDx = 0;
    if (m.look === Look.BROSHI) lookDx = b.x - m.x;
    else if (m.look === Look.MIDASUS) lookDx = f.x - m.x;
    else if (m.look === Look.SKY) lookDx = (ms.skyX - m.x) * .3;
    const peer = ms.row.name === 'investigate' ? 7 : 4;
    m.leanDeg = clamp(m.vx / 80, -1, 1) * 5 + m.lookW * peer * clamp(lookDx / 80, -1, 1);

    // Broshi: which way he faces (travel direction, else his target) and
    // where his head goes (nose down sniffing, up at the sky or Midasus).
    let face = 0;
    if (b.lookW > .2) {
      if (b.lookAt === Look.MIDIO) face = Math.sign(m.x - b.x);
      else if (b.lookAt === Look.MIDASUS) face = Math.sign(f.x - b.x);
    }
    if (!face && Math.abs(bdx) > 12 && bu < 1) face = Math.sign(bdx);
    if (!face) face = Math.abs(bdx) > 12 ? Math.sign(bdx) : Math.sign(m.x - b.x) || 1;
    b.facing = face;
    let look = 0;
    if (b.lookAt === Look.GROUND) look = -.55 + .3 * Math.sin(t * .015);
    else if (b.lookAt === Look.SKY) look = 1;
    else if (b.lookAt === Look.MIDASUS) look = .8;
    else if (b.lookAt === Look.MIDIO) look = bs.row.move ? -.4 + .25 * Math.sin(t * .015) : .3;
    b.look = b.lookW * look;

    // Midasus: tips toward whoever she has come to see.
    let tiltDx = 0;
    if (f.look === Look.MIDIO) tiltDx = m.x - f.x;
    else if (f.look === Look.BROSHI) tiltDx = b.x - f.x;
    f.tilt = f.lookW * (f.look === Look.SKY ? .1 * Math.sin(t * .0009 + fs.phase) : .22 * clamp(tiltDx / 120, -1, 1));
    return this;
  }
}

/** Midio's eye, for Renderer._drawMidio's gaze: an iris direction and an
 *  openness. Render-only, written in place each step. */
export class TrioGaze {
  constructor() {
    this.dirX = 0; this.dirY = 0; this.openness = 1;
    this._out = { x: 0, y: 0 };
  }

  /** Aim from Midio's eye (ex, ey) given his plan and the cast's actual
   *  positions this step. */
  aim(plan, t, ex, ey, broshi, midasus) {
    const m = plan.midio;
    // Default: forward while strolling, idly scanning when not.
    let bx = clamp(m.vx / 60, -1, 1) * .6, by = .05;
    if (Math.abs(m.vx) < 20) {
      bx = .75 * Math.sin(t * .0011 + m.phase);
      by = -.15 + .2 * Math.sin(t * .0007 + 2 * m.phase);
    }
    let lx = bx, ly = by;
    if (m.look === Look.BROSHI && broshi) { lx = broshi.x - ex; ly = broshi.y - ey; }
    else if (m.look === Look.MIDASUS && midasus) { lx = midasus.x - ex; ly = midasus.y - ey; }
    else if (m.look === Look.SKY) { lx = (m.skyX - ex) * .35; ly = -400; }
    if (lx !== bx || ly !== by) {
      const len = Math.hypot(lx, ly) || 1;
      lx /= len; ly /= len;
    }
    const k = m.lookW;
    this.dirX = bx + (lx - bx) * k;
    this.dirY = by + (ly - by) * k;
    const wonder = m.look === Look.SKY || m.look === Look.MIDASUS || m.intent === 'investigate';
    this.openness = 1 + (wonder ? .16 * k : 0);
    return this;
  }

  irisOffset(maxPx) {
    this._out.x = this.dirX * maxPx * .8;
    this._out.y = this.dirY * maxPx * .8;
    return this._out;
  }
}
