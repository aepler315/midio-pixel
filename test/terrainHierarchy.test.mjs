// Land dance along the ridge/drainage hierarchy (docs/landscape-dance.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTerrainHierarchy, danceDisplacement, landDanceRequest, sampleHierarchy, DRAIN_WAVELENGTH_M } from '../src/world/alpine/TerrainHierarchy.js';
import { landDance, landMotion, rangeMusicState, calibrateRangeMusic, sceneDeformation, heardBeats,
  RANGE_MOTION_REFERENCE_M, LAND_DANCE } from '../src/world/alpine/RangeFrame.js';
import { liftBounds } from '../src/world/alpine/MirrorScissor.js';
import { DEFORM_GLSL } from '../src/world/alpine/TerrainDeform.js';

// A range: a main valley running +x (draining to x = 0), side ridges
// between tributaries, a closed pit, and a flat valley floor.
const W = 121, H = 81, cell = 50;
function lattice() {
  const heights = new Float32Array(W * H);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const across = Math.abs(z - 40) * cell;
    const floor = 1000 + x * cell * .02 + across * .04;
    const flank = Math.max(0, across - 300) * .5 * (1 + .35 * Math.cos(x * cell * 2 * Math.PI / 1500));
    let h = floor + flank;
    if (Math.hypot(x - 90, z - 40) < 4) h -= 15; // a pit on the valley floor
    heights[z * W + x] = h;
  }
  return { width: W, height: H, cellXM: cell, cellZM: cell, heights };
}
const h = buildTerrainHierarchy(lattice());
const f = h.fields;

test('every cell drains to the lattice edge, pits included', () => {
  for (let i = 0; i < W * H; i++) {
    let j = i, steps = 0;
    while (f.down[j] >= 0 && steps++ < W * H) j = f.down[j];
    const x = j % W, z = (j - x) / W;
    assert.ok(x === 0 || z === 0 || x === W - 1 || z === H - 1, `cell ${i} ends inside at ${x},${z}`);
  }
  // The pit drains out downstream, through its filled rim.
  const pit = 40 * W + 90;
  assert.ok(f.filled[pit] > f.heights[pit] + 10);
});

test('the main valley is the highest drainage order and sits at zero relief', () => {
  const floor = 40 * W + 10;
  assert.equal(f.drainOrder[floor], h.stats.maxDrainOrder);
  assert.ok(h.stats.maxDrainOrder >= 2);
  assert.equal(f.hand[floor], 0);
  assert.equal(h.texture[floor * 4], 0, 'relief byte on the valley floor');
  // High flanks are well above their drainage.
  assert.ok(f.hand[5 * W + 60] > 100);
  assert.ok(h.texture[(5 * W + 60) * 4] > 128);
});

test('flow distance grows upstream and the wave runs downstream with the beat', () => {
  const up = 40 * W + 60, down = 40 * W + 20;
  assert.ok(f.distM[up] > f.distM[down]);
  // sin(k d + phase): the crest at distance d moves to d - delta when the
  // phase advances by k delta.
  const k = 2 * Math.PI / DRAIN_WAVELENGTH_M, delta = 300;
  const s = d => ({ relief: 1, spine: 0, cos: Math.cos(k * d), sin: Math.sin(k * d) });
  const music = phase => ({ spineM: 0, drainM: 10, drainPhaseRad: phase });
  for (const d of [0, 700, 1900]) {
    assert.ok(Math.abs(danceDisplacement(music(0), s(d)) - danceDisplacement(music(k * delta), s(d - delta))) < 1e-9);
  }
});

test('ridges rank the side spines and stay off the valley floor', () => {
  let onFloor = 0, high = 0;
  for (let x = 0; x < W; x++) { if (f.ridgeOrder[40 * W + x] && h.texture[(40 * W + x) * 4 + 1] > 0) onFloor++; }
  for (let i = 0; i < W * H; i++) if (h.texture[i * 4 + 1] > 200) high++;
  assert.equal(onFloor, 0);
  assert.ok(high > 0, 'some spine band at full order');
});

test('water and receivers never move, whatever the dance', () => {
  const music = { ...rangeMusicState({ env: { groove: 1, sustain: 1 } }), spineM: 30, spineGate01: .3, drainM: 18, drainPhaseRad: 1.1 };
  for (const s of [{ relief: 1, spine: 1, cos: .3, sin: -.9 }, { relief: .4, spine: .7, cos: 1, sin: 0 }]) {
    assert.equal(sceneDeformation(music, 10, 20, 1500, [1000, 2000], 0, s), 0);
    assert.notEqual(sceneDeformation(music, 10, 20, 1500, [1000, 2000], 1, s), sceneDeformation(music, 10, 20, 1500, [1000, 2000], 1));
  }
  // Relief 0 (valley floors, channels) pins the dance even off the water.
  assert.equal(danceDisplacement(music, { relief: 0, spine: 1, cos: 1, sin: 1 }), 0);
});

test('no dance leaves the land exactly as it was', () => {
  const land = landMotion(rangeMusicState({ env: { groove: .7 } }), .6, { tSec: 3 });
  assert.equal(landDance(land, { dance01: 0 }), land);
  assert.equal(sceneDeformation(land, 1, 2, 1500, [1000, 2000], 1, { relief: 1, spine: 1, cos: 1, sin: 1 }),
    sceneDeformation(land, 1, 2, 1500, [1000, 2000], 1));
});

test('full dance stays inside the calibrated motion reference', () => {
  const music = rangeMusicState({ env: { groove: 1, sustain: 1, scaleMul: 1.3, kickMul: 1 }, evaluatedKick01: 1, activity01: 1 });
  const danced = landDance(landMotion(music, 1), { dance01: 1, beats: 3.5 });
  assert.ok(danced.totalBoundM <= RANGE_MOTION_REFERENCE_M, `${danced.totalBoundM}`);
  assert.ok(danced.spineM > 0 && danced.drainM > 0);
  assert.ok(Math.abs(danced.drainPhaseRad - 2 * Math.PI * 3.5 / LAND_DANCE.beatsPerWave) < 1e-12);
  const quiet = landDance(landMotion(rangeMusicState({ env: { groove: .05 } }), 0), { dance01: 1 });
  assert.ok(quiet.spineGate01 > danced.spineGate01, 'quiet music gates to the highest ridge orders');
  const m = calibrateRangeMusic(danced, { depthM: 8000, heightRange: [1000, 3000] });
  assert.ok(Math.abs(m.spineM - danced.spineM * m.calibrationGain) < 1e-9);
  assert.ok(m.totalBoundM >= m.amplitudeM + m.structuralM + m.spineM + m.drainM - 1e-9);
});

test('beats come from the heard transport and stop in free time', () => {
  assert.equal(heardBeats({ periodMs: 500, anchorMs: 1000 }, 3000), 4);
  assert.equal(heardBeats({ periodMs: 500, anchorMs: 1000, freeTime: true }, 3000), null);
  assert.equal(heardBeats(null, 3000), null);
});

test('the lake mirror bounds the dance lift', () => {
  const u = { uDeformAmp: { value: 1 }, uDeformKick: { value: 0 }, uDeformStructural: { value: 0 }, uDeformMelodic: { value: 0 },
    uDeformGesture: { value: 0 }, uLandDance: { value: { x: 10, y: .5, z: 5, w: 0 } } };
  const without = liftBounds({ ...u, uLandDance: { value: { x: 0, y: 0, z: 0, w: 0 } } });
  const withDance = liftBounds(u);
  assert.ok(withDance.hi - without.hi >= 2 * (10 + 5 * Math.SQRT2) - 1e-9);
});

test('the GLSL dance matches its CPU twin and is skipped when still', () => {
  assert.match(DEFORM_GLSL, /if \(uLandDance\.x == 0\.0 && uLandDance\.z == 0\.0\) return 0\.0;/);
  assert.match(DEFORM_GLSL, /smoothstep\(uLandDance\.y - 0\.2, uLandDance\.y, hz\.g\)/);
  assert.match(DEFORM_GLSL, /hz\.r \* \(uLandDance\.x \* spine \* \(0\.35 \+ 0\.65 \* hz\.r\) \+ uLandDance\.z \* wave\)/);
  // The packed texel decodes the way the shader decodes it.
  const grid = { width: W, height: H, cellSizeM: cell, originM: [0, 0] };
  const s = sampleHierarchy(h, grid, 60 * cell, 5 * cell), i = (5 * W + 60) * 4;
  assert.equal(s.relief, h.texture[i] / 255);
  assert.equal(s.cos, (h.texture[i + 2] - 127.5) / 127.5);
});

test('the dance is on by default; ?landDance=0 opts out', () => {
  assert.equal(landDanceRequest(''), 1);
  assert.equal(landDanceRequest('?other=1'), 1);
  assert.equal(landDanceRequest('?landDance=0'), 0);
  assert.equal(landDanceRequest('?landDance=off'), 0);
  assert.equal(landDanceRequest('?landDance=.4'), .4);
  assert.equal(landDanceRequest('?landDance=7'), 1);
  assert.equal(landDanceRequest('?landDance=nope'), 1);
});

test('a ridge at any angle shapes the spine band, not the lattice directions', () => {
  // A single straight ridge at 30 degrees, falling off both sides.
  const W = 97, H = 97, cell = 60, slope = Math.tan(Math.PI / 6);
  const heights = new Float32Array(W * H);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const d = Math.abs((z - 48) - slope * (x - 48)) * Math.cos(Math.PI / 6) * cell;
    heights[z * W + x] = 2000 - .45 * d;
  }
  const r = buildTerrainHierarchy({ width: W, height: H, cellXM: cell, cellZM: cell, heights });
  // Per column, the spine's centre of mass sits on the true ridge line.
  let worst = 0;
  for (let x = 20; x < 77; x++) {
    let s = 0, m = 0;
    for (let z = 0; z < H; z++) { const v = r.fields.spine[z * W + x]; s += v; m += v * z; }
    if (s < .5) continue;
    worst = Math.max(worst, Math.abs(m / s - (48 + slope * (x - 48))));
  }
  assert.ok(worst < 1, `spine centre strays ${worst.toFixed(2)} cells from the ridge`);
});

test('the dance stays a breath: small share of the motion, barely any kick', () => {
  const loud = landDance(landMotion(rangeMusicState({ env: { groove: 1, sustain: 1, scaleMul: 1.3, kickMul: 1 }, evaluatedKick01: 1, activity01: 1 }), 1), { dance01: 1, beats: 0 });
  assert.ok((loud.spineM + loud.drainM) / RANGE_MOTION_REFERENCE_M <= .16, 'dance share of the motion reference');
  const still = landDance(landMotion(rangeMusicState({ env: {} }), 0), { dance01: 1 });
  const kicked = landDance(landMotion(rangeMusicState({ env: {}, evaluatedKick01: 1 }), 0), { dance01: 1 });
  assert.ok(kicked.spineM - still.spineM <= 2, `a lone kick lifts the spines ${kicked.spineM - still.spineM} m`);
  // A full wave takes at least four bars to pass.
  assert.ok(LAND_DANCE.beatsPerWave >= 16);
});
