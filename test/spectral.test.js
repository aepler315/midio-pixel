import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hueDelta, hueOf, spectralShiftDeg, spectralTokens, cssVarMap, feverStops, spectralFamily,
} from '../src/render/spectral.js';
import { spectralHue } from '../src/render/stellar.js';
import { rotateHueHex } from '../src/utils/color.js';

// The TWILIGHT profile -- representative, with a clear purple identity.
const TWILIGHT = {
  sky: ['#1a1a3e', '#4a3b6b', '#e8746a'],
  silhouette: '#2b2145',
  celestial: { kind: 'sun', color: '#ffb37a', radius: 46, haloColor: '#ffdca0' },
  particles: { kind: 'fireflies', color: '#fff2a8', count: 26, speed: 14 },
  fx: 'starTwinkle',
  terrainEnergy: 1.0,
};

test('hueDelta is the shortest signed arc', () => {
  assert.equal(hueDelta(0, 0), 0);
  assert.equal(Math.abs(hueDelta(0, 180)), 180, 'a half-turn is a half-turn either way');
  assert.equal(hueDelta(0, 270), -90, '270 is closer going back through 0');
  assert.equal(hueDelta(350, 10), 20, 'wraps through 360');
  assert.equal(hueDelta(10, 350), -20);
});

test('spectralShiftDeg rotates the anchor onto the song key by the shortest arc', () => {
  // Anchor hue 40, C (tonic 0, spectralHue 0): rotate -40 to land on 0.
  assert.equal(spectralShiftDeg(40, 0), -40);
  // Anchor hue 40, G (tonic 7, spectralHue 210): shortest arc 210-40=170
  // vs -190 -- must pick +170.
  assert.equal(spectralShiftDeg(40, 7), 170);
  // Same key, matching anchor: zero shift.
  assert.equal(spectralShiftDeg(spectralHue(3), 3), 0);
});

test('spectralTokens at amount=0 reproduces the biome hexes byte-identically (Phase-1 no-op)', () => {
  const t = spectralTokens({ tonic: 5, biome: TWILIGHT, amount: 0 });
  assert.deepEqual(t.sky, TWILIGHT.sky);
  assert.equal(t.silhouette, TWILIGHT.silhouette);
  assert.equal(t.halo, TWILIGHT.celestial.haloColor);
  assert.equal(t.edgeLight, null);
  assert.equal(t.shiftDeg, 0);
});

test('spectralTokens amount=0 still composes the existing keyRotation + sectionHueBias', () => {
  // With amount=0 the spectral center is off, but the director signals
  // (key rotation + form bias) still apply exactly like today's _rotated.
  const t = spectralTokens({ tonic: 5, biome: TWILIGHT, amount: 0, keyRotation: 21, sectionHueBias: 6 });
  assert.equal(t.shiftDeg, Math.round((21 + 6) / 3) * 3, 'quantized to 3deg steps');
  assert.equal(t.halo, rotateHueHex(TWILIGHT.celestial.haloColor, t.shiftDeg));
});

test('spectralTokens amount=1 lands the halo hue on the song key', () => {
  const tonic = 7; // spectralHue 210
  const t = spectralTokens({ tonic, biome: TWILIGHT });
  assert.equal(t.shiftDeg, Math.round(spectralShiftDeg(hueOf(TWILIGHT.celestial.haloColor), tonic) / 3) * 3);
  // The rotated halo's hue must sit within the 3deg quantization of the key.
  const haloHue = hueOf(t.halo);
  const d = Math.abs(hueDelta(haloHue, spectralHue(tonic)));
  assert.ok(d <= 3.5, `halo hue ${haloHue} should land on key hue ${spectralHue(tonic)} (delta ${d})`);
  // And the biome keeps its internal color RELATIONSHIP: sky[0] rotates by
  // the same degrees as the halo (saturation/lightness preserved).
  assert.equal(
    rotateHueHex(TWILIGHT.sky[0], t.shiftDeg),
    t.sky[0],
    'sky rotates by the same degree as the halo -- one body',
  );
});

test('spectralTokens keys the palette as one body: every token rotates by shiftDeg', () => {
  for (const tonic of [0, 2, 5, 9, 11]) {
    const t = spectralTokens({ tonic, biome: TWILIGHT });
    if (t.shiftDeg === 0) continue;
    assert.equal(t.sky[0], rotateHueHex(TWILIGHT.sky[0], t.shiftDeg));
    assert.equal(t.sky[1], rotateHueHex(TWILIGHT.sky[1], t.shiftDeg));
    assert.equal(t.sky[2], rotateHueHex(TWILIGHT.sky[2], t.shiftDeg));
    assert.equal(t.silhouette, rotateHueHex(TWILIGHT.silhouette, t.shiftDeg));
    assert.equal(t.halo, rotateHueHex(TWILIGHT.celestial.haloColor, t.shiftDeg));
  }
});

test('spectralTokens handles an achromatic halo (ARCTIC white sun) without breaking', () => {
  const arctic = {
    sky: ['#0e2a44', '#3f6d9e', '#cfe8ff'],
    silhouette: '#12324f',
    celestial: { kind: 'sun', color: '#eaf6ff', radius: 34, haloColor: '#ffffff', ring: true },
  };
  const t = spectralTokens({ tonic: 4, biome: arctic });
  assert.equal(t.halo, '#ffffff', 'white stays white (rotating white is identity)');
  assert.ok(t.sky[0] !== arctic.sky[0], 'but the sky still keys');
});

test('an explicit anchorHue overrides the halo-derived anchor', () => {
  const t = spectralTokens({ tonic: 3, biome: TWILIGHT, anchorHue: 90 });
  assert.equal(t.shiftDeg, Math.round(hueDelta(90, spectralHue(3)) / 3) * 3);
});

test('cssVarMap emits the spec vars with the halo as gold', () => {
  const t = spectralTokens({ tonic: 2, biome: TWILIGHT });
  const vars = cssVarMap(t);
  assert.ok(vars['--spec-gold'].startsWith('#'), 'gold is the halo hex');
  assert.equal(vars['--spec-gold'], t.halo);
  for (const k of ['--spec-cool', '--spec-warm', '--spec-pad', '--spec-rhythm']) {
    assert.ok(/^#[0-9a-f]{6}$/i.test(vars[k]), `${k} should be a hex, got ${vars[k]}`);
  }
  assert.ok(Number.isFinite(Number(vars['--spec-hue'])));
});

test('spectralFamily falls back to the song base hue for an achromatic halo', () => {
  const fam = spectralFamily('#ffffff', spectralHue(7));
  assert.ok(Math.abs(fam.familyHue - spectralHue(7)) < 1, 'white halo -> the song hue drives the family');
  assert.notEqual(fam.coolHex, '#ffffff');
  assert.notEqual(fam.warmHex, '#ffffff');
});

test('feverStops anchors the gauge to the tonic: warm == the song key hue', () => {
  const tonic = 9;
  const stops = feverStops(tonic);
  assert.equal(stops.warm.h, spectralHue(tonic), 'the mid stop IS the song key');
  assert.notEqual(stops.cool.h, stops.warm.h);
  assert.notEqual(stops.hot.h, stops.warm.h);
  assert.ok(stops.cool.s >= 0 && stops.cool.s <= 100);
  assert.ok(stops.hot.l > stops.warm.l, 'hot reads hotter');
});

test('spectralTokens is deterministic for identical inputs', () => {
  const a = spectralTokens({ tonic: 6, biome: TWILIGHT, keyRotation: 12, sectionHueBias: -9 });
  const b = spectralTokens({ tonic: 6, biome: TWILIGHT, keyRotation: 12, sectionHueBias: -9 });
  assert.deepEqual(a, b);
});
