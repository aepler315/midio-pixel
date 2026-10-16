import test from 'node:test';
import assert from 'node:assert/strict';
import { assertActualDpr, claimCase, verifyServedIdentity } from '../tools/lib/landscape-evidence.mjs';
import { caseId, casesForPreset, requireBiomes } from '../tools/lib/landscape-fixtures.mjs';
import { parseLandscapeArgs, captureLandscapeCase } from '../tools/range-landscape-smoke.mjs';

test('verifyServedIdentity rejects a module hash even when the commit string matches', () => {
  const expectSha = 'e4a0e81ea8263579f68fbb32d382db111531cc7c';
  assert.throws(() => verifyServedIdentity({
    expectSha,
    expectedHashes: { 'src/world/BiomeManager.js': 'abc' },
    served: { commit: expectSha, hashes: { 'src/world/BiomeManager.js': 'def' } },
  }), /BiomeManager/);
  assert.equal(verifyServedIdentity({
    expectSha,
    expectedHashes: { 'src/world/BiomeManager.js': 'abc' },
    served: { commit: expectSha, hashes: { 'src/world/BiomeManager.js': 'abc' } },
  }), true);
});

test('a missing required biome fails the preset', () => {
  assert.throws(() => requireBiomes(['RAINFOREST', 'DESERT']), /ICEFIELD/);
  assert.doesNotThrow(() => requireBiomes([
    'ICEFIELD', 'TUNDRA', 'TAIGA', 'RAINFOREST', 'CONIFER', 'PINE_OAK',
    'BROADLEAF', 'CHAPARRAL', 'STEPPE', 'CANYON', 'DESERT',
  ]));
});

test('actual DPR and duplicate case ids are rejected', () => {
  assert.throws(() => assertActualDpr(2, 1), /devicePixelRatio/);
  const seen = new Set();
  const spec = { biome: 'DESERT', seed: 315, timeMs: 45000, level: 0, reducedFlash: false, width: 1280, height: 720, dpr: 1, pass: 'all' };
  claimCase(seen, caseId(spec, { fixtureHash: 'h' }));
  assert.throws(() => claimCase(seen, caseId(spec, { fixtureHash: 'h' })), /duplicate/);
  assert.throws(() => casesForPreset('not-a-preset'), /unknown landscape preset/);
  assert.equal(casesForPreset('primary').length, 11);
  assert.throws(() => parseLandscapeArgs(['node', 'smoke', '--preset', 'primary']), /require --url/);
  assert.throws(() => parseLandscapeArgs(['node', 'smoke', '--url', 'http://127.0.0.1:8091', '--source-root', '.', '--expect-sha', 'abc', '--nope', '1']), /unknown landscape flag/);
  const parsed = parseLandscapeArgs(['node', 'smoke', '--url', 'http://127.0.0.1:8091', '--source-root', '.', '--expect-sha', 'abc', '--preset', 'primary', '--output', '.smoke/out']);
  assert.equal(parsed.preset, 'primary');
  assert.equal(parseLandscapeArgs(['node', 'smoke', 'http://127.0.0.1:8080', 'out', 'base']).legacy, true);
});

test('source verification refuses vacuous hashes', () => {
  assert.throws(() => verifyServedIdentity({ expectedHashes: {}, served: { hashes: {} } }), /empty/);
});

test('visibility stations are distinct frames and cannot overwrite each other', () => {
  const cases = casesForPreset('visibility');
  assert.equal(cases.length, 21);
  assert.equal(new Set(cases.map(c => c.timeMs)).size, 21);
  assert.equal(new Set(cases.map(c => caseId(c))).size, 21);
  const base = cases[0];
  assert.notEqual(caseId({ ...base, station: 0 }), caseId({ ...base, station: 1 }));
});

test('lighting and travel presets actually specify different conditions', () => {
  const lighting = casesForPreset('lighting');
  assert.ok(lighting.some(c => c.timeMs === 20000));
  assert.ok(lighting.some(c => c.timeMs === 68000));
  const travel = casesForPreset('travel');
  assert.deepEqual(travel.map(c => c.transition.t), [0.25, 0.5, 0.75]);
  assert.ok(travel.every(c => c.transition.to === 'DESERT'));
  assert.ok(casesForPreset('full').length > casesForPreset('primary').length);
});

test('travel evidence rejects a dissolve that never painted moving seams', async () => {
  const spec = casesForPreset('travel')[1];
  const page = { evaluate: async () => ({
    dpr: 1, worldKind: 'alpine', ranges: [], clock: { timeMs: spec.timeMs },
    blend: { from: spec.biome, to: spec.transition.to, t: spec.transition.t },
    travelCompositeLayers: [], pngData: '',
    quality: { requested: spec.level, actual: spec.level }, finalDraws: 1,
  }) };
  await assert.rejects(captureLandscapeCase(page, spec), /travel seam/);
  page.evaluate = async () => ({
    dpr: 1, worldKind: 'alpine', ranges: [], clock: { timeMs: spec.timeMs },
    blend: { travel: true, travelP: spec.transition.t },
    travelCompositeLayers: ['L2', 'L3'], pngData: '',
    quality: { requested: spec.level, actual: spec.level }, finalDraws: 1,
  });
  await assert.rejects(captureLandscapeCase(page, spec), /travel seam/);
});
