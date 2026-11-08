import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';

function body(name) {
  const start = SCENE_FRAG.indexOf(` ${name}(`);
  assert.ok(start >= 0, `production shader must provide ${name}`);
  let at = SCENE_FRAG.indexOf('{', start) + 1, end = at, depth = 1;
  while (depth) { if (SCENE_FRAG[end] === '{') depth++; if (SCENE_FRAG[end] === '}') depth--; end++; }
  return SCENE_FRAG.slice(at, end - 1);
}

const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const add = (a, b) => a.map((v, i) => v + b[i]);
const close = (got, want) => assert.ok(Math.abs(got - want) < 1e-9, `${got} != ${want}`);

test('water wave derivatives are captured before clipped or dry fragments diverge', () => {
  const main = body('main'), clip = main.indexOf('if (vRenderedWorld.y < uClipBelow) discard');
  for (const axis of ['x', 'y']) {
    const capture = main.indexOf(`vec2 waterD${axis} = dFd${axis}(vWorld.xz)`);
    assert.ok(capture >= 0 && capture < clip, `world ${axis} derivative must precede the first varying discard`);
  }
  for (const name of ['waterSlope', 'waterAccentSlope', 'riverSlope']) {
    assert.doesNotMatch(body(name), /\b(?:fwidth|dFdx|dFdy)\s*\(/,
      `${name} cannot take undefined derivatives inside the water branch`);
  }
  assert.match(main, /waterSlope\(vWorld\.xz, uTime, waterDx, waterDy\)/);
  assert.match(main, /waterAccentSlope\(vWorld\.xz, waterDx, waterDy\)/);
  const phases = main.indexOf('vec3 riverPhase = riverPhases(uTime)');
  const widths = main.indexOf('vec3 riverWidth = fwidth(riverPhase)');
  assert.ok(phases >= 0 && widths > phases && widths < clip, 'all river phase widths must precede varying exits');
  assert.match(main, /riverSlope\(riverPhase\.xy, riverWidth\.xy\)/);
  assert.match(main, /riverCurrentTone\(riverPhase\.z, 1\.0 - smoothstep\(\.35, 1\.2, riverWidth\.z\)\)/);
});

test('directional water footprints preserve projected cancellation and finite quad phase differences', () => {
  // Execute the production footprint expression; the reference independently
  // differences phase values across a complete pixel quad, including dry peers.
  const expression = body('waterPhaseWidth').replace(/\babs\(/g, 'Math.abs(');
  const width = new Function('direction', 'waveNumber', 'dx', 'dy', 'dot', expression);
  close(width([1, 1], 2, [3, -3], [-2, 2], dot), 0);
  close(width([0, 1], .5, [4, -2], [1, 6], dot), 4);
  close(width([1, 0], 3, [0, 0], [0, 0], dot), 0);
  for (const direction of [[.92, .39], [-.45, .89], [.71, -.70], [-.97, -.24], [Math.cos(.91), Math.sin(.91)]]) {
    for (const wavelength of [7, 16, 41, 97, 48, 86, 140]) {
      const k = 6.2831853 / wavelength, point = [1024.5, -231.25];
      for (const [dx, dy] of [[[.2, -.7], [.4, .9]], [[12, -4], [-3, 40]], [[0, 0], [0, 0]]]) {
        const phase = p => dot(direction, p) * k + 37.125;
        const expected = Math.abs(phase(add(point, dx)) - phase(point)) + Math.abs(phase(add(point, dy)) - phase(point));
        close(width(direction, k, dx, dy, dot), expected);
      }
    }
  }
  assert.match(body('waterSlope'), /waterPhaseWidth\(dir, k, dx, dy\)/);
  assert.match(body('waterAccentSlope'), /waterPhaseWidth\(direction, 6\.2831853 \/ wavelength, dx, dy\)/);
});

test('cached river phases retain finite differences across transverse bends and zero-speed clamps', () => {
  const travel = new Function('distanceM', 'speedMps', 'timeSec', body('riverTravel').replace(/\bmax\(/g, 'Math.max('));
  const expression = body('riverPhases').replace(/\bfloat\s+/g, 'let ').replace(/\bsin\(/g, 'Math.sin(');
  const phases = new Function('vRiver', 't', 'riverTravel', 'vec3', expression);
  const at = (p, t) => phases({ x: p[0], y: p[1], z: p[2] }, t, travel, (...args) => args);
  const reference = ([distance, across, speed], t) => {
    const along = distance - (speed > 0 ? speed : 0) * t;
    return [along * 2.617994 + .3 * Math.sin(across * 3),
      along * .897598 + across * 1.7, along * .897598 + .25 * Math.sin(across * 4)];
  };
  for (const p of [[20, 0, -.1], [21, .9, 0], [25, 4.2, .7]]) for (const t of [0, 3, 100]) {
    const dx = [2, 1.3, .2], dy = [-.5, -.8, -.3];
    const values = [at(p, t), at(add(p, dx), t), at(add(p, dy), t)];
    const expected = [reference(p, t), reference(add(p, dx), t), reference(add(p, dy), t)];
    values.forEach((v, i) => v.forEach((phase, axis) => close(phase, expected[i][axis])));
    // Vector fwidth is componentwise: caching these phases preserves the
    // original sine/clamp differences rather than a local chain-rule estimate.
    for (let axis = 0; axis < 3; axis++) close(
      Math.abs(values[1][axis] - values[0][axis]) + Math.abs(values[2][axis] - values[0][axis]),
      Math.abs(expected[1][axis] - expected[0][axis]) + Math.abs(expected[2][axis] - expected[0][axis]));
  }
});
