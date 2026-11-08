import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';
import { createForest } from '../src/world/alpine/ForestGL.js';
import * as coverage from '../src/world/alpine/OpeningCoverage.js';

function terrain() {
  const tiles = new Map();
  for (let z = 0; z < 3; z++) for (let x = 0; x < 4; x++) {
    if (x === 3 && z === 1) continue;
    const t = { id: `${x},${z}`, ix: x, iz: z, visible: true, rail: x !== 2, minY: 100, maxY: 100 };
    tiles.set(t.id, t);
  }
  return { grid: { width: 401, height: 301, cellSizeM: 10, originM: [0, 0] }, cells: 100,
    tiles, byIndex: tiles, groundAt: (x, z) => tiles.has(`${Math.min(3, Math.floor(x / 1000))},${Math.min(2, Math.floor(z / 1000))}`) ? 100 : NaN };
}
const view = { camera: { eyeStartM: [0, 200, 0], eyeEndM: [0, 200, 3000],
  targetStartM: [0, 100, -1000], targetEndM: [0, 100, -1000], fovYDeg: 35 } };

test('coverage follows irregular source boundaries and separate rail/tour footprints without clamping outside', () => {
  assert.equal(typeof coverage.buildOpeningCoverage, 'function', 'explicit coverage field is missing');
  const field = coverage.buildOpeningCoverage(terrain(), view);
  assert.ok(field.width <= 129 && field.height <= 129);
  const at = (x, z, tour = false) => coverage.sampleOpeningCoverage(field, x, z, tour);
  assert.equal(at(-1, 1500).source, 0);
  assert.equal(at(4001, 1500).source, 0);
  assert.equal(at(3500, 1500, true).source, 0, 'a missing interior tile remains missing');
  assert.ok(at(1500, 1500, true).source > .98, 'an interior band boundary stays solid');
  assert.equal(at(2500, 1500).source, 0, 'tour-only terrain is outside the rail coverage');
  assert.ok(at(2500, 1500, true).source > .9);
  assert.ok(at(3000, 1500, true).source < .02, 'the exact exposed edge fades into its support');
  for (const x of [2700, 2800, 2900, 2950, 3000]) {
    assert.ok(at(x, 1500, true).source <= at(x - 50, 1500, true).source + .001);
  }
});

test('near-camera ground beyond the placed forest footprint keeps continuous canopy instead of a bare strip', () => {
  assert.equal(typeof coverage.forestHandoff, 'function', 'placement-aware forest handoff is missing');
  const canopyExpression = SCENE_FRAG.match(/float cover = expectedForestCover\([^;]+;/)?.[0];
  assert.ok(canopyExpression, 'exercise the production canopy contribution');
  const canopy = new Function('placement', 'handoff', canopyExpression
    .replace(/float cover = expectedForestCover\([^)]*\)/, 'return 1')
    .replace('farForestMix(forestDist, uFarForest.xy)', 'handoff'));
  for (let available = 0; available <= 1; available += .025) for (const distance of [100, 6500, 7000, 7800, 9000]) {
    const handoff = coverage.forestHandoff(distance, available);
    const current = coverage.forestHandoff(distance, 1).canopy;
    assert.equal(canopy(available, current), handoff.canopy);
    assert.ok(Math.abs(handoff.instances + handoff.canopy - 1) < 1e-12, 'representations cover the same stand through the entire handoff');
  }
  assert.deepEqual(coverage.forestHandoff(100, 0), { instances: 0, canopy: 1 });
  const distant = { camera: { ...view.camera, eyeStartM: [-8000, 200, 0], eyeEndM: [-8000, 200, 3000] } };
  const field = coverage.buildOpeningCoverage(terrain(), distant);
  assert.equal(coverage.sampleOpeningCoverage(field, 1000, 1500).forest, 0);
});

test('sliced construction preserves bytes and cancellation stops before another row', async () => {
  const data = terrain(), sync = coverage.buildOpeningCoverage(data, view);
  let yields = 0;
  const asyncField = await coverage.buildOpeningCoverageAsync(data, view, { sliceMs: 0, yieldTo: async () => { yields++; } });
  assert.ok(yields >= asyncField.height);
  assert.deepEqual(asyncField, sync);
  const abort = new AbortController();
  let checks = 0;
  await assert.rejects(coverage.buildOpeningCoverageAsync(data, view, { sliceMs: 0, signal: abort.signal,
    checkCurrent: () => { checks++; }, yieldTo: async () => abort.abort() }), { name: 'AbortError' });
  assert.equal(checks, 2, 'no resumed row or publication after cancellation');
});

test('source feather is absent at full height and leaves interior material output exact', () => {
  const block = SCENE_FRAG.match(/float sourceEdge = 0\.0;[\s\S]*?\n {4}if \(sourceEdge/)[0].replace(/\n {4}if \(sourceEdge$/, '');
  const run = new Function('uLandRise', 'openingSourceCoverage', 'smoothstep', 'vUv', 'uTourEye',
    block.replaceAll('float ', 'let ') + '\nreturn sourceEdge;');
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (const rise of [0, .2, .5, .6, .7, .9, 1]) {
    assert.equal(run({ x: 1 - rise }, () => 1, smooth, null, { w: 0 }), 0, 'source interiors stay untouched');
    const edge = run({ x: 1 - rise }, () => 0, smooth, null, { w: 1 });
    if (rise >= .7) assert.ok(Math.abs(edge) < 1e-12, `rise ${rise}: complete authored material remains exact`);
    else assert.ok(edge > 0);
  }
});

test('field accounts CPU/GPU bytes, binds the shared coverage in color/depth trees, and disposes once', () => {
  assert.equal(typeof coverage.createOpeningCoverage, 'function');
  const field = coverage.buildOpeningCoverage(terrain(), view), made = coverage.createOpeningCoverage(THREE, field);
  assert.equal(made.bytes, field.data.byteLength * 2);
  assert.ok(made.bytes <= coverage.openingCoverageBytes());
  let disposed = 0; made.texture.addEventListener('dispose', () => disposed++);
  made.dispose(); made.dispose(); assert.equal(disposed, 1);
  assert.match(SCENE_FRAG, /openingSourceCoverage\(/);
  assert.match(SCENE_FRAG, /1\.0 - \(1\.0 - farForestMix\(forestDist, uFarForest.xy\)\)\s*\* placement/);
  const f = createForest(THREE, { mesh: new Float32Array([0,100,0,20,6,0,.2,0]), billboard: new Float32Array(), count: 1, stride: 8 }, {});
  for (const object of [...Object.values(f.byBand).flat(), ...f.depth]) {
    assert.match(object.material.fragmentShader, /forestPlacementCoverage\(/);
  }
  f.dispose();
});
