import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleWetResponse, recentConductorHits, GroundResponse } from '../src/world/alpine/GroundResponse.js';

test('wet response ignores future and stale hits and caps simultaneous impulses', () => {
  const hits = [{ id: 'early', tMs: 900, x: 40, strength: 1 },
    { id: 'future', tMs: 1100, x: 40, strength: 1 }];
  assert.ok(sampleWetResponse({ nowMs: 1000, hits, x: 40 }) > 0);
  assert.equal(sampleWetResponse({ nowMs: 800, hits, x: 40 }), 0);
  assert.equal(sampleWetResponse({ nowMs: 4000, hits, x: 40 }), 0);
  assert.ok(sampleWetResponse({ nowMs: 1000, hits: Array(100).fill(hits[0]), x: 40 }) <= 1);
  assert.ok(sampleWetResponse({ nowMs: 1000, hits, x: 40, reducedFlash: true }) <= .35);
});

test('empty or dry receiver lists cause no paint and disposal drops references', () => {
  let paints = 0;
  const ctx = { save() {}, restore() {}, beginPath() {}, stroke() { paints++; },
    ellipse() {}, clip() {}, moveTo() {}, lineTo() {} };
  const response = new GroundResponse();
  response.draw(ctx, { receivers: { wetMasks: [], litEdges: [] }, lights: [], quality: 0 });
  assert.equal(paints, 0);
  response.dispose();
  assert.equal(response.disposed, true);
});

test('recent musical hits are reconstructed from time after backward seeks', () => {
  const timeline = [{ tMs: 100, kick: true, vel: .8 }, { tMs: 500, kick: false },
    { tMs: 950, kick: true, vel: 1 }, { tMs: 3000, kick: true, vel: 1 }];
  assert.deepEqual(recentConductorHits(timeline, 1000).map(h => h.tMs), [950, 100]);
  assert.deepEqual(recentConductorHits(timeline, 200).map(h => h.tMs), [100]);
  assert.deepEqual(recentConductorHits(timeline, 6000), []);
});

test('a wet receiver draws a local pulse from current conductor hits', () => {
  const strokes = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, stroke() { strokes.push(this.strokeStyle); },
    ellipse() {}, clip() {}, moveTo() {}, lineTo() {}, rect() {} };
  new GroundResponse().draw(ctx, { receivers: {
    wetMasks: [{ x: 40, y: 100, widthPx: 40, depthPx: 8 }],
    litEdges: [{ x: 40, y: 100, widthPx: 40, alpha: 1 }],
  }, nowMs: 1000, hits: [{ id: 'k', tMs: 900, strength: 1 }], quality: 0 });
  assert.ok(strokes.length >= 2, 'pool edge and clipped ripple should respond');
});
