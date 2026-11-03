// Prove the water colour ranges leave terrain geometry alone and measure what
// they save. Every package's position/index/fringe arrays, at both budgets,
// are compared byte for byte against a baseline commit's own mesh builder.
//   node tools/water-geometry-check.mjs [--base c94cba2] [--out .smoke/water-geometry] [--options '{"maxRanges":6}']
// Counts are one renderWater call of a static view: colour = terrain and seam
// draws, total = colour + the whole depth pre-pass. Rivers are not included.
// A frame that refreshes the lake mirror leaves the seam draws hidden, so the
// counts here are the larger case.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BANDS, buildSurfaceTexture, buildTerrainGeometry, decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { waterColourRanges, waterTexelTable } from '../src/world/alpine/WaterColourRanges.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const repo = path.resolve(import.meta.dirname, '..'), base = arg('base', 'c94cba2');
const out = path.resolve(repo, arg('out', '.smoke/water-geometry')), terrainRoot = path.join(repo, 'src/assets/range/v2/terrain');
const options = JSON.parse(arg('options', 'null')) ?? undefined;

async function baselineMesh() {
  const root = path.join(out, 'base');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const tar = path.join(out, 'base.tar');
  execFileSync('git', ['-C', repo, 'archive', '-o', tar, base, 'src/world/alpine/TerrainMesh.js', 'src/world/alpine/TerrainPackage.js', 'src/world/alpine/PreparationSteps.js']);
  execFileSync('tar', ['-xf', path.relative(repo, tar).replaceAll('\\', '/'), '-C', path.relative(repo, root).replaceAll('\\', '/')], { cwd: repo });
  await fs.rm(tar);
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  return import(new URL(`file:///${path.join(root, 'src/world/alpine/TerrainMesh.js').replaceAll('\\', '/')}`));
}

const hash = a => createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex');

/** The shader's water test at one point, for triangles the ranges dropped. */
function coverage(surface, grid, x, z) {
  const px = (x - grid.originM[0]) / ((grid.width - 1) * grid.cellSizeM) * (surface.width - 1);
  const pz = (z - grid.originM[1]) / ((grid.height - 1) * grid.cellSizeM) * (surface.height - 1);
  const cx = Math.floor(px), cz = Math.floor(pz), fx = px - cx, fz = pz - cz;
  const wet = (ox, oz) => {
    const tx = Math.min(surface.width - 1, Math.max(0, cx + ox)), tz = Math.min(surface.height - 1, Math.max(0, cz + oz));
    return surface.data[(tz * surface.width + tx) * 4 + 3] === 255 ? 1 : 0;
  };
  return (wet(0, 0) * (1 - fx) + wet(1, 0) * fx) * (1 - fz) + (wet(0, 1) * (1 - fx) + wet(1, 1) * fx) * fz;
}

function assertDroppedDry(positions, indices, groups, surface, grid) {
  let next = 0, checked = 0;
  for (const g of [...groups, { start: indices.length, count: 0 }]) {
    for (let i = next; i < g.start; i += 3) {
      const [a, b, c] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3];
      for (const [wa, wb, wc] of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1 / 3, 1 / 3, 1 / 3], [.5, .5, 0], [0, .5, .5], [.5, 0, .5]]) {
        const x = positions[a] * wa + positions[b] * wb + positions[c] * wc, z = positions[a + 2] * wa + positions[b + 2] * wb + positions[c + 2] * wc;
        assert.ok(coverage(surface, grid, x, z) <= .5, `dropped triangle at index ${i} shows water`);
      }
      checked++;
    }
    next = g.start + g.count;
  }
  return checked;
}

await fs.mkdir(out, { recursive: true });
const before = await baselineMesh();
const packages = (await fs.readdir(terrainRoot)).filter(f => f.endsWith('.terrain.json')).sort();
const report = { base, packages: packages.length, arrays: 0, identical: 0, droppedTrianglesChecked: 0, views: {} };

for (const file of packages) {
  const id = file.replace('.terrain.json', '');
  const manifest = JSON.parse(await fs.readFile(path.join(terrainRoot, file), 'utf8'));
  const bytes = gunzipSync(await fs.readFile(path.join(terrainRoot, `${id}.terrain.bin.gz`)));
  const data = decodeTerrain(manifest, bytes), oldData = before.decodeTerrain(manifest, bytes);
  const surface = buildSurfaceTexture(data), table = waterTexelTable(surface);
  for (const budget of ['desktop', 'mobile']) {
    const now = buildTerrainGeometry(data, { budget }), then = before.buildTerrainGeometry(oldData, { budget });
    let depth = 0, colour = 0, restricted = 0, draws = 0, groupsDrawn = 0;
    const geometries = [];
    for (const band of BANDS) {
      const a = now.bands[band], b = then.bands[band];
      for (const key of ['positions', 'indices', 'fringe']) {
        report.arrays++;
        assert.equal(a[key].constructor, b[key].constructor);
        assert.equal(hash(a[key]), hash(b[key]), `${id} ${budget} ${band} ${key} differs from ${base}`);
        report.identical++;
      }
      depth += a.indices.length;
      geometries.push([a.positions, a.indices]);
      if (band !== 'far' && a.fringe.length) geometries.push([a.positions, a.fringe]);
    }
    for (const [positions, indices] of geometries) {
      if (!indices.length) continue;
      colour += indices.length; draws++;
      const groups = waterColourRanges(positions, indices, table, data.grid, options);
      if (groups) report.droppedTrianglesChecked += assertDroppedDry(positions, indices, groups, surface, data.grid);
      restricted += groups ? groups.reduce((n, g) => n + g.count, 0) : indices.length;
      groupsDrawn += groups ? groups.length : 1;
    }
    for (const band of BANDS) {
      const a = now.bands[band], b = then.bands[band];
      assert.equal(hash(a.indices), hash(b.indices), 'range planning changed an input array');
      assert.equal(hash(a.positions), hash(b.positions), 'range planning changed an input array');
      assert.equal(hash(a.fringe), hash(b.fringe), 'range planning changed an input array');
    }
    report.views[`${id}:${budget}`] = { colourBefore: colour, colourAfter: restricted, colourSaved: 1 - restricted / colour,
      totalBefore: depth + colour, totalAfter: depth + restricted, totalSaved: 1 - (depth + restricted) / (depth + colour), drawsBefore: draws, drawsAfter: groupsDrawn };
  }
}
assert.equal(report.identical, report.packages * 2 * BANDS.length * 3);
await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const row = report.views['teton-jackson-lake:mobile'];
console.log(`${report.identical}/${report.arrays} arrays byte-identical to ${base} across ${report.packages} packages and both budgets`);
console.log(`${report.droppedTrianglesChecked} dropped triangles sampled dry`);
console.log('teton-jackson-lake mobile, one water call:', row);
