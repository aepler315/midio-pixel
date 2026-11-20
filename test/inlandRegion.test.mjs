import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeInlandTerrain } from '../src/world/terrain/InlandTerrain.js';
import { makeInlandRegion, regionAnchors, regionDesign, regionElevationSpan } from '../src/world/terrain/InlandRegion.js';
import { INLAND_MAX_DRY_FLOW, INLAND_RIVER_FLOW } from '../src/world/alpine/TerrainPackage.js';

const printFor = values => ({ version: 1, skyline: values, passages: [] });
const SKYLINE = [.95, .15, .08, .26, .6, .75, .4, .34, .51, .72, .62, .18, .58, .31, .7, .39];
const field = makeInlandTerrain(112, printFor(SKYLINE));
const BASE_M = 2050;
const massifs = [{ x: -9000, z: -12000, radiusM: 5000, weight: 1 }, { x: 8000, z: -14000, radiusM: 4200, weight: .7 }];
const region = makeInlandRegion(field, BASE_M, { massifs });

test('one recording always rebuilds the same region, and another recording builds a different one', () => {
  const again = makeInlandRegion(JSON.parse(JSON.stringify(field)), BASE_M, { massifs });
  const points = [[0, 0], [12345.6, -7890.1], [-30000, 25000]];
  assert.deepEqual(points.map(([x, z]) => again.sample(x, z, {})), points.map(([x, z]) => region.sample(x, z, {})));
  assert.deepEqual(regionAnchors(again), regionAnchors(region));
  const other = makeInlandRegion(makeInlandTerrain(77, printFor(SKYLINE.toReversed())), BASE_M, { massifs });
  let differ = 0;
  for (let z = -30000; z <= 30000; z += 6000) for (let x = -30000; x <= 30000; x += 6000)
    if (Math.abs(other.heightAt(x, z) - region.heightAt(x, z)) > 150) differ++;
  assert.ok(differ > 60, `${differ} of 121 samples change substantially`);
});

test('rivers run downhill along the low ground and join into one network', () => {
  const roots = region.rivers.filter(r => r.joins === null);
  assert.equal(roots.length, 1, 'one outlet drains the stage');
  assert.ok(roots[0].trunk, 'the outlet river is the trunk');
  const byId = new Map(region.rivers.map(r => [r.id, r]));
  for (const river of region.rivers) {
    for (let i = 1; i < river.points.length; i++) assert.ok(river.points[i].bed <= river.points[i - 1].bed + 1e-9, `river ${river.id} never climbs`);
    if (river.joins === null) continue;
    // Each tributary ends on its parent's course.
    const end = river.points.at(-1), parent = byId.get(river.joins);
    const gap = Math.min(...parent.points.map(p => Math.hypot(p.x - end.x, p.z - end.z)));
    assert.ok(gap < 120, `river ${river.id} meets river ${river.joins} (${gap.toFixed(1)} m)`);
    for (let k = river.joins, guard = 0; k !== null; k = byId.get(k).joins) assert.ok(++guard < 100);
  }
  // Water sits in the valley: the land rises on both sides of every flown river.
  let checked = 0, rising = 0;
  for (const river of region.rivers.filter(r => r.flown)) {
    for (let i = 4; i < river.points.length - 4; i += 9) {
      const p = river.points[i], a = river.points[i - 2], b = river.points[i + 2];
      let nx = -(b.z - a.z), nz = b.x - a.x;
      const len = Math.hypot(nx, nz); nx /= len; nz /= len;
      if (Math.max(Math.abs(p.x), Math.abs(p.z)) > 30000) continue;
      const here = region.sample(p.x, p.z, {});
      assert.equal(here.flowByte, INLAND_RIVER_FLOW);
      // Skip a side that reaches another channel or a bend further downstream.
      const sides = [-1, 1].map(side => region.sample(p.x + side * nx * 1500, p.z + side * nz * 1500, {}))
        .filter(q => !(q.distanceM < 500)).map(q => q.heightM - here.heightM);
      if (!sides.length) continue;
      assert.ok(Math.min(...sides) > -25, `no ground sits well below river ${river.id} (${sides.map(Math.round)})`);
      if (Math.max(...sides) > 30) rising++;
      checked++;
    }
  }
  assert.ok(checked > 20);
  assert.ok(rising >= .75 * checked, `valley walls rise beside ${rising} of ${checked} river samples`);
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
