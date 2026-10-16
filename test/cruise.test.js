import test from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { sampleWorldMusic } from '../src/world/WorldMusic.js';
import {
  boundaryLift01, cruiseRate, cruiseTravel, phrasePassage, signageAlpha,
} from '../src/world/redline/Cruise.js';

const chorus = { meanEnergy: 0.82, relEnergy01: 0.95, startMs: 60000, endMs: 90000, provenance: 'detected' };
const verse = { meanEnergy: 0.48, relEnergy01: 0.5, startMs: 30000, endMs: 60000, provenance: 'detected' };

test('quiet songs crawl, mid energy cruises, dense material drops to half-time', () => {
  const quiet = cruiseRate(0.05);
  const groove = cruiseRate(0.42);
  const dense = cruiseRate(0.95);
  assert.ok(quiet < 0.4, `crawl should be slow, got ${quiet.toFixed(3)}`);
  assert.ok(groove > 0.9, `groove should be the peak, got ${groove.toFixed(3)}`);
  assert.ok(dense < groove, 'dense songs must not outrun the cruise');
  assert.ok(dense > quiet, 'half-time is still faster than a crawl');
});

test('reduced flash halves the grid without inventing a different shape', () => {
  assert.ok(Math.abs(cruiseRate(0.42, true) * 2 - cruiseRate(0.42)) < 1e-9);
  assert.ok(cruiseRate(0.95, true) < cruiseRate(0.42, true));
});

test('travel is a function of the clock, so a backward seek cannot keep speed', () => {
  const curves = { globalEnergyNorm: () => 0.5 };
  const at = cruiseTravel(12, curves);
  cruiseTravel(90, curves);
  assert.equal(cruiseTravel(12, curves), at);
  assert.equal(cruiseTravel(-1, curves), 0);
  assert.equal(cruiseTravel(NaN, curves), 0);
});

test('lane travel changes its local derivative when sustained energy changes', () => {
  const curves = new EnergyCurves(6000, 50);
  for (let i = 0; i < curves.n; i++) {
    const energy = i < 100 ? 0.05 : 0.42; // step at two seconds
    curves.setFrame(i, [energy, energy, energy, energy, energy, energy, energy]);
  }
  const dt = 0.02;
  const before = cruiseTravel(1.8 + dt, curves) - cruiseTravel(1.8, curves);
  const after = cruiseTravel(3.8 + dt, curves) - cruiseTravel(3.8, curves);
  assert.ok(Math.abs(after - before) > 0.01,
    `a sustained energy change must alter road velocity (${before.toFixed(3)} -> ${after.toFixed(3)})`);
});

test('only an earned step-up opens a tunnel-then-horizon passage', () => {
  const lift = boundaryLift01(chorus, verse);
  const mid = phrasePassage({ nowMs: 62000, section: chorus, lift });
  const early = phrasePassage({ nowMs: 60500, section: chorus, lift });
  const late = phrasePassage({ nowMs: 63500, section: chorus, lift });
  assert.ok(lift > 0.9);
  assert.ok(early.tunnel > early.horizon, 'the mouth closes first');
  assert.ok(late.horizon > late.tunnel, 'the horizon opens after');
  assert.ok(mid.tunnel > 0 && mid.horizon > 0);
  const decorative = phrasePassage({
    nowMs: 62000,
    section: { ...chorus, provenance: 'decorative' },
    lift,
  });
  assert.deepEqual(decorative, { tunnel: 0, horizon: 0 });
  assert.deepEqual(phrasePassage({ nowMs: 62000, section: chorus, lift: 0 }), { tunnel: 0, horizon: 0 });
});

test('a continuation or a drop into a quieter section is not a horizon event', () => {
  assert.equal(boundaryLift01(verse, chorus), 0);
  assert.equal(boundaryLift01(verse, { meanEnergy: 0.46, relEnergy01: 0.5 }), 0);
});

test('one gantry catches the accent; the rest stay at the energy baseline', () => {
  const hit = signageAlpha(0.4, 0.9, true);
  const miss = signageAlpha(0.4, 0.9, false);
  const idle = signageAlpha(0.4, 0, false);
  assert.ok(hit > miss + 0.3, `accented gantry ${hit.toFixed(3)} vs neighbour ${miss.toFixed(3)}`);
  assert.ok(miss - idle < 0.08, 'neighbours must not relight with the hit');
  assert.ok(signageAlpha(0.8, 0, false) > signageAlpha(0.1, 0, false), 'energy still wakes the strip');
});

test('rapid drums change local signage without speeding the cruise', () => {
  const curves = new EnergyCurves(4000, 100);
  for (let i = 0; i < curves.n; i++) {
    const hit = i % 15 === 0 ? 1 : 0;
    curves.setFrame(i, [hit, hit, 0.4, 0.4, 0.3, 0, 0]);
  }
  const a = sampleWorldMusic({ nowMs: 2400, energyCurves: curves, rhythm: { tMs: 2400, vel: 1 } });
  const b = sampleWorldMusic({ nowMs: 2400, energyCurves: curves, rhythm: { tMs: 2000, vel: 0.3 } });
  assert.equal(cruiseRate(a.energy), cruiseRate(b.energy));
  assert.ok(a.accent > b.accent);
});

test('every output stays in range for junk input', () => {
  for (const energy of [0, 0.5, 1, -1, 4, NaN]) {
    const r = cruiseRate(energy);
    assert.ok(r >= 0 && r <= 1, `rate ${r}`);
    const a = signageAlpha(energy, 2, true);
    assert.ok(a >= 0 && a <= 1, `signage ${a}`);
  }
  const p = phrasePassage({ nowMs: 1, section: null, lift: 9 });
  assert.equal(p.tunnel, 0);
  assert.equal(p.horizon, 0);
});
