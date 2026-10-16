import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Burrow, BurrowPhase } from '../src/sim/Burrow.js';

const STEP_MS = 1000 / 120;

function advance(burrow, t, seconds, worldX = 500, groundField = null) {
  const steps = Math.round((seconds * 1000) / STEP_MS);
  for (let i = 0; i < steps; i++) {
    t += STEP_MS;
    burrow.update(t, STEP_MS / 1000, worldX, groundField);
  }
  return t;
}

function makeMockGroundField() {
  return {
    calls: [], pulseAt(nowMs, worldX, sagPx, recoverAtMs) { this.calls.push({ nowMs, worldX, sagPx, recoverAtMs }); },
    impulseCalls: [], impulse(worldX, strength, nowMs) { this.impulseCalls.push({ worldX, strength, nowMs }); },
  };
}

test('a fresh burrow is idle and inactive', () => {
  const b = new Burrow(1);
  assert.equal(b.phase, BurrowPhase.IDLE);
  assert.equal(b.active, false);
  assert.equal(b.depth, 0);
});

test('trigger enters DIG_IN, generates cave geometry, and becomes active', () => {
  const b = new Burrow(1);
  const ok = b.trigger(0, { x: 300, y: 480 }, 500, 480);
  assert.equal(ok, true);
  assert.equal(b.phase, BurrowPhase.DIG_IN);
  assert.equal(b.active, true);
  assert.ok(b.contours.length > 0, 'cave should generate at least one contour');
  for (const c of b.contours) {
    assert.ok(c.points.length >= 3);
    assert.equal(c.insets.length, 2);
  }
});

test('trigger is a no-op while already active', () => {
  const b = new Burrow(1);
  b.trigger(0, { x: 300, y: 480 }, 500, 480);
  const contoursBefore = b.contours;
  const ok = b.trigger(0, { x: 999, y: 999 }, 9999, 480);
  assert.equal(ok, false);
  assert.equal(b.contours, contoursBefore, 'a second trigger must not regenerate the cave');
});

test('the entry point is always in open space, not inside rock', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const b = new Burrow(seed);
    b.trigger(0, { x: 300, y: 480 }, 500, 480);
    const noiseAtEntry = b._noiseAt(b._gx, b._gy);
    assert.ok(noiseAtEntry <= 0.5, `seed ${seed}: entry point should be open, noise=${noiseAtEntry.toFixed(3)}`);
  }
});

test('cave generation is deterministic for a given seed and worldX', () => {
  const a = new Burrow(7);
  const b = new Burrow(7);
  a.trigger(0, { x: 300, y: 480 }, 500, 480);
  b.trigger(0, { x: 300, y: 480 }, 500, 480);
  assert.equal(a.contours.length, b.contours.length);
  assert.deepEqual(a.stalactites, b.stalactites);
  assert.deepEqual(a.stalagmites, b.stalagmites);
  assert.deepEqual(a.crystals, b.crystals);
});

test('phases progress DIG_IN -> TUNNELING -> ERUPT -> IDLE in order', () => {
  const b = new Burrow(2);
  let t = 0;
  b.trigger(t, { x: 300, y: 480 }, 500, 480);
  let elapsed = 0;
  const goTo = (target) => { t = advance(b, t, target - elapsed); elapsed = target; };

  goTo(0.5);
  assert.equal(b.phase, BurrowPhase.DIG_IN);
  goTo(0.9); // past DIG_IN_SEC (0.7)
  assert.equal(b.phase, BurrowPhase.TUNNELING);
  goTo(8.9); // past TUNNEL_SEC (8.0) since entering TUNNELING at 0.7
  assert.equal(b.phase, BurrowPhase.ERUPT);
  goTo(9.5); // past ERUPT_SEC (0.5) since entering ERUPT at ~8.7
  assert.equal(b.phase, BurrowPhase.IDLE);
  assert.equal(b.active, false);
  assert.equal(b.contours.length, 0, 'cave geometry is cleared once he surfaces');
});

test('depth ramps 0->1 during DIG_IN, holds at 1 through TUNNELING, ramps back down in ERUPT', () => {
  const b = new Burrow(3);
  let t = 0;
  b.trigger(t, { x: 300, y: 480 }, 500, 480);
  let elapsed = 0;
  const goTo = (target) => { t = advance(b, t, target - elapsed); elapsed = target; };

  goTo(0.1);
  assert.ok(b.depth > 0 && b.depth < 1, `expected mid-dig depth, got ${b.depth}`);
  goTo(0.8);
  assert.equal(b.phase, BurrowPhase.TUNNELING);
  assert.equal(b.depth, 1);
  goTo(8.8);
  assert.equal(b.phase, BurrowPhase.ERUPT);
  assert.ok(b.depth > 0 && b.depth <= 1, `expected high-but-draining depth early in eruption, got ${b.depth}`);
});

test('forceEnd immediately begins eruption from any active phase', () => {
  const b = new Burrow(4);
  let t = 0;
  b.trigger(t, { x: 300, y: 480 }, 500, 480);
  t = advance(b, t, 2); // now well into TUNNELING
  assert.equal(b.phase, BurrowPhase.TUNNELING);
  b.forceEnd(t);
  assert.equal(b.phase, BurrowPhase.ERUPT);
});

test('forceEnd is a no-op when already idle', () => {
  const b = new Burrow(5);
  b.forceEnd(1000);
  assert.equal(b.phase, BurrowPhase.IDLE);
});

test('steering never advances into rock -- a hard invariant, checked every frame of tunneling', () => {
  for (const seed of [10, 11, 12]) {
    const b = new Burrow(seed);
    let t = 0;
    b.trigger(t, { x: 300, y: 480 }, 500, 480);
    t = advance(b, t, 0.8); // clear DIG_IN
    assert.equal(b.phase, BurrowPhase.TUNNELING);
    for (let i = 0; i < 6 * 120; i++) {
      t += STEP_MS;
      b.update(t, STEP_MS / 1000, 500);
      if (b.phase !== BurrowPhase.TUNNELING) break;
      const noiseHere = b._noiseAt(b._gx, b._gy);
      assert.ok(noiseHere <= 0.5 + 1e-9, `seed ${seed}: swam into rock, noise=${noiseHere.toFixed(3)} at t=${t}`);
    }
  }
});

test('the mole-ridge surface tell pulses the ground field periodically during tunneling', () => {
  const b = new Burrow(6);
  const gf = makeMockGroundField();
  let t = 0;
  b.trigger(t, { x: 300, y: 480 }, 500, 480);
  t = advance(b, t, 0.8, 500, gf); // clear DIG_IN (fires one dig-in pulse)
  const afterDigIn = gf.calls.length;
  assert.ok(afterDigIn >= 1, 'DIG_IN should fire one ground pulse');
  advance(b, t, 4, 500, gf); // several ridge periods (1.0s each)
  assert.ok(gf.calls.length > afterDigIn + 1, 'tunneling should fire multiple mole-ridge pulses over 4s');
});

test('eruption fires a ground pulse at the surface point', () => {
  const b = new Burrow(8);
  const gf = makeMockGroundField();
  let t = 0;
  b.trigger(t, { x: 300, y: 480 }, 500, 480);
  t = advance(b, t, 8.8, 500, gf); // clear DIG_IN + TUNNELING
  assert.equal(b.phase, BurrowPhase.ERUPT);
  const eruptCall = gf.calls[gf.calls.length - 1];
  assert.ok(eruptCall.sagPx > 30, 'eruption pulse should be a pronounced sag, not a small ridge tick');
  assert.equal(gf.impulseCalls.length, 1, 'the eruption should also send exactly one terrain ripple');
  assert.ok(gf.impulseCalls[0].strength > 0.5, 'the eruption ripple should be a strong one');
  assert.equal(gf.impulseCalls[0].worldX, eruptCall.worldX, 'ripple and pulse must anchor to the same eruption site');
});

test('a full burrow cycle never produces NaN/Infinity', () => {
  const b = new Burrow(9);
  let t = 0;
  b.trigger(t, { x: 300, y: 480 }, 500, 480);
  for (let i = 0; i < 10 * 120; i++) {
    t += STEP_MS;
    b.update(t, STEP_MS / 1000, 500);
    assert.ok(Number.isFinite(b.p.x) && Number.isFinite(b.p.y), `position finite at t=${t}`);
    assert.ok(Number.isFinite(b.depth), `depth finite at t=${t}`);
  }
});

test('stalactites and stalagmites stay within the reasonable spike cap', () => {
  for (const seed of [20, 21, 22]) {
    const b = new Burrow(seed);
    b.trigger(0, { x: 300, y: 480 }, 500, 480);
    assert.ok(b.stalactites.length + b.stalagmites.length <= 14);
    assert.ok(b.crystals.length <= 5);
  }
});

// --- Resonance pass: the cavern hears the music ---

function intoTunneling(seed) {
  const b = new Burrow(seed);
  let t = 0;
  b.trigger(t, { x: 300, y: 480 }, 500, 480);
  t = advance(b, t, 0.8);
  assert.equal(b.phase, BurrowPhase.TUNNELING);
  return { b, t };
}

test('a kick while tunneling spawns a pressure ring and flashes the crystals', () => {
  const { b, t } = intoTunneling(30);
  b.onKick(0.9);
  assert.equal(b.rings.length, 1);
  assert.equal(b.crystalFlash, 1);
  const t2 = advance(b, t, 0.5); // past the 0.4s ring life
  assert.equal(b.rings.length, 0, 'rings expire');
  assert.ok(b.crystalFlash < 0.05, 'the flash decays');
  void t2;
});

test('kicks outside tunneling are ignored; ring count stays capped under spam', () => {
  const b = new Burrow(31);
  b.onKick(0.9);
  assert.equal(b.rings.length, 0, 'idle: no rings');
  const { b: b2 } = intoTunneling(31);
  for (let i = 0; i < 12; i++) b2.onKick(1.0);
  assert.ok(b2.rings.length <= 4, `rings must stay capped, got ${b2.rings.length}`);
});

test('a melody onset shakes a drip loose from the stalactite nearest his x', () => {
  // Find a seed whose cave actually grew stalactites.
  let picked = null;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const b = new Burrow(seed);
    b.trigger(0, { x: 300, y: 480 }, 500, 480);
    if (b.stalactites.length > 0) { picked = seed; break; }
  }
  assert.ok(picked !== null, 'expected at least one test seed to generate stalactites');

  const { b, t } = intoTunneling(picked);
  b.onMelodyOnset({ pitch: 64, vel: 0.7 });
  assert.equal(b.drips.length, 1);
  const drip = b.drips[0];
  const lx = b._gx * 13; // CELL_PX
  const nearestDist = Math.min(...b.stalactites.map((s) => Math.abs(s.x - lx)));
  assert.ok(Math.abs(Math.abs(drip.x - lx) - nearestDist) < 1e-9, 'the drip hangs from the NEAREST stalactite');

  const y0 = drip.y;
  advance(b, t, 0.3);
  assert.ok(b.drips.length === 0 || b.drips[0].y > y0, 'drips fall under gravity');
});

test('a melody onset with no stalactites in the cave is a harmless no-op', () => {
  const { b } = intoTunneling(40);
  b.stalactites = []; // simulate a cave that grew none
  b.onMelodyOnset({ pitch: 64, vel: 0.7 });
  assert.equal(b.drips.length, 0);
});

test('bass energy feeds the wall-vibration EMA', () => {
  const { b, t } = intoTunneling(32);
  assert.ok(b._bass < 0.05);
  let t2 = t;
  for (let i = 0; i < 120; i++) {
    t2 += STEP_MS;
    b.update(t2, STEP_MS / 1000, 500, null, 1.0);
  }
  assert.ok(b._bass > 0.8, `expected the bass EMA to charge, got ${b._bass.toFixed(3)}`);
});

test('dig-in flings dirt shards, and the eruption flings a second, bigger burst', () => {
  const b = new Burrow(33);
  let t = 0;
  b.trigger(t, { x: 300, y: 480 }, 500, 480, 620);
  assert.ok(b.shards.length >= 10, 'dig-in should have flung shards');
  for (const s of b.shards) {
    assert.ok(Math.abs(s.wx - 620) < 30, 'dig-in shards spawn at the actual hole world-x');
    assert.ok(s.vy < 0, 'shards launch upward');
  }
  t = advance(b, t, 2); // shards from dig-in expire (max life ~1.1s)
  assert.equal(b.shards.length, 0);
  t = advance(b, t, 6.9); // reach the eruption (~8.7s total)
  assert.equal(b.phase, BurrowPhase.ERUPT);
  assert.ok(b.shards.length >= 14, 'the eruption flings its own burst');
});

test('shards keep flying (and eventually expire) after the burrow has gone idle', () => {
  const b = new Burrow(34);
  let t = 0;
  b.trigger(t, { x: 300, y: 480 }, 500, 480);
  t = advance(b, t, 8.8); // eruption fired its shards
  t = advance(b, t, 0.5); // past 9.2s total: now IDLE, shards mid-arc
  assert.equal(b.phase, BurrowPhase.IDLE);
  assert.ok(b.shards.length > 0, 'shards outlive the burrow');
  t = advance(b, t, 1.5);
  assert.equal(b.shards.length, 0, 'and then expire');
});

test('justSurfaced fires exactly once per burrow cycle', () => {
  const b = new Burrow(35);
  let t = 0;
  b.trigger(t, { x: 300, y: 480 }, 500, 480);
  let surfacedFrames = 0;
  for (let i = 0; i < 11 * 120; i++) {
    t += STEP_MS;
    b.update(t, STEP_MS / 1000, 500);
    if (b.justSurfaced) surfacedFrames++;
  }
  assert.equal(surfacedFrames, 1);
  assert.equal(b.justSurfaced, false);
});

test('the hole world-x defaults to worldX when not given (back-compat)', () => {
  const b = new Burrow(36);
  b.trigger(0, { x: 300, y: 480 }, 500, 480);
  assert.equal(b._holeWorldX, 500);
});

// --- Resonance veins: the melody builds a ley-line network in the rock ---

/** A tunneling burrow with a known crystal layout (>= 2 crystals). */
function intoTunnelingWithCrystals(seeds = [30, 31, 32, 33, 34, 35, 36, 37]) {
  for (const seed of seeds) {
    const b = new Burrow(seed);
    let t = 0;
    b.trigger(t, { x: 300, y: 480 }, 500, 480);
    if (b.crystals.length < 2) continue;
    t = advance(b, t, 0.8);
    assert.equal(b.phase, BurrowPhase.TUNNELING);
    return { b, t };
  }
  assert.fail('expected at least one test seed to generate >= 2 crystals');
  return null;
}

test('a melody onset charges the crystal selected by pitch class', () => {
  const { b } = intoTunnelingWithCrystals();
  const n = b.crystals.length;
  const pitch = 60 + 3; // pitch class 3
  const expectedIdx = 3 % n;
  b.onMelodyOnset({ pitch, vel: 1.0 });
  assert.ok(b.crystals[expectedIdx].charge > 0.3, 'the pitch-mapped crystal charges');
  for (let i = 0; i < n; i++) {
    if (i !== expectedIdx) assert.equal(b.crystals[i].charge, 0, `crystal ${i} should be untouched`);
  }
  // The same pitch class rings the SAME stone again -- a motif re-lights it.
  const before = b.crystals[expectedIdx].charge;
  b.onMelodyOnset({ pitch: pitch + 12, vel: 1.0 }); // same class, octave up
  assert.ok(b.crystals[expectedIdx].charge > before);
});

test('crystal charges ring down over time', () => {
  const { b, t } = intoTunnelingWithCrystals();
  b.onMelodyOnset({ pitch: 60, vel: 1.0 });
  const idx = 0 % b.crystals.length;
  const charged = b.crystals[idx].charge;
  advance(b, t, 3);
  assert.ok(b.crystals[idx].charge < charged * 0.5, 'charge should have decayed substantially over ~1.2 tau');
});

test('a vein forms only when BOTH crystals of a pair are charged, and dissolves as charge fades', () => {
  const { b, t } = intoTunnelingWithCrystals();
  const n = b.crystals.length;
  // Charge exactly one crystal: no pair, no vein.
  b.onMelodyOnset({ pitch: 60, vel: 1.0 }); // class 0 -> crystal 0
  let t2 = advance(b, t, 0.05);
  assert.equal(b.veins.length, 0, 'one hot crystal alone cannot arc');

  // Charge a second, different crystal.
  b.onMelodyOnset({ pitch: 61, vel: 1.0 }); // class 1 -> crystal 1 % n (differs since n >= 2)
  t2 = advance(b, t2, 0.05);
  assert.ok(b.veins.length >= 1, 'two hot crystals arc a vein');
  const v = b.veins[0];
  assert.ok(Array.isArray(v.pts) && v.pts.length >= 2, 'the vein has midpoint-displacement geometry');

  // Let the charges ring down below the threshold: the vein dissolves.
  advance(b, t2, 8);
  assert.equal(b.veins.length, 0, 'veins dissolve as the charge fades');
});

test('vein energy packets travel and wrap along the filament', () => {
  const { b, t } = intoTunnelingWithCrystals();
  b.onMelodyOnset({ pitch: 60, vel: 1.0 });
  b.onMelodyOnset({ pitch: 61, vel: 1.0 });
  let t2 = advance(b, t, 0.05);
  assert.ok(b.veins.length >= 1);
  const u0 = b.veins[0].packetU;
  advance(b, t2, 0.4);
  if (b.veins.length >= 1) {
    const u1 = b.veins[0].packetU;
    assert.ok(u1 !== u0, 'the packet advances along the vein');
    assert.ok(u1 >= 0 && u1 <= 1, 'and stays in [0, 1] (wrapping)');
  }
});

test('vein geometry re-jitters on its regen cadence but stays anchored at both crystals', () => {
  const { b, t } = intoTunnelingWithCrystals();
  b.onMelodyOnset({ pitch: 60, vel: 1.0 });
  b.onMelodyOnset({ pitch: 61, vel: 1.0 });
  let t2 = advance(b, t, 0.05);
  const v = b.veins[0];
  const a = b.crystals[v.i], c = b.crystals[v.j];
  const firstPts = v.pts;
  assert.ok(Math.hypot(firstPts[0].x - a.x, firstPts[0].y - a.y) < 1e-9, 'endpoint anchored at crystal A');
  const last = firstPts[firstPts.length - 1];
  assert.ok(Math.hypot(last.x - c.x, last.y - c.y) < 1e-9, 'endpoint anchored at crystal B');

  advance(b, t2, 0.2); // past the 120ms regen cadence
  if (b.veins.length >= 1) {
    assert.notEqual(b.veins[0].pts, firstPts, 'the filament re-jittered into new geometry');
  }
});

test('surfacing clears the vein network along with the cave', () => {
  const { b, t } = intoTunnelingWithCrystals();
  b.onMelodyOnset({ pitch: 60, vel: 1.0 });
  b.onMelodyOnset({ pitch: 61, vel: 1.0 });
  let t2 = advance(b, t, 0.05);
  assert.ok(b.veins.length >= 1);
  b.forceEnd(t2);
  advance(b, t2, 0.6); // through ERUPT into IDLE
  assert.equal(b.phase, BurrowPhase.IDLE);
  assert.equal(b.veins.length, 0);
});
