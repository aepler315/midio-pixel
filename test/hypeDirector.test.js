import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HypeDirector, hypeFrameStyle, slamAt, surgeAt, trioHypeFrameStyle } from '../src/sim/HypeDirector.js';

// HypeDirector's drop detector reads globalEnergyNorm -- see CalmDirector's
// test for why a fixed-value stub is the right fixture for these thresholds.
function fakeEnergy(value) {
  return { globalEnergy: () => value, globalEnergyNorm: () => value };
}

const STEP = 1 / 120;

test('a sudden loud attack after a quiet stretch fires exactly one drop', () => {
  const hype = new HypeDirector();
  let t = 0;
  for (let i = 0; i < 600; i++) { hype.update(t, STEP, fakeEnergy(0.1)); t += 8.33; } // 5s quiet
  assert.equal(hype.dropCount, 0);

  for (let i = 0; i < 120; i++) { hype.update(t, STEP, fakeEnergy(0.95)); t += 8.33; } // the drop hits
  assert.equal(hype.dropCount, 1, 'the attack must register as a drop');
  assert.ok(hype.surge > 0.5, 'surge should still be hot right after');
});

test('sustained loud music never re-fires: fast and slow EMAs converge', () => {
  const hype = new HypeDirector();
  let t = 0;
  for (let i = 0; i < 600; i++) { hype.update(t, STEP, fakeEnergy(0.1)); t += 8.33; }
  for (let i = 0; i < 2400; i++) { hype.update(t, STEP, fakeEnergy(0.95)); t += 8.33; } // 20s loud
  assert.equal(hype.dropCount, 1, 'only the initial attack counts, not the sustain');
});

test('the cooldown blocks rapid-fire drops from an oscillating dynamic', () => {
  const hype = new HypeDirector();
  let t = 0;
  // Alternate 1.5s quiet / 1.5s loud for 12s: without a cooldown this would
  // fire every cycle; with it, at most every 6s.
  for (let i = 0; i < 1440; i++) {
    const loud = Math.floor(t / 1500) % 2 === 1;
    hype.update(t, STEP, fakeEnergy(loud ? 0.95 : 0.05));
    t += 8.33;
  }
  assert.ok(hype.dropCount <= 2, `cooldown must cap drops, got ${hype.dropCount}`);
});

test('kick slams spike and decay; surge decays; ring window opens then closes', () => {
  const hype = new HypeDirector();
  hype.onKick(1);
  assert.ok(hype.slam >= 0.9);
  let t = 0;
  for (let i = 0; i < 60; i++) { hype.update(t, STEP, fakeEnergy(0.3)); t += 8.33; } // 0.5s
  assert.ok(hype.slam < 0.05, 'slam must decay within half a second');

  hype.dropAtMs = t;
  assert.ok(hype.ringU(t + 100) > 0 && hype.ringU(t + 100) < 1);
  assert.equal(hype.ringU(t + 2000), null, 'ring must close after its window');
});

test('buildUp rises on a sustained energy ramp without ever firing a drop', () => {
  const hype = new HypeDirector();
  let t = 0;
  // Fully settle at a flat level first (~5 slow-EMA time constants) so the
  // startup transient itself (slow catching up to fast from 0) isn't
  // mistaken for a ramp.
  for (let i = 0; i < 1500; i++) { hype.update(t, STEP, fakeEnergy(0.1)); t += 8.33; }
  assert.ok(hype.buildUp < 0.05, 'no ramp yet -- buildUp should sit near 0');

  // A gradual, sustained rise -- never a sudden attack, so no drop should fire.
  for (let i = 0; i < 600; i++) {
    const e = 0.1 + 0.6 * (i / 600);
    hype.update(t, STEP, fakeEnergy(e));
    t += 8.33;
  }
  assert.equal(hype.dropCount, 0, 'a gradual ramp is a build-up, not a drop');
  assert.ok(hype.buildUp > 0.15, `expected buildUp to rise on a sustained crescendo, got ${hype.buildUp}`);
});

test('buildUp settles back toward 0 once the ramp plateaus', () => {
  const hype = new HypeDirector();
  let t = 0;
  for (let i = 0; i < 600; i++) {
    const e = 0.1 + 0.7 * Math.min(1, i / 400);
    hype.update(t, STEP, fakeEnergy(e));
    t += 8.33;
  }
  const peak = hype.buildUp;
  // Hold steady at the plateau -- fast catches up to slow, delta -> 0.
  for (let i = 0; i < 600; i++) { hype.update(t, STEP, fakeEnergy(0.8)); t += 8.33; }
  assert.ok(hype.buildUp < peak * 0.3, `buildUp should decay once the ramp plateaus, was ${peak}, now ${hype.buildUp}`);
});

test('hypeFrameStyle nearly extinguishes the rim during calm; energetic still reads', () => {
  const hot = { fast: 0.6, slam: 1, surge: 0 };
  const calmHot = hypeFrameStyle(hot, 1);
  const wildHot = hypeFrameStyle(hot, 0);
  assert.ok(calmHot.alpha < 0.08, `calm + kick slam should barely flash the rim, got ${calmHot.alpha}`);
  assert.ok(wildHot.alpha > 0.35, `energetic slam should still light the frame, got ${wildHot.alpha}`);
  assert.ok(calmHot.alpha < wildHot.alpha * 0.25, 'calm must cut most of the kick-strobe');

  const drop = { fast: 0.2, slam: 0, surge: 1 };
  const calmDrop = hypeFrameStyle(drop, 1);
  const wildDrop = hypeFrameStyle(drop, 0);
  assert.ok(calmDrop.alpha > calmHot.alpha, 'a drop surge should still peek through calm more than a kick');
  assert.ok(wildDrop.alpha > calmDrop.alpha, 'full surge is brighter when not calm');
  assert.ok(calmDrop.echo > 0 || wildDrop.echo > 0);

  const idle = hypeFrameStyle({ fast: 0.15, slam: 0, surge: 0 }, 1);
  assert.ok(idle.alpha < 0.03, 'fully calm idle rim should be almost gone');
});

// Trio's hype on heard time: pure functions of the song position.
const KICKS = [
  { tMs: 1000, vel: 1 }, { tMs: 1100, vel: 0.4 }, { tMs: 1500, vel: 0.8 }, { tMs: 2000, vel: 0.2 },
];

test('slamAt and trioHypeFrameStyle are the same for one 33 ms step as for four 8.33 ms steps', () => {
  const hype = { fast: 0.6, slam: 0.9, surge: 0.9, dropAtMs: 1480 };
  for (let t0 = 900; t0 < 2300; t0 += 7) {
    const one = { slam: slamAt(KICKS, t0 + 33.32), style: trioHypeFrameStyle(hype, 0.3, t0 + 33.32, KICKS) };
    let four;
    for (let k = 1; k <= 4; k++) {
      const t = t0 + 8.33 * k;
      four = { slam: slamAt(KICKS, t), style: trioHypeFrameStyle(hype, 0.3, t, KICKS) };
    }
    assert.deepEqual(four, one, `t0=${t0}`);
  }
});

test('slamAt: nothing before the first kick, a peak at the heard kick, gone after its window', () => {
  assert.equal(slamAt(KICKS, 999.9), 0, 'no lookahead');
  assert.equal(slamAt(KICKS, 0), 0);
  assert.equal(slamAt([], 1000), 0);
  assert.equal(slamAt(null, 1000), 0);
  assert.equal(slamAt(KICKS, 1000), 1, '.35 + .65 * vel at age 0');
  assert.ok(Math.abs(slamAt(KICKS, 1110) - Math.max(1 - 110 / 220, (0.35 + 0.65 * 0.4) * (1 - 10 / 220))) < 1e-12,
    'the strongest live kick wins');
  assert.ok(Math.abs(slamAt(KICKS, 1050) - (1 - 50 / 220)) < 1e-12);
  assert.ok(Math.abs(slamAt(KICKS, 1500) - (0.35 + 0.65 * 0.8)) < 1e-12);
  assert.equal(slamAt(KICKS, 1720), 0, 'a kick is gone 220 ms later');
  assert.ok(slamAt(KICKS, 1600) < slamAt(KICKS, 1550), 'and decays on the way');
});

test('surgeAt is 0 before the drop, 1 at it, and decays to 0', () => {
  assert.equal(surgeAt(5000, 4999), 0);
  assert.equal(surgeAt(-Infinity, 4999), 0, 'no drop yet');
  assert.equal(surgeAt(5000, 5000), 1);
  assert.ok(surgeAt(5000, 6000) > 0 && surgeAt(5000, 6000) < 1);
  assert.equal(surgeAt(5000, 5000 + 2200), 0);
  assert.equal(surgeAt(5000, 9000), 0);
});

test('trioHypeFrameStyle ignores the director\'s dispatch-clock slam and surge', () => {
  const ahead = { fast: 0.5, slam: 1, surge: 1, dropAtMs: 5000 }; // dispatch already past the kick and drop
  const quiet = trioHypeFrameStyle(ahead, 0, 4900, KICKS);
  assert.deepEqual(quiet, hypeFrameStyle({ fast: 0.5, slam: 0, surge: 0 }, 0), 'not heard yet: no slam, no surge');
  const heard = trioHypeFrameStyle(ahead, 0, 5000, [{ tMs: 5000, vel: 1 }]);
  assert.deepEqual(heard, hypeFrameStyle({ fast: 0.5, slam: 1, surge: 1 }, 0));
});
