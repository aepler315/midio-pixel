// The ridge as a score. Every assertion here pins one of the four things
// that were true of the ranges before this and shouldn't have been:
//
//   1. a summit's position said WHICH event, never WHEN -- the landmark
//      set was rescaled to fill the tile, so the gaps between summits were
//      whatever the normalization made them;
//   2. a summit's width said how bright the event was, never how long it
//      lasted relative to the others;
//   3. the flanks were carved on a fixed spatial frequency, unrelated to
//      anything about the song, so the texture scrolled past at a rate no
//      music chose;
//   4. `attack` -- the one number that knows whether a landmark was a hit
//      with a tail or a build with a cut -- only ever set wL/wR, which
//      nothing downstream read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { ValueNoise1D } from '../src/utils/noise.js';
import {
  extractRidgePortrait, composeAlpinePeaks, layerLaps, layerTimeBase,
} from '../src/world/RidgePortrait.js';
import {
  ALPINE_CHARACTERS, pulseFor, phraseCyclesPerTile, alpineHeightField,
} from '../src/world/SilhouetteGenerator.js';
import {
  summitMass, pulseComb, couloirCarve, crenellation,
  ATTACK_FLANK_FLOOR, STEEP_WIDTH_MUL, SHALLOW_WIDTH_MUL,
} from '../src/world/RidgeShape.js';
import { medianBeatSec } from '../src/world/BiomeManager.js';

const WIDTH = 2048;
const BEAT_SEC = 60 / 128;
// The layer scroll rates BiomeManager hands over: 220 px/s through each
// layer's parallax ratio.
const RATE = { L2: 22, L3: 39.6, L4: 66, L5: 143 };

function curvesFrom(energyAt, { durationMs = 180000, shares = [1, 1, 0.8, 0.8, 0.6, 0.5, 0.4] } = {}) {
  const ec = new EnergyCurves(durationMs, 50);
  const tot = shares.reduce((a, b) => a + b, 0);
  for (let i = 0; i < ec.n; i++) {
    const e = energyAt(ec.n > 1 ? i / (ec.n - 1) : 0);
    ec.setFrame(i, shares.map((s) => Math.max(0, e * s / tot)));
  }
  return { ec, durationMs };
}

function bump(t, at, w, h) {
  const d = (t - at) / w;
  return h * Math.exp(-(d * d) * 4);
}

/** Five events at deliberately UNEVEN spacing: two close together early,
 *  then a long empty stretch, then a pair. The pacing is the thing under
 *  test, so it has to be a pacing no even subdivision would produce. */
function unevenSong() {
  return curvesFrom((t) => 0.12
    + bump(t, 0.08, 0.03, 0.55)
    + bump(t, 0.16, 0.03, 0.60)
    + bump(t, 0.62, 0.03, 0.95)
    + bump(t, 0.70, 0.03, 0.58)
    + bump(t, 0.88, 0.03, 0.62));
}

test('layerLaps: a tile stands for a whole number of traversals, never a fraction', () => {
  // A section shorter than the layer's own span still gets one lap -- the
  // far range simply drifts through it slowly.
  assert.equal(layerLaps(30, 93), 1);
  assert.equal(layerLaps(200, 93), 2);
  assert.equal(layerLaps(200, 31), 6);
  // Capped: past a point the summits fold over each other faster than they
  // can be told apart.
  assert.equal(layerLaps(4000, 14), 6);
  // No signal either way is one lap, never a divide-by-zero.
  assert.equal(layerLaps(0, 93), 1);
  assert.equal(layerLaps(93, 0), 1);
});

test('the four depths read the same song at four different scales', () => {
  const { ec, durationMs } = unevenSong();
  const portrait = extractRidgePortrait(ec, durationMs);
  const laps = ['L2', 'L3', 'L4', 'L5'].map((k) => (
    layerTimeBase(portrait, { pxPerSec: RATE[k] }, WIDTH).laps
  ));
  // Monotonic: the nearer the range, the faster it travels, so the less
  // music one tile of it can hold and the more laps it takes to show the
  // same window.
  for (let i = 1; i < laps.length; i++) {
    assert.ok(laps[i] >= laps[i - 1], `laps must not decrease with depth: ${laps}`);
  }
  assert.ok(laps[3] > laps[0], `near and far must differ in scale: ${laps}`);
});

test('summit spacing is event spacing: an uneven song makes an unevenly spaced range', () => {
  // A read short enough that one tile of the far massif holds all of it
  // (laps === 1), so the tile is the music, unfolded and unstretched --
  // the case the property is cleanest in.
  const { ec, durationMs } = curvesFrom((t) => 0.12
    + bump(t, 0.08, 0.035, 0.55)
    + bump(t, 0.18, 0.035, 0.60)
    + bump(t, 0.64, 0.035, 0.95)
    + bump(t, 0.74, 0.035, 0.58), { durationMs: 88000 });
  const portrait = extractRidgePortrait(ec, durationMs);
  const timeline = { pxPerSec: RATE.L2 };
  const { laps } = layerTimeBase(portrait, timeline, WIDTH);
  assert.equal(laps, 1, 'this read is meant to fit one traversal of the far range');

  const timed = composeAlpinePeaks({
    portrait, cfg: ALPINE_CHARACTERS.massif, layerKey: 'L2', seed: 11, width: WIDTH, timeline,
  });
  const wrap = (v) => ((v % 1) + 1) % 1;
  const circDist = (a, b) => {
    const d = Math.abs(wrap(a) - wrap(b));
    return Math.min(d, 1 - d);
  };
  const summitUs = timed.map((p) => p.x / WIDTH);
  const nearestTo = (u) => Math.min(...summitUs.map((s) => circDist(s, u)));

  // Every landmark has a summit standing on it -- and at the SAME offset
  // from the tile origin, since one lap of the tile is one pass of the
  // read. Slack allows for the layer phase, the per-biome slide and
  // collision relaxation, all of which move a summit a little.
  const sorted = portrait.landmarks.slice().sort((a, b) => a.t01 - b.t01);
  const shift = wrap(summitUs.reduce((best, s) => (
    circDist(s, sorted[0].t01) < circDist(best, sorted[0].t01) ? s : best
  ), summitUs[0]) - sorted[0].t01);
  for (const lm of sorted) {
    assert.ok(nearestTo(lm.t01 + shift) < 0.05,
      `no summit on the landmark at t=${lm.t01.toFixed(2)}: ${nearestTo(lm.t01 + shift)}`);
  }

  // And the gaps between those summits are the gaps between the events:
  // the pair 0.1 apart in the song sits far closer than the 0.46 crossing
  // the song's empty middle. Normalize-to-fill could not promise this --
  // it rescales whatever span the landmarks happen to occupy.
  const uAt = (t01) => {
    let best = summitUs[0];
    for (const s of summitUs) if (circDist(s, t01 + shift) < circDist(best, t01 + shift)) best = s;
    return best;
  };
  const close = circDist(uAt(sorted[0].t01), uAt(sorted[1].t01));
  const across = circDist(uAt(sorted[1].t01), uAt(sorted[2].t01));
  assert.ok(close < across * 0.5, `close events must stay close: ${close} vs ${across}`);
});

test('without a timeline the older normalize-to-fill placement is untouched', () => {
  const { ec, durationMs } = unevenSong();
  const portrait = extractRidgePortrait(ec, durationMs);
  const cfg = ALPINE_CHARACTERS.massif;
  const a = composeAlpinePeaks({ portrait, cfg, layerKey: 'L3', seed: 5, width: WIDTH });
  const b = composeAlpinePeaks({
    portrait, cfg, layerKey: 'L3', seed: 5, width: WIDTH, timeline: null,
  });
  assert.deepEqual(a.map((p) => Math.round(p.x)), b.map((p) => Math.round(p.x)));
  assert.equal(a.timeMap, null, 'no timeline means no time map to hang the spine on');
});

test('a long event is a wider mountain than a short one in the same range', () => {
  // One broad swell and one narrow stab, both loud, well apart.
  const { ec, durationMs } = curvesFrom((t) => 0.12
    + bump(t, 0.25, 0.11, 0.85)   // long
    + bump(t, 0.72, 0.02, 0.85)); // short
  const portrait = extractRidgePortrait(ec, durationMs);
  const long = portrait.landmarks.find((l) => l.t01 < 0.5);
  const short = portrait.landmarks.find((l) => l.t01 > 0.5);
  assert.ok(long && short, 'both events must be found as landmarks');
  assert.ok(long.width01 > short.width01 * 1.5, 'the long event must read as longer');

  const peaks = composeAlpinePeaks({
    portrait, cfg: ALPINE_CHARACTERS.range, layerKey: 'L3', seed: 9, width: WIDTH,
    timeline: { pxPerSec: RATE.L3 },
  });
  const { laps } = layerTimeBase(portrait, { pxPerSec: RATE.L3 }, WIDTH);
  const wrap = (v) => ((v % 1) + 1) % 1;
  const at = (t01) => {
    const u = wrap(t01 * laps);
    let best = peaks[0], bestD = 1;
    for (const p of peaks) {
      const d = Math.abs(p.x / WIDTH - u);
      const dd = Math.min(d, 1 - d);
      if (dd < bestD) { bestD = dd; best = p; }
    }
    return best;
  };
  assert.ok(at(long.t01).w > at(short.t01).w,
    'the mountain standing for the longer event must be the wider one');
});

test('a landmark against the edge of the read reports no attack rather than a maximal one', () => {
  // A window that opens mid-decay: the first landmark has no measurable
  // rise, which the raw ratio pins to exactly -1.
  const { ec, durationMs } = curvesFrom((t) => 0.9 - 0.7 * t + bump(t, 0.55, 0.05, 0.5));
  const portrait = extractRidgePortrait(ec, durationMs);
  for (const lm of portrait.landmarks) {
    assert.ok(Math.abs(lm.attack) <= 1, `attack out of range: ${lm.attack}`);
    if (lm.t01 < 0.05 || lm.t01 > 0.95) {
      assert.ok(Math.abs(lm.attack) < 0.5,
        `an unmeasurable edge landmark claimed a strong attack: ${lm.attack}`);
    }
  }
});

test('attack decides which face a summit shows, and only when it is decisive', () => {
  const w = 120;
  const sample = (peak) => {
    // How far up each flank the mountain still stands, 40px out. The steep
    // face is the narrower one, so it has fallen further by then.
    const left = summitMass(-40, peak, 1, null);
    const right = summitMass(40, peak, 1, null);
    return { left, right };
  };
  // A hit with a long tail: sudden onset, so the headwall faces the way
  // the viewer is coming from -- the earlier (left) side.
  const hit = sample({ x: 0, h: 1, w, attack: 0.9 });
  assert.ok(hit.left < hit.right, `a sudden onset must show its steep face early: ${JSON.stringify(hit)}`);
  // A build with a cut: the long ramp comes first, the cliff after.
  const build = sample({ x: 0, h: 1, w, attack: -0.9 });
  assert.ok(build.right < build.left, `a sudden cut must show its steep face late: ${JSON.stringify(build)}`);

  // Below the floor the range's own regional dip still governs, so a weak
  // reading cannot break the regional grain into per-peak randomness.
  const weak = ATTACK_FLANK_FLOOR * 0.9;
  const dipped = sample({ x: 0, h: 1, w, attack: -weak });
  const plain = sample({ x: 0, h: 1, w, attack: 0 });
  assert.deepEqual(dipped, plain, 'a weak attack must not overrule the regional dip');

  // And a peak carrying no attack at all is exactly the old behaviour:
  // dip +1 is steep-left, at the unmodified width multipliers.
  const legacy = sample({ x: 0, h: 1, w });
  assert.ok(legacy.left < legacy.right, 'dip +1 must still put the steep face left');
  assert.deepEqual(legacy, plain, 'attack 0 and no attack field must agree');
  assert.ok(STEEP_WIDTH_MUL < SHALLOW_WIDTH_MUL);
});

test('a summit is more lopsided the more emphatic the gesture was', () => {
  const peakAt = (attack) => {
    const p = { x: 0, h: 1, w: 120, attack };
    return summitMass(-40, p, 1, null);
  };
  // All of these put the steep face left, so the left sample falls further
  // the harder the attack.
  const mild = peakAt(0.4);
  const hard = peakAt(1);
  assert.ok(hard < mild, `a harder attack must carve a narrower headwall: ${hard} vs ${mild}`);
});

test('pulseComb is 1 on the beat, near nothing between, and exactly periodic', () => {
  const period = 40;
  assert.ok(Math.abs(pulseComb(0, period) - 1) < 1e-9);
  assert.ok(Math.abs(pulseComb(period, period) - 1) < 1e-9);
  assert.ok(Math.abs(pulseComb(period * 7, period) - 1) < 1e-9);
  assert.ok(pulseComb(period / 2, period) < 0.02, 'the off-beat must be nearly uncut');
  assert.equal(pulseComb(10, 0), 0, 'no period means no comb');
});

test('couloirs land on the beat grid and the grid divides the tile exactly', () => {
  const portrait = extractRidgePortrait(...Object.values(unevenSong()).slice(0, 1), 180000)
    || extractRidgePortrait(unevenSong().ec, 180000);
  const timeline = { pxPerSec: RATE.L4, beatSec: BEAT_SEC };
  const pulse = pulseFor(portrait, timeline, WIDTH, 'L4');
  assert.ok(pulse, 'a song with a tempo must produce a grid');
  // A whole number of beats per tile: the strip wraps forever, and a grid
  // that does not divide it stumbles at every seam.
  assert.equal(pulse.beatsPerTile, Math.round(pulse.beatsPerTile));
  assert.ok(Math.abs(pulse.periodPx * pulse.beatsPerTile - WIDTH) < 1e-6);
  // And it is the distance this layer travels in a beat, so a gully passes
  // the eye once per beat.
  assert.ok(Math.abs(pulse.periodPx - BEAT_SEC * RATE.L4) < pulse.periodPx * 0.15,
    `the grid must be a beat of travel: ${pulse.periodPx} vs ${BEAT_SEC * RATE.L4}`);

  // Far ranges are striped at bar scale, near ranges beat by beat.
  const far = pulseFor(portrait, { pxPerSec: RATE.L2, beatSec: BEAT_SEC }, WIDTH, 'L2');
  assert.ok(far.beatsPerTile < pulse.beatsPerTile,
    'the far massif must carry the coarser grain');

  // Free time has no grid at all, and falls back to fixed-frequency detail.
  assert.equal(pulseFor(portrait, { pxPerSec: RATE.L4, beatSec: 0 }, WIDTH, 'L4'), null);
});

test('a locked couloir actually cuts deeper on the beat than between beats', () => {
  const noise = new ValueNoise1D(21, 256);
  const pulse = { periodPx: 40 };
  let onBeat = 0, offBeat = 0;
  for (let k = 0; k < 24; k++) {
    onBeat += couloirCarve(noise, k * 40, 1, 1, 0.3, pulse);
    offBeat += couloirCarve(noise, k * 40 + 20, 1, 1, 0.3, pulse);
  }
  assert.ok(onBeat > offBeat * 1.5, `beats must carve deeper: ${onBeat} vs ${offBeat}`);
  // Unlocked (no pulse) the carve is the original noise-driven one and has
  // no preference for either phase.
  let plainOn = 0, plainOff = 0;
  for (let k = 0; k < 24; k++) {
    plainOn += couloirCarve(noise, k * 40, 1, 1, 0.3);
    plainOff += couloirCarve(noise, k * 40 + 20, 1, 1, 0.3);
  }
  assert.ok(Math.abs(plainOn - plainOff) < Math.max(plainOn, plainOff) * 0.7,
    'the unlocked carve must not favour a phase it knows nothing about');
});

test('crenellation grain follows the subdivision, and the default is unchanged', () => {
  const noise = new ValueNoise1D(33, 256);
  const zeroCrossings = (cellPx) => {
    let last = crenellation(noise, 0, 1, 0.2, cellPx), n = 0;
    for (let x = 1; x < 2000; x += 2) {
      const v = crenellation(noise, x, 1, 0.2, cellPx);
      if ((v < 0) !== (last < 0)) n++;
      last = v;
    }
    return n;
  };
  assert.ok(zeroCrossings(12) > zeroCrossings(60) * 1.5,
    'a fast subdivision must serrate the crest more finely than a slow one');
  // No cell given is byte-identical to the original fixed grain.
  assert.equal(crenellation(noise, 137, 1, 0.2), crenellation(noise, 137, 1, 0.2, 0));
});

test('the nearest hills roll once per phrase, not once per tile', () => {
  // A song with a clear repeating phrase.
  const { ec, durationMs } = curvesFrom((t) => 0.3 + 0.35 * Math.sin(t * 2 * Math.PI * 12));
  const portrait = extractRidgePortrait(ec, durationMs);
  assert.ok(portrait.phrasePeriod01 > 0, 'the loop must be detected at all');
  const cycles = phraseCyclesPerTile(portrait, { pxPerSec: RATE.L5 }, WIDTH);
  assert.ok(cycles >= 1);
  // The tile holds musicSecPerTile of song; the phrase lasts
  // phrasePeriod01 * windowSec. The count has to be that ratio, rounded.
  const { laps } = layerTimeBase(portrait, { pxPerSec: RATE.L5 }, WIDTH);
  const want = Math.round(1 / (laps * portrait.phrasePeriod01));
  assert.equal(cycles, Math.max(1, Math.min(10, want)));
  // No timeline: the old single stretched cycle per tile.
  assert.equal(phraseCyclesPerTile(portrait, null, WIDTH), 1);
});

test('the height field stays a mountain range with the timeline engaged', () => {
  const { ec, durationMs } = unevenSong();
  const portrait = extractRidgePortrait(ec, durationMs);
  const noise = new ValueNoise1D(4, 256);
  const n = 513, step = 4;
  for (const layerKey of ['L2', 'L3', 'L4']) {
    const h = alpineHeightField(
      noise, n, step, 42, WIDTH, 'range', portrait, layerKey, null,
      { pxPerSec: RATE[layerKey], beatSec: BEAT_SEC },
    );
    let min = 1, max = 0, sum = 0;
    for (const v of h) { min = Math.min(min, v); max = Math.max(max, v); sum += v; }
    // L2/L4 draw plateau formations, whose caprocks sit at each formation's
    // own height rather than at the field ceiling, so the bar is what a
    // range has to clear to read as a range at all -- not what an alpine
    // horn reaches.
    assert.ok(max > 0.62, `${layerKey}: summits must still reach: ${max}`);
    assert.ok(min < 0.45, `${layerKey}: valleys must still fall away: ${min}`);
    assert.ok(sum / n < 0.7, `${layerKey}: this is a range, not a plateau: ${sum / n}`);
    for (const v of h) assert.ok(v >= 0 && v <= 1, `${layerKey}: out of range ${v}`);
  }
});

test('medianBeatSec reads the grid, survives an odd bar, and gives up on free time', () => {
  const grid = [];
  for (let i = 0; i < 40; i++) grid.push({ ms: i * 2000, numerator: 4, denominator: 4 });
  // One mangled bar (a tempo-change window in a drift-aware grid).
  grid[20].ms += 900;
  const beat = medianBeatSec(grid);
  assert.ok(Math.abs(beat - 0.5) < 0.02, `expected a 0.5s beat, got ${beat}`);
  // 3/4 is read in three.
  const waltz = [];
  for (let i = 0; i < 20; i++) waltz.push({ ms: i * 1800, numerator: 3, denominator: 4 });
  assert.ok(Math.abs(medianBeatSec(waltz) - 0.6) < 0.02);
  // Free time has no grid at all.
  assert.equal(medianBeatSec([]), null);
  assert.equal(medianBeatSec(null), null);
});
