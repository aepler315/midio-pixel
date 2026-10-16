import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanLine, extractChorusPhrase } from '../src/lyrics/LyricLexicon.js';

test('scanLine: returns null for empty/whitespace input', () => {
  assert.strictEqual(scanLine(''), null);
  assert.strictEqual(scanLine('   '), null);
  assert.strictEqual(scanLine(null), null);
  assert.strictEqual(scanLine(undefined), null);
});

test('scanLine: matches common symbols at priority 1', () => {
  const r = scanLine('My heart is beating fast');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'heart');
  assert.strictEqual(r.priority, 1);
});

test('scanLine: matches specific symbols at priority 2', () => {
  const r = scanLine('Wearing a crown of thorns');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'crown');
  assert.strictEqual(r.priority, 2);
});

test('scanLine: matches easter eggs at priority 3', () => {
  const r = scanLine('Rolling up a blunt tonight');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'leaf');
  assert.strictEqual(r.priority, 3);
});

test('scanLine: higher priority wins when multiple keywords match', () => {
  const r = scanLine('The king lit a fire and stared at the stars');
  assert.ok(r);
  // crown (pri 2) or flame (pri 2) should beat star (pri 1)
  assert.ok(r.priority >= 2);
});

test('scanLine: multi-word phrases match', () => {
  const r = scanLine('Open your third eye to the truth');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'eye');
});

test('scanLine: case insensitive', () => {
  const r = scanLine('DIAMOND in the rough');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'diamond');
});

test('scanLine: no false positive on "high" or "smoke" alone', () => {
  assert.strictEqual(scanLine('High hopes'), null);
  assert.strictEqual(scanLine('Smoke on the water'), null);
});

test('scanLine: a line naming both heart and its breaking returns the heart_break combo, above plain heart', () => {
  const r = scanLine('This broken heart still beats for you');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'heart_break');
  assert.strictEqual(r.priority, 4);
});

test('scanLine: the single compound word "heartbreak" also triggers the combo', () => {
  const r = scanLine('Nothing but heartbreak in this town');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'heart_break');
});

test('scanLine: a line naming both a ship and the sea returns the ship_wave combo', () => {
  const r = scanLine('Our ship is sailing on the ocean tonight');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'ship_wave');
  assert.strictEqual(r.priority, 4);
});

test('scanLine: heart alone (no break word) still matches plain heart, not the combo', () => {
  const r = scanLine('My heart is beating fast');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'heart');
});

test('scanLine: ship alone (no wave word) still matches plain ship, not the combo', () => {
  const r = scanLine('The old ship creaks in the harbor');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'ship');
});

test('scanLine: a combo outranks an easter egg present in the same line', () => {
  const r = scanLine('An alien watched our ship sail the ocean');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'ship_wave', 'the confirmed two-image combo should win over the rarer single match');
});

test('scanLine: a line naming both wings and fire returns the phoenix combo', () => {
  const r = scanLine('Rise up on wings of fire tonight');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'phoenix');
  assert.strictEqual(r.priority, 4);
});

test('scanLine: the single word "phoenix" also triggers the combo', () => {
  const r = scanLine('Like a phoenix I return');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'phoenix');
});

test('scanLine: a line naming both moonlight and the tide returns the moon_tide combo', () => {
  const r = scanLine('Moonlight pulls the tide back home');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'moon_tide');
  assert.strictEqual(r.priority, 4);
});

test('scanLine: wings alone (no fire word) still matches plain wings, not the combo', () => {
  const r = scanLine('Angel wings above the city');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'wings');
});

test('scanLine: moon alone (no tide word) still matches plain moon, not the combo', () => {
  const r = scanLine('The moonlight guides me home');
  assert.ok(r);
  assert.strictEqual(r.glyphId, 'moon');
});

test('extractChorusPhrase: returns uppercase short phrase', () => {
  const text = 'We are the champions\nNo time for losers\nWe are the champions of the world';
  const r = extractChorusPhrase(text);
  assert.ok(r);
  assert.ok(r.length <= 22);
  assert.strictEqual(r, r.toUpperCase());
});

test('extractChorusPhrase: returns null for empty input', () => {
  assert.strictEqual(extractChorusPhrase(''), null);
  assert.strictEqual(extractChorusPhrase(null), null);
});

test('extractChorusPhrase: picks shortest non-trivial line', () => {
  const text = 'This is a very long chorus line that goes on and on\nShort hook\nAnother medium line here';
  const r = extractChorusPhrase(text);
  assert.ok(r);
  assert.strictEqual(r, 'SHORT HOOK');
});

test('extractChorusPhrase: truncates multi-word lines at word boundary', () => {
  const text = 'Dancing through the night with you forever\nAnother long line about the sunrise coming over the hill';
  const r = extractChorusPhrase(text);
  assert.ok(r);
  assert.ok(r.length <= 22, `result "${r}" exceeds 22 chars`);
});
