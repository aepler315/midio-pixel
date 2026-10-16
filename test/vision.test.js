import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVisionResponse } from '../src/vision/VisionLoop.js';
import { ParamBus } from '../src/core/ParamBus.js';

function payload(obj) {
  return { message: { content: JSON.stringify(obj) } };
}

const VALID = {
  observations: { eq_motion: 1, speed_match: 0, companion_weight: 2, clutter: 0, notes: 'ok' },
  adjust: { jumpHeight: 1.1, obstacleDensity: 1.0, scrollSpeed: 0.95, eqSensitivity: 1.0, onsetThreshold: 1.0 },
  confidence: 0.8,
};

test('parseVisionResponse accepts a well-formed payload', () => {
  const parsed = parseVisionResponse(payload(VALID));
  assert.ok(parsed);
  assert.equal(parsed.adjust.jumpHeight, 1.1);
  assert.equal(parsed.observations.companion_weight, 2);
});

test('parseVisionResponse strips markdown code fences', () => {
  const raw = { message: { content: '```json\n' + JSON.stringify(VALID) + '\n```' } };
  const parsed = parseVisionResponse(raw);
  assert.ok(parsed);
});

test('parseVisionResponse rejects payloads below the confidence floor', () => {
  const low = { ...VALID, confidence: 0.1 };
  assert.equal(parseVisionResponse(payload(low)), null);
});

test('parseVisionResponse rejects malformed JSON without throwing', () => {
  assert.equal(parseVisionResponse({ message: { content: 'not json at all {' } }), null);
  assert.equal(parseVisionResponse({}), null);
  assert.equal(parseVisionResponse(null), null);
});

test('parseVisionResponse clamps out-of-range adjust values into [0.5, 1.5]', () => {
  const wild = { ...VALID, adjust: { ...VALID.adjust, jumpHeight: 99, scrollSpeed: -5 } };
  const parsed = parseVisionResponse(payload(wild));
  assert.equal(parsed.adjust.jumpHeight, 1.5);
  assert.equal(parsed.adjust.scrollSpeed, 0.5);
});

test('parseVisionResponse rejects a payload missing a required adjust key', () => {
  const missing = { ...VALID, adjust: { jumpHeight: 1.1 } };
  assert.equal(parseVisionResponse(payload(missing)), null);
});

test('ParamBus: a regression reverts to the pre-apply snapshot on the next cycle', () => {
  const bus = new ParamBus();
  bus.trust = 1; // maximize authority so the effect is unambiguous in this test

  // Cycle 1: apply a jump-height bump, severity looked fine (2).
  bus.updateTrust(2);       // no prior severity -> no-op besides recording
  bus.snapshotForRevert();  // snapshot BEFORE this cycle's own change
  bus.propose({ jumpHeight: 1.2, obstacleDensity: 1, scrollSpeed: 1, eqSensitivity: 1, onsetThreshold: 1 }, 1);
  const afterCycle1 = bus.target.jumpHeight;
  assert.ok(afterCycle1 > 1);

  // Cycle 2: severity got worse (4 > 2) -> should revert to the pre-cycle-1 snapshot.
  bus.updateTrust(4);
  assert.equal(bus.target.jumpHeight, 1); // reverted back to baseline
  assert.ok(bus.trust < 1); // trust penalized
});

test('ParamBus: an improving severity score raises trust without reverting', () => {
  const bus = new ParamBus();
  bus.updateTrust(3);
  bus.snapshotForRevert();
  bus.propose({ jumpHeight: 1.1, obstacleDensity: 1, scrollSpeed: 1, eqSensitivity: 1, onsetThreshold: 1 }, 1);
  const trustBefore = bus.trust;
  bus.updateTrust(1); // improved (lower severity)
  assert.ok(bus.trust > trustBefore);
  assert.ok(bus.target.jumpHeight > 1); // NOT reverted
});
