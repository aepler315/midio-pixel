import test from 'node:test';
import assert from 'node:assert/strict';
import { createSongprintSweep } from '../src/render/SongprintSweep.js';
import { renderFable, sliceColours } from '../src/render/SongprintFable.js';
import { SongBeatTransport } from '../src/sim/SongBeatTransport.js';

const descriptor = {
  version: 2, offsetSeconds: .5, slices: 3, sliceSeconds: 1, lastFraction: .5, keyAngle: 0,
  chroma: Float32Array.from({ length: 36 }, (_, i) => Math.sin(i * 1.3)),
  tone: [0, 1, -5, 2, -1, -2, 5, -3, 2],
};
const field = { slices: 3, stride: 4, rays: 4, field: Float32Array.from([
  0, .1, .4, .6, 0, .3, .5, .9, 0, .18, .21, .4, 0, .08, .3, .32,
]) };
const near = (actual, expected) => assert.ok(Math.abs(expected - actual) < 1e-6, actual + ' instead of ' + expected);

test('revisiting a scan protects it while the two delayed fold faces are sampled', () => {
  const sampleAt = createSongprintSweep(descriptor, field, {});
  for (const t of [1, 2, 3, 4]) sampleAt(t);
  const current = sampleAt(1);
  const before = structuredClone(current);
  sampleAt(.04);
  sampleAt(.66);
  assert.deepEqual(current, before);
});

test('ray crossings, colour, pith and partial tail follow the same print and seek clock', () => {
  const sampleAt = createSongprintSweep(descriptor, field, { durationMs: 5000 });
  const start = sampleAt(.1);
  assert.equal(start.activeRadius, 0);
  const halfway = sampleAt(1.5, { periodSec: 12 });
  near(halfway.phase, Math.PI / 4);
  near(halfway.rows[0].r1, .2);
  near(halfway.activeRadius, .2);
  near(halfway.activeIndex, 1);
  const tail = sampleAt(2.75);
  near(tail.activeIndex, 2.5);
  near(tail.activeRadius, (tail.rows[2].r0 + tail.rows[2].r1) / 2);
  const end = sampleAt(4);
  near(end.activeIndex, 3); near(end.activeRadius, end.outerRadius);
  const snapshot = structuredClone(sampleAt(.8));
  for (let t = 6; t < 12; t++) sampleAt(t);
  assert.deepEqual(sampleAt(.8), snapshot);
  const loop = structuredClone(sampleAt(.8, { periodSec: 12, withAudio: false }));
  const replay = sampleAt(12.8, { periodSec: 12, withAudio: false });
  near(replay.rows[0].r1, loop.rows[0].r1);
  near(replay.phase, loop.phase);
  assert.equal(replay.attack, 0); assert.equal(replay.rows[0].focus, 0);
  const old = createSongprintSweep({ ...descriptor, version: 1, offsetSeconds: undefined }, field, { conductor: { durationMs: 5000 } });
  near(old(2).activeIndex, 1);
});

test('the default sweep makes one clockwise turn over the entire heard track, including its silent margins', () => {
  const read = createSongprintSweep(descriptor, field, { conductor: {durationMs: 96500} });
  for (const withAudio of [true, false]) {
    for (const fraction of [0, .002, .125, .25, .50, .75, .999, 1, .25, 1.1]) {
      const scan = read(fraction * 96.5, {withAudio});
      near(scan.phase, Math.min(1, fraction) * 2 * Math.PI);
      const ray = Math.min(1, fraction) * field.rays;
      const j = Math.floor(ray) % field.rays, k = (j + 1) % field.rays, mix = ray - Math.floor(ray);
      near(scan.rows[0].r1, (1-mix) * field.field[j*field.stride+1] + mix * field.field[k*field.stride+1]);
    }
  }
  near(read(48.25, {periodSec: 'song'}).phase, Math.PI);
  // A loop with the same duration and a full-song pass have different end states.
  near(read(96.5, {periodSec: 96.5}).phase, 0);
  near(read(96.5).phase, 2 * Math.PI);
});

test('the original raster uses the same geometry and colour when provided by the sweep', () => {
  const original = renderFable(descriptor, 64, { rays: 8 });
  const reuse = renderFable(descriptor, 64, { growth: original, lab: sliceColours(descriptor) });
  assert.deepEqual(reuse.data, original.data);
  assert.equal(reuse.field, original.field);
  assert.equal(reuse.radius, original.radius);
});

test('attacks follow measured onsets, uncertainty and silence suppress the corresponding reactions', () => {
  const band = Float32Array.from({ length: 200 }, (_, i) => i >= 40 && i < 100 ? .25 : 0);
  const sim = { durationMs: 4000, energyCurves: { rmsBands: [band], rateHz: 50 },
    conductor: { timeline: [
      { tMs: 1200, src: 'audio', role: 'PAD', vel: .95, pitchProvenance: 'synthetic' },
      { tMs: 1600, src: 'audio', role: 'RHYTHM', vel: .95 },
      { tMs: 2400, src: 'audio', role: 'RHYTHM', vel: 1 },
    ], beatMetadata: { phaseConfidence: .8 } },
    songBeat: new SongBeatTransport({ confidence: .9, beatPeriodMs: 500,
      localTempo: [{ tMs: 1000, beatPeriodMs: 250, confidence: .85 }] }) };
  const sampleAt = createSongprintSweep(descriptor, field, sim);
  assert.ok(sampleAt(.80).attack > .9, 'broadband rise');
  assert.ok(sampleAt(1.20).attack < .01, 'a synthetic chord does not fire an accent');
  assert.ok(sampleAt(1.59).attack < .01, 'future hits stay in the future');
  const hit = sampleAt(1.60);
  assert.ok(hit.attack > .9);
  near(hit.beatPosition, 4.4);
  near(hit.beatConfidence, .8);
  assert.equal(sampleAt(2.4).attack, 0);
  assert.equal(sampleAt(2.4).audible, 0);
  sim.conductor.beatMetadata.phaseConfidence = .03;
  const uncertain = createSongprintSweep(descriptor, field, sim);
  assert.equal(uncertain(1.6).beatPosition, null);
  assert.equal(uncertain(1.6).beatConfidence, 0);
  const provisional = createSongprintSweep(descriptor, field, { ...sim, biomes: { analyzedThroughMs: 1000 } });
  assert.equal(provisional(1.6).energy, 0);
  assert.equal(provisional(1.6).attack, 0);
  sim.conductor.beatMetadata.localTempo = [
    { tMs: 1000, firstBeatMs: 1075, phaseConfidence: .7 },
    { tMs: 2000, firstBeatMs: 2020, phaseConfidence: .1 },
  ];
  const anchored = createSongprintSweep(descriptor, field, sim);
  near(anchored(1.075).beatPosition, 2);
  near(anchored(1.575).beatPosition, 4);
  assert.equal(anchored(2.2).beatPosition, null);
});

test('steady sound and unavailable evidence never manufacture attacks', () => {
  const noMethods = createSongprintSweep(descriptor, field, { energyCurves: {} });
  const missing = noMethods(1.3);
  assert.equal(missing.energy, 0);
  assert.equal(missing.attack, 0);
  assert.equal(missing.beatPosition, null);
  const drone = createSongprintSweep(descriptor, field, { energyCurves: {
    rmsBands: [new Float32Array(500).fill(.25)], rateHz: 50,
  }, songBeat: new SongBeatTransport({ beatPeriodMs: 500, confidence: 0, freeTime: true }) });
  assert.ok(drone(1.5).energy > .9);
  assert.ok(drone(1.5).attack < .0001);
  assert.equal(drone(1.5).beatPosition, null);
});

test('sustained ink pressure distinguishes a transient, a held phrase and its release on seek', () => {
  const band = Float32Array.from({length: 500}, (_, i) => i === 10 || (i >= 100 && i < 240) ? .25 : 0);
  const read = createSongprintSweep(descriptor, field, { durationMs: 10000, energyCurves: { rmsBands: [band], rateHz: 50 } });
  assert.equal(read(.18).sustained, 0, 'future samples cannot affect the ink');
  assert.ok(read(.20).attack > .9 && read(.20).sustained < .05);
  const crest = structuredClone(read(4.4));
  assert.ok(crest.sustained > .95 && crest.attack < .01);
  assert.ok(read(9.9).sustained < .03);
  assert.equal(read(4.4, {withAudio: false}).sustained, 0);
  assert.deepEqual(read(4.4), crest);
  const midi = createSongprintSweep(descriptor, field, {durationMs: 10000, energyCurves: {
    globalEnergy: ms => ms > 2000 && ms < 5000 ? .1 : 0, globalEnergyNorm: () => .9,
  }});
  assert.equal(midi(1).sustained, 0, 'song calibration cannot manufacture a pulse in silence');
  assert.ok(midi(4).sustained > .63 && midi(4).sustained < .68);
  assert.equal(midi(8).sustained, 0);
});
