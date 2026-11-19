import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INLAND_MAX_DRY_FLOW, INLAND_RIVER_FLOW } from '../src/world/alpine/TerrainPackage.js';
import { makeInlandTerrain } from '../src/world/terrain/InlandTerrain.js';
import { makeInlandWatershed } from '../src/world/terrain/InlandWatershed.js';

const outline = [.95, .15, .08, .26, .6, .75, .4, .34, .51, .72, .62, .18, .58, .31, .7, .39];
const print = { version: 1, skyline: outline };
const bounds = { min: [-44800, 0, -44800], max: [44800, 4000, 44800] };
const baseM = 1800;
const field = makeInlandTerrain(37, print);

test('inland tributaries join a descending main river at exact confluence coordinates and grades', () => {
  const { rivers, anchors, sample, tileHasRiver, minHeightM } = makeInlandWatershed(field, baseM, bounds);
  const [trunk, ...feeders] = rivers;
  assert.ok(feeders.length >= 10);
  assert.equal(trunk.points.at(-1).heightM, minHeightM);
  for (const feeder of feeders) {
    assert.equal(feeder.joins, trunk.id);
    const mouth = feeder.points.at(-1);
    assert.ok(trunk.points.some(p => p.x === mouth.x && p.z === mouth.z && p.heightM === mouth.heightM));
  }
  for (const river of rivers) {
    for (let i = 1; i < river.points.length; i++) {
      const a = river.points[i - 1], b = river.points[i];
      assert.ok(a.heightM > b.heightM);
      const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2;
      const wet = sample(x, z, 4000);
      assert.equal(wet.flowByte, INLAND_RIVER_FLOW);
      assert.ok(wet.heightM <= (a.heightM + b.heightM) / 2 + 1e-9 && wet.heightM >= minHeightM);
      assert.ok(tileHasRiver(x - 40, z - 40, x + 40, z + 40));
    }
  }
  assert.ok(anchors.some(a => a.kind === 'gorge' && a.id.startsWith('gorge-tributary-')));
  assert.ok(anchors.some(a => a.kind === 'confluence'));
});

test('river banks meet their wet grade over preexisting depressions and cut terraces into high ground', () => {
  const watershed = makeInlandWatershed(field, baseM, bounds);
  const [a, b] = watershed.rivers[0].points.slice(2, 4);
  const lengthM = Math.hypot(a.x - b.x, a.z - b.z);
  const at = (distanceM, heightM) => watershed.sample(
    (a.x + b.x) / 2 + distanceM * (a.z - b.z) / lengthM,
    (a.z + b.z) / 2 + distanceM * (b.x - a.x) / lengthM, heightM);
  const lowM = baseM + 100;
  const center = at(0, lowM);
  const bank = at(center.halfWidthM + 30, lowM);
  assert.equal(center.flowByte, INLAND_RIVER_FLOW);
  assert.ok(bank.flowByte > 150 && bank.flowByte <= INLAND_MAX_DRY_FLOW);
  assert.ok(bank.heightM >= center.heightM - .5);
  assert.ok(bank.heightM - center.heightM < 40);
  assert.equal(at(4000, lowM).heightM, lowM);
  const plateauM = baseM + 2200;
  const innerBank = at(center.halfWidthM + 320, plateauM);
  const terrace = at(700, plateauM), wall = at(1800, plateauM), plateau = at(4000, plateauM);
  assert.ok(innerBank.heightM - center.heightM < 160);
  assert.ok(terrace.heightM > center.heightM && wall.heightM - terrace.heightM > 150);
  assert.ok(plateau.heightM - wall.heightM > 100);
  assert.equal(plateau.flowByte, 0);
});

test('watershed topology and coordinate samples are deterministic for an inland field', () => {
  const first = makeInlandWatershed(field, baseM, bounds);
  const second = makeInlandWatershed(JSON.parse(JSON.stringify(field)), baseM, bounds);
  const other = makeInlandWatershed(makeInlandTerrain(38, print), baseM, bounds);
  assert.deepEqual(first.rivers, second.rivers);
  assert.notDeepEqual(first.rivers[0].points, other.rivers[0].points);
  for (const { x, z } of first.anchors) assert.deepEqual(first.sample(x, z, 2300), second.sample(x, z, 2300));
});
