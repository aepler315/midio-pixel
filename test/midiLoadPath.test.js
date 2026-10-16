// End-to-end pure-logic check on the timeline pipeline (regression for the
// PR #7 UTF-16 corruption that broke module parse of ParamBus/Renderer).
//
// Audio is the only upload input now. The retained MIDI adapter provides a
// cheap deterministic fixture for testing the timeline-to-biome machinery.
// The real upload and automatic world-start flow is covered in
// tools/smoke.mjs with a generated WAV and a browser file chooser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { midiToTimeline } from '../src/core/MidiAdapter.js';
import { synthesizeEnergyCurves } from '../src/core/EnergyCurvesSynth.js';
import { generateCustomBiomeFromMidi } from '../src/world/BiomeImporter.js';
import { buildMultiTrackPannedMidi } from './helpers/midiFixture.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('core modules corrupted by PR #7 parse cleanly (no null-byte garbage)', () => {
  for (const rel of [
    'src/core/ParamBus.js',
    'src/render/Renderer.js',
    'src/world/BiomeManager.js',
    'src/main.js',
  ]) {
    const buf = readFileSync(join(root, rel));
    assert.equal(buf.includes(0), false, `${rel} must not contain null bytes`);
    const text = buf.toString('utf8');
    // main.js is a bootstrap module (side-effect imports); others re-export.
    assert.ok(
      text.includes('export ') || text.includes('import '),
      `${rel} should be valid ES module source`,
    );
  }
});

test('retained MIDI adapter: parse → energy curves → custom biome', () => {
  const buf = buildMultiTrackPannedMidi();
  const data = midiToTimeline(buf);
  assert.ok(Array.isArray(data.timeline) && data.timeline.length > 0);
  assert.ok(data.durationMs > 0);
  assert.ok(Array.isArray(data.tracks) && data.tracks.length > 0);

  data.energyCurves = synthesizeEnergyCurves(data.timeline, data.durationMs);
  assert.ok(data.energyCurves);
  assert.equal(typeof data.energyCurves.sample, 'function');
  // Sample mid-song energy without throwing
  const e0 = data.energyCurves.sample(0, data.durationMs * 0.5);
  assert.ok(Number.isFinite(e0));

  data.customBiome = generateCustomBiomeFromMidi(data, 'upload.mid');
  assert.ok(data.customBiome.name.startsWith('CUSTOM:'));
  assert.ok(data.customBiome.derived.noteCount === data.timeline.length);
});

test('playing a decoded recording mutes the timeline synth (no keyboard/click layer)', () => {
  const text = readFileSync(join(root, 'src/main.js'), 'utf8');
  // A recording already contains its voices. The browser smoke also checks
  // this flag during real audio playback.
  assert.ok(
    /if \(playBuffer[^)]*\) muteTimelineSynth = true/.test(text),
    'startTimeline must mute the synth whenever a recording is about to play',
  );
  const confirm = text.slice(text.indexOf('function confirmWorld'), text.indexOf('function startTimeline'));
  assert.ok(
    confirm.includes('muteTimelineSynth = true'),
    'confirming a world on a recording must mute the synth before start',
  );
});
