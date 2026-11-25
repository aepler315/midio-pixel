import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishPreparation } from '../src/world/alpine/PreparationSteps.js';
import { bakeRiverBankAtlasSteps, RIVER_BANK_MAX_BYTES, RIVER_BANK_MAX_TEXTURE_SIZE, riverBankDistanceAt } from '../src/world/terrain/RiverBankAtlas.js';

const grid = { width: 129, height: 129, cellSizeM: 20, originM: [-1280, -1280] };
const river = (...points) => ({ points: points.map(([x, z, channelM]) => ({ x, z, channelM })) });
const bake = (rivers, options = {}) => finishPreparation(
  bakeRiverBankAtlasSteps(rivers, options.grid ?? grid, options.centre, options.isDryGround));

test('modeled channels serialize bank sediment, hydraulic depth, local whitewater and dry islands', () => {
  const station = (x, grainMm, bankRock, rapid) => ({ x, z: 0, channelM: 72, bed: 100 - x * .01,
    hydro: { grainMm, bankRock, rapid, fall: 0, barSide: 0, barStrength: 0, depthM: 2 } });
  const island = { x: 0, z: 0, tx: 1, tz: 0, halfLengthM: 65, halfWidthM: 24, heightM: 1, sand: .6, rock: .1 };
  const atlas = bake([{ points: [station(-800, 1, .02, 0), station(0, 1, .02, 0), station(420, 40, .9, 1),
    station(800, 40, .9, 1)], islands: [island] }]);
  assert.equal(atlas.version, 2);
  assert.equal(atlas.data.length, atlas.width * atlas.height * 4);
  const pixel = (x, z) => {
    const gx = (x - atlas.originM[0]) / atlas.texelSizeM, gz = (z - atlas.originM[1]) / atlas.texelSizeM;
    const n = atlas.coreSize, side = n + 1;
    const px = Math.floor(gx / n), pz = Math.floor(gz / n), key = 2 * (pz * atlas.pagesX + px);
    const slot = atlas.pageTable[key] + atlas.pageTable[key + 1] * 256 - 1;
    const i = 4 * ((Math.floor(slot / atlas.pageColumns) * side + gz % n) * atlas.width + slot % atlas.pageColumns * side + gx % n);
    return atlas.data.subarray(i, i + 4);
  };
  const calm = pixel(-600, 0), rapid = pixel(600, 0), crown = pixel(0, 0), bank = pixel(600, 80);
  assert.ok(calm[0] > 128 && calm[1] < 96 && calm[2] > 80 && calm[3] === 0);
  assert.ok(rapid[0] > 128 && rapid[1] > 195 && rapid[2] === calm[2] && rapid[3] > 175);
  assert.ok(crown[0] < 128 && crown[2] === 0 && crown[3] === 0);
  assert.ok(bank[0] < 128 && bank[2] === 0 && bank[3] === 0);
  assert.ok(riverBankDistanceAt(atlas, 0, 0) < 0 && riverBankDistanceAt(atlas, 0, 40) > 0);
});

test('sparse ledge slots follow the actual lip axis, agree on shared posts, and preserve the ordinary bank field', () => {
  const hydro = { depthM: 2, grainMm: 19, bankRock: .8, rapid: .6, fall: 0, barSide: 0, barStrength: 0 };
  const station = (x, z) => ({ x, z, bed: 120 - x * .01, channelM: 48, hydro });
  const falls = [{ x: 0, z: 0, footX: 48, footZ: 36, widthM: 96 },
    { x: 175, z: 80, footX: 150, footZ: 140, widthM: 75 }];
  const course = { points: [station(-1100, -150), station(0, 0), station(48, 36), station(175, 80),
    station(150, 140), station(1100, 140)] };
  const centre = [40, -20];
  const plain = bake([course], { centre }), atlas = bake([{ ...course, falls }], { centre });
  assert.equal(plain.pageChannels, undefined);
  assert.equal(atlas.pageChannels, 4);
  assert.equal(atlas.pageTable.length, 4 * atlas.pagesX * atlas.pagesZ);
  assert.equal(atlas.texelSizeM, plain.texelSizeM);
  const n = atlas.coreSize, pitch = n + 1;
  const slotAt = (px, pz, lane) => {
    const key = 4 * (pz * atlas.pagesX + px) + lane;
    return atlas.pageTable[key] + 256 * atlas.pageTable[key + 1] - 1;
  };
  const at = (slot, i, j) => {
    const k = 4 * ((Math.floor(slot / atlas.pageColumns) * pitch + j) * atlas.width + slot % atlas.pageColumns * pitch + i);
    return [...atlas.data.subarray(k, k + 4)];
  };
  const fallPost = (x, z) => {
    const gx = (x + centre[0] - atlas.originM[0]) / atlas.texelSizeM, gz = (z + centre[1] - atlas.originM[1]) / atlas.texelSizeM;
    const px = Math.floor(gx / n), pz = Math.floor(gz / n), slot = slotAt(px, pz, 2);
    assert.ok(slot >= 0);
    const [lo, hi, weight, progress] = at(slot, gx % n, gz % n);
    return { across: (lo + hi * 256 - 32768) / 8, weight, progress };
  };
  const lip = fallPost(0, 0), mid = fallPost(20, 20), left = fallPost(0, 20);
  assert.deepEqual(lip, { across: 0, weight: 255, progress: 0 });
  assert.deepEqual(mid, { across: 4, weight: 255, progress: 119 });
  assert.equal(left.across, 16); // 20m Z projected onto the actual left normal.
  assert.deepEqual(fallPost(0, 80), { across: 64, weight: 0, progress: 204 });
  assert.equal(fallPost(70, 50).progress, 255);
  assert.ok(fallPost(70, 50).weight < mid.weight);
  let shared = 0, ordinary = 0, ledges = 0;
  for (let pz = 0; pz < atlas.pagesZ; pz++) for (let px = 0; px < atlas.pagesX; px++) {
    const slot = slotAt(px, pz, 2), bank = slotAt(px, pz, 0);
    if (slot < 0) { if (bank >= 0) ordinary++; continue; }
    ledges++; assert.ok(bank >= 0 && bank !== slot);
    const east = px + 1 < atlas.pagesX ? slotAt(px + 1, pz, 2) : -1;
    const south = pz + 1 < atlas.pagesZ ? slotAt(px, pz + 1, 2) : -1;
    for (let k = 0; k <= n; k++) {
      if (east >= 0) { assert.deepEqual(at(slot, n, k), at(east, 0, k)); shared++; }
      if (south >= 0) { assert.deepEqual(at(slot, k, n), at(south, k, 0)); shared++; }
    }
  }
  assert.ok(shared > 100 && ledges > 1 && ordinary > ledges);
  for (let x = -950; x < 960; x += 37) for (let z = -150; z < 210; z += 23) {
    const a = {}, b = {};
    assert.equal(riverBankDistanceAt(atlas, x, z, a), riverBankDistanceAt(plain, x, z, b));
    assert.deepEqual(a, b);
  }
});

test('oblique banks keep their physical width between coarse posts and across page seams', () => {
  for (const angle of [0, 5, 15, 30, 45]) {
    const radians = angle * Math.PI / 180, tx = Math.cos(radians), tz = Math.sin(radians);
    for (const shift of [0, 13, 40]) {
      const atlas = bake([river([-1000 * tx, -1000 * tz, 18], [1000 * tx, 1000 * tz, 18])],
        { centre: [-tz * shift, tx * shift] });
      for (let along = -910; along < 910; along += 3.5) for (const side of [-1, 1]) {
        const at = offset => riverBankDistanceAt(atlas,
          along * tx - (shift + side * offset) * tz, along * tz + (shift + side * offset) * tx);
        assert.ok(at(16) > 0 && at(20) < 0, `bank stays within 2 m at ${angle} degrees, phase ${shift}, station ${along}`);
      }
    }
  }
});

test('variable widths join without gaps and a measured massif keeps its dry ground', () => {
  const paths = [river([-900, 0, 20], [900, 0, 70]), river([-650, -650, 16], [0, 0, 22])];
  const atlas = bake(paths, { centre: [35, -57], isDryGround: (x, z) => x > 460 && x < 650 && z < -20 });
  const distance = (x, z) => riverBankDistanceAt(atlas, x + 35, z - 57);
  for (let k = -640; k < 0; k += 2) assert.ok(distance(k, k) > 0);
  for (let x = -800; x < 400; x += 5) {
    const expected = 20 + (x + 900) / 1800 * 50;
    assert.ok(distance(x, expected - 2) > 0 && distance(x, expected + 2) < 0);
    assert.ok(distance(x, 0) > 0);
  }
  // The near edge of a narrow tributary falls inside its wider receiver.
  assert.ok(distance(-20, -42) > 0);
  assert.ok(distance(506, 0) < 0 && distance(715, 0) > 0);
  assert.ok(distance(10000, 0) < 0);
  assert.equal(bake([]), null);
  assert.equal(bake([river([2000, 4000, 20], [2500, 4000, 20])]), null);
});

test('a dense drainage adapts sample spacing within the combined texture budget', () => {
  const largeGrid = { width: 1601, height: 1601, cellSizeM: 20, originM: [0, 0] };
  const courses = Array.from({ length: 100 }, (_, i) => river([0, 160 + 320 * i, 40], [32000, 160 + 320 * i, 40]));
  const atlas = bake(courses, { grid: largeGrid });
  assert.ok(atlas.texelSizeM > 10 && atlas.texelSizeM <= 20);
  assert.ok(atlas.data.byteLength + atlas.pageTable.byteLength <= RIVER_BANK_MAX_BYTES);
  assert.ok(Math.max(atlas.width, atlas.height, atlas.pagesX, atlas.pagesZ) <= RIVER_BANK_MAX_TEXTURE_SIZE);
  assert.ok(atlas.pageTable.some((b, i) => i % 2 === 1 && b > 0), 'more than 255 active pages');
  for (const z of [160, 16160, 31840]) for (const x of [100, 16200, 31800]) {
    assert.ok(riverBankDistanceAt(atlas, x, z) > 0);
    assert.ok(riverBankDistanceAt(atlas, x, z + 50) < 0);
  }
});
