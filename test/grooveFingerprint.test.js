// The cross-song groove profile: what this player means when they tap.
//
// The load-bearing property is the one about cold starts. A player who has
// never tapped must get byte-identical behaviour to before this existed --
// the profile is only allowed to speak once it has genuinely been taught
// something, and even then only in proportion to how much.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GrooveFingerprint, bandShares, cosine, ROLE_LOW, ROLE_HIGH,
  MIN_ROLE_SAMPLES, MAX_OFFSET_MS,
} from '../src/sim/GrooveFingerprint.js';

/** A kick-shaped moment: energy piled into SUB/BASS. */
const KICKY = [0.8, 0.7, 0.15, 0.1, 0.05, 0.03, 0.02];
/** A hat-shaped moment: energy up in PRESENCE/AIR. */
const HATTY = [0.02, 0.03, 0.05, 0.1, 0.3, 0.8, 0.7];

function teach(fp, role, bands, n) {
  for (let i = 0; i < n; i++) fp.observe({ role, bands, tMs: i * 500, energyNorm: 0.5 });
  return fp;
}

test('bandShares normalizes to a shape, discarding absolute loudness', () => {
  const quiet = bandShares([0.08, 0.07, 0.015, 0.01, 0.005, 0.003, 0.002]);
  const loud = bandShares(KICKY); // the same shape, 10x louder
  for (let i = 0; i < 7; i++) {
    assert.ok(Math.abs(quiet[i] - loud[i]) < 1e-9, `band ${i} should match regardless of level`);
  }
  assert.ok(Math.abs(quiet.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'shares sum to 1');
});

test('bandShares and cosine survive silence without dividing by zero', () => {
  const zero = bandShares([0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(zero, new Array(7).fill(0));
  assert.equal(cosine(zero, bandShares(KICKY)), 0);
  assert.deepEqual(bandShares(null), new Array(7).fill(0));
});

test('a cold profile is completely inert -- callers must fall back', () => {
  const fp = new GrooveFingerprint();
  assert.equal(fp.ready, false);
  assert.equal(fp.strength(ROLE_LOW), 0);
  assert.equal(fp.score(KICKY), null, 'null means "use your own rule", not "no match"');
});

test('a profile stays inert right up until MIN_ROLE_SAMPLES', () => {
  const fp = teach(new GrooveFingerprint(), ROLE_LOW, KICKY, MIN_ROLE_SAMPLES - 1);
  assert.equal(fp.strength(ROLE_LOW), 0, 'one tap short is still cold');
  assert.equal(fp.score(KICKY), null);
  fp.observe({ role: ROLE_LOW, bands: KICKY, tMs: 9999, energyNorm: 0.5 });
  assert.ok(fp.strength(ROLE_LOW) >= 0, 'and now it has a say');
  assert.notEqual(fp.score(KICKY), null);
});

test('influence ramps with sample count instead of switching on', () => {
  const few = teach(new GrooveFingerprint(), ROLE_LOW, KICKY, MIN_ROLE_SAMPLES + 4);
  const many = teach(new GrooveFingerprint(), ROLE_LOW, KICKY, 200);
  assert.ok(few.strength(ROLE_LOW) < many.strength(ROLE_LOW), 'more taps, more say');
  assert.ok(many.strength(ROLE_LOW) <= 1);
});

test('the templates separate: a kicky moment scores low, a hatty one scores high', () => {
  const fp = new GrooveFingerprint();
  teach(fp, ROLE_LOW, KICKY, 20);
  teach(fp, ROLE_HIGH, HATTY, 20);

  const onKick = fp.score(KICKY);
  assert.ok(onKick.low > onKick.high, `kick moment: low ${onKick.low} should beat high ${onKick.high}`);
  const onHat = fp.score(HATTY);
  assert.ok(onHat.high > onHat.low, `hat moment: high ${onHat.high} should beat low ${onHat.low}`);
});

test('an unroled tap never pollutes either template', () => {
  const fp = new GrooveFingerprint();
  teach(fp, ROLE_LOW, KICKY, 20);
  const before = [...fp.low.template];
  for (let i = 0; i < 50; i++) fp.observe({ role: null, bands: HATTY, tMs: i * 100, energyNorm: 0.5 });
  assert.deepEqual(fp.low.template, before, 'we do not know which drum they meant');
  assert.equal(fp.high.count, 0);
});

test('the timing offset is a median, so one fumbled tap moves it barely at all', () => {
  const fp = new GrooveFingerprint();
  // Twenty taps consistently 30ms late...
  for (let i = 0; i < 20; i++) {
    fp.observe({ role: ROLE_LOW, bands: KICKY, tMs: i * 500 + 30, nearestOnsetMs: i * 500, energyNorm: 0.5 });
  }
  assert.ok(Math.abs(fp.offsetMs - 30) < 6, `expected ~30ms, got ${fp.offsetMs}`);
  // ...then one wild one at the very edge of the match window.
  fp.observe({ role: ROLE_LOW, bands: KICKY, tMs: 10000 + 175, nearestOnsetMs: 10000, energyNorm: 0.5 });
  assert.ok(Math.abs(fp.offsetMs - 30) < 6, `a single outlier must not drag it, got ${fp.offsetMs}`);
});

test('taps nowhere near an onset teach nothing about timing', () => {
  const fp = new GrooveFingerprint();
  fp.observe({ role: ROLE_LOW, bands: KICKY, tMs: 5000, nearestOnsetMs: 0, energyNorm: 0.5 });
  assert.equal(fp.offsetMs, 0, 'that tap was not aimed at that onset');
});

test('the learned offset is clamped -- this is feel, not audio latency', () => {
  const fp = new GrooveFingerprint();
  for (let i = 0; i < 20; i++) {
    fp.observe({ role: ROLE_LOW, bands: KICKY, tMs: i * 500 + 170, nearestOnsetMs: i * 500, energyNorm: 0.5 });
  }
  assert.ok(Math.abs(fp.offsetMs) <= MAX_OFFSET_MS);
});

test('intensity converges on how hot the player likes to tap', () => {
  const fp = new GrooveFingerprint();
  for (let i = 0; i < 40; i++) fp.observe({ role: ROLE_LOW, bands: KICKY, tMs: i * 500, energyNorm: 0.8 });
  assert.ok(Math.abs(fp.intensity - 0.8) < 0.05, `expected ~0.8, got ${fp.intensity}`);
});

test('a profile round-trips through storage', () => {
  const fp = new GrooveFingerprint();
  teach(fp, ROLE_LOW, KICKY, 20);
  teach(fp, ROLE_HIGH, HATTY, 15);
  for (let i = 0; i < 10; i++) {
    fp.observe({ role: ROLE_LOW, bands: KICKY, tMs: i * 500 + 25, nearestOnsetMs: i * 500, energyNorm: 0.6 });
  }

  const revived = new GrooveFingerprint(JSON.stringify(fp.toJSON()));
  assert.equal(revived.low.count, fp.low.count);
  assert.equal(revived.high.count, fp.high.count);
  assert.deepEqual(revived.low.template, fp.low.template);
  assert.ok(Math.abs(revived.offsetMs - fp.offsetMs) < 1e-9);
  assert.ok(Math.abs(revived.intensity - fp.intensity) < 1e-9);
  const a = revived.score(KICKY), b = fp.score(KICKY);
  assert.ok(Math.abs(a.low - b.low) < 1e-9, 'and it classifies identically after the round trip');
});

test('garbage in storage yields a blank profile rather than throwing', () => {
  for (const junk of ['not json at all', '{"low":{"template":[1,2]}}', '{}', 'null', '[]']) {
    const fp = new GrooveFingerprint(junk);
    assert.equal(fp.ready, false, `${junk} should leave it cold`);
  }
  const nan = new GrooveFingerprint('{"low":{"template":[null,1,1,1,1,1,1],"count":99}}');
  assert.equal(nan.ready, false, 'a non-finite template is rejected wholesale');
});

test('reset returns a taught profile to cold', () => {
  const fp = teach(new GrooveFingerprint(), ROLE_LOW, KICKY, 30);
  assert.ok(fp.ready);
  fp.reset();
  assert.equal(fp.ready, false);
  assert.equal(fp.score(KICKY), null);
  assert.equal(fp.offsetMs, 0);
});
