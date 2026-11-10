import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { buildRangeFrame, viewportState } from '../src/world/alpine/RangeFrame.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { LerpCache } from '../src/utils/color.js';
import { LAND_RISE_START } from '../src/world/alpine/LandRise.js';
import { landRiseFov } from '../src/world/alpine/LandRiseCamera.js';

test('a played song opens on the land-rise close-up in the rendered camera and releases it within five seconds', () => {
  const profile = { name: 'RAINFOREST', sky: ['#102030', '#304050', '#607080'] };
  const sim = { heardTimeMs: 0, songSeed: 42, stageW: 1280, perf: { level: 0 },
    biomes: { tSec: 0, durationMs: 180000, terrainPreview: false, sections: [],
      energyCurves: { globalEnergyNorm: () => .5 }, world: { response: null },
      currentBlend: { from: profile.name, to: profile.name, t: 1 },
      _profile: () => profile, _rotated: color => color, lerpCache: new LerpCache(), _airColor: '#556677' } };
  const viewport = viewportState({ logicalWidth: 1280, logicalHeight: 720,
    backingWidth: 640, backingHeight: 360 });
  const frame = buildRangeFrame({ frameId: 1, sim, pose: { worldX: 0, midioX: 400 },
    scenicViewport: viewport, groundViewport: viewport });
  const view = { id: 'played-opening', camera: { eyeStartM: [0, 1500, 10000], eyeEndM: [0, 1500, 10000],
    targetStartM: [0, 2200, 0], targetEndM: [0, 2200, 0], fovYDeg: 35 } };
  const scene = Object.assign(Object.create(RangeScene.prototype), {
    prepared: new Map(), _movedPoses: new WeakMap(), camera: new THREE.PerspectiveCamera(),
    _ensureTourWindow() {} });
  const ordinary = new THREE.PerspectiveCamera(35, 1280 / 720);
  assert.equal(frame.timeMs, 0);
  assert.equal(frame.rise01, LAND_RISE_START, 'the real playback frame must carry the opening rise into the camera');
  scene._setCamera(view, frame);
  const magnification = scene.camera.projectionMatrix.elements[5] / ordinary.projectionMatrix.elements[5];
  // The land starts one third built, so the terrain-safe close-up is about 3x.
  const expected = Math.tan(35 * Math.PI / 360) / Math.tan(landRiseFov(35, LAND_RISE_START, 0) * Math.PI / 360);
  assert.ok(Math.abs(magnification - expected) < 1e-9 && magnification > 2, `played opening magnification was ${magnification}`);
  // Six seconds in the land is still low, but the opening has let the lens go.
  sim.heardTimeMs = 6000; sim.biomes.tSec = 6;
  const later = buildRangeFrame({ frameId: 2, sim, pose: { worldX: 0, midioX: 400 }, scenicViewport: viewport, groundViewport: viewport });
  assert.ok(later.rise01 < .5, `the land keeps building (${later.rise01})`);
  scene._movedPoses = new WeakMap();
  scene._setCamera(view, later);
  const after = scene.camera.projectionMatrix.elements[5] / ordinary.projectionMatrix.elements[5];
  assert.ok(Math.abs(after - 1) < 1e-9, `authored lens after the opening (was ${after})`);
});
