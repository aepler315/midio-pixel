import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mirrorScissor, waterScissor, waterBoxes, vertexWaterBoxes, liftBounds, shiverBounds, WATER_BOX_M } from '../src/world/alpine/MirrorScissor.js';
import { glacierErrors, glacierSample } from '../src/world/alpine/GlacierField.js';
import { sceneDeformation } from '../src/world/alpine/RangeFrame.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
// Column-major perspective * lookAt, enough to exercise real projections.
function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookAt(eye, target) {
  const sub = (a, b) => a.map((v, i) => v - b[i]), norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const z = norm(sub(eye, target)), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const bias = [.5, 0, 0, 0, 0, .5, 0, 0, 0, 0, .5, 0, .5, .5, .5, 1];
const apply = (m, p) => [0, 1, 2, 3].map(r => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);

test('every texel a visible lake fragment can read lies in the scissor', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(seed), level = 1300, eyeY = level + 50 + r() * 600;
    const eye = [r() * 400, eyeY, r() * 400], target = [eye[0] + (r() - .5) * 3000, level - r() * 200, eye[2] - 2000 - r() * 3000];
    const proj = perspective(.6, 16 / 9, 20, 150000);
    const viewProj = mul(proj, lookAt(eye, target));
    const mirrorEye = [eye[0], level - .45 * (eyeY - level), eye[2]], mirrorTarget = [target[0], 2 * level - target[1], target[2]];
    const mirror = mul(bias, mul(proj, lookAt(mirrorEye, mirrorTarget)));
    // Lake triangles scattered around and behind the camera.
    const positions = [], index = [];
    for (let t = 0; t < 400; t++) {
      const cx = eye[0] + (r() - .5) * 8000, cz = eye[2] + (r() - .7) * 8000;
      for (let v = 0; v < 3; v++) { index.push(positions.length / 3); positions.push(cx + (r() - .5) * 60, level + (r() - .5) * 4, cz + (r() - .5) * 60); }
    }
    const boxes = waterBoxes([{ positions: Float32Array.from(positions), index: Uint32Array.from(index) }]);
    const u = { uDeformAmp: { value: 3 * r() }, uDeformKick: { value: r() }, uDeformStructural: { value: 0 }, uDeformMelodic: { value: r() }, uDeformGesture: { value: 0 },
      uMirrorRipple: { value: .004 }, uWakeAmt: { value: r() }, uWaterGust: { value: [{ y: r() }] }, uStorm: { value: { x: r() } },
      uWaterMusic: { value: { x: r(), y: r() } }, uWaterAccent: { value: [{ y: r() }] } };
    const lift = liftBounds(u), shiver = shiverBounds(u);
    const W = 704, H = 424;
    const rect = mirrorScissor(boxes, mirror, viewProj, lift, shiver, W, H);
    if (!rect) continue;
    const realShiver = { x: shiver.x / 2, y: shiver.y / 2 }; // the unscaled bound
    let checked = 0;
    for (let t = 0; t < index.length; t += 3) {
      for (let n = 0; n < 30; n++) {
        let a = r(), b = r(); if (a + b > 1) { a = 1 - a; b = 1 - b; }
        const p = [0, 1, 2].map(k => positions[index[t] * 3 + k] + a * (positions[index[t + 1] * 3 + k] - positions[index[t] * 3 + k]) + b * (positions[index[t + 2] * 3 + k] - positions[index[t] * 3 + k]));
        p[1] += (r() * 2 - 1) * (u.uDeformAmp.value + u.uDeformKick.value + u.uDeformMelodic.value);
        const c = apply(viewProj, p);
        if (!(c[3] > 0) || Math.abs(c[0]) > c[3] || Math.abs(c[1]) > c[3] || Math.abs(c[2]) > c[3]) continue; // not drawn
        const mc = apply(mirror, p);
        if (!(mc[3] > 0)) continue; // never reads the mirror
        const su = Math.min(.999, Math.max(.001, mc[0] / mc[3] + (r() * 2 - 1) * realShiver.x));
        const sv = Math.min(.999, Math.max(.001, mc[1] / mc[3] + (r() * 2 - 1) * realShiver.y));
        // The bilinear footprint of that fetch.
        for (const tx of [Math.floor(su * W - .5), Math.floor(su * W - .5) + 1]) for (const ty of [Math.floor(sv * H - .5), Math.floor(sv * H - .5) + 1]) {
          const x = Math.min(W - 1, Math.max(0, tx)), y = Math.min(H - 1, Math.max(0, ty));
          assert.ok(x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height, `seed ${seed}: texel ${x},${y} outside ${JSON.stringify(rect)}`);
        }
        checked++;
      }
    }
    assert.ok(checked > 0 || rect.width * rect.height === 0, `seed ${seed} checked nothing`);
  }
});

test('unknown bounds draw the whole mirror; a box at the camera plane widens to the clamp', () => {
  const box = Float64Array.of(-1, -1, -1, 1, 1, 1);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.equal(mirrorScissor(box, identity, null, { lo: NaN, hi: 0 }, { x: 0, y: 0 }, 10, 10), null);
  // w = z + 0: the box spans the camera plane, so its quotients are unbounded.
  const straddle = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
  assert.deepEqual(mirrorScissor(box, straddle, null, { lo: 0, hi: 0 }, { x: 0, y: 0 }, 10, 10), { x: 0, y: 0, width: 10, height: 10 });
  // Entirely behind: never read.
  const behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 0, -5];
  assert.deepEqual(mirrorScissor(box, behind, null, { lo: 0, hi: 0 }, { x: 0, y: 0 }, 10, 10), { x: 0, y: 0, width: 0, height: 0 });
});

test('every pixel a lake triangle can draw in the main view lies in the water scissor', () => {
  let inside = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(seed), level = 1300, eyeY = level + 20 + r() * 900;
    const eye = [r() * 400, eyeY, r() * 400], target = [eye[0] + (r() - .5) * 3000, level - r() * 300, eye[2] - 1000 - r() * 3000];
    // Some views hold the lake under and behind the camera too.
    const viewProj = mul(perspective(.4 + r() * .8, 16 / 9, 5 + r() * 20, 150000), lookAt(eye, target));
    const positions = [], index = [];
    for (let t = 0; t < 300; t++) {
      const cx = eye[0] + (r() - .5) * 6000, cz = eye[2] + (r() - .8) * 6000, s = 5 + r() * 120;
      for (let v = 0; v < 3; v++) { index.push(positions.length / 3); positions.push(cx + (r() - .5) * s, level + (r() - .5) * 6, cz + (r() - .5) * s); }
    }
    const boxes = waterBoxes([{ positions: Float32Array.from(positions), index: Uint32Array.from(index) }]);
    const u = { uDeformAmp: { value: 20 * r() }, uDeformKick: { value: 5 * r() }, uDeformStructural: { value: 10 * r() }, uDeformMelodic: { value: 0 }, uDeformGesture: { value: 0 },
      uLandDance: { value: { x: 10 * r(), z: 6 * r() } } };
    const lift = liftBounds(u), reach = (u.uDeformAmp.value + u.uDeformKick.value + u.uDeformStructural.value + u.uLandDance.value.x + Math.SQRT2 * u.uLandDance.value.z);
    const W = 1280, H = 720;
    const rect = waterScissor(boxes, viewProj, lift, W, H);
    assert.ok(rect, `seed ${seed}`);
    for (let t = 0; t < index.length; t += 3) {
      for (let n = 0; n < 40; n++) {
        let a = r(), b = r(); if (a + b > 1) { a = 1 - a; b = 1 - b; }
        const p = [0, 1, 2].map(k => positions[index[t] * 3 + k] + a * (positions[index[t + 1] * 3 + k] - positions[index[t] * 3 + k]) + b * (positions[index[t + 2] * 3 + k] - positions[index[t] * 3 + k]));
        p[1] += (r() * 2 - 1) * reach;
        const c = apply(viewProj, p);
        if (!(c[3] > 0) || Math.abs(c[0]) > c[3] || Math.abs(c[1]) > c[3] || Math.abs(c[2]) > c[3]) continue; // not drawn
        const x = Math.min(W - 1, Math.floor((c[0] / c[3] + 1) / 2 * W)), y = Math.min(H - 1, Math.floor((c[1] / c[3] + 1) / 2 * H));
        assert.ok(x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height, `seed ${seed}: pixel ${x},${y} outside ${JSON.stringify(rect)}`);
        inside++;
      }
    }
  }
  assert.ok(inside > 1000, `checked ${inside}`);
  // Unbounded lift: no scissor. No boxes: nothing to bound.
  const box = Float64Array.of(-1, -1, -5, 1, 1, -4);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0];
  assert.equal(waterScissor(box, identity, { lo: -Infinity, hi: 0 }, 10, 10), null);
  assert.equal(waterScissor(new Float64Array(), identity, { lo: 0, hi: 0 }, 10, 10), null);
  // A box that reaches the camera plane widens to the target's edges.
  const straddle = Float64Array.of(-1, -1, -2, 1, 1, 2);
  assert.deepEqual(waterScissor(straddle, identity, { lo: 0, hi: 0 }, 10, 10), { x: 0, y: 0, width: 10, height: 10 });
});

test('a lake crossing box cells keeps its edge water when a frustum side falls between two cells', () => {
  // A flat grid lake whose triangles cross every WATER_BOX_M cell line. The
  // camera's left frustum plane is the vertical plane x = X, placed between
  // the last vertex before a cell line and the first one after it: the
  // cell left of X is wholly outside the frustum, but the triangles that
  // cross the line still draw at the frame's left edge.
  const level = 1000, W = 960, H = 540, fovY = 50 * Math.PI / 180, aspect = W / H;
  const halfH = Math.atan(Math.tan(fovY / 2) * aspect);
  let checked = 0;
  for (const spacing of [30, 40, 55]) {
    const positions = [], index = [], n = Math.floor(4000 / spacing);
    for (let j = 0; j <= 40; j++) for (let i = 0; i <= n; i++) positions.push(-2000 + i * spacing, level, -100 - j * spacing);
    for (let j = 0; j < 40; j++) for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      index.push(a, c, d, a, d, b);
    }
    const boxes = waterBoxes([{ positions: Float32Array.from(positions), index: Uint32Array.from(index) }]);
    for (const cell of [-3, -1, 2]) {
      const line = cell * 384, before = -2000 + Math.ceil((line + 2000) / spacing - 1) * spacing;
      if (before + spacing === line) continue; // a vertex on the line: no gap
      const X = (before + Math.min(before + spacing, line + spacing)) / 2;
      const eye = [X, level + 100, 0], view = lookAt(eye, [X + Math.sin(halfH), level + 100, -Math.cos(halfH)]);
      const viewProj = mul(perspective(fovY, aspect, 1, 50000), view);
      const rect = waterScissor(boxes, viewProj, { lo: -1, hi: 1 }, W, H);
      for (let t = 0; t < index.length; t += 3) {
        const A = index[t] * 3, B = index[t + 1] * 3, C = index[t + 2] * 3;
        if (Math.max(positions[A], positions[B], positions[C]) < X) continue;
        for (let s = 0; s <= 6; s++) for (let q = 0; q <= 6 - s; q++) {
          const a = s / 6, b = q / 6, c = 1 - a - b;
          const p = [0, 1, 2].map(k => a * positions[A + k] + b * positions[B + k] + c * positions[C + k]);
          const v = apply(viewProj, p);
          if (!(v[3] > 0) || Math.abs(v[0]) > v[3] || Math.abs(v[1]) > v[3] || Math.abs(v[2]) > v[3]) continue;
          const x = Math.min(W - 1, Math.floor((v[0] / v[3] + 1) / 2 * W)), y = Math.min(H - 1, Math.floor((v[1] / v[3] + 1) / 2 * H));
          assert.ok(x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height,
            `spacing ${spacing}, plane x=${X}: pixel ${x},${y} outside ${JSON.stringify(rect)}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 10000, `checked ${checked}`);
});

test('liftBounds holds every displacement the shader adds: glacier ice, deformation and land dance', () => {
  // The CPU twins of SCENE_VERT's lift: p.y += ice + deform * (1 - ice cover).
  let iced = 0, checked = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed), scale = seed % 4 === 0 ? .02 : r() * 1.5, a = r() * 6.28, b = r() * 6.28;
    const music = { amplitudeM: (r() - .5) * 140 * scale, kickM: (r() - .5) * 40 * scale, structuralM: (r() - .5) * 100 * scale,
      melodicM: (r() - .5) * 40 * scale, gestureM: (r() - .5) * 40 * scale, waveDir: [Math.cos(a), Math.sin(a)], melodyDir: [Math.cos(b), Math.sin(b)],
      waveK: r() * .01, melodyK: r() * .01, phaseRad: r() * 6.28, melodyPhaseRad: r() * 6.28,
      spineM: r() * 20 * scale, spineGate01: r(), drainM: (r() - .5) * 12 * scale, drainPhaseRad: r() * 6.28 };
    const glacier = { axisStartM: [0, 0], axisEndM: [0, -20000], halfWidthM: 3000, surfaceStartM: 1400 + r() * 400, surfaceEndM: 900, maxThicknessM: 100 + r() * 800 };
    assert.deepEqual(glacierErrors(glacier), []);
    const u = { uDeformAmp: { value: music.amplitudeM }, uDeformKick: { value: music.kickM }, uDeformStructural: { value: music.structuralM },
      uDeformMelodic: { value: music.melodicM }, uDeformGesture: { value: music.gestureM },
      uLandDance: { value: { x: music.spineM, y: music.spineGate01, z: music.drainM, w: music.drainPhaseRad } },
      uGlacierEnabled: { value: 1 }, uGlacierMaxThickness: { value: glacier.maxThicknessM } };
    const lift = liftBounds(u), heightRange = [400, 2400], retreat = r() * .5;
    for (let n = 0; n < 400; n++) {
      const x = (r() - .5) * 8000, z = -r() * 21000, y = heightRange[0] + r() * 2000, t = r() * 6.28;
      const ice = glacierSample(glacier, x, z, y, retreat);
      const hierarchy = { spine: r(), relief: r(), sin: Math.sin(t) * r(), cos: Math.cos(t) };
      const d = ice.thicknessM + sceneDeformation(music, x, z, y, heightRange, r(), hierarchy) * (1 - ice.coverage01);
      assert.ok(d >= lift.lo && d <= lift.hi, `seed ${seed}: lift ${d} outside [${lift.lo}, ${lift.hi}]`);
      if (ice.thicknessM > 50) iced++;
      checked++;
    }
  }
  assert.ok(iced > 100 && checked === 16000, `iced ${iced}`);
  // Off, the ice adds nothing; the dance is bounded only where it is on.
  const off = liftBounds({ uDeformAmp: { value: 10 }, uDeformKick: { value: 0 }, uDeformStructural: { value: 0 }, uDeformMelodic: { value: 0 },
    uDeformGesture: { value: 0 }, uGlacierEnabled: { value: 0 }, uGlacierMaxThickness: { value: 800 } });
  assert.equal(off.hi, 10 * 2 + 1);
});

test('the mirror keeps main\'s vertex-binned boxes; the water scissor gets whole triangles', () => {
  // A triangle across a cell line: two vertex boxes, neither holding the
  // strip between them; one triangle box holding all of it.
  const positions = Float32Array.of(WATER_BOX_M - 10, 0, 5, WATER_BOX_M + 30, 0, 5, WATER_BOX_M - 10, 0, 40);
  const subsets = [{ positions, index: Uint32Array.of(0, 1, 2) }];
  const v = vertexWaterBoxes(subsets), t = waterBoxes(subsets);
  assert.equal(v.length, 12);
  assert.deepEqual([...v.subarray(0, 6)].map(Math.round), [WATER_BOX_M - 10, 0, 5, WATER_BOX_M - 10, 0, 40]);
  assert.deepEqual([...v.subarray(6)].map(Math.round), [WATER_BOX_M + 30, 0, 5, WATER_BOX_M + 30, 0, 5]);
  assert.deepEqual([...t].map(Math.round), [WATER_BOX_M - 10, 0, 5, WATER_BOX_M + 30, 0, 40]);
});
