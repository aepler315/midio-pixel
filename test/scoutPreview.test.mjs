import test from 'node:test';
import assert from 'node:assert/strict';
import { renderScoutPreview, sampleScoutHeight } from '../tools/lib/scout-preview.mjs';

function fixture(fn = () => 0) {
  const grid = { west: -0.2, south: -0.2, east: 0.2, north: 0.2, width: 161, height: 161 };
  grid.heightsM = Float32Array.from({ length: grid.width * grid.height }, (_, i) => {
    const lon = grid.west + ((i % grid.width + 0.5) / grid.width) * (grid.east - grid.west);
    const lat = grid.north - ((Math.floor(i / grid.width) + 0.5) / grid.height) * (grid.north - grid.south);
    return fn(lon, lat);
  });
  return grid;
}
const camera = { eye: { lon: 0, lat: -0.12, aboveGroundM: 180 }, headingDeg: 0, pitchDeg: 0, hfovDeg: 65 };
const options = { width: 160, height: 90, maxDistanceM: 18000 };
const pixel = (image, x, y) => Array.from(image.rgba.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));

test('north-up bilinear heights follow cell centres and preserve missing data', () => {
  const grid = { west: 0, south: 0, east: 2, north: 2, width: 2, height: 2, heightsM: new Float32Array([10, 20, 30, 40]) };
  assert.equal(sampleScoutHeight(grid, 0.5, 1.5), 10);
  assert.equal(sampleScoutHeight(grid, 1, 1), 25);
  assert.equal(sampleScoutHeight(grid, 1.5, 0.5), 40);
  assert.ok(Number.isNaN(sampleScoutHeight(grid, 2.01, 1)));
  grid.heightsM[3] = NaN;
  assert.equal(sampleScoutHeight(grid, 0.5, 1.5), 10, 'zero-weight no-data neighbours do not erase a valid sample');
  assert.ok(Number.isNaN(sampleScoutHeight(grid, 1, 1)));
});

test('flat terrain produces a stable level horizon and opaque bounded output', () => {
  const grid = fixture();
  const image = renderScoutPreview(grid, camera, options);
  assert.equal(image.rgba.length, 160 * 90 * 4);
  assert.equal(image.coverage, 1);
  assert.equal(image.warning, undefined);
  assert.deepEqual(pixel(image, 20, 20), pixel(image, 140, 20), 'sky is independent of camera column');
  assert.deepEqual(pixel(image, 20, 75), pixel(image, 140, 75), 'equal depth across a flat plane is symmetric');
  assert.notDeepEqual(pixel(image, 80, 20), pixel(image, 80, 75));
  for (let i = 3; i < image.rgba.length; i += 4) assert.equal(image.rgba[i], 255);
  assert.deepEqual(renderScoutPreview(grid, camera, options).rgba, image.rgba);
});

test('a real northern ridge changes the silhouette only when the camera faces it', () => {
  const flat = fixture();
  const ridge = fixture((lon, lat) => 2400 * Math.exp(-(((lat - 0.01) / 0.025) ** 2)) * Math.exp(-((lon / 0.055) ** 2)));
  const facing = renderScoutPreview(ridge, camera, options);
  const plain = renderScoutPreview(flat, camera, options);
  assert.notDeepEqual(pixel(facing, 80, 34), pixel(plain, 80, 34), 'ridge rises above the plain horizon');
  const awayCamera = { ...camera, eye: { lon: 0, lat: 0.12, aboveGroundM: 180 }, headingDeg: 0 };
  const away = renderScoutPreview(ridge, awayCamera, { ...options, maxDistanceM: 7000 });
  assert.deepEqual(pixel(away, 80, 34), pixel(plain, 80, 34), 'ridge behind the camera is absent');
});

test('positive pitch moves the horizon down and absolute height overrides AGL', () => {
  const grid = fixture();
  const level = renderScoutPreview(grid, camera, options);
  const up = renderScoutPreview(grid, { ...camera, pitchDeg: 12 }, options);
  assert.notDeepEqual(pixel(level, 80, 58), pixel(up, 80, 58));
  const absolute = renderScoutPreview(grid, { ...camera, eye: { lon: 0, lat: -0.12, heightM: 180, aboveGroundM: 9999 } }, options);
  assert.deepEqual(absolute.rgba, level.rgba);
});

test('missing strips stop the ray without inventing a terrain wall and report coverage', () => {
  const grid = fixture((lon, lat) => lat > -0.07 && lat < -0.03 ? NaN : lat > 0 ? 3000 : 0);
  const image = renderScoutPreview(grid, camera, options);
  assert.ok(image.coverage > 0 && image.coverage < 0.5);
  assert.match(image.warning, /missing terrain/i);
  const flat = renderScoutPreview(fixture(), camera, options);
  assert.deepEqual(pixel(image, 80, 25), pixel(flat, 80, 25), 'no filled cliff spans the data gap');
});

test('source boundaries and output dimensions have explicit finite limits', () => {
  const grid = fixture();
  const image = renderScoutPreview(grid, camera, { ...options, maxDistanceM: 60000 });
  assert.ok(image.coverage < 1);
  assert.match(image.warning, /source boundary/i);
  for (const invalid of [{ width: Infinity }, { width: 4000 }, { height: 0 }, { maxDistanceM: 0 }, { maxDistanceM: 1e7 }]) {
    assert.throws(() => renderScoutPreview(grid, camera, { ...options, ...invalid }), /preview|distance/i);
  }
  assert.throws(() => renderScoutPreview(grid, { ...camera, hfovDeg: 180 }, options), /camera/i);
  assert.throws(() => renderScoutPreview(grid, { ...camera, eye: { lon: 2, lat: 0, heightM: 1000 } }, options), /ground/i);
  assert.throws(() => renderScoutPreview({ ...grid, heightsM: [] }, camera, options), /grid/i);
});
