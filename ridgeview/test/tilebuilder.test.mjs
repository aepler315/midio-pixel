import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTile, toHalf, tileHeightAt, gridIndex, skirtLoop } from '../src/engine/TileBuilder.js';
import { mxToLon, myToLat, lonToMx, latToMy, tileAt } from '../src/core/geo.js';

// Analytic terrain sampled at pixel centres, like real terrarium tiles.
const terrain = (lon, lat) => 2000 + 800 * Math.sin(lon * 40) * Math.cos(lat * 37) + (lon > -110.62 && lon < -110.58 && lat > 43.82 && lat < 43.86 ? -1500 : 0);
class FakeDem {
  constructor(fn, maxLevel = 15) { this.fn = fn; this.maxLevel = maxLevel; this.cache = new Map(); }
  resolve(level, tx, ty) {
    const L = Math.min(level, this.maxLevel), s = level - L, ax = tx >> s, ay = ty >> s;
    const k = `${L}/${ax}/${ay}`;
    if (!this.cache.has(k)) {
      const h = new Float32Array(65536), N = 256 * 2 ** L;
      for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
        let v = this.fn(mxToLon((ax * 256 + i + 0.5) / N), myToLat((ay * 256 + j + 0.5) / N));
        if (v < 1000) v = 500; // flat lake
        h[j * 256 + i] = v;
      }
      this.cache.set(k, h);
    }
    return { heights: this.cache.get(k), level: L, ox: ax * 256, oy: ay * 256, scale: 2 ** s };
  }
}

test('half-float conversion', () => {
  const back = (h) => {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    return e === 0 ? s * m * 2 ** -24 : s * (1 + m / 1024) * 2 ** (e - 15);
  };
  for (const v of [0, 1, -1, 0.5, 0.0001, 3.14159, -2.75, 1000.5, 60000]) {
    assert.ok(Math.abs(back(toHalf(v)) - v) <= Math.abs(v) * 1e-3 + 1e-6, `${v} -> ${back(toHalf(v))}`);
  }
});

test('index buffer covers grid and skirts', () => {
  const M = 8, idx = gridIndex(M), nv = (M + 1) ** 2 + skirtLoop(M).length;
  assert.equal(idx.length, M * M * 6 + skirtLoop(M).length * 6);
  assert.ok(Math.max(...idx) === nv - 1);
});

test('neighbouring tiles share identical edges (no cracks)', () => {
  const dem = new FakeDem(terrain), z = 14, t = tileAt(-110.7, 43.8, z);
  const a = buildTile(dem, z, t.x, t.y, { S: 32, M: 16 });
  const b = buildTile(dem, z, t.x + 1, t.y, { S: 32, M: 16 });
  const c = buildTile(dem, z, t.x, t.y + 1, { S: 32, M: 16 });
  for (let j = 0; j <= 32; j++) assert.equal(a.heightfield[j * 33 + 32], b.heightfield[j * 33]);
  for (let i = 0; i <= 32; i++) assert.equal(a.heightfield[32 * 33 + i], c.heightfield[i]);
});

test('reconstructs heights where the data is, with and without overzoom', () => {
  const dem = new FakeDem(terrain);
  for (const z of [12, 16, 18]) {
    const t = tileAt(-110.75, 43.75, z);
    const tile = buildTile(dem, z, t.x, t.y, { S: 32, M: 16, detail: false });
    const n = 2 ** z, u = lonToMx(-110.75) * n - t.x, v = latToMy(43.75) * n - t.y;
    const h = tileHeightAt(tile, u, v);
    assert.ok(Math.abs(h - terrain(-110.75, 43.75)) < 6, `z${z}: ${h} vs ${terrain(-110.75, 43.75)}`);
  }
});

test('flat lake is marked as water and keeps its level', () => {
  const dem = new FakeDem(terrain), z = 15, t = tileAt(-110.6, 43.84, z);
  const tile = buildTile(dem, z, t.x, t.y, { S: 32, M: 16 });
  const mid = 18 * tile.texSize + 18;
  // water channel = 0.5 (lake) as half float 0x3800
  assert.equal(tile.tex[mid * 4 + 2], toHalf(0.5));
  assert.ok(Math.abs(tile.heightfield[16 * 33 + 16] - 500) < 1e-3);
});

test('micro-relief appears only past the data resolution and only on land', () => {
  const dem = new FakeDem(terrain);
  const t16 = tileAt(-110.75, 43.75, 18);
  const smooth = buildTile(dem, 18, t16.x, t16.y, { S: 32, M: 16, detail: false });
  const rough = buildTile(dem, 18, t16.x, t16.y, { S: 32, M: 16, detail: true });
  let diff = 0;
  for (let i = 0; i < smooth.heightfield.length; i++) diff = Math.max(diff, Math.abs(smooth.heightfield[i] - rough.heightfield[i]));
  assert.ok(diff > 0.05 && diff < 20, `detail amplitude ${diff}`);
  const t12 = tileAt(-110.75, 43.75, 12);
  const far = buildTile(dem, 12, t12.x, t12.y, { S: 32, M: 16, detail: true });
  const farPlain = buildTile(dem, 12, t12.x, t12.y, { S: 32, M: 16, detail: false });
  assert.deepEqual([...far.heightfield], [...farPlain.heightfield]);
});
