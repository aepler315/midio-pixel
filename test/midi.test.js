import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TempoMap } from '../src/core/TempoMap.js';
import { midiToTimeline } from '../src/core/MidiAdapter.js';
import { Role } from '../src/core/NoteEvent.js';
import { vlq, buildTrackChunk, buildMultiTrackPannedMidi, buildType0MultiChannelMidi, strBytes } from './helpers/midiFixture.js';

function buildSimpleMidi() {
  const ppqn = 96;
  const track = [];
  // Track name meta "Lead"
  track.push([...vlq(0), 0xff, 0x03, 4, 0x4c, 0x65, 0x61, 0x64]);
  // Tempo 500000 us/qn (120 BPM)
  track.push([...vlq(0), 0xff, 0x51, 3, 0x07, 0xa1, 0x20]);
  // Time sig 4/4
  track.push([...vlq(0), 0xff, 0x58, 4, 4, 2, 24, 8]);
  // Note on ch0 pitch60 vel100 at tick 0
  track.push([...vlq(0), 0x90, 60, 100]);
  // Note off at tick 96 (one quarter note later)
  track.push([...vlq(96), 0x80, 60, 0]);
  // Second overlapping-pitch retrigger to test FIFO pairing
  track.push([...vlq(0), 0x90, 60, 90]);
  track.push([...vlq(48), 0x90, 60, 80]); // retrigger before first closes
  track.push([...vlq(24), 0x80, 60, 0]); // closes the first-opened (FIFO)
  track.push([...vlq(24), 0x80, 60, 0]); // closes the second
  // End of track
  track.push([...vlq(0), 0xff, 0x2f, 0]);

  const trackChunk = buildTrackChunk(track);
  const header = [
    0x4d, 0x54, 0x68, 0x64, // 'MThd'
    0, 0, 0, 6,
    0, 0, // format 0
    0, 1, // ntrks
    (ppqn >> 8) & 0xff, ppqn & 0xff,
  ];
  return new Uint8Array([...header, ...trackChunk]).buffer;
}

test('TempoMap converts ticks to ms at 120 BPM', () => {
  const map = new TempoMap([{ tick: 0, usPerQN: 500000 }], 96);
  assert.equal(map.toMs(96), 500); // one quarter note = 500ms at 120bpm
  assert.equal(map.toMs(192), 1000);
});

test('TempoMap handles a tempo ramp mid-song', () => {
  const map = new TempoMap([
    { tick: 0, usPerQN: 500000 },   // 120 BPM
    { tick: 192, usPerQN: 1000000 }, // drops to 60 BPM at tick 192 (t=1000ms)
  ], 96);
  assert.equal(map.toMs(192), 1000);
  assert.equal(map.toMs(192 + 96), 1000 + 1000); // one quarter note at 60bpm = 1000ms
});

test('midiToTimeline parses a minimal SMF and pairs FIFO notes', () => {
  const buf = buildSimpleMidi();
  const { timeline, durationMs, tracks } = midiToTimeline(buf);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].noteCount, 3);
  assert.equal(timeline.length, 3);
  assert.ok(durationMs > 0);
  // First note: tick0 -> ms0, dur 96 ticks = 500ms
  assert.equal(timeline[0].tMs, 0);
  assert.equal(Math.round(timeline[0].durMs), 500);
});

test('single melody track with runs/legato falls back to MELODY role', () => {
  const buf = buildSimpleMidi();
  const { timeline } = midiToTimeline(buf);
  // Named "Lead" should hit the MELODY keyword regex directly.
  assert.equal(timeline[0].role, Role.MELODY);
});

test('a MIDI with no pan/program-change info defaults to center pan and unknown program', () => {
  const buf = buildSimpleMidi();
  const { timeline, tracks } = midiToTimeline(buf);
  for (const e of timeline) {
    assert.equal(e.pan, 0);
    assert.equal(e.program, -1);
  }
  assert.equal(tracks[0].pan, 0);
  assert.equal(tracks[0].intertwined, false);
});

test('a single track multiplexing channels (SMF Type 0 style) splits into per-channel voices', () => {
  const buf = buildType0MultiChannelMidi();
  const { tracks, timeline } = midiToTimeline(buf);
  assert.equal(tracks.length, 2, `expected 2 voices, got ${tracks.map((t) => t.name).join(', ')}`);

  const melodic = tracks.find((t) => t.channel === 0);
  const drums = tracks.find((t) => t.channel === 9);
  assert.ok(melodic, 'channel 0 voice should exist');
  assert.ok(drums, 'channel 9 voice should exist');
  assert.equal(melodic.noteCount, 2);
  assert.equal(drums.noteCount, 1);
  // Channel 10 (0-indexed 9) is always RHYTHM regardless of statistics.
  assert.equal(drums.role, Role.RHYTHM);

  const kickEvt = timeline.find((e) => e.channel === 9);
  assert.ok(kickEvt);
  assert.equal(kickEvt.kick, true);
  const melodicEvt = timeline.find((e) => e.channel === 0);
  assert.equal(melodicEvt.program, 73);
});

test('two tracks hard-panned to opposite sides with overlapping notes are intertwined and pan-out over the song', () => {
  const buf = buildMultiTrackPannedMidi();
  const { timeline, tracks, pairs } = midiToTimeline(buf);
  assert.equal(tracks.length, 2);

  const left = tracks.find((t) => t.name === 'Left');
  const right = tracks.find((t) => t.name === 'Right');
  assert.ok(left && right, 'both named tracks should be present');
  assert.ok(left.pan < -0.9, `left should be hard-panned, got ${left.pan}`);
  assert.ok(right.pan > 0.9, `right should be hard-panned, got ${right.pan}`);
  assert.equal(left.intertwined, true);
  assert.equal(right.intertwined, true);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], { channelA: 0, channelB: 1 });

  const leftNotes = timeline.filter((e) => e.channel === 0);
  const rightNotes = timeline.filter((e) => e.channel === 1);
  assert.ok(leftNotes.length > 0 && rightNotes.length > 0);

  // The song-opening note should play centered; by the final note the pair
  // should have eased out toward its full authored hard-pan spread.
  assert.ok(Math.abs(leftNotes[0].pan) < 0.05, `first note should start centered, got ${leftNotes[0].pan}`);
  assert.ok(leftNotes[leftNotes.length - 1].pan < -0.5, `last note should widen left, got ${leftNotes.at(-1).pan}`);
  assert.ok(rightNotes[rightNotes.length - 1].pan > 0.5, `last note should widen right, got ${rightNotes.at(-1).pan}`);

  // Real GM program numbers from Program Change carry through onto notes.
  assert.equal(leftNotes[0].program, 40);
  assert.equal(rightNotes[0].program, 42);
});

// A track named "Conductor" used to be diverted into an authored cue sheet
// and hidden from the musical pipeline entirely (the Guitar-Pro authoring
// path, now removed). It's an ordinary track like any other today.
test('a track named "Conductor" plays like any other track, and no cue sheet is produced', () => {
  const ppqn = 96;
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, (ppqn >> 8) & 0xff, ppqn & 0xff];

  const lead = [];
  lead.push([...vlq(0), 0xff, 0x03, 4, ...strBytes('Lead')]);
  lead.push([...vlq(0), 0xff, 0x51, 3, 0x07, 0xa1, 0x20]); // 120 BPM
  lead.push([...vlq(0), 0x90, 60, 100]);
  lead.push([...vlq(96), 0x80, 60, 0]);
  lead.push([...vlq(0), 0xff, 0x2f, 0]);

  const named = [];
  named.push([...vlq(0), 0xff, 0x03, 9, ...strBytes('Conductor')]);
  named.push([...vlq(0), 0x99, 49, 127]); // Crash Cymbal 1, fff -- used to mean "section boundary"
  named.push([...vlq(24), 0x89, 49, 0]);
  named.push([...vlq(0), 0xff, 0x2f, 0]);

  const { timeline, tracks, conductor } = midiToTimeline(
    new Uint8Array([...header, ...buildTrackChunk(lead), ...buildTrackChunk(named)]).buffer,
  );

  assert.equal(conductor, null);
  assert.equal(tracks.length, 2);
  assert.ok(tracks.some((t) => t.name === 'Conductor'));
  assert.ok(timeline.some((e) => e.pitch === 49), 'the former cue pitch is just a playable note now');
});
