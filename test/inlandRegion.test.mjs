import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeInlandTerrain } from '../src/world/terrain/InlandTerrain.js';
import { cutOffChannelFolds, migrateChannel } from '../src/world/terrain/ChannelMigration.js';
import { riverWetHalfWidthM } from '../src/world/terrain/Riverbed.js';
import { makeInlandRegion, regionAnchors, regionDesign, regionElevationSpan, roundChannelBends, traceRivers } from '../src/world/terrain/InlandRegion.js';
import { INLAND_MAX_DRY_FLOW, INLAND_RIVER_FLOW } from '../src/world/alpine/TerrainPackage.js';
import { finishPreparation } from '../src/world/alpine/PreparationSteps.js';
import { bakeRiverBankAtlasSteps, riverBankDistanceAt } from '../src/world/terrain/RiverBankAtlas.js';

const printFor = values => ({ version: 1, skyline: values, passages: [] });
const SKYLINE = [.95, .15, .08, .26, .6, .75, .4, .34, .51, .72, .62, .18, .58, .31, .7, .39];
const field = makeInlandTerrain(printFor(SKYLINE));
const BASE_M = 2050;

test('a migrated course crossing itself inside one channel takes a single downstream path', () => {
  const routed = Array.from({ length: 9 }, (_, i) => ({ x: 7 * i, z: 0 }));
  const stations = [[0, 0], [8, 0], [16, -1], [27, 3], [20, -2], [22, 3], [31, -2], [42, -1], [56, 0]];
  const points = stations.map(([x, z], i) => ({ x, z, bed: 300 - i, channelM: 35 }));
  cutOffChannelFolds(routed, points);
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].x > points[i - 1].x);
    assert.equal(points[i].bed, 300 - i);
    assert.ok(Math.hypot(points[i].x - stations[i][0], points[i].z - stations[i][1]) < points[i].channelM);
  }
  assert.deepEqual([points[0].x, points[0].z], stations[0]);
  assert.deepEqual([points.at(-1).x, points.at(-1).z], stations.at(-1));
});

test('migration follows existing bends and the available floodplain while keeping the endpoints fixed', () => {
  const start = Array.from({ length: 70 }, (_, i) => ({ x: i * 44, z: 0, area: 320, bed: 240 - i * .05,
    channelM: 60, floorM: 390, gorge: 0, broad: 1 }));
  const straight = migrateChannel(start, 110, () => 0, 1900, 1);
  assert.deepEqual(straight, start, 'a uniform straight valley does not acquire a repeating wave');
  const bend = start.map((p, i) => ({ ...p, z: 250 * Math.exp(-((i - 30) ** 2) / 69) }));
  const open = migrateChannel(bend, 110, () => 0, 1900, 1);
  const gorge = bend.map(p => ({ ...p, gorge: .98, broad: 0, floorM: 64 }));
  const rock = migrateChannel(gorge, 110, () => 0, 1900, 1);
  const displacements = out => out.map((p, i) => Math.hypot(bend[i].x - p.x, bend[i].z - p.z));
  assert.ok(Math.max(...displacements(open)) > 20);
  assert.ok(Math.max(...displacements(rock)) <= 4.001);
  assert.deepEqual(open[0], bend[0]); assert.deepEqual(open.at(-1), bend.at(-1));
  assert.deepEqual(open.map(p => p.bed), bend.map(p => p.bed));
  assert.deepEqual(open, migrateChannel(bend, 110, () => 0, 1900, 1));
});

test('a wide river rounds a tight turn inside its original wet footprint', () => {
  // Local metre coordinates of the TAIGA trunk at the pointed inside bank.
  const stations = [[0, 0], [-61, -6], [-118, -22], [-170, -50], [-214, -88], [-247, -124],
    [-269, -151], [-287, -163], [-298, -162], [-305, -164], [-307, -171], [-308, -184],
    [-309, -205], [-318, -242], [-336, -291], [-353, -347], [-368, -413], [-371, -481], [-360, -545]];
  const points = stations.map(([x, z], i) => ({ x, z, bed: 400 - i, channelM: 92 }));
  const minRadius = () => Math.min(...points.slice(1, -1).map((p, i) => {
    const a = points[i], b = points[i + 2];
    const ux = p.x - a.x, uz = p.z - a.z, vx = b.x - p.x, vz = b.z - p.z;
    return Math.hypot(ux, uz) * Math.hypot(vx, vz) * Math.hypot(b.x - a.x, b.z - a.z) / (2 * Math.abs(ux * vz - uz * vx));
  }));
  assert.ok(minRadius() < 10);
  roundChannelBends(points);
  assert.ok(minRadius() > 92, 'every inside bank retains a positive bend radius');
  for (const [i, p] of points.entries()) {
    assert.equal(p.bed, 400 - i);
    assert.equal(p.channelM, 92);
    const shift = Math.hypot(p.x - stations[i][0], p.z - stations[i][1]);
    assert.ok(shift < p.channelM);
    if (i < 4 || i > 13) assert.equal(shift, 0, 'the approaching and departing reaches keep their course');
  }
});
const massifs = [{ x: -9000, z: -12000, radiusM: 5000, weight: 1 }, { x: 8000, z: -14000, radiusM: 4200, weight: .7 }];
const region = makeInlandRegion(field, BASE_M, { massifs });

test('ordinary soil-covered divides have subdued local relief and curved hillslopes', () => {
  const spans = [], curvature = [];
  const { coarse, halfM } = region;
  for (let z = -19000; z <= 19000; z += 1000) for (let x = -19000; x <= 19000; x += 1000) {
    const i = Math.round((z + halfM) / coarse.dx) * coarse.n + Math.round((x + halfM) / coarse.dx);
    if (coarse.U[i] >= .6 || massifs.some(m => Math.hypot(x - m.x, z - m.z) < m.radiusM + 1600)) continue;
    const here = region.sample(x, z);
    if (here.distanceM < 350) continue;
    const sides = d => [region.heightAt(x + d, z), region.heightAt(x - d, z),
      region.heightAt(x, z + d), region.heightAt(x, z - d)];
    const ring = sides(1000);
    spans.push(Math.max(here.heightM, ...ring) - Math.min(here.heightM, ...ring));
    curvature.push(Math.abs(sides(250).reduce((sum, h) => sum + h, 0) / 4 - here.heightM));
  }
  const percentile = (v, f) => v.sort((a, b) => a - b)[Math.floor(f * v.length)];
  assert.ok(spans.length > 150, 'measure across the interior watershed');
  assert.ok(percentile(spans, .5) > 35 && percentile(spans, .95) < 320);
  assert.ok(percentile(curvature, .5) > .5 && percentile(curvature, .95) < 24);
  assert.ok(region.rivers.some(r => r.points.some(p => p.colluviumM > 0)), 'hillslopes deliver sediment to the rivers');
});

// Heights on a grid laid along and across the region's own trunk, so a
// region that turned a little compares as the same land.
function ownFrameHeights(f, r) {
  const out = [];
  for (let c = -30000; c <= 30000; c += 3000) for (let a = -30000; a <= 30000; a += 3000)
    out.push(r.heightAt(a * f.east - c * f.north, a * f.north + c * f.east));
  return out;
}
function correlation(a, b) {
  const ma = a.reduce((s, v) => s + v) / a.length, mb = b.reduce((s, v) => s + v) / b.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
  return ab / Math.sqrt(aa * bb);
}

test('one recording always rebuilds the same region, and another song builds a different one', () => {
  const again = makeInlandRegion(JSON.parse(JSON.stringify(field)), BASE_M, { massifs });
  const points = [[0, 0], [12345.6, -7890.1], [-30000, 25000]];
  assert.deepEqual(points.map(([x, z]) => again.sample(x, z, {})), points.map(([x, z]) => region.sample(x, z, {})));
  assert.deepEqual(regionAnchors(again), regionAnchors(region));
  const otherField = makeInlandTerrain(printFor(SKYLINE.toReversed()));
  const other = makeInlandRegion(otherField, BASE_M, { massifs });
  let differ = 0;
  for (let z = -30000; z <= 30000; z += 6000) for (let x = -30000; x <= 30000; x += 6000)
    if (Math.abs(other.heightAt(x, z) - region.heightAt(x, z)) > 150) differ++;
  assert.ok(differ > 60, `${differ} of 121 samples change substantially`);
});

test('a slightly different outline, as from a live take, builds nearly the same land', () => {
  // The region has no seed drawn from the outline, so a small change in the
  // outline is a small change in the land. Drainage still amplifies it a
  // little, so close rather than identical.
  const nearField = makeInlandTerrain(printFor(SKYLINE.map((v, i) => Math.min(1, Math.max(0, v + .03 * Math.sin(2.3 * i + 1))))));
  const near = makeInlandRegion(nearField, BASE_M, { massifs });
  const here = ownFrameHeights(field, region);
  const r = correlation(here, ownFrameHeights(nearField, near));
  assert.ok(r > .6, `a nearby outline correlates ${r.toFixed(3)} in its own frame`);
  // Another song's measured outline builds clearly different land, even
  // compared in each region's own frame.
  const otherField = makeInlandTerrain(printFor([1, .57, .3, .25, .19, .25, .57, .69, .21, .07, .58, .33, .86, .95, .07, .42]));
  const other = correlation(here, ownFrameHeights(otherField, makeInlandRegion(otherField, BASE_M, { massifs })));
  assert.ok(other < r - .1, `another song correlates ${other.toFixed(3)}, a nearby outline ${r.toFixed(3)}`);
  const d = regionDesign(field), dn = regionDesign(nearField);
  for (const key of ['amplitude', 'gorgeAt', 'basinAt', 'erodibility', 'concavity', 'riverAreaKm2', 'reliefM'])
    assert.ok(Math.abs(d[key] - dn[key]) <= .12 * Math.abs(d[key]) + 1e-9, `${key} ${d[key]} vs ${dn[key]}`);
});

test('rivers run downhill along the low ground and join into one network', () => {
  const roots = region.rivers.filter(r => r.joins === null);
  assert.equal(roots.length, 1, 'one outlet drains the stage');
  assert.ok(roots[0].trunk, 'the outlet river is the trunk');
  const byId = new Map(region.rivers.map(r => [r.id, r]));
  for (const river of region.rivers) {
    for (let i = 1; i < river.points.length; i++) assert.ok(river.points[i].bed <= river.points[i - 1].bed + 1e-9, `river ${river.id} never climbs`);
    // Check the surface the renderer receives, not just the routing metadata.
    for (let i = 1; i < river.points.length; i += 15) {
      const a = river.points[i - 1], b = river.points[i];
      const mid = region.sample((a.x + b.x) / 2, (a.z + b.z) / 2);
      assert.ok(mid.wet || mid.island || mid.barHeightM > 0);
      assert.ok(Math.abs(mid.waterM - (a.bed + b.bed) / 2) < 1e-6);
      assert.equal(mid.bedM, mid.heightM);
      assert.equal(mid.renderHeightM, mid.wet ? mid.waterM : mid.heightM);
      if (mid.wet) assert.ok(mid.depthM > 0 && mid.heightM < mid.waterM);
    }
    if (river.joins === null) continue;
    // Each tributary ends on its parent's course.
    const end = river.points.at(-1), parent = byId.get(river.joins);
    const junction = parent.points.find(p => Math.hypot(p.x - end.x, p.z - end.z) < 1e-6);
    assert.ok(junction, `river ${river.id} meets river ${river.joins}`);
    assert.ok(Math.abs(junction.bed - end.bed) < 1e-6, 'water levels meet');
    assert.ok(Math.abs(junction.hydro.depthM - end.hydro.depthM) < 1e-6, 'submerged beds meet');
    for (let k = river.joins, guard = 0; k !== null; k = byId.get(k).joins) assert.ok(++guard < 100);
  }
  // Water sits in the valley: the land rises on both sides of the flown
  // rivers. Erosion leaves an occasional sample with lower ground beside a
  // river (a neighbouring basin, a meander across a spur): 1.1% of samples
  // over 21 real outlines, 2.4% at worst, so allow a few, never a river
  // running along a ridge (that would put half the samples below).
  let checked = 0, rising = 0, below = 0;
  for (const river of region.rivers.filter(r => r.flown)) {
    for (let i = 4; i < river.points.length - 4; i += 9) {
      const p = river.points[i], a = river.points[i - 2], b = river.points[i + 2];
      let nx = -(b.z - a.z), nz = b.x - a.x;
      const len = Math.hypot(nx, nz); nx /= len; nz /= len;
      if (Math.max(Math.abs(p.x), Math.abs(p.z)) > 30000) continue;
      const here = region.sample(p.x, p.z, {});
      if (!here.island && !here.barHeightM) assert.equal(here.flowByte, INLAND_RIVER_FLOW);
      // Skip a side that reaches another channel or a bend further downstream.
      const sides = [-1, 1].map(side => region.sample(p.x + side * nx * 1500, p.z + side * nz * 1500, {}))
        .filter(q => !(q.distanceM < 500)).map(q => q.heightM - here.heightM);
      if (!sides.length) continue;
      if (Math.min(...sides) <= -25) below++;
      if (Math.max(...sides) > 30) rising++;
      checked++;
    }
  }
  assert.ok(checked > 20);
  assert.ok(below <= .05 * checked, `ground sits well below the river beside ${below} of ${checked} river samples`);
  assert.ok(rising >= .75 * checked, `valley walls rise beside ${rising} of ${checked} river samples`);
});

test('visible waterfalls descend and sediment islands stand between two wet channels', () => {
  const anchors = regionAnchors(region);
  assert.ok(anchors.falls.length > 0 && anchors.islands.length > 0);
  for (const fall of anchors.falls) {
    const lip = region.sample(fall.x, fall.z), foot = region.sample(fall.footX, fall.footZ);
    assert.ok(fall.lipM > fall.footM && fall.dropM > 0);
    assert.ok(Math.abs(lip.waterM - fall.lipM) < 1 && Math.abs(foot.waterM - fall.footM) < 1);
  }
  let complete = 0;
  for (const island of anchors.islands) {
    const crest = region.sample(island.x, island.z);
    assert.ok(crest.island && !crest.wet && crest.heightM > crest.waterM && crest.depthM === 0);
    const offset = island.halfWidthM * 1.65;
    const sides = [-1, 1].map(side => region.sample(island.x - side * offset * island.tz, island.z + side * offset * island.tx));
    if (sides.every(q => q.wet && q.depthM > 0 && q.bedM < q.renderHeightM)) complete++;
  }
  assert.ok(complete > 0, 'at least one deposited island is surrounded by physically flowing water');
});

test('the region has connected ridges, passes, broad reaches and a gorge that read differently', () => {
  const anchors = regionAnchors(region);
  assert.ok(anchors.passes.length >= 3 && anchors.broadReaches.length >= 1 && anchors.gorges.length >= 1);
  for (const pass of anchors.passes) assert.ok(pass.reliefM >= 180, 'a pass stands above the valleys it links');
  // Cross sections: an open floor rises gently, a gorge rises at once.
  const rise = (run) => {
    const river = region.rivers.find(r => r.id === run.river);
    const mid = river.points.reduce((best, p) => Math.hypot(p.x - run.x, p.z - run.z) < Math.hypot(best.x - run.x, best.z - run.z) ? p : best);
    const i = river.points.indexOf(mid), a = river.points[Math.max(0, i - 2)], b = river.points[Math.min(river.points.length - 1, i + 2)];
    let nx = -(b.z - a.z), nz = b.x - a.x;
    const len = Math.hypot(nx, nz); nx /= len; nz /= len;
    const bed = region.sample(mid.x, mid.z, {}).bedM;
    return Math.min(...[-1, 1].map(side => region.heightAt(mid.x + side * nx * 260, mid.z + side * nz * 260) - bed));
  };
  const broad = Math.max(...anchors.broadReaches.map(rise)), gorge = Math.max(...anchors.gorges.map(rise));
  assert.ok(gorge > 3 * Math.max(10, broad), `gorge walls ${gorge.toFixed(0)} m vs open floor ${broad.toFixed(0)} m at 260 m`);
  // Dry ground keeps the dry flow range; relief matches the design.
  const { floorM, topM } = regionElevationSpan(field, BASE_M);
  assert.ok(Math.abs(regionDesign(field).reliefM - (topM - floorM)) < 1e-6);
  let max = -Infinity;
  for (let z = -26000; z <= 26000; z += 1300) for (let x = -26000; x <= 26000; x += 1300) {
    const s = region.sample(x, z, {});
    assert.ok(s.flowByte === INLAND_RIVER_FLOW || s.flowByte <= INLAND_MAX_DRY_FLOW);
    assert.ok(s.heightM >= region.boundsM[0] && s.heightM <= region.boundsM[1]);
    max = Math.max(max, s.heightM);
  }
  assert.ok(max - floorM > .7 * (topM - floorM), 'the travelled core reaches most of the relief');
});

test('a measured timeline turns the peak region by key and supplies a flight over a connected watershed', () => {
  const series = Array.from({ length: 24 }, (_, i) => (i % 8) / 7);
  const timeline = { version: 1, stepMs: 2000, key: { tonic: 0, major: true, confidence: .9 },
    dynamics: .7, loudness: series, brightness: series, tension: series, novelty: series, major: series };
  const song = { ...printFor(SKYLINE), timeline };
  const peaks = makeInlandTerrain(song);
  const rotated = makeInlandTerrain({ ...song, timeline: { ...timeline, key: { ...timeline.key, tonic: 3 } } });
  assert.ok(Math.abs(peaks.east * rotated.east + peaks.north * rotated.north) < 1e-9);
  const landscape = makeInlandRegion(peaks, BASE_M, { massifs });
  const { spine } = regionAnchors(landscape);
  assert.equal(spine.durationMs, series.length * timeline.stepMs);
  assert.ok(spine.course.length > 1);
  for (const [x, z] of spine.course) {
    const sample = landscape.sample(x, z, {});
    assert.ok(Number.isFinite(sample.heightM));
    assert.ok(Number.isFinite(sample.bedM));
  }
  assert.equal(landscape.rivers.filter(r => r.joins === null).length, 1);
  assert.ok(landscape.rivers.length > 1);
  for (const r of landscape.rivers.filter(r => r.trunk)) {
    const p = r.points[Math.floor(r.points.length / 2)];
    const crossing = landscape.sample(p.x, p.z, {});
    assert.ok(crossing.wet || crossing.island, 'a trunk may split around a deposited island');
    if (crossing.island) assert.ok(crossing.heightM > crossing.waterM);
  }
});

test('a tributary converges when it reaches the larger downhill channel on a shared floor', () => {
  const n = 21, h = new Float64Array(n*n), area = new Int32Array(n*n);
  const rcv = Int32Array.from({ length: n*n }, (_, i) => i);
  const cell = (x,z) => x + z*n;
  for (let z = 0; z < n; z++) {
    const trunk = cell(8,z);
    rcv[trunk] = cell(8,Math.min(n-1,z+1));
    h[trunk] = 1-z*.01; area[trunk] = 60+z;
    if (z < 3 || z >= n-1) continue;
    const x = Math.max(9,16-z), i = cell(x,z);
    rcv[i] = z === n-2 ? cell(8,n-1) : cell(Math.max(9,x-1),z+1);
    h[i] = h[trunk]+.004; area[i] = 5+z;
  }
  const rivers = traceRivers({ n, dx: 1000, halfM: 10000, h, rcv, area }, 1000, 0, 4);
  assert.equal(rivers.length, 2);
  const tributary = rivers.find(r => r.joins !== null);
  assert.ok(tributary.points.at(-1).z < 0, 'joins near first contact instead of paralleling to the outlet');
});

test('the generated terrain carries a narrow tributary at its physical bank width', () => {
  let checked = 0, dryBanks = 0;
  for (const { points } of region.rivers) {
    for (let i = 5; i < points.length - 5; i += 25) {
      const a = points[i - 1], b = points[i], half = (a.channelM + b.channelM) / 2;
      if (half > 28) continue;
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      if (length < 1) continue;
      for (const side of [-1, 1]) {
        const sample = offset => region.sample((a.x + b.x) / 2 - dz / length * offset * side,
          (a.z + b.z) / 2 + dx / length * offset * side);
        const bank = riverWetHalfWidthM(a, b, .5, side);
        const inside = sample(bank - 3);
        assert.ok(inside.wet || inside.island);
        if (!sample(bank + 6).wet) dryBanks++;
        checked++;
      }
    }
  }
  assert.ok(checked > 50 && dryBanks > .95 * checked, `${dryBanks} dry outer banks of ${checked} sampled`);
});

test('drawn banks follow both sides of generated reaches through the full 89.6 km region', () => {
  const grid = { width: 4481, height: 4481, cellSizeM: 20, originM: [-44800, -44800] };
  const atlas = finishPreparation(bakeRiverBankAtlasSteps(region.rivers, grid));
  const errors = [];
  for (const { points } of region.rivers) for (let k = 6; k < points.length - 6; k += 71) {
    const a = points[k - 1], b = points[k], dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2;
    if (length < 1 || Math.max(Math.abs(x), Math.abs(z)) > 44600) continue;
    const centre = region.sample(x, z), distance = riverBankDistanceAt(atlas, x, z);
    if (Math.abs(distance) > atlas.texelSizeM) assert.equal(distance > 0, centre.wet, 'river and island centres agree with rendered coverage');
    for (const side of [-1, 1]) {
      const nx = -side * dz / length, nz = side * dx / length;
      const half = riverWetHalfWidthM(a, b, .5, side);
      const wet = d => region.sample(x + d * nx, z + d * nz).wet;
      const drawn = d => riverBankDistanceAt(atlas, x + d * nx, z + d * nz) > 0;
      // A near-by channel can own the opposite bank at a confluence. Only
      // measure perpendicular error where this reach's bank is exposed.
      if (!wet(half - 4) || wet(half + 4) || !wet(half - 15) || wet(half + 15)) continue;
      const bank = sample => {
        let lo = half - 15, hi = half + 15;
        assert.ok(sample(lo) && !sample(hi));
        for (let i = 0; i < 10; i++) {
          const mid = (lo + hi) / 2;
          if (sample(mid)) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
      };
      errors.push(Math.abs(bank(wet) - bank(drawn)));
    }
  }
  errors.sort((a, b) => a - b);
  assert.ok(errors.length > 500);
  assert.ok(errors.at(-1) < atlas.texelSizeM, `worst physical bank error ${errors.at(-1)} m`);
  assert.ok(errors[Math.floor(.99 * errors.length)] < 2, '99% of bank crossings are within two metres');
});

test('a ridge between adjacent drainage basins preserves the downstream confluence', () => {
  const n = 31, h = new Float64Array(n*n).fill(2), area = new Int32Array(n*n);
  const rcv = Int32Array.from({ length: n*n }, (_, i) => i);
  const cell = (x, z) => x + z*n;
  for (let z = 0; z < n; z++) {
    const trunk = cell(10, z);
    rcv[trunk] = cell(10, Math.min(n-1, z+1));
    h[trunk] = 1 - z*.01; area[trunk] = 300+z;
    if (z < 4 || z === n-1) continue;
    const x = z === n-2 ? 11 : 12, branch = cell(x, z);
    h[branch] = h[trunk] + .003; area[branch] = 150+z;
    rcv[branch] = cell(z >= n-3 ? x-1 : x, z+1);
  }
  const rivers = traceRivers({ n, dx: 200, halfM: 3000, h, rcv, area }, 1000, 0, 4);
  assert.equal(rivers.length, 2);
  const tributary = rivers.find(r => r.joins !== null);
  assert.ok(tributary.points.at(-1).z >= 2600, 'the stream stays in its own basin until the ridge ends');
});
