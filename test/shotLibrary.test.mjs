import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { packShotPaths, decodeShotLibrary, shotLibraryErrors, SHOT_SCHEMA, SHOT_VERSION, POSITION_STEP_M } from '../src/world/terrain/ShotLibrary.js';
import { samplePath } from '../src/world/terrain/ShotPath.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function library() {
  const a = samplePath({ eyes: [[-3000.123, 812.4, 4000.9], [-1500, 900, 3500], [0, 950.77, 3000]], aims: [[0, 1500, 0], [0, 1500, 0], [0, 1500, 0]], fovs: [30, 28, 26] });
  const b = samplePath({ eyes: [[2000, 1000, 2500], [3500, 1100, 1800], [5000, 1200, 1000]], aims: [[0, 1600, 0], [0, 1600, 0], [0, 1600, 0]], fovs: 22 });
  // A link from a's last sample to b's first, as the authoring tool builds it.
  const n = a.s.length, ln = samplePath({ eyes: [[a.eye[(n - 1) * 3], a.eye[(n - 1) * 3 + 1], a.eye[(n - 1) * 3 + 2]], [1000, 1100, 2900], [b.eye[0], b.eye[1], b.eye[2]]],
    aims: [[a.aim[(n - 1) * 3], a.aim[(n - 1) * 3 + 1], a.aim[(n - 1) * 3 + 2]], [0, 1550, 0], [b.aim[0], b.aim[1], b.aim[2]]], fovs: [a.fov[n - 1], 24, b.fov[0]] });
  for (const p of [a, b, ln]) p.flow = Float32Array.from(p.s, (_, i) => 0.0004 + 0.0001 * Math.sin(i));
  const durationMs = { min: 4000, ideal: 8000, max: 20000 };
  const traits = { headingDeg: 10, azimuthDeg: 190, elevationDeg: 5, aglM: 300, distanceM: 4000, lens: 'normal', foreground: 0.1, side: 'left' };
  const shots = [{ id: 'a', subjectId: 'p', move: 'traverse', path: a, lengthM: a.s.at(-1), payoffS: a.s.at(-1) / 2, holdS: [0, a.s.at(-1)], durationMs, traits, score: { total: 0.7 } },
    { id: 'b', subjectId: 'p', move: 'orbit', path: b, lengthM: b.s.at(-1), payoffS: b.s.at(-1) / 2, holdS: [0, b.s.at(-1)], durationMs, traits, score: { total: 0.6 } }];
  const links = [{ id: 'l', from: 'a', to: 'b', kind: 'direct', path: ln, lengthM: ln.s.at(-1), durationMs, score: { total: 0.5 } }];
  const decoded = Buffer.from(packShotPaths([...shots, ...links]));
  const payload = zlib.gzipSync(decoded);
  const strip = ({ path: _p, ...r }) => r;
  const manifest = { schema: SHOT_SCHEMA, version: SHOT_VERSION, viewId: 'v', regionId: 'r', terrainManifestSha256: 'f'.repeat(64),
    axes: { x: 'east', y: 'up', z: 'south', units: 'metres' }, subjects: [{ id: 'p', kind: 'peak', name: null, posM: [0, 1600, 0], radiusM: 500, heightM: 600 }],
    shots: shots.map(strip), links: links.map(strip),
    payload: { url: 'v.shots.bin.gz', byteLength: payload.length, sha256: sha(payload), decodedByteLength: decoded.length, decodedSha256: sha(decoded) } };
  return { manifest, decoded, source: { a, b, ln } };
}

test('a packed library validates, decodes within the lattice, and joins exactly', () => {
  const { manifest, decoded, source } = library();
  assert.deepEqual(shotLibraryErrors(manifest, { viewId: 'v', decodedByteLength: decoded.length }), []);
  const lib = decodeShotLibrary(manifest, new Uint8Array(decoded));
  for (const [id, src] of [['a', source.a], ['b', source.b]]) {
    const p = lib.shotById.get(id).path;
    for (let i = 0; i < src.eye.length; i++) assert.ok(Math.abs(p.eye[i] - src.eye[i]) <= POSITION_STEP_M / 2 + 1e-3);
    for (let i = 0; i < src.fov.length; i++) assert.ok(Math.abs(p.fov[i] - src.fov[i]) <= 0.006);
    for (let i = 1; i < p.s.length; i++) assert.ok(p.s[i] > p.s[i - 1], 'progress strictly increases');
    assert.ok(Math.abs(p.flow[3] - src.flow[3]) / src.flow[3] < 0.01);
  }
  const a = lib.shotById.get('a').path, b = lib.shotById.get('b').path, l = lib.linkById.get('l').path, n = a.s.length, m = l.s.length;
  for (let k = 0; k < 3; k++) {
    assert.equal(l.eye[k], a.eye[(n - 1) * 3 + k], 'the link starts exactly on the shot exit');
    assert.equal(l.eye[(m - 1) * 3 + k], b.eye[k], 'and ends exactly on the next entry');
    assert.equal(l.aim[k], a.aim[(n - 1) * 3 + k]);
  }
  assert.equal(lib.linksFrom.get('a').length, 1);
});

test('validation rejects unknown ends, overlapping lanes and a missing lattice anchor', () => {
  const { manifest, decoded } = library();
  const bad = structuredClone(manifest);
  bad.links[0].to = 'nowhere';
  assert.ok(shotLibraryErrors(bad).some((e) => /ends/.test(e)));
  const overlap = structuredClone(manifest);
  overlap.shots[1].samples.offset = overlap.shots[0].samples.offset;
  assert.ok(shotLibraryErrors(overlap, { decodedByteLength: decoded.length }).some((e) => /overlapping/.test(e)));
  const anchor = structuredClone(manifest);
  delete anchor.shots[0].samples.first;
  assert.ok(shotLibraryErrors(anchor).some((e) => /samples/.test(e)));
});
