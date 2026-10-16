import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findPoints } from '../tools/lib/tour-points.mjs';

function terrain(width, height, heightAt, cellSizeM = 100) {
  return { width, height, cellSizeM, originM: [0, 0],
    heightsM: Float32Array.from({ length: width * height }, (_, i) => heightAt(i % width, Math.floor(i / width))),
    valid: new Uint8Array(width * height).fill(1) };
}
const peaksOf = result => result.points.filter(p => ['summit', 'subpeak', 'butte'].includes(p.type));

test('a cone has one summit with explicitly truncated window prominence', () => {
  const grid = terrain(21, 21, (x, y) => 1200 - 40 * Math.hypot(x - 10, y - 10));
  const points = peaksOf(findPoints(grid, { pMin: 15, isoMin: 120 }));
  assert.equal(points.length, 1);
  assert.equal(points[0].index, 10 * 21 + 10);
  assert.equal(points[0].elevationM, 1200);
  assert.equal(points[0].prominenceTruncated, true);
  assert.equal(points[0].parentId, null);
  assert.equal(points[0].keyColId, null);
  assert.ok(Math.abs(points[0].prominenceM - (1200 - Math.min(...grid.heightsM))) < .001);
  assert.equal(points[0].isolationM, 20000);
  assert.equal(points[0].isolationCapped, true);
});

function joinedCones() {
  const ridge = [200, 200, 400, 600, 800, 600, 400, 500, 850, 1000, 700, 500, 300, 200, 200, 200, 200];
  return terrain(17, 7, (x, y) => Math.max(0, ridge[x] - 150 * Math.abs(y - 3)));
}

test('two cones merge at their key col and give the lower summit its exact prominence and parent', () => {
  const result = findPoints(joinedCones(), { pMin: 15, isoMin: 120 });
  const peaks = peaksOf(result);
  assert.equal(peaks.length, 2);
  const lower = peaks.find(p => p.elevationM === 800), higher = peaks.find(p => p.elevationM === 1000);
  assert.equal(lower.prominenceM, 400);
  assert.equal(lower.prominenceTruncated, false);
  assert.equal(lower.parentId, higher.id);
  const col = result.points.find(p => p.id === lower.keyColId);
  assert.equal(col.type, 'col');
  assert.equal(col.index, 3 * 17 + 6);
  assert.equal(col.elevationM, 400);
});

test('isolation measures the nearest higher cell rather than the nearest higher summit', () => {
  const result = findPoints(joinedCones(), { pMin: 15, isoMin: 120 });
  const lower = peaksOf(result).find(p => p.elevationM === 800);
  assert.equal(lower.isolationM, 400);
  assert.equal(lower.isolationCapped, false);
});

test('isolation searches beyond a higher corner in the first matching square ring', () => {
  const grid = terrain(17, 17, (x, y) => x === 5 && y === 5 ? 100 : x === 11 && y === 11 ? 300 : x === 12 && y === 5 ? 200 : 0);
  const p = peaksOf(findPoints(grid, { pMin: 15, isoMin: 0 })).find(p => p.index === 5 * 17 + 5);
  assert.equal(p.isolationM, 700);
});

test('a flat summit is one peak, with deterministic plateau selection', () => {
  const grid = terrain(21, 21, (x, y) => 1000 - 40 * Math.hypot(Math.max(0, 10 - x, x - 11), Math.max(0, 10 - y, y - 11)));
  const a = findPoints(grid), b = findPoints(grid);
  assert.equal(peaksOf(a).length, 1);
  assert.equal(peaksOf(a)[0].index, 10 * 21 + 10);
  assert.deepEqual(a, b);
});

test('a lower peak touching the coverage edge stays marked truncated after an interior merge', () => {
  const ridge = [800, 700, 600, 500, 400, 500, 600, 700, 900, 1000, 700, 500, 300];
  const grid = terrain(13, 9, (x, y) => Math.max(0, ridge[x] - 150 * Math.abs(y - 4)));
  const p = peaksOf(findPoints(grid)).find(p => p.index === 4 * 13);
  assert.equal(p.prominenceTruncated, true);
  assert.equal(p.prominenceM, 800);
  assert.equal(p.keyColId, null);
});

test('prominence and isolation thresholds exclude minor bumps without losing a retained parent', () => {
  assert.equal(peaksOf(findPoints(joinedCones(), { pMin: 401, isoMin: 120 })).length, 1);
  assert.equal(peaksOf(findPoints(joinedCones(), { pMin: 15, isoMin: 401 })).length, 1);
});

test('invalid cells never become peaks or act as higher isolation samples', () => {
  const grid = joinedCones();
  const i = 1 * grid.width + 1;
  grid.valid[i] = 0;
  grid.heightsM[i] = 10000;
  const points = peaksOf(findPoints(grid));
  assert.equal(points.length, 2);
  assert.ok(points.every(p => p.index !== i));
});

test('names match by feature type, distance and peak elevation, and retain source identities', () => {
  const names = [
    { id: '1', name: 'Lower Peak', featureCode: 'PK', localM: [410, 300], lonLat: [-110.8, 43.7], elevationM: 795 },
    { id: '2', name: 'Wrong Height', featureCode: 'PK', localM: [400, 300], elevationM: 600 },
    { id: '3', name: 'Wrong Feature', featureCode: 'LK', localM: [400, 300], elevationM: 800 },
    { id: '4', name: 'Too Far', featureCode: 'PK', localM: [400, 700], elevationM: 800 },
  ];
  const result = findPoints(joinedCones(), { names });
  const peak = peaksOf(result).find(p => p.elevationM === 800);
  assert.equal(peak.name, 'Lower Peak');
  assert.equal(peak.geonamesId, '1');
  assert.deepEqual(peak.nameLonLat, [-110.8, 43.7]);
  assert.equal(peak.fame, 1.5);
  assert.deepEqual(result.stats.unmatchedNames.map(p => p.id), ['2', '3', '4']);
  assert.deepEqual(result.stats.unmatchedProminentPeaks.map(p => p.id), ['2']);
});

test('point properties measure an inclined plane in metres and degrees', async () => {
  const { pointProperties } = await import('../tools/lib/tour-points.mjs');
  const grid = terrain(51, 51, x => 3000 + 25 * x);
  const point = { index: 25 * 51 + 25, localM: [2500, 3625, 2500], elevationM: 3625, type: 'col' };
  const props = pointProperties(grid, point, { water: new Uint8Array(51 * 51) });
  assert.ok(Math.abs(props.meanSlope300Deg - Math.atan(.25) * 180 / Math.PI) < 1e-4);
  assert.equal(props.relief2kmM, 500);
  assert.ok(Math.abs(props.sharpness) < 1e-6);
  assert.equal(props.faceAspectDeg, 270);
  assert.equal(props.waterWithin2km, 0);
  assert.ok(Number.isFinite(props.skyOpenness));
  assert.ok(props.viewshedKm2 > 0 && props.viewshedKm2 < 26);
});

test('a concave lake uses an interior aim point when its centroid lies on dry land', () => {
  const grid = terrain(51, 51, () => 2000, 20), water = new Uint8Array(51 * 51);
  for (let y = 5; y <= 35; y++) for (let x = 5; x <= 35; x++) {
    if (x <= 10 || x >= 30 || y >= 30) water[y * 51 + x] = 1;
  }
  const result = findPoints(grid, { hydrology: { water } });
  const lakes = result.points.filter(p => p.type === 'lake');
  assert.equal(lakes.length, 1);
  assert.equal(lakes[0].areaM2, 194400);
  assert.equal(water[lakes[0].index], 1);
  assert.ok(lakes[0].shorelineM > 0);
  assert.equal(lakes[0].cirqueLake, false);
  assert.ok(Math.abs(lakes[0].waterWithin2km - 486 / (51 * 51)) < 1e-6);
});

test('water components below two hectares are excluded', () => {
  const grid = terrain(21, 21, () => 2000, 20), water = new Uint8Array(21 * 21);
  for (let x = 5; x < 10; x++) water[10 * 21 + x] = 1;
  assert.equal(findPoints(grid, { hydrology: { water } }).points.filter(p => p.type === 'lake').length, 0);
});

test('every extracted point has finite properties and normalized grandeur', () => {
  const { points } = findPoints(joinedCones());
  for (const p of points) {
    for (const key of ['relief2kmM', 'sharpness', 'meanSlope300Deg', 'faceAspectDeg', 'skyOpenness', 'viewshedKm2', 'waterWithin2km', 'grandeur']) {
      assert.ok(Number.isFinite(p[key]), `${p.id} ${key}`);
    }
    assert.ok(['east', 'west', 'crest'].includes(p.side));
    assert.ok(p.grandeur >= 0 && p.grandeur <= 1);
  }
});

test('GeoNames filtering includes lakes and passes, excludes unrelated features, and uses the DEM height fallback', async () => {
  const { parseTourName } = await import('../tools/build-tour-names.mjs');
  const bbox = [-111.13, 43.41, -110.53, 44.09];
  const row = (id, name, code, lon = -110.8, elevation = '', dem = '2100') => {
    const f = new Array(19).fill('');
    Object.assign(f, { 0: id, 1: name, 4: '43.75', 5: String(lon), 6: code === 'LK' ? 'H' : 'T', 7: code, 15: elevation, 16: dem });
    return f.join('\t');
  };
  assert.deepEqual(parseTourName(row('1', 'Lake Test', 'LK'), bbox), {
    id: '1', name: 'Lake Test', featureCode: 'LK', lonLat: [-110.8, 43.75], elevationM: 2100,
  });
  assert.equal(parseTourName(row('2', 'Pass Test', 'PASS'), bbox).featureCode, 'PASS');
  assert.equal(parseTourName(row('3', 'Unknown Height', 'PK', -110.8, '', '-9999'), bbox).elevationM, null);
  assert.equal(parseTourName(row('4', 'Outside', 'PK', -112), bbox), null);
  assert.equal(parseTourName(row('5', 'City', 'PPL'), bbox), null);
});

test('a high-flow steep-to-flat break produces one canyon point at the greatest-flow break cell', () => {
  const grid = terrain(17, 51, (x, y) => y < 25 ? 1000 + (25 - y) * 80 : 1000 - (y - 25) * 2);
  const n = grid.width * grid.height, accumulation = new Float64Array(n), downstream = new Int32Array(n).fill(-1);
  for (let y = 1; y < 50; y++) {
    const i = y * 17 + 8;
    accumulation[i] = 4096 + y * 100;
    downstream[i] = i + 17;
  }
  const hydrology = { accumulation, downstream, water: new Uint8Array(n) };
  const points = findPoints(grid, { hydrology }).points.filter(p => p.type === 'canyon');
  assert.equal(points.length, 1);
  assert.equal(points[0].index, 26 * 17 + 8);
  assert.equal(points[0].canyonAxisDeg, 180);
  accumulation.fill(4095);
  assert.equal(findPoints(grid, { hydrology }).points.filter(p => p.type === 'canyon').length, 0);
});

test('a low isolated peak over three kilometres from the main crest is a butte', () => {
  const grid = terrain(101, 101, (x, y) => Math.max(3000 - 25 * Math.hypot(x - 75, y - 50), 2200 - 20 * Math.hypot(x - 20, y - 50)));
  const point = peaksOf(findPoints(grid)).find(p => p.elevationM === 2200);
  assert.equal(point.type, 'butte');
  assert.ok(point.distanceToCrestM > 3000);
});

test('the names build projects and clips a local dump, and records its actual content hash', async t => {
  const { findGdalPython } = await import('../tools/lib/terrain-source.mjs');
  if (!await findGdalPython()) return t.skip('Python GDAL bindings unavailable');
  const { buildTourNames } = await import('../tools/build-tour-names.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tour-names-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const authoring = path.join(dir, 'authoring.json'), input = path.join(dir, 'US.txt'), out = path.join(dir, 'names.json');
  await fs.writeFile(authoring, JSON.stringify({ dem: { centerLonLat: [-110.83, 43.75], extentM: [2000, 2000], cellM: 20 } }));
  const row = (id, lon, lat) => {
    const f = new Array(19).fill('');
    Object.assign(f, { 0: id, 1: `Peak ${id}`, 4: String(lat), 5: String(lon), 6: 'T', 7: 'PK', 15: '2500' });
    return f.join('\t');
  };
  await fs.writeFile(input, [row('1', -110.83, 43.75), row('2', -110.829, 43.751), row('3', -110.85, 43.75)].join('\n'));
  const result = await buildTourNames({ authoring, input, out, log: () => {} });
  assert.deepEqual(result.names.map(n => n.id), ['1', '2']);
  assert.ok(Math.hypot(...result.names[0].localM) < .001);
  assert.ok(result.names[1].localM[0] > 70 && result.names[1].localM[0] < 90);
  assert.ok(result.names[1].localM[1] < -100 && result.names[1].localM[1] > -120);
  assert.match(result.provenance.sha256, /^[a-f\d]{64}$/);
  assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), result);
});

// The real West Horn record is 87 m below a 3DEP peak just 30 m away.
// A region-specific tolerance must be explicit and audited; ordinary callers
// retain the 60 m rule, and a genuinely wrong height must still reject.
test('a documented regional name-height tolerance preserves and audits the source discrepancy', () => {
  const names = [{ id: 'west-horn', name: 'West Horn', featureCode: 'MT', localM: [410, 300], elevationM: 713 }];
  const options = { names, nameElevationToleranceM: 100 };
  const result = findPoints(joinedCones(), options);
  const p = peaksOf(result).find(p => p.elevationM === 800);
  assert.equal(p.name, 'West Horn');
  assert.equal(p.nameElevationM, 713);
  assert.equal(p.nameElevationDeltaM, 87);
  assert.equal(result.stats.unmatchedProminentPeaks.length, 0);
  assert.deepEqual(result.stats.nameHeightDiscrepancies, [{ pointId: p.id, geonamesId: 'west-horn', name: 'West Horn', sourceElevationM: 713, demElevationM: 800, deltaM: 87 }]);
  assert.equal(peaksOf(findPoints(joinedCones(), { names })).find(p => p.elevationM === 800).name, undefined);
  assert.equal(peaksOf(findPoints(joinedCones(), { ...options, names: [{ ...names[0], elevationM: 699 }] })).find(p => p.elevationM === 800).name, undefined);
  assert.throws(() => findPoints(joinedCones(), { nameElevationToleranceM: Infinity }), /name.*tolerance/i);
});
