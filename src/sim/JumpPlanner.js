// Predicts Midio's full jump-arc schedule from the kick timeline in advance,
// so obstacle placement can guarantee clearance instead of scripting around
// it. This replays JumpController's exact takeoff/retarget decision logic
// (kept in lockstep — see test/jumpPlanner.test.js, which cross-checks this
// against a live JumpController stepped in real time) but as a pure,
// non-realtime function over the whole kick list at once.
import {
  A, B, GAMMA, H_BASE, jumpY, scheduledJumpD, nextLandingKickMs, shortHopHeightMul,
  LANDING_QUANT_EPS_MS, RETARGET_FALL_MS, canRetarget,
} from './JumpController.js';

const HIGH_BPM_HALFTIME = 170;

/**
 * @param {{tMs:number, vel:number}[]} kicks sorted ascending
 * @returns {{takeoffMs:number, landMs:number, H:number, D:number}[]}
 */
export function predictJumpArcs(kicks, { hBase = H_BASE, jumpHeightMul = 1 } = {}) {
  let beatPeriodMs = 500;
  let lastKickMs = null;
  let kickCount = 0;
  let compressingUntilMs = -Infinity;
  const arcs = [];
  const kickTimes = kicks.map((k) => k.tMs);

  for (let ki = 0; ki < kicks.length; ki++) {
    const k = kicks[ki];
    if (lastKickMs != null) {
      const interval = k.tMs - lastKickMs;
      if (interval > 120 && interval < 2000) beatPeriodMs = beatPeriodMs * 0.7 + interval * 0.3;
    }
    lastKickMs = k.tMs;
    kickCount++;

    if (k.tMs < compressingUntilMs) continue; // mid-compression: ignored, same guard as JumpController

    const bpm = 60000 / beatPeriodMs;
    if (bpm > HIGH_BPM_HALFTIME && kickCount % 2 === 0) continue; // ghost kick, routes to FX only

    const H = hBase * (0.6 + 0.8 * k.vel) * jumpHeightMul;

    const last = arcs[arcs.length - 1];
    // Symmetric landing-tie rule (see LANDING_QUANT_EPS_MS's doc): a kick
    // within the tolerance of the arc's scheduled touchdown IS the
    // touchdown -- it reads as grounded and relaunches ON the kick, in
    // lockstep with the live controller's own force-land.
    const airborne = last && k.tMs < last.landMs - LANDING_QUANT_EPS_MS;

    if (!airborne) {
      // Land ON the next audible kick when one falls in range (see
      // JumpController.scheduledJumpD) rather than only ever guessing from
      // the beat-period EMA -- searched from ki+1 so a duplicate/too-close
      // kick doesn't stall the search, exactly the live controller's own
      // cursor walk (JumpController._launchOrRetarget).
      const nextKickMs = nextLandingKickMs(kickTimes, k.tMs, ki + 1);
      const D = scheduledJumpD(k.tMs, nextKickMs, beatPeriodMs);
      arcs.push({ takeoffMs: k.tMs, landMs: k.tMs + D, H: H * shortHopHeightMul(D), D });
      continue;
    }

    const u = (k.tMs - last.takeoffMs) / last.D;
    if (u >= A + B) {
      const r = (u - A - B) / GAMMA;
      if (r < 0.3 && canRetarget(k.tMs, last.takeoffMs, last.D)) {
        const compressLandMs = k.tMs + RETARGET_FALL_MS;
        const nextKickMs = nextLandingKickMs(kickTimes, compressLandMs, ki + 1);
        const D = scheduledJumpD(compressLandMs, nextKickMs, beatPeriodMs);
        last.landMs = compressLandMs; // truncate the in-flight arc
        compressingUntilMs = compressLandMs;
        arcs.push({ takeoffMs: compressLandMs, landMs: compressLandMs + D, H: H * shortHopHeightMul(D), D });
      }
    }
    // else: mid launch/hang -- kick ignored, already committed to this arc
  }

  return arcs;
}

/**
 * The contiguous time window (in ms) during which a given arc keeps Midio's
 * altitude at or above thresholdPx, clipped to the arc's (possibly
 * retarget-truncated) actual landing time. Returns null if the arc never
 * clears the threshold at all.
 */
export function safeWindowForArc(arc, thresholdPx, samples = 64) {
  let loU = null, hiU = null;
  const maxU = Math.min(1, (arc.landMs - arc.takeoffMs) / arc.D);
  for (let i = 0; i <= samples; i++) {
    const u = (i / samples) * maxU;
    if (jumpY(u, arc.H) >= thresholdPx) {
      if (loU === null) loU = u;
      hiU = u;
    }
  }
  if (loU === null) return null;
  return { fromMs: arc.takeoffMs + loU * arc.D, toMs: arc.takeoffMs + hiU * arc.D };
}
