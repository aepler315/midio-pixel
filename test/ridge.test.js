import test from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { sampleWorldMusic } from '../src/world/WorldMusic.js';
import {
  boundaryLift01, ambientDance, ridgeWeight, phraseScale, kickGate, summitGesture, ridgeEnvelope,
} from '../src/world/alpine/Ridge.js';

const chorus = { meanEnergy: 0.82, relEnergy01: 0.95, startMs: 60000, endMs: 90000, provenance: 'detected' };
const verse = { meanEnergy: 0.48, relEnergy01: 0.5 };

test('quiet songs keep atmosphere, a groove breathes, dense material settles', () => {
  const quiet = ambientDance(0.05);
  const groove = ambientDance(0.40);
  const dense = ambientDance(0.95);
  assert.ok(quiet < 0.35, `atmosphere should stay slow, got ${quiet.toFixed(3)}`);
  assert.ok(groove > 0.75, `groove should be the peak, got ${groove.toFixed(3)}`);
  assert.ok(dense < groove, 'dense songs must not out-heave the groove');
  assert.ok(dense > quiet, 'settled dense motion is still more than a hush');
});

test('reduced flash halves the travel without inventing a different shape', () => {
  assert.ok(Math.abs(ambientDance(0.40, true) * 2 - ambientDance(0.40)) < 1e-9);
  assert.ok(ambientDance(0.95, true) < ambientDance(0.40, true));
});

test('weight follows sustained bass, not a single kick', () => {
  const low = new EnergyCurves(4000, 50);
  const burst = new EnergyCurves(4000, 50);
  const high = new EnergyCurves(4000, 50);
  for (let i = 0; i < low.n; i++) {
    low.setFrame(i, [0.8, 0.8, 0.4, 0, 0, 0, 0]);
    burst.setFrame(i, [i === 100 ? 1 : 0, i === 100 ? 1 : 0, 0, 0, 0, 0, 0]);
    high.setFrame(i, [0, 0, 0, 0, 0.8, 0.8, 0.8]);
  }
  const held = ridgeWeight(sampleWorldMusic({ nowMs: 2000, energyCurves: low }).bass);
  const tap = ridgeWeight(sampleWorldMusic({ nowMs: 2000, energyCurves: burst }).bass);
  const treble = ridgeWeight(sampleWorldMusic({ nowMs: 2000, energyCurves: high }).bass);
  assert.ok(held > tap * 2, `bass weight ${held.toFixed(3)} vs kick ${tap.toFixed(3)}`);
  assert.ok(treble < 0.15, `treble is not mass, got ${treble.toFixed(3)}`);
  assert.ok(tap < 0.25, `a single kick is not a new range, got ${tap.toFixed(3)}`);
});

test('an earned phrase lift scales the range; a decorative cut does not', () => {
  const lift = boundaryLift01(chorus, verse);
  const at = (provenance) => sampleWorldMusic({
    nowMs: 62000,
    section: { ...chorus, provenance },
  }).reveal;
  const idle = phraseScale({ reveal: 0, lift });
  const opened = phraseScale({ reveal: at('detected'), lift });
  const decorative = phraseScale({ reveal: at('decorative'), lift });
  assert.equal(idle, 1);
  assert.ok(opened > 1.12, `phrase ${opened.toFixed(3)} should raise the range`);
  assert.equal(decorative, 1);
  assert.ok(phraseScale({ reveal: at('detected'), lift, reducedFlash: true }) < opened);
});

test('sparse songs let an isolated accent sharpen a summit; dense songs filter it', () => {
  const hit = 0.45;
  const sparse = summitGesture(hit, 0.05);
  const dense = summitGesture(hit, 0.95);
  assert.ok(sparse > 0.3, `a lone hit on quiet ground should show, got ${sparse.toFixed(3)}`);
  assert.equal(dense, 0, 'the same hit in a dense mix is not a vibrating horizon');
  assert.ok(summitGesture(0.95, 0.95) > 0.5, 'a strong hit still marks a dense skyline');
  assert.equal(summitGesture(0, 0.05), 0);
});

test('dense material gates kick bounce so large motion is saved for phrases', () => {
  assert.ok(kickGate(0.05) > 0.9);
  assert.ok(kickGate(0.95) < 0.35);
  assert.ok(kickGate(0.95) < kickGate(0.4));
});

test('the envelope depends on where the song is, not how it got there', () => {
  const args = { energy: 0.4, bass: 0.5, accent: 0.8, reveal: 0.8, lift: 0.9 };
  const first = ridgeEnvelope(args);
  for (let i = 0; i < 20; i++) ridgeEnvelope({ energy: 1, bass: 1, accent: 1, reveal: 1, lift: 1 });
  assert.deepEqual(ridgeEnvelope(args), first);
  for (const v of Object.values(first)) {
    assert.ok(Number.isFinite(v) && v >= 0, `envelope value ${v}`);
  }
  assert.ok(first.scaleMul >= 1);
});
