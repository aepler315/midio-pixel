import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimpleSynth } from '../src/audio/SimpleSynth.js';
import { Role } from '../src/core/NoteEvent.js';

function fakeAudioEngine() {
  const calls = { oscillators: 0, gains: 0, filters: 0, panners: 0 };
  const gainParam = () => ({
    value: 0,
    setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
  });
  const ctx = {
    currentTime: 0,
    createOscillator: () => {
      calls.oscillators++;
      return {
        type: '',
        frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        detune: { value: 0 },
        connect(dest) { return dest; }, start() {}, stop() {},
      };
    },
    createGain: () => {
      calls.gains++;
      return { gain: gainParam(), connect(dest) { return dest; } };
    },
    createBiquadFilter: () => {
      calls.filters++;
      return {
        type: '', frequency: { value: 0 }, Q: { value: 0 }, connect(dest) { return dest; },
      };
    },
    createStereoPanner: () => {
      calls.panners++;
      return { pan: { value: 0 }, connect(dest) { return dest; } };
    },
    createBuffer: (ch, len, sr) => ({ getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => ({ buffer: null, connect: () => ({ connect() {} }), start() {} }),
  };
  return { ae: { ctx, master: {} }, calls };
}

function note(o) {
  return {
    tMs: 0, durMs: 200, pitch: 60, vel: 0.6, role: Role.MELODY, kick: false,
    src: 'midi', channel: 0, pan: 0, program: -1, lane: null, ...o,
  };
}

test('with no patches set, noteOn plays the original plain tone (single oscillator, no filter/unison)', () => {
  const { ae, calls } = fakeAudioEngine();
  const synth = new SimpleSynth(ae);
  synth.noteOn(note({}));
  assert.equal(calls.oscillators, 1);
  assert.equal(calls.filters, 0);
  assert.equal(calls.gains, 2, 'authored envelope plus independent teardown release');
});

test('setPatches(null/empty) is a no-op: still plays the plain tone', () => {
  const { ae, calls } = fakeAudioEngine();
  const synth = new SimpleSynth(ae);
  synth.setPatches(null);
  synth.setPatches({});
  synth.noteOn(note({}));
  assert.equal(calls.oscillators, 1);
  assert.equal(calls.filters, 0);
});

test('a channel with a designed patch is voiced through the patched path: filter + primary oscillator', () => {
  const { ae, calls } = fakeAudioEngine();
  const synth = new SimpleSynth(ae);
  synth.setPatches({
    0: {
      type: 'sawtooth', attack: 0.02, release: 0.3, cutoffHz: 3000, resonanceQ: 1,
      unisonGain: 0, unisonDetuneCents: 0, vibratoDepthCents: 0, vibratoRateHz: 5, peakGain: 0.15,
    },
  });
  synth.noteOn(note({ channel: 0 }));
  assert.equal(calls.filters, 1, 'patched voicing should route through a lowpass filter');
  assert.equal(calls.oscillators, 1, 'no unison/vibrato configured -> exactly one oscillator');
});

test('a chordal patch (unisonGain > 0) adds a second detuned oscillator; vibrato adds an LFO oscillator', () => {
  const { ae, calls } = fakeAudioEngine();
  const synth = new SimpleSynth(ae);
  synth.setPatches({
    0: {
      type: 'triangle', attack: 0.05, release: 0.6, cutoffHz: 2000, resonanceQ: 1,
      unisonGain: 0.3, unisonDetuneCents: 8, vibratoDepthCents: 10, vibratoRateHz: 5.5, peakGain: 0.1,
    },
  });
  synth.noteOn(note({ channel: 0, durMs: 500 }));
  // primary + unison + vibrato LFO = 3 oscillators.
  assert.equal(calls.oscillators, 3);
  assert.equal(calls.filters, 1);
});

test('a note on a channel with no patch entry still falls back to the plain tone even when other channels have patches', () => {
  const { ae, calls } = fakeAudioEngine();
  const synth = new SimpleSynth(ae);
  synth.setPatches({
    0: {
      type: 'sawtooth', attack: 0.02, release: 0.3, cutoffHz: 3000, resonanceQ: 1,
      unisonGain: 0, unisonDetuneCents: 0, vibratoDepthCents: 0, vibratoRateHz: 5, peakGain: 0.15,
    },
  });
  synth.noteOn(note({ channel: 1 }));
  assert.equal(calls.filters, 0, 'channel 1 has no patch, so no filter should be involved');
  assert.equal(calls.oscillators, 1);
});

test('RHYTHM notes always use the dedicated drum voices, ignoring any patch on that channel', () => {
  const { ae, calls } = fakeAudioEngine();
  const synth = new SimpleSynth(ae);
  synth.setPatches({
    9: {
      type: 'sawtooth', attack: 0.02, release: 0.3, cutoffHz: 3000, resonanceQ: 1,
      unisonGain: 0, unisonDetuneCents: 0, vibratoDepthCents: 0, vibratoRateHz: 5, peakGain: 0.15,
    },
  });
  synth.noteOn(note({ channel: 9, role: Role.RHYTHM, pitch: 36 }));
  assert.equal(calls.filters, 0, 'the kick voice never touches the filter/patch path');
  assert.equal(calls.oscillators, 1);
});
