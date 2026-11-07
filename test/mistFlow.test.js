import { test } from 'node:test';
import assert from 'node:assert/strict';

// These checks fail if the field loses low-valley connectivity, its terrain
// placement, or the packed texture contract used by the atmosphere shader.
import { MIST_FLOW_MAX_SAMPLES, buildMistFlow, buildMistFlowAsync, sampleMistFlow, createMistFlowTexture } from '../src/world/alpine/MistFlow.js';
const grid = { width: 81, height: 81, cellSizeM: 50, originM: [300, -2400] };
function terrain(groundAt, customGrid = grid) { return { grid: customGrid, groundAt }; }
function valleyHeight(x, z) {
  const along = x - grid.originM[0], across = z - (grid.originM[1] + 2000);
  const branch = Math.max(0, along - 1600) * .45;
  const bank = Math.min(Math.abs(across - branch), Math.abs(across + branch));
  return 1000 + along * .025 + Math.max(0, bank - 100) * .6;
}
const valley = terrain(valleyHeight);
const point = (x, z) => [grid.originM[0] + x, grid.originM[1] + 2000 + z];

test('the compact field follows both branches of the low valley and excludes the dividing ridge', () => {
  assert.equal(typeof buildMistFlow, 'function', 'the mist flow builder is available');
  const field = buildMistFlow(valley);
  assert.equal(MIST_FLOW_MAX_SAMPLES, 96);
  assert.ok(field.width <= 96 && field.height <= 96);
  for (const [x, z] of [[500, 0], [1800, 90], [3200, 720], [3200, -720]]) {
    const s = sampleMistFlow(field, ...point(x, z));
    assert.ok(s.valley01 > .65, `valley affinity at ${x},${z}: ${s.valley01}`);
    assert.ok(Math.abs(s.groundM - valleyHeight(...point(x, z))) < 12, 'banks stand on the actual valley floor');
    assert.equal(s.valid01, 1);
  }
  assert.ok(sampleMistFlow(field, ...point(3200, 0)).valley01 < .15, 'the ridge between branches stays clear');
  assert.ok(sampleMistFlow(field, ...point(600, 1500)).valley01 < .1, 'high sides do not become sources');
});

test('upstream distance grows from a low source through the fork and up each branch', () => {
  const field = buildMistFlow(valley);
  let last = -1;
  for (const [x, z] of [[100, 0], [800, 0], [1500, 0], [2200, 270], [3200, 720]]) {
    const s = sampleMistFlow(field, ...point(x, z));
    assert.ok(s.upstreamM > last, `${x},${z}: ${s.upstreamM} after ${last}`);
    last = s.upstreamM;
  }
  const north = sampleMistFlow(field, ...point(3200, 720));
  const south = sampleMistFlow(field, ...point(3200, -720));
  assert.ok(Math.abs(north.upstreamM - south.upstreamM) < 200, 'both branches are fed by the same low valley');
  assert.ok(field.distanceM >= north.upstreamM);
  assert.deepEqual(buildMistFlow(valley).texture, field.texture, 'builds are deterministic');
});

test('no-data and isolated high flats cannot create mist sources', () => {
  const data = terrain((x, z) => {
    const xx = x - grid.originM[0], zz = z - grid.originM[1];
    if (xx > 1700 && xx < 2300) return NaN;
    return xx >= 2300 ? 2400 : 1000 + xx * .025 + Math.abs(zz - 2000) * .3;
  });
  const field = buildMistFlow(data);
  assert.equal(sampleMistFlow(field, ...point(2000, 0)).valid01, 0, 'no-data is invalid');
  const island = sampleMistFlow(field, ...point(3200, 0));
  assert.equal(island.valid01, 1, 'an isolated valid plateau still has ground');
  assert.equal(island.valley01, 0, 'the isolated high island has no low source');
  assert.ok(sampleMistFlow(field, ...point(800, 0)).valley01 > .5, 'the connected low valley remains usable');
  for (const p of [[grid.originM[0] - 1, 0], [grid.originM[0] + 4001, 0], [NaN, 0]]) {
    const s = sampleMistFlow(field, ...p);
    assert.equal(s.valid01, 0);
    assert.equal(s.valley01, 0);
    assert.ok(Object.values(s).every(Number.isFinite), 'outside queries remain finite');
  }
});

test('flat ground and empty terrain are finite and bounded', () => {
  for (const height of [() => 1200, () => NaN]) {
    const field = buildMistFlow(terrain(height));
    assert.ok(field.distanceM > 0);
    assert.ok(field.heightRange.every(Number.isFinite));
    const s = sampleMistFlow(field, ...point(2000, 0));
    assert.ok(Object.values(s).every(Number.isFinite));
    assert.ok(s.valley01 >= 0 && s.valley01 <= 1);
    assert.equal(s.valid01, Number.isFinite(height()) ? 1 : 0);
  }
  assert.ok(sampleMistFlow(buildMistFlow(terrain(() => 1200)), ...point(2000, 0)).valley01 > .5, 'flat low terrain can hold mist');
});

test('packed fields bilinearly decode at sample centres and halfway between them', () => {
  const field = { width: 2, height: 2, originM: [10, 30], extentM: [100, 200], heightRange: [500, 1010], distanceM: 5100,
    texture: Uint8Array.from([0, 255, 0, 255, 100, 153, 50, 255, 200, 51, 150, 255, 255, 0, 255, 0]) };
  assert.deepEqual(sampleMistFlow(field, 10, 30), { groundM: 500, valley01: 1, upstreamM: 0, valid01: 1 });
  const centre = sampleMistFlow(field, 60, 130);
  assert.ok(Math.abs(centre.groundM - (500 + (0 + 100 + 200 + 255) / 4 / 255 * 510)) < 1e-10);
  assert.ok(Math.abs(centre.valley01 - (255 + 153 + 51) / 4 / 255) < 1e-10);
  assert.equal(centre.upstreamM, (0 + 50 + 150 + 255) / 4 / 255 * 5100);
  assert.equal(centre.valid01, .75);
});

test('async preparation matches sync bytes and observes cancellation while yielding', async () => {
  const expected = buildMistFlow(valley, { maxSamples: 48 });
  let yields = 0;
  const actual = await buildMistFlowAsync(valley, { maxSamples: 48, sliceMs: 0, yieldTo: async () => { yields++; } });
  assert.deepEqual(actual, expected);
  assert.ok(yields > 1, 'preparation makes progress in bounded slices');
  const before = new AbortController(); before.abort();
  await assert.rejects(buildMistFlowAsync(valley, { signal: before.signal }), { name: 'AbortError' });
  const during = new AbortController();
  await assert.rejects(buildMistFlowAsync(valley, { signal: during.signal, sliceMs: 0,
    yieldTo: async () => { during.abort(); } }), { name: 'AbortError' });
});

test('the upload keeps one RGBA8 tap, correct sample centres and both resident copies charged', async () => {
  const THREE = await import('../src/vendor/range/three-range.module.js');
  const field = buildMistFlow(valley);
  const uploaded = createMistFlowTexture(THREE, field);
  assert.equal(uploaded.field, field);
  assert.equal(uploaded.texture.image.data, field.texture, 'the CPU twin retains the packed bytes');
  assert.equal(uploaded.texture.image.width, field.width);
  assert.equal(uploaded.texture.image.height, field.height);
  assert.equal(uploaded.texture.format, THREE.RGBAFormat);
  assert.equal(uploaded.texture.type, THREE.UnsignedByteType);
  assert.equal(uploaded.texture.magFilter, THREE.LinearFilter);
  assert.equal(uploaded.texture.minFilter, THREE.LinearFilter);
  assert.equal(uploaded.texture.generateMipmaps, false);
  assert.equal(uploaded.texture.flipY, false);
  assert.equal(uploaded.texture.wrapS, THREE.ClampToEdgeWrapping);
  assert.equal(uploaded.texture.wrapT, THREE.ClampToEdgeWrapping);
  assert.equal(uploaded.texture.colorSpace, THREE.NoColorSpace);
  assert.equal(uploaded.bytes, field.texture.byteLength * 2);
  assert.ok(uploaded.bytes <= 96 * 96 * 8);
  uploaded.texture.dispose();
});

test('large source packages keep a valley bank rather than turning coarse hillsides into channels', () => {
  const span = 64000;
  const wide = terrain((x, z) => 600 + x * .025 + Math.max(0, Math.abs(z - span * .5) - 1600) * .4,
    { originM: [0, 0], width: 1025, height: 1025, cellSizeM: span / 1024 });
  const field = buildMistFlow(wide);
  assert.ok(sampleMistFlow(field, 32000, 32000).valley01 > .6, 'the central valley remains a mist route');
  assert.ok(sampleMistFlow(field, 32000, 48000).valley01 < .1, 'a flank 16km from the valley remains clear');
});

test('wide uphill valley floors share nearby drainage instead of treating their climb as ridge height', () => {
  const valley = terrain((x, z) => {
    const xx = x - grid.originM[0], zz = z - grid.originM[1];
    return 1000 + xx * .1 + Math.max(0, Math.abs(zz - 2000) - 200) * .6;
  });
  const field = buildMistFlow(valley);
  for (const x of [1000, 2000, 3000]) {
    assert.ok(sampleMistFlow(field, ...point(x, 0)).valley01 > .65, `the middle of the uphill floor stays connected at ${x}m`);
    assert.ok(sampleMistFlow(field, ...point(x, 1000)).valley01 < .1, 'lateral sharing does not reach the high flanks');
  }
});

test('lateral drainage sharing preserves a dividing ridge between steep uphill valleys', () => {
  const steep = terrain((x, z) => {
    const xx = x - grid.originM[0], zz = z - grid.originM[1];
    return 1000 + xx * .8 + 1.6 * Math.min(Math.abs(zz - 1800), Math.abs(zz - 2200));
  });
  const field = buildMistFlow(steep);
  assert.ok(sampleMistFlow(field, ...point(2000, -200)).valley01 > .6, 'the steep channel remains a mist route');
  assert.ok(sampleMistFlow(field, ...point(2000, 0)).valley01 < .1, 'upstream channel elevation cannot erase a 320m dividing ridge');
});

test('source-connected bank edges soften without sharp angular affinity steps', () => {
  const field = buildMistFlow(terrain((x, z) => 180 + 760 * (x / 3000) ** 2
    + 520 * ((z + 3000) / 7000) ** 2 + 80 * Math.sin(z / 650) * (x / 3000),
  { width: 121, height: 141, cellSizeM: 50, originM: [-3000, -3000] }));
  let worst = 0;
  const at = (x, z) => field.texture[(z * field.width + x) * 4 + 1];
  for (let z = 1; z < field.height - 1; z++) for (let x = 1; x < field.width - 1; x++) {
    worst = Math.max(worst, Math.abs(at(x - 1, z) - 2 * at(x, z) + at(x + 1, z)),
      Math.abs(at(x, z - 1) - 2 * at(x, z) + at(x, z + 1)));
  }
  assert.ok(worst < 200, `neighboring bank samples contain a sharp affinity step of ${worst}/255`);
});
