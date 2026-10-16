import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { ValueNoise1D } from '../src/utils/noise.js';
import {
  extractRidgePortrait, findLandmarks, sampleEnergyWave, phrasePeriod,
  composeAlpinePeaks, seedPeaks, layerWeathering, spineAt, phraseAt,
  lithologyFromShares, layerLithology, massProfile,
  PORTRAIT_SAMPLES, MAX_LANDMARKS,
} from '../src/world/RidgePortrait.js';
import { ALPINE_CHARACTERS, alpineHeightField, rollingHeightField } from '../src/world/SilhouetteGenerator.js';

function makeCurves({ durationMs = 120000, rateHz = 50, energyAt, bandsAt } = {}) {
  const ec = new EnergyCurves(durationMs, rateHz);
  for (let i = 0; i < ec.n; i++) {
    const t01 = ec.n > 1 ? i / (ec.n - 1) : 0;
    const e = energyAt ? energyAt(t01) : 0.4;
    const shares = bandsAt ? bandsAt(t01) : [1, 1, 1, 1, 1, 1, 1];
    let sum = 0;
    for (const s of shares) sum += s;
    const frame = shares.map((s) => Math.max(0, e * s / (sum || 1)));
    ec.setFrame(i, frame);
  }
  return { ec, durationMs };
}

function bump(t01, at, width, height) {
  const d = (t01 - at) / width;
  return height * Math.exp(-d * d * 4);
}

/** Bass-heavy drop song: quiet, then one late mountain. */
function bassDrop() {
  return makeCurves({
    energyAt: (t) => 0.12 + bump(t, 0.72, 0.08, 0.85),
    bandsAt: () => [1.6, 1.4, 0.4, 0.25, 0.12, 0.06, 0.03],
  });
}

/** Bright, busy song: several sharp mid/high peaks. */
function brightBusy() {
  return makeCurves({
    energyAt: (t) => 0.18
      + bump(t, 0.18, 0.05, 0.55)
      + bump(t, 0.38, 0.04, 0.7)
      + bump(t, 0.55, 0.045, 0.5)
      + bump(t, 0.78, 0.05, 0.8)
      + bump(t, 0.90, 0.03, 0.45),
    bandsAt: () => [0.15, 0.25, 0.5, 1.0, 1.3, 1.4, 1.1],
  });
}

/** Verse-chorus-verse-chorus: two pairs, choruses taller. */
function verseChorus() {
  return makeCurves({
    energyAt: (t) => 0.14
      + bump(t, 0.18, 0.07, 0.40)  // verse 1
      + bump(t, 0.38, 0.07, 0.82)  // chorus 1
      + bump(t, 0.58, 0.07, 0.42)  // verse 2
      + bump(t, 0.80, 0.08, 0.95), // chorus 2 (bigger)
    bandsAt: () => [0.7, 0.9, 1.0, 1.1, 0.8, 0.5, 0.3],
  });
}

/** Pad drone: almost no dynamics, mid-forward, little air. */
function drone() {
  return makeCurves({
    energyAt: (t) => 0.35 + 0.04 * Math.sin(t * Math.PI * 2),
    bandsAt: () => [0.2, 0.3, 1.4, 1.0, 0.25, 0.1, 0.05],
  });
}

/** Repeating phrase so autocorrelation has something to grab. */
function looped() {
  return makeCurves({
    energyAt: (t) => 0.2 + 0.55 * Math.max(0, Math.sin(t * Math.PI * 8)),
    bandsAt: () => [1.0, 1.1, 0.6, 0.5, 0.4, 0.3, 0.2],
  });
}

test('extractRidgePortrait is null without a real energy curve', () => {
  assert.equal(extractRidgePortrait(null, 120000), null);
  assert.equal(extractRidgePortrait({ n: 3 }, 120000), null);
  assert.equal(extractRidgePortrait(new EnergyCurves(500, 50), 500), null);
});

test('extractRidgePortrait is deterministic', () => {
  const { ec, durationMs } = verseChorus();
  const a = extractRidgePortrait(ec, durationMs);
  const b = extractRidgePortrait(ec, durationMs);
  assert.ok(a);
  assert.equal(a.landmarks.length, b.landmarks.length);
  for (let i = 0; i < a.landmarks.length; i++) {
    assert.equal(a.landmarks[i].t01, b.landmarks[i].t01);
    assert.equal(a.landmarks[i].prominence, b.landmarks[i].prominence);
  }
  assert.equal(a.centroid01, b.centroid01);
  assert.equal(a.bassShare, b.bassShare);
});

test('bass-heavy drop reads as a low-centroid, high-bass portrait with one dominant landmark', () => {
  const { ec, durationMs } = bassDrop();
  const p = extractRidgePortrait(ec, durationMs);
  assert.ok(p.bassShare > 0.5, `bassShare ${p.bassShare}`);
  assert.ok(p.centroid01 < 0.35, `centroid ${p.centroid01}`);
  assert.ok(p.landmarks.length >= 1 && p.landmarks.length <= 4, `landmarks ${p.landmarks.length}`);
  const king = p.landmarks.reduce((a, b) => (b.prominence > a.prominence ? b : a));
  assert.ok(king.t01 > 0.55, `drop should sit late, t01=${king.t01}`);
});

test('bright busy song reads high centroid / high edge, with several landmarks', () => {
  const { ec, durationMs } = brightBusy();
  const p = extractRidgePortrait(ec, durationMs);
  assert.ok(p.centroid01 > 0.5, `centroid ${p.centroid01}`);
  assert.ok(p.edgeShare + p.airShare > p.bassShare, 'bright mass should outweigh bass');
  assert.ok(p.landmarks.length >= 3, `expected several summits, got ${p.landmarks.length}`);
});

test('verse-chorus form yields a handful of phrase-scale landmarks, not a comb', () => {
  const { ec, durationMs } = verseChorus();
  const p = extractRidgePortrait(ec, durationMs);
  assert.ok(p.landmarks.length >= 2 && p.landmarks.length <= 8, `got ${p.landmarks.length}`);
  assert.ok(p.landmarks.length < PORTRAIT_SAMPLES / 4, 'must not keep every ripple');
  const king = p.landmarks.reduce((a, b) => (b.prominence > a.prominence ? b : a));
  assert.ok(king.t01 > 0.65, `final chorus should be king, t01=${king.t01}`);
});

test('findLandmarks rejects a ripple and keeps a real summit', () => {
  const n = 64;
  const wave = new Float32Array(n);
  for (let i = 0; i < n; i++) wave[i] = 0.3 + 0.03 * Math.sin(i * 1.7);
  wave[40] = 0.95;
  wave[39] = 0.6;
  wave[41] = 0.55;
  const lms = findLandmarks(wave);
  assert.ok(lms.length >= 1 && lms.length <= 4, `got ${lms.length}`);
  assert.ok(lms.some((lm) => Math.abs(lm.i - 40) <= 1), 'the real summit must survive');
});

test('findLandmarks enforces min spacing and the cap', () => {
  const wave = new Float32Array(64);
  for (let k = 0; k < 16; k++) wave[4 + k * 3] = 0.9;
  const lms = findLandmarks(wave, { minSpacing: 4, maxCount: 6, prominenceFloor: 0.05 });
  assert.ok(lms.length <= 6);
  const sorted = [...lms].sort((a, b) => a.i - b.i);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].i - sorted[i - 1].i >= 4, `spacing ${sorted[i].i - sorted[i - 1].i}`);
  }
});

test('composeAlpinePeaks: king is the most prominent landmark, not a forced centre', () => {
  const { ec, durationMs } = bassDrop();
  const portrait = extractRidgePortrait(ec, durationMs);
  const peaks = composeAlpinePeaks({
    portrait, cfg: ALPINE_CHARACTERS.massif, layerKey: 'L2', seed: 7, width: 2048,
  });
  assert.ok(peaks.length >= 3, `massif should still be a range, got ${peaks.length}`);
  const king = peaks.find((p) => p.king) || peaks.reduce((a, b) => (b.h > a.h ? b : a));
  const u = king.x / 2048;
  assert.ok(u > 0.12 && u < 0.88, `king off the wrap, u=${u}`);
  // Late drop → king sits right of centre, not dead-on 0.5.
  assert.ok(u > 0.40, `late song should lean the king right, u=${u}`);
  assert.ok(king.h >= Math.max(...peaks.map((p) => p.h)) - 1e-6);
});

test('composeAlpinePeaks: layers rhyme without cloning', () => {
  const { ec, durationMs } = verseChorus();
  const portrait = extractRidgePortrait(ec, durationMs);
  const l2 = composeAlpinePeaks({ portrait, cfg: ALPINE_CHARACTERS.massif, layerKey: 'L2', seed: 11, width: 2048 });
  const l3 = composeAlpinePeaks({ portrait, cfg: ALPINE_CHARACTERS.range, layerKey: 'L3', seed: 12, width: 2048 });
  const l4 = composeAlpinePeaks({ portrait, cfg: ALPINE_CHARACTERS.crags, layerKey: 'L4', seed: 13, width: 2048 });
  assert.ok(l2.length <= l3.length, `L2 (${l2.length}) should be the sparsest vs L3 (${l3.length})`);
  assert.ok(l4.length >= l3.length, `L4 (${l4.length}) should be the busiest`);
  const meanW = (ps) => ps.reduce((s, p) => s + p.w, 0) / ps.length;
  assert.ok(meanW(l2) > meanW(l4), `far peaks should be broader: L2 ${meanW(l2)} vs L4 ${meanW(l4)}`);
  const xs = (ps) => ps.map((p) => Math.round(p.x / 8)).join(',');
  assert.notEqual(xs(l2), xs(l3), 'L2 and L3 must not share a stencil');
});

test('two different songs compose different skylines', () => {
  const a = extractRidgePortrait(bassDrop().ec, 120000);
  const b = extractRidgePortrait(brightBusy().ec, 120000);
  const pa = composeAlpinePeaks({ portrait: a, cfg: ALPINE_CHARACTERS.massif, layerKey: 'L2', seed: 1, width: 2048 });
  const pb = composeAlpinePeaks({ portrait: b, cfg: ALPINE_CHARACTERS.massif, layerKey: 'L2', seed: 1, width: 2048 });
  const sig = (ps) => ps.map((p) => `${Math.round(p.x / 16)}:${p.h.toFixed(2)}`).join('|');
  assert.notEqual(sig(pa), sig(pb));
  const meanW = (ps) => ps.reduce((s, p) => s + p.w, 0) / ps.length;
  assert.ok(meanW(pa) > meanW(pb) * 0.95, `bass song should be at least as broad: ${meanW(pa)} vs ${meanW(pb)}`);
});

test('same song + same seed is a stable composition', () => {
  const portrait = extractRidgePortrait(verseChorus().ec, 120000);
  const a = composeAlpinePeaks({ portrait, cfg: ALPINE_CHARACTERS.range, layerKey: 'L3', seed: 99, width: 2048 });
  const b = composeAlpinePeaks({ portrait, cfg: ALPINE_CHARACTERS.range, layerKey: 'L3', seed: 99, width: 2048 });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].x, b[i].x);
    assert.equal(a[i].h, b[i].h);
    assert.equal(a[i].w, b[i].w);
  }
});

test('weathering: a drone is quieter than a bright song, and neither matches the old raw constants', () => {
  const d = extractRidgePortrait(drone().ec, 120000);
  const b = extractRidgePortrait(brightBusy().ec, 120000);
  const cfg = ALPINE_CHARACTERS.massif;
  const dw = layerWeathering(d, cfg, 'L2');
  const bw = layerWeathering(b, cfg, 'L2');
  assert.ok(bw.teeth > dw.teeth, `bright teeth ${bw.teeth} vs drone ${dw.teeth}`);
  assert.ok(bw.notch > dw.notch, `bright notch ${bw.notch} vs drone ${dw.notch}`);
  assert.ok(dw.notch < cfg.notch, 'portrait notches must be calmer than the old raw amount');
  assert.ok(bw.teeth <= cfg.teeth * 1.15, `even a bright L2 must not explode: ${bw.teeth} vs ${cfg.teeth}`);
});

test('bass song lifts the connecting bed (high saddles) vs a bright one', () => {
  const bass = extractRidgePortrait(bassDrop().ec, 120000);
  const bright = extractRidgePortrait(brightBusy().ec, 120000);
  const cfg = ALPINE_CHARACTERS.massif;
  const a = layerWeathering(bass, cfg, 'L2');
  const b = layerWeathering(bright, cfg, 'L2');
  assert.ok(a.bed > b.bed, `bass bed ${a.bed} vs bright ${b.bed}`);
});

test('alpineHeightField with a portrait stays in 0..1, has a few distinct summits, and is not a mesa', () => {
  const portrait = extractRidgePortrait(verseChorus().ec, 120000);
  const noise = new ValueNoise1D(42, 256);
  const n = 512, step = 4, width = n * step;
  const h = alpineHeightField(noise, n, step, 1234, width, 'massif', portrait, 'L2');
  let max = 0, sum = 0, peaks = 0;
  for (let i = 0; i < n; i++) {
    assert.ok(h[i] >= 0 && h[i] <= 1, `h[${i}]=${h[i]}`);
    max = Math.max(max, h[i]);
    sum += h[i];
  }
  for (let i = 2; i < n - 2; i++) {
    if (h[i] > 0.55 && h[i] >= h[i - 1] && h[i] >= h[i + 1] && h[i] > h[i - 2] && h[i] > h[i + 2]) peaks++;
  }
  assert.ok(max > 0.75, `max ${max}`);
  assert.ok(peaks >= 2 && peaks <= 40, `summits ${peaks}`);
  let nearTop = 0;
  for (let i = 0; i < n; i++) if (h[i] > max * 0.92) nearTop++;
  assert.ok(nearTop / n < 0.10, `mesa? ${nearTop}/${n}`);
});

test('portrait alpine is peakier than rolling foothills', () => {
  const portrait = extractRidgePortrait(brightBusy().ec, 120000);
  const noise = new ValueNoise1D(7, 256);
  const n = 400, step = 5, width = n * step;
  const alpine = alpineHeightField(noise, n, step, 99, width, 'massif', portrait, 'L2');
  const rolling = rollingHeightField(noise, n, step, 2, portrait, width);
  let aMax = 0, rMax = 0, aSum = 0, rSum = 0;
  for (let i = 0; i < n; i++) {
    aMax = Math.max(aMax, alpine[i]);
    rMax = Math.max(rMax, rolling[i]);
    aSum += alpine[i];
    rSum += rolling[i];
  }
  const aPeak = aMax / (aSum / n + 1e-6);
  const rPeak = rMax / (rSum / n + 1e-6);
  assert.ok(aPeak > rPeak * 0.95, `a=${aPeak} r=${rPeak}`);
});

test('rolling with a portrait stays in 0..1 and is not a spectrogram (low variance vs alpine)', () => {
  const portrait = extractRidgePortrait(looped().ec, 120000);
  const noise = new ValueNoise1D(3, 256);
  const n = 256, step = 8;
  const h = rollingHeightField(noise, n, step, 2, portrait, n * step);
  let min = 1, max = 0;
  for (let i = 0; i < n; i++) {
    assert.ok(h[i] >= 0 && h[i] <= 1);
    min = Math.min(min, h[i]);
    max = Math.max(max, h[i]);
  }
  assert.ok(max - min < 0.85, `rolling should stay gentle, span=${max - min}`);
});

test('the outline is not a 64-bar spectrogram: few composed peaks, spanning the whole tile', () => {
  const portrait = extractRidgePortrait(brightBusy().ec, 120000);
  const peaks = composeAlpinePeaks({
    portrait, cfg: ALPINE_CHARACTERS.massif, layerKey: 'L2', seed: 4, width: 2048,
  });
  assert.ok(peaks.length < PORTRAIT_SAMPLES / 4, 'must not place a peak per energy sample');

  // This used to assert every peak sat inside [0.10, 0.90] -- "off the tile
  // wrap". That constraint came from clamping placement into a margin, and
  // it was actively harmful: `shift` slides the composition to put the king
  // at kingU, and clamping then piled everything that fell outside the
  // margin onto one edge, leaving the opposite side of the tile empty. That
  // empty side was the long dead-flat stretch that made the ranges read as
  // random bumps on a plain. Placement wraps now (the strip TILES -- there
  // is no privileged frame), so the property worth pinning is the opposite
  // one: the summits have to actually SPAN the tile.
  const us = peaks.map((p) => p.x / 2048).sort((a, b) => a - b);
  let widestGap = us[0] + (1 - us[us.length - 1]); // the gap across the seam
  for (let i = 1; i < us.length; i++) widestGap = Math.max(widestGap, us[i] - us[i - 1]);
  assert.ok(widestGap <= 0.34, `range leaves a dead stretch ${widestGap.toFixed(2)} wide`);
});

test('phrasePeriod finds a repeating loop and stays quiet on a drone', () => {
  const loopWave = sampleEnergyWave(looped().ec, 120000);
  const loopP = phrasePeriod(loopWave);
  assert.ok(loopP.period01 > 0, 'looped song should have a phrase period');
  assert.ok(loopP.strength >= 0.25);
  assert.ok(loopP.phrase.length >= 4);

  const droneWave = sampleEnergyWave(drone().ec, 120000);
  const droneP = phrasePeriod(droneWave);
  // A near-sine at 1 cycle over the whole song has no local autocorr peak
  // in the phrase window, so it must not invent a phrase.
  assert.equal(droneP.period01, 0);
  assert.equal(droneP.strength, 0);
});

test('spineAt / phraseAt are bounded and wrap', () => {
  const portrait = extractRidgePortrait(verseChorus().ec, 120000);
  for (const u of [0, 0.3, 0.99, 1, 1.4, -0.2]) {
    const s = spineAt(portrait, u, 0.1);
    const p = phraseAt(portrait, u);
    assert.ok(s >= 0 && s <= 0.1 + 1e-6, `spine ${s} at ${u}`);
    assert.ok(p >= 0 && p <= 1 + 1e-6, `phrase ${p} at ${u}`);
  }
});

test('seedPeaks fallback still builds a king and stays off the wrap', () => {
  const peaks = seedPeaks(ALPINE_CHARACTERS.massif, 42, 2048);
  assert.ok(peaks.length >= 3);
  assert.ok(peaks.some((p) => p.king));
  const king = peaks.find((p) => p.king);
  assert.ok(king.h >= 0.94);
  for (const p of peaks) {
    const u = p.x / 2048;
    assert.ok(u >= 0.10 && u <= 0.90, `u=${u}`);
  }
});

test('no-portrait alpineHeightField remains deterministic', () => {
  const noise = new ValueNoise1D(42, 256);
  const n = 256, step = 8, width = n * step;
  const a = alpineHeightField(noise, n, step, 42, width);
  const b = alpineHeightField(noise, n, step, 42, width);
  assert.equal(a.length, n);
  for (let i = 0; i < n; i++) assert.equal(a[i], b[i]);
});

// --- Spectral mass geology -------------------------------------------------
// Same energy envelope, different 7-band shape: the FORM (landmarks) stays
// put and the ROCK changes. That's the whole point of treating the spectrum
// as a vertical mass distribution instead of another timeline.

function sameForm(bandsAt) {
  return makeCurves({
    energyAt: (t) => 0.16
      + bump(t, 0.22, 0.07, 0.50)
      + bump(t, 0.52, 0.07, 0.78)
      + bump(t, 0.78, 0.08, 0.92),
    bandsAt,
  });
}

const BASS_MIX = () => [1.8, 1.5, 0.25, 0.18, 0.10, 0.05, 0.02];
const MID_MIX = () => [0.35, 0.45, 1.25, 1.35, 0.70, 0.28, 0.12];
const BRIGHT_MIX = () => [0.10, 0.14, 0.28, 0.48, 1.15, 1.40, 1.25];
const SCOOP_MIX = () => [1.55, 1.35, 0.12, 0.10, 0.18, 1.15, 1.05];

test('lithologyFromShares: bass loads the foot, bright loads the tip, scoop loads both', () => {
  const bass = lithologyFromShares(BASS_MIX());
  const mid = lithologyFromShares(MID_MIX());
  const bright = lithologyFromShares(BRIGHT_MIX());
  const scoop = lithologyFromShares(SCOOP_MIX());

  assert.ok(bass.foot > bright.foot, `bass foot ${bass.foot} vs bright ${bright.foot}`);
  assert.ok(bright.tip > bass.tip, `bright tip ${bright.tip} vs bass ${bass.tip}`);
  assert.ok(mid.mid > bass.mid && mid.mid > bright.mid, `mid-forward should own the body: ${mid.mid}`);
  assert.ok(scoop.scoop > 0.3, `scoop ${scoop.scoop}`);
  assert.ok(scoop.foot > mid.foot, `scooped mix still has basement: ${scoop.foot} vs ${mid.foot}`);
  assert.ok(scoop.tip > mid.tip, `scooped mix still has a horn: ${scoop.tip} vs ${mid.tip}`);
  assert.ok(Math.abs(bass.foot + bass.mid + bass.tip - 1) < 1e-6);
});

test('massProfile is 1 at the summit, 0 at the foot, and bass is bulkier at mid-flank than bright', () => {
  const bass = lithologyFromShares(BASS_MIX());
  const bright = lithologyFromShares(BRIGHT_MIX());
  assert.ok(Math.abs(massProfile(0, bass) - 1) < 1e-6);
  assert.equal(massProfile(1, bass), 0);
  assert.equal(massProfile(1.2, bass), 0);
  // d=0.55 is the lower flank: a shield still has mass there, a horn doesn't.
  assert.ok(massProfile(0.55, bass) > massProfile(0.55, bright) * 1.15,
    `bass ${massProfile(0.55, bass)} vs bright ${massProfile(0.55, bright)}`);
  // Near the summit (d=0.12) the horn holds more of its height as a spike;
  // the shield has already started spreading. Relative to d=0.55, bright
  // drops faster.
  const bassDrop = massProfile(0.12, bass) - massProfile(0.55, bass);
  const brightDrop = massProfile(0.12, bright) - massProfile(0.55, bright);
  assert.ok(brightDrop > bassDrop, `bright should fall off faster: ${brightDrop} vs ${bassDrop}`);
});

test('a scooped mix is a plateau with horns, not a triangle', () => {
  const scoop = lithologyFromShares(SCOOP_MIX());
  const mid = lithologyFromShares(MID_MIX());
  // Far flank (d=0.78): scoop's basement keeps mass out on the plain.
  assert.ok(massProfile(0.78, scoop) > massProfile(0.78, mid),
    `plateau foot: scoop ${massProfile(0.78, scoop)} vs mid ${massProfile(0.78, mid)}`);
  // Upper flank near the tip (d=0.08): both near 1, but the scoop's extra
  // tip weight vs mid's body weight shows as a sharper last bit — the
  // derivative from 0.04 to 0.16 should be steeper for scoop.
  const scoopSlope = massProfile(0.04, scoop) - massProfile(0.18, scoop);
  const midSlope = massProfile(0.04, mid) - massProfile(0.18, mid);
  assert.ok(scoopSlope > midSlope * 0.95, `horn: scoop slope ${scoopSlope} vs mid ${midSlope}`);
});

test('layerLithology: L2 tilts to the foot, L4 tilts to the tip', () => {
  const litho = lithologyFromShares(MID_MIX());
  const l2 = layerLithology(litho, 'L2');
  const l3 = layerLithology(litho, 'L3');
  const l4 = layerLithology(litho, 'L4');
  assert.ok(l2.foot > l3.foot, `L2 foot ${l2.foot} vs L3 ${l3.foot}`);
  assert.ok(l4.tip > l3.tip, `L4 tip ${l4.tip} vs L3 ${l3.tip}`);
  assert.ok(Math.abs(l2.foot + l2.mid + l2.tip - 1) < 1e-6);
});

test('same form, different spectrum: saddles sit higher under bass than under treble', () => {
  const bassP = extractRidgePortrait(sameForm(BASS_MIX).ec, 120000);
  const brightP = extractRidgePortrait(sameForm(BRIGHT_MIX).ec, 120000);
  assert.equal(bassP.landmarks.length, brightP.landmarks.length, 'form (landmarks) must match');
  const cfg = ALPINE_CHARACTERS.massif;
  const bw = layerWeathering(bassP, cfg, 'L3');
  const tw = layerWeathering(brightP, cfg, 'L3');
  assert.ok(bw.apronCap > tw.apronCap, `apronCap bass ${bw.apronCap} vs bright ${tw.apronCap}`);
  assert.ok(bw.apronSpread > tw.apronSpread, `apronSpread bass ${bw.apronSpread} vs bright ${tw.apronSpread}`);
  assert.ok(bw.litho.foot > tw.litho.foot);

  const noise = new ValueNoise1D(9, 256);
  const n = 400, step = 5, width = n * step;
  const bassH = alpineHeightField(noise, n, step, 44, width, 'range', bassP, 'L3');
  const brightH = alpineHeightField(noise, n, step, 44, width, 'range', brightP, 'L3');
  // Mean of the lower half of samples ≈ connecting mass. Bass should sit
  // higher (altiplano); bright should drop into deeper valleys.
  const lowerMean = (h) => {
    const sorted = Float32Array.from(h).slice().sort((a, b) => a - b);
    let s = 0, c = Math.floor(sorted.length * 0.5);
    for (let i = 0; i < c; i++) s += sorted[i];
    return s / c;
  };
  const bassSaddle = lowerMean(bassH);
  const brightSaddle = lowerMean(brightH);
  assert.ok(bassSaddle > brightSaddle, `saddle bass ${bassSaddle} vs bright ${brightSaddle}`);
});

test('extractRidgePortrait carries lithology, and L3 leans on it harder than L4', () => {
  const p = extractRidgePortrait(sameForm(SCOOP_MIX).ec, 120000);
  assert.ok(p.lithology);
  assert.ok(p.lithology.scoop > 0.2);
  const cfg = ALPINE_CHARACTERS.range;
  const l3 = layerWeathering(p, cfg, 'L3');
  const l4 = layerWeathering(p, cfg, 'L4');
  assert.ok(l3.profileMix > l4.profileMix, 'timbre layer should lean on spectral geology more than crags');
});

