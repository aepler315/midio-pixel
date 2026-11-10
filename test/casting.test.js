// Casting: stem filenames and the melody's spectrum -> lanes
// (clean melody -> MIDASUS, bass -> BROSHI, other leads -> MIDIO).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Lane, classifyInstrumentText,
  melodyLaneForNote, laneForStemName, delegateByStemActivity, laneCounts,
} from '../src/core/Casting.js';
import { Role, makeNoteEvent } from '../src/core/NoteEvent.js';

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
