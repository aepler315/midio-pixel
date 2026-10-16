// ConductorTrack.js: the surviving half of the cue schema after the MIDI-
// authoring path (a Guitar-Pro-exported "Conductor" percussion track) was
// removed. splitCues/applyConductorSchedule remain because the built-in
// demo song (DemoSong.js) still builds its own cue sheet directly and uses
// them the same way BiomeManager does at load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CueKind, splitCues, applyConductorSchedule } from '../src/core/ConductorTrack.js';

const cue = (tMs, kind, value, extra = {}) => ({ tMs, kind, value, bucket: 8, durMs: 80, pitch: 0, ...extra });

test('splitCues separates the build-time half from the live half', () => {
  const { schedule, live } = splitCues([
    cue(0, CueKind.SECTION, 'cut'),
    cue(0, CueKind.BIOME, 'TWILIGHT'),
    cue(1000, CueKind.APOTHEOSIS, 1),
    cue(2000, CueKind.FEVER, 1),
  ]);
  assert.deepEqual(schedule.map((c) => c.kind), [CueKind.SECTION, CueKind.BIOME]);
  assert.deepEqual(live.map((c) => c.kind), [CueKind.APOTHEOSIS, CueKind.FEVER]);
});

// --- Folding the schedule onto the section plan ---------------------------

const barGrid = Array.from({ length: 21 }, (_, i) => ({ ms: i * 1000 }));
const basePlan = [
  { startMs: 0, endMs: 10000, transition: 'fade', profile: 'TWILIGHT', label: 'A' },
  { startMs: 10000, endMs: 20000, transition: 'fade', profile: 'JADE', label: 'B' },
];

test('absent cues is a true no-op -- the same array reference comes back', () => {
  assert.strictEqual(applyConductorSchedule(basePlan, [], barGrid, 20000), basePlan);
  assert.strictEqual(applyConductorSchedule(basePlan, null, barGrid, 20000), basePlan);
});

test('a section cue cuts a boundary at its own beat and sets the transition style', () => {
  const out = applyConductorSchedule(basePlan, [cue(5000, CueKind.SECTION, 'shutter')], barGrid, 20000);
  const boundary = out.find((s) => s.startMs === 5000);
  assert.ok(boundary, 'expected a section starting at the cued beat');
  assert.equal(boundary.transition, 'shutter');
  assert.ok(boundary.cued);
});

test('a cued boundary snaps to the bar grid', () => {
  const out = applyConductorSchedule(basePlan, [cue(5120, CueKind.SECTION, 'shutter')], barGrid, 20000);
  assert.ok(out.some((s) => s.startMs === 5000), 'boundary should snap to the nearest bar');
});

test('the plan never mutates -- the detected schedule is left intact', () => {
  const snapshot = JSON.parse(JSON.stringify(basePlan));
  applyConductorSchedule(basePlan, [cue(5000, CueKind.SECTION, 'cut'), cue(0, CueKind.BIOME, 'EMBER')], barGrid, 20000);
  assert.deepEqual(basePlan, snapshot);
});

test('a new cued section inherits the detected read of that moment', () => {
  const out = applyConductorSchedule(basePlan, [cue(15000, CueKind.SECTION, 'cut')], barGrid, 20000);
  const sec = out.find((s) => s.startMs === 15000);
  // 15000 sat inside the detected 'B'/JADE section, so the cued split keeps
  // everything the analysis already knew there rather than resetting it.
  assert.equal(sec.label, 'B');
  assert.equal(sec.profile, 'JADE');
});

test('a biome cue overrides the profile of the section containing it', () => {
  const out = applyConductorSchedule(basePlan, [cue(12000, CueKind.BIOME, 'MIRROR')], barGrid, 20000);
  const sec = out.find((s) => s.startMs <= 12000 && s.endMs > 12000);
  assert.equal(sec.profile, 'MIRROR');
  assert.ok(sec.cuedBiome);
});

test('boundaries too close together collapse instead of making unreadable slivers', () => {
  // Three cues inside 200ms -- an authoring slip, not three sections.
  const cues = [cue(5000, CueKind.SECTION, 'cut'), cue(5050, CueKind.SECTION, 'cut'), cue(5100, CueKind.SECTION, 'cut')];
  const out = applyConductorSchedule(basePlan, cues, barGrid, 20000);
  for (const s of out) {
    assert.ok(s.endMs - s.startMs >= 500, `section ${s.startMs}-${s.endMs} is a sliver`);
  }
});

test('an opening section cue never shutters into frame from nothing', () => {
  const out = applyConductorSchedule(basePlan, [cue(0, CueKind.SECTION, 'shutter')], barGrid, 20000);
  assert.notEqual(out[0].transition, 'shutter');
});

test('sections stay contiguous and cover the whole song after a fold', () => {
  const cues = [cue(4000, CueKind.SECTION, 'cut'), cue(12000, CueKind.SECTION, 'cut')];
  const out = applyConductorSchedule(basePlan, cues, barGrid, 20000);
  assert.equal(out[0].startMs, 0);
  assert.equal(out[out.length - 1].endMs, 20000);
  for (let i = 1; i < out.length; i++) assert.equal(out[i].startMs, out[i - 1].endMs);
});
