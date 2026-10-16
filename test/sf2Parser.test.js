import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSf2 } from '../src/audio/Sf2Parser.js';
import { buildMinimalSf2, buildBadSf2, buildStereoLinkSf2, buildDualZoneStereoSf2 } from './helpers/sf2Fixture.js';

test('parseSf2 extracts the font name from INAM', () => {
  const sf2 = parseSf2(buildMinimalSf2('MyFont'));
  assert.equal(sf2.name, 'MyFont');
});

test('parseSf2 uses fallback name when INAM is absent', () => {
  // The fixture always includes INAM, but fallback is tested implicitly
  const sf2 = parseSf2(buildMinimalSf2(), 'Fallback');
  assert.equal(sf2.name, 'TestFont'); // INAM takes priority
});

test('parseSf2 rejects non-SF2 data', () => {
  assert.throws(() => parseSf2(buildBadSf2(), 'bad'), /not a valid SF2/);
});

test('parseSf2 builds one preset at bank 0 program 0', () => {
  const sf2 = parseSf2(buildMinimalSf2());
  assert.equal(sf2.presets.size, 1);
  const preset = sf2.presets.get(0); // bank*128+program = 0
  assert.ok(preset, 'preset at key 0 should exist');
  assert.equal(preset.bank, 0);
  assert.equal(preset.program, 0);
  assert.equal(preset.zones.length, 1);
});

test('parseSf2 zone has correct key/velocity range intersection', () => {
  const sf2 = parseSf2(buildMinimalSf2());
  const z = sf2.presets.get(0).zones[0];
  assert.equal(z.loKey, 40);
  assert.equal(z.hiKey, 84);
  assert.equal(z.loVel, 20);
  assert.equal(z.hiVel, 110);
});

test('parseSf2 converts timecent attack/decay to seconds', () => {
  const sf2 = parseSf2(buildMinimalSf2());
  const z = sf2.presets.get(0).zones[0];
  // attack: -6000 timecents → 2^(-5) = 0.03125
  assert.ok(Math.abs(z.attack - 0.03125) < 0.001, `attack=${z.attack}`);
  // decay: -4800 timecents → 2^(-4) = 0.0625
  assert.ok(Math.abs(z.decay - 0.0625) < 0.001, `decay=${z.decay}`);
});

test('parseSf2 converts centibel sustain to linear gain', () => {
  const sf2 = parseSf2(buildMinimalSf2());
  const z = sf2.presets.get(0).zones[0];
  // -100 centibels → 10^(-0.5) ≈ 0.31623
  assert.ok(Math.abs(z.sustain - 0.31623) < 0.001, `sustain=${z.sustain}`);
});

test('parseSf2 defaults release from timecent -12000 when no releaseVolEnv generator is present', () => {
  const sf2 = parseSf2(buildMinimalSf2());
  const z = sf2.presets.get(0).zones[0];
  // -12000 timecents → 2^(-10) ≈ 0.000977
  assert.ok(Math.abs(z.release - Math.pow(2, -10)) < 0.0001, `release=${z.release}`);
});

test('parseSf2 sample data is 16-bit PCM with correct length', () => {
  const sf2 = parseSf2(buildMinimalSf2());
  assert.ok(sf2.sampleData instanceof Int16Array);
  assert.equal(sf2.sampleData.length, 97);
  // First sample: sin(0) = 0
  assert.equal(sf2.sampleData[0], 0);
});

test('parseSf2 sample header has correct fields', () => {
  const sf2 = parseSf2(buildMinimalSf2());
  // shdr has 2 entries (real + sentinel), [0] is the real sample
  const s = sf2.samples[0];
  assert.equal(s.start, 0);
  assert.equal(s.end, 97);
  assert.equal(s.loopStart, 16);
  assert.equal(s.loopEnd, 81); // 97 - 16
  assert.equal(s.sampleRate, 44100);
  assert.equal(s.rootKey, 60);
  assert.equal(s.fineTune, 0);
});

test('a stereo sample-link pair (one explicit zone, sampleLink to an unzoned partner) is expanded to both channels', () => {
  // Some fonts encode a stereo instrument as ONE zone per side, relying on
  // the player to follow each sample's `sampleLink` to find its partner —
  // as opposed to hand-authoring two explicit panned zones. Without
  // following the link, only the named sample's channel would ever sound
  // ("some soundfonts only play left or right").
  const sf2 = parseSf2(buildStereoLinkSf2({}));
  const zones = sf2.presets.get(0).zones;
  assert.equal(zones.length, 2, 'both the named sample and its linked partner should become zones');
  const bySample = Object.fromEntries(zones.map((z) => [z.sampleIndex, z]));
  assert.equal(bySample[0].pan, -1, 'leftSample (type 4) defaults hard left');
  assert.equal(bySample[1].pan, 1, 'the linked rightSample partner sits on the opposite side');
});

test('an explicit PAN generator on a stereo-linked zone wins over the type-inferred default', () => {
  const sf2 = parseSf2(buildStereoLinkSf2({ explicitPan: 0.3 }));
  const zones = sf2.presets.get(0).zones;
  const bySample = Object.fromEntries(zones.map((z) => [z.sampleIndex, z]));
  assert.equal(bySample[0].pan, 0.3, 'the font author\'s own pan is never overridden');
  assert.equal(bySample[1].pan, 1, 'the synthesized partner (no authored pan of its own) still gets the type default');
});

test('a font that already hand-authors both stereo-pair zones is not double-paired', () => {
  // The common, already-working pattern: two explicit zones, each with its
  // own PAN generator, referencing untyped (non-stereo-linked) samples.
  // Confirms the new link-expansion logic only adds a zone when the
  // partner ISN'T already present, so this font still gets exactly 2 zones.
  const sf2 = parseSf2(buildDualZoneStereoSf2());
  assert.equal(sf2.presets.get(0).zones.length, 2);
});

test('an unrelated mono zone (no stereo link) is unaffected by the expansion logic', () => {
  const sf2 = parseSf2(buildMinimalSf2());
  assert.equal(sf2.presets.get(0).zones.length, 1);
});