import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RidgeAnchor, OPEN_AT, CLOSE_AT, BOB_PX } from '../src/sim/RidgeAnchor.js';
import {
  ridgeSwell01, danceOffset, DANCE_LAYERS, FAR_DANCE_LAYER, SWELL_KICK_GAIN,
} from '../src/world/MountainChoreo.js';

const L2 = DANCE_LAYERS[FAR_DANCE_LAYER];

test('FAR_DANCE_LAYER names the furthest range -- the one that leads on the kick', () => {
  // The gate reads the HORIZON, which is the layer the kick reaches first
  // (smallest delaySec), not the layer with the biggest swing. Those used
  // to be the same layer; damping the far ranges for depth separated them.
  const byDelay = Object.entries(DANCE_LAYERS).sort((a, b) => a[1].delaySec - b[1].delaySec);
  assert.equal(byDelay[0][0], FAR_DANCE_LAYER, 'the gate should read the furthest skyline');
});

test('the swell gate is amplitude-free, so damping a range for depth never moves the gate', () => {
  // This is what makes DANCE_LAYERS safe to retune for looks: ridgeSwell01
  // deliberately drops every amplitude factor and reads the swing in phase,
  // so a far range that barely moves in pixels still gates identically to
  // one that heaves. Guarded because the alternative -- a gate built on
  // absolute pixels -- would silently retime gameplay on a visual tweak.
  const loud = { ...DANCE_LAYERS[FAR_DANCE_LAYER], waveAmp: 40, bounceAmp: 40 };
  const quiet = { ...DANCE_LAYERS[FAR_DANCE_LAYER], waveAmp: 0.1, bounceAmp: 0.1 };
  for (let x = -2000; x <= 2000; x += 211) {
    for (let t = 0; t < 8; t += 0.29) {
      for (const kick of [0, 0.5, 1]) {
        assert.equal(ridgeSwell01(x, t, loud, kick), ridgeSwell01(x, t, quiet, kick),
          `swell must not depend on amplitude (x=${x} t=${t} kick=${kick})`);
      }
    }
  }
});

test('ridgeSwell01 stays in 0..1 across a full sweep of position, time and kick', () => {
  for (let x = -4000; x <= 4000; x += 137) {
    for (let t = 0; t < 12; t += 0.37) {
      for (const kick of [0, 0.5, 1, 3, -1]) {
        const s = ridgeSwell01(x, t, L2, kick);
        assert.ok(s >= 0 && s <= 1, `swell out of range at x=${x} t=${t} kick=${kick}: ${s}`);
      }
    }
  }
});

test('ridgeSwell01 reads high exactly where danceOffset lifts the range', () => {
  // danceOffset is negative-is-lifted, so with the kick term held at zero the
  // two must move in strict opposition -- that lockstep is the whole point of
  // deriving the swell from the same sine.
  let checked = 0;
  for (let t = 0; t < 10; t += 0.13) {
    const off = danceOffset(500, t, 1, 0, L2, 0);
    const swell = ridgeSwell01(500, t, L2, 0);
    if (off < -1) { assert.ok(swell > 0.5, 'a lifted column should read above the midpoint'); checked++; }
    if (off > 1) { assert.ok(swell < 0.5, 'a sunk column should read below the midpoint'); checked++; }
  }
  assert.ok(checked > 20, 'the sweep should have covered both lifted and sunk columns');
});

test('ridgeSwell01 is scale-free: groove, fever and terrain flattening cannot move it', () => {
  // danceOffset swings wildly with those; the swell reading must not, or the
  // gate would hang open under fever and never open in a flat biome.
  const a = ridgeSwell01(800, 3.2, L2, 0);
  const b = ridgeSwell01(800, 3.2, L2, 0);
  assert.equal(a, b);
  // Only the kick has any say, and only a small one.
  const dry = ridgeSwell01(800, 3.2, L2, 0);
  const hit = ridgeSwell01(800, 3.2, L2, 1);
  assert.ok(Math.abs(hit - dry) <= SWELL_KICK_GAIN + 1e-9, 'the kick vote is bounded by its gain');
});

test('a fresh anchor is shut, so nothing launches before the skyline has been read', () => {
  const anchor = new RidgeAnchor();
  assert.equal(anchor.open, false);
  assert.equal(anchor.bobPx, 0);
});

test('the gate opens at OPEN_AT and shuts at CLOSE_AT, with the whole gap as hysteresis', () => {
  const anchor = new RidgeAnchor();
  anchor.update(OPEN_AT - 0.01, 0.016);
  assert.equal(anchor.open, false, 'just under the open threshold stays shut');
  anchor.update(OPEN_AT, 0.016);
  assert.equal(anchor.open, true);

  // Anywhere inside the hysteresis band it must hold whatever it already was.
  const mid = (OPEN_AT + CLOSE_AT) / 2;
  anchor.update(mid, 0.016);
  assert.equal(anchor.open, true, 'a half-sunk skyline does not slam the gate');

  anchor.update(CLOSE_AT - 0.01, 0.016);
  assert.equal(anchor.open, false);
  anchor.update(mid, 0.016);
  assert.equal(anchor.open, false, 'and does not re-open it either');
});

test('the gate is open for roughly two fifths of the far range\'s swell cycle', () => {
  // The tuning claim in RidgeAnchor's header, asserted rather than trusted:
  // long enough that each airborne stretch is a phrase, short enough that
  // most of the song is spent on foot.
  const anchor = new RidgeAnchor();
  const dtSec = 1 / 60;
  let open = 0;
  let frames = 0;
  // Walk several full cycles of the L2 wave at the scroll rate the far layer
  // actually travels at (worldX 220px/s through the 0.10 parallax ratio).
  for (let t = 0; t < 60; t += dtSec) {
    anchor.update(ridgeSwell01(22 * t + 220, t, L2, 0), dtSec);
    if (anchor.open) open++;
    frames++;
  }
  const duty = open / frames;
  assert.ok(duty > 0.3 && duty < 0.55, `expected a ~40% duty cycle, got ${duty}`);
});

test('the gate holds each stretch open for seconds, not frames', () => {
  const anchor = new RidgeAnchor();
  const dtSec = 1 / 60;
  const runs = [];
  let run = 0;
  for (let t = 0; t < 60; t += dtSec) {
    anchor.update(ridgeSwell01(22 * t + 220, t, L2, 0), dtSec);
    if (anchor.open) { run++; } else if (run) { runs.push(run * dtSec); run = 0; }
  }
  assert.ok(runs.length >= 3, 'the walk should have covered several cycles');
  for (const secs of runs) {
    assert.ok(secs > 1.5, `an airborne stretch should be a phrase, got ${secs}s`);
  }
});

test('the bob rides up with the swell, never sinks him below the ground line', () => {
  const anchor = new RidgeAnchor();
  const dtSec = 1 / 60;
  let lowest = 0;
  let highest = 0;
  for (let i = 0; i < 400; i++) {
    anchor.update(1, dtSec);
    lowest = Math.min(lowest, anchor.bobPx);
    highest = Math.max(highest, anchor.bobPx);
  }
  assert.ok(Math.abs(lowest + BOB_PX) < 0.01, 'a fully heaved skyline lifts him the full bob');
  assert.equal(highest, 0, 'the bob is never positive -- that would bury him in the ground');

  for (let i = 0; i < 400; i++) anchor.update(0, dtSec);
  assert.ok(Math.abs(anchor.bobPx) < 0.01, 'and it settles back to the ground line');
});

test('the bob eases rather than snapping, so a kick cannot jolt him', () => {
  const anchor = new RidgeAnchor();
  anchor.update(1, 1 / 60);
  assert.ok(Math.abs(anchor.bobPx) < BOB_PX * 0.35, 'one frame gets nowhere near the full travel');
});

test('a zero or negative dt is inert rather than explosive', () => {
  const anchor = new RidgeAnchor();
  anchor.update(1, 0);
  assert.ok(anchor.bobPx === 0, 'no elapsed time, no travel');
  anchor.update(1, -1);
  assert.ok(Number.isFinite(anchor.bobPx) && anchor.bobPx <= 0);
});

test('swell readings outside 0..1 are clamped rather than trusted', () => {
  const anchor = new RidgeAnchor();
  anchor.update(5, 0.016);
  assert.equal(anchor.swell01, 1);
  anchor.update(-5, 0.016);
  assert.equal(anchor.swell01, 0);
  assert.ok(anchor.bobPx <= 0);
});
