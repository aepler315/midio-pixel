import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  LAND_RISE_START, LAND_RISE_GLSL, LAND_RISE_MIN_END, LAND_RISE_CATCH_UP_MS, risenSphere,
  compileLandRise, landRiseLift, risenFloor, risenHeight, riseFromUniforms,
} from '../src/world/alpine/LandRise.js';
import { compileLandscapeScore } from '../src/world/alpine/LandscapeScore.js';
import { FINALE_MS } from '../src/world/alpine/RangeCamera.js';
import { sceneUniforms, SCENE_FRAG, SCENE_VERT } from '../src/world/alpine/TerrainMaterial.js';
import { liftBounds } from '../src/world/alpine/MirrorScissor.js';
import { forestBatchFootprintPx } from '../src/world/alpine/ForestDetail.js';

// Seeded so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ---------------------------------------------------------------------------
// The song's curve

test('the affine rise starts on one flat base and moves land below the eye too', () => {
  assert.equal(LAND_RISE_START, 0);
  const baseM = 1200;
  for (const point of [[0, 600, 0], [50, 1500, -200], [-5000, 4000, 10000]]) {
    const [x, y, z] = point;
    assert.equal(y + landRiseLift(x, y, z, [0, 2000, 0], 1, baseM), baseM);
    assert.equal(y + landRiseLift(x, y, z, [0, 2000, 0], .5, baseM), baseM + .5 * (y - baseM));
  }
  assert.deepEqual(riseFromUniforms({ uLandRise: { value: { x: .5, y: -150 } } }), { sink: .5, baseM: -150 });
});

test('the range starts flat and stands complete before the closing move', () => {
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
  // Nor does one a moment from over: no handoff moves faster than the
  // catch-up. (An opening analysis cannot hear a quiet tail, so its climb
  // can run well past the whole song's.)
  const frameMs = 1000 / 60, fastest = (1 - LAND_RISE_START) * 1.1 * frameMs / LAND_RISE_CATCH_UP_MS;
  const long = compileLandRise({ read: () => .2, durationMs: 240000, cadenceMs: 240000, finaleMs: FINALE_MS });
  const whole = compileLandRise({ read: () => .5, durationMs: 240000, cadenceMs: 180000, finaleMs: FINALE_MS });
  for (const early of [1, 20, 300, 1000, 5000]) {
    const freezeThroughMs = whole.endMs - early;
    const handed = compileLandRise({ read: () => .5, durationMs: 240000, cadenceMs: 180000, finaleMs: FINALE_MS,
      previous: long.progressAt, freezeThroughMs });
    assert.ok(long.at(freezeThroughMs) < .9, 'the land still had climbing to do');
    let step = 0;
    for (let t = freezeThroughMs; t <= freezeThroughMs + 2 * LAND_RISE_CATCH_UP_MS; t += frameMs) step = Math.max(step, handed.at(t + frameMs) - handed.at(t));
    assert.ok(step <= fastest, `${early} ms before the new end: ${step} per frame`);
    assert.equal(handed.at(Math.max(whole.endMs, freezeThroughMs + LAND_RISE_CATCH_UP_MS)), 1);
  }
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
// The shared vertical map

test('the same affine rise applies at every distance, camera pitch and source elevation', () => {
  const random = rng(7);
  for (let index = 0; index < 3000; index++) {
    const x = (random() - .5) * 100000, z = (random() - .5) * 100000;
    const y = (random() - .3) * 6000, baseM = (random() - .3) * 3000;
    const sink = random(), expected = baseM + (1 - sink) * (y - baseM);
    for (const eye of [null, [0, -500, 0], [12000, 8000, -9000]]) {
      const drawn = y + landRiseLift(x, y, z, eye, sink, baseM);
      assert.ok(Math.abs(drawn - expected) < 1e-9);
    }
    assert.ok(Math.abs(risenHeight(y, Math.hypot(x, z), { sink, baseM }) - expected) < 1e-9);
  }
});

test('the flat plane is exact and intermediate relief grows continuously to source height', () => {
  for (const baseM of [-430, 0, 1250]) {
    const source = [baseM - 800, baseM, baseM + 100, baseM + 4000];
    for (const y of source) {
      assert.equal(risenHeight(y, 0, { sink: 1, baseM }), baseM);
      let prior = baseM;
      for (const rise01 of [0, .01, .1, .25, .5, .9, 1]) {
        const next = risenHeight(y, 5000, { sink: 1 - rise01, baseM });
        assert.ok((next - prior) * (y - baseM) >= -1e-9, 'relief grows toward the source on either side of the base');
        assert.ok(Math.abs(next - baseM) <= Math.abs(y - baseM));
        prior = next;
      }
      assert.equal(prior, y);
      assert.equal(landRiseLift(0, y, 0, null, 0, baseM), 0, 'the complete source is an exact no-op');
    }
  }
});

const vec3 = (x, y = x, z = x) => ({ x, y, z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const normalize = value => {
  const length = Math.hypot(value.x, value.y, value.z);
  return vec3(value.x / length, value.y / length, value.z / length);
};

// Execute the production scalar/vector GLSL with JavaScript vector stand-ins.
function glsl(name, args) {
  const match = LAND_RISE_GLSL.match(new RegExp(`\\w+ ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\}`));
  assert.ok(match, `the shared shader must provide ${name}`);
  const body = match[1].replace(/\b(?:float|vec3) (\w+)/g, 'const $1').replace(/\bmax\(/g, 'Math.max(');
  return new Function(...args, 'vec3', 'normalize', 'dot', body);
}

test('the GPU affine lift and gradient match the CPU, including the exact flat opening', () => {
  const lift = glsl('riseLift', ['p', 'uLandRise']);
  const grad = glsl('riseGrad', ['p', 'uLandRise']);
  const random = rng(11);
  for (let index = 0; index < 2000; index++) {
    const p = vec3((random() - .5) * 40000, (random() - .3) * 6000, (random() - .5) * 40000);
    const sink = index % 5 === 0 ? 1 : index % 5 === 1 ? 0 : random();
    const baseM = (random() - .3) * 3000, uniform = { x: sink, y: baseM };
    assert.equal(lift(p, uniform, vec3, normalize, dot), landRiseLift(p.x, p.y, p.z, null, sink, baseM));
    const gradient = grad(p, uniform, vec3, normalize, dot);
    assert.ok(gradient.x === 0 && gradient.y === -sink && gradient.z === 0);
    const epsilon = .05;
    const derivative = (landRiseLift(p.x, p.y + epsilon, p.z, null, sink, baseM)
      - landRiseLift(p.x, p.y - epsilon, p.z, null, sink, baseM)) / (2 * epsilon);
    assert.ok(Math.abs(gradient.y - derivative) < 1e-8);
  }
});

test('carried normals stay finite at zero relief and perpendicular throughout the rise', () => {
  const carry = glsl('gradNormal', ['n', 'g', 'uLandRise']);
  const random = rng(13);
  for (const rise01 of [0, 1e-9, .01, .5, 1]) {
    for (let index = 0; index < 300; index++) {
      const normal = normalize(vec3(random() - .5, .2 + random(), random() - .5));
      const tangent = normalize(vec3(normal.y, -normal.x, 0));
      const carried = carry(normal, vec3(0, rise01 - 1, 0), { x: 1 - rise01 }, vec3, normalize, dot);
      assert.ok(Object.values(carried).every(Number.isFinite));
      assert.ok(Math.abs(dot(carried, vec3(tangent.x, rise01 * tangent.y, tangent.z))) < 1e-9);
      if (rise01 === 0) assert.ok(carried.x === 0 && carried.y === 1 && carried.z === 0);
      if (rise01 === 1) assert.equal(carried, normal, 'the complete normal is returned unchanged');
    }
  }
  assert.deepEqual(carry(vec3(1, 0, 0), vec3(0, -1, 0), { x: 1 }, vec3, normalize, dot), vec3(0, 1, 0));
});

test('every ground pass applies one affine rise after the musical and glacial lift', () => {
  assert.match(SCENE_VERT, /float drop = riseLift\(p\);\n\s*vRiseGrad = vec4\(riseGrad\(p\), drop\);\n\s*p\.y \+= drop;/);
  assert.match(SCENE_VERT, /vec3 drop = vec3\(riseLift\(liftedA\), riseLift\(liftedB\), riseLift\(liftedC\)\);\n\s*p\.y \+= dot\(bary, lift \+ drop\);/);
  assert.match(SCENE_FRAG, /sunHorizonVisibility\(vUv, stretchedLight\(uLightDir, 1\.0 \+ vRiseGrad\.y\)\)/);
  const uniforms = sceneUniforms(THREE, {});
  assert.ok(uniforms.uLandRise.value.isVector2, 'sink and base retain the existing uniform budget');
  assert.equal(riseFromUniforms(uniforms), null);
  uniforms.uLandRise.value.set(.4, -300);
  assert.deepEqual(riseFromUniforms(uniforms), { sink: .4, baseM: -300 });
  assert.deepEqual(liftBounds(uniforms).rise, { sink: .4, baseM: -300 });
});

test('affine box floors and spheres contain every transformed source point', () => {
  const random = rng(17);
  for (let index = 0; index < 1000; index++) {
    const rise = { sink: random(), baseM: (random() - .4) * 4000 };
    const center = [(random() - .5) * 20000, (random() - .3) * 6000, (random() - .5) * 20000];
    const radius = 1 + random() * 200;
    const sphere = risenSphere(...center, radius, rise);
    assert.equal(sphere.radius, radius);
    const floor = risenFloor(center[1] - radius, center[0] - radius, center[2] - radius, center[0] + radius, center[2] + radius, rise);
    for (let sample = 0; sample < 20; sample++) {
      let direction;
      do { direction = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1]; } while (Math.hypot(...direction) > 1);
      const point = center.map((value, axis) => value + direction[axis] * radius);
      const y = risenHeight(point[1], 0, rise);
      assert.ok(y >= floor - 1e-9);
      assert.ok(Math.hypot(point[0] - center[0], y - sphere.y, point[2] - center[2]) <= sphere.radius + 1e-9);
    }
  }
  assert.equal(risenFloor(1234, 0, 0, 1, 1, null), 1234);
});

test('forest detail follows the flattened tree and reaches the exact source endpoint', () => {
  const attr = (...rows) => ({ count: rows.length, getX: i => rows[i][0], getY: i => rows[i][1], getZ: i => rows[i][2] });
  const geometry = { attributes: { iPos: attr([0, 3500, -5200]), iSize: attr([30, 10, 0]) }, instanceCount: 1 };
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 1, 60000);
  camera.position.set(0, 500, 0); camera.lookAt(0, 0, -5200); camera.updateMatrixWorld();
  assert.equal(forestBatchFootprintPx(geometry, camera, 1280, 720, {}), 0);
  assert.ok(forestBatchFootprintPx(geometry, camera, 1280, 720, { rise: { sink: 1, baseM: 0 } }) > 0);
  const source = forestBatchFootprintPx(geometry, camera, 1280, 720, {});
  assert.equal(forestBatchFootprintPx(geometry, camera, 1280, 720, { rise: { sink: 0, baseM: 4000 } }), source);
});
