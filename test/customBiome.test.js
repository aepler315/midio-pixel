// Custom biome from MIDI + ParamBus history (MIDI restore + feature).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { midiToTimeline } from '../src/core/MidiAdapter.js';
import { generateCustomBiomeFromMidi, rememberCustomBiome } from '../src/world/BiomeImporter.js';
import { ParamBus } from '../src/core/ParamBus.js';
import { BIOMES } from '../src/world/BiomeProfiles.js';
import { buildMultiTrackPannedMidi, buildType0MultiChannelMidi } from './helpers/midiFixture.js';

function minimalMidiBuf() {
  // Reuse the multi-track fixture — real notes, roles, pans.
  // Fixture already returns an ArrayBuffer (not a Uint8Array).
  return buildMultiTrackPannedMidi();
}

test('generateCustomBiomeFromMidi returns a BiomeProfiles-shaped object', () => {
  const data = midiToTimeline(minimalMidiBuf());
  const biome = generateCustomBiomeFromMidi(data, 'demo-song.mid');
  assert.ok(biome.name.startsWith('CUSTOM:'));
  assert.ok(biome.id.startsWith('custom-'));
  assert.equal(biome.sky.length, 3);
  assert.match(biome.sky[0], /^#[0-9a-f]{6}$/i);
  assert.match(biome.silhouette, /^#[0-9a-f]{6}$/i);
  assert.ok(biome.celestial && biome.celestial.color);
  assert.ok(biome.particles && biome.particles.kind && biome.particles.count > 0);
  assert.ok(typeof biome.fx === 'string' && biome.fx.length > 0);
  assert.equal(biome.sourceFile, 'demo-song.mid');
  assert.ok(biome.derived.noteCount > 0);
});

test('same MIDI content yields the same custom biome id/name (deterministic)', () => {
  const a = generateCustomBiomeFromMidi(midiToTimeline(minimalMidiBuf()), 'x.mid');
  const b = generateCustomBiomeFromMidi(midiToTimeline(minimalMidiBuf()), 'x.mid');
  assert.equal(a.id, b.id);
  assert.equal(a.name, b.name);
  assert.deepEqual(a.sky, b.sky);
});

test('Type-0 multi-channel MIDI still produces a custom biome (drag path input)', () => {
  const data = midiToTimeline(buildType0MultiChannelMidi());
  assert.ok(data.timeline.length > 0, 'timeline must be non-empty for loadMidiFile');
  const biome = generateCustomBiomeFromMidi(data, 'type0.mid');
  assert.ok(biome.derived.noteCount === data.timeline.length);
  // Name is unique vs stock biomes so BiomeManager can register it safely.
  assert.ok(!BIOMES.some((b) => b.name === biome.name));
});

test('rememberCustomBiome prepends and dedupes by id on ParamBus', () => {
  const bus = new ParamBus();
  assert.deepEqual(bus.customBiomes, []);
  assert.equal(bus.rendererMode, 'canvas');

  const data = midiToTimeline(minimalMidiBuf());
  const biome = generateCustomBiomeFromMidi(data, 'a.mid');
  rememberCustomBiome(bus, biome);
  assert.equal(bus.customBiomes.length, 1);
  rememberCustomBiome(bus, biome); // same id — no duplicate
  assert.equal(bus.customBiomes.length, 1);
  rememberCustomBiome(bus, { ...biome, id: 'custom-other', name: 'CUSTOM:OTHER' });
  assert.equal(bus.customBiomes.length, 2);
  assert.equal(bus.customBiomes[0].id, 'custom-other');
});

// --- Analysis-driven fingerprint (the audio path's chroma/texture features) ---

function syntheticTimelineData(overrides = {}) {
  const timeline = [];
  for (let i = 0; i < 60; i++) {
    timeline.push({
      tMs: i * 250, durMs: 200, pitch: 60 + (i % 12), vel: 0.6, pan: 0,
      role: i % 4 === 0 ? 'RHYTHM' : 'MELODY', kick: i % 4 === 0, src: 'audio', channel: 0,
    });
  }
  return { timeline, durationMs: 15000, bpm: 120, ...overrides };
}

test('an analysis fingerprint tilts the palette: major vs minor produce different skies, deterministically', () => {
  const majorA = generateCustomBiomeFromMidi(syntheticTimelineData({ analysis: { tonic: 0, majorness: 0.9, brightness: 0.5, dynamicRange: 0.3, stereoWidth: 0.2 } }), 'song.mp3');
  const majorB = generateCustomBiomeFromMidi(syntheticTimelineData({ analysis: { tonic: 0, majorness: 0.9, brightness: 0.5, dynamicRange: 0.3, stereoWidth: 0.2 } }), 'song.mp3');
  const minor = generateCustomBiomeFromMidi(syntheticTimelineData({ analysis: { tonic: 0, majorness: -0.9, brightness: 0.5, dynamicRange: 0.3, stereoWidth: 0.2 } }), 'song.mp3');

  assert.deepEqual(majorA.sky, majorB.sky, 'same analysis must reproduce the same palette');
  assert.notDeepEqual(majorA.sky, minor.sky, 'major vs minor must read as different worlds');
  assert.equal(majorA.derived.majorness, 0.9);
  assert.equal(minor.derived.majorness, -0.9);
  // Same timeline -> same id either way (identity comes from the notes, mood tilts only the look).
  assert.equal(majorA.id, minor.id);
});

test('audio texture features move their palette knobs: dynamics earn the ridge line, width airs out particles', () => {
  const flat = generateCustomBiomeFromMidi(syntheticTimelineData({ analysis: { dynamicRange: 0.1, stereoWidth: 0 } }), 'flat.wav');
  const dynamic = generateCustomBiomeFromMidi(syntheticTimelineData({ analysis: { dynamicRange: 0.95, stereoWidth: 1 } }), 'dyn.wav');
  assert.ok(dynamic.particles.count > flat.particles.count, 'wide mixes should air out the particle field');
  assert.ok(dynamic.particles.speed > flat.particles.speed, 'dynamic songs should move faster particles');
});

test('audio file extensions are stripped from the fingerprint name like MIDI extensions are', () => {
  const b = generateCustomBiomeFromMidi(syntheticTimelineData(), 'my-song.mp3');
  assert.ok(b.name.startsWith('CUSTOM:MY-SONG'), b.name);
  assert.ok(!b.name.includes('MP3'), b.name);
});

test('without an analysis, MIDI derives the same knobs from its own notes (majorness from thirds)', () => {
  // A minor-heavy timeline: tonic class 0 with lots of minor thirds (class 3).
  const timeline = [];
  for (let i = 0; i < 40; i++) {
    timeline.push({ tMs: i * 200, durMs: 150, pitch: i % 2 === 0 ? 60 : 63, vel: 0.6, pan: 0, role: 'MELODY', kick: false, src: 'midi', channel: 0 });
  }
  const b = generateCustomBiomeFromMidi({ timeline, durationMs: 8000, bpm: 120 }, 'sad.mid');
  assert.ok(b.derived.majorness < 0, `expected a minor read, got ${b.derived.majorness}`);
  assert.ok(Number.isFinite(b.derived.brightness));
  assert.ok(Number.isFinite(b.derived.dynamicRange));
});

test('ParamBus KEYS smoothing still works after customBiomes fields (no regression)', () => {
  const bus = new ParamBus();
  bus.propose({ jumpHeight: 1.2 }, 1);
  bus.step();
  assert.ok(bus.live.jumpHeight > 1);
  bus.reset();
  assert.equal(bus.live.jumpHeight, 1);
  // customBiomes is session history — reset does not clear it (by design).
  bus.customBiomes = [{ id: 'x' }];
  bus.reset();
  assert.equal(bus.customBiomes.length, 1);
});

test('every biome has a unique fx and a distinct terrainEnergy -- no two read visually identical', () => {
  const fxNames = BIOMES.map((b) => b.fx);
  assert.equal(new Set(fxNames).size, BIOMES.length, 'every biome must have its own fx treatment');
  for (const b of BIOMES) {
    assert.ok(Number.isFinite(b.terrainEnergy), `${b.name} must define terrainEnergy`);
    assert.ok(b.terrainEnergy > 0, `${b.name}.terrainEnergy must be positive`);
  }
  const energies = BIOMES.map((b) => b.terrainEnergy);
  assert.ok(Math.max(...energies) - Math.min(...energies) > 0.3, 'terrain energy must spread meaningfully across biomes, not cluster near 1');
});
