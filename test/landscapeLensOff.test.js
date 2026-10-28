import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Simulation } from '../src/sim/Simulation.js';
import { Conductor } from '../src/core/Conductor.js';
import { ParamBus } from '../src/core/ParamBus.js';
import { synthesizeEnergyCurves } from '../src/core/EnergyCurvesSynth.js';
import { buildRangeFrame, viewportState } from '../src/world/alpine/RangeFrame.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { presentationCamera, stageZoomFor } from '../src/render/Renderer.js';
import { CameraDirector } from '../src/render/CameraDirector.js';

const neutral = { halfAngleScale: 1, zoomPulse: 0, cueIndex: -1 };
const sections = [
  { startMs: 0, endMs: 20000, role: 'verse', meanEnergy: .3, relEnergy01: .3, provenance: 'detected', confidence: .8 },
  { startMs: 20000, endMs: 40000, role: 'chorus', meanEnergy: .9, relEnergy01: .9, provenance: 'detected', confidence: .8 },
];
function simulation(experience = 'landscape') {
  const conductor = new Conductor();
  conductor.load({ timeline: [], durationMs: 40000, bpm: 120, barGrid: [] });
  const sim = new Simulation(conductor, new ParamBus(), { experience, songSeed: 315,
    energyCurves: synthesizeEnergyCurves([], 40000) });
  sim.biomes.sections = sections.map(section => ({ ...sim.biomes.sections[0], ...section }));
  sim.biomes.pumpStripPrewarm = () => {};
  return sim;
}

test('Landscape lens stays Off through trusted cues with a score and the sections-only fallback', () => {
  const sim = simulation();
  try {
    for (const fallback of [false, true]) {
      if (fallback) sim.biomes.energyCurves = null;
      for (const timeMs of [19800, 20000, 20300, 21000, 23000]) assert.deepEqual(sim._lensAt(timeMs), neutral);
    }
  } finally { sim.dispose(); }
});

test('Trio retains trusted accents in the scored and sections-only paths', () => {
  const sim = simulation('trio');
  try {
    assert.ok(sim._lensAt(20000).zoomPulse > .9);
    sim.biomes.energyCurves = null;
    assert.ok(sim._lensAt(20000).zoomPulse > .9);
  } finally { sim.dispose(); }
});

test('Landscape simulation supplies no automatic dip or tilt before scenic presentation and during arrival', () => {
  const sim = simulation();
  try {
    sim._lensAt(20000); // Prime the same analysis revision before the first update.
    sim.step(16, 20000);
    assert.equal(sim.camera.universeDip, 0);
    assert.equal(sim.camera.zoom, 1);
    assert.equal(sim.camera.floatTilt, 0);
    const camera = new CameraDirector();
    const lens = sim._lensAt(20000);
    camera.update(.016, 0, null, 0, lens.zoomPulse, lens.cueIndex);
    assert.equal(camera.roll, 0);
    for (const presentation of [null, { enabled: false }, { enabled: true, active: false },
      { enabled: true, active: true, arrival: .5 }, { enabled: true, active: true, arrival: 1 }]) {
      assert.equal(stageZoomFor(sim.camera, presentation), 1);
      assert.equal(presentationCamera(camera, presentation, sim.biomes).roll, 0);
    }
    camera.shake(10);
    camera.update(.016, 0, null, 0, lens.zoomPulse, lens.cueIndex);
    assert.notEqual(camera.roll, 0, 'impact roll remains available');
  } finally { sim.dispose(); }
});

test('Landscape frame keeps the final scenic FOV neutral while manual projection zoom still works', () => {
  const sim = simulation();
  const view = { id: 'lens-off', camera: { eyeStartM: [0, 1500, 20000], eyeEndM: [0, 1500, 20000],
    targetStartM: [0, 2500, 0], targetEndM: [0, 2500, 0], fovYDeg: 35 } };
  const scene = Object.assign(Object.create(RangeScene.prototype), { camera: new THREE.PerspectiveCamera(),
    prepared: new Map(), _movedPoses: new WeakMap(), _ensureTourWindow() {} });
  try {
    sim.heardTimeMs = 20000;
    const frame = buildRangeFrame({ frameId: 1, sim, pose: sim.lerpState(1),
      scenicViewport: viewportState({ logicalWidth: 1280, logicalHeight: 720 }) });
    assert.deepEqual(frame.performance.lens, neutral);
    scene._setCamera(view, { ...frame, cameraMove: null });
    assert.equal(scene.camera.fov, 35);
    const initial = scene.camera.projectionMatrix.toArray();
    const position = scene.camera.position.toArray();
    scene._setCamera(view, { ...frame, cameraMove: null, userCamera: { fx: .6, rx: .08, uy: -.04 } });
    assert.notDeepEqual(scene.camera.projectionMatrix.toArray(), initial, 'manual zoom changes projection');
    assert.deepEqual(scene.camera.position.toArray(), position, 'manual zoom keeps the geographic eye');
    scene._setCamera(view, { ...frame, cameraMove: null, userCamera: { fx: 0, rx: 0, uy: 0 } });
    assert.deepEqual(scene.camera.projectionMatrix.toArray(), initial);
    assert.ok(Object.values(frame.cameraMove).some(v => typeof v === 'number' && Math.abs(v) > 0), 'slow camera move remains scored');
  } finally { sim.dispose(); }
});
