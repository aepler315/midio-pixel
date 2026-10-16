// The baked Teton pass, read at the size The Range draws it.
// Logical stage is 1280×720 with the ground at 625. L2 is one 8192×400
// strip at amplitude 0.50. Each full window is one screen of that strip.
// The crest line is the check; a screenshot is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileUnits } from '../src/world/terrain/TerrainProfile.js';
import { alpineTerrainProfiles } from '../src/world/terrain/loadTerrain.js';
import {
  TERRAIN_STRIP_WIDTH, bakedCrest, crestRimAlpha, heightAboveFoot, prominentPeaks, viewRelief,
} from '../src/world/terrain/StripRead.js';
import { layerBake } from '../src/world/WorldMaterial.js';
import {
  mountainStripDrawHeight, orogenyHeightMul, pullbackHeightMul,
} from '../src/world/MountainChoreo.js';

const STAGE_W = 1280;
const STAGE_H = 720;
const GROUND_Y = 625;

function drawn(layerKey) {
  const bake = layerBake('alpine', layerKey);
  const units = profileUnits(alpineTerrainProfiles()[layerKey]);
  const crest = bakedCrest({
    units, width: TERRAIN_STRIP_WIDTH,
    height: bake.height, amplitude: bake.amplitude, baseline: bake.baseline,
  });
  const at = (g, p) => {
    const mul = orogenyHeightMul(layerKey, g) * pullbackHeightMul(layerKey, p);
    const dh = mountainStripDrawHeight(bake.height, mul, STAGE_H, GROUND_Y);
    return heightAboveFoot(crest.ridgeYs, bake.height, dh);
  };
  return { bake, crest, at };
}

test('a scanned ridge does not get the full neon rim', () => {
  assert.equal(crestRimAlpha(1, true), 0.4);
  assert.equal(crestRimAlpha(0.35, true), 0.35);
  assert.equal(crestRimAlpha(1, false), 1);
});

test('alpine L2 is drawn as an 8192×400 strip at amplitude 0.50', () => {
  const bake = layerBake('alpine', 'L2');
  assert.equal(TERRAIN_STRIP_WIDTH, 8192);
  assert.equal(bake.height, 400);
  assert.equal(bake.amplitude, 0.5);
  assert.equal(bake.baseline, 0.44);
  assert.equal(bake.profile, 'alpine');
  const dh = mountainStripDrawHeight(bake.height, 1, STAGE_H, GROUND_Y);
  assert.equal(dh, 400, 'on the 720 stage the far strip is not capped further');
});

test('the Teton crest reads as a skyline along the pass, not one flat frame', () => {
  const { crest, at } = drawn('L2');
  const above = at(0, 0);
  let max = -Infinity;
  let maxI = 0;
  let nearTop = 0;
  for (let i = 0; i < above.length; i++) {
    if (above[i] > max) { max = above[i]; maxI = i; }
    if (crest.ridgeYs[i] < 4) assert.fail(`crest leaves the strip at ${i}`);
  }
  for (let i = 0; i < above.length; i++) if (above[i] > max - 4) nearTop++;
  const peaks = prominentPeaks(above, 12);
  const summit = peaks.find((pk) => pk.i === maxI) || peaks.find((pk) => Math.abs(pk.i - maxI) <= 2);
  assert.ok(summit, 'the highest sample is a summit, not a shelf');
  assert.ok(summit.prom >= 60, `summit prominence ${summit.prom.toFixed(0)}px is too low to read`);
  assert.ok(nearTop < 20, `${nearTop} samples sit on the top — that is a clip, not a peak`);
  assert.ok(peaks.length >= 4 && peaks.length <= 24, `expected a range of summits, got ${peaks.length}`);
  const summitX = maxI * crest.step;
  assert.ok(summitX > TERRAIN_STRIP_WIDTH * 0.25 && summitX < TERRAIN_STRIP_WIDTH * 0.75,
    `summit at ${summitX}px is an end-hold, not a crest`);

  const windows = viewRelief(above, { step: crest.step, stripWidth: crest.width, view: STAGE_W });
  const full = windows.filter((w) => w.full);
  assert.ok(full.length >= 6, `the pass covers ${full.length} screens`);
  const reliefs = full.map((w) => w.relief);
  const lo = Math.min(...reliefs);
  const hi = Math.max(...reliefs);
  for (const w of full) {
    assert.ok(w.relief >= 20, `screen at ${w.x0}px is flat (${w.relief.toFixed(0)}px)`);
  }
  assert.ok(hi >= lo * 1.5, `every screen looks the same (${lo.toFixed(0)}..${hi.toFixed(0)}px)`);
  const summitView = full.find((w) => summitX >= w.x0 && summitX < w.x1);
  assert.ok(summitView.relief === hi, 'the summit screen is where the skyline opens up');
});

test('the eastern range stays shorter than the Teton crest at every draw size', () => {
  const far = drawn('L2');
  const near = drawn('L4');
  assert.equal(near.bake.height, 330);
  assert.equal(near.bake.amplitude, 0.32);
  assert.ok(near.bake.height < far.bake.height);
  // Rest, full orogeny, full pull-back, and both. Pull-back grows L4 more,
  // and full orogeny caps L2 on the frame, so those are the corners where
  // a shorter range could catch up.
  for (const [g, p] of [[0, 0], [0.1, 0], [1, 0], [0, 1], [1, 1]]) {
    const a = far.at(g, p);
    const b = near.at(g, p);
    let farMax = -Infinity;
    let nearMax = -Infinity;
    for (let i = 0; i < a.length; i++) {
      if (a[i] > farMax) farMax = a[i];
      if (b[i] > nearMax) nearMax = b[i];
    }
    const mid = (vals) => [...vals].sort((x, y) => x - y)[Math.floor(vals.length / 2)];
    const nearMed = mid(b);
    const farMed = mid(a);
    assert.ok(nearMax < farMax,
      `at growth ${g} pullback ${p}, eastern summit ${nearMax.toFixed(0)}px reaches the Teton summit ${farMax.toFixed(0)}px`);
    assert.ok(nearMed < farMed,
      `at growth ${g} pullback ${p}, eastern midline ${nearMed.toFixed(0)}px is not below the crest ${farMed.toFixed(0)}px`);
  }
});
