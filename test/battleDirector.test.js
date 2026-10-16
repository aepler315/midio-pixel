import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sixteenthsInRange, barEnergies, findCombatWindows, escalationTargets,
  assignSlot, travelMsFor, dotU, DOT_SPEED_PX_S, BattleDirector,
} from '../src/sim/BattleDirector.js';

function makeBarGrid(bars, msPerBar, numerator = 4, denominator = 4) {
  const out = [];
  for (let i = 0; i < bars; i++) out.push({ tick: i * 1920, ms: i * msPerBar, numerator, denominator });
  return out;
}

test('sixteenthsInRange: 4/4 gives 16 uniform steps per bar, 3/4 gives 12, spans bars, clamps at duration', () => {
  const grid = makeBarGrid(4, 2000); // 2s bars
  const durationMs = 8000;
  const times = sixteenthsInRange(grid, durationMs, 0, durationMs);
  // 4 bars * 16 steps = 64 steps total.
  assert.equal(times.length, 64);
  const stepMs = 2000 / 16;
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(times[i] - i * stepMs) < 1e-9);
  // Ascending overall.
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1]);

  const grid34 = makeBarGrid(2, 1500, 3, 4);
  const times34 = sixteenthsInRange(grid34, 3000, 0, 3000);
  assert.equal(times34.length, 24); // 12 steps/bar * 2 bars

  // Range filter + duration clamp on the last (open) bar.
  const sub = sixteenthsInRange(grid, durationMs, 1900, 2200);
  assert.ok(sub.every((t) => t >= 1900 && t <= 2200));
  const grid1 = makeBarGrid(1, 2000);
  const clamped = sixteenthsInRange(grid1, 2500, 0, 2500); // last bar spans to durationMs, not 2*msPerBar
  assert.ok(clamped[clamped.length - 1] < 2500);
});

test('barEnergies samples globalEnergy at each bar midpoint, zero without an energyCurves', () => {
  const grid = makeBarGrid(3, 1000);
  const fake = { globalEnergy: (tMs) => tMs / 3000 };
  const es = barEnergies(fake, grid, 3000);
  assert.equal(es.length, 3);
  assert.ok(Math.abs(es[0] - (500 / 3000)) < 1e-9);
  assert.deepEqual(barEnergies(null, grid, 3000), [0, 0, 0]);
});

test('findCombatWindows: flat energy yields no windows', () => {
  const flat = new Array(40).fill(0.5);
  assert.deepEqual(findCombatWindows(flat), []);
});

test('findCombatWindows: a single sustained hump yields exactly one window over the peak', () => {
  const n = 48;
  const energies = new Array(n).fill(0).map((_, i) => 0.2 + 0.6 * Math.sin((i / n) * Math.PI));
  const windows = findCombatWindows(energies, { minLen: 6 });
  assert.equal(windows.length, 1);
  const { startBar, endBar } = windows[0];
  assert.ok(startBar < n / 2 && endBar > n / 2, 'window must straddle the peak');
  assert.ok(startBar >= 4, 'must never start before bar 4');
});

test('findCombatWindows: caps at `cap`, respects minSepBars, and truncates over-long runs', () => {
  const n = 120;
  const energies = new Array(n).fill(0.1);
  // Three separated humps, all above threshold.
  for (const center of [20, 60, 100]) {
    for (let i = center - 6; i <= center + 6; i++) if (i >= 0 && i < n) energies[i] = 1.0;
  }
  const windows = findCombatWindows(energies, { minLen: 4, cap: 2, minSepBars: 10, z: 0.3 });
  assert.ok(windows.length <= 2);
  for (let i = 1; i < windows.length; i++) {
    assert.ok(windows[i].startBar - windows[i - 1].endBar >= 10, 'windows must respect minSepBars');
  }
  // A run much longer than maxLen truncates rather than spanning it whole.
  const longEnergies = new Array(n).fill(0).map((_, i) => (i > 10 && i < 110 ? 1 : 0));
  const truncated = findCombatWindows(longEnergies, { minLen: 4, maxLen: 20, cap: 1 });
  assert.equal(truncated.length, 1);
  assert.ok(truncated[0].endBar - truncated[0].startBar <= 20);
});

test('findCombatWindows is deterministic', () => {
  const energies = new Array(60).fill(0).map((_, i) => 0.3 + 0.5 * Math.sin(i / 5));
  assert.deepEqual(findCombatWindows(energies), findCombatWindows(energies));
});

test('escalationTargets: 1->2 at alive>=4, 2->3 at alive>=6, never de-escalates', () => {
  assert.equal(escalationTargets(0, 1), 1);
  assert.equal(escalationTargets(3, 1), 1);
  assert.equal(escalationTargets(4, 1), 2);
  assert.equal(escalationTargets(5, 2), 2);
  assert.equal(escalationTargets(6, 2), 3);
  assert.equal(escalationTargets(1, 3), 3, 'must never drop back down within the same call');
  // A defender count never decreases across a plausible declining sequence.
  let d = 1;
  for (const alive of [2, 6, 9, 3, 1, 0]) {
    const next = escalationTargets(alive, d);
    assert.ok(next >= d, `defenders must not decrease: ${next} < ${d}`);
    d = next;
  }
});

test('assignSlot: every assigned slot lies at/after earliestMs and respects global + per-shooter gaps', () => {
  const grid = Array.from({ length: 40 }, (_, i) => i * 125); // 8th-note-ish spacing
  // No prior kills: first slot at/after earliestMs.
  let slot = assignSlot(grid, 500, -1, -1, 2);
  assert.ok(slot >= 0 && grid[slot] >= 500);
  // Global floor: must be strictly after globalLastSlot.
  slot = assignSlot(grid, 0, 10, -1, 2);
  assert.ok(slot > 10);
  // Per-shooter gap: must be at least minGapSlots after the shooter's own last slot.
  slot = assignSlot(grid, 0, -1, 5, 3);
  assert.ok(slot >= 8);
  // Exhausted grid returns -1.
  slot = assignSlot(grid, grid[grid.length - 1] + 1000, -1, -1, 1);
  assert.equal(slot, -1);
});

test('travelMsFor is clamped to [130,210] and grows with distance up to the clamp', () => {
  assert.equal(travelMsFor(0), 130);
  assert.equal(travelMsFor(1e9), 210);
  const near = travelMsFor(50);
  const far = travelMsFor(150);
  assert.ok(far >= near);
  assert.ok(Math.abs(travelMsFor(DOT_SPEED_PX_S) - 1000) < 1e-9 ? true : travelMsFor(DOT_SPEED_PX_S) === 210 || travelMsFor(DOT_SPEED_PX_S) === 130);
});

test('dotU reaches exactly 1 at departMs+travelMs (killMs) and is clamped/bounded otherwise', () => {
  const departMs = 1000, travelMs = 180;
  assert.equal(dotU(departMs, departMs, travelMs), 0);
  assert.equal(dotU(departMs + travelMs, departMs, travelMs), 1);
  assert.equal(dotU(departMs + travelMs + 500, departMs, travelMs), 1, 'clamped past arrival');
  assert.equal(dotU(departMs - 500, departMs, travelMs), 0, 'clamped before departure');
  const mid = dotU(departMs + travelMs / 2, departMs, travelMs);
  assert.ok(Math.abs(mid - 0.5) < 1e-9);
});

test('BattleDirector: a full window runs the drama arc and every kill lands exactly on the 16th grid', () => {
  const barMs = 500;
  const bars = 240; // 120s song
  const durationMs = bars * barMs;
  const barGrid = Array.from({ length: bars }, (_, i) => ({ tick: i * 1920, ms: i * barMs, numerator: 4, denominator: 4 }));
  // A wide high-energy plateau (bars 40..100) so a combat window reliably opens.
  const fakeEnergy = {
    globalEnergy: (tMs) => {
      const bar = tMs / barMs;
      return (bar >= 40 && bar <= 100) ? 1.0 : 0.1;
    },
  };
  const director = new BattleDirector({ barGrid, durationMs, energyCurves: fakeEnergy, seed: 7 });
  assert.ok(director._windows.length >= 1, 'a combat window must be found over the plateau');

  const anchors = [{ x: 220, y: 300 }, { x: 300, y: 540 }, { x: 500, y: 540 }];
  const defendersSeen = new Set();
  let sawBattle = false;
  const dtMs = 16;
  let nowMs = 0;
  const stopMs = durationMs; // run the whole song
  while (nowMs < stopMs) {
    director.update(nowMs, dtMs, anchors, 0, false);
    if (director.phase === 'BATTLE' || director.phase === 'FINALE') sawBattle = true;
    defendersSeen.add(director.defenders);
    nowMs += dtMs;
  }

  assert.ok(sawBattle, 'the director must actually enter battle at some point');
  assert.ok(defendersSeen.has(2) || defendersSeen.has(3), 'escalation must occur under a sustained plateau');
  assert.equal(director.phase, 'IDLE', 'must resolve back to idle by the end of the song');
  assert.equal(director.enemies.active.length, 0, 'no enemies should remain alive');
  assert.equal(director.dots.active.length, 0, 'no dots should remain in flight');
  assert.ok(director.lastKills.length > 0, 'the battle must have produced kills');

  const fullGrid = sixteenthsInRange(barGrid, durationMs, 0, durationMs);
  for (const { killMs } of director.lastKills) {
    const onGrid = fullGrid.some((t) => Math.abs(t - killMs) < 1e-6);
    assert.ok(onGrid, `kill at ${killMs} is not on the 16th-note grid`);
  }
  // Every enemy takes two hits (hp=2): the number of recorded kills must
  // equal the number of enemies actually spawned, not double-count the
  // stagger as a kill.
  assert.equal(director.lastKills.length, director._enemySeq, 'exactly one kill per enemy spawned, despite two hits each');
});

test('BattleDirector: a stagger hit knocks back and re-queues the enemy; only the finishing hit vaporizes and records a kill', () => {
  const barMs = 500;
  const barGrid = Array.from({ length: 20 }, (_, i) => ({ tick: i * 1920, ms: i * barMs, numerator: 4, denominator: 4 }));
  const director = new BattleDirector({ barGrid, durationMs: 10000, energyCurves: null, seed: 3 });

  const enemy = director.enemies.spawn({
    id: 999, kind: 'flyer', sx: 500, sy: 300, bobPhase: 0, spawnMs: 0,
    shooterIdx: 0, killMs: 1000, departMs: 800, travelMs: 200,
    fired: true, locked: true, hp: 2, staggerMs: -Infinity,
  });
  director.dots.spawn({ enemyId: 999, shooterIdx: 0, x0: 220, y0: 300, departMs: 800, travelMs: 200, killMs: 1000 });

  director._advanceDots(1000); // the dot arrives exactly on killMs
  assert.equal(director.enemies.active.length, 1, 'a stagger must not remove the enemy');
  assert.equal(enemy.hp, 1, 'hp decrements on a stagger');
  assert.equal(enemy.shooterIdx, -1, 'a staggered enemy is unassigned for reassignment');
  assert.equal(enemy.sx, 526, 'a stagger knocks the enemy back');
  assert.equal(director.dots.active.length, 0, 'the spent dot is consumed');
  assert.equal(director.lastKills.length, 0, 'a stagger is not a kill');

  // The finishing hit: re-lock and fire a second dot.
  Object.assign(enemy, { shooterIdx: 1, killMs: 1500, departMs: 1300, travelMs: 200, fired: true, locked: true });
  director.dots.spawn({ enemyId: 999, shooterIdx: 1, x0: 300, y0: 540, departMs: 1300, travelMs: 200, killMs: 1500 });
  director._advanceDots(1500);
  assert.equal(director.enemies.active.length, 0, 'the finishing hit vaporizes the enemy');
  assert.equal(director.lastKills.length, 1, 'only the finishing hit records a kill');
  assert.equal(director.lastKills[0].killMs, 1500);
});
