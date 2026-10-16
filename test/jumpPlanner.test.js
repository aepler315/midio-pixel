import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predictJumpArcs, safeWindowForArc } from '../src/sim/JumpPlanner.js';
import { JumpController, jumpY } from '../src/sim/JumpController.js';
import { ParamBus } from '../src/core/ParamBus.js';
import { mulberry32 } from '../src/utils/math.js';

function runLive(kicks, opts = {}) {
  const paramBus = new ParamBus();
  const jump = new JumpController(paramBus, opts);
  // Landing-on-the-next-kick (scheduledJumpD): the live controller needs
  // the same raw kick-time list predictJumpArcs replays, or it would fall
  // back to pure-EMA scheduling while the predictor schedules onto real
  // kicks -- breaking the lockstep this test exists to verify.
  jump.setKickTimes(kicks.map((k) => k.tMs));
  const STEP_MS = 1000 / 120;
  const landings = [];
  let ki = 0;
  let t = 0;
  const endMs = kicks[kicks.length - 1].tMs + 3000;
  while (t <= endMs) {
    jump.clearFrameFlags();
    while (ki < kicks.length && kicks[ki].tMs <= t) {
      jump.onKick(kicks[ki]);
      ki++;
    }
    jump.update(t);
    if (jump.pendingLanding) landings.push(t);
    t += STEP_MS;
  }
  return landings;
}

test('predictJumpArcs matches a live JumpController stepped in real time (simple steady kicks)', () => {
  const kicks = [];
  for (let i = 0; i < 20; i++) kicks.push({ tMs: i * 500, vel: 0.6 + 0.3 * Math.sin(i) });

  const liveLandings = runLive(kicks);
  const arcs = predictJumpArcs(kicks);

  assert.equal(arcs.length, liveLandings.length, 'same number of arcs/landings');
  for (let i = 0; i < arcs.length; i++) {
    assert.ok(Math.abs(arcs[i].landMs - liveLandings[i]) < 10, `arc ${i} landMs ${arcs[i].landMs} vs live ${liveLandings[i]}`);
  }
});

test('predictJumpArcs matches live behavior with high-BPM halftime skipping', () => {
  const kicks = [];
  for (let i = 0; i < 30; i++) kicks.push({ tMs: i * 180, vel: 0.7 }); // ~333bpm kick-to-kick -> halftime kicks in

  const liveLandings = runLive(kicks);
  const arcs = predictJumpArcs(kicks);

  assert.equal(arcs.length, liveLandings.length);
  for (let i = 0; i < arcs.length; i++) {
    assert.ok(Math.abs(arcs[i].landMs - liveLandings[i]) < 15);
  }
});

test('predictJumpArcs matches live behavior when a close kick triggers mid-air retargeting', () => {
  // A steady beat, then one kick lands unusually early (in the last 30% of the
  // fall), which should trigger a compress-and-relaunch in both systems.
  const kicks = [
    { tMs: 0, vel: 0.8 }, { tMs: 500, vel: 0.8 }, { tMs: 1000, vel: 0.8 },
    { tMs: 1000 + 500 * 0.85, vel: 0.8 }, // ~85% through the next 500ms-ish arc -> retarget window
    { tMs: 2200, vel: 0.8 }, { tMs: 2700, vel: 0.8 },
  ];
  const liveLandings = runLive(kicks);
  const arcs = predictJumpArcs(kicks);

  assert.equal(arcs.length, liveLandings.length);
  for (let i = 0; i < arcs.length; i++) {
    assert.ok(Math.abs(arcs[i].landMs - liveLandings[i]) < 15, `arc ${i}: ${arcs[i].landMs} vs ${liveLandings[i]}`);
  }
});

test('predictJumpArcs stays in sync over a long randomized kick sequence', () => {
  const rand = mulberry32(2024);
  const kicks = [];
  let t = 0;
  for (let i = 0; i < 200; i++) {
    t += 250 + rand() * 500;
    kicks.push({ tMs: Math.round(t), vel: 0.4 + rand() * 0.6 });
  }
  const liveLandings = runLive(kicks);
  const arcs = predictJumpArcs(kicks);

  assert.equal(arcs.length, liveLandings.length);
  for (let i = 0; i < arcs.length; i++) {
    assert.ok(Math.abs(arcs[i].landMs - liveLandings[i]) < 15);
  }
});

test('safeWindowForArc finds the above-threshold sub-interval and clips to a truncated landing', () => {
  const arc = { takeoffMs: 1000, landMs: 1500, H: 150, D: 500 };
  const w = safeWindowForArc(arc, 60);
  assert.ok(w);
  assert.ok(w.fromMs > arc.takeoffMs && w.fromMs < arc.takeoffMs + arc.D * 0.4);
  assert.ok(w.toMs <= arc.landMs);
  // Sanity: every point in the window is really above threshold.
  for (let t = w.fromMs; t <= w.toMs; t += 10) {
    const u = (t - arc.takeoffMs) / arc.D;
    assert.ok(jumpY(u, arc.H) >= 60 - 1e-6);
  }
});

test('safeWindowForArc returns null when the arc never clears the threshold', () => {
  const arc = { takeoffMs: 0, landMs: 400, H: 40, D: 400 };
  assert.equal(safeWindowForArc(arc, 200), null);
});

// --- Chart-scheduled landings (scheduledJumpD / nextLandingKickMs) -------

test('predictJumpArcs prefers beat-grid landings; kicks win only when near the grid', () => {
  // Deliberately uneven gaps. Midio aims at the beat period first; a kick
  // steals the landing only when it sits near a beat multiple (or is a
  // short double-step hop under D_MIN).
  const gaps = [500, 750, 500, 250, 900, 400, 600];
  const kicks = [];
  let t = 0;
  for (const g of gaps) { kicks.push({ tMs: t, vel: 0.8 }); t += g; }
  kicks.push({ tMs: t, vel: 0.8 });

  const arcs = predictJumpArcs(kicks);
  for (const arc of arcs) {
    assert.ok(Number.isFinite(arc.D) && arc.D > 0, 'duration must be finite');
    assert.ok(arc.D <= 1200 + 1e-6, 'D_MAX ceiling');
    assert.ok(arc.landMs >= arc.takeoffMs, 'lands after takeoff');
    // Short hops still clamp to real kick gaps under D_MIN.
    if (arc.D < 380 - 1e-6) {
      const matchesKick = kicks.some((k) => Math.abs(k.tMs - arc.landMs) < 1e-6);
      assert.ok(matchesKick, `short hop should land on a kick: ${JSON.stringify(arc)}`);
    }
  }
  // At least one arc should use a clean beat-period landing (not forced
  // onto a raw off-grid kick) when the stream is uneven.
  assert.ok(arcs.length >= 2);
});
