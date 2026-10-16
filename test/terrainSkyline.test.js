import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apparentAngle, scanCorridor, smoothBaseline, pointAlong,
} from '../src/world/terrain/SkylineScan.js';
import {
  buildProfile, profileUnits, sampleProfile, profileChunks, profileFromDem, rangeLayerProfiles,
  compositeLayerProfiles, profilesToJSON, profilesFromJSON,
} from '../src/world/terrain/TerrainProfile.js';
import { resolveStripHeights, layoutRidgeYs } from '../src/world/SilhouetteGenerator.js';

// A straight crest at x = 0, camera 80 km to the east. A lower ridge stands
// between them. The traced crest is the tall mountain. The skyline is not.
function frontDem() {
  const cellM = 1000;
  const width = 81;
  const height = 21;
  const elev = new Float64Array(width * height);
  elev.fill(1500);
  elev[10 * width + 0] = 4000;   // crest, 80 km from the camera
  elev[10 * width + 55] = 3000;  // nearer ridge, 25 km from the camera
  return {
    elev, width, height, cellM, originX: 0, originY: 0,
  };
}

const GUIDE = [{ x: 0, y: 0 }, { x: 0, y: 20000 }];

function scanFront(extra = {}) {
  return scanCorridor(frontDem(), GUIDE, {
    distanceM: 80000,
    cameraElevM: 1800,
    side: -1,
    spacingM: 5000,
    pastM: 2000,
    smoothWindowM: 0,
    ...extra,
  });
}

test('the skyline is the highest angle, not the highest elevation', () => {
  const scan = scanFront();
  const atSummit = 2; // y = 10000
  assert.equal(scan.crestElevM[atSummit], 4000);
  assert.equal(scan.skylineElevM[atSummit], 3000);
  assert.ok(scan.skylineDistM[atSummit] < 40000, 'the winning terrain is the nearer ridge');
  assert.ok(scan.skylineAngle[atSummit] > apparentAngle(4000, 1800, 80000, false));
});

test('isolating the guide drops the foreground ridge out of the skyline', () => {
  const scan = scanFront({ isolateBandM: 8000 });
  assert.equal(scan.skylineElevM[2], 4000);
  assert.ok(scan.skylineDistM[2] > 70000);
});

test('curvature lowers a distant crest and does not move the camera onto the summits', () => {
  const far = apparentAngle(4000, 1800, 80_000, false);
  const curved = apparentAngle(4000, 1800, 80_000, true);
  assert.ok(curved < far);
  const plain = scanFront();
  const withCurve = scanFront({ curvature: true });
  assert.ok(withCurve.skylineAngle[2] < plain.skylineAngle[2]);
});

test('a zigzag guide is not stretched to its own arc length', () => {
  // 22 km of walking, about 2 km of net progress. The camera follows the
  // broad direction, so the profile is the short one.
  const guide = [
    { x: 0, y: 0 },
    { x: 0, y: 10000 },
    { x: 1000, y: 10000 },
    { x: 1000, y: 0 },
    { x: 2000, y: 0 },
  ];
  const dem = frontDem();
  const scan = scanCorridor(dem, guide, {
    distanceM: 5000,
    cameraElevM: 1800,
    side: -1,
    spacingM: 500,
    pastM: 1000,
    smoothWindowM: 30000,
  });
  assert.ok(scan.guideLengthM > 20000);
  assert.ok(scan.baselineLengthM < scan.guideLengthM * 0.75,
    `baseline ${scan.baselineLengthM} should be well under the walked crest ${scan.guideLengthM}`);
});

test('profile scale is the whole range, and a window does not tile or re-stretch', () => {
  const profile = profileFromDem(frontDem(), GUIDE, {
    distanceM: 80000,
    cameraElevM: 1800,
    side: -1,
    spacingM: 5000,
    pastM: 2000,
    smoothWindowM: 0,
  }, { name: 'front' });
  const units = profileUnits(profile);
  const summit = units[2];
  assert.ok(summit > 0.5, 'the occluding ridge is the tall angle in this corridor');
  // A chunk that is only the quiet end of the range stays quiet.
  const quiet = sampleProfile(profile, 0, 1, profile.spacingM);
  assert.ok(quiet[0] < summit);
  const past = sampleProfile(profile, profile.spacingM * 100, 2, profile.spacingM);
  const end = sampleProfile(profile, profile.spacingM * (units.length - 1), 1, profile.spacingM);
  assert.equal(past[0], end[0]);
  assert.equal(past[1], end[0]);
});

test('profile JSON preserves a missing skyline sample', () => {
  const profile = {
    version: 1, kind: 'skyline', spacingM: 400,
    angleMin: -1, angleMax: 1,
    angles: Float64Array.from([-1, NaN, 1]),
    crestElevM: Float64Array.from([2000, NaN, 3000]),
    skylineElevM: Float64Array.from([2000, NaN, 3000]), meta: {},
  };
  const encoded = JSON.parse(JSON.stringify(profilesToJSON({ L2: profile })));
  const decoded = profilesFromJSON(encoded).L2;
  assert.deepEqual([...profileUnits(decoded)], [...profileUnits(profile)]);
  assert.equal(Number.isNaN(decoded.angles[1]), true);
  assert.equal(Number.isNaN(decoded.crestElevM[1]), true);
});

test('profile JSON rejects a layer with no observed skyline samples', () => {
  assert.throws(() => profilesFromJSON({
    version: 1,
    layers: {
      L2: { spacingM: 10, angleMin: 0, angleMax: 1, angles: [null, null], crestElevM: [] },
    },
  }), /no finite samples/);
});

test('a finite flat skyline stays drawable at mid-height', () => {
  const profile = {
    version: 1, kind: 'skyline', spacingM: 400,
    angleMin: 0.2, angleMax: 0.2,
    angles: Float64Array.from([0.2, 0.2]),
    crestElevM: Float64Array.from([2000, 2000]),
    skylineElevM: Float64Array.from([2000, 2000]), meta: {},
  };
  assert.deepEqual([...profileUnits(profile)], [0.5, 0.5]);
});

test('consecutive chunks overlap on the same source samples', () => {
  const starts = profileChunks(11, { chunk: 4, overlap: 1 });
  assert.deepEqual(starts, [0, 3, 6, 7]);
  assert.equal(starts[starts.length - 1] + 4, 11);
});

test('a real profile is not blended into a tile, and a foothill is not stretched', () => {
  const src = [0.05, 0.2, 0.55, 0.9];
  const heights = resolveStripHeights(4, src, () => {
    throw new Error('procedural skyline must not run for a supplied profile');
  });
  assert.ok(Math.abs(heights[3] - 0.9) < 1e-6);
  assert.ok(heights[3] > heights[0]);

  // Both of these overflow the strip, so the procedural refit pulls each
  // tile's own tallest sample to the same headroom line — a foothill
  // window becomes as tall as the summit window. The terrain path keeps
  // the 0.12 ratio from the whole profile.
  const opts = { height: 320, footY: 176, hanging: false, amplitude: 5, profile: 'alpine' };
  const hill = new Float32Array([0.12, 0.12, 0.12, 0.12]);
  const peak = new Float32Array([1, 1, 1, 1]);
  const hillKept = layoutRidgeYs(hill, { ...opts, preserveScale: true });
  const peakKept = layoutRidgeYs(peak, { ...opts, preserveScale: true });
  const hillThrow = 176 - hillKept.ridgeYs[0];
  const peakThrow = 176 - peakKept.ridgeYs[0];
  assert.ok(Math.abs(hillThrow / peakThrow - 0.12) < 1e-6);
  const hillFit = layoutRidgeYs(hill, { ...opts, preserveScale: false });
  const peakFit = layoutRidgeYs(peak, { ...opts, preserveScale: false });
  assert.ok(Math.abs(hillFit.ridgeYs[0] - peakFit.ridgeYs[0]) < 1);
});

test('smoothBaseline of a straight guide stays on that guide', () => {
  const pts = [{ x: 0, y: 0 }, { x: 0, y: 10000 }];
  const smooth = smoothBaseline(pts, 4000);
  for (const p of smooth) assert.ok(Math.abs(p.x) < 1, `left the guide: ${p.x}`);
  const mid = pointAlong(pts, 5000);
  assert.equal(mid.y, 5000);
});

function threeRidgeDem() {
  const cellM = 1000;
  const width = 81;
  const height = 21;
  const elev = new Float64Array(width * height);
  elev.fill(1000);
  elev[10 * width + 0] = 4000;  // far, 80 km, the traced crest
  elev[10 * width + 35] = 2200; // middle, 45 km
  elev[10 * width + 65] = 1200; // near, 15 km
  return { elev, width, height, cellM, originX: 0, originY: 0 };
}

test('two authored guides keep their own shape, and the far crest subtends more', () => {
  const width = 81;
  const height = 11;
  const elev = new Float64Array(width * height);
  elev.fill(1500);
  for (let y = 0; y < height; y++) {
    elev[y * width + 5] = 4000;
    elev[y * width + 55] = 2500;
  }
  const dem = { elev, width, height, cellM: 1000, originX: 0, originY: 0 };
  const far = [];
  const near = [];
  for (let y = 0; y < 10000; y += 2000) {
    far.push({ x: 5000, y });
    near.push({ x: 55000, y });
  }
  const profiles = compositeLayerProfiles(dem, { far, near }, {
    distanceM: 20000,
    cameraElevM: 1600,
    side: -1,
    spacingM: 2000,
    pastM: 2000,
    smoothWindowM: 0,
    isolateBandM: 3000,
  });
  assert.ok(profiles.L2 && profiles.L4);
  assert.equal(profiles.L3, undefined);
  // Each ridge fills its own shape. The far crest still subtends the
  // greater angle, which is what keeps it the major range.
  assert.ok(profiles.L2.angleMax > profiles.L4.angleMax);
  let nearElev = -Infinity;
  for (const v of profiles.L4.skylineElevM) if (Number.isFinite(v) && v > nearElev) nearElev = v;
  assert.ok(nearElev > 2000 && nearElev < 3000, `near ridge elev ${nearElev}`);
});

test('one corridor yields three layers that do not copy each other', () => {
  const profiles = rangeLayerProfiles(threeRidgeDem(), GUIDE, {
    distanceM: 80000,
    cameraElevM: 1000,
    side: -1,
    spacingM: 10000,
    pastM: 2000,
    smoothWindowM: 0,
    minGapM: 8000,
  }, { name: 'front' });
  assert.ok(profiles.L2 && profiles.L3 && profiles.L4);
  assert.equal(profiles.L5, undefined);
  const at = 1; // y = 10000
  assert.ok(profiles.L2.angles[at] > profiles.L4.angles[at]);
  // Far crest is the tall angle. The near ridge is a real, shorter layer,
  // not the far skyline drawn again.
  const farU = profileUnits(profiles.L2)[at];
  const midU = profileUnits(profiles.L3)[at];
  const nearU = profileUnits(profiles.L4)[at];
  assert.ok(farU > midU && midU > nearU, `units far ${farU} mid ${midU} near ${nearU}`);
  assert.ok(Math.abs(profiles.L2.angleMin - profiles.L4.angleMin) < 1e-12);
  assert.ok(Math.abs(profiles.L2.angleMax - profiles.L4.angleMax) < 1e-12);
});

test('buildProfile rejects a scan with no visible terrain', () => {
  const dem = frontDem();
  dem.elev.fill(dem.noData ?? NaN);
  dem.noData = NaN;
  // NaN-filled: sampleDem treats non-finite as missing. Scan angles are NaN.
  assert.throws(() => buildProfile(scanCorridor(dem, GUIDE, {
    distanceM: 80000, cameraElevM: 1800, side: -1, spacingM: 5000, pastM: 2000, smoothWindowM: 0,
  })));
});
