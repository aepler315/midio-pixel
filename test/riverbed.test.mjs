import assert from 'node:assert/strict';
import { test } from 'node:test';
import { riverHalfWidthM, riverIslandDistance, riverIslandHeightM, riverWetHalfWidthM, sampleRiverbed, simulateRiverbeds } from '../src/world/terrain/Riverbed.js';

const field = { character: { relief: .8, ruggedness: .8, activity: .8 } };
function watershed() {
  let y = 1750;
  const points = Array.from({ length: 420 }, (_, i) => {
    const steep = i < 125;
    y -= 30 * (steep ? .055 : i < 210 ? .004 : .00021);
    return { x: 30 * i, z: steep ? 0 : 160 * Math.sin((i - 125) * .016), bed: y,
      area: 400 + 3 * i + (i >= 155 ? 180 : 0), broad: steep ? 0 : 1, gorge: steep ? .96 : 0,
      relief: steep ? 620 : 35, erodibility: steep ? .55 : 1.05, colluviumM: steep ? .5 : 2 };
  });
  const main = { id: 0, joins: null, areaKm2: points.at(-1).area, points };
  const junction = points[155];
  const tributary = { id: 3, joins: 0, areaKm2: 180, points: Array.from({ length: 63 }, (_, i) => ({
    x: junction.x, z: junction.z + 30 * (i - 62), bed: junction.bed + 1.7 * (62 - i),
    area: 20 + 160 * i / 62, relief: 600, gorge: .85, broad: 0, erodibility: .58 })) };
  return [main, tributary];
}

const near = (a, b, epsilon = 1e-8) => assert.ok(Math.abs(a - b) <= epsilon, `${a} vs ${b}`);

test('discharge and both sediment loads pass through a confluence once and the watershed budget closes', () => {
  const [main, tributary] = watershed(), pins = [main.points[0].bed, main.points[155].bed, main.points.at(-1).bed];
  const totals = simulateRiverbeds([main, tributary], field);
  assert.deepEqual([main.points[0].bed, main.points[155].bed, main.points.at(-1).bed], pins);
  near(tributary.points.at(-1).bed, main.points[155].bed);
  const mouth = tributary.points.at(-1), receiver = main.points[155];
  near(sampleRiverbed(mouth, mouth, 0, 0).bedM, sampleRiverbed(receiver, receiver, 0, 0).bedM);
  near(main.sediment.incomingKgS, tributary.sediment.coarseOutKgS + tributary.sediment.fineOutKgS);
  const qPerKm2 = main.points[0].hydro.dischargeM3s / main.points[0].area;
  near(main.points[155].hydro.dischargeM3s - main.points[154].hydro.dischargeM3s,
    tributary.points.at(-1).hydro.dischargeM3s + 3 * qPerKm2);
  near(totals.outletDischargeM3s, main.areaKm2 * qPerKm2);
  assert.ok(totals.erodedKgS > 0 && totals.depositedKgS > 0 && totals.outletKgS > 0);
  near(totals.suppliedKgS + totals.erodedKgS, totals.depositedKgS + totals.outletKgS);
  for (const river of [main, tributary]) {
    const s = river.sediment;
    near(s.incomingKgS + s.suppliedKgS + s.erodedKgS, s.fineOutKgS + s.coarseOutKgS + s.depositedKgS);
    river.points.forEach((p, i) => {
      assert.ok(p.hydro.dischargeM3s > 0 && p.hydro.depthM > 0 && p.hydro.loadKgS >= 0);
      if (i) assert.ok(p.bed <= river.points[i - 1].bed && p.hydro.dischargeM3s >= river.points[i - 1].hydro.dischargeM3s);
    });
  }
  const [repeat, other] = watershed();
  assert.deepEqual(simulateRiverbeds([other, repeat], field), totals);
  assert.deepEqual(repeat.points, main.points);
});

test('a confined rocky reach makes hydraulic rapids, resolvable bedrock lips and a submerged plunge pool', () => {
  const [main, child] = watershed();
  simulateRiverbeds([main, child], field);
  const p = main.points, steep = p[20], flat = p[300];
  assert.ok(steep.channelM < flat.channelM && steep.hydro.rapid > flat.hydro.rapid + .5);
  assert.ok(steep.hydro.grainMm > 10 * flat.hydro.grainMm && steep.hydro.capacityKgS > 10 * flat.hydro.capacityKgS);
  const rock = sampleRiverbed(steep, steep, 0, steep.channelM + .5);
  const sand = sampleRiverbed(flat, flat, 0, flat.channelM + .5);
  assert.ok(rock.rock > .6 && sand.sand > .5 && rock.grainMm > 20 && sand.grainMm < 3);
  assert.ok(main.falls.length > 0);
  for (const f of main.falls) {
    const i = p.findIndex(q => q.x === f.x && q.z === f.z);
    assert.ok(f.lengthM >= 20 && f.dropM > 2.5 && f.dropM / f.lengthM > .075);
    const lip = sampleRiverbed(p[i], p[i + 1], 0, 0), toe = sampleRiverbed(p[i], p[i + 1], 1, 0);
    near(lip.waterM - toe.waterM, f.dropM);
    assert.ok(toe.depthM > lip.depthM + .5 && toe.bedM < lip.bedM - f.dropM);
    assert.ok(toe.foam > .5 && sampleRiverbed(p[i], p[i + 1], 1, p[i + 1].channelM + 2).foam === 0);
  }
  const flatCourse = { id: 0, joins: null, points: p.map((s, i) => ({ ...s, bed: 600 - .004 * i })) };
  simulateRiverbeds([flatCourse], field);
  assert.equal(flatCourse.falls.length, 0, 'no available drop on the floodplain');
});

test('deposited sediment raises island crowns and point bars while leaving both island branches wet', () => {
  const [main, child] = watershed();
  simulateRiverbeds([main, child], field);
  assert.ok(main.islands.length > 0);
  for (const island of main.islands) {
    assert.ok(island.settledKgS > 0 && island.heightM > 0 && island.sand + island.rock <= 1);
    near(riverIslandHeightM(island, island.x, island.z), island.heightM);
    near(riverIslandDistance(island, island.x + island.tx * island.halfLengthM, island.z + island.tz * island.halfLengthM), 0);
    const p = main.points.reduce((best, s) => Math.hypot(s.x - island.x, s.z - island.z)
      < Math.hypot(best.x - island.x, best.z - island.z) ? s : best);
    for (const side of [-1, 1]) {
      const across = side * p.channelM * .65;
      assert.ok(riverIslandDistance(island, p.x - island.tz * across, p.z + island.tx * across) < 0);
      assert.ok(sampleRiverbed(p, p, 0, across).signedWetDistanceM > 0);
    }
  }
  const p = main.points.reduce((best, s) => Math.abs(s.hydro.barSide) * s.hydro.barStrength >
    Math.abs(best.hydro.barSide) * best.hydro.barStrength ? s : best);
  const side = Math.sign(p.hydro.barSide), inner = riverWetHalfWidthM(p, p, 0, side);
  assert.ok(inner < p.channelM);
  const exposed = sampleRiverbed(p, p, 0, side * (inner + p.channelM) * .5);
  assert.ok(exposed.signedWetDistanceM < 0 && exposed.bedM > exposed.waterM && exposed.barHeightM > 0);
  assert.ok(sampleRiverbed(p, p, 0, -side * (inner + p.channelM) * .5).signedWetDistanceM > 0);
});

test('sediment supply grows a laterally offset bar with a blunt nose and tapered downstream tail', () => {
  const [sparse, first] = watershed(), [laden, second] = watershed();
  for (const p of sparse.points) p.colluviumM = 0;
  for (const p of laden.points) p.colluviumM = 30;
  simulateRiverbeds([sparse, first], field);
  simulateRiverbeds([laden, second], field);
  const a = sparse.islands[0], b = laden.islands.find(s => s.stationM === a.stationM);
  assert.ok(b && b.settledKgS > a.settledKgS && b.heightM > a.heightM && b.halfWidthM > a.halfWidthM);
  assert.ok(b.noseM > a.noseM && b.tailM > a.tailM && b.tailM > 1.4 * b.noseM);
  assert.ok(Math.abs(b.offsetM) > .5 && Math.abs(b.offsetM) > Math.abs(a.offsetM));
  const distance = (along, across) => riverIslandDistance(b, b.x + along * b.tx - across * b.tz,
    b.z + along * b.tz + across * b.tx);
  near(distance(-b.noseM, 0), 0); near(distance(b.tailM, 0), 0);
  assert.ok(distance(-.8 * b.noseM, .52 * b.halfWidthM) > 0 && distance(.8 * b.tailM, .52 * b.halfWidthM) < 0);
  const legacy = { x: 0, z: 0, tx: 1, tz: 0, halfLengthM: 60, halfWidthM: 22 };
  near(riverIslandDistance(legacy, -30, 5), riverIslandDistance(legacy, 30, 5));
});

test('Songprint runoff changes width and discharge; delivered colluvium increases sediment supply', () => {
  const [low] = watershed(), [high] = watershed();
  const quiet = { character: { relief: .1, ruggedness: .1, activity: .1 } };
  const section = low.points[0];
  assert.ok(riverHalfWidthM(section, quiet) < riverHalfWidthM(section, field));
  assert.ok(riverHalfWidthM({ area: 9000, broad: 1 }, field) > riverHalfWidthM({ area: 6500, broad: 1 }, field));
  const drier = simulateRiverbeds([low], quiet), wetter = simulateRiverbeds([high], field);
  assert.ok(wetter.outletDischargeM3s > drier.outletDischargeM3s * 1.5);
  const [bare] = watershed();
  for (const p of bare.points) p.colluviumM = 0;
  assert.ok(simulateRiverbeds([bare], field).suppliedKgS < .9 * wetter.suppliedKgS);
});
