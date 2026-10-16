import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shardMesh, MIDIO_BODY, MIDIO_EYE, MIDIO_MESH,
  BROSHI_BODY, BROSHI_HEAD, BROSHI_JAW, BROSHI_TAIL, MIDASUS_MESH,
  MIDIO_APOTHEOSIS_FOLDED, MIDIO_APOTHEOSIS_UNFOLDED, APOTHEOSIS_INDEX_MAP,
} from '../src/render/meshes.js';
import { lerpMesh } from '../src/render/MeshDrawer.js';

function rimRadii(mesh) {
  const hub = mesh.vertices[0];
  return mesh.vertices.slice(1).map((v) => Math.hypot(v.x - hub.x, v.y - hub.y));
}

function coefficientOfVariation(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

test('every mesh has valid edge indices and a hub at vertex 0', () => {
  for (const mesh of [MIDIO_BODY, MIDIO_EYE, MIDIO_MESH, BROSHI_BODY, BROSHI_HEAD, BROSHI_JAW, BROSHI_TAIL, MIDASUS_MESH]) {
    for (const [i, j] of mesh.edges) {
      assert.ok(i >= 0 && i < mesh.vertices.length);
      assert.ok(j >= 0 && j < mesh.vertices.length);
      assert.notEqual(i, j);
    }
  }
  // The displaceable bodies anchor modal vibration at vertex 0: every rim
  // vertex must sit clearly away from it so radial displacement is defined.
  for (const mesh of [MIDIO_BODY, BROSHI_BODY, MIDASUS_MESH]) {
    for (const r of rimRadii(mesh)) assert.ok(r > 4, `rim vertex too close to hub: ${r}`);
  }
});

test('the glyphs are irregular shards, not wheels: rim radius variation is high', () => {
  // A perfect circle has coefficient of variation 0; the old cartoon
  // wheels were exactly that. The new silhouettes must stay jagged.
  assert.ok(coefficientOfVariation(rimRadii(MIDIO_BODY)) > 0.12,
    `Midio reads too round: cv=${coefficientOfVariation(rimRadii(MIDIO_BODY)).toFixed(3)}`);
  assert.ok(coefficientOfVariation(rimRadii(BROSHI_BODY)) > 0.25,
    `Broshi reads too round: cv=${coefficientOfVariation(rimRadii(BROSHI_BODY)).toFixed(3)}`);
});

test('Midio keeps his physics footprint: 23px half-width, bottom apex on the origin line', () => {
  let minY = Infinity, maxY = -Infinity;
  for (const v of MIDIO_BODY.vertices) {
    assert.ok(Math.abs(v.x) <= 23 + 1e-9, `vertex escapes the collision body at x=${v.x}`);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  // Was a pair of FEET at y=0 with a keel notch between them; it is a single
  // spindle apex now (he hovers -- see MidioMotion.js -- so there is no gait
  // to animate). The invariant itself still matters and is unchanged: the
  // mesh bottoms out exactly on its own origin line, which is what the draw
  // transform, the contact shadow and the ground anchor all measure from.
  assert.ok(Math.abs(maxY) < 1e-9, 'the bottom apex must sit exactly on y=0');
  assert.ok(minY < -50, 'the crown spike must give him real height');
});

test('the core sits centered on the blink axis the renderer scales around', () => {
  // Renderer scales MIDIO_EYE vertices toward MIDIO_EYE_CY = -31; the
  // core's own vertical center must match or the flicker drifts.
  const ys = MIDIO_EYE.vertices.map((v) => v.y);
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  assert.ok(Math.abs(centerY - -31) < 1.6, `core center y=${centerY}, blink axis is -31`);
});

test('Broshi jaw and tail stay 2-vertex lines (the draw code rebuilds them by index)', () => {
  assert.equal(BROSHI_JAW.vertices.length, 2);
  assert.deepEqual(BROSHI_JAW.edges, [[0, 1]]);
  assert.equal(BROSHI_TAIL.vertices.length, 2);
  assert.deepEqual(BROSHI_TAIL.edges, [[0, 1]]);
});

test('shardMesh builds ring + sparse spokes + braces with correct indexing', () => {
  const m = shardMesh({ x: 0, y: 0 }, [
    { x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 }, { x: 0, y: -10 },
  ], { spokeEvery: 2, braces: [[0, 2]] });
  assert.equal(m.vertices.length, 5);
  // 4 ring edges + 2 spokes (rim 0 and 2) + 1 brace.
  assert.equal(m.edges.length, 7);
  for (const [i, j] of m.edges) assert.ok(i < 5 && j < 5);
});

// --- Apotheosis (Movement I): the 9-rim shard's precomputed unfold ---

test('the folded and unfolded apotheosis meshes share vertex count and identical edge topology', () => {
  assert.equal(MIDIO_APOTHEOSIS_FOLDED.vertices.length, MIDIO_APOTHEOSIS_UNFOLDED.vertices.length);
  assert.deepEqual(MIDIO_APOTHEOSIS_FOLDED.edges, MIDIO_APOTHEOSIS_UNFOLDED.edges);
  // 1 hub + 18 rim vertices (the original 9-rim body subdivided).
  assert.equal(MIDIO_APOTHEOSIS_FOLDED.vertices.length, 19);
});

test('the folded mesh is visually identical to the original 9-rim body: its even rim vertices sit exactly on MIDIO_BODY\'s rim', () => {
  assert.equal(APOTHEOSIS_INDEX_MAP.length, MIDIO_BODY.vertices.length - 1);
  for (let k = 0; k < APOTHEOSIS_INDEX_MAP.length; k++) {
    const original = MIDIO_BODY.vertices[k + 1];
    const folded = MIDIO_APOTHEOSIS_FOLDED.vertices[APOTHEOSIS_INDEX_MAP[k]];
    assert.ok(Math.abs(original.x - folded.x) < 1e-9 && Math.abs(original.y - folded.y) < 1e-9,
      `rim vertex ${k}: original (${original.x},${original.y}) vs folded (${folded.x},${folded.y})`);
  }
  // The hub matches too.
  assert.deepEqual(MIDIO_APOTHEOSIS_FOLDED.vertices[0], MIDIO_BODY.vertices[0]);
});

test('the unfolded mesh reaches further from the hub than the folded mesh at every rim vertex (it actually blooms outward)', () => {
  const hub = MIDIO_APOTHEOSIS_FOLDED.vertices[0];
  for (let i = 1; i < MIDIO_APOTHEOSIS_FOLDED.vertices.length; i++) {
    const rFolded = Math.hypot(MIDIO_APOTHEOSIS_FOLDED.vertices[i].x - hub.x, MIDIO_APOTHEOSIS_FOLDED.vertices[i].y - hub.y);
    const rUnfolded = Math.hypot(MIDIO_APOTHEOSIS_UNFOLDED.vertices[i].x - hub.x, MIDIO_APOTHEOSIS_UNFOLDED.vertices[i].y - hub.y);
    assert.ok(rUnfolded > rFolded, `rim vertex ${i} did not expand: folded=${rFolded}, unfolded=${rUnfolded}`);
  }
});

test('lerpMesh(folded, unfolded, t): exact endpoints, no discontinuity at onset, monotone in between', () => {
  const at0 = lerpMesh(MIDIO_APOTHEOSIS_FOLDED, MIDIO_APOTHEOSIS_UNFOLDED, 0);
  assert.deepEqual(at0, MIDIO_APOTHEOSIS_FOLDED);

  const at1 = lerpMesh(MIDIO_APOTHEOSIS_FOLDED, MIDIO_APOTHEOSIS_UNFOLDED, 1);
  assert.deepEqual(at1, MIDIO_APOTHEOSIS_UNFOLDED);

  // No large jump for a small step away from t=0 (morph continuity at onset).
  const nearStart = lerpMesh(MIDIO_APOTHEOSIS_FOLDED, MIDIO_APOTHEOSIS_UNFOLDED, 0.01);
  for (let i = 0; i < nearStart.vertices.length; i++) {
    const a = MIDIO_APOTHEOSIS_FOLDED.vertices[i], b = nearStart.vertices[i];
    assert.ok(Math.hypot(b.x - a.x, b.y - a.y) < 2, `vertex ${i} jumped at morph onset`);
  }

  // Topology is preserved throughout: same edge list as the inputs.
  const mid = lerpMesh(MIDIO_APOTHEOSIS_FOLDED, MIDIO_APOTHEOSIS_UNFOLDED, 0.5);
  assert.deepEqual(mid.edges, MIDIO_APOTHEOSIS_FOLDED.edges);
  assert.equal(mid.vertices.length, MIDIO_APOTHEOSIS_FOLDED.vertices.length);
});

test('Midasus is a hexagram: two closed triangles sharing no edges', () => {
  const tris = [MIDASUS_MESH.edges.slice(0, 3), MIDASUS_MESH.edges.slice(3, 6)];
  for (const tri of tris) {
    const verts = new Set(tri.flat());
    assert.equal(verts.size, 3, 'each triangle must close over exactly 3 vertices');
  }
  const [setA, setB] = tris.map((tri) => new Set(tri.flat()));
  for (const v of setA) assert.ok(!setB.has(v), 'the triangles must interlock, not touch');
});
