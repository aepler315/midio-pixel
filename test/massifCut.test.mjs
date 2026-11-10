import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE_CELLS, findMassifSeeds, watershedLabels, cutMassif, borderRelief, quarterTurn, mirrorX, facingTurns,
  blockTiles, CUT_DEFAULTS,
} from '../tools/lib/massif-cut.mjs';

// Two Gaussian summits on a tilted plain, 20 m cells, X east and Z south.
function twinPeaks({ W = 449, H = 385, cell = 20 } = {}) {
  const heightsM = new Float32Array(W * H), valid = new Uint8Array(W * H).fill(1);
  const originM = [-(W - 1) * cell / 2, -(H - 1) * cell / 2];
  const bump = (x, z, cx, cz, a, s) => a * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * s * s));
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = originM[0] + i * cell, z = originM[1] + j * cell;
    heightsM[j * W + i] = 1800 + 0.01 * z + bump(x, z, -1800, 0, 1400, 900) + bump(x, z, 2000, 300, 1000, 800)
      + 25 * Math.sin(x / 210) * Math.cos(z / 170);
  }
  return { width: W, height: H, cellSizeM: cell, originM, heightsM, valid };
}

const peakIndex = (g, xM) => {
  const i = Math.round((xM - g.originM[0]) / g.cellSizeM);
  let best = -1;
  for (let j = 0; j < g.height; j++) for (let di = -60; di <= 60; di++) {
    const k = j * g.width + i + di;
    if (best < 0 || g.heightsM[k] > g.heightsM[best]) best = k;
  }
  return best;
};

test('seeds start with landmarks, then prominent summits, without near duplicates', () => {
  const g = twinPeaks();
  const seeds = findMassifSeeds(g, { landmarks: [{ name: 'West', localM: [-1750, 40] }], peakRadiusM: 1500 });
  assert.equal(seeds[0].name, 'West');
  assert.equal(seeds[0].kind, 'landmark');
  assert.equal(seeds[0].index, peakIndex(g, -1800));
  assert.ok(seeds.some((s) => s.kind === 'prominence' && s.index === peakIndex(g, 2000)), 'east summit found by prominence');
  for (let a = 0; a < seeds.length; a++) for (let b = a + 1; b < seeds.length; b++) {
    const ax = seeds[a].index % g.width, ay = Math.floor(seeds[a].index / g.width);
    const bx = seeds[b].index % g.width, by = Math.floor(seeds[b].index / g.width);
    assert.ok(Math.hypot(ax - bx, ay - by) * g.cellSizeM >= CUT_DEFAULTS.seedSpacingM);
  }
});

test('the watershed splits neighbouring summits along the valley between them', () => {
  const g = twinPeaks();
  const seeds = [{ index: peakIndex(g, -1800) }, { index: peakIndex(g, 2000) }];
  const labels = watershedLabels(g, seeds);
  const row = Math.round(-g.originM[1] / g.cellSizeM);
  let boundary = -1;
  for (let i = 1; i < g.width; i++) if (labels[row * g.width + i] !== labels[row * g.width + i - 1]) { boundary = i; break; }
  const xM = g.originM[0] + boundary * g.cellSizeM;
  // The saddle of the two Gaussians lies between them, nearer the smaller one.
  assert.ok(xM > -200 && xM < 1200, `boundary at ${xM} m`);
  assert.ok(labels.every((l) => l === 0 || l === 1));
});

test('a cut piece is tile aligned, zero on its outline and border, and true relief inside', () => {
  const g = twinPeaks();
  const seeds = [{ index: peakIndex(g, -1800), name: 'West', kind: 'landmark', heightM: 0 }, { index: peakIndex(g, 2000), name: null, kind: 'prominence', heightM: 0 }];
  const labels = watershedLabels(g, seeds);
  const r = cutMassif(g, seeds[0], labels, 0, { maxTiles: 6 });
  assert.equal(r.ok, true, r.reason);
  const p = r.piece;
  assert.equal((p.width - 1) % TILE_CELLS, 0);
  assert.equal((p.height - 1) % TILE_CELLS, 0);
  assert.deepEqual(p.tiles, [(p.width - 1) / TILE_CELLS, (p.height - 1) / TILE_CELLS]);
  assert.ok(Math.max(...p.tiles) <= 6);
  assert.equal(borderRelief(p.relief, p.width, p.height), 0);
  assert.ok(p.relief.every((v) => v >= 0 && Number.isFinite(v)));
  // Every relief cell touching a zero cell is the outline: it is zero too, so
  // a positive cell never meets a zero neighbour by more than one cell's rise.
  let maxStep = 0;
  for (let j = 1; j < p.height - 1; j++) for (let i = 1; i < p.width - 1; i++) {
    const k = j * p.width + i;
    if (!p.relief[k]) continue;
    for (const m of [k - 1, k + 1, k - p.width, k + p.width]) if (!p.relief[m]) maxStep = Math.max(maxStep, p.relief[k]);
  }
  assert.ok(maxStep < 40, `largest rise next to the outline ${maxStep.toFixed(1)} m over one 20 m cell`);
  assert.ok(p.peakReliefM > 1000, `peak relief ${p.peakReliefM}`);
  assert.ok(p.peakM - p.peakReliefM - p.baseAtPeakM < 1e-3);
  // Base removal does not steepen the outline beyond the source terrain.
  assert.ok(p.outline.band[1] <= 1.1 * p.outline.bandSource[1] + 0.02, JSON.stringify(p.outline));
});

test('cutting is deterministic', () => {
  const g = twinPeaks();
  const seeds = findMassifSeeds(g);
  const labels = watershedLabels(g, seeds);
  const a = cutMassif(g, seeds[0], labels, 0, { maxTiles: 6 }), b = cutMassif(g, seeds[0], watershedLabels(g, seeds), 0, { maxTiles: 6 });
  assert.equal(a.ok, true);
  assert.deepEqual(Buffer.from(a.piece.relief.buffer), Buffer.from(b.piece.relief.buffer));
  assert.equal(a.piece.levelM, b.piece.levelM);
});

test('a size budget too small for the summit is refused', () => {
  const g = twinPeaks();
  const seeds = findMassifSeeds(g);
  const r = cutMassif(g, seeds[0], watershedLabels(g, seeds), 0, { maxTiles: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /too-large|relief-below-minimum/);
});

test('quarter turns map +X onto +Z, four are the identity, mirroring twice is the identity', () => {
  const W = 3, H = 2, d = Float32Array.from([1, 2, 3, 4, 5, 6]);
  const q = quarterTurn(d, W, H);
  assert.equal(q.width, 2); assert.equal(q.height, 3);
  // The east-middle-ish value 3 (row 0, rightmost) lands on the bottom row.
  assert.ok([q.data[(q.height - 1) * q.width], q.data[(q.height - 1) * q.width + 1]].includes(3));
  let r = { data: d, width: W, height: H };
  for (let k = 0; k < 4; k++) r = quarterTurn(r.data, r.width, r.height);
  assert.deepEqual([...r.data], [...d]);
  assert.deepEqual([...mirrorX(mirrorX(d, W, H), W, H)], [...d]);
  assert.deepEqual([...mirrorX(d, W, H)], [3, 2, 1, 6, 5, 4]);
});

test('facing turns bring the source viewer onto +Z and report the remainder', () => {
  assert.deepEqual(facingTurns([0, 10]), { turns: 0, residualDeg: 0 });
  assert.equal(facingTurns([10, 0]).turns, 1);
  assert.equal(facingTurns([0, -10]).turns, 2);
  assert.equal(facingTurns([-10, 0]).turns, 3);
  const f = facingTurns([10, 10]);
  assert.equal(Math.abs(f.residualDeg), 45);
});

test('blocks keep a zero ring of at least two cells', () => {
  assert.deepEqual(blockTiles({ minX: 0, maxX: 60, minY: 0, maxY: 59 }), [1, 1]);
  assert.deepEqual(blockTiles({ minX: 0, maxX: 61, minY: 0, maxY: 59 }), [2, 1]);
});
