import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { bakeTerrain, encodeResiduals } from '../tools/lib/terrain-bake.mjs';
import { alignTourToRail, bakeGzip } from '../tools/align-tour-terrain.mjs';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';

// The terrainBakePoses fixture: 4 x 4 tiles of 64 cells at 20 m, a rail at
// z = -600 looking north.
function fixture() {
  const width = 257, depth = 257, cellSizeM = 20, originM = [-2560, -2560];
  const height = (x, z) => 1000 + 150 * Math.sin(x / 900) * Math.cos(z / 800) + 0.3 * Math.sin(x / 37 + z / 53) + 0.15 * Math.cos(x / 23 - z / 31);
  const heightsM = new Float32Array(width * depth);
  for (let j = 0; j < depth; j++) for (let i = 0; i < width; i++) heightsM[j * width + i] = height(originM[0] + i * cellSizeM, originM[1] + j * cellSizeM);
  const grid = { width, height: depth, cellSizeM, originM, heightsM, valid: new Uint8Array(width * depth).fill(1),
    horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 20, outputSpacingM: 20 };
  const view = { id: 'align-test', camera: { eyeStartM: [0, 1500, -600], eyeEndM: [0, 1500, -600],
    targetStartM: [0, 1000, -2400], targetEndM: [0, 1000, -2400], fovYDeg: 30 } };
  return { grid, view };
}
// A coarse, distant tour pose that sees the rail's extended tiles in core,
// and one behind the rail that adds tiles only it sees.
const POSES = [{ eyeM: [0, 6000, 2400], targetM: [0, 1000, -1800], fovYDeg: 70 }, { eyeM: [640, 1500, 600], targetM: [640, 1000, 1920], fovYDeg: 20 }];
const key = (t) => `${t.ix},${t.iz}`;

/** Repack a manifest's tiles (re-encoding the ones `replace` returns new
 *  samples for) into a fresh payload, as a pre-fix tour bake would ship. */
function repack(manifest, decoded, replace = () => null) {
  const chunks = [];
  let at = 0;
  const push = (buf) => { const o = at; chunks.push(Buffer.from(buf)); at += buf.byteLength; return o; };
  const tiles = manifest.tiles.map((t) => {
    const r = replace(t);
    if (r) {
      const { q, flow, stride } = r, n = 64 / stride + 1;
      const res = encodeResiduals(q, n), planes = new Uint8Array(2 * n * n);
      for (let i = 0; i < n * n; i++) { planes[i] = res[i] & 255; planes[n * n + i] = res[i] >> 8; }
      return { ...t, ...r.fields, stride, samples: n,
        heights: { ...t.heights, byteOffset: push(planes), byteLength: planes.byteLength, count: n * n },
        flow: { ...t.flow, byteOffset: push(flow), byteLength: flow.byteLength, count: n * n }, validity: { mode: 'all' } };
    }
    const slice = (range) => decoded.subarray(range.byteOffset, range.byteOffset + range.byteLength);
    return { ...t, heights: { ...t.heights, byteOffset: push(slice(t.heights)) }, flow: { ...t.flow, byteOffset: push(slice(t.flow)) },
      validity: t.validity.mode === 'bits' ? { ...t.validity, byteOffset: push(slice(t.validity)) } : t.validity };
  });
  const bytes = Buffer.concat(chunks), gz = bakeGzip(bytes);
  return { manifest: { ...manifest, tiles, payload: { ...manifest.payload, byteLength: gz.byteLength, decodedByteLength: bytes.byteLength } }, gz };
}

/** The fixed bake, its rail-only bake, and a pre-fix version of the fixed
 *  bake: no rail marks or rail bounds, one rail tile coarsened to a single
 *  quad and another moved to a nearer or farther band. */
async function packages() {
  const { grid, view } = fixture();
  const rail = await bakeTerrain(grid, view);
  const fixed = await bakeTerrain(grid, view, { poses: POSES, poseErrorScale: 64 });
  const railTiles = new Map(rail.manifest.tiles.map((t) => [key(t), t]));
  const same = fixed.manifest.tiles.filter((t) => railTiles.has(key(t)) && t.stride < 64 && JSON.stringify(t.lod) === JSON.stringify(railTiles.get(key(t)).lod));
  assert.ok(same.length >= 2, 'fixture has rail tiles to degrade');
  const [coarsen, reband] = same;
  const data = decodeTerrain(fixed.manifest, fixed.decoded);
  const { offsetM, stepM } = fixed.manifest.quantization;
  const old = repack({ ...fixed.manifest, railBoundsM: undefined, tiles: fixed.manifest.tiles.map(({ rail: _r, ...t }) => (key(t) === key(reband) ? { ...t, band: t.band === 'near' ? 'far' : 'near' } : t)) },
    fixed.decoded, (t) => {
      if (key(t) !== key(coarsen)) return null;
      const d = data.byIndex.get(key(t)), n = d.samples, s = 64 / d.stride;
      const at = (u, v) => v * s * n + u * s;
      const idx = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
      return { stride: 64, q: Uint16Array.from(idx, (i) => Math.round((d.heightsM[i] - offsetM) / stepM)), flow: Uint8Array.from(idx, (i) => d.flowBytes[i]),
        fields: { lod: { desktop: 64, mobile: 64 }, errorsM: { 64: d.errorsM['64'] } } };
    });
  delete old.manifest.railBoundsM;
  return { grid, view, rail, fixed, old, coarsen, reband };
}

test('aligning a pre-fix tour package with its rail package reproduces the fixed bake', async () => {
  const { rail, fixed, old, coarsen, reband } = await packages();
  const before = new Map(old.manifest.tiles.map((t) => [key(t), t]));
  assert.equal(before.get(key(coarsen)).stride, 64);
  assert.notEqual(before.get(key(reband)).band, reband.band);
  const out = alignTourToRail(old, { manifest: rail.manifest, gz: rail.payload });
  assert.deepEqual(out.decoded, fixed.decoded, 'the payload is the fixed bake\'s, byte for byte');
  assert.deepEqual(out.payload, fixed.payload);
  assert.equal(JSON.stringify(out.manifest.tiles), JSON.stringify(fixed.manifest.tiles), 'every tile record is the fixed bake\'s');
  assert.deepEqual(out.manifest.railBoundsM, rail.manifest.boundsM);
  assert.deepEqual(out.manifest.estimatedBytes, fixed.manifest.estimatedBytes);
  assert.deepEqual(Object.keys(out.manifest), Object.keys(fixed.manifest));
  assert.equal(out.stats.spliced, 1);
  assert.equal(out.stats.rebanded, 1);
  assert.equal(out.stats.tourOnly, fixed.manifest.tiles.filter((t) => t.rail === false).length);
  // Already aligned: a no-op.
  const again = alignTourToRail({ manifest: out.manifest, gz: out.payload }, { manifest: rail.manifest, gz: rail.payload });
  assert.deepEqual(again.payload, out.payload);
  assert.equal(JSON.stringify(again.manifest), JSON.stringify(out.manifest));
});

test('alignment refuses drifted samples, foreign grids and a tour-baked rail', async () => {
  const { rail, old, fixed } = await packages();
  const railPkg = { manifest: rail.manifest, gz: rail.payload };
  // One shared sample one metre higher in the tour package.
  const bytes = Buffer.from(zlib.gunzipSync(old.gz));
  const t = old.manifest.tiles.find((x) => rail.manifest.tiles.some((r) => key(r) === key(x)));
  bytes[t.heights.byteOffset] = (bytes[t.heights.byteOffset] + Math.round(1 / old.manifest.quantization.stepM)) & 255;
  assert.throws(() => alignTourToRail({ manifest: old.manifest, gz: bakeGzip(bytes) }, railPkg), /source drift|flow differs/);
  assert.throws(() => alignTourToRail(old, { manifest: { ...rail.manifest, grid: { ...rail.manifest.grid, cellSizeM: 30 } }, gz: rail.payload }), /differ in grid/);
  assert.throws(() => alignTourToRail(old, { manifest: fixed.manifest, gz: fixed.payload }), /itself a tour bake/);
  assert.throws(() => alignTourToRail(railPkg, railPkg), /itself a tour bake|not a tour bake/);
});
