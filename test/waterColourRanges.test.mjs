import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { WATER_FLOW } from '../src/world/alpine/TerrainPackage.js';
import { waterColourRanges, waterTexelTable, WATER_COLOUR_MAX_RANGES } from '../src/world/alpine/WaterColourRanges.js';

const GRID = { originM: [100, -50], cellSizeM: 10, width: 33, height: 33 };
const EVERY = { minGap: 0, minSaving: 0, maxRanges: Infinity };

function surface(wet = [], { width = GRID.width, height = GRID.height } = {}) {
  const data = new Uint8Array(width * height * 4).fill(40);
  for (const [x, z] of wet) data[(z * width + x) * 4 + 3] = WATER_FLOW;
  return { width, height, data };
}

/** A lattice mesh split like TerrainMesh: `step` grid cells per quad. */
function lattice(step = 1) {
  const m = (GRID.width - 1) / step, n = m + 1;
  const positions = new Float32Array(n * n * 3), indices = new Uint32Array(m * m * 6);
  for (let v = 0, o = 0; v < n; v++) for (let u = 0; u < n; u++, o += 3) {
    positions[o] = GRID.originM[0] + u * step * GRID.cellSizeM;
    positions[o + 2] = GRID.originM[1] + v * step * GRID.cellSizeM;
  }
  for (let v = 0, k = 0; v < m; v++) for (let u = 0; u < m; u++) {
    const a = v * n + u, b = a + 1, c = a + n, d = c + 1;
    indices.set([a, c, d, a, d, b], k); k += 6;
  }
  return { positions, indices };
}

/** The fragment shader's waterCoverageAt, at a point of a triangle. */
function coverageAt(s, x, z) {
  const px = (x - GRID.originM[0]) / ((GRID.width - 1) * GRID.cellSizeM) * (s.width - 1);
  const pz = (z - GRID.originM[1]) / ((GRID.height - 1) * GRID.cellSizeM) * (s.height - 1);
  const cx = Math.floor(px), cz = Math.floor(pz), fx = px - cx, fz = pz - cz;
  const at = (ox, oz) => {
    const tx = Math.min(s.width - 1, Math.max(0, cx + ox)), tz = Math.min(s.height - 1, Math.max(0, cz + oz));
    return s.data[(tz * s.width + tx) * 4 + 3] === WATER_FLOW ? 1 : 0;
  };
  return (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fz) + (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fz;
}

function kept(ranges, count) {
  const on = new Uint8Array(count / 3);
  for (const r of ranges) for (let i = r.start; i < r.start + r.count; i += 3) on[i / 3] = 1;
  return on;
}

function ranges(s, mesh, options) {
  return waterColourRanges(mesh.positions, mesh.indices, waterTexelTable(s), GRID, options);
}

test('groups stay ordered, triangle-aligned and inside the cap', () => {
  const wet = [];
  for (let i = 1; i < 32; i += 6) wet.push([i, i]);
  const mesh = lattice();
  const out = ranges(surface(wet), mesh, { minGap: 0, minSaving: 0 });
  assert.ok(out.length >= 1 && out.length <= WATER_COLOUR_MAX_RANGES);
  let end = 0;
  for (const r of out) {
    assert.equal(r.materialIndex, 0);
    assert.equal(r.start % 3, 0);
    assert.equal(r.count % 3, 0);
    assert.ok(r.start >= end && r.count > 0);
    end = r.start + r.count;
  }
  assert.ok(end <= mesh.indices.length);
});

test('no triangle that can show water leaves the submission', () => {
  const s = surface([[0, 0], [7, 3], [8, 3], [31, 19], [32, 32], [15, 15]]);
  for (const step of [1, 2, 4]) {
    const mesh = lattice(step);
    const out = ranges(s, mesh, EVERY);
    assert.ok(out, `step ${step} keeps a restriction`);
    const on = kept(out, mesh.indices.length);
    assert.ok(on.includes(0));
    for (let t = 0; t < on.length; t++) {
      if (on[t]) continue;
      const p = [...mesh.indices.subarray(t * 3, t * 3 + 3)].map(i => [mesh.positions[i * 3], mesh.positions[i * 3 + 2]]);
      for (let a = 0; a <= 12; a++) for (let b = 0; b <= 12 - a; b++) {
        const c = 12 - a - b;
        const x = (p[0][0] * a + p[1][0] * b + p[2][0] * c) / 12, z = (p[0][1] * a + p[1][1] * b + p[2][1] * c) / 12;
        assert.ok(coverageAt(s, x, z) <= .5, `triangle ${t} at ${x},${z} is water`);
      }
    }
  }
});

test('a texel just past the bilinear footprint still counts as adjacent', () => {
  const mesh = lattice();
  // Triangle 0 sits in the cell between texels 0 and 1. Its corners reach
  // texel 1; the guard of one more texel reaches 2 and 3, no further.
  const near = ranges(surface([[3, 3]]), mesh, EVERY);
  assert.equal(kept(near, mesh.indices.length)[0], 1);
  const far = ranges(surface([[4, 4]]), mesh, EVERY);
  assert.equal(kept(far, mesh.indices.length)[0], 0);
});

test('a coarser surface lattice maps through the same grid extent', () => {
  const s = surface([[2, 2]], { width: 17, height: 17 });
  const mesh = lattice();
  const on = kept(ranges(s, mesh, EVERY), mesh.indices.length);
  // Texel (2,2) of a stride-2 surface stands at grid (4,4).
  assert.equal(on[(4 * 32 + 4) * 2], 1);
  assert.equal(on[(12 * 32 + 12) * 2], 0);
});

test('capping merges the smallest gaps and only ever adds triangles', () => {
  const wet = [[1, 1], [2, 12], [20, 12], [30, 30]];
  const mesh = lattice();
  const all = kept(ranges(surface(wet), mesh, EVERY), mesh.indices.length);
  const capped = ranges(surface(wet), mesh, { minGap: 0, minSaving: 0, maxRanges: 2 });
  assert.equal(capped.length, 2);
  const on = kept(capped, mesh.indices.length);
  for (let t = 0; t < on.length; t++) if (all[t]) assert.equal(on[t], 1);
  assert.ok(on.includes(0));
});

test('a gap too small to earn a draw is drawn through', () => {
  const mesh = lattice();
  const out = ranges(surface([[4, 2], [28, 2]]), mesh, { minGap: mesh.indices.length, minSaving: 0 });
  assert.equal(out.length, 1);
});

test('negligible savings keep the original draw', () => {
  const mesh = lattice();
  const wet = [];
  for (let z = 0; z < 26; z++) for (let x = 0; x < 33; x++) wet.push([x, z]);
  for (let x = 0; x < 33; x++) wet.push([x, 32]);
  assert.equal(ranges(surface(wet), mesh, { minGap: 0, minSaving: .5 }), null);
  assert.ok(ranges(surface(wet), mesh, { minGap: 0, minSaving: 0 }));
  assert.equal(waterColourRanges(new Float32Array(), new Uint32Array(), waterTexelTable(surface()), GRID), null);
});

test('a surface with no water, or no terrain water by policy, submits nothing', () => {
  const mesh = lattice();
  assert.deepEqual(ranges(surface(), mesh), []);
  assert.deepEqual(waterColourRanges(mesh.positions, mesh.indices, null, GRID), []);
});

test('the input arrays are not changed', () => {
  const mesh = lattice();
  const positions = mesh.positions.slice(), indices = mesh.indices.slice();
  ranges(surface([[4, 4]]), mesh);
  assert.deepEqual(mesh.positions, positions);
  assert.deepEqual(mesh.indices, indices);
});

// renderWater with the GL side stubbed: what each scene draw sees.
function waterScene({ tour = false } = {}) {
  const s = Object.create(RangeScene.prototype);
  const geometry = new THREE.BufferGeometry(), material = new THREE.ShaderMaterial();
  const mesh = new THREE.Mesh(geometry, material), fringe = new THREE.Mesh(new THREE.BufferGeometry(), material);
  const river = new THREE.Mesh(new THREE.BufferGeometry(), material);
  const bandScene = new THREE.Scene(), depthScene = new THREE.Scene();
  bandScene.add(mesh, fringe, river);
  const uniforms = { uWaterOnly: { value: 0 }, uViewportPx: { value: new THREE.Vector2() } };
  const groups = [{ start: 6, count: 12, materialIndex: 0 }];
  const fringeGroups = [{ start: 0, count: 6, materialIndex: 0 }, { start: 30, count: 6, materialIndex: 0 }];
  const p = { uniforms, view: { id: 'lake' }, depthScene, depthScenes: new Map(), forest: { byBand: {} },
    scenes: { far: bandScene, mid: new THREE.Scene(), near: new THREE.Scene() }, fringeTravel: [],
    waterColour: tour ? null : [{ mesh, geometry, groups }, { mesh: fringe, geometry: fringe.geometry, groups: fringeGroups }] };
  const draws = [];
  const r = {
    setRenderTarget() {}, setClearColor() {}, clear() {},
    render(scene) {
      draws.push({ scene, water: uniforms.uWaterOnly.value, mesh: mesh.material, groups: geometry.groups,
        fringe: fringe.material, fringeGroups: fringe.geometry.groups, river: river.material });
    },
  };
  Object.assign(s, { THREE, renderer: r, contextLost: false, target: {}, prepared: new Map([['lake', p]]),
    camera: new THREE.PerspectiveCamera(), size: { width: 320, height: 180 }, canvas: {},
    _setCamera() {}, _setUniforms() {}, _prepareMirror() { draws.push({ mirror: mesh.material }); },
    _waterRenderTarget: () => ({}), _setCanvasSize() {}, _clearCanvas() {}, _copyTexture() {}, _travelFringe() {}, _travelDepth() {} });
  return { s, r, draws, mesh, fringe, river, geometry, material, depthScene, bandScene, groups };
}
const frame = { frameId: 1, occurrenceId: 1 };

test('the colour draw alone takes the wet ranges; depth, mirror and rivers stay whole', () => {
  const t = waterScene();
  t.s.renderWater(frame, 'lake', 320, 180);
  assert.equal(t.draws[0].mirror, t.material);
  const depth = t.draws.find(d => d.scene === t.depthScene), colour = t.draws.find(d => d.scene === t.bandScene);
  assert.equal(depth.mesh, t.material);
  assert.equal(depth.water, 0);
  assert.deepEqual(depth.groups, []);
  assert.deepEqual(colour.mesh, [t.material]);
  assert.equal(colour.water, 1);
  assert.deepEqual(colour.groups, t.groups);
  assert.equal(colour.fringeGroups.length, 2);
  assert.equal(colour.river, t.material);
  assert.equal(t.mesh.material, t.material);
  assert.equal(t.fringe.material, t.material);
  assert.deepEqual(t.geometry.groups, []);
});

test('a failed colour draw restores the mesh', () => {
  const t = waterScene();
  const render = t.r.render;
  t.r.render = (scene) => { render(scene); if (scene === t.bandScene) throw new Error('lost'); };
  assert.throws(() => t.s.renderWater(frame, 'lake', 320, 180), /lost/);
  assert.equal(t.mesh.material, t.material);
  assert.deepEqual(t.geometry.groups, []);
});

test('tour views, swapped windows and travel columns keep the original draw', () => {
  const tour = waterScene({ tour: true });
  tour.s.renderWater(frame, 'lake', 320, 180);
  assert.equal(tour.draws.find(d => d.scene === tour.bandScene).mesh, tour.material);

  const swapped = waterScene();
  swapped.mesh.geometry = new THREE.BufferGeometry();
  swapped.s.renderWater(frame, 'lake', 320, 180);
  assert.equal(swapped.draws.find(d => d.scene === swapped.bandScene).mesh, swapped.material);
  assert.deepEqual(swapped.draws.find(d => d.scene === swapped.bandScene).fringeGroups.length, 2);

  const travel = waterScene();
  travel.s.renderWater(frame, 'lake', 320, 180, { pass: 'far', bandColumns: { mid: [0, 1] } });
  assert.equal(travel.draws.find(d => d.scene === travel.bandScene).mesh, travel.material);
});
