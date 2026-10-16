// A seek jumps `nowMs` by however far the player scrubbed -- arbitrarily
// far, in either direction, in a single update() call. TelegraphScanner's
// resting-pose spring (5 Hz, zeta 0.55) integrates with explicit Euler using
// `dtSec` derived directly from that same nowMs, unclamped: measured live,
// one real seek fed a ~59-second "dtSec" into the spring and produced
// midio.scaleY = 120 / scaleX = 1/120 in a single call -- a numerically
// exploded spring, rendered as Midio's own mesh stretched thousands of px
// off toward a screen edge (reported as "a straight line casting out from
// midio to the edge of the screen").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegraphScanner } from '../src/sim/TelegraphScanner.js';

function fakeConductor() {
  return { peekWindow: () => [] };
}
function fakeMidio() {
  return { scaleX: 1, scaleY: 1, leanDeg: 0, screenX: 100 };
}
function fakeJump() {
  return { airborne: false };
}
function fakeImpactFX() {
  return { sputter() {} };
}

test('a normal small per-frame dtSec relaxes the spring smoothly toward neutral', () => {
  const ts = new TelegraphScanner();
  const midio = fakeMidio();
  midio.scaleY = 0.8; // mid-relax, as if just past a landing squash
  const cond = fakeConductor(), jump = fakeJump(), fx = fakeImpactFX();
  let t = 1000;
  ts.update(t, cond, midio, jump, fx, 0, 0);
  for (let i = 0; i < 30; i++) {
    t += 1000 / 120; // one sim step
    ts.update(t, cond, midio, jump, fx, 0, 0);
  }
  assert.ok(Number.isFinite(midio.scaleY));
  assert.ok(midio.scaleY > 0.5 && midio.scaleY < 1.5, `expected a settling scaleY, got ${midio.scaleY}`);
});

test('a huge forward jump in nowMs (a seek) never blows the spring up', () => {
  const ts = new TelegraphScanner();
  const midio = fakeMidio();
  const cond = fakeConductor(), jump = fakeJump(), fx = fakeImpactFX();
  ts.update(1300, cond, midio, jump, fx, 0, 0); // establish _lastMs at 1300ms
  // The spring needs some displacement from neutral for a bad dtSec to
  // amplify -- an exactly-at-rest spring (scaleY=1, vel=0) has zero error
  // to blow up regardless of step size. A mid-squash value (as if caught
  // mid-landing right when the seek lands) is exactly the realistic case.
  midio.scaleY = 0.8;
  ts.update(60000, cond, midio, jump, fx, 0, 0); // seek forward ~58.7s in one call

  assert.ok(Number.isFinite(midio.scaleY) && Number.isFinite(midio.scaleX));
  assert.ok(
    Math.abs(midio.scaleY - 1) < 5,
    `scaleY should stay in a sane range after a huge nowMs jump, got ${midio.scaleY}`,
  );
  assert.ok(
    Math.abs(midio.scaleX - 1) < 5,
    `scaleX should stay in a sane range after a huge nowMs jump, got ${midio.scaleX}`,
  );
});

test('a mid-sized gap (a real stutter, between one frame and the settle threshold) never explodes either', () => {
  const ts = new TelegraphScanner();
  const midio = fakeMidio();
  const cond = fakeConductor(), jump = fakeJump(), fx = fakeImpactFX();
  ts.update(1300, cond, midio, jump, fx, 0, 0);
  midio.scaleY = 0.8;
  ts.update(1300 + 100, cond, midio, jump, fx, 0, 0); // a 100ms hitch -- not tiny, not a seek-sized gap
  assert.ok(Number.isFinite(midio.scaleY) && Number.isFinite(midio.scaleX));
  assert.ok(Math.abs(midio.scaleY - 1) < 5, `scaleY exploded on a 100ms gap: ${midio.scaleY}`);
});

test('a huge BACKWARD jump in nowMs (scrubbing back) is equally safe', () => {
  const ts = new TelegraphScanner();
  const midio = fakeMidio();
  const cond = fakeConductor(), jump = fakeJump(), fx = fakeImpactFX();
  ts.update(60000, cond, midio, jump, fx, 0, 0);
  midio.scaleY = 0.8;
  ts.update(1300, cond, midio, jump, fx, 0, 0); // seek backward ~58.7s

  assert.ok(Number.isFinite(midio.scaleY) && Number.isFinite(midio.scaleX));
  assert.ok(Math.abs(midio.scaleY - 1) < 5, `scaleY exploded on a backward jump: ${midio.scaleY}`);
});

test('repeated huge jumps never accumulate into a runaway spring', () => {
  const ts = new TelegraphScanner();
  const midio = fakeMidio();
  const cond = fakeConductor(), jump = fakeJump(), fx = fakeImpactFX();
  let t = 1000;
  ts.update(t, cond, midio, jump, fx, 0, 0);
  midio.scaleY = 0.8; // give the spring an initial error to potentially amplify
  for (let i = 0; i < 8; i++) {
    t += 60000 + i * 500;
    ts.update(t, cond, midio, jump, fx, 0, 0);
    assert.ok(Math.abs(midio.scaleY - 1) < 5, `scaleY exploded after jump #${i}: ${midio.scaleY}`);
  }
});
