// Range v2 Task 13: valley mist and local light.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mistAmount, mistMask, mistParams, mistDrift, emitterStrength, MIST_GLSL, MIST_NOISE_M, MIST_DRIFT, SEA_DENSITY,
  meanLayer, easeMistSteps, tourMistCap, tourMistFade, MIST_OCTAVE_ROTATION, MIST_SAMPLES, MIST_STEP_EASE_SEC,
  emitterVisibility, seaSubmersion, seaLightReach, EMITTER_GLSL, EMITTER_SUBMERGE, SEA_TOP_SOFT_BELOW_M, SEA_TOP_SOFT_ABOVE_M,
} from '../src/world/alpine/RangeAtmosphere.js';

const cam = [0, 1500, 0];
const params = { density: 4e-4, baseM: 480, heightM: 250, tSec: 12 };

test('zero density is the identity', () => {
  assert.equal(mistAmount(cam, [9000, 500, -12000], { ...params, density: 0 }), 0);
  assert.equal(mistAmount(cam, [9000, 500, -12000], {}), 0);
});

test('a nearer object on the same ray receives no more mist than one behind it', () => {
  for (const far of [[9000, 500, -12000], [-4000, 700, -8000], [2000, 480, -3000]]) {
    const whole = mistAmount(cam, far, params);
    for (const f of [0.2, 0.5, 0.8]) {
      const near = cam.map((c, i) => c + (far[i] - c) * f);
      assert.ok(mistAmount(cam, near, params) <= whole + 1e-12, `nearer point at ${f} gets more mist`);
    }
  }
});

test('mist settles in the valley: low rays gather far more than high ones', () => {
  let low = 0, high = 0;
  for (let k = 0; k < 20; k++) {
    const x = -8000 + k * 800;
    low += mistAmount(cam, [x, 500, -12000], params);
    high += mistAmount(cam, [x, 2600, -12000], params);
  }
  assert.ok(low > 4 * high, `valley ${low.toFixed(3)} vs summits ${high.toFixed(3)}`);
  assert.ok(low / 20 < 0.95, 'never a solid wall');
});

test('banks are irregular, not a uniform sheet', () => {
  const vals = [];
  for (let k = 0; k < 60; k++) vals.push(mistMask(k * 330, -k * 170, 0));
  assert.ok(Math.min(...vals) < 0.1 && Math.max(...vals) > 0.9);
});

test('drift is pure in heard time: pause holds it, seek reconstructs it', () => {
  const p = [6000, 520, -9000];
  const at = (t) => mistAmount(cam, p, { ...params, tSec: t });
  const first = at(42);
  at(100); at(3);
  assert.equal(at(42), first);
  assert.equal(at(42), at(42));
  // It does move with time: slowly (metres per second).
  assert.notEqual(mistMask(1000, 1000, 0), mistMask(1000, 1000, 400));
  assert.ok(Math.abs(mistMask(1000, 1000, 0) - mistMask(1000, 1000, 0.5)) < 0.02);
});

test('mist parameters follow the view: water level, wetness, calm', () => {
  const wet = mistParams({ rules: { wetness: 0.8 }, waterLevelM: 488, heightRange: [300, 2760] });
  const dry = mistParams({ rules: { wetness: 0.1 }, waterLevelM: 488, heightRange: [300, 2760] });
  assert.equal(wet.baseM, 488);
  assert.ok(wet.density > 4 * dry.density);
  assert.ok(mistParams({ rules: { wetness: 0.8 }, calm01: 1 }).density > mistParams({ rules: { wetness: 0.8 }, calm01: 0 }).density);
  assert.ok(Number.isFinite(mistParams({ heightRange: [300, 2760] }).baseM), 'no water: a valley-floor fallback');
});

test('a cloud sea floods the valley below a flat top that stays under the eye', () => {
  const view = { rules: { wetness: 0.5 }, waterLevelM: 800, heightRange: [750, 2300], cameraY: 2200 };
  const calm = mistParams(view);
  assert.equal(calm.fill, 0);
  assert.ok(calm.topM > 1e8, 'no top without a cloud sea');
  const full = mistParams({ ...view, sea01: 1 });
  assert.equal(full.fill, 1);
  assert.ok(full.topM > 800 && full.topM < 2200, `top ${full.topM} between floor and eye`);
  assert.ok(full.density > calm.density);
  assert.ok(mistParams({ ...view, sea01: 0.5 }).topM < full.topM, 'it rises as it fills');
  // It wells up out of the valley: a thin sea sits near the floor and the
  // density blends in with no step where the sea takes over.
  const thin = mistParams({ ...view, sea01: 0.05 });
  assert.ok(thin.topM - 800 < 0.1 * (2200 - 800), `a thin sea's top ${thin.topM} sits near the floor`);
  let last = calm.density;
  for (let k = 1; k <= 20; k++) {
    const d = mistParams({ ...view, sea01: k / 20 }).density;
    assert.ok(d >= last && d - last <= (SEA_DENSITY - calm.density) / 20 + 1e-12, `density steps at ${k / 20}`);
    last = d;
  }
  assert.equal(mistParams({ ...view, sea01: 1, cameraY: 700 }).fill, 0, 'never with the eye below the floor');
  // Looking down into it: thick below the top, clear above it.
  const p = { ...full, tSec: 0 };
  const cam = [0, 2200, 0];
  assert.ok(mistAmount(cam, [0, 900, -3000], p) > 0.8, 'the valley floor is under cloud');
  assert.ok(mistAmount(cam, [0, full.topM + 200, -1500], p) < mistAmount(cam, [0, 900, -1500], p) * 0.5, 'a peak above the top stands clear');
});

test('a light is seen through the same mist as the ground under it', () => {
  const view = { rules: { wetness: 0.5 }, waterLevelM: 800, heightRange: [750, 2300], cameraY: 2200 };
  const eye = [0, 2200, 0];
  // Valley mist only (no sea): exactly the terrain's mist, atmosphere applied again.
  const calm = { ...mistParams({ ...view, calm01: 1 }), steps: MIST_SAMPLES, atm: 0.7 };
  for (const p of [[0, 820, -4000], [2500, 1100, -9000], [-600, 1800, -2000]]) {
    const seen = emitterVisibility(eye, p, calm);
    assert.ok(Math.abs(seen - (1 - mistAmount(eye, p, calm) * 0.7)) < 1e-12, `parity at ${p}`);
    assert.ok(seen < 1 && seen > 0);
  }
  // Clear air, or no fog state at all, hides nothing.
  assert.equal(emitterVisibility(eye, [0, 820, -4000], null), 1);
  assert.equal(emitterVisibility(eye, [0, 820, -4000], { density: 0, fill: 0, topM: 1e9 }), 1);
});

test('a light sunk under a full cloud sea is gone, one standing above its top is not', () => {
  const view = { rules: { wetness: 0.5 }, waterLevelM: 800, heightRange: [750, 2300], cameraY: 2200 };
  const eye = [0, 2200, 0];
  const full = { ...mistParams({ ...view, sea01: 1 }), steps: MIST_SAMPLES, atm: 1 };
  assert.equal(EMITTER_SUBMERGE, 1, 'they disappear under the sea');
  // A lantern on the lake 2 km out: the ground beside it keeps a trace
  // through the thin near cloud, the lantern itself does not.
  const lake = [0, 802, -2000];
  assert.ok(mistAmount(eye, lake, full) < 0.98, 'the ground keeps a trace');
  assert.ok(emitterVisibility(eye, lake, full) < 1e-6, 'the lantern is gone');
  // On the face above the top the sea takes nothing.
  const face = [0, full.topM + SEA_TOP_SOFT_ABOVE_M + 50, -2500];
  assert.equal(seaSubmersion(face[1], full), 0);
  assert.ok(Math.abs(emitterVisibility(eye, face, full) - (1 - mistAmount(eye, face, full))) < 1e-12);
  // Half a sea: a floor lantern fades with the fill, continuously.
  const half = { ...mistParams({ ...view, sea01: 0.5 }), steps: MIST_SAMPLES, atm: 1 };
  assert.ok(Math.abs(seaSubmersion(lake[1], half) - 0.5) < 1e-9);
  const a = emitterVisibility(eye, lake, half);
  assert.ok(a > 0 && a < 0.5 * (1 - mistAmount(eye, lake, half)) + 1e-12);
  // Across the top's soft edge the light comes back smoothly.
  let last = -1;
  for (let y = full.topM - SEA_TOP_SOFT_BELOW_M - 10; y <= full.topM + SEA_TOP_SOFT_ABOVE_M + 10; y += 5) {
    const sub = seaSubmersion(y, full);
    assert.ok(sub >= 0 && sub <= 1);
    const seen = 1 - sub;
    assert.ok(seen >= last - 1e-12, `no dip at ${y}`);
    last = seen;
  }
});

test('a lantern under the cloud sea lights nothing that stands above its top', () => {
  const m = { topM: 1500, fill: 1 };
  const under = 1500 - SEA_TOP_SOFT_BELOW_M - 20, above = 1500 + SEA_TOP_SOFT_ABOVE_M + 20;
  assert.equal(seaLightReach(under, above, m), 0, 'a peak above the cloud gets no light from below it');
  assert.equal(seaLightReach(under, under - 50, m), 1, 'ground under the sea keeps its pool (the terrain fogs it)');
  assert.equal(seaLightReach(above, under, m), 1, 'a light above the sea still reaches down');
  assert.equal(seaLightReach(under, above, { topM: 1500, fill: 0.4 }), 0.6);
  assert.equal(seaLightReach(under, above, null), 1);
});

test('the emitter and lantern-light shader twins use the same constants', async () => {
  assert.ok(MIST_GLSL.includes('float mistSubmersion(float y)'));
  assert.ok(MIST_GLSL.includes(`uMistTop - ${SEA_TOP_SOFT_BELOW_M.toFixed(1)}`) && MIST_GLSL.includes(`uMistTop + ${SEA_TOP_SOFT_ABOVE_M.toFixed(1)}`));
  assert.ok(EMITTER_GLSL.includes('mistAmount(uCameraPos, p) * uNarrative.y'));
  assert.ok(EMITTER_GLSL.includes(`${EMITTER_SUBMERGE.toFixed(3)} * sub`));
  const { ACTOR_GLSL } = await import('../src/world/alpine/ActorsGL.js');
  assert.ok(ACTOR_GLSL.includes('fall *= 1.0 - uMistFill * max(mistSubmersion(uActorPos[i].y) - mistSubmersion(p.y), 0.0)'));
  // actorLight reads the sea's top: the mist uniforms must be declared above it.
  const { SCENE_FRAG } = await import('../src/world/alpine/TerrainMaterial.js');
  const { createForest } = await import('../src/world/alpine/ForestGL.js');
  const THREE = await import('../src/vendor/range/three-range.module.js');
  const placed = { mesh: new Float32Array([0, 0, 0, 20, 10, 0, .5, 2]), billboard: new Float32Array(), stride: 8, count: 1 };
  const forest = createForest(THREE, placed, {});
  for (const [name, frag] of [['terrain', SCENE_FRAG], ['forest', forest.byBand.near[0].material.fragmentShader]]) {
    const top = frag.indexOf('uniform float uMistTop;'), light = frag.indexOf('vec3 actorLight(');
    assert.ok(top >= 0 && light > top, `${name}: MIST_GLSL precedes ACTOR_GLSL`);
    assert.equal(frag.split('uniform float uMistTop;').length, 2, `${name}: declared once`);
  }
  for (const m of [...Object.values(forest.byBand).flat(), ...forest.depth]) m.geometry.dispose();
});

test('local light is bounded and softened with height', () => {
  const full = emitterStrength({});
  assert.ok(full > 0 && full <= 0.22);
  assert.ok(emitterStrength({ airbornePx: 500 }) < full * 0.5);
  assert.ok(emitterStrength({ airbornePx: 500 }) > 0);
});

test('the shader twin uses the same constants', () => {
  for (const k of ['uniform vec2 uMistDrift[3]', `${MIST_NOISE_M.toFixed(1)}`, 'smoothstep(0.35, 0.75, n)', '2.0 * (1.0 - s)',
    '(xz + uMistDrift[0])', '(xz + uMistDrift[1])', '(xz + uMistDrift[2])']) {
    assert.ok(MIST_GLSL.includes(k), `GLSL lacks ${k}`);
  }
});

test('the banks do not slide as one sheet: each octave drifts on its own heading, with a sway', () => {
  assert.equal(MIST_DRIFT.length, 3);
  const heading = ({ v }) => Math.atan2(v[1], v[0]);
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    assert.ok(Math.abs(heading(MIST_DRIFT[i]) - heading(MIST_DRIFT[j])) > 0.5, `octaves ${i} and ${j} share a heading`);
  }
  // Velocity changes over time (a sway), but stays at metres per second.
  const vel = (t) => mistDrift(t + 0.5).map((d, i) => Math.hypot(d[0] - mistDrift(t - 0.5)[i][0], d[1] - mistDrift(t - 0.5)[i][1]));
  const speeds = [0, 20, 40, 60, 80].map((t) => vel(t)[0]);
  assert.ok(Math.max(...speeds) - Math.min(...speeds) > 0.5, `octave 0 speed is constant: ${speeds.map((v) => v.toFixed(2))}`);
  for (let t = 0; t < 600; t += 7) for (const v of vel(t)) assert.ok(v < 6, `${v.toFixed(2)} m/s at ${t}s`);
  // A pure function of heard time.
  assert.deepEqual(mistDrift(42), mistDrift(42));
});

test('sky hierarchy: a secondary moon and sparse clouds that drift together, purely in time', async () => {
  const { rangeV2MoonRadius, rangeCloudBanks } = await import('../src/world/alpine/RangeSkyComposition.js');
  const R = rangeV2MoonRadius(1280, 1);
  assert.ok(Math.abs((2 * R) / 1280 - 0.035) < 0.002, 'about 3.5% of the width across');
  assert.ok(rangeV2MoonRadius(1280, 5) <= 1280 * 0.0175 * 1.25 + 1e-9, 'approach growth is capped');
  const a = rangeCloudBanks({ width: 1280, height: 720, tSec: 30, seed: 7 });
  const b = rangeCloudBanks({ width: 1280, height: 720, tSec: 30, seed: 7 });
  assert.deepEqual(a, b);
  assert.ok(a.length <= 8, 'sparse');
  // One wind: every bank drifts the same way, slowly (a few px a second).
  const later = rangeCloudBanks({ width: 1280, height: 720, tSec: 31, seed: 7 });
  for (let i = 0; i < a.length; i++) {
    const dx = later[i].x - a[i].x;
    if (Math.abs(dx) > 100) continue; // wrapped round, off frame
    assert.ok(dx > 0 && dx < 5, `${a[i].id} moved ${dx}`);
  }
  // A camera swing and tilt carry the whole sky together.
  const panned = rangeCloudBanks({ width: 1280, height: 720, tSec: 30, seed: 7, panPx: 40, panYPx: -12 });
  for (let i = 0; i < a.length; i++) {
    const dx = panned[i].x - a[i].x;
    assert.ok(Math.abs(panned[i].y - a[i].y + 12) < 1e-9);
    if (Math.abs(dx) > 100) continue;
    assert.ok(Math.abs(dx - 40) < 1e-6, `${a[i].id} panned ${dx}`);
  }
});

test('fewer fog samples (the quality ladder) approximate the full integral and never exceed the full sample count', () => {
  // Single rays land on different puffs of the ~900 m mask; what must hold
  // is the amount of haze over the frame.
  const mean = (steps) => {
    let a = 0, n = 0;
    for (let x = -12000; x <= 12000; x += 1500) for (let z = -24000; z <= -2000; z += 1500) {
      for (const y of [500, 700, 1000]) { a += mistAmount(cam, [x, y, z], { ...params, steps }); n++; }
    }
    return a / n;
  };
  const full = mean(6);
  for (const steps of [4, 3, 2]) {
    const lite = mean(steps);
    assert.ok(Math.abs(lite / full - 1) < 0.05, `${steps} steps: frame haze ${lite.toFixed(4)} vs ${full.toFixed(4)}`);
  }
  const far = [9000, 500, -12000];
  // Asking for more than MIST_SAMPLES is the full integral, not more work.
  assert.equal(mistAmount(cam, far, { ...params, steps: 99 }), mistAmount(cam, far, params));
  // The shader bounds its loop the same way.
  assert.match(MIST_GLSL, /if \(float\(i\) >= n\) break;/);
  assert.match(MIST_GLSL, /float od = uMistDensity \* length\(d\) \* mistMeanLayer\(cam\.y, p\.y\) \* banks;/);
});

test('the sky turns with the camera: a far landmark and the clouds pan alike', async () => {
  const { skyTurn } = await import('../src/world/alpine/RangeSkyComposition.js');
  const { applyCameraMoves } = await import('../src/world/alpine/RangeCamera.js');
  const { cameraBasis, projectPoint } = await import('../src/world/terrain/SceneTravel.js');
  const rail = { eyeM: [0, 2000, 0], targetM: [0, 1000, 20000], fovYDeg: 40 };
  const ref = cameraBasis(rail).forward;
  const still = skyTurn(rail, ref);
  assert.ok(Math.abs(still.x) < 1e-9 && Math.abs(still.y) < 1e-9);
  // A star straight down the rail's view (clouds hang far beyond the land):
  // in NDC of any lens the turn lands where it does, sideways for a swing,
  // up the frame for a crane.
  const peak = rail.eyeM.map((v, i) => v + ref[i] * 1e8);
  for (const move of [{ yaw: 0.05 }, { crane: 0.03 }, { yaw: -0.04, crane: 0.02 }]) {
    const moved = applyCameraMoves(rail, { dolly: 0, yaw: 0, crane: 0, truck: 0, kind: 'orbit', ...move }, null);
    const turn = skyTurn(moved, ref);
    for (const fovYDeg of [18, 40]) {
      const tanY = Math.tan(fovYDeg * Math.PI / 360);
      const q = projectPoint({ ...moved, fovYDeg }, 16 / 9, peak);
      assert.ok(Math.abs(turn.x / (tanY * 16 / 9) - q.x) < 2e-3, `${JSON.stringify(move)} x at ${fovYDeg}`);
      assert.ok(Math.abs(turn.y / tanY - q.y) < 2e-3, `${JSON.stringify(move)} y at ${fovYDeg}`);
    }
    if (move.yaw) assert.ok(Math.abs(turn.x) > 0.01);
    if (move.crane) assert.ok(turn.y > 0.005, 'craning up tips the sky up the frame');
  }
});

test('the sky pan uses the scene\'s own moved pose and follows a late-joining view only as it fades in', async () => {
  const { RangePresentation } = await import('../src/world/alpine/RangePresentation.js');
  const { cameraBasis } = await import('../src/world/terrain/SceneTravel.js');
  const rail = { eyeM: [0, 2000, 0], targetM: [0, 1000, 20000], fovYDeg: 40 };
  // Each view's scene pose: A swung one way, B the other (as if lifted or
  // turned by the scene's own constraints).
  const swing = (yaw) => {
    const f = cameraBasis(rail).forward, c = Math.cos(yaw), s = Math.sin(yaw);
    return { ...rail, targetM: [rail.eyeM[0] + (f[0] * c - f[2] * s) * 2e4, rail.eyeM[1] + f[1] * 2e4, rail.eyeM[2] + (f[0] * s + f[2] * c) * 2e4] };
  };
  const proj = { fovYDeg: 40, aspect: 16 / 9 };
  const scene = { movedPose: (v) => ({ rail, proj, pose: swing(v.id === 'a' ? 0.04 : -0.04) }) };
  const frame = { cameraMove: { yaw: 0 }, scenicViewport: { logicalWidth: 1280, logicalHeight: 720 } };
  const pan = (seamP, incomingFade, incoming = { id: 'b' }) =>
    RangePresentation.prototype._skyPan.call({ scene, shots: { timeline: () => null }, seamP, incomingFade }, { id: 'a' }, incoming, frame);
  const alone = pan(0.5, 1, null);
  assert.ok(Math.abs(alone.x) > 0.02, 'the scene pose drives the pan');
  assert.deepEqual(pan(0.5, 0), alone, 'a view that has just joined (still invisible) moves nothing');
  const half = pan(0.5, 1), end = pan(1, 1);
  assert.ok(Math.abs(half.x) < Math.abs(alone.x));
  assert.ok(Math.sign(end.x) === -Math.sign(alone.x), 'across the seam the pan is the incoming view\'s');
});

// --- Seams and sudden changes (fog fix) -------------------------------------

test('the layer is integrated exactly along the ray, through the valley floor and a cloud-sea top', () => {
  const numeric = (y0, y1, o) => {
    let sum = 0; const N = 20000;
    for (let i = 0; i < N; i++) {
      const y = y0 + (y1 - y0) * (i + .5) / N;
      const e = Math.exp(-Math.max(0, y - o.baseM) / o.heightM);
      const lo = (o.topM ?? 1e9) - 60, hi = (o.topM ?? 1e9) + 30;
      const slab = Math.min(1, Math.max(0, (hi - y) / (hi - lo)));
      sum += e + ((o.fill ?? 0) * (slab - e));
    }
    return sum / N;
  };
  const cases = [[1500, 500], [1500, 300], [400, 300], [600, 600.0001], [2200, 900], [900, 2200]];
  for (const o of [{ baseM: 480, heightM: 250 }, { baseM: 480, heightM: 250, topM: 1200, fill: 0.7 }]) {
    for (const [y0, y1] of cases) assert.ok(Math.abs(meanLayer(y0, y1, o) - numeric(y0, y1, o)) < 1e-4, `${y0}->${y1} ${JSON.stringify(o)}`);
  }
});

test('haze is smooth across the frame: no slices, steps or seams between neighbouring rays', () => {
  for (const y of [500, 900]) {
    let worst = 0;
    for (let x = -6000; x < 6000; x += 3) {
      const a = mistAmount(cam, [x, y, -9000], params), b = mistAmount(cam, [x + 3, y, -9000], params);
      worst = Math.max(worst, Math.abs(a - b));
    }
    assert.ok(worst < 0.004, `3 m apart differ by ${worst.toFixed(4)}`);
  }
  // A ray sweeping down through the layer changes smoothly with depth too.
  let worst = 0, last = mistAmount(cam, [0, 2400, -9000], params);
  for (let y = 2399; y >= 300; y--) { const v = mistAmount(cam, [0, y, -9000], params); worst = Math.max(worst, Math.abs(v - last)); last = v; }
  assert.ok(worst < 0.004, `1 m of height changes haze by ${worst.toFixed(4)}`);
});

test('octave lattices are turned apart from each other and from the terrain axes', () => {
  const quarter = Math.PI / 2;
  const off = (a) => { const r = ((a % quarter) + quarter) % quarter; return Math.min(r, quarter - r); };
  for (const a of MIST_OCTAVE_ROTATION) assert.ok(off(a) > 0.2, `octave at ${a} rad is near a grid axis`);
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    assert.ok(off(MIST_OCTAVE_ROTATION[i] - MIST_OCTAVE_ROTATION[j]) > 0.2, `octaves ${i}/${j} share grid lines`);
  }
  assert.doesNotMatch(MIST_GLSL, /sin\(p\.x \* 127\.1/, 'no fract(sin) lattice hash');
  assert.match(MIST_GLSL, /0x27d4eb2du/);
});

test('mask values do not line up along any straight lattice direction', () => {
  // Correlation of lattice values with their neighbours along many directions.
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1], [2, 5], [5, 2], [3, 7]]) {
    let sxy = 0, sx = 0, sy = 0, sxx = 0, syy = 0, n = 0;
    for (let i = -400; i < 400; i += 3) for (let j = -400; j < 400; j += 7) {
      const a = mistMask(i * 900, j * 900, 0), b = mistMask((i + dx) * 900, (j + dy) * 900, 0);
      sxy += a * b; sx += a; sy += b; sxx += a * a; syy += b * b; n++;
    }
    const r = (sxy / n - sx / n * sy / n) / Math.sqrt((sxx / n - (sx / n) ** 2) * (syy / n - (sy / n) ** 2));
    assert.ok(Math.abs(r) < 0.3, `direction ${dx},${dy}: correlation ${r.toFixed(3)}`);
  }
});

test('a rung change eases across fractional sample counts; pause holds, seek snaps', () => {
  const far = [3000, 520, -9000];
  const at = (steps) => mistAmount(cam, far, { ...params, steps });
  // Between two counts the haze lies between their values, continuously.
  for (const [a, b] of [[4, 5], [5, 6], [2, 3]]) {
    const lo = Math.min(at(a), at(b)), hi = Math.max(at(a), at(b));
    let last = at(a);
    for (let k = 1; k <= 20; k++) {
      const v = at(a + k / 20);
      assert.ok(v >= lo - 1e-12 && v <= hi + 1e-12);
      assert.ok(Math.abs(v - last) <= (hi - lo) / 10 + 1e-9, 'no jump inside the blend');
      last = v;
    }
  }
  let s = MIST_SAMPLES, t = 0;
  const frames = [];
  while (t < 3) { s = easeMistSteps(s, 4, 1 / 30); frames.push(s); t += 1 / 30; }
  assert.ok(frames[0] < MIST_SAMPLES && frames[0] > 4, 'one frame moves a little');
  assert.equal(frames.at(-1), 4);
  const reachedAt = frames.findIndex(v => v === 4) / 30;
  assert.ok(Math.abs(reachedAt - 2 / (MIST_SAMPLES - 1) * MIST_STEP_EASE_SEC) < 0.1);
  assert.equal(easeMistSteps(5.2, 4, 0), 5.2, 'paused');
  assert.equal(easeMistSteps(5.2, 4, -3), 4, 'seek back');
  assert.equal(easeMistSteps(5.2, 4, 12), 4, 'seek forward');
  assert.equal(easeMistSteps(undefined, 3, 1 / 30), 3, 'first frame');
});

test('the tour ceiling is continuous in time and the fog thins out instead of switching off', () => {
  const poseAt = (t) => ({ eyeM: [0, 1500 + 400 * Math.sin(t / 7000) + (t > 24000 ? -300 * Math.min(1, (t - 24000) / 3000) : 0), 0] });
  let last = tourMistCap(poseAt, 0, 60000), worst = 0;
  for (let t = 50; t <= 60000; t += 50) {
    const v = tourMistCap(poseAt, t, 60000);
    worst = Math.max(worst, Math.abs(v - last)); last = v;
  }
  assert.ok(worst < 20, `ceiling jumps ${worst.toFixed(1)} m in 50 ms`);
  assert.ok(tourMistCap(poseAt, 21000, 60000) < Math.min(poseAt(21000).eyeM[1], poseAt(27000).eyeM[1]) - 119, 'looks ahead');
  let prev = 0;
  for (let gap = 0; gap <= 300; gap += 5) {
    const f = tourMistFade(500 + gap, 500);
    assert.ok(f >= prev && f - prev < 0.08, `fade steps at ${gap} m`); prev = f;
  }
  assert.equal(tourMistFade(530, 500), 0); assert.equal(tourMistFade(700, 500), 1);
});

test('the fog GLSL declares no identifier that GLSL ES 3.00 reserves', () => {
  // A reserved word (flat, smooth, sample, input, output, ...) as a variable
  // name fails the terrain shader's compile and drops Range v2 to legacy.
  const reserved = ['flat', 'smooth', 'centroid', 'sample', 'patch', 'layout', 'input', 'output', 'filter', 'common', 'partition',
    'active', 'superp', 'noperspective', 'resource', 'buffer', 'shared', 'coherent', 'volatile', 'restrict', 'readonly', 'writeonly',
    'fixed', 'half', 'long', 'short', 'double', 'unsigned', 'cast', 'namespace', 'using', 'sizeof', 'typedef', 'union', 'enum',
    'class', 'template', 'this', 'goto', 'inline', 'noinline', 'public', 'static', 'extern', 'external', 'interface'];
  const code = MIST_GLSL.replace(/\/\/[^\n]*/g, '');
  for (const word of reserved) assert.doesNotMatch(code, new RegExp(`\\b${word}\\b`), `GLSL uses reserved word ${word}`);
});
