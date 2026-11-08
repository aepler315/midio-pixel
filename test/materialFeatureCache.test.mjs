import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as VENDORED_THREE from '../src/vendor/range/three-range.module.js';
import * as domain from '../src/world/alpine/MaterialDetailDomain.js';
import { recordingWebGL2 } from './helpers/recordingWebGL2.mjs';

const cache = await import('../src/world/alpine/MaterialFeatureCache.js').catch(() => ({}));
const grid = { originM: [-12345, -8765], width: 2241, height: 1121, cellSizeM: 10 };

test('material feature caching is the default with explicit reference opt-outs', () => {
  assert.equal(typeof cache.materialFeatureMode, 'function');
  for (const query of ['?materialFeatures=reference', '?materialFeatures=off', '?materialFeatures=0', '?materialFeatures=Warp', '?materialFeatures=warp-extra']) {
    assert.equal(cache.materialFeatureMode(query), 'reference');
  }
  assert.equal(cache.materialFeatureMode(''), 'warp');
  assert.equal(cache.materialFeatureMode('?other=1&materialFeatures=warp'), 'warp');
});

test('planning covers both shifted noise domains and their negative boundary cells', () => {
  assert.equal(typeof cache.planMaterialFeatureCache, 'function');
  const plan = cache.planMaterialFeatureCache(grid);
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.originCell, [-22, -36]);
  assert.equal(plan.bytes, plan.width * plan.height * 4);
  assert.ok(plan.bytes <= 256 * 256 * 4 && plan.buildBytes <= 1024);
  for (const [dx, dz] of [[0, 0], [37.2, -19.7]]) {
    for (const x of [grid.originM[0], grid.originM[0] + (grid.width - 1) * grid.cellSizeM]) {
      for (const z of [grid.originM[1], grid.originM[1] + (grid.height - 1) * grid.cellSizeM]) {
        const cell = [Math.floor(x / 600 + dx), Math.floor(z / 600 + dz)];
        assert.ok(cell[0] > plan.originCell[0] && cell[0] < plan.originCell[0] + plan.width - 1);
        assert.ok(cell[1] > plan.originCell[1] && cell[1] < plan.originCell[1] + plan.height - 1);
      }
    }
  }
});

test('cache origins retain the planned cell when world-origin float32 rounding crosses a boundary', () => {
  const plan = cache.planMaterialFeatureCache({ originM: [599.99999, 0], width: 2, height: 2, cellSizeM: 10 });
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.originCell, [-1, -21]);
  assert.equal(Math.fround(599.99999), 600, 'recomputing from a float32 world origin selects the wrong cell');
  assert.match(cache.MATERIAL_FEATURE_GLSL, /ivec2 origin = ivec2\(sSoil, sCanopy\)/);
  assert.doesNotMatch(cache.MATERIAL_FEATURE_GLSL, /uGridOrigin/, 'the shader reads exact admitted cache cells');
});

test('planning rejects invalid grids and cannot exceed the hard texture bound', () => {
  assert.equal(typeof cache.planMaterialFeatureCache, 'function');
  for (const bad of [null, {}, { ...grid, originM: [NaN, 0] }, { ...grid, width: 1 }, { ...grid, height: 1.5 }, { ...grid, cellSizeM: 0 }, { ...grid, cellSizeM: Infinity }]) {
    assert.equal(cache.planMaterialFeatureCache(bad).eligible, false);
  }
  assert.equal(cache.planMaterialFeatureCache(grid, { maxSize: 16 }).eligible, false);
  assert.equal(cache.planMaterialFeatureCache(grid, { maxSize: NaN }).eligible, false);
  const huge = cache.planMaterialFeatureCache({ ...grid, width: 20001, cellSizeM: 30 }, { maxSize: 4096 });
  assert.equal(huge.eligible, false, 'a caller cannot raise the 256 texel cap');
  for (const origin of [1e30, Number.MAX_SAFE_INTEGER * 600, (2 ** 24 - 2) * 600, -(2 ** 24 - 2) * 600]) {
    assert.equal(cache.planMaterialFeatureCache({ originM: [origin, origin], width: 2, height: 2, cellSizeM: 10 }).eligible,
      false, 'all packed cell coordinates and their corners must remain exact float integers');
  }
});

test('the outer guard cell joins cached noise continuously to the procedural domain', () => {
  const source = cache.MATERIAL_FEATURE_GLSL;
  assert.equal(typeof source, 'string');
  const body = source.match(/float materialFeatureBlend\([^)]*\) \{([^}]+)\}/)?.[1];
  assert.ok(body, 'the draw shader must use the tested scalar boundary blend');
  const blend = new Function('cached', 'reference', 'edge', 'mix', 'smoothstep', body);
  const mix = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const sample = (cached, reference, edge) => blend(cached, reference, edge, mix, smoothstep);
  const cached = .4980392156862745, reference = .5;
  for (const edge of [-1e6, -1, 0]) assert.equal(sample(cached, reference, edge), reference);
  for (const edge of [1, 2, 1e6]) assert.equal(sample(cached, reference, edge), cached);
  for (const edge of [1e-7, .01, .5, .99, 1 - 1e-7]) {
    const value = sample(cached, reference, edge);
    assert.ok(value >= cached && value <= reference);
  }
  assert.ok(Math.abs(sample(cached, reference, 1e-5) - reference) * 300 < 1e-8);
  assert.ok(Math.abs(sample(cached, reference, 1 - 1e-5) - cached) * 300 < 1e-8);
  assert.match(source, /if \(edge < 1\.0\) return materialFeatureBlend\(cached, vnoise12\(p\), edge\)/,
    'procedural hashes are confined to the one-cell guard band');
  // All four edges and their corners have zero cache contribution. Interior
  // corners one cell from the boundary have the full cache contribution.
  const origin = [-4, -7], size = [8, 10];
  for (const p of [[-4, -7], [4, -7], [-4, 3], [4, 3], [-4, -2], [4, -2], [0, -7], [0, 3]]) {
    const edge = Math.min(p[0] - origin[0], p[1] - origin[1], origin[0] + size[0] - p[0], origin[1] + size[1] - p[1]);
    assert.equal(sample(cached, reference, edge), reference);
  }
  assert.equal(sample(cached, reference, 1), cached);
});

test('cached noise uses one integer lookup and preserves the original cubic interpolation', () => {
  assert.equal(typeof domain.MATERIAL_HASH_GLSL, 'string');
  assert.match(domain.MATERIAL_HASH_GLSL, /float hash12\(vec2 p\)/);
  const source = cache.MATERIAL_FEATURE_GLSL;
  assert.equal(typeof source, 'string');
  assert.equal([...source.matchAll(/texelFetch\(/g)].length, 1);
  assert.match(source, /return vnoise12\(p\)/, 'outside the atlas remains procedural');
  assert.match(source, /f = f \* f \* \(3\.0 - 2\.0 \* f\)/);
  const expression = source.match(/(mix\(mix\(corners\.r[^;]+);/)[1]
    .replace(/corners\.([rgba])/g, (_, c) => `corners[${'rgba'.indexOf(c)}]`)
    .replace(/f\.([xy])/g, (_, c) => `f[${'xy'.indexOf(c)}]`);
  const interpolate = new Function('corners', 'f', 'mix', `return ${expression};`);
  const mix = (a, b, t) => a + (b - a) * t;
  const corners = [.0001, .12345, .87654, .9999];
  const encoded = corners.map(v => Math.round(v * 255) / 255);
  for (let x = 0; x <= 100; x++) for (let y = 0; y <= 100; y++) {
    const smooth = v => v * v * (3 - 2 * v), f = [smooth(x / 100), smooth(y / 100)];
    const error = Math.abs(interpolate(encoded, f, mix) - interpolate(corners, f, mix)) * 300;
    assert.ok(error <= 300 / 510 + 1e-12, 'convex interpolation retains the UNORM8 warp bound');
  }
});

function fakeRenderer({ fail = null } = {}) {
  const before = { target: { name: 'previous' }, viewport: new THREE.Vector4(2, 3, 800, 600),
    scissor: new THREE.Vector4(5, 7, 200, 100), scissorTest: true, autoClear: true };
  const state = { ...before, viewport: before.viewport.clone(), scissor: before.scissor.clone(),
    targets: [], geometryDisposals: 0, materialDisposals: 0, targetDisposals: 0, renders: 0 };
  const gl = { FRAMEBUFFER: 1, FRAMEBUFFER_COMPLETE: 2, LINK_STATUS: 3,
    checkFramebufferStatus: () => fail === 'framebuffer' ? 0 : 2,
    getProgramParameter: () => fail !== 'link', getProgramInfoLog: () => 'rejected shader' };
  const renderer = {
    autoClear: true,
    getRenderTarget: () => state.target,
    getViewport: v => v.copy(state.viewport), getScissor: v => v.copy(state.scissor),
    getScissorTest: () => state.scissorTest,
    setViewport: (...args) => { state.viewport.copy(args[0]?.isVector4 ? args[0] : new THREE.Vector4(...args)); },
    setScissor: (...args) => { state.scissor.copy(args[0]?.isVector4 ? args[0] : new THREE.Vector4(...args)); },
    setScissorTest: value => { state.scissorTest = value; },
    setRenderTarget: target => {
      state.target = target;
      if (target !== before.target && !state.targets.includes(target)) {
        state.targets.push(target); target.addEventListener('dispose', () => { state.targetDisposals++; });
      }
    },
    getContext: () => gl,
    properties: { get: () => ({ programs: new Map([['bake', { program: {} }]]) }) },
    compile: scene => {
      const mesh = scene.children[0]; state.mesh = mesh;
      mesh.geometry.addEventListener('dispose', () => { state.geometryDisposals++; });
      mesh.material.addEventListener('dispose', () => { state.materialDisposals++; });
      if (fail === 'compile') throw new Error('compile failed');
      return new Set([mesh.material]);
    },
    render: () => { state.renders++; if (fail === 'render') throw new Error('draw failed'); },
  };
  const assertRestored = () => {
    assert.equal(state.target, before.target);
    assert.deepEqual(state.viewport, before.viewport); assert.deepEqual(state.scissor, before.scissor);
    assert.equal(state.scissorTest, before.scissorTest); assert.equal(renderer.autoClear, before.autoClear);
  };
  return { renderer, state, assertRestored };
}

test('a successful GPU bake restores renderer state and owns only the final target', () => {
  assert.equal(typeof cache.bakeMaterialFeatureCache, 'function');
  const { renderer, state, assertRestored } = fakeRenderer();
  const plan = cache.planMaterialFeatureCache(grid), result = cache.bakeMaterialFeatureCache(THREE, renderer, plan);
  assertRestored();
  assert.equal(state.renders, 1); assert.equal(state.geometryDisposals, 1); assert.equal(state.materialDisposals, 1);
  assert.equal(result.bytes, plan.bytes); assert.equal(result.texture, result.target.texture);
  assert.equal(result.target.depthBuffer, false); assert.equal(result.texture.generateMipmaps, false);
  assert.equal(result.texture.magFilter, THREE.NearestFilter); assert.equal(result.texture.colorSpace, THREE.NoColorSpace);
  assert.deepEqual(result.texture.userData.materialFeatures, { version: 1, mode: 'warp',
    originCell: plan.originCell, width: plan.width, height: plan.height });
  assert.notEqual(result.texture.userData.materialFeatures.originCell, plan.originCell, 'the texture owns its tag coordinates');
  assert.equal(state.mesh.geometry.attributes.position.array.byteLength, 36, 'the bake allocates only a fixed triangle');
  assert.ok(state.mesh.material.fragmentShader.includes(domain.MATERIAL_HASH_GLSL));
  result.dispose(); result.dispose(); assert.equal(state.targetDisposals, 1);
});

for (const fail of ['compile', 'link', 'framebuffer', 'render']) test(`a ${fail} failure restores state and disposes every GPU bake resource`, () => {
  assert.equal(typeof cache.bakeMaterialFeatureCache, 'function');
  const { renderer, state, assertRestored } = fakeRenderer({ fail });
  assert.throws(() => cache.bakeMaterialFeatureCache(THREE, renderer, cache.planMaterialFeatureCache(grid)));
  assertRestored(); assert.equal(state.geometryDisposals, 1); assert.equal(state.materialDisposals, 1);
  assert.equal(state.targetDisposals, 1);
});

for (const override of ['target', 'viewport', 'scissor', 'scissorTest', 'all']) for (const fail of [false, true]) test(`vendored Three preserves ${override} state${fail ? ' after a draw failure' : ''}`, () => {
  const T = VENDORED_THREE, { gl, canvas, state } = recordingWebGL2(64, 64);
  // The base recording helper returns default getParameter rectangles. This
  // fixture exposes the live recorded GL state for the bake's public reads.
  const getParameter = gl.getParameter;
  gl.getParameter = parameter => parameter === gl.SCISSOR_BOX ? new Int32Array(state.scissor)
    : parameter === gl.SCISSOR_TEST ? state.scissorTest : getParameter(parameter);
  const renderer = new T.WebGLRenderer({ canvas, context: gl });
  const target = new T.WebGLRenderTarget(32, 32);
  target.viewport.set(1, 2, 14, 19);
  target.scissor.set(3, 4, 11, 13);
  target.scissorTest = true;
  renderer.setViewport(0, 0, 64, 64);
  renderer.setScissor(0, 0, 64, 64);
  renderer.setScissorTest(false);
  renderer.setRenderTarget(target, 3, 1);
  const overrideViewport = override === 'viewport' || override === 'all';
  const overrideScissor = override === 'scissor' || override === 'all';
  const overrideTest = override === 'scissorTest' || override === 'all';
  if (overrideViewport) renderer.setViewport(7, 9, 10, 11);
  if (overrideScissor) renderer.setScissor(13, 15, 17, 19);
  if (overrideTest) renderer.setScissorTest(false);
  const globalViewport = overrideViewport ? [7, 9, 10, 11] : [0, 0, 64, 64];
  const globalScissor = overrideScissor ? [13, 15, 17, 19] : [0, 0, 64, 64];
  const currentViewport = overrideViewport ? globalViewport : [1, 2, 14, 19];
  const currentScissor = overrideScissor ? globalScissor : [3, 4, 11, 13];
  assert.deepEqual(renderer.getViewport(new T.Vector4()).toArray(), globalViewport);
  assert.deepEqual(renderer.getCurrentViewport(new T.Vector4()).toArray(), currentViewport);
  if (fail) renderer.render = () => { throw new Error('draw interrupted'); };
  let result;
  try {
    const bake = () => { result = cache.bakeMaterialFeatureCache(T, renderer, cache.planMaterialFeatureCache(grid)); };
    if (fail) assert.throws(bake, /draw interrupted/); else bake();
    assert.equal(renderer.getRenderTarget(), target);
    assert.equal(renderer.getActiveCubeFace(), 3); assert.equal(renderer.getActiveMipmapLevel(), 1);
    assert.deepEqual(renderer.getViewport(new T.Vector4()).toArray(), globalViewport);
    assert.deepEqual(renderer.getScissor(new T.Vector4()).toArray(), globalScissor);
    assert.equal(renderer.getScissorTest(), false);
    assert.deepEqual(renderer.getCurrentViewport(new T.Vector4()).toArray(), currentViewport);
    assert.deepEqual(state.viewport, currentViewport);
    assert.deepEqual(state.scissor, currentScissor);
    assert.equal(state.scissorTest, !overrideTest);
  } finally { result?.dispose(); target.dispose(); renderer.dispose(); }
});

for (const fail of [false, true]) test(`vendored Three restores the default framebuffer at device pixel ratio two${fail ? ' after a draw failure' : ''}`, () => {
  const T = VENDORED_THREE, { gl, canvas, state } = recordingWebGL2(64, 64);
  const renderer = new T.WebGLRenderer({ canvas, context: gl });
  renderer.setPixelRatio(2);
  renderer.setViewport(7, 9, 10, 11);
  renderer.setScissor(13, 15, 17, 19);
  renderer.setScissorTest(true);
  if (fail) renderer.render = () => { throw new Error('draw interrupted'); };
  let result;
  try {
    const bake = () => { result = cache.bakeMaterialFeatureCache(T, renderer, cache.planMaterialFeatureCache(grid)); };
    if (fail) assert.throws(bake, /draw interrupted/); else bake();
    assert.equal(renderer.getRenderTarget(), null);
    assert.deepEqual(renderer.getViewport(new T.Vector4()).toArray(), [7, 9, 10, 11]);
    assert.deepEqual(renderer.getScissor(new T.Vector4()).toArray(), [13, 15, 17, 19]);
    assert.deepEqual(renderer.getCurrentViewport(new T.Vector4()).toArray(), [14, 18, 20, 22]);
    assert.deepEqual(state.viewport, [14, 18, 20, 22]);
    assert.deepEqual(state.scissor, [26, 30, 34, 38]);
    assert.equal(renderer.getScissorTest(), true); assert.equal(state.scissorTest, true);
  } finally { result?.dispose(); renderer.dispose(); }
});

test('an ineligible plan allocates no GPU cache', () => {
  assert.equal(typeof cache.bakeMaterialFeatureCache, 'function');
  const { renderer, state } = fakeRenderer();
  assert.throws(() => cache.bakeMaterialFeatureCache(THREE, renderer, { eligible: false }), /plan/i);
  assert.equal(state.targets.length, 0);
  const malformed = { ...cache.planMaterialFeatureCache(grid), originCell: [1.5, 2] };
  assert.throws(() => cache.bakeMaterialFeatureCache(THREE, renderer, malformed), /plan/i);
  for (const originCell of [[2 ** 24 - 2, 0], [-(2 ** 24 - 1), 0], [0, 1e30]]) {
    assert.throws(() => cache.bakeMaterialFeatureCache(THREE, renderer, { ...cache.planMaterialFeatureCache(grid), originCell }), /plan/i);
  }
  for (const malformedCost of [{ bytes: 0 }, { bytes: Number.MAX_SAFE_INTEGER }, { buildBytes: 0 }, { buildBytes: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => cache.bakeMaterialFeatureCache(THREE, renderer, { ...cache.planMaterialFeatureCache(grid), ...malformedCost }), /plan/i);
  }
  assert.equal(state.targets.length, 0);
});
