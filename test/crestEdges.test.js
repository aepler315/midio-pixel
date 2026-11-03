// Output-resolution edges from the crest probe's fine render (CrestProbe.js,
// RangeCrest.js): the fine crest rows and terrain-over-terrain edge cells.
// The shaders themselves are checked on a GPU by tools/crest-edge-smoke.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_EDGE_ROW, PROBE_FINE_ROWS, PROBE_FINE_K, EDGE_NEIGHBOURS, PROBE_EDGE_JUMP, PROBE_EDGE_MATCH, edgeCell } from '../src/world/alpine/CrestProbe.js';
import { decodeEdges, colorEdges, edgeState, fineCrest } from '../src/world/alpine/RangeCrest.js';

const W = 6, H = 4;
const identity = (e = 0, f = 0) => ({ a: 1, b: 0, c: 0, d: 1, e, f, sx: 1, sy: 1, Wg: W, Hg: H });
function probeWith(cells, { edges = 1, water = [] } = {}) {
  const data = new Uint8Array((PROBE_EDGE_ROW + 2 * H) * W * 4);
  for (const [block, list] of [[0, cells], [1, water]]) for (const [i, r, mask, n] of list) {
    const o = ((PROBE_EDGE_ROW + block * H + H - 1 - r) * W + i) * 4; // rows bottom-up
    data[o] = mask & 255; data[o + 1] = mask >> 8; data[o + 2] = n; data[o + 3] = 255;
  }
  return { width: W, height: H, data, rows: 0, edges };
}

test('an edge texel decodes to its 16-pixel mask and neighbour; empty texels to null', () => {
  const data = new Uint8Array([0x0f, 0xf0, 3, 255, 0, 0, 0, 0, 0, 0, 2, 255, 1, 0, 9, 255]);
  assert.deepEqual(edgeCell(data, 0), { mask: 0xf00f, neighbour: 3 });
  assert.equal(edgeCell(data, 4), null, 'no alpha: nothing');
  assert.equal(edgeCell(data, 8), null, 'no pixel masked: nothing');
  assert.equal(edgeCell(data, 12), null, 'no such neighbour: nothing');
  assert.equal(EDGE_NEIGHBOURS.length, 8);
  assert.equal(PROBE_FINE_K * PROBE_FINE_K, 16, 'one 16-bit mask holds a cell');
  assert.ok(PROBE_EDGE_JUMP > 1 && PROBE_EDGE_MATCH < 0.5, 'a smooth slope stays nearer its own cell');
});

test('edge cells land on grid cells through the probe offset, top-down', () => {
  const out = edgeState(1);
  // Target (2, 1) and (5, 3); the grid is drawn 1.4 px left and 0.6 px up:
  // grid cell (x, y) samples target (x + 1, y + 1).
  const n = decodeEdges(probeWith([[2, 1, 0x00f0, 3], [5, 3, 0x0001, 0], [0, 0, 0x8000, 1]]), identity(-1.4, -0.6), out);
  assert.equal(n, 2, 'the target cell left of the grid is dropped');
  assert.deepEqual([out.x[0], out.y[0], out.mask[0], out.n[0]], [1, 0, 0x00f0, 3]);
  assert.deepEqual([out.x[1], out.y[1], out.mask[1], out.n[1]], [4, 2, 0x0001, 0]);
  assert.ok(out.x.length >= 2, 'storage grows');
});

test('water edge cells (dry pixels of wet cells) follow the terrain ones, each block only when written', () => {
  const out = edgeState();
  const both = probeWith([[1, 1, 0x000f, 3]], { edges: 3, water: [[4, 2, 0xf000, 0]] });
  assert.equal(decodeEdges(both, identity(), out), 2);
  assert.deepEqual([out.x[1], out.y[1], out.mask[1], out.n[1]], [4, 2, 0xf000, 0]);
  const waterOnly = probeWith([[1, 1, 0x000f, 3]], { edges: 2, water: [[4, 2, 0xf000, 0]] });
  assert.equal(decodeEdges(waterOnly, identity(), out), 1, 'an unwritten terrain block is not read');
  assert.equal(out.x[0], 4);
});

test('no edge cells without the fine pass, or when the target is scaled or turned against the grid', () => {
  const out = edgeState();
  assert.equal(decodeEdges(probeWith([[2, 1, 1, 0]], { edges: 0 }), identity(), out), 0);
  assert.equal(decodeEdges(probeWith([[2, 1, 1, 0]]), { ...identity(), a: 0.5 }, out), 0);
  assert.equal(decodeEdges(probeWith([[2, 1, 1, 0]]), { ...identity(), c: 0.01 }, out), 0);
  assert.equal(decodeEdges(probeWith([[2, 1, 1, 0]]), null, out), 0);
  assert.equal(out.count, 0);
});

function grid(fill) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(fill(x, y), (y * W + x) * 4);
  return data;
}

test('each edge cell takes its neighbour\'s colour, unless there is nothing to paint', () => {
  // Sky row 0, far ridge (blue) row 1, near ridge (brown) rows 2-3.
  const data = grid((x, y) => y === 0 ? [0, 0, 0, 0] : y === 1 ? [90, 100, 200, 255] : [100, 80, 60, 255]);
  data.set([100, 80, 60, 255], (1 * W + 4) * 4); // one far cell already brown
  const edges = edgeState();
  const cells = [[1, 2, 0], [2, 2, 0], [3, 1, 0], [4, 2, 0], [5, 2, 0]]; // all looking up
  cells.forEach(([x, y, n], k) => { edges.x[k] = x; edges.y[k] = y; edges.mask[k] = 0xff; edges.n[k] = n; });
  edges.count = cells.length;
  const busy = (x, y) => x === 5 && y === 2;
  assert.equal(colorEdges(edges, data, W, 0, H, { busy }), 2);
  assert.equal(edges.color[0], 90 << 16 | 100 << 8 | 200, 'near cell shows the far ridge above it');
  assert.equal(edges.color[1], 90 << 16 | 100 << 8 | 200);
  assert.equal(edges.color[2], -1, 'never paints sky (the crest line owns that edge)');
  assert.equal(edges.color[3], -1, 'same colour both sides: nothing to paint');
  assert.equal(edges.color[4], -1, 'a cell a crest line already splits is left to it');
  // A lagged probe moved by the grid's own shift; rows outside the data read are skipped.
  edges.count = 1; edges.y[0] = 1;
  assert.equal(colorEdges(edges, data, W, 0, H, { dy: 1 }), 1);
  edges.y[0] = 2;
  assert.equal(colorEdges(edges, data.subarray(2 * W * 4), W, 2, 2), 0, 'the neighbour\'s row was not read');
});

test('the fine crest replaces whole-row steps by output-pixel rows, but never shaves a crown', () => {
  const PW = 3, rows = PROBE_FINE_ROWS.far;
  const data = new Uint8Array((rows + 2) * PW * 4);
  const put = (j, sub, row) => { const o = ((rows + (sub >> 1)) * PW + j) * 4 + (sub & 1) * 2; data[o] = (row + 1) & 255; data[o + 1] = (row + 1) >> 8; };
  // Column 0: sub-rows 40, 41, 41, 42 → 10.25 grid rows. Column 1: one
  // sub-column has no terrain. Column 2: the grid crest is 3 rows above (a tree).
  [40, 41, 41, 42].forEach((r, s) => put(0, s, r));
  [40, 40, 40].forEach((r, s) => put(1, s, r));
  [52, 52, 52, 52].forEach((r, s) => put(2, s, r));
  const probe = { width: PW, data, rows: 1 << rows };
  const raw = Float32Array.from([10, 10, 10]), recon = Float32Array.from([10.5, 10, 10]);
  assert.equal(fineCrest(probe, 'far', raw, recon), 1);
  assert.equal(recon[0], 10.25);
  assert.equal(recon[1], 10, 'incomplete: the grid crest stands');
  assert.equal(recon[2], 10, 'a crown above the terrain keeps the grid crest');
  assert.equal(fineCrest({ ...probe, rows: 0 }, 'far', raw, recon), 0, 'no fine pass this frame');
});
