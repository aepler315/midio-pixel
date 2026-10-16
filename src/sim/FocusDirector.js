// Focus: a dramatic attention arbiter. Every visual subsystem used to
// decide its own intensity in isolation -- the drop's own flash, Midasus's
// voyage, Broshi's burrow, Midio's glow, and the sky's ambient spectacle
// all read raw hype/fever/calm state and computed their own alpha with no
// awareness of what else was happening, so a drop and a voyage could both
// be visually loud in the same frame, fighting for attention instead of
// one winning it.
//
// Same shape family as PerfGovernor (one small instance, read defensively
// everywhere) but the opposite job: PerfGovernor sheds quality under LOAD,
// Focus sheds competing ATTENTION under drama. Each candidate submits a
// bid every step from state that already exists (no new signals); the
// highest bidder becomes this step's subject, and mul(key) hands back a
// dampener for every OTHER registered system -- 1 for the subject itself
// or when nothing has won focus, so an absent/idle Focus is a no-op.
import { clamp01 } from '../utils/math.js';

const MIN_BID = 0.25;      // below this, nothing has won focus -- subject stays null
const SWITCH_MARGIN = 0.08; // a new candidate must beat the holder by this much to take over
const MIN_HOLD_SEC = 0.6;   // once won, a subject can't be displaced before this -- reads as a cut, not a flicker
const DAMPEN_MIN = 0.3;     // heaviest dampening, at a decisive win
const DAMPEN_MAX = 0.5;     // lightest dampening, at a marginal win
const SKY_BASELINE = 0.05;  // small ambient bid so "nothing else is happening" resolves to sky, not a stuck prior winner

export const FOCUS_KEYS = ['drop', 'voyage', 'burrow', 'midio', 'sky'];

export class FocusDirector {
  constructor() {
    this._subject = null;
    this._winningBid = 0;
    this._heldSinceSec = -Infinity;
    this._bids = { drop: 0, voyage: 0, burrow: 0, midio: 0, sky: 0 };
  }

  /** @returns {'drop'|'voyage'|'burrow'|'midio'|'sky'|null} */
  get subject() { return this._subject; }

  /** Dampening multiplier for a given system key: 1 if it IS the subject
   *  (or nothing has won focus this step), otherwise a value in
   *  [DAMPEN_MIN, DAMPEN_MAX] scaled by how decisive the win is -- a
   *  marginal win dampens everyone else less than a decisive one. */
  mul(key) {
    if (!this._subject || key === this._subject) return 1;
    // Winning bid sits in [MIN_BID, 1]; map that range onto
    // [DAMPEN_MAX, DAMPEN_MIN] so a bid that barely cleared the floor
    // dampens lightly and a maxed-out bid dampens hard.
    const decisiveness = clamp01((this._winningBid - MIN_BID) / (1 - MIN_BID));
    return DAMPEN_MAX - (DAMPEN_MAX - DAMPEN_MIN) * decisiveness;
  }

  /** Call once per Simulation.step(), after hype/fever/calm/midasus/broshi/
   *  apotheosis have all updated this step so bids read fresh state. */
  update(sim, dtSec, nowMs) {
    const nowSec = nowMs / 1000;
    const hype = sim.hype;
    const voyage = sim.midasus ? sim.midasus.voyage : null;
    const burrow = sim.broshi ? sim.broshi.burrow : null;
    const apotheosis = sim.apotheosis;

    this._bids.drop = hype ? Math.max(clamp01(hype.surge), clamp01(hype.slam)) : 0;
    this._bids.voyage = voyage && voyage.active ? clamp01(1 - voyage.depth * 0.15) : 0;
    this._bids.burrow = burrow && burrow.active ? clamp01(1 - burrow.depth * 0.15) : 0;
    this._bids.midio = apotheosis ? clamp01(apotheosis.progress) : 0;
    this._bids.sky = SKY_BASELINE;

    let bestKey = null, bestBid = 0;
    for (const key of FOCUS_KEYS) {
      const bid = this._bids[key];
      if (bid > bestBid) { bestBid = bid; bestKey = key; }
    }

    const held = this._subject;
    const heldBid = held ? this._bids[held] : 0;
    const heldFor = nowSec - this._heldSinceSec;

    if (bestBid < MIN_BID) {
      // Nothing clears the floor -- resolve to no subject regardless of hold.
      this._subject = null;
      this._winningBid = 0;
      return;
    }

    if (!held) {
      this._subject = bestKey;
      this._winningBid = bestBid;
      this._heldSinceSec = nowSec;
      return;
    }

    if (bestKey === held) {
      this._winningBid = heldBid;
      return;
    }

    if (heldFor >= MIN_HOLD_SEC && bestBid >= heldBid + SWITCH_MARGIN) {
      this._subject = bestKey;
      this._winningBid = bestBid;
      this._heldSinceSec = nowSec;
      return;
    }

    // Held subject survives: either still inside its minimum hold, or the
    // challenger didn't beat it by enough margin to earn a cut.
    this._winningBid = heldBid;
  }
}
