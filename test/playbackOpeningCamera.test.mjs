import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { buildRangeFrame, viewportState } from '../src/world/alpine/RangeFrame.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { LerpCache } from '../src/utils/color.js';

test('a played song starts with a twenty-fourfold close-up in the rendered camera', () => {
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
  assert.equal(frame.rise01, 0, 'the real playback frame must carry the opening rise into the camera');
  scene._setCamera(view, frame);
  const magnification = scene.camera.projectionMatrix.elements[5] / ordinary.projectionMatrix.elements[5];
  assert.ok(Math.abs(magnification - 24) < 1e-10, `played opening magnification was ${magnification}`);
});
