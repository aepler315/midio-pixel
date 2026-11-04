import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  LAND_RISE_START, LAND_RISE_KNEE, LAND_RISE_GLSL, LAND_RISE_MIN_END, LAND_RISE_CATCH_UP_MS,
  compileLandRise, landRiseLift, risenFloor, risenHeight, riseFromUniforms,
} from '../src/world/alpine/LandRise.js';
import { compileLandscapeScore } from '../src/world/alpine/LandscapeScore.js';
import { FINALE_MS } from '../src/world/alpine/RangeCamera.js';
import { sceneUniforms, SCENE_FRAG, SCENE_VERT } from '../src/world/alpine/TerrainMaterial.js';
import { frustumPlanes, visibleGroups, chunkTable } from '../src/world/alpine/TerrainChunks.js';
import { liftBounds } from '../src/world/alpine/MirrorScissor.js';
import { forestBatchFootprintPx } from '../src/world/alpine/ForestDetail.js';
import { planTerrainWindow } from '../src/world/alpine/TerrainWindow.js';

// Seeded so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ---------------------------------------------------------------------------
// The song's curve

test('the range starts pressed down and stands complete before the closing move', () => {
  const read = t => .5 + .5 * Math.sin(t / 7000);
  const rise = compileLandRise({ read, durationMs: 240000, cadenceMs: 230000, finaleMs: FINALE_MS });
  assert.equal(rise.endMs, 230000 - FINALE_MS);
  assert.ok(Math.abs(rise.at(0) - LAND_RISE_START) < 1e-12);
  let prev = -Infinity;
  for (let t = 0; t <= 240000; t += 50) {
    const s = rise.at(t);
    assert.ok(s >= prev - 1e-12, `the land never sinks (${t} ms)`);
    if (t > 0 && t < rise.endMs) assert.ok(s > prev, `it keeps rising (${t} ms)`);
    assert.ok(s >= LAND_RISE_START && s <= 1);
    prev = s;
  }
  for (const t of [rise.endMs, rise.endMs + 1, 230000, 240000, 1e9]) assert.equal(rise.at(t), 1, `${t} ms`);
  // The landing is gentle: the last stretch climbs slower than the middle.
  const late = rise.at(rise.endMs) - rise.at(rise.endMs - 5000), mid = rise.at(105000) - rise.at(100000);
  assert.ok(late < mid / 2, `landing ${late} vs ${mid}`);
});

test('a short song still rises over most of its length; no song or a preview stands complete', () => {
  const short = compileLandRise({ read: () => .4, durationMs: 40000, cadenceMs: 39000, finaleMs: FINALE_MS });
  assert.equal(short.endMs, LAND_RISE_MIN_END * 39000);
  assert.ok(short.at(10000) > LAND_RISE_START && short.at(10000) < 1);
  for (const durationMs of [0, -5, NaN]) {
    const none = compileLandRise({ durationMs });
    assert.equal(none.at(0), 1);
    assert.equal(none.at(5000), 1);
  }
  const score = compileLandscapeScore({ energyCurves: { globalEnergyNorm: () => .5 }, durationMs: 120000 });
  assert.equal(score.at(0, { preview: true }).rise01, 1, 'a preview shows the complete range');
  assert.ok(Math.abs(score.at(0).rise01 - LAND_RISE_START) < 1e-12);
  assert.equal(score.at(119000).rise01, 1);
  assert.equal(score.riseEndMs, compileLandRise({ read: () => .5, durationMs: 120000, cadenceMs: score.cadenceMs, finaleMs: FINALE_MS }).endMs);
});

test('loud passages climb faster than quiet ones, and silence still climbs', () => {
  const rise = compileLandRise({ read: t => t < 60000 ? 0 : 1, durationMs: 160000, cadenceMs: 160000, finaleMs: FINALE_MS });
  const quiet = rise.progressAt(50000) - rise.progressAt(40000), loud = rise.progressAt(90000) - rise.progressAt(80000);
  assert.ok(quiet > 0, 'quiet passages keep rising');
  assert.ok(loud > 2 * quiet, `loud ${loud} vs quiet ${quiet}`);
});

test('a whole-song analysis takes over the climb without a jump or a sink', () => {
  const opening = compileLandRise({ read: () => .2, durationMs: 200000, cadenceMs: 200000, finaleMs: FINALE_MS });
  for (const freezeThroughMs of [0, 15000, 30000, 150000, 199000]) {
    const whole = compileLandRise({ read: t => (t / 210000) ** 2, durationMs: 210000, cadenceMs: 205000, finaleMs: FINALE_MS,
      previous: opening.progressAt, freezeThroughMs });
    for (let t = 0; t <= freezeThroughMs; t += 1000) assert.equal(whole.at(t), opening.at(t), `held before the handoff (${t})`);
    assert.ok(Math.abs(whole.at(freezeThroughMs + 1) - opening.at(freezeThroughMs)) < 1e-3, `no jump at ${freezeThroughMs}`);
    let prev = -Infinity;
    for (let t = 0; t <= 210000; t += 100) { const s = whole.at(t); assert.ok(s >= prev - 1e-12, `${freezeThroughMs}: sinks at ${t}`); prev = s; }
    assert.equal(whole.at(whole.endMs), 1);
  }
  // A re-analysis whose climb is already over finishes what is left, gently.
  const late = compileLandRise({ read: () => .5, durationMs: 60000, cadenceMs: 60000, finaleMs: FINALE_MS,
    previous: opening.progressAt, freezeThroughMs: 50000 });
  assert.ok(late.endMs < 50000 && opening.at(50000) < 1);
  assert.equal(late.at(50000), opening.at(50000));
  assert.ok(late.at(50250) - late.at(50000) < .05, 'no jump to the complete range');
  let before = late.at(50000);
  for (let t = 50000; t <= 60000; t += 50) { const s = late.at(t); assert.ok(s >= before - 1e-12); before = s; }
  assert.equal(late.at(50000 + LAND_RISE_CATCH_UP_MS), 1);
  // A climb already complete stays complete.
  const done = compileLandRise({ read: () => .5, durationMs: 100000, cadenceMs: 100000, previous: () => 1, freezeThroughMs: 20000 });
  assert.equal(done.at(30000), 1);
  // The score hands its climb to the next analysis.
  const curves = { globalEnergyNorm: () => .3 };
  const first = compileLandscapeScore({ energyCurves: curves, durationMs: 150000 });
  const second = compileLandscapeScore({ energyCurves: { globalEnergyNorm: () => .9 }, durationMs: 150000, previous: first, committedThroughMs: 40000 });
  assert.equal(second.at(40000).rise01, first.at(40000).rise01);
  assert.ok(second.at(41000).rise01 >= first.at(40000).rise01);
});

// ---------------------------------------------------------------------------
// The map

test('nothing hidden at full height comes into view, nothing below the eye moves, and rays stay rays', () => {
  const r = rng(7);
  for (let n = 0; n < 4000; n++) {
    const eye = [(r() - .5) * 2000, 500 + r() * 2000, (r() - .5) * 2000], sink = r();
    const dir = [Math.cos(r() * 6.28), Math.sin(r() * 6.28)];
    const at = (d, y) => [eye[0] + dir[0] * d, y, eye[2] + dir[1] * d];
    const drawn = (d, y) => y + landRiseLift(...at(d, y), eye, sink);
    // P behind Q along the same azimuth, Q at or above the sight line.
    const dP = 50 + r() * 30000, dQ = r() * dP, yP = eye[1] + (r() - .3) * 3000;
    const line = eye[1] + (yP - eye[1]) * dQ / dP, yQ = line + r() * 500;
    const lineDrawn = eye[1] + (drawn(dP, yP) - eye[1]) * dQ / dP;
    assert.ok(drawn(dQ, yQ) >= lineDrawn - 1e-6, `case ${n}: Q no longer hides P`);
    // Land below the eye stays; land above it never drops below the eye.
    const below = eye[1] - r() * 2000;
    assert.equal(landRiseLift(...at(dP, below), eye, sink), 0);
    assert.ok(drawn(dP, eye[1] + r() * 3000) >= eye[1]);
    // Homogeneous (beyond the first metre): the squash is the same at every distance.
    const k = 1 + r() * 9, d = 1 + r() * 5000, h = r() * 3000;
    assert.ok(Math.abs(landRiseLift(...at(k * d, eye[1] + k * h), eye, sink) - k * landRiseLift(...at(d, eye[1] + h), eye, sink)) < 1e-6 * k * (1 + h));
  }
  assert.equal(landRiseLift(0, 5000, 0, [0, 0, 0], 0), 0, 'no sink, no rise');
  assert.equal(landRiseLift(0, 5000, 0, null, .5), 0);
});

// Execute the production GLSL with JS stand-ins for its vector math.
function glsl(name, args) {
  const match = LAND_RISE_GLSL.match(new RegExp(`\\w+ ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\}`));
  assert.ok(match, `LAND_RISE_GLSL must provide ${name}`);
  const body = match[1]
    .replace(/\bvec2 (\w+) = p\.xz - uTourEye\.xz;/, 'const $1 = { x: p.x - uTourEye.x, y: p.z - uTourEye.z };')
    .replace(/length\(p\.xz - uTourEye\.xz\)/g, 'Math.hypot(p.x - uTourEye.x, p.z - uTourEye.z)')
    .replace(/length\((\w+)\)/g, 'Math.hypot($1.x, $1.y)')
    .replace(/\b(float|vec3) /g, 'let ')
    .replace(/\b(max|exp)\(/g, 'Math.$1(')
    .replace(/vec3\(0\.0\)/g, 'vec3(0, 0, 0)');
  return new Function(...args, 'vec3', 'riseGrad', 'normalize', body);
}
const vec3 = (x, y, z) => ({ x, y, z });
const normalize = v => { const l = Math.hypot(v.x, v.y, v.z); return vec3(v.x / l, v.y / l, v.z / l); };

test('the GPU rise, its gradient and the carried normals match the CPU twin', () => {
  assert.match(LAND_RISE_GLSL, /vec3 risenNormal\(vec3 n, vec3 p\) \{ return gradNormal\(n, riseGrad\(p\)\); \}/);
  const lift = glsl('riseLift', ['p', 'uTourEye', 'uLandRise']);
  const gradBody = glsl('riseGrad', ['p', 'uTourEye', 'uLandRise']);
  const normalBody = glsl('gradNormal', ['n', 'g', 'uLandRise']);
  const r = rng(11);
  let checked = 0;
  for (let n = 0; n < 3000; n++) {
    const eye = { x: (r() - .5) * 4000, y: 300 + r() * 2500, z: (r() - .5) * 4000 }, sink = r() < .1 ? 0 : r();
    const p = { x: eye.x + (r() - .5) * 40000, y: eye.y + (r() - .3) * 3000, z: eye.z + (r() - .5) * 40000 };
    const cpu = landRiseLift(p.x, p.y, p.z, [eye.x, eye.y, eye.z], sink);
    const gpu = lift(p, eye, sink, vec3);
    assert.ok(Math.abs(gpu - cpu) <= 1e-4 * (1 + Math.abs(cpu)), `${gpu} vs ${cpu}`);
    // Gradient against central differences of the CPU twin.
    const g = gradBody(p, eye, sink, vec3), e = .05;
    const f = (dx, dy, dz) => landRiseLift(p.x + dx, p.y + dy, p.z + dz, [eye.x, eye.y, eye.z], sink);
    const fd = [(f(e, 0, 0) - f(-e, 0, 0)) / (2 * e), (f(0, e, 0) - f(0, -e, 0)) / (2 * e), (f(0, 0, e) - f(0, 0, -e)) / (2 * e)];
    if (Math.abs(p.y - eye.y) > 1 && Math.hypot(p.x - eye.x, p.z - eye.z) > 2) {
      for (const [k, v] of [['x', fd[0]], ['y', fd[1]], ['z', fd[2]]]) assert.ok(Math.abs(g[k] - v) < 2e-3, `d/d${k}: ${g[k]} vs ${v}`);
      // The carried normal stays perpendicular to the lowered surface.
      const nrm = normalize(vec3(r() - .5, .2 + r(), r() - .5));
      const t1 = normalize(vec3(nrm.y, -nrm.x, 0)), t2 = vec3(nrm.y * t1.z - nrm.z * t1.y, nrm.z * t1.x - nrm.x * t1.z, nrm.x * t1.y - nrm.y * t1.x);
      const risen = normalBody(nrm, g, sink, vec3, null, normalize);
      for (const t of [t1, t2]) {
        const moved = vec3(t.x, t.y + g.x * t.x + g.y * t.y + g.z * t.z, t.z);
        assert.ok(Math.abs(risen.x * moved.x + risen.y * moved.y + risen.z * moved.z) < 1e-6 * (1 + Math.hypot(moved.x, moved.y, moved.z)));
      }
      checked++;
    }
  }
  assert.ok(checked > 2000, `checked ${checked}`);
});

test('every pass lowers the land once, after the musical lift; the complete range costs nothing', () => {
  assert.match(SCENE_VERT, /p\.y \+= riseLift\(p\);/);
  assert.match(SCENE_FRAG, /nShade = gradNormal\(nShade, vRiseGrad\)/);
  assert.match(SCENE_VERT, /vRiseGrad = riseGrad\(p\);\n\s*p\.y \+= riseLift\(p\);/, 'the gradient where the rise is taken');
  assert.match(SCENE_FRAG, /sunHorizonVisibility\(vUv, stretchedLight\(uLightDir, 1\.0 \+ vRiseGrad\.y\)\)/);
  assert.match(LAND_RISE_GLSL, /if \(uLandRise <= 0\.0\) return 0\.0;/, 'zero sink is an early out');
  const u = sceneUniforms(THREE, {});
  assert.equal(u.uLandRise.value, 0);
  assert.ok(u.uTourEye.value.isVector4, 'uTourEye carries the tour fade in w');
  assert.equal(riseFromUniforms(u), null);
  u.uLandRise.value = .4; u.uTourEye.value.set(1, 2, 3, 0);
  assert.deepEqual(riseFromUniforms(u), { sink: .4, eye: [1, 2, 3], knee: LAND_RISE_KNEE });
});

test('the scene draws the frame\'s rise, and a frame without one draws the complete range', async () => {
  const [{ RangeScene }, { rangeMusicState }] = await Promise.all([
    import('../src/world/alpine/RangeScene.js'), import('../src/world/alpine/RangeFrame.js'),
  ]);
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, .1, 100000);
  camera.position.set(10, 1000, 1000); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, camera });
  const uniforms = sceneUniforms(THREE, { uHeightRange: { value: new THREE.Vector2(0, 2000) } });
  const view = { camera: { eyeStartM: [10, 1000, 1000], eyeEndM: [10, 1000, 1000], targetStartM: [0, 0, 0], targetEndM: [0, 0, 0], fovYDeg: 40 } };
  const frame = { timeMs: 9000, progress01: .3, music: rangeMusicState({}), qualityLevel: 4,
    scenicViewport: { nominalHeight: 720 }, light: { celestial: { xFrac: .7, yFrac: .08, body: 'sun', colorHex: '#ffffff', intensity: 1.6 },
      night01: 0, ambientMultiplier: 1, sky: { top: '#334455', horizon: '#778899', air: '#556677' } } };
  for (const [rise01, sink] of [[.25, .75], [1, 0], [undefined, 0], [NaN, 0], [-1, 1], [3, 0]]) {
    scene._setUniforms({ uniforms, view }, { ...frame, rise01 });
    assert.equal(uniforms.uLandRise.value, sink, `rise01 ${rise01}`);
    assert.deepEqual(uniforms.uTourEye.value.toArray(), [10, 1000, 1000, 0]);
  }
});

// ---------------------------------------------------------------------------
// Bounds: what the rise lowers into view is drawn

test('risenFloor bounds every point the rise draws from a box', () => {
  const r = rng(3);
  for (let n = 0; n < 2000; n++) {
    const rise = { sink: r(), eye: [(r() - .5) * 4000, 500 + r() * 2000, (r() - .5) * 4000], knee: LAND_RISE_KNEE };
    const x0 = rise.eye[0] + (r() - .5) * 20000, z0 = rise.eye[2] + (r() - .5) * 20000, x1 = x0 + r() * 3000, z1 = z0 + r() * 3000;
    const y0 = rise.eye[1] + (r() - .5) * 3000, y1 = y0 + r() * 2000;
    const floor = risenFloor(y0, x0, z0, x1, z1, rise);
    assert.ok(floor <= y0);
    for (let k = 0; k < 16; k++) {
      const x = x0 + r() * (x1 - x0), z = z0 + r() * (z1 - z0), y = y0 + r() * (y1 - y0);
      const drawn = y + landRiseLift(x, y, z, rise.eye, rise.sink);
      assert.ok(drawn >= floor - 1e-9 && drawn <= y1 + 1e-9, `case ${n}: ${drawn} outside [${floor}, ${y1}]`);
      assert.ok(Math.abs(risenHeight(y, Math.hypot(x - rise.eye[0], z - rise.eye[2]), rise) - drawn) < 1e-9);
    }
  }
  assert.equal(risenFloor(1234, 0, 0, 1, 1, null), 1234);
});

// A camera level at 1000 m looking north; a summit block 5 km out whose
// lowest point is 26 degrees up, above the top of a 30 degree frame.
function summitScene() {
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 1, 100000);
  camera.position.set(0, 1000, 0); camera.lookAt(0, 1000, -1); camera.updateMatrixWorld();
  const box = [-500, 3500, -5500, 500, 4000, -5000];
  const rise = { sink: 1 - LAND_RISE_START, eye: [0, 1000, 0], knee: LAND_RISE_KNEE };
  return { camera, box, rise };
}

test('a summit the rise lowers into the frame is not culled; one it leaves above is', () => {
  const { camera, box, rise } = summitScene();
  const planes = frustumPlanes(camera, null);
  const table = chunkTable(Uint32Array.of(0), Uint32Array.of(3), Float64Array.from(box));
  assert.equal(visibleGroups(table, planes, { lo: 0, hi: 0 }).length, 0, 'above the frame at full height');
  assert.equal(visibleGroups(table, planes, { lo: 0, hi: 0, rise }).length, 1, 'lowered into it');
  assert.equal(visibleGroups(table, planes, { lo: 0, hi: 0, rise: { ...rise, sink: 0 } }).length, 0);
  // The scissor and culling bounds read the rise from this frame's uniforms.
  const u = sceneUniforms(THREE, {});
  assert.equal(liftBounds(u).rise, null);
  u.uLandRise.value = rise.sink; u.uTourEye.value.set(...rise.eye, 1);
  assert.deepEqual(liftBounds(u).rise, rise);
  // A random sweep: a culled box has no drawn point in the frame.
  const r = rng(5);
  let culled = 0, kept = 0;
  for (let n = 0; n < 3000; n++) {
    const sink = r(), eye = [0, 1000, 0];
    const cx = (r() - .5) * 8000, cz = -200 - r() * 12000, s = 50 + r() * 800, y0 = 1000 + r() * 4000, y1 = y0 + r() * 1000;
    const b = [cx - s, y0, cz - s, cx + s, y1, cz + s];
    const keep = visibleGroups(chunkTable(Uint32Array.of(0), Uint32Array.of(3), Float64Array.from(b)), planes,
      { lo: 0, hi: 0, rise: { sink, eye, knee: LAND_RISE_KNEE } }).length;
    if (keep) { kept++; continue; }
    culled++;
    for (let k = 0; k < 24; k++) {
      const x = b[0] + r() * (b[3] - b[0]), z = b[2] + r() * (b[5] - b[2]), y = b[1] + r() * (b[4] - b[1]);
      const v = new THREE.Vector3(x, y + landRiseLift(x, y, z, eye, sink), z).project(camera);
      assert.ok(!(Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && Math.abs(v.z) <= 1), `case ${n}: culled box drawn at ${v.toArray()}`);
    }
  }
  assert.ok(culled > 300 && kept > 300, `culled ${culled}, kept ${kept}`);
});

test('the pixel-mode forest sizes a tree where the rise draws it', () => {
  const { camera, rise } = summitScene();
  const attr = (...rows) => ({ count: rows.length, getX: i => rows[i][0], getY: i => rows[i][1], getZ: i => rows[i][2] });
  const geometry = { attributes: { iPos: attr([0, 3500, -5200]), iSize: attr([30, 10, 0]) }, instanceCount: 1 };
  assert.equal(forestBatchFootprintPx(geometry, camera, 1280, 720, {}), 0, 'above the frame at full height');
  const lowered = forestBatchFootprintPx(geometry, camera, 1280, 720, { rise });
  assert.ok(lowered > 0, 'lowered into the frame, it is sized');
  // Without a rise the footprint is exactly what it was.
  const inView = { attributes: { iPos: attr([0, 900, -3000]), iSize: attr([30, 10, 0]) }, instanceCount: 1 };
  assert.equal(forestBatchFootprintPx(inView, camera, 1280, 720, { rise: null }), forestBatchFootprintPx(inView, camera, 1280, 720, {}));
});

test('a mapped tour plans the land the rise lowers into its windows', () => {
  const tiles = new Map([...Array(4)].map((_, i) => [`t${i}`, { id: `t${i}`, ix: i % 2, iz: Math.floor(i / 2), stride: 1,
    minY: i === 0 ? 3000 : 0, maxY: i === 0 ? 3400 : 100, errorsM: { 1: 0, 2: 1, 4: 3, 8: 10, 16: 30, 32: 100, 64: 300 } }]));
  const data = { grid: { originM: [-1280, -1280], cellSizeM: 20, width: 129, height: 129 }, cells: 64, tiles };
  const tour = { poseAt: t => ({ eyeM: [0, 500, 5000 - t / 10], targetM: [0, 50, 0], fovYDeg: 40 }), durationMs: 30000 };
  const flat = planTerrainWindow(data, tour, 0, { heightPx: 1080 });
  assert.ok(!flat.visible.has('t0'), 'the summit tile stands above every frame at full height');
  assert.equal(flat.strides.get('t0'), 64);
  const risen = planTerrainWindow(data, tour, 0, { heightPx: 1080, riseSink: 1 - LAND_RISE_START });
  assert.ok(risen.visible.has('t0'), 'lowered, it is in the window');
  assert.ok(risen.strides.get('t0') < 64);
  for (const id of ['t1', 't2', 't3']) assert.equal(risen.strides.get(id), flat.strides.get(id), 'land below the eye plans as before');
});
