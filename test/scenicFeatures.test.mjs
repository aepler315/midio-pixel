import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSubjects, valleyPaths, shorelines } from '../tools/lib/scenic-features.mjs';
import { heightAt, localToLonLat, lonLatToLocal, loadViewContext } from '../tools/lib/scenic-terrain.mjs';
import { LANDFORMS } from '../tools/lib/scenic-shots.mjs';
import { SUBJECT_KINDS } from '../src/world/terrain/ShotLibrary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = { discovery: { maxSubjects: 12, minSubjectSpacingM: 1800, prominenceMinM: 80, snapRadiusM: 2500 }, clearance: { boundaryMarginM: 1500 } };
const dist2 = (p, x, z) => Math.hypot(p[0] - x, p[2] - z);
const quiet = { log: () => {} };

function grid(n, cell, fn) {
  const heightsM = new Float32Array(n * n), valid = new Uint8Array(n * n).fill(1), o = -((n - 1) * cell) / 2;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) heightsM[r * n + c] = fn(o + c * cell, o + r * cell);
  return { width: n, height: n, cellSizeM: cell, originM: [o, o], heightsM, valid,
    horizontalCrs: '+proj=tmerc +lat_0=40 +lon_0=-110 +k=1 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs', sourceToLocal: [1, 0, 0, 0, -1, 0] };
}

// 14 km square: a smooth 700 m mountain, a 260 m steep-walled table, a
// flat 900 m lake, on a gently tilted floor; optionally a second, smaller
// 150 m table and a no-data hole under the rail target.
const PEAK = [-3000, -2500], BUTTE = [3000, -2000], LAKE = [0, 3500], SMALL = [4500, 1000];
const table = (x, z, [cx, cz], h, r) => {
  const d = Math.hypot(x - cx, z - cz);
  return d < r ? h : d < r + 130 ? (h * (r + 130 - d)) / 130 : 0;
};
function landscape({ landmarks = [], small = false, hole = false } = {}) {
  const g = grid(701, 20, (x, z) => {
    const floor = 1000 + 0.004 * x;
    const rl = Math.hypot(x - LAKE[0], z - LAKE[1]);
    if (rl < 900) return 985;
    const mountain = 700 * Math.exp(-((Math.hypot(x - PEAK[0], z - PEAK[1]) / 1300) ** 2));
    return floor + mountain + table(x, z, BUTTE, 260, 350) + (small ? table(x, z, SMALL, 150, 250) : 0);
  });
  const water = new Uint8Array(701 * 701);
  for (let r = 0; r < 701; r++) for (let c = 0; c < 701; c++) {
    const x = g.originM[0] + c * 20, z = g.originM[1] + r * 20;
    if (Math.hypot(x - LAKE[0], z - LAKE[1]) < 900) water[r * 701 + c] = 1;
    if (hole && Math.abs(x) <= 300 && Math.abs(z) <= 300) { g.valid[r * 701 + c] = 0; g.heightsM[r * 701 + c] = NaN; }
  }
  const camera = { eyeStartM: [-500, 1300, 6000], eyeEndM: [500, 1300, 6000], targetStartM: [-500, 1100, 0], targetEndM: [500, 1100, 0], fovYDeg: 30 };
  return { viewId: 'synthetic', grid: g, water, camera, landmarks };
}

test('discovers a peak, a butte and a lake from the DEM, plus the rail target', () => {
  const ctx = landscape();
  const subjects = discoverSubjects(ctx, null, DEFAULTS);
  const ids = new Set(subjects.map((s) => s.id));
  assert.equal(ids.size, subjects.length, 'unique ids');
  for (const s of subjects) {
    assert.ok(SUBJECT_KINDS.includes(s.kind), s.kind);
    assert.ok(s.grandeur >= 0 && s.grandeur <= 1 && s.radiusM > 0 && s.posM.every(Number.isFinite), s.id);
    if (s.kind !== 'rail-target') assert.ok(Math.abs(s.posM[0]) <= 7000 - 1500 && Math.abs(s.posM[2]) <= 7000 - 1500, `${s.id} inside the margin`);
  }
  const rail = subjects.find((s) => s.kind === 'rail-target');
  assert.deepEqual([rail.id, rail.source, rail.posM], ['rail-target', 'rail', [0, 1100, 0]]);
  const peak = subjects.find((s) => s.kind === 'peak' && dist2(s.posM, ...PEAK) < 150);
  assert.ok(peak, 'peak found');
  assert.ok(peak.prominenceM > 600 && peak.heightM > 500 && peak.source === 'dem' && /^peak-w\d+-n\d+$/.test(peak.id));
  const butte = subjects.find((s) => s.kind === 'butte' && dist2(s.posM, ...BUTTE) < 400);
  assert.ok(butte, 'butte found');
  assert.ok(Math.abs(butte.heightM - 260) < 40 && butte.prominenceM > 200);
  assert.ok(!subjects.some((s) => s.kind === 'butte' && dist2(s.posM, ...PEAK) < 1500), 'the smooth mountain is not a butte');
  const lake = subjects.find((s) => s.kind === 'lake');
  assert.ok(lake && dist2(lake.posM, ...LAKE) < 300 && Math.abs(lake.posM[1] - 985) < 1e-3);
  assert.ok(Math.abs(lake.radiusM - 900) < 100 && lake.axisM.length === 2 && lake.polygonM.length >= 8);
  for (const [x, z] of lake.polygonM) assert.ok(Math.abs(Math.hypot(x - LAKE[0], z - LAKE[1]) - 900) < 60, 'polygon on the shore');
  // Point landforms keep their spacing; the rail target (an aim point) blocks nothing.
  const points = subjects.filter((s) => ['peak', 'butte', 'landmark'].includes(s.kind));
  for (const a of points) for (const b of points) if (a !== b) assert.ok(dist2(a.posM, b.posM[0], b.posM[2]) >= 1800, `${a.id} / ${b.id} spacing`);
  // shorelines(ctx) follows the lake subjects of the last discovery.
  assert.deepEqual(shorelines(ctx).map((s) => s.lakeId), [lake.id]);
  // Stable: the same input gives the same subjects.
  assert.deepEqual(discoverSubjects(landscape(), null, DEFAULTS), subjects);
});

test('DEM features are ranked only inside the tour focus (rail target and heroes), named subjects always kept', () => {
  // Centred on the rail target [0, 0]: the lake lies 3.5 km away, the
  // mountain's summit 3.905 km, the table's highest (east) rim 3.935 km.
  const kinds = (list) => list.filter((s) => s.source === 'dem').map((s) => s.kind).sort();
  assert.deepEqual(kinds(discoverSubjects(landscape(), { focusRadiusM: 3700 }, DEFAULTS)), ['lake']);
  assert.deepEqual(kinds(discoverSubjects(landscape(), { focusRadiusM: 3920 }, DEFAULTS)), ['lake', 'peak']);
  assert.deepEqual(kinds(discoverSubjects(landscape(), { focusRadiusM: 4000 }, DEFAULTS)), ['butte', 'lake', 'peak']);
  // A hero at the mountain moves the centre to [-1500, -1250]: now only the
  // named mountain is kept, and no DEM feature lies outside 3.7 km.
  const ctx = landscape({ landmarks: [{ name: 'Big Peak', lonLat: null, localM: [PEAK[0], 1690, PEAK[1]] }] });
  const region = { focusRadiusM: 3700, hero: ['Big Peak'], subjects: [{ name: 'Big Peak', kind: 'peak' }] };
  const heroed = discoverSubjects(ctx, region, DEFAULTS);
  assert.ok(heroed.some((s) => s.id === 'big-peak'));
  for (const s of heroed.filter((x) => x.source === 'dem')) assert.ok(dist2(s.posM, -1500, -1250) <= 3700, `${s.id} in focus`);
  assert.ok(!heroed.some((s) => s.kind === 'butte' || s.kind === 'lake'));
  // The landform's focus applies when the region gives no radius.
  const formed = discoverSubjects(landscape(), { landform: 'butte' }, { ...DEFAULTS, discovery: { ...DEFAULTS.discovery, focusRadiusM: 100 } });
  assert.equal(LANDFORMS.butte.focusM, 6000);
  assert.ok(formed.some((s) => s.kind === 'peak') && formed.some((s) => s.kind === 'butte'));
});

test('config subjects: landmarks matched by name, approximate positions snapped to the NEAREST DEM feature, names kept', () => {
  const g = landscape().grid;
  const ctx = landscape({ small: true, landmarks: [{ name: 'Big Peak', lonLat: null, localM: [PEAK[0] + 60, 1690, PEAK[1] + 40] }] });
  // Between the two tables, nearer the small one (1.1 km vs 2.2 km): the
  // big table is the stronger feature, the small one the nearest.
  const tablePoint = [4000, 0];
  const region = {
    subjects: [
      { name: 'Big Peak', kind: 'peak', weight: 1.3 },
      { name: 'Table Butte', kind: 'butte', lonLat: localToLonLat(g, tablePoint), approximate: true, weight: 1.2 },
      { name: 'Round Lake', kind: 'lake', lonLat: localToLonLat(g, [LAKE[0] + 300, LAKE[1] - 200]), approximate: true },
    ],
  };
  const plain = discoverSubjects(landscape({ small: true }), null, { ...DEFAULTS, discovery: { ...DEFAULTS.discovery, maxSubjects: 30 } });
  const smallButte = plain.find((s) => s.kind === 'butte' && dist2(s.posM, ...SMALL) < 300), bigButte = plain.find((s) => s.kind === 'butte' && dist2(s.posM, ...BUTTE) < 400);
  assert.ok(smallButte && bigButte && bigButte.grandeur > smallButte.grandeur, 'two tables, the big one grander');
  const subjects = discoverSubjects(ctx, region, DEFAULTS);
  const big = subjects.find((s) => s.id === 'big-peak');
  assert.ok(big && big.kind === 'peak' && big.name === 'Big Peak' && big.source === 'config' && big.weight === 1.3);
  assert.ok(dist2(big.posM, ...PEAK) < 30, 'snapped to the summit within 200 m');
  assert.ok(!subjects.some((s) => s.source === 'dem' && s.kind === 'peak' && dist2(s.posM, ...PEAK) < 1800), 'no duplicate DEM peak');
  const tableB = subjects.find((s) => s.id === 'table-butte');
  assert.ok(tableB && tableB.kind === 'butte' && tableB.name === 'Table Butte' && tableB.featureId === smallButte.id, `snapped to ${tableB?.featureId}`);
  assert.deepEqual(tableB.posM, smallButte.posM);
  const lake = subjects.find((s) => s.id === 'round-lake');
  assert.ok(lake && lake.kind === 'lake' && lake.featureId && lake.polygonM.length >= 8);
  assert.equal(subjects.filter((s) => s.kind === 'lake').length, 1);
  assert.deepEqual(subjects.slice(0, 4).map((s) => s.source), ['rail', 'config', 'config', 'config']);
  // Shorelines name the lake subject; closed, ~100 m apart, on the water.
  const [shore, ...others] = shorelines(ctx, subjects);
  assert.equal(others.length, 0);
  assert.equal(shore.lakeId, 'round-lake');
  assert.deepEqual(shorelines(ctx), [shore], 'defaults to the last discovery');
  const pts = shore.points;
  assert.ok(Math.abs(pts.length - (2 * Math.PI * 900) / 100) < 8);
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k], q = pts[(k + 1) % pts.length];
    assert.ok(Math.abs(Math.hypot(p[0] - LAKE[0], p[2] - LAKE[1]) - 900) < 60 && p[1] === 985);
    assert.ok(Math.hypot(q[0] - p[0], q[2] - p[2]) < 140, 'closed and evenly spaced');
  }
  assert.throws(() => shorelines(landscape()), /needs the view's subjects/);
  assert.throws(() => discoverSubjects(ctx, { subjects: [{ name: 'Nowhere', kind: 'peak' }] }, DEFAULTS), /matches no authored landmark/);
});

test('config kinds: lakes and valleys take DEM geometry or fall back to landmarks; edge subjects are excluded with a note', () => {
  const g = landscape().grid;
  const ctx = landscape({ landmarks: [
    { name: 'Round Lake', lonLat: null, localM: [LAKE[0] + 100, 985, LAKE[1]] },
    { name: 'Edge Mark', lonLat: null, localM: [-6900, 1000, 0] },
  ] });
  const notes = [];
  const region = {
    subjects: [
      { name: 'Round Lake', kind: 'lake', weight: 1.1 },
      { name: 'Dry Wash', kind: 'valley', lonLat: localToLonLat(g, [5000, 5000]), snapRadiusM: 100, weight: 0.9 },
      { name: 'Edge Peak', kind: 'peak', lonLat: localToLonLat(g, [6800, 0]) },
    ],
  };
  const subjects = discoverSubjects(ctx, region, DEFAULTS, { log: (m) => notes.push(m) });
  const lake = subjects.find((s) => s.id === 'round-lake');
  assert.ok(lake && lake.kind === 'lake' && lake.featureId && lake.polygonM.length >= 8 && lake.axisM && lake.weight === 1.1, 'landmark retyped to a lake takes the water');
  const wash = subjects.find((s) => s.id === 'dry-wash');
  assert.ok(wash && wash.kind === 'landmark' && wash.source === 'config' && wash.weight === 0.9, 'no valley there: kept as a landmark');
  assert.ok(!subjects.some((s) => s.name === 'Edge Peak' || s.name === 'Edge Mark'));
  assert.equal(notes.length, 3, notes.join('\n'));
  assert.ok(notes.some((n) => /Dry Wash.*landmark/.test(n)) && notes.some((n) => /Edge Peak.*edge: excluded/.test(n)) && notes.some((n) => /Edge Mark.*edge: excluded/.test(n)));
});

test('subjects over no-data stay finite (rail target and landmark in a hole)', () => {
  const ctx = landscape({ hole: true, landmarks: [{ name: 'Lost Point', lonLat: null, localM: [100, 1050, -100] }] });
  assert.ok(Number.isNaN(heightAt(ctx.grid, 0, 0)));
  const subjects = discoverSubjects(ctx, null, DEFAULTS, quiet);
  const rail = subjects.find((s) => s.kind === 'rail-target'), lost = subjects.find((s) => s.id === 'lost-point');
  assert.deepEqual(rail.posM, [0, 1100, 0]);
  assert.deepEqual(lost.posM, [100, 1050, -100]);
  for (const s of subjects) for (const k of ['radiusM', 'heightM', 'prominenceM', 'grandeur']) assert.ok(Number.isFinite(s[k]) && s.posM.every(Number.isFinite), `${s.id}.${k} = ${s[k]}`);
});

test('valley paths follow a V-shaped valley floor from mouth to head', () => {
  // Floor along x = 0, rising southward (+z); 10 km square.
  const g = grid(501, 20, (x, z) => 1000 + 0.03 * z + 0.25 * Math.abs(x));
  const ctx = { viewId: 'valley', grid: g, water: null };
  const paths = valleyPaths(ctx);
  assert.ok(paths.length >= 1);
  const main = paths[0];
  assert.ok(main.areaM2 > 50e6 && /^valley-/.test(main.id));
  const pts = main.points;
  assert.ok(pts[0][2] < pts.at(-1)[2], 'mouth (north, low) first');
  assert.ok((pts.length - 1) * 100 >= 7000, `length ${(pts.length - 1) * 100}`);
  for (let k = 0; k < pts.length; k++) {
    assert.ok(Math.abs(pts[k][0]) < 80, `on the floor: ${pts[k]}`);
    assert.ok(Math.abs(pts[k][1] - heightAt(g, pts[k][0], pts[k][2])) < 0.1);
    if (k) assert.ok(Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][2] - pts[k - 1][2]) <= 100.5);
  }
  assert.deepEqual(valleyPaths(ctx, { minLengthM: 20000 }), []);
  const subjects = discoverSubjects(ctx, null, DEFAULTS);
  const valley = subjects.find((s) => s.kind === 'valley');
  assert.ok(valley && valley.axisM.length === 2 && valley.heightM >= 150 && Math.abs(valley.posM[0]) < 80);
});

async function realContext(t, viewId) {
  try { return await loadViewContext(viewId); } catch (e) {
    if (/DEM grid cache file .* is missing/.test(e.message)) { t.skip(`no cached ${viewId} grid`); return null; }
    throw e;
  }
}
const tours = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'terrain', 'scenic-tours.json'), 'utf8'));
const describe = (subjects) => subjects.map((s) => `${s.id} ${s.kind} [${s.posM.map(Math.round)}] prom ${s.prominenceM} g ${s.grandeur}`).join('\n');
/** The builder's focus area (build-scenic-tours focusArea) over a subject list. */
function focusOf(subjects, region, defaults) {
  const anchors = [subjects.find((s) => s.kind === 'rail-target'), ...subjects.filter((s) => (region.hero || []).includes(s.name))].filter(Boolean);
  const centre = [0, 2].map((k) => anchors.reduce((a, s) => a + s.posM[k], 0) / anchors.length);
  return { centre, radiusM: region.focusRadiusM ?? LANDFORMS[region.landform]?.focusM ?? defaults.discovery.focusRadiusM };
}

test('real data: monument-valley-163 finds the buttes around the Mittens and Merrick Butte', async (t) => {
  const ctx = await realContext(t, 'monument-valley-163');
  if (!ctx) return;
  const { defaults, regions } = tours(), region = regions['monument-valley-163'];
  const subjects = discoverSubjects(ctx, region, defaults);
  t.diagnostic(describe(subjects));
  const rail = subjects.find((s) => s.kind === 'rail-target');
  const mid = [0, 2].map((k) => (ctx.camera.targetStartM[k] + ctx.camera.targetEndM[k]) / 2);
  assert.ok(rail && Math.hypot(rail.posM[0] - mid[0], rail.posM[2] - mid[1]) < 1);
  assert.ok(subjects.length <= defaults.discovery.maxSubjects);
  // The hero snaps to the butte nearest its approximate point (a Mitten).
  const config = region.subjects.find((c) => c.name === 'The Mittens and Merrick Butte'), point = lonLatToLocal(ctx.grid, config.lonLat);
  const hero = subjects.find((s) => s.id === 'the-mittens-and-merrick-butte');
  assert.ok(hero && hero.kind === 'butte' && hero.featureId && dist2(hero.posM, ...point) < 1500, `hero at [${hero?.posM}]`);
  const buttesNear = (list, [x, z], r) => list.filter((s) => s.kind === 'butte' && dist2(s.posM, x, z) < r);
  assert.ok(buttesNear(subjects, [hero.posM[0], hero.posM[2]], 3000).length >= 3, describe(buttesNear(subjects, [hero.posM[0], hero.posM[2]], 3000)));
  // Everything the DEM adds lies in the builder's focus area.
  const focus = focusOf(subjects, region, defaults);
  for (const s of subjects.filter((x) => x.source === 'dem')) assert.ok(dist2(s.posM, ...focus.centre) <= focus.radiusM, `${s.id} in focus`);
  // Without the library's spacing, both Mittens stand out on their own.
  const dense = discoverSubjects(ctx, { ...region, overrides: { discovery: { maxSubjects: 60, minSubjectSpacingM: 600 } } }, defaults);
  assert.ok(buttesNear(dense, [-6000, 6500], 2000).length >= 2, describe(buttesNear(dense, [-6000, 6500], 2000)));
  assert.ok(buttesNear(dense, [-6000, 6500], 3500).length >= 4, describe(buttesNear(dense, [-6000, 6500], 3500)));
});

test('real data: teton-jackson-lake summits are peaks, not buttes; Jackson Lake is snapped to its water', async (t) => {
  const ctx = await realContext(t, 'teton-jackson-lake');
  if (!ctx) return;
  const { defaults, regions } = tours(), region = regions['teton-jackson-lake'];
  const subjects = discoverSubjects(ctx, region, defaults);
  t.diagnostic(describe(subjects));
  for (const name of ['grand-teton', 'mount-moran']) assert.equal(subjects.find((s) => s.id === name)?.kind, 'peak');
  const lake = subjects.find((s) => s.id === 'jackson-lake');
  assert.ok(lake?.kind === 'lake' && lake.featureId && lake.radiusM > 5000);
  // Only the lake subject's shore, under its subject id.
  const shores = shorelines(ctx);
  assert.deepEqual(shores.map((s) => s.lakeId), ['jackson-lake']);
  assert.ok(shores[0].points.length > 100);
  const focus = focusOf(subjects, region, defaults);
  for (const s of subjects.filter((x) => x.source === 'dem')) assert.ok(dist2(s.posM, ...focus.centre) <= focus.radiusM, `${s.id} in focus`);
  const dense = discoverSubjects(ctx, { ...region, overrides: { discovery: { maxSubjects: 80, minSubjectSpacingM: 600 } } }, defaults);
  assert.equal(dense.filter((s) => s.kind === 'butte').length, 0);
});
