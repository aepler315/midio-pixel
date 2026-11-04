import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  LAND_RISE_START, LAND_RISE_KNEE, LAND_RISE_GLSL, LAND_RISE_MIN_END, LAND_RISE_CATCH_UP_MS, risenSphere,
  compileLandRise, landRiseLift, risenFloor, risenHeight, riseFromUniforms, risePivot,
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
// The map

test('nothing hidden at full height comes into view, nothing below the eye moves, and rays stay rays', () => {
  const r = rng(7);
  for (let n = 0; n < 4000; n++) {
    // Half the cases pivot above the horizon, as a frame pitched up at a summit does.
    const eye = [(r() - .5) * 2000, 500 + r() * 2000, (r() - .5) * 2000], sink = r(), pivot = r() < .5 ? 0 : r() * .5;
    const azimuth = r() * 2 * Math.PI, dir = [Math.cos(azimuth), Math.sin(azimuth)];
    const at = (d, y) => [eye[0] + dir[0] * d, y, eye[2] + dir[1] * d];
    const drawn = (d, y) => y + landRiseLift(...at(d, y), eye, sink, pivot);
    // P behind Q along the same azimuth, Q at or above the sight line.
    const dP = 50 + r() * 30000, dQ = r() * dP, yP = eye[1] + (r() - .3) * 3000;
    const line = eye[1] + (yP - eye[1]) * dQ / dP, yQ = line + r() * 500;
    const lineDrawn = eye[1] + (drawn(dP, yP) - eye[1]) * dQ / dP;
    assert.ok(drawn(dQ, yQ) >= lineDrawn - 1e-6, `case ${n}: Q no longer hides P`);
    // Land below the eye, or below the pivot's elevation, stays; land above
    // never drops below it.
    const below = eye[1] - r() * 2000;
    assert.equal(landRiseLift(...at(dP, below), eye, sink, pivot), 0);
    assert.equal(landRiseLift(...at(dP, eye[1] + pivot * dP * r()), eye, sink, pivot), 0);
    const yA = eye[1] + r() * 3000;
    assert.ok(drawn(dP, yA) >= Math.min(yA, eye[1] + pivot * dP) - 1e-9);
    // Homogeneous (beyond the first metre): the squash is the same at every distance.
    const k = 1 + r() * 9, d = 1 + r() * 5000, h = r() * 3000;
    assert.ok(Math.abs(landRiseLift(...at(k * d, eye[1] + k * h), eye, sink, pivot) - k * landRiseLift(...at(d, eye[1] + h), eye, sink, pivot)) < 1e-6 * k * (1 + h));
  }
  assert.equal(landRiseLift(0, 5000, 0, [0, 0, 0], 0), 0, 'no sink, no rise');
  assert.equal(landRiseLift(0, 5000, 0, null, .5), 0);
});

test('a shot pitched up at a summit keeps its land and its summit in frame', () => {
  // A 16 degree telephoto 11 degrees up at a summit 12 km away and 2.6 km
  // above the eye: the frame's bottom edge is 3 degrees above the horizon.
  const eye = [0, 600, 0], fov = 16, aspect = 16 / 9, pitch = 11 * Math.PI / 180;
  const forward = [0, Math.sin(pitch), -Math.cos(pitch)], up = [0, Math.cos(pitch), Math.sin(pitch)], right = [1, 0, 0];
  const pivot = risePivot(forward, up, right, fov, aspect);
  const tv = Math.tan(fov * Math.PI / 360), bottom = (Math.sin(pitch) - tv * Math.cos(pitch)) / Math.hypot(Math.cos(pitch) + tv * Math.sin(pitch), tv * aspect);
  assert.ok(pivot > 0 && Math.abs(pivot - bottom) < 1e-12, `the lowest corner: ${pivot} vs ${bottom}`);
  // Elevation in the frame (NDC y, 0 = centre) of a point straight ahead.
  const ndcY = (y, r) => { const a = Math.atan2(y - eye[1], r) - pitch; return Math.tan(a) / tv; };
  const summit = [0, 3200, -12000], r = 12000, sink = 1 - LAND_RISE_START;
  assert.ok(Math.abs(ndcY(summit[1], r)) < 1, 'framed at full height');
  const drawnY = p => summit[1] + landRiseLift(...summit, eye, sink, p);
  assert.ok(ndcY(drawnY(0), r) < -1, 'squashed toward the horizon it would leave the frame');
  const kept = ndcY(drawnY(pivot), r);
  assert.ok(kept > -1 && kept < ndcY(summit[1], r), `pressed down onto the frame's bottom, in view: ${kept}`);
  // Land at the bottom edge stays where it is.
  const edge = eye[1] + bottom * 8000;
  assert.equal(landRiseLift(0, edge, -8000, eye, sink, pivot), 0);
  // Elevation is lowest at a corner of the frame (any roll), and a frame
  // reaching the horizon does not pivot.
  const rr = rng(13);
  for (let n = 0; n < 500; n++) {
    const yaw = rr() * 6.28, p = (rr() - .3) * 1.2, roll = (rr() - .5) * .6, f = 10 + rr() * 60, a = .5 + rr() * 2;
    const fw = [Math.cos(p) * Math.sin(yaw), Math.sin(p), -Math.cos(p) * Math.cos(yaw)];
    const u0 = [-Math.sin(p) * Math.sin(yaw), Math.cos(p), Math.sin(p) * Math.cos(yaw)];
    const r0 = [fw[1] * u0[2] - fw[2] * u0[1], fw[2] * u0[0] - fw[0] * u0[2], fw[0] * u0[1] - fw[1] * u0[0]];
    const rt = r0.map((v, i) => Math.cos(roll) * v + Math.sin(roll) * u0[i]), ut = u0.map((v, i) => Math.cos(roll) * v - Math.sin(roll) * r0[i]);
    const t = Math.tan(f * Math.PI / 360);
    let low = Infinity;
    for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
      const d = fw.map((v, k) => v + (i / 10 - 1) * t * a * rt[k] + (j / 10 - 1) * t * ut[k]);
      low = Math.min(low, d[1] / Math.hypot(d[0], d[2]));
    }
    const got = risePivot(fw, ut, rt, f, a);
    if (low <= 0) assert.equal(got, 0);
    else assert.ok(Math.abs(got - low) < 1e-9 * (1 + low), `case ${n}: ${got} vs ${low}`);
  }
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
    const pivot = r() < .4 ? 0 : r() * .3, rise = { x: sink, y: pivot };
    const p = { x: eye.x + (r() - .5) * 40000, y: eye.y + (r() - .3) * 3000, z: eye.z + (r() - .5) * 40000 };
    const cpu = landRiseLift(p.x, p.y, p.z, [eye.x, eye.y, eye.z], sink, pivot);
    const gpu = lift(p, eye, rise, vec3);
    assert.ok(Math.abs(gpu - cpu) <= 1e-4 * (1 + Math.abs(cpu)), `${gpu} vs ${cpu}`);
    // Gradient against central differences of the CPU twin.
    const g = gradBody(p, eye, rise, vec3), e = .05;
    const f = (dx, dy, dz) => landRiseLift(p.x + dx, p.y + dy, p.z + dz, [eye.x, eye.y, eye.z], sink, pivot);
    const fd = [(f(e, 0, 0) - f(-e, 0, 0)) / (2 * e), (f(0, e, 0) - f(0, -e, 0)) / (2 * e), (f(0, 0, e) - f(0, 0, -e)) / (2 * e)];
    if (Math.abs(p.y - eye.y - pivot * Math.hypot(p.x - eye.x, p.z - eye.z)) > 1 && Math.hypot(p.x - eye.x, p.z - eye.z) > 2) {
      for (const [k, v] of [['x', fd[0]], ['y', fd[1]], ['z', fd[2]]]) assert.ok(Math.abs(g[k] - v) < 2e-3, `d/d${k}: ${g[k]} vs ${v}`);
      // The carried normal stays perpendicular to the lowered surface.
      const nrm = normalize(vec3(r() - .5, .2 + r(), r() - .5));
      const t1 = normalize(vec3(nrm.y, -nrm.x, 0)), t2 = vec3(nrm.y * t1.z - nrm.z * t1.y, nrm.z * t1.x - nrm.x * t1.z, nrm.x * t1.y - nrm.y * t1.x);
      const risen = normalBody(nrm, g, rise, vec3, null, normalize);
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
  assert.match(SCENE_VERT, /float drop = riseLift\(p\);\n\s*vRiseGrad = vec4\(riseGrad\(p\), drop\);\n\s*p\.y \+= drop;/,
    'the gradient and the drop where the rise is taken');
  // A creek takes both at its bank's lifted corners, interpolated as the bank is.
  assert.match(SCENE_VERT, /vec3 drop = vec3\(riseLift\(liftedA\), riseLift\(liftedB\), riseLift\(liftedC\)\);\n\s*p\.y \+= dot\(bary, lift \+ drop\);/);
  assert.match(SCENE_VERT, /vRiseGrad = vec4\(bary\.x \* riseGrad\(liftedA\) \+ bary\.y \* riseGrad\(liftedB\) \+ bary\.z \* riseGrad\(liftedC\), dot\(bary, drop\)\);/);
  assert.match(SCENE_FRAG, /sunHorizonVisibility\(vUv, stretchedLight\(uLightDir, 1\.0 \+ vRiseGrad\.y\)\)/);
  // The ground's normal is carried through the rise before the painted
  // crowns are mixed in: they keep the complete range's, as the mesh trees do.
  const carried = SCENE_FRAG.indexOf('nShade = gradNormal(nShade, vRiseGrad.xyz);');
  assert.ok(carried > 0 && carried < SCENE_FRAG.indexOf('nShade = normalize(mix(nShade, farCrownNormal, farCrownWeight));'));
  assert.match(SCENE_FRAG, /if \(uHasMaterial < 0\.5\) nShade = gradNormal\(nShade, vRiseGrad\.xyz\);/);
  // The painted canopy and the glacier facets read the unlowered surface.
  assert.match(SCENE_FRAG, /vec3 unlowered = vRenderedWorld - vec3\(0\.0, vRiseGrad\.w, 0\.0\);/);
  assert.match(SCENE_FRAG, /if \(uLandRise\.x > 0\.0\) forestRay = normalize\(cameraPosition - unlowered\);/);
  assert.match(SCENE_FRAG, /iceNormal = normalize\(cross\(dFdx\(unlowered\), dFdy\(unlowered\)\)\);/);
  assert.match(SCENE_FRAG, /mix\(nShade, gradNormal\(iceNormal, vRiseGrad\.xyz\), ice\.y\)/);
  assert.match(LAND_RISE_GLSL, /if \(uLandRise\.x <= 0\.0\) return 0\.0;/, 'zero sink is an early out');
  const u = sceneUniforms(THREE, {});
  assert.ok(u.uLandRise.value.isVector2 && u.uLandRise.value.x === 0 && u.uLandRise.value.y === 0, 'uLandRise: the sink and the pivot');
  assert.ok(u.uTourEye.value.isVector4, 'uTourEye carries the tour fade in w');
  assert.equal(riseFromUniforms(u), null);
  u.uLandRise.value.set(.4, .05); u.uTourEye.value.set(1, 2, 3, 0);
  assert.deepEqual(riseFromUniforms(u), { sink: .4, eye: [1, 2, 3], knee: LAND_RISE_KNEE, pivot: .05 });
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
    assert.deepEqual(uniforms.uLandRise.value.toArray(), [sink, 0], `rise01 ${rise01}: this camera looks down at the horizon`);
    assert.deepEqual(uniforms.uTourEye.value.toArray(), [10, 1000, 1000, 0]);
  }
  // Pitched up at a summit, the frame's lowest corner is the pivot, while rising only.
  camera.position.set(0, 1000, 0); camera.lookAt(-3000, 1000 + 10000 * Math.tan(30 * Math.PI / 180), -10000);
  camera.setViewOffset(1280, 720, 640, 0, 640, 360); camera.updateMatrixWorld();
  scene._setUniforms({ uniforms, view }, { ...frame, rise01: .25 });
  // The whole frame's corners, not the partition the view offset draws.
  const lowest = Math.min(...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => {
    const full = camera.clone(); full.clearViewOffset(); full.updateMatrixWorld();
    const d = new THREE.Vector3(x, y, .5).unproject(full).sub(full.position);
    return d.y / Math.hypot(d.x, d.z);
  }));
  assert.ok(lowest > 0 && Math.abs(uniforms.uLandRise.value.y - lowest) < 1e-9, `pivot ${uniforms.uLandRise.value.y} vs ${lowest}`);
  scene._setUniforms({ uniforms, view }, { ...frame, rise01: 1 });
  assert.deepEqual(uniforms.uLandRise.value.toArray(), [0, 0]);
});

// ---------------------------------------------------------------------------
// Bounds: what the rise lowers into view is drawn

test('risenFloor bounds every point the rise draws from a box', () => {
  const r = rng(3);
  for (let n = 0; n < 2000; n++) {
    const rise = { sink: r(), eye: [(r() - .5) * 4000, 500 + r() * 2000, (r() - .5) * 4000], knee: LAND_RISE_KNEE, pivot: r() < .5 ? 0 : r() * .3 };
    const x0 = rise.eye[0] + (r() - .5) * 20000, z0 = rise.eye[2] + (r() - .5) * 20000, x1 = x0 + r() * 3000, z1 = z0 + r() * 3000;
    const y0 = rise.eye[1] + (r() - .5) * 3000, y1 = y0 + r() * 2000;
    const floor = risenFloor(y0, x0, z0, x1, z1, rise);
    assert.ok(floor <= y0);
    for (let k = 0; k < 16; k++) {
      const x = x0 + r() * (x1 - x0), z = z0 + r() * (z1 - z0), y = y0 + r() * (y1 - y0);
      const drawn = y + landRiseLift(x, y, z, rise.eye, rise.sink, rise.pivot);
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
  const rise = { sink: 1 - LAND_RISE_START, eye: [0, 1000, 0], knee: LAND_RISE_KNEE, pivot: 0 };
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
  u.uLandRise.value.set(rise.sink, 0); u.uTourEye.value.set(...rise.eye, 1);
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
  // Without a rise the footprint is exactly what it was, and as the rise
  // completes it becomes that: no detail pop on the last frame of the climb.
  const inView = { attributes: { iPos: attr([0, 900, -3000]), iSize: attr([30, 10, 0]) }, instanceCount: 1 };
  const complete = forestBatchFootprintPx(inView, camera, 1280, 720, {});
  assert.equal(forestBatchFootprintPx(inView, camera, 1280, 720, { rise: null }), complete);
  assert.equal(forestBatchFootprintPx(inView, camera, 1280, 720, { rise: { ...rise, sink: 1e-9 } }), complete, 'below the eye');
  const high = { attributes: { iPos: attr([0, 3500, -5200]), iSize: attr([30, 10, 0]) }, instanceCount: 1 };
  const wide = new THREE.PerspectiveCamera(80, 16 / 9, 1, 60000);
  wide.position.copy(camera.position); wide.lookAt(0, 3000, -5200); wide.updateMatrixWorld();
  const full = forestBatchFootprintPx(high, wide, 1280, 720, {});
  assert.ok(full > 0 && Math.abs(forestBatchFootprintPx(high, wide, 1280, 720, { rise: { ...rise, sink: 1e-9 } }) - full) < 1e-6 * full, 'above the eye');
  // The moved sphere holds every lowered point of the tree's own sphere.
  const r = rng(7);
  let worst = 0;
  for (let n = 0; n < 3000; n++) {
    const sink = r(), eye = [0, 1000, 0], R = 2 + r() * 80;
    const c = [(r() - .5) * 2 * (50 + r() * 9000), 800 + r() * 3200, (r() - .5) * 2 * (50 + r() * 9000)];
    const pivot = r() < .5 ? 0 : r() * .3;
    const moved = risenSphere(...c, R, { sink, eye, knee: LAND_RISE_KNEE, pivot });
    assert.ok(moved.radius >= R && moved.y <= c[1]);
    for (let k = 0; k < 64; k++) {
      let d; do { d = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1]; } while (Math.hypot(...d) > 1);
      if (k < 8) { const l = Math.hypot(...d) || 1; d = d.map(v => v / l); } // the surface too
      const p = d.map((v, i) => c[i] + v * R);
      const y = p[1] + landRiseLift(...p, eye, sink, pivot);
      worst = Math.max(worst, Math.hypot(p[0] - c[0], y - moved.y, p[2] - c[2]) / moved.radius);
    }
  }
  assert.ok(worst <= 1 + 1e-9, `a drawn point outside the moved sphere (${worst})`);
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
