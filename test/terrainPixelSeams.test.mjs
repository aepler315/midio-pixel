import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { planTerrainWindow } from '../src/world/alpine/TerrainWindow.js';
import { buildTerrainGeometry } from '../src/world/alpine/TerrainMesh.js';
import { LENS_MIN_HALF_ANGLE_SCALE } from '../src/render/CameraLens.js';
import { tileStrideError } from '../tools/lib/terrain-bake.mjs';

function seamFixture() {
  const tiles = new Map(Array.from({ length: 3 }, (_, ix) => [`${ix}`, {
    id: `${ix}`, ix, iz: 0, stride: 1, samples: 5, visible: true, band: 'far',
    heightsM: new Float32Array(25), flowBytes: new Uint8Array(25),
  }]));
  const left = tiles.get('0'), middle = tiles.get('1'), right = tiles.get('2');
  // An exact stride-2 hill keeps the left neighbour from using stride 4.
  // This makes the middle tile retain stride 2 while its right neighbour
  // may choose stride 4. Shared tile boundaries all have matching samples.
  const hill = (u, v) => u === 2 && v === 2 ? 100 : 0;
  for (let v = 0; v <= 4; v++) for (let u = 0; u <= 4; u++) {
    const x = Math.min(2, Math.floor(u / 2) * 2), z = Math.min(2, Math.floor(v / 2) * 2);
    const tx = (u - x) / 2, tz = (v - z) / 2;
    const a = hill(x, z), b = hill(x + 2, z), c = hill(x, z + 2), d = hill(x + 2, z + 2);
    left.heightsM[v * 5 + u] = tx >= tz ? a + (b - a) * tx + (d - b) * tz : a + (d - c) * tx + (c - a) * tz;
  }
  middle.heightsM[2 * 5 + 2] = 1;
  middle.heightsM[2 * 5 + 4] = -1;
  middle.heightsM[2 * 5 + 3] = -1;
  right.heightsM[2 * 5] = -1;
  const valid = new Uint8Array(25).fill(1);
  for (const tile of tiles.values()) {
    tile.minY = Math.min(...tile.heightsM); tile.maxY = Math.max(...tile.heightsM);
    tile.errorsM = Object.fromEntries([1, 2, 4].map(stride =>
      [stride, tileStrideError(tile.heightsM, valid, 5, 5, 0, 0, 4, stride)]));
  }
  return { manifest: { bands: { nearM: 1800 } }, cells: 4,
    grid: { originM: [0, 0], cellSizeM: 1 }, tiles,
    byIndex: new Map([...tiles.values()].map(tile => [`${tile.ix},0`, tile])) };
}

function meshHeightAt(geometry, x, z) {
  const positions = geometry.bands.far.positions, indices = geometry.bands.far.indices;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]].map(index =>
      [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]]);
    const area = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (!area) continue;
    const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / area;
    const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / area;
    const w = 1 - u - v;
    if (Math.min(u, v, w) >= -1e-8) return u * a[1] + v * b[1] + w * c[1];
  }
  assert.fail(`no drawn triangle covers ${x}, ${z}`);
}

test('pixel terrain error includes interior interpolation combined with a snapped coarser seam', () => {
  const data = seamFixture(), heightPx = 180, widthPx = 320, baseFov = 10;
  assert.deepEqual(data.tiles.get('1').errorsM, { 1: 0, 2: 1, 4: 1 }, 'uniform measured grids both have only 1 m error');
  const focal = heightPx / (2 * Math.tan(baseFov * Math.PI / 360) * LENS_MIN_HALF_ANGLE_SCALE);
  // The maximum permitted lens has about .2 native pixels per metre here.
  // The eye is beyond the protected near-root distance, and horizontal,
  // so vertical sample displacement has an exact simple screen projection.
  const pose = { eyeM: [7, 0, focal / .2 + 5], targetM: [7, 0, 0], fovYDeg: baseFov };
  const tour = { durationMs: 8000, poseAt: () => pose };
  const reference = planTerrainWindow(data, tour, 0);
  const pixel = planTerrainWindow(data, tour, 0, { pixelHeightPx: heightPx });
  const built = buildTerrainGeometry(data, { strides: pixel.strides });
  const before = buildTerrainGeometry(data, { strides: reference.strides });
  assert.equal(meshHeightAt(before, 7, 2), -1, 'the existing reference surface retains the sample');
  assert.ok(pixel.pixelTrianglesSaved > 0, 'safe additional coarsening remains available');
  const camera = new THREE.PerspectiveCamera(2 * Math.atan(Math.tan(baseFov * Math.PI / 360) * LENS_MIN_HALF_ANGLE_SCALE) * 180 / Math.PI,
    widthPx / heightPx, 20, 150000);
  camera.position.fromArray(pose.eyeM); camera.lookAt(...pose.targetM); camera.updateMatrixWorld();
  const project = y => {
    const p = new THREE.Vector3(7, y, 2).project(camera);
    return [(p.x + 1) * widthPx / 2, (1 - p.y) * heightPx / 2];
  };
  const source = project(-1), candidate = project(meshHeightAt(built, 7, 2));
  const errorPx = Math.hypot(candidate[0] - source[0], candidate[1] - source[1]);
  assert.ok(errorPx <= .25 + 1e-6,
    `drawn mixed-stride seam moved ${errorPx.toFixed(6)} native pixels despite the ${pixel.pixelCoarsenedMaxErrorPx.toFixed(6)} px table bound`);
});
