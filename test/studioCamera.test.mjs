import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_FIELDS, CAMERA_PRESETS, defaultCamera, normalizeCamera, cameraAt,
  sampleHeight, analyzeCamera, randomizeCamera, improveCamera,
} from '../src/studio/CameraEditor.js';

const flat = (height = 0) => ({ west: -0.1, south: -0.1, east: 0.1, north: 0.1,
  width: 9, height: 9, heightsM: new Float32Array(81).fill(height), cellM: 2400 });
const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≠ ${expected}`);

// Catches absent input validation, incorrect compass wrapping and discarded source camera coordinates.
test('camera defaults preserve geographic source cameras and reject nonfinite controls', () => {
  const candidate = { camera: { eye: { lon: -110.8, lat: 43.7, heightM: 2600 },
    target: { lon: -110.7, lat: 43.8, heightM: 3100 }, headingDeg: 32, pitchDeg: 4, hfovDeg: 55 } };
  const defaults = defaultCamera(candidate);
  assert.equal(defaults.lon, -110.8);
  assert.equal(defaults.lat, 43.7);
  assert.equal(defaults.heightM, 2600);
  assert.equal(defaults.targetLon, -110.7);
  const source = { ...defaults, headingDeg: -90, pitchDeg: 500, hfovDeg: NaN,
    durationSec: Infinity, aboveGroundM: -10, lon: NaN, motionAmount: 9 };
  const normalized = normalizeCamera(source, candidate);
  assert.equal(normalized.headingDeg, 270);
  assert.equal(normalized.lon, -110.8);
  assert.ok(normalized.aboveGroundM > 0);
  assert.ok(normalized.pitchDeg <= 60);
  assert.ok(normalized.motionAmount <= 1);
  for (const field of CAMERA_FIELDS) assert.ok(Number.isFinite(normalized[field.key]), field.key);
  assert.ok(Number.isNaN(source.lon));
  for (const preset of Object.values(CAMERA_PRESETS)) {
    assert.ok(Number.isFinite(cameraAt(normalizeCamera(preset)).headingDeg));
  }
});

// Catches flipped north/south grids, edge extrapolation and accidental filling through terrain holes.
test('height sampling is north-up cell-centred bilinear and preserves missing terrain', () => {
  const grid = { west: 0, south: 0, east: 2, north: 2, width: 2, height: 2, heightsM: [100, 200, 300, 400] };
  assert.equal(sampleHeight(grid, 0.5, 1.5), 100);
  assert.equal(sampleHeight(grid, 1, 1), 250);
  assert.equal(sampleHeight(grid, 0, 2), 100);
  assert.ok(Number.isNaN(sampleHeight(grid, -0.1, 1)));
  grid.heightsM[3] = NaN;
  assert.equal(sampleHeight(grid, 0.5, 1.5), 100);
  assert.ok(Number.isNaN(sampleHeight(grid, 1, 1)));
  assert.ok(Number.isNaN(sampleHeight(null, 0, 0)));
});

// Catches travel in the wrong compass direction, progress overflow and motion that survives the zero control.
test('camera motion starts at the edited position, travels forward and cranes smoothly', () => {
  const settings = normalizeCamera({ lon: 0, lat: 0, headingDeg: 90, aboveGroundM: 100,
    travelM: 1000, craneM: 80, orbitDeg: 0, motionAmount: 1 });
  close(cameraAt(settings, 0).eye.lon, 0);
  close(cameraAt(settings, 1).eye.lon, 1000 / 111320);
  close(cameraAt(settings, 1).eye.aboveGroundM, 180);
  assert.deepEqual(cameraAt(settings, 2), cameraAt(settings, 1));
  assert.deepEqual(cameraAt(settings, -1), cameraAt(settings, 0));
  const still = { ...settings, orbitDeg: 35, motionAmount: 0 };
  assert.deepEqual(cameraAt(still, 1), cameraAt(still, 0));
});

// Catches treating a target bearing as a fixed heading and failing to account for DEM elevation.
test('target aiming tracks a fixed geographic subject through an orbit', () => {
  const grid = flat(500);
  const settings = normalizeCamera({ lon: 0, lat: 0, aboveGroundM: 100,
    targetLon: 0.01, targetLat: 0, targetHeightM: 100, aimMode: 'target',
    headingDeg: 90, orbitDeg: 30, travelM: 0, craneM: 0, motionAmount: 1 });
  const start = cameraAt(settings, 0, grid), end = cameraAt(settings, 1, grid);
  close(start.headingDeg, 90);
  close(start.pitchDeg, 0);
  close(start.eye.heightM, 600);
  assert.ok(Math.abs(end.headingDeg - start.headingDeg) > 20);
  close(end.pitchDeg, 0);
  close(Math.hypot(end.eye.lon - 0.01, end.eye.lat), 0.01, 0.00002);
});

// Catches losing authored absolute height and creating an underground preview over a coarse DEM.
test('authored absolute heights stay intact when possible and get a measured ground fallback', () => {
  const settings = normalizeCamera({ lon: 0, lat: 0, heightM: 1500, aboveGroundM: 100, motionAmount: 0 });
  assert.equal(cameraAt(settings, 0, flat(1000)).eye.heightM, 1500);
  assert.ok(cameraAt(settings, 0, flat(1600)).eye.heightM > 1600);
  assert.ok(analyzeCamera(settings, flat(1600)).warnings.some(w => /height|clearance|ground/i.test(w)));
});

// Catches unseeded randomness, ignored locks and randomization at zero strength.
test('randomization is deterministic, broad, bounded and respects independent field locks', () => {
  const original = normalizeCamera({ lon: 0, lat: 0, headingDeg: 140, hfovDeg: 58, aboveGroundM: 300 });
  const options = { seed: 'teton-42', strength: 0.75, locks: ['lon', 'headingDeg', 'hfovDeg'] };
  const first = randomizeCamera(original, options);
  assert.deepEqual(first, randomizeCamera(original, options));
  assert.notDeepEqual(first.settings, randomizeCamera(original, { ...options, seed: 'teton-43' }).settings);
  assert.equal(first.settings.lon, 0);
  assert.equal(first.settings.headingDeg, 140);
  assert.equal(first.settings.hfovDeg, 58);
  assert.ok(CAMERA_FIELDS.filter(f => first.settings[f.key] !== original[f.key]).length >= 5);
  assert.deepEqual(randomizeCamera(original, { strength: 0 }).settings, original);
  assert.equal(original.headingDeg, 140);
  assert.ok(first.report.changes.length > 0);
  assert.ok(first.report.score >= 0 && first.report.score <= 100);
});

// Catches claims of good framing on all-sky views and unreported missing DEM coverage.
test('analysis distinguishes sky-heavy framing, unsafe crane and unmeasured terrain', () => {
  const grid = flat();
  const bad = normalizeCamera({ lon: 0, lat: 0, aboveGroundM: 20, pitchDeg: 55,
    craneM: -500, motionAmount: 1, travelM: 0, orbitDeg: 0 });
  const analysis = analyzeCamera(bad, grid);
  assert.ok(analysis.warnings.some(w => /sky|horizon/i.test(w)));
  assert.ok(analysis.warnings.some(w => /clearance|ground/i.test(w)));
  assert.ok(analysis.metrics.skyFraction > 0.8);
  assert.ok(analysis.metrics.minClearanceM < 0);
  assert.ok(analyzeCamera(bad).warnings.some(w => /terrain|unmeasured/i.test(w)));
  grid.heightsM.fill(NaN);
  assert.ok(analyzeCamera(bad, grid).warnings.some(w => /coverage|missing|terrain/i.test(w)));
});

// Catches a randomizer moving off available DEM and a repair that ignores the terrain subject.
test('terrain suggestions select an actual summit and keep a sampled motion route covered', () => {
  const grid = flat(200);
  grid.heightsM[2 * 9 + 6] = 2200;
  const original = normalizeCamera({ lon: -0.07, lat: -0.07, aboveGroundM: 2,
    pitchDeg: 55, headingDeg: 220, travelM: 15000, craneM: -1000, orbitDeg: 50, motionAmount: 1 });
  const improved = improveCamera(original, { grid });
  assert.ok(improved.report.score > analyzeCamera(original, grid).score);
  assert.ok(improved.report.changes.length > 0);
  assert.equal(improved.settings.aimMode, 'target');
  assert.ok(sampleHeight(grid, improved.settings.targetLon, improved.settings.targetLat) > 1000);
  const randomized = randomizeCamera(improved.settings, { grid, seed: 6, strength: 0.9 });
  for (let n = 0; n <= 16; n++) {
    const pose = cameraAt(randomized.settings, n / 16, grid);
    assert.ok(Number.isFinite(sampleHeight(grid, pose.eye.lon, pose.eye.lat)), `uncovered sample ${n}`);
    assert.ok(pose.eye.heightM - sampleHeight(grid, pose.eye.lon, pose.eye.lat) >= 12);
  }
  const locked = improveCamera(original, { grid, locks: ['pitchDeg', 'aboveGroundM', 'craneM', 'aimMode'] });
  assert.equal(locked.settings.pitchDeg, original.pitchDeg);
  assert.equal(locked.settings.aboveGroundM, original.aboveGroundM);
  assert.equal(locked.settings.craneM, original.craneM);
  assert.equal(locked.settings.aimMode, original.aimMode);
  assert.ok(locked.report.warnings.length > 0);
});

// Catches malformed catalog target metadata leaking NaN into otherwise valid project documents.
test('partial or malformed source targets cannot create nonfinite camera defaults', () => {
  for (const target of [{ lon: NaN }, { lat: Infinity }, { lon: 12 }, {}]) {
    const candidate = { camera: { eye: { lon: 0, lat: 0 }, target } };
    for (const value of [defaultCamera(candidate), normalizeCamera({}, candidate)]) {
      for (const field of CAMERA_FIELDS) assert.ok(Number.isFinite(value[field.key]), field.key);
    }
  }
});

// Catches interpreting absolute authored eye altitude as target-relative height without a DEM.
test('target mode without terrain uses the authored eye clearance as its relative datum', () => {
  const camera = cameraAt({ lon: 0, lat: 0, heightM: 1800, aboveGroundM: 100,
    targetLon: 0.01, targetLat: 0, targetHeightM: 100, aimMode: 'target', motionAmount: 0 });
  close(camera.headingDeg, 90);
  close(camera.pitchDeg, 0);
});

// Catches an inherited absolute source eye silently overriding an edited above-ground slider.
test('explicit above-ground edits replace authored absolute height during normalization', () => {
  const candidate = { camera: { eye: { lon: 0, lat: 0, heightM: 1800 } } };
  assert.equal(defaultCamera(candidate).heightM, 1800);
  const edited = normalizeCamera({ ...defaultCamera(candidate), heightM: null, aboveGroundM: 250 }, candidate);
  assert.equal(Object.hasOwn(edited, 'heightM'), false);
  assert.equal(cameraAt(edited, 0, flat(1000)).eye.heightM, 1250);
  const partial = normalizeCamera({ aboveGroundM: 300 }, candidate);
  assert.equal(Object.hasOwn(partial, 'heightM'), false);
});

// Catches tangent wraparound incorrectly calling an entirely missing sight line terrain-filled.
test('a camera with an absolute height still reports all sky when every terrain sample is missing', () => {
  const grid = flat();
  grid.heightsM.fill(NaN);
  const analysis = analyzeCamera({ lon: 0, lat: 0, heightM: 1500, pitchDeg: 45, motionAmount: 0 }, grid);
  assert.equal(analysis.metrics.skyFraction, 1);
  assert.equal(analysis.metrics.terrainCoverage, 0);
});

// Catches selecting a taller hidden summit when a visible foreground ridge is available.
test('terrain improvement prefers a visible ridge over an occluded higher summit', () => {
  const grid = flat(0);
  grid.heightsM[4 * 9 + 4] = 1800;
  grid.heightsM[2 * 9 + 6] = 2200;
  const settings = normalizeCamera({ lon: -0.08, lat: -0.08, aboveGroundM: 120,
    headingDeg: 45, pitchDeg: 45, motionAmount: 0 });
  const result = improveCamera(settings, { grid });
  assert.equal(result.report.metrics.targetVisible, true);
  close(result.settings.targetLon, 0);
  close(result.settings.targetLat, 0);
});

// Catches perspective tangent wraparound for terrain that lies more than 90 degrees below the aim.
test('steep upward cameras do not wrap ground behind the view into the frame', () => {
  const grid = { ...flat(), west: -0.001, south: -0.001, east: 0.001, north: 0.001, cellM: 25 };
  const analysis = analyzeCamera({ lon: 0, lat: 0, aboveGroundM: 6000, pitchDeg: 60, motionAmount: 0 }, grid);
  assert.equal(analysis.metrics.skyFraction, 1);
});
