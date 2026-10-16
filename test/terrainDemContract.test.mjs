// Range v2 Task 2: the normalized elevation contract. GDAL-backed cases run
// when a Python with the GDAL bindings is present (MIDIO_GDAL_PYTHON or a
// discoverable python3); the payload-validation cases always run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGdalPython, normalizeDem, readDemGrid, sampleHeight } from '../tools/lib/terrain-source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'terrain');
const labels = JSON.parse(await fs.readFile(path.join(fixtures, 'fixtures.json'), 'utf8'));
const python = await findGdalPython();
const gdalTest = python ? test : (name, fn) => test(name, { skip: 'no Python with GDAL bindings' }, fn);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-dem-'));

const norm = (name, extra) => normalizeDem(path.join(fixtures, `${name}.tif`), {
  out: path.join(tmp, name), centerLonLat: labels[name].center, python, retrievedAt: '2026-09-29', ...extra,
});

gdalTest('a sloped plane keeps its orientation and labeled heights', async () => {
  const g = await norm('plane', { extentM: [400, 400], cellM: 10 });
  assert.equal(g.width, 41);
  assert.equal(g.height, 41);
  assert.equal(g.sourceResolutionM, 10);
  assert.equal(g.upsampled, false);
  for (const p of labels.plane.points) {
    const h = sampleHeight(g, p.x, p.z);
    // Bilinear between warped cells of a plane: exact up to float rounding.
    assert.ok(Math.abs(h - p.h) < 0.05, `height at ${p.x},${p.z}: ${h} vs ${p.h}`);
  }
  // East is +X and higher; north is -Z and higher (the plane rises both ways).
  assert.ok(sampleHeight(g, 50, 0) > sampleHeight(g, -50, 0));
  assert.ok(sampleHeight(g, 0, -50) > sampleHeight(g, 0, 50), 'north/south mirrored');
  assert.equal(g.provenance.sha256.length, 1);
  assert.match(g.horizontalCrs, /\+proj=tmerc/);
});

gdalTest('an explicitly rotated source grid is recovered in map orientation', async () => {
  const g = await norm('rotated', { extentM: [200, 200], cellM: 10 });
  for (const p of labels.rotated.points) {
    const h = sampleHeight(g, p.x, p.z);
    assert.ok(Math.abs(h - p.h) < 0.5, `rotated height at ${p.x},${p.z}: ${h} vs ${p.h}`);
  }
});

gdalTest('no-data stays invalid and never becomes zero', async () => {
  const g = await norm('hole', { extentM: [400, 400], cellM: 10 });
  const mid = Math.floor(g.height / 2) * g.width + Math.floor(g.width / 2);
  assert.equal(g.valid[mid], 0);
  assert.ok(Number.isNaN(g.heightsM[mid]));
  let invalid = 0;
  for (let i = 0; i < g.valid.length; i++) {
    if (!g.valid[i]) invalid++;
    else assert.ok(g.heightsM[i] > 900, 'a valid cell fell to a fill value');
  }
  assert.ok(invalid >= 100 && invalid < g.valid.length / 2, `invalid cells ${invalid}`);
  assert.ok(Number.isNaN(sampleHeight(g, 0, 0)));
});

gdalTest('non-square geographic pixels keep a north-facing slope', async () => {
  const g = await norm('geographic', { extentM: [600, 400], cellM: 10 });
  // 0.0002 deg lon (~14.8 m) x 0.0001 deg lat (~11.1 m): the coarser axis.
  // Longitude degrees scale with cos(latitude): ~14.8 m at 48 deg, not the
  // equatorial 22.3 m.
  assert.ok(g.sourceResolutionM > 14.3 && g.sourceResolutionM < 15.3, String(g.sourceResolutionM));
  assert.ok(sampleHeight(g, 0, -100) > sampleHeight(g, 0, 100) + 150, 'north slope lost or mirrored');
  // 1 m of height per 1.11 m north: slope survives the warp.
  const dh = sampleHeight(g, 0, -100) - sampleHeight(g, 0, 100);
  assert.ok(Math.abs(dh - 200 / 1.113) < 8, `slope ${dh}`);
  assert.ok(Math.abs(sampleHeight(g, -150, 0) - sampleHeight(g, 150, 0)) < 1, 'east-west should be flat');
});

gdalTest('downsampling averages instead of inventing resolution', async () => {
  const fine = await norm('branched', { extentM: [400, 400], cellM: 5 });
  const coarse = await norm('branched', { extentM: [400, 400], cellM: 20, out: path.join(tmp, 'branched-20') });
  assert.equal(fine.sourceResolutionM, 5);
  assert.equal(coarse.meta.resampling, 'average');
  assert.equal(fine.upsampled, false);
  const up = await norm('branched', { extentM: [100, 100], cellM: 2, out: path.join(tmp, 'branched-2') });
  assert.equal(up.upsampled, true, 'a 2 m grid from a 5 m source must say so');
  // The ridge crest stays at its source easting.
  const row = Math.floor(fine.height * 0.7);
  let best = -1, bestH = -Infinity;
  for (let c = 0; c < fine.width; c++) {
    const h = fine.heightsM[row * fine.width + c];
    if (h > bestH) { bestH = h; best = c; }
  }
  const crestX = fine.originM[0] + best * fine.cellSizeM;
  assert.ok(Math.abs(crestX - labels.branched.ridgeEastingOffsetM) < 15, `crest at ${crestX}`);
});

async function writeFake(prefix, { width = 3, height = 2, heights, valid, tamper = {} } = {}) {
  const h = Buffer.from(new Float32Array(heights).buffer);
  const v = Buffer.from(Uint8Array.from(valid));
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const meta = {
    schema: 'midio.demgrid', version: 1, width, height, cellSizeM: 10, originM: [0, 0],
    centerLonLat: [0, 0], sourceToLocal: [1, 0, 0, 0, -1, 0], localToSource: [1, 0, 0, 0, -1, 0],
    horizontalCrs: '+proj=tmerc', verticalReference: 'synthetic', sourceResolutionM: 10, outputSpacingM: 10,
    upsampled: false, provenance: {},
    payload: {
      heights: { file: path.basename(prefix) + '.f32', byteLength: h.length, sha256: sha(h) },
      valid: { file: path.basename(prefix) + '.valid.u8', byteLength: v.length, sha256: sha(v) },
    },
    ...tamper,
  };
  await fs.writeFile(prefix + '.f32', h);
  await fs.writeFile(prefix + '.valid.u8', v);
  await fs.writeFile(prefix + '.json', JSON.stringify(meta));
}

test('readDemGrid validates schema, lengths, hashes and finite valid cells', async () => {
  const ok = path.join(tmp, 'fake-ok');
  await writeFake(ok, { heights: [1, 2, 3, 4, NaN, 6], valid: [1, 1, 1, 1, 0, 1] });
  const g = await readDemGrid(ok);
  assert.equal(g.heightsM[3], 4);
  assert.ok(Number.isNaN(g.heightsM[4]));
  assert.equal(sampleHeight(g, 5, 0), 1.5);

  const badSchema = path.join(tmp, 'fake-schema');
  await writeFake(badSchema, { heights: [1, 2, 3, 4, 5, 6], valid: [1, 1, 1, 1, 1, 1], tamper: { version: 2 } });
  await assert.rejects(readDemGrid(badSchema), /unsupported DEM schema/);

  const badLen = path.join(tmp, 'fake-len');
  await writeFake(badLen, { heights: [1, 2, 3, 4, 5], valid: [1, 1, 1, 1, 1, 1] });
  await assert.rejects(readDemGrid(badLen), /length mismatch/);

  const badHash = path.join(tmp, 'fake-hash');
  await writeFake(badHash, { heights: [1, 2, 3, 4, 5, 6], valid: [1, 1, 1, 1, 1, 1] });
  await fs.writeFile(badHash + '.f32', Buffer.from(new Float32Array([1, 2, 3, 4, 5, 7]).buffer));
  await assert.rejects(readDemGrid(badHash), /hash mismatch/);

  const nanValid = path.join(tmp, 'fake-nan');
  await writeFake(nanValid, { heights: [1, 2, NaN, 4, 5, 6], valid: [1, 1, 1, 1, 1, 1] });
  await assert.rejects(readDemGrid(nanValid), /not finite/);
});
