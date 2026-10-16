// The overlay draws the Sync pass. These tests cover the timing it owns --
// how long a pass lasts and what a phase switch does to that -- which needs
// no DOM: every element it touches is optional, so it runs headless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecalibrationOverlay, RECAL_MEASURES } from '../src/ui/RecalibrationOverlay.js';

const BEAT = 500;
const PASS_MS = RECAL_MEASURES * 4 * BEAT; // 8 measures of 4 beats

test('a pass runs for its full eight measures', () => {
  const o = new RecalibrationOverlay({});
  o.start(0, BEAT, 0);
  assert.equal(o.update(PASS_MS - 1, { beatPeriodMs: BEAT }), true);
  assert.equal(o.update(PASS_MS, { beatPeriodMs: BEAT }), false, 'and then ends');
});

test('switching to the eye phase gives it a full pass of its own', () => {
  // The eight measures are a budget for ONE half. Shared, a sparse chart --
  // one kick per measure -- spends six of them on the six ear taps, leaving
  // two measures to collect six eye taps: the overlay closes mid-instruction
  // and the trim is persisted from a two-sample eye median.
  const o = new RecalibrationOverlay({});
  o.start(0, BEAT, 0);
  const lateInPass = PASS_MS - BEAT; // the ear half ran nearly to the wire
  assert.equal(o.update(lateInPass, { beatPeriodMs: BEAT }), true);

  o.setPhase('eye', lateInPass);
  assert.equal(o.phase, 'eye');
  // Without the re-base this would already be over.
  assert.equal(o.update(lateInPass + BEAT, { beatPeriodMs: BEAT }), true);
  assert.equal(
    o.update(lateInPass + PASS_MS - 1, { beatPeriodMs: BEAT }), true,
    'the eye half gets the same eight measures the ear half had',
  );
  assert.equal(o.update(lateInPass + PASS_MS, { beatPeriodMs: BEAT }), false);
});

test('a phase switch without a clock leaves the deadline alone', () => {
  // setPhase's nowMs is optional; callers that omit it keep the old budget
  // rather than silently getting an unbounded pass.
  const o = new RecalibrationOverlay({});
  o.start(0, BEAT, 0);
  o.setPhase('eye');
  assert.equal(o.startMs, 0);
  assert.equal(o.update(PASS_MS, { beatPeriodMs: BEAT }), false);
});

test('start() always opens on the ear phase', () => {
  const o = new RecalibrationOverlay({});
  o.setPhase('eye', 0);
  o.start(0, BEAT, 0);
  assert.equal(o.phase, 'ear', 'a fresh pass never opens mid-interaction');
});
