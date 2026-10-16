import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spectralShiftDeg, easeSpectralShift, hueOf, spectralTokens } from '../src/render/spectral.js';
import { spectralHue } from '../src/render/stellar.js';
import { rotateHueHex } from '../src/utils/color.js';

// The TWILIGHT profile (the default resting world) -- representative of
// how every biome is keyed: the palette rotates as one body so the anchor
// hue lands on the song's tonic.
const TWILIGHT = {
  sky: ['#1a1a3e', '#4a3b6b', '#e8746a'],
  silhouette: '#2b2145',
  celestial: { kind: 'sun', color: '#ffb37a', radius: 46, haloColor: '#ffdca0' },
  particles: { kind: 'fireflies', color: '#fff2a8', count: 26, speed: 14 },
  fx: 'starTwinkle',
  terrainEnergy: 1.0,
};

test('with a detected tonic, the world halo converges onto the song key', () => {
  const tonic = 7; // G: spectralHue 210
  const tokens = spectralTokens({ tonic, biome: TWILIGHT });
  const haloHue = hueOf(tokens.halo);
  const d = Math.abs(((haloHue - spectralHue(tonic) + 540) % 360) - 180);
  assert.ok(d <= 6, `halo hue ${haloHue.toFixed(1)} should land on G (210), delta ${d.toFixed(1)}`);
});

test('a different tonic moves the whole world palette as one body', () => {
  const cMajor = spectralTokens({ tonic: 0, biome: TWILIGHT });
  const gSharp = spectralTokens({ tonic: 8, biome: TWILIGHT }); // F#/Gb: 240
  const a = hueOf(cMajor.halo);
  const b = hueOf(gSharp.halo);
  const d = Math.abs(((b - a + 540) % 360) - 180);
  assert.ok(d > 100, `two distant keys must land far apart on the wheel, got delta ${d.toFixed(1)}`);
});

test('spectralShiftDeg drives the anchor onto the key by the shortest arc', () => {
  const anchorHue = hueOf(TWILIGHT.celestial.haloColor); // ~37.9
  const tonic = 7;
  const shift = spectralShiftDeg(anchorHue, tonic);
  const landed = rotateHueHex(TWILIGHT.celestial.haloColor, shift);
  const d = Math.abs(((hueOf(landed) - spectralHue(tonic) + 540) % 360) - 180);
  assert.ok(d <= 3, `shortest-arc rotation must land on the key, delta ${d.toFixed(1)}`);
});

test('easeSpectralShift glides toward the target rather than snapping', () => {
  const target = 180;
  let cur = 0;
  const dt = 1 / 120;
  cur = easeSpectralShift(cur, target, dt);
  assert.ok(cur < 5, `the first step after a key change must move only a little (${cur.toFixed(2)}deg)`);
  for (let i = 0; i < 120 * 10; i++) cur = easeSpectralShift(cur, target, dt);
  assert.ok(Math.abs(cur - target) < 2, `should converge on the target, got ${cur.toFixed(1)}`);
});

test('easeSpectralShift never overshoots and snaps cleanly to zero', () => {
  // Target 0 from a large eased value: decays down, never below.
  let cur = 90;
  const dt = 1 / 120;
  for (let i = 0; i < 120 * 20; i++) {
    const next = easeSpectralShift(cur, 0, dt);
    assert.ok(next <= cur + 1e-9, 'must not overshoot upward toward the target');
    assert.ok(next >= 0 - 1e-9, 'must not undershoot below zero');
    cur = next;
  }
  assert.equal(cur, 0, 'decays to exactly zero (snap when both are zero)');
});

test('easeSpectralShift tolerates degenerate dt', () => {
  assert.ok(Number.isFinite(easeSpectralShift(30, 100, 0)));
  assert.ok(Number.isFinite(easeSpectralShift(30, 100, -1)));
  assert.equal(easeSpectralShift(30, 100, 0), 30, 'zero dt moves nothing');
});

test('the keyed palette stays one body: every token rotates by the same quantized shift', () => {
  const tonic = 5;
  const t = spectralTokens({ tonic, biome: TWILIGHT });
  if (t.shiftDeg === 0) return;
  assert.equal(t.sky[0], rotateHueHex(TWILIGHT.sky[0], t.shiftDeg));
  assert.equal(t.sky[1], rotateHueHex(TWILIGHT.sky[1], t.shiftDeg));
  assert.equal(t.silhouette, rotateHueHex(TWILIGHT.silhouette, t.shiftDeg));
  assert.equal(t.halo, rotateHueHex(TWILIGHT.celestial.haloColor, t.shiftDeg));
});
