// Enemy-wave battle system: flying/crawling enemies spawn during identified
// high-energy/tension sections of the song and are shot down by the three
// characters with dots of light, timed to vaporize each enemy EXACTLY on a
// 16th-note grid time. Staged as a drama arc -- one defender alone,
// gradually overwhelmed, a second steps in and the lead is regained, then
// the third joins for the finale.
//
// Pure math lives here (grid derivation, window-finding, escalation
// thresholds, slot assignment, travel timing) so it's testable without a
// canvas or a running Simulation; the BattleDirector class holds the
// stateful drama loop and is driven from Simulation.step, drawn by Renderer.
import { clamp, clamp01, mulberry32 } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';
import { ObjectPool } from '../utils/ObjectPool.js';

// --- 16th-note grid -------------------------------------------------------

/** All 16th-note times within [t0,t1], derived from bar starts (barGrid
 *  entries carry no subdivision of their own). Ascending, one array per
 *  call -- cheap enough to build per combat window rather than cache. */
export function sixteenthsInRange(barGrid, durationMs, t0, t1) {
  const out = [];
  if (!barGrid || barGrid.length === 0) return out;
  for (let i = 0; i < barGrid.length; i++) {
    const bar = barGrid[i];
    const barEnd = i + 1 < barGrid.length ? barGrid[i + 1].ms : durationMs;
    const span = barEnd - bar.ms;
    if (span <= 0) continue;
    const steps = Math.max(1, Math.round((bar.numerator || 4) * 16 / (bar.denominator || 4)));
    const stepMs = span / steps;
    for (let k = 0; k < steps; k++) {
      const tMs = bar.ms + k * stepMs;
      if (tMs >= t0 && tMs <= t1) out.push(tMs);
    }
  }
  return out;
}

// --- Bar-level energy + combat windows -----------------------------------

/** Per-bar scalar energy (globalEnergy at each bar's midpoint), one entry
 *  per barGrid bar. All zero if energyCurves is absent. */
export function barEnergies(energyCurves, barGrid, durationMs) {
  if (!barGrid || barGrid.length === 0) return [];
  return barGrid.map((bar, i) => {
    if (!energyCurves) return 0;
    const barEnd = i + 1 < barGrid.length ? barGrid[i + 1].ms : durationMs;
    const mid = (bar.ms + barEnd) / 2;
    return clamp01(energyCurves.globalEnergy(mid, FLAT_WEIGHTS));
  });
}

/** Identifies up to `cap` windows of sustained high energy/tension: bars
 *  whose energy exceeds mean + z*stdev, merged across short gaps, filtered
 *  by minimum length, truncated to the highest-mean sub-stretch if too
 *  long, ranked by mean energy, and spaced at least minSepBars apart.
 *  Returns [{startBar, endBar}] (endBar exclusive), sorted by start. */
export function findCombatWindows(energies, opts = {}) {
  const {
    minLen = 8, maxLen = 24, mergeGap = 2, cap = 3, minSepBars = 8, z = 0.35, minStartBar = 4,
  } = opts;
  const n = energies.length;
  if (n === 0) return [];

  const mean = energies.reduce((a, v) => a + v, 0) / n;
  const variance = energies.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const stdev = Math.sqrt(variance);
  const threshold = mean + z * stdev;

  const hot = energies.map((v, i) => v > threshold && i >= minStartBar);

  // Runs of hot bars, merged across gaps <= mergeGap.
  let runs = [];
  let i = 0;
  while (i < n) {
    if (!hot[i]) { i++; continue; }
    let j = i + 1;
    while (j < n) {
      if (hot[j]) { j++; continue; }
      let k = j;
      while (k < n && !hot[k] && k - j < mergeGap) k++;
      if (k < n && hot[k]) { j = k + 1; continue; }
      break;
    }
    runs.push([i, j]);
    i = j;
  }

  runs = runs.filter(([s, e]) => e - s >= minLen);

  // Truncate over-long runs to their highest-mean maxLen-length sub-stretch.
  runs = runs.map(([s, e]) => {
    if (e - s <= maxLen) return [s, e];
    let bestStart = s, bestSum = -Infinity;
    let sum = 0;
    for (let x = s; x < s + maxLen; x++) sum += energies[x];
    bestSum = sum;
    for (let x = s + 1; x + maxLen <= e; x++) {
      sum += energies[x + maxLen - 1] - energies[x - 1];
      if (sum > bestSum) { bestSum = sum; bestStart = x; }
    }
    return [bestStart, bestStart + maxLen];
  });

  const withMean = runs.map(([s, e]) => {
    let sum = 0;
    for (let x = s; x < e; x++) sum += energies[x];
    return { startBar: s, endBar: e, mean: sum / (e - s) };
  });
  withMean.sort((a, b) => b.mean - a.mean);

  const accepted = [];
  for (const w of withMean) {
    if (accepted.length >= cap) break;
    const clashes = accepted.some((a) => !(w.startBar - a.endBar >= minSepBars || a.startBar - w.endBar >= minSepBars));
    if (!clashes) accepted.push(w);
  }
  accepted.sort((a, b) => a.startBar - b.startBar);
  return accepted.map(({ startBar, endBar }) => ({ startBar, endBar }));
}

// --- Escalation ------------------------------------------------------------

/** Defender count (1-3) given the current alive-enemy backlog and the
 *  current defender count. Hysteresis: only ever escalates (never drops
 *  defenders mid-window) -- 1->2 at alive>=5, 2->3 at alive>=8. */
export function escalationTargets(aliveCount, currentDefenders) {
  let d = Math.max(1, currentDefenders | 0);
  if (d < 2 && aliveCount >= 4) d = 2;
  if (d < 3 && aliveCount >= 6) d = 3;
  return d;
}

// --- Slot assignment / travel timing --------------------------------------

/** First 16th-grid slot index usable for a new kill, honoring: the
 *  earliest allowed time (travel + guard), a global one-kill-per-slot
 *  rhythm floor, and a per-shooter minimum slot gap. Returns -1 if the
 *  grid is exhausted (song/window ending). */
export function assignSlot(grid, earliestMs, globalLastSlot, shooterLastSlot, minGapSlots) {
  const minIdx = Math.max(
    globalLastSlot + 1,
    shooterLastSlot >= 0 ? shooterLastSlot + minGapSlots : 0,
  );
  for (let i = Math.max(0, minIdx); i < grid.length; i++) {
    if (grid[i] >= earliestMs) return i;
  }
  return -1;
}

export const DOT_SPEED_PX_S = 1000;

/** Travel time (ms) for a dot covering `dist` px, clamped to stay within
 *  the choreography's anticipation lead. */
export function travelMsFor(dist) {
  return clamp((Math.abs(dist) / DOT_SPEED_PX_S) * 1000, 130, 210);
}

/** Dot progress (0..1) at the heard clock time vNowMs, departing at
 *  departMs and arriving (u=1) exactly travelMs later -- i.e. exactly at
 *  killMs = departMs + travelMs. */
export function dotU(vNowMs, departMs, travelMs) {
  if (travelMs <= 0) return 1;
  return clamp01((vNowMs - departMs) / travelMs);
}

// --- Drama constants -------------------------------------------------------

const MAX_ALIVE_ENEMIES = 8; // fewer, but each takes two hits -- a smaller, tougher crowd
const ASSIGN_AGE_MS = 900; // an enemy must "arrive" a moment before it can be locked onto -- they menace a beat longer
const SPAWN_GAP_NEAR = 2.0; // gap multiplier (of one bar) at window start
const SPAWN_GAP_FAR = 0.75; // gap multiplier near window end (before finale cutoff)
const FINALE_LEAD_BARS = 2; // stop spawning & start the finale this many bars before window end
const RESCUE_COUNT = 3; // enemies handed to a freshly-joined defender immediately
const PRESS_RADIUS_PX = 90;
const BURST_SHARDS = 14;
const ENEMY_HP = 2; // each enemy takes a stagger hit, then a finishing hit -- "more powerful"
const STAGGER_KNOCKBACK_PX = 26;
const SPAWN_MARGIN_PX = 60; // spawn point past the right edge -- offscreen, never conjured in view
const GLIDE_IN_MS = 800; // pure leftward drift before pressure-homing kicks in
const GLIDE_IN_SPEED_PX_S = 140;

/** Fixed defender join order: Midasus first (solo), Broshi second (the
 *  save), Midio last (the hero's rescue). Index into the `anchors` array
 *  passed to update(). */
export const DEFENDER_ORDER = ['MIDASUS', 'BROSHI', 'MIDIO'];

export class BattleDirector {
  constructor({ barGrid, durationMs, energyCurves, seed = 1 }) {
    this.barGrid = barGrid || [];
    this.durationMs = durationMs || 0;
    this.rand = mulberry32(seed >>> 0);

    const energies = barEnergies(energyCurves, this.barGrid, this.durationMs);
    this._windows = findCombatWindows(energies).map((w) => ({
      startBar: w.startBar,
      endBar: w.endBar,
      startMs: this.barGrid[w.startBar] ? this.barGrid[w.startBar].ms : 0,
      endMs: w.endBar < this.barGrid.length ? this.barGrid[w.endBar].ms : this.durationMs,
      barMs: (this._barSpan(w.startBar)) || 500,
    }));
    this._windowIdx = 0;

    this.phase = 'IDLE'; // 'IDLE' | 'BATTLE' | 'FINALE'
    this.defenders = 1;
    this._activeWindow = null;
    this._grid = [];
    this._globalLastSlot = -1;
    this._shooterLastSlot = [-1, -1, -1];
    this._nextSpawnMs = Infinity;
    this._spawnAlt = 0;
    this._rrCounter = 0;
    this._enemySeq = 0;

    this.enemies = new ObjectPool(() => ({}), (o, i) => Object.assign(o, { fired: false, shooterIdx: -1 }, i), MAX_ALIVE_ENEMIES + 4);
    this.dots = new ObjectPool(() => ({}), (o, i) => Object.assign(o, i), 24);
    this.bursts = new ObjectPool(() => ({}), (o, i) => Object.assign(o, { age: 0 }, i), 32);

    this.lastKills = []; // ring buffer of {killMs} for verification/telemetry
  }

  _barSpan(barIdx) {
    const bar = this.barGrid[barIdx];
    if (!bar) return 0;
    const next = this.barGrid[barIdx + 1];
    return (next ? next.ms : this.durationMs) - bar.ms;
  }

  get aliveCount() { return this.enemies.active.length; }

  /** anchors: [{x,y} for MIDASUS, BROSHI, MIDIO] in screen space.
   *  visualLagMs: output-latency compensation (ChoreoClock convention) --
   *  kills are evaluated on the HEARD clock, same discipline as every other
   *  apex-on-beat system in this codebase. canvasWidth: stage width, so
   *  enemies spawn hard offscreen past the right edge (default 1280 keeps
   *  callers that don't pass it working exactly as before). */
  update(nowMs, dtMs, anchors, visualLagMs = 0, reducedFlash = false, canvasWidth = 1280) {
    const vNow = nowMs - (visualLagMs || 0);
    this._advancePhase(nowMs, anchors);
    if (this.phase === 'BATTLE') this._spawn(nowMs, canvasWidth);
    this._movePressure(nowMs, dtMs, anchors);
    this._escalate(nowMs, anchors);
    if (this.phase !== 'IDLE') this._assign(nowMs, anchors);
    this._fireDots(vNow, anchors);
    this._advanceDots(vNow);
    this._stepBursts(dtMs);
  }

  _advancePhase(nowMs, anchors) {
    if (this.phase === 'IDLE') {
      const w = this._windows[this._windowIdx];
      if (!w) return;
      if (nowMs < w.startMs) return;
      if (nowMs >= w.endMs) { this._windowIdx++; return; } // window skipped over entirely
      this._activeWindow = w;
      this._grid = sixteenthsInRange(this.barGrid, this.durationMs, w.startMs, w.endMs);
      this._globalLastSlot = -1;
      this._shooterLastSlot = [-1, -1, -1];
      this.defenders = 1;
      this._nextSpawnMs = w.startMs;
      this.phase = 'BATTLE';
      return;
    }
    if (this.phase === 'BATTLE') {
      const w = this._activeWindow;
      if (nowMs >= w.endMs - FINALE_LEAD_BARS * w.barMs) {
        this.phase = 'FINALE';
        this.defenders = 3; // everyone joins for the finale cascade
        // Extend the grid a few bars past the window's own end: at 2 hp per
        // enemy, a stagger's finishing hit needs a slot too, and the
        // original window-bounded grid can run out right at the cutoff --
        // stranding an enemy that can never resolve. A cascade always has
        // somewhere to land.
        this._grid = sixteenthsInRange(this.barGrid, this.durationMs, w.startMs, Math.min(this.durationMs, w.endMs + 8 * w.barMs));
        this._finaleAssignAll(nowMs, anchors);
      }
      return;
    }
    if (this.phase === 'FINALE') {
      if (this.enemies.active.length === 0 && this.dots.active.length === 0) {
        this.phase = 'IDLE';
        this._activeWindow = null;
        this._windowIdx++;
        this.defenders = 1;
      }
    }
  }

  _spawn(nowMs, canvasWidth) {
    if (nowMs < this._nextSpawnMs || this.enemies.active.length >= MAX_ALIVE_ENEMIES) return;
    const w = this._activeWindow;
    const winProgress = clamp01((nowMs - w.startMs) / Math.max(1, w.endMs - w.startMs));
    const gapMul = SPAWN_GAP_NEAR + (SPAWN_GAP_FAR - SPAWN_GAP_NEAR) * winProgress;
    this._nextSpawnMs = nowMs + w.barMs * gapMul;

    const kind = (this._spawnAlt++ % 2 === 0) ? 'flyer' : 'crawler';
    const fromRight = canvasWidth + SPAWN_MARGIN_PX;
    const sy = kind === 'flyer' ? (170 + this.rand() * 240) : 540;
    this.enemies.spawn({
      id: this._enemySeq++,
      kind,
      sx: fromRight, sy,
      bobPhase: this.rand() * Math.PI * 2,
      spawnMs: nowMs,
      shooterIdx: -1,
      killMs: -1, departMs: -1, travelMs: 0,
      fired: false,
      locked: false,
      hp: ENEMY_HP,
      staggerMs: -Infinity,
    });
  }

  _movePressure(nowMs, dtMs, anchors) {
    const dtSec = dtMs / 1000;
    const leadIdx = Math.max(0, this.defenders - 1);
    const lead = anchors[leadIdx] || anchors[0];
    for (const e of this.enemies.active) {
      // A fresh arrival glides in from offscreen first -- it doesn't home
      // in until it's actually on the stage, so nothing appears to
      // materialize mid-air already chasing a defender.
      if (nowMs - e.spawnMs < GLIDE_IN_MS) {
        e.sx -= GLIDE_IN_SPEED_PX_S * dtSec;
        continue;
      }
      const targetIdx = e.locked && e.shooterIdx >= 0 ? e.shooterIdx : leadIdx;
      const target = anchors[targetIdx] || lead;
      const dx = target.x - e.sx, dy = (e.kind === 'crawler' ? target.y : target.y) - e.sy;
      const dist = Math.hypot(dx, dy) || 1;
      const pressSpeed = e.locked ? 20 : 60 + 40 * clamp01(this.aliveCount / 8);
      if (dist > PRESS_RADIUS_PX) {
        e.sx += (dx / dist) * pressSpeed * dtSec;
        e.sy += (dy / dist) * pressSpeed * dtSec * (e.kind === 'crawler' ? 0.2 : 1);
      }
    }
  }

  _escalate(nowMs, anchors) {
    if (this.phase !== 'BATTLE') return;
    const target = escalationTargets(this.aliveCount, this.defenders);
    if (target > this.defenders) {
      const joiningIdx = target - 1;
      // The rescue volley: the nearest unassigned enemies go straight to
      // the newly-joined defender, visibly regaining the lead.
      const unassigned = this.enemies.active.filter((e) => e.shooterIdx < 0);
      const anchor = anchors[joiningIdx] || anchors[0];
      unassigned.sort((a, b) => Math.hypot(a.sx - anchor.x, a.sy - anchor.y) - Math.hypot(b.sx - anchor.x, b.sy - anchor.y));
      this.defenders = target;
      for (let i = 0; i < Math.min(RESCUE_COUNT, unassigned.length); i++) {
        this._lockEnemy(unassigned[i], joiningIdx, nowMs, anchors);
      }
    }
  }

  _lockEnemy(e, shooterIdx, nowMs, anchors) {
    const anchor = anchors[shooterIdx] || anchors[0];
    const dist = Math.hypot(anchor.x - e.sx, anchor.y - e.sy);
    const travelMs = travelMsFor(dist);
    const earliestMs = nowMs + travelMs + 40;
    const minGapSlots = this.defenders >= 3 ? 1 : 2;
    const slotIdx = assignSlot(this._grid, earliestMs, this._globalLastSlot, this._shooterLastSlot[shooterIdx], minGapSlots);
    if (slotIdx < 0) return false;
    const killMs = this._grid[slotIdx];
    e.shooterIdx = shooterIdx;
    e.killMs = killMs;
    e.departMs = killMs - travelMs;
    e.travelMs = travelMs;
    e.locked = true;
    this._globalLastSlot = slotIdx;
    this._shooterLastSlot[shooterIdx] = slotIdx;
    return true;
  }

  _assign(nowMs, anchors) {
    for (const e of this.enemies.active) {
      if (e.shooterIdx >= 0) continue;
      if (nowMs - e.spawnMs < ASSIGN_AGE_MS) continue;
      const shooterIdx = this._rrCounter++ % this.defenders;
      this._lockEnemy(e, shooterIdx, nowMs, anchors);
    }
  }

  _finaleAssignAll(nowMs, anchors) {
    // Every remaining enemy gets consecutive slots, round-robin across all
    // three defenders -- the rapid chain of on-grid vaporizes that closes
    // the window.
    for (const e of this.enemies.active) {
      if (e.shooterIdx >= 0) continue;
      const shooterIdx = this._rrCounter++ % 3;
      this._lockEnemy(e, shooterIdx, nowMs, anchors);
    }
  }

  _fireDots(vNow, anchors) {
    for (const e of this.enemies.active) {
      if (!e.locked || e.fired) continue;
      if (vNow < e.departMs) continue;
      const anchor = anchors[e.shooterIdx] || anchors[0];
      this.dots.spawn({
        enemyId: e.id, shooterIdx: e.shooterIdx,
        x0: anchor.x, y0: anchor.y,
        departMs: e.departMs, travelMs: e.travelMs, killMs: e.killMs,
      });
      e.fired = true;
    }
  }

  _advanceDots(vNow) {
    this.dots.step(0, (d) => {
      if (vNow < d.killMs) return true;
      // Arrival: a hit lands exactly on the grid time either way. At hp>1
      // it's a stagger -- knocked back, unlocked, and re-queued for a
      // finishing hit (also on-grid); only the finishing hit vaporizes and
      // counts as a kill.
      const idx = this.enemies.active.findIndex((e) => e.id === d.enemyId);
      let ex = d.x0, ey = d.y0;
      if (idx >= 0) {
        const e = this.enemies.active[idx];
        ex = e.sx; ey = e.sy;
        e.hp -= 1;
        if (e.hp > 0) {
          e.sx += STAGGER_KNOCKBACK_PX;
          e.staggerMs = d.killMs;
          e.shooterIdx = -1; e.locked = false; e.fired = false;
          e.killMs = -1; e.departMs = -1; e.travelMs = 0;
          this._spawnBurst(ex, ey, true);
          return false; // this dot is spent; the enemy lives on for the next volley
        }
        this.enemies.active.splice(idx, 1);
        if (this.enemies.free.length < this.enemies.capacity) this.enemies.free.push(e);
      }
      this._spawnBurst(ex, ey, false);
      this.lastKills.push({ killMs: d.killMs });
      if (this.lastKills.length > 64) this.lastKills.shift();
      return false;
    });
  }

  _spawnBurst(x, y, stagger = false) {
    // A stagger is a hit landed, not a kill -- a small white flash + a
    // couple of sparks, distinct from the full vaporize shatter.
    const n = stagger ? 4 : BURST_SHARDS;
    const shards = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + this.rand() * 0.3;
      shards.push({ ang, speed: (stagger ? 40 : 60) + this.rand() * 90 });
    }
    this.bursts.spawn({ x, y, shards, age: 0, life: stagger ? 0.2 : 0.35, stagger });
  }

  _stepBursts(dtMs) {
    const dtSec = dtMs / 1000;
    this.bursts.step(dtSec, (o, dt) => { o.age += dt; return o.age < o.life; });
  }
}
