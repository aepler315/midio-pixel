import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createForest } from '../src/world/alpine/ForestGL.js';

function camera() {
  const c = new THREE.PerspectiveCamera(60, 16 / 9, 1, 10000);
  c.updateMatrixWorld();
  return c;
}

function fixture(rows = [[0, 0, -170, 20, 6, 1, .5, 2]], uniforms = {}) {
  return createForest(THREE, { meshDetail: new Float32Array(rows.flat()), mesh: new Float32Array(),
    billboard: new Float32Array(), stride: 8, count: rows.length }, uniforms);
}

function twins(f) {
  return Object.fromEntries(['detail', 'lite'].map(lod => [lod,
    f.byBand.near.find(m => m.userData.nearLod === lod)]));
}

function shaderFunction(fragment, name) {
  const match = new RegExp(`\\b${name}\\([^)]*\\)\\s*\\{`).exec(fragment);
  assert.ok(match, `assembled shader has ${name}`);
  const start = match.index + match[0].length;
  let depth = 1, end = start;
  while (depth && end < fragment.length) { if (fragment[end] === '{') depth++; if (fragment[end] === '}') depth--; end++; }
  return fragment.slice(start, end - 1);
}

function preprocessShader(body, defines) {
  const stack = [], lines = [];
  let enabled = true;
  for (const line of body.split('\n')) {
    const directive = /^\s*#(ifdef|elif defined|else|endif)\b(?:\(?\s*(\w+)\s*\)?)?/.exec(line);
    if (!directive) { if (enabled) lines.push(line); continue; }
    const [, kind, name] = directive;
    if (kind === 'ifdef') { stack.push({ outer: enabled, taken: !!defines[name] }); enabled = enabled && !!defines[name]; }
    else if (kind === 'elif defined') { const s = stack.at(-1); enabled = s.outer && !s.taken && !!defines[name]; s.taken ||= !!defines[name]; }
    else if (kind === 'else') { const s = stack.at(-1); enabled = s.outer && !s.taken; s.taken = true; }
    else { enabled = stack.pop().outer; }
  }
  return lines.join('\n');
}

// Execute the assembled shader's scalar coverage/selection and pass decisions.
// Vector shading and derivatives are fixed to a fully covered opaque interior;
// they cannot account for a density loss at the LOD/compositing boundary.
function interiorPass(mesh, x, y, treeId = .5, geometricCoverage = 1) {
  const fragment = mesh.material.fragmentShader;
  const weight = mesh.geometry.attributes.iLodWeight?.getX(0) ?? mesh.material.defaultAttributeValues.iLodWeight[0];
  const mix = (a, b, t) => a + (b - a) * t;
  const coverageReturn = /return\s+([^;]+);/.exec(shaderFunction(fragment, 'meshCoverage'))[1];
  const coverage = new Function('edge', 'fringe', 'vBranch', 'vLodWeight', 'mix', `return ${coverageReturn};`);
  const scalar = body => body.replace(/\buvec2\(floor\(gl_FragCoord\.xy\)\)/g, '({x:Math.floor(gl_FragCoord.x),y:Math.floor(gl_FragCoord.y)})')
    .replace(/\b(float|uint|bool|uvec2)\s+(\w+)/g, 'let $2')
    .replace(/(\w+)\s*\*=\s*(0x[\da-f]+)u\s*;/gi, '$1 = Math.imul($1, $2);')
    .replace(/\b(0x[\da-f]+|\d+)u\b/gi, '$1').replace(/\buint\(/g, 'Math.floor(').replace(/\bfloat\(/g, 'Number(')
    .replace(/>>/g, '>>>');
  const bindings = { vLodWeight: weight, vLodId: treeId, gl_FragCoord: { x: x + .5, y: y + .5 },
    abs: Math.abs, clamp: (n, a, b) => Math.max(a, Math.min(b, n)) };
  let selected = () => true;
  if (fragment.includes('bool forestLodSelected()')) {
    const noise = new Function(...Object.keys(bindings), scalar(shaderFunction(fragment, 'forestLodNoise')));
    const select = new Function(...Object.keys(bindings), 'forestLodNoise', scalar(shaderFunction(fragment, 'forestLodSelected')));
    selected = () => select(...Object.values(bindings), () => noise(...Object.values(bindings)));
  }
  let main = shaderFunction(fragment, 'main');
  const shadeAt = main.indexOf('vec3 n =');
  const colour = shadeAt >= 0;
  if (colour) main = main.slice(0, shadeAt);
  main = preprocessShader(main, mesh.material.defines).replace(/\bfloat\s+/g, 'let ')
    .replace(/\bdiscard\s*;/g, 'return null;').replace(/outColor\s*=.*?;/g, '');
  const env = { meshCoverage: () => coverage(1, geometricCoverage, { w: 1 }, weight, mix), forestLodSelected: selected,
    forestInstanceWeight: () => 1, length: () => 1, uCameraPos: 0, vWorld: 0, uFarForest: { x: 0, y: 0 },
    vBranch: { x: 0, y: 0 }, vId: treeId, gTreeOcc: 1, vOcc: 1, fwidth: () => 0, smoothstep: () => 0 };
  return new Function(...Object.keys(env), `${main}\nreturn { alpha: ${colour ? 'cov' : '1'} };`)(...Object.values(env));
}

test('paired LOD opaque interiors retain exactly one solid colour and depth sample throughout transition', () => {
  const f = fixture(), c = camera();
  try {
    f.updateDetailView({ camera: c, width: 480, height: 270, pixelated: true, nearDetail: true });
    const core = f.byBand.near.filter(m => m.material.defines.FOREST_CORE);
    const depth = f.depth.filter(m => m.material.defines.FOREST_CORE);
    let fullPixels = 0, litePixels = 0;
    const pair = twins(f);
    for (const w of [1 / 65536, .125, .5, .875, 1 - 1 / 65536]) {
      pair.detail.geometry.attributes.iLodWeight.setX(0, w);
      pair.lite.geometry.attributes.iLodWeight.setX(0, -(1 - w));
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const colourSamples = core.map(m => interiorPass(m, x, y));
        const depthSamples = depth.map(m => interiorPass(m, x, y));
        assert.equal(colourSamples.filter(Boolean).length, 1, 'opaque LOD interiors cannot expose the background');
        assert.deepEqual(depthSamples.map(Boolean), colourSamples.map(Boolean), 'solid colour and solid depth choose the same asset');
        const alpha = colourSamples.filter(Boolean).reduce((a, sample) => sample.alpha + a * (1 - sample.alpha), 0);
        assert.equal(alpha, 1, 'premultiplied composition stays opaque');
        if (colourSamples[0]) fullPixels++; else litePixels++;
      }
    }
    assert.ok(fullPixels > 0 && litePixels > 0, 'the transition selects pixels from both assets');
  } finally { f.dispose(); }
});

test('LOD selection preserves the geometric soft edge instead of scaling its alpha twice', () => {
  const f = fixture(), c = camera();
  try {
    f.updateDetailView({ camera: c, width: 480, height: 270, pixelated: true, nearDetail: true });
    const soft = f.byBand.near.filter(m => m.material.defines.FOREST_BLEND);
    const hardDepth = f.depth.filter(m => !m.material.defines.FOREST_CORE);
    for (const geometricCoverage of [.4, .7]) for (const [x, y] of [[3, 7], [97, 41], [319, 179]]) {
      const samples = soft.map(m => interiorPass(m, x, y, .5, geometricCoverage));
      assert.equal(samples.filter(Boolean).length, 1);
      assert.equal(samples.find(Boolean).alpha, geometricCoverage);
      const depth = hardDepth.map(m => interiorPass(m, x, y, .5, geometricCoverage));
      assert.equal(depth.filter(Boolean).length, geometricCoverage < .5 ? 0 : 1);
      if (geometricCoverage >= .5) assert.deepEqual(samples.map(Boolean), depth.map(Boolean));
    }
  } finally { f.dispose(); }
});

test('ordinary mesh-ring trees keep opaque colour and depth with the default LOD attribute', () => {
  const f = createForest(THREE, { mesh: new Float32Array([0, 0, -300, 20, 6, 1, .5, 2]),
    billboard: new Float32Array(), stride: 8, count: 1 }, {});
  try {
    for (const mesh of [...f.byBand.near, ...f.depth].filter(m => m.material.defines.FOREST_CORE)) {
      for (const [x, y] of [[0, 0], [31, 97], [639, 359]]) assert.equal(interiorPass(mesh, x, y)?.alpha, 1);
    }
  } finally { f.dispose(); }
});

test('pixel forest detail follows the actual target resolution and restores deterministically after a mirror', () => {
  const f = fixture(), c = camera();
  try {
    assert.equal(typeof f.updateDetailView, 'function');
    const before = f.counts.meshDetail;
    const classic = f.updateDetailView({ camera: c, width: 320, height: 180, pixelated: true, nearDetail: true });
    assert.equal(classic.detailBatches, 0);
    assert.equal(classic.liteBatches, 1);
    assert.equal(twins(f).detail.visible, false);
    assert.equal(twins(f).lite.visible, true);
    const detailed = f.updateDetailView({ camera: c, width: 640, height: 360, pixelated: true, nearDetail: true });
    assert.equal(detailed.blendedBatches, 1);
    const weight = twins(f).detail.geometry.attributes.iLodWeight.getX(0);
    assert.ok(weight > .9 && weight < 1);
    assert.ok(twins(f).detail.visible && twins(f).lite.visible);
    f.updateDetailView({ camera: c, width: 320, height: 180, pixelated: true, nearDetail: true });
    const restored = f.updateDetailView({ camera: c, width: 640, height: 360, pixelated: true, nearDetail: true });
    assert.deepEqual(restored, detailed);
    assert.equal(twins(f).detail.geometry.attributes.iLodWeight.getX(0), weight);
    assert.equal(f.counts.meshDetail, before, 'asset selection never thins placements');
  } finally { f.dispose(); }
});

test('pixel forest blend is continuous and shared by colour, core and depth without copying tree records', () => {
  const f = fixture(), c = camera();
  try {
    assert.equal(typeof f.updateDetailView, 'function');
    const { detail, lite } = twins(f);
    const positions = detail.geometry.attributes.iPos;
    f.updateDetailView({ camera: c, width: 480, height: 270, pixelated: true, nearDetail: true });
    const w = detail.geometry.attributes.iLodWeight.getX(0);
    assert.ok(w > .1 && w < .9);
    assert.equal(w + Math.abs(lite.geometry.attributes.iLodWeight.getX(0)), 1);
    const all = [...f.byBand.near, ...f.depth, ...f.depthByBand.near];
    for (const mesh of all) {
      assert.ok(mesh.visible);
      assert.equal(mesh.geometry.attributes.iPos, positions);
      assert.equal(mesh.geometry.attributes.iLodWeight.count, 1, 'one scalar per batch');
      assert.equal(mesh.geometry.attributes.iLodWeight.meshPerAttribute, positions.count);
    }
    c.position.z = .01;
    c.updateMatrixWorld();
    f.updateDetailView({ camera: c, width: 480, height: 270, pixelated: true, nearDetail: true });
    assert.ok(Math.abs(detail.geometry.attributes.iLodWeight.getX(0) - w) < .001, 'no distance-boundary asset pop');
    assert.equal(f.bytes, 28 + 8, 'seven source floats plus two batch scalars');
  } finally { f.dispose(); }
});

test('a resolvable tree keeps its entire batch detailed while invisible trees cannot force full detail', () => {
  const c = camera();
  for (const [rows, wantDetail] of [
    [[[0, 0, -300, 20, 6, 1, .5, 2], [0, 0, -45, 20, 6, 1, .5, 2]], true],
    [[[0, 0, -300, 20, 6, 1, .5, 2], [0, 0, 30, 20, 6, 1, .5, 2], [10000, 0, -5, 20, 6, 1, .5, 2]], false],
  ]) {
    const f = fixture(rows);
    try {
      assert.equal(typeof f.updateDetailView, 'function');
      const state = f.updateDetailView({ camera: c, width: 320, height: 180, pixelated: true, nearDetail: true });
      assert.equal(state.detailBatches, wantDetail ? 1 : 0);
      assert.equal(state.blendedBatches, 0);
      assert.equal(f.counts.meshDetail, rows.length);
      assert.equal(twins(f).detail.geometry.instanceCount, rows.length);
      assert.equal(twins(f).lite.geometry.instanceCount, rows.length);
    } finally { f.dispose(); }
  }
});

test('natural rendering and a disabled detail rung preserve their established asset choices', () => {
  const f = fixture(), c = camera();
  try {
    assert.equal(typeof f.updateDetailView, 'function');
    f.updateDetailView({ camera: c, width: 320, height: 180, pixelated: true, nearDetail: true });
    f.updateDetailView({ camera: c, width: 320, height: 180, pixelated: false, nearDetail: true });
    assert.equal(twins(f).detail.visible, true);
    assert.equal(twins(f).lite.visible, false);
    f.updateDetailView({ camera: c, width: 640, height: 360, pixelated: true, nearDetail: false });
    assert.equal(twins(f).detail.visible, false);
    assert.equal(twins(f).lite.visible, true);
    f.applyVisibility({ shown: false });
    assert.ok([...f.byBand.near, ...f.depth, ...f.depthByBand.near].every(m => !m.visible));
    f.applyVisibility({ shown: true });
    assert.equal(twins(f).detail.visible, false);
    assert.equal(twins(f).lite.visible, true);
  } finally { f.dispose(); }
});

test('the largest tree leaving the frustum cannot pop the other trees in its batch', () => {
  const c = camera();
  // The close crown's conservative sphere is almost outside the right
  // edge. Its remaining sliver cannot resolve full branch complexity.
  const f = fixture([[0, 0, -300, 20, 6, 1, .5, 2], [51, 0, -30, 20, 6, 1, .5, 2]]);
  try {
    const state = f.updateDetailView({ camera: c, width: 320, height: 180, pixelated: true, nearDetail: true });
    assert.equal(state.liteBatches, 1);
    assert.equal(f.counts.meshDetail, 2, 'frustum assessment only selects assets');
  } finally { f.dispose(); }
});

test('musical root motion expands the footprint bound before a crown can need more detail', () => {
  const uniforms = { uHeightRange: { value: new THREE.Vector2(0, 200) }, uDeformAmp: { value: 0 } };
  const f = fixture([[0, 100, -240, 20, 6, 1, .5, 2]], uniforms), c = camera();
  try {
    const quiet = f.updateDetailView({ camera: c, width: 320, height: 180, pixelated: true, nearDetail: true });
    assert.equal(quiet.liteBatches, 1);
    uniforms.uDeformAmp.value = 200;
    const attack = f.updateDetailView({ camera: c, width: 320, height: 180, pixelated: true, nearDetail: true });
    assert.equal(attack.detailBatches, 1);
    assert.ok(attack.maxFootprintPx > quiet.maxFootprintPx);
  } finally { f.dispose(); }
});
