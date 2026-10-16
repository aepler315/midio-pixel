import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhraseTracker, choosePhraseLength, autocorrAtLag } from '../src/core/PhraseTracker.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { BANDS } from '../src/audio/bands.js';

const BAR_MS = 2000; // 4 beats at 120 BPM

function makeBars(count) {
  return Array.from({ length: count }, (_, i) => ({ ms: i * BAR_MS }));
}

/** EnergyCurves whose global energy follows `levelForBar` exactly. */
function makeEnergy(barCount, levelForBar) {
  const durationMs = barCount * BAR_MS;
  const ec = new EnergyCurves(durationMs);
  for (let f = 0; f < ec.n; f++) {
    const tMs = (f / ec.rateHz) * 1000;
    const bar = Math.min(barCount - 1, Math.floor(tMs / BAR_MS));
    const v = levelForBar(bar);
    ec.setFrame(f, new Array(BANDS.length).fill(v));
  }
  return ec;
}

test('defaults to 4-bar phrases with no energy curves or short songs', () => {
  assert.equal(choosePhraseLength([], null), 4);
  const bars = makeBars(8).map((b) => b.ms);
  assert.equal(choosePhraseLength(bars, makeEnergy(8, () => 0.5)), 4);
});

test('picks 8-bar phrases when energy repeats on an 8-bar cycle', () => {
  const barCount = 32;
  // A profile periodic in 8 bars but NOT in 4: bars 0-3 quiet, 4-7 loud.
  const level = (bar) => ((bar % 8) < 4 ? 0.2 : 0.9);
  const bars = makeBars(barCount).map((b) => b.ms);
  assert.equal(choosePhraseLength(bars, makeEnergy(barCount, level)), 8);
});

test('keeps 4-bar phrases when energy repeats every 4 bars', () => {
  const barCount = 32;
  const level = (bar) => ((bar % 4) < 2 ? 0.2 : 0.9); // periodic in 4 (and thus 8)
  const bars = makeBars(barCount).map((b) => b.ms);
  // c8 cannot beat c4 by the margin: both are ~1.
  assert.equal(choosePhraseLength(bars, makeEnergy(barCount, level)), 4);
});

test('infoAt maps times to bar/phrase coordinates', () => {
  const pt = new PhraseTracker(makeBars(16), null);
  assert.equal(pt.phraseLenBars, 4);
  assert.deepEqual(pt.infoAt(0), { barIdx: 0, phraseIdx: 0, barInPhrase: 0, phraseLenBars: 4 });
  assert.deepEqual(pt.infoAt(BAR_MS * 5 + 10), { barIdx: 5, phraseIdx: 1, barInPhrase: 1, phraseLenBars: 4 });
  // Past the last bar clamps to the last bar's phrase.
  assert.equal(pt.infoAt(BAR_MS * 100).barIdx, 15);
});

test('bar-less songs fall back to a nominal fixed phrase period', () => {
  const pt = new PhraseTracker([], null);
  const a = pt.infoAt(0), b = pt.infoAt(pt.fallbackPhraseMs + 1);
  assert.equal(a.phraseIdx, 0);
  assert.equal(b.phraseIdx, 1);
});

test('autocorrAtLag is 1 for a perfectly periodic signal at its own lag', () => {
  const x = Array.from({ length: 40 }, (_, i) => (i % 8 < 4 ? 0 : 1));
  assert.ok(autocorrAtLag(x, 8) > 0.99);
  assert.ok(autocorrAtLag(x, 4) < 0.0, 'anti-phase at half the period');
});
