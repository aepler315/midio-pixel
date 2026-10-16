import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import * as music from '../src/world/WorldMusic.js';

const sample = (args) => music.sampleWorldMusic(args);
const rhythm = { tMs: 1000, vel: 0.9, kick: false };

test('percussion lights peak on the detected onset, never before it, then decay', () => {
  assert.equal(typeof music.sampleWorldMusic, 'function');
  assert.equal(sample({ nowMs: 999, rhythm }).accent, 0);
  assert.equal(sample({ nowMs: 1000, rhythm }).accent, 0.9);
  assert.ok(sample({ nowMs: 1120, rhythm }).accent < 0.5);
  assert.equal(sample({ nowMs: 2000, rhythm }).accent, 0);
});

test('missing rhythm never manufactures a pulse, but the scene keeps ambient light', () => {
  for (const nowMs of [0, 500, 1000, 8000]) {
    const value = sample({ nowMs });
    assert.equal(value.accent, 0);
    assert.equal(value.bass, 0);
    assert.ok(value.cityLight > 0 && value.waterLight > 0);
    assert.ok(Object.values(value).every(Number.isFinite));
  }
});

test('underwater bass responds to sustained low bands, not a treble burst or a single kick', () => {
  const low = new EnergyCurves(4000, 50);
  const high = new EnergyCurves(4000, 50);
  const burst = new EnergyCurves(4000, 50);
  for (let i = 0; i < low.n; i++) {
    low.setFrame(i, [0.8, 0.8, 0, 0, 0, 0, 0]);
    high.setFrame(i, [0, 0, 0, 0, 0.8, 0.8, 0.8]);
    burst.setFrame(i, [i === 100 ? 0.8 : 0, i === 100 ? 0.8 : 0, 0, 0, 0, 0, 0]);
  }
  const sustained = sample({ nowMs: 2000, energyCurves: low });
  assert.ok(sustained.bass > 0.7);
  assert.equal(sample({ nowMs: 2000, energyCurves: high }).bass, 0);
  assert.ok(sample({ nowMs: 2000, energyCurves: burst }).bass < 0.25);
  assert.equal(sample({ nowMs: 2000, rhythm: { tMs: 2000, vel: 1, kick: true } }).bass, 0);
});

test('dense percussion changes local accents without speeding up the water current', () => {
  const a = sample({ nowMs: 4000, rhythm: { tMs: 4000, vel: 1 } });
  const b = sample({ nowMs: 4000, rhythm: { tMs: 3750, vel: 0.4 } });
  assert.equal(a.current, b.current);
  assert.equal(a.waterLight, b.waterLight);
  assert.ok(a.accent > b.accent);
});

test('rapid periodic bass cannot alias into a full-strength pressure flash', () => {
  const curves = new EnergyCurves(4000, 100);
  for (let i = 0; i < curves.n; i++) {
    const hit = i % 15 === 0 ? 1 : 0;
    curves.setFrame(i, [hit, hit, 0, 0, 0, 0, 0]);
  }
  const levels = Array.from({ length: 15 }, (_, i) => sample({ nowMs: 2400 + i * 10, energyCurves: curves }).bass);
  assert.ok(Math.max(...levels) < 0.15, 'pressure follows average bass, not aligned samples');
  assert.ok(Math.max(...levels) - Math.min(...levels) < 0.04, 'dense drums retain slow pressure');
});

test('only measured section boundaries produce a slow opening in the water light', () => {
  const section = { startMs: 4000, endMs: 12000, provenance: 'detected' };
  assert.equal(sample({ nowMs: 3999, section }).reveal, 0);
  assert.equal(sample({ nowMs: 4000, section }).reveal, 0);
  assert.ok(sample({ nowMs: 6000, section }).reveal > 0.8);
  assert.equal(sample({ nowMs: 10000, section }).reveal, 0);
  assert.equal(sample({ nowMs: 6000, section: { ...section, provenance: 'decorative' } }).reveal, 0);
});

test('reduced flashing suppresses moving currents and tempers local accents', () => {
  const full = sample({ nowMs: 1000, rhythm });
  const reduced = sample({ nowMs: 1000, rhythm, reducedFlash: true });
  assert.equal(reduced.current, 0);
  assert.ok(reduced.accent < full.accent / 2);
  assert.equal(reduced.waterLight, full.waterLight);
});

test('WP04 motion-only current suppression preserves independent musical light', () => {
  for (const reducedFlash of [false, true]) {
    const mgr = { tSec: 4, worldRhythm: { tMs: 4000, vel: 0.9 }, reducedFlash };
    const full = music.sampleManagerMusic(mgr);
    const reduced = music.sampleManagerMusic({ ...mgr, reducedMotion: true });
    assert.equal(reduced.current, 0);
    for (const field of ['bass', 'energy', 'accent', 'reveal', 'cityLight', 'waterLight']) {
      assert.equal(reduced[field], full[field], `${field} remains musical`);
    }
    if (!reducedFlash) assert.notEqual(full.current, 0);
  }
});

test('sampling the same passage is deterministic and does not consume events', () => {
  const args = { nowMs: 1100, rhythm };
  const before = sample(args);
  sample({ nowMs: 9000 });
  assert.deepEqual(sample(args), before);
  assert.deepEqual(rhythm, { tMs: 1000, vel: 0.9, kick: false });
});
