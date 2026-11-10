import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';

// Execute the production scalar coverage region. This does not compile GLSL
// or claim pixel/GPU equivalence; the old shader's binary appearance is the
// baseline when the filtering helpers have not been added.
function body(name) {
  const start = SCENE_FRAG.indexOf(`float ${name}(`);
  if (start < 0) return null;
  let at = SCENE_FRAG.indexOf('{', start) + 1, end = at, depth = 1;
  while (depth) { if (SCENE_FRAG[end] === '{') depth++; if (SCENE_FRAG[end] === '}') depth--; end++; }
  return SCENE_FRAG.slice(at, end - 1).replace(/\bfloat /g, 'const ');
}
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const coverage = body('waterAppearanceCoverage');
const detail = body('shorelineDetailCoverage');
const wetAppearance = coverage && new Function('coverage', 'footprint', 'sourceWet', 'enabled', 'clamp', 'abs', 'smoothstep', coverage);
const landDetail = detail && new Function('coverage', 'footprint', 'enabled', 'clamp', 'abs', 'smoothstep', detail);
const region = SCENE_FRAG.slice(SCENE_FRAG.indexOf('    bool water = waterCoverage'), SCENE_FRAG.indexOf('    float flowN ='))
  .replaceAll('ice.y', 'iceY').replace(/\b(?:float|bool) /g, 'let ')
  .replace('discard;', 'return { discarded: true, water, paintWater: false, waterAmount: 0, paintWaterAmount: 0, landDetail: 1 };');
const evaluate = new Function('waterCoverage', 'uWaterOnly', 'uSeparateWater', 'uDebugMask', 'uDiag', 'iceY', 'fwidth',
  'waterAppearanceCoverage', 'shorelineDetailCoverage', `${region}\nreturn { discarded: false, water, paintWater, filterShore: typeof filterShore === 'undefined' ? false : filterShore,
    waterAmount: typeof waterAmount === 'undefined' ? (water ? 1 : 0) : waterAmount,
    paintWaterAmount: typeof paintWaterAmount === 'undefined' ? (paintWater ? 1 : 0) : paintWaterAmount,
    landDetail: typeof landDetail === 'undefined' ? 1 : landDetail };`);
function at(value, width = .1, { waterOnly = 0, separate = 0, debug = 0, diag = 0, ice = 0 } = {}) {
  return evaluate(value, waterOnly, separate, debug, diag, ice, () => width,
    (...args) => wetAppearance(...args, clamp, Math.abs, smoothstep),
    (...args) => landDetail(...args, clamp, Math.abs, smoothstep));
}

test('camera phases across the native water threshold no longer replace a whole pixel at once', () => {
  const values = Array.from({ length: 101 }, (_, i) => at(.49 + i * .001, .08).paintWaterAmount);
  assert.equal(values[0], 0); assert.equal(values.at(-1), 1);
  assert.ok(values.every((v, i) => !i || v >= values[i - 1]));
  assert.ok(values.every((v, i) => !i || v - values[i - 1] < .02), 'the source threshold cannot trigger a 0→1 appearance switch');
  assert.ok(Math.abs(at(.55, .1).paintWaterAmount - .5) < 1e-12);
});

test('derivative extremes retain exact dry/wet interiors and keep filtered work on the source-wet side', () => {
  for (const width of [0, 1e-12, .0001, .01, .1, .5, 1, 8, -.1]) {
    assert.equal(at(0, width).waterAmount, 0); assert.equal(at(1, width).waterAmount, 1);
    assert.equal(at(0, width).landDetail, 1); assert.equal(at(1, width).landDetail, 0);
    for (const c of [0, .1, .25, .499999, .5]) assert.equal(at(c, width).paintWaterAmount, 0);
    const w = Math.min(.5, Math.max(.00001, Math.abs(width)));
    assert.ok(Math.abs(at(.5 + w * .5, width).waterAmount - .5) < 1e-10);
    assert.ok(Math.abs(at(.5 - w * .5, width).landDetail - .5) < 1e-10);
  }
});

test('physical water-only, Direct separation, debug and glacier ownership bypass appearance filtering', () => {
  for (const c of [.49, .5, .500001, .55, 1]) {
    for (const flags of [{ waterOnly: 1 }, { separate: 1 }, { debug: 1 }, { debug: 8 }, { diag: 1 }, { ice: .005 }, { ice: .01 }, { ice: 1 }]) {
      const actual = at(c, .1, flags), wet = c > .5 && !(flags.ice >= .01);
      assert.equal(actual.water, wet);
      assert.equal(actual.discarded, !!flags.waterOnly && !wet);
      if (actual.discarded) continue;
      assert.equal(actual.waterAmount, wet ? 1 : 0);
      assert.equal(actual.paintWaterAmount, wet && !flags.separate ? 1 : 0);
      assert.equal(actual.landDetail, 1);
    }
  }
  assert.equal(at(1).waterAmount, 1, 'mapped river interiors remain fully wet');
});

test('existing skipped ground detail fades before the source threshold without new wet-fragment samples', () => {
  const nearCall = SCENE_FRAG.match(/triplanarWhen\(tRockNear,[^\n]*, ([^,()]+)\);/);
  const snowCall = SCENE_FRAG.match(/triplanarWhen\(tSnow,[^\n]*, ([^,()]+)\);/);
  assert.ok(nearCall && snowCall);
  const near = new Function('water', 'nearFade', `return ${nearCall[1]};`);
  const snow = new Function('water', 'snow', `return ${snowCall[1]};`);
  for (const c of [.45, .499, .499999, .5, .500001, .55, 1]) {
    const value = at(c), sampled = !value.water;
    assert.equal(near(value.water, 1), sampled); assert.equal(snow(value.water, 1), sampled);
  }
  const before = at(.5 - 1e-7), after = at(.5 + 1e-7);
  assert.ok(before.landDetail < 1e-10, 'near/snow normals and far dots contribute zero as their existing sample gate switches');
  assert.equal(after.landDetail, 0);
});

test('production sky/glint, crest and mirror instructions share the filtered appearance weight', () => {
  const starts = ['lit = mix(lit, skyReflect', 'lit += (uSkyHorizon', 'color = mix(color, mirrored'];
  const expected = [.6, .345, .46];
  const mix = (a, b, t) => a * (1 - t) + b * t;
  for (let i = 0; i < starts.length; i++) {
    const start = SCENE_FRAG.indexOf(starts[i]); assert.ok(start >= 0);
    const instruction = SCENE_FRAG.slice(start, SCENE_FRAG.indexOf(';', start) + 1);
    const run = new Function('paintWaterAmount', 'mix', 'clamp', 'smoothstep', `
      let lit = .2, color = .2;
      const skyReflect = .8, rWaterSkyMix = 1, skyHere = .5, uLightColor = 1, glint = .1, moonTransmission = 1;
      const uSkyHorizon = 1, crest = 1, uWaterMusic = {z: 1}, paw = 1, clear = 1, air = 0;
      const uNarrative = {z: 1, w: 1}, uStorm = {x: 0}, mirrored = .8, reflectance = .5, waterCoverage = 1, have = 1;
      ${instruction} return ${i < 2 ? 'lit' : 'color'};`);
    assert.equal(run(0, mix, clamp, smoothstep), .2, `${starts[i]} cannot appear abruptly at the source shore`);
    assert.ok(Math.abs(run(1, mix, clamp, smoothstep) - expected[i]) < 1e-12, 'uniform wet response remains unchanged');
    assert.ok(Math.abs(run(.5, mix, clamp, smoothstep) - (.2 + expected[i]) / 2) < 1e-12, 'the same half-covered material owns each optical contribution');
  }
});

test('fair-weather cloud evaluation keeps its original source-water gate and joins continuously from dry ground', () => {
  const start = SCENE_FRAG.indexOf('    float moonTransmission =');
  const region = SCENE_FRAG.slice(start, SCENE_FRAG.indexOf('    vec3 lit =', start)).replace(/\bfloat /g, 'let ');
  const run = new Function('water', 'waterAmount', 'landDetail', 'filterShore', 'uCloudMode',
    'celestialCloudTransmission', 'mix', `const vRenderedWorld = 0, uLightDir = 0; ${region} return moonTransmission;`);
  const mix = (a, b, t) => a * (1 - t) + b * t;
  const cloudAt = (c, width, flags, mode) => {
    const v = at(c, width, flags); let calls = 0;
    const transmission = run(v.water, v.waterAmount, v.landDetail, v.filterShore, mode, () => { calls++; return .4; }, mix);
    return { transmission, calls, wet: v.water };
  };
  for (const flags of [{}, { separate: 1 }, { debug: 3 }, { diag: 1 }, { ice: .005 }, { ice: 1 }]) {
    for (const mode of [0, 1]) for (const c of [.1, .4, .499999, .5, .500001, .55, 1]) {
      const v = cloudAt(c, .1, flags, mode);
      assert.equal(v.calls, v.wet && mode > .5 ? 0 : 1, 'partial water must not add a previously skipped cloud-disc traversal');
    }
  }
  assert.ok(Math.abs(cloudAt(.45, .1, {}, 1).transmission - .7) < 1e-12);
  assert.equal(cloudAt(.5, .1, {}, 1).transmission, 1);
  assert.ok(Math.abs(cloudAt(.5 - 1e-8, .1, {}, 1).transmission - cloudAt(.5 + 1e-8, .1, {}, 1).transmission) < 1e-10);
  for (const c of [.1, .45, .5, .55, 1]) assert.equal(cloudAt(c, .1, {}, 0).transmission, .4, 'legacy moon-cloud transmission is unchanged');
});
