// Casting: track names / GM programs / stem filenames -> character lanes
// (clean melody -> Midasus, bass -> Broshi, other leads -> Midio).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Lane, classifyInstrumentText, classifyGmProgram, laneForTrack,
  melodyLaneForNote, laneForStemName, delegateByStemActivity, laneCounts,
} from '../src/core/Casting.js';
import { Role, makeNoteEvent } from '../src/core/NoteEvent.js';
import { midiToTimeline } from '../src/core/MidiAdapter.js';
import { buildNamedEnsembleMidi } from './helpers/midiFixture.js';

test('instrument text classifies into sound families, clean beating lead on ties', () => {
  assert.equal(classifyInstrumentText('Grand Piano'), 'clean');
  assert.equal(classifyInstrumentText('Clean Electric Gtr'), 'clean');
  assert.equal(classifyInstrumentText('Acoustic Guitar'), 'clean');
  assert.equal(classifyInstrumentText('Rhodes'), 'clean');
  assert.equal(classifyInstrumentText('clean lead'), 'clean', 'a clean lead is a clean sound -- Midasus takes it');
  assert.equal(classifyInstrumentText('Bass'), 'bass');
  assert.equal(classifyInstrumentText('Sub Bass 808'), 'bass');
  assert.equal(classifyInstrumentText('Lead Saw'), 'lead');
  assert.equal(classifyInstrumentText('Alto Sax Solo'), 'lead');
  assert.equal(classifyInstrumentText('Distortion Guitar'), 'lead');
  assert.equal(classifyInstrumentText('Drum Kit'), 'kit');
  assert.equal(classifyInstrumentText('808 Kick'), 'kit', 'a kick is drums even with an 808 in the name');
  assert.equal(classifyInstrumentText('Warm Pad'), 'pad');
  assert.equal(classifyInstrumentText('Strings Ensemble'), 'pad');
  assert.equal(classifyInstrumentText(''), null);
  assert.equal(classifyInstrumentText('Track 3'), null);
});

test('GM programs classify when names say nothing', () => {
  assert.equal(classifyGmProgram(0), 'clean');   // acoustic grand
  assert.equal(classifyGmProgram(11), 'clean');  // vibraphone
  assert.equal(classifyGmProgram(27), 'clean');  // clean electric guitar
  assert.equal(classifyGmProgram(30), 'lead');   // distortion guitar
  assert.equal(classifyGmProgram(33), 'bass');   // electric bass (finger)
  assert.equal(classifyGmProgram(56), 'lead');   // trumpet
  assert.equal(classifyGmProgram(81), 'lead');   // saw lead
  assert.equal(classifyGmProgram(89), 'pad');    // warm pad
  assert.equal(classifyGmProgram(-1), null);
  assert.equal(classifyGmProgram(128), null);
});

test('laneForTrack: the casting rule end to end, with sane fallbacks', () => {
  assert.equal(laneForTrack({ name: 'Grand Piano', role: Role.MELODY }), Lane.MIDASUS);
  assert.equal(laneForTrack({ name: 'Lead Synth', role: Role.MELODY }), Lane.MIDIO);
  assert.equal(laneForTrack({ name: 'Bass', role: Role.BASS }), Lane.BROSHI);
  assert.equal(laneForTrack({ name: '', program: 81, role: Role.PAD }), Lane.MIDIO,
    'a demoted second melody (role PAD) with a lead program is still Midio\'s line');
  assert.equal(laneForTrack({ name: 'Drums', channel: 9, role: Role.RHYTHM }), null);
  assert.equal(laneForTrack({ name: 'Kick', role: Role.RHYTHM }), null);
  assert.equal(laneForTrack({ name: 'Warm Pad', role: Role.PAD }), null, 'true pads drive the world, not a character');
  assert.equal(laneForTrack({ name: '', program: -1, role: Role.MELODY }), Lane.MIDASUS,
    'an unnamed unknown melody defaults to Midasus so the sky-dancer never starves');
  assert.equal(laneForTrack({ name: '', program: -1, role: Role.BASS }), Lane.BROSHI);
});

test('melodyLaneForNote: centroid excess over the fundamental splits clean from lead', () => {
  // A C5 (~523 Hz) sits ~0.46 up the 50Hz..8kHz log axis. Brightness near
  // the fundamental = clean; far above = a harmonically rich lead.
  assert.equal(melodyLaneForNote(72, 0.48), Lane.MIDASUS);
  assert.equal(melodyLaneForNote(72, 0.75), Lane.MIDIO);
  assert.equal(melodyLaneForNote(72, null), Lane.MIDASUS, 'no brightness reading -> the safe clean default');
});

test('stem filenames cast lanes with extensions stripped', () => {
  assert.equal(laneForStemName('bass.wav'), Lane.BROSHI);
  assert.equal(laneForStemName('Piano Stem.flac'), Lane.MIDASUS);
  assert.equal(laneForStemName('lead-synth.mp3'), Lane.MIDIO);
  assert.equal(laneForStemName('drums.wav'), null);
  assert.equal(laneForStemName('pads.ogg'), null);
  assert.equal(laneForStemName('mystery.wav'), null);
});

test('delegateByStemActivity: the loudest lane-carrying stem at each moment owns the note', () => {
  const rate = 86;
  const n = rate * 4;
  const bassEnv = new Float32Array(n);
  const leadEnv = new Float32Array(n);
  // Bass stem plays for the first two seconds, lead stem for the last two.
  for (let f = 0; f < n / 2; f++) bassEnv[f] = 0.8;
  for (let f = n / 2; f < n; f++) leadEnv[f] = 0.6;
  const timeline = [
    makeNoteEvent({ tMs: 500, pitch: 36, vel: 0.7, role: Role.BASS, src: 'audio', lane: Lane.BROSHI }),
    makeNoteEvent({ tMs: 1000, pitch: 64, vel: 0.7, role: Role.MELODY, src: 'audio', lane: Lane.MIDASUS }),
    makeNoteEvent({ tMs: 3000, pitch: 76, vel: 0.7, role: Role.MELODY, src: 'audio', lane: Lane.MIDASUS }),
    makeNoteEvent({ tMs: 3200, pitch: 36, vel: 0.9, role: Role.RHYTHM, kick: true, src: 'audio' }),
  ];
  const reassigned = delegateByStemActivity(timeline, [
    { lane: Lane.BROSHI, env: bassEnv },
    { lane: Lane.MIDIO, env: leadEnv },
    { lane: null, env: new Float32Array(n).fill(1) }, // a drums stem: never votes
  ], rate);
  assert.equal(timeline[0].lane, Lane.BROSHI, 'bass note during the bass stem stays Broshi\'s');
  assert.equal(timeline[1].lane, Lane.BROSHI, 'melody note while ONLY the bass stem sounds follows the audio');
  assert.equal(timeline[2].lane, Lane.MIDIO, 'melody note during the lead stem becomes Midio\'s');
  assert.equal(timeline[3].lane, null, 'rhythm events are never delegated');
  assert.equal(reassigned, 2);
});

test('laneCounts tallies stamped lanes', () => {
  const counts = laneCounts([
    { lane: Lane.MIDASUS }, { lane: Lane.MIDASUS }, { lane: Lane.BROSHI }, { lane: null }, {},
  ]);
  assert.deepEqual(counts, { MIDASUS: 2, MIDIO: 0, BROSHI: 1 });
});

test('midiToTimeline stamps lanes from track names end to end (the casting fixture)', () => {
  const data = midiToTimeline(buildNamedEnsembleMidi());
  const byLane = laneCounts(data.timeline);
  assert.ok(byLane.MIDASUS > 0, 'Grand Piano notes carry the Midasus lane');
  assert.ok(byLane.MIDIO > 0, 'Lead Synth notes carry the Midio lane');
  assert.ok(byLane.BROSHI > 0, 'Bass notes carry the Broshi lane');
  for (const evt of data.timeline) {
    if (evt.role === Role.RHYTHM) assert.equal(evt.lane, null, 'drums never cast');
  }
  // The track summary mirrors the same verdicts for the UI badge.
  const named = Object.fromEntries(data.tracks.map((t) => [t.name, t.lane]));
  assert.equal(named['Grand Piano'], Lane.MIDASUS);
  assert.equal(named['Lead Synth'], Lane.MIDIO);
  assert.equal(named['Bass'], Lane.BROSHI);
  assert.equal(named['Drums'], null);
});
