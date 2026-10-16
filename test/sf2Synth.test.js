import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sf2Synth, combinePan } from '../src/audio/Sf2Synth.js';
import { Role } from '../src/core/NoteEvent.js';

// _findPreset only touches this.sf2.presets — no AudioContext needed, so it's
// unit-testable in Node directly (Sf2Synth's constructor never touches `ae`).
function synthWithPresets(entries) {
  const synth = new Sf2Synth({});
  synth.sf2 = { presets: new Map(entries) };
  return synth;
}

const presetKey = (bank, program) => bank * 128 + program;
const fakePreset = (bank, program) => ({ bank, program, zones: [] });

test('a real MIDI program on a bank-0 preset is preferred over the role default', () => {
  const synth = synthWithPresets([
    [presetKey(0, 40), fakePreset(0, 40)],   // Violin — the MIDI's real instrument
    [presetKey(0, 0), fakePreset(0, 0)],     // role default (Acoustic Grand Piano)
  ]);
  const preset = synth._findPreset(Role.MELODY, 40);
  assert.equal(preset.program, 40);
});

test('an unknown program (-1) falls back to the role default preset', () => {
  const synth = synthWithPresets([
    [presetKey(0, 0), fakePreset(0, 0)],
    [presetKey(0, 89), fakePreset(0, 89)],
  ]);
  const preset = synth._findPreset(Role.PAD, -1);
  assert.equal(preset.program, 89); // ROLE_PROGRAMS[PAD] = program 89
});

test('a real program the loaded font does not have falls back to the role default', () => {
  const synth = synthWithPresets([
    [presetKey(0, 33), fakePreset(0, 33)], // role default for BASS
  ]);
  const preset = synth._findPreset(Role.BASS, 200); // font has no program 200
  assert.equal(preset.program, 33);
});

test('RHYTHM always resolves in bank 128, honoring the specific drum-kit variant', () => {
  const synth = synthWithPresets([
    [presetKey(128, 0), fakePreset(128, 0)],   // Standard Kit
    [presetKey(128, 16), fakePreset(128, 16)], // Power Kit
    [presetKey(0, 40), fakePreset(0, 40)],     // decoy — must never be picked for RHYTHM
  ]);
  const power = synth._findPreset(Role.RHYTHM, 16);
  assert.equal(power.bank, 128);
  assert.equal(power.program, 16);
});

test('RHYTHM with no program info falls back to the standard kit (bank 128, program 0)', () => {
  const synth = synthWithPresets([
    [presetKey(128, 0), fakePreset(128, 0)],
  ]);
  const preset = synth._findPreset(Role.RHYTHM, -1);
  assert.equal(preset.bank, 128);
  assert.equal(preset.program, 0);
});

test('RHYTHM with an unavailable kit variant falls back to the standard kit', () => {
  const synth = synthWithPresets([
    [presetKey(128, 0), fakePreset(128, 0)],
  ]);
  const preset = synth._findPreset(Role.RHYTHM, 99); // font has no kit 99
  assert.equal(preset.bank, 128);
  assert.equal(preset.program, 0);
});

test('a font with nothing at all resolves to null rather than throwing', () => {
  const synth = synthWithPresets([]);
  assert.equal(synth._findPreset(Role.MELODY, 40), null);
  assert.equal(synth._findPreset(Role.RHYTHM, -1), null);
});

test('an unrecognized role falls back to the MELODY default', () => {
  const synth = synthWithPresets([
    [presetKey(0, 0), fakePreset(0, 0)],
  ]);
  const preset = synth._findPreset('NOT_A_ROLE', -1);
  assert.equal(preset.program, 0);
});

test('a drum-only font (bank 128 presets only) never lends a drum kit to a melodic role', () => {
  const synth = synthWithPresets([
    [presetKey(128, 0), fakePreset(128, 0)], // Standard Kit — the font's only content
  ]);
  // "Some soundfonts only play drums": a font with genuinely nothing melodic
  // has nothing honest to offer MELODY/BASS/PAD — staying silent (not
  // substituting a drum kit, which would sound like random percussion
  // instead of a melody) is the correct behavior, not a bug.
  assert.equal(synth._findPreset(Role.MELODY, -1), null);
  assert.equal(synth._findPreset(Role.BASS, -1), null);
  assert.equal(synth._findPreset(Role.PAD, -1), null);
  // RHYTHM still finds its kit normally.
  assert.equal(synth._findPreset(Role.RHYTHM, -1).bank, 128);
});

test('a font with melodic content but not at the role-default program is still used, not dropped', () => {
  const synth = synthWithPresets([
    [presetKey(0, 40), fakePreset(0, 40)], // Violin only — no program 0/33/89 anywhere
  ]);
  // This is the "some soundfonts only play drums" bug in disguise: a real
  // MIDI often carries no program info (program=-1) for a track, and the
  // old fallback chain gave up at bank-0/program-0 instead of using
  // whatever bank-0 content the font actually has.
  assert.equal(synth._findPreset(Role.MELODY, -1)?.program, 40);
  assert.equal(synth._findPreset(Role.BASS, -1)?.program, 40);
  assert.equal(synth._findPreset(Role.PAD, -1)?.program, 40);
});

test('RHYTHM falls back to melodic content when the font has no drum kit at all', () => {
  const synth = synthWithPresets([
    [presetKey(0, 0), fakePreset(0, 0)], // only a piano — some sound beats silence for a drum hit
  ]);
  const preset = synth._findPreset(Role.RHYTHM, -1);
  assert.equal(preset.program, 0);
});

test('a font with content only in a non-standard bank is still used as a last resort', () => {
  const synth = synthWithPresets([
    [5 * 128 + 12, { bank: 5, program: 12, zones: [] }], // unconventional bank numbering
  ]);
  assert.equal(synth._findPreset(Role.MELODY, -1)?.bank, 5);
  assert.equal(synth._findPreset(Role.RHYTHM, -1)?.bank, 5);
});

test('a melodic role never falls back into a drum-bank preset even as the last resort', () => {
  const synth = synthWithPresets([
    [presetKey(128, 0), fakePreset(128, 0)], // ONLY a drum kit exists
  ]);
  assert.equal(synth._findPreset(Role.MELODY, -1), null);
});

test('combinePan leaves the zone pan untouched when the track pan is centered', () => {
  assert.equal(combinePan(0, -1), -1);
  assert.equal(combinePan(0, 1), 1);
  assert.equal(combinePan(0, 0), 0);
});

test('combinePan lets a fully hard-panned track win outright, regardless of zone pan', () => {
  assert.equal(combinePan(1, -1), 1);
  assert.equal(combinePan(-1, 1), -1);
  assert.equal(combinePan(1, 1), 1);
  assert.equal(combinePan(-1, -1), -1);
});

test('combinePan proportionally compresses (never cancels) the zone spread for a partial track pan', () => {
  // At evtPan=0.5, the zone's spread only has half the field left to move
  // in: a hard-left zone shifts to (0.5 + -1*0.5) = 0, not all the way to
  // hard-left, but also not left stuck exactly where the additive+clamp
  // formula would have parked it.
  assert.equal(combinePan(0.5, -1), 0);
  assert.equal(combinePan(0.5, 1), 1);
});

test('combinePan is always bounded to [-1, 1] for any input in range', () => {
  for (let e = -1; e <= 1; e += 0.25) {
    for (let z = -1; z <= 1; z += 0.25) {
      const v = combinePan(e, z);
      assert.ok(v >= -1 && v <= 1, `combinePan(${e}, ${z}) = ${v} out of range`);
    }
  }
});
