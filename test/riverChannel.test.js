import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  riverChannelErrors, resolveRiverFlow, projectRiverPoint, buildRiverGeometry, riverGeometryBound,
} from '../src/world/alpine/RiverChannel.js';
import { sceneDeformation } from '../src/world/alpine/RangeFrame.js';

const manifest = {
  source: { horizontalCrs: '+proj=tmerc +lat_0=38.58 +lon_0=-109.34 +k=1 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs' },
};
const data = { manifest, grid: { cellSizeM: 22 } };
const reach = (extra = {}) => ({
  id: 'castle-creek-test', name: 'Castle Creek', permanence: 'perennial', state: 'flowing',
  pathLonLat: [[-109.341, 38.58], [-109.339, 38.58]], widthM: 2, depthM: .1,
  dischargeM3s: .1,
  source: { provider: 'USGS', url: 'https://example.org/nhdplus', retrievedAt: '2026-10-21',
    estimateKind: 'modeled-mean-annual', flowDirection: 'with-digitized' },
  ...extra,
});
const view = (rivers) => ({ biome: 'CANYON', rivers });

// These are drawn triangles, with y = 100 + .1*x + .2*z. Each half belongs
// to a different depth pass; the source DEM may contain finer detail.
function terrain() {
  const band = (west, east) => ({
    positions: new Float32Array([
      west, 100 + .1 * west - 40, -200, east, 100 + .1 * east - 40, -200,
      west, 100 + .1 * west + 40, 200, east, 100 + .1 * east + 40, 200,
    ]),
    indices: new Uint32Array([0, 2, 3, 0, 3, 1]),
  });
  return { bands: { near: band(-200, 0), mid: { positions: new Float32Array(), indices: new Uint32Array() }, far: band(0, 200) } };
}

test('missing, dry and unknown reaches create no river surface even with modeled annual discharge', () => {
  for (const rivers of [undefined, [], [reach({ state: 'dry' })], [reach({ state: 'unknown' })]]) {
    const result = buildRiverGeometry(data, view(rivers), terrain());
    assert.equal(result.stats.vertices, 0);
    assert.equal(result.stats.bytes, 0);
    assert.equal(riverGeometryBound(view(rivers)), 0);
  }
  const dry = reach({ state: 'dry', widthM: null, depthM: null, dischargeM3s: null, velocityMps: null,
    source: { ...reach().source, estimateKind: 'ordinary-no-runoff-condition' } });
  assert.deepEqual(riverChannelErrors(dry), [], 'unknown dry dimensions are not measured zeroes');
});

test('zero discharge suppresses current while missing discharge can use an explicit model velocity', () => {
  assert.equal(resolveRiverFlow(reach({ dischargeM3s: 0, velocityMps: .4 })).active, false);
  const missing = reach({ velocityMps: .4 });
  delete missing.dischargeM3s;
  const resolved = resolveRiverFlow(missing);
  assert.equal(resolved.active, true);
  assert.equal(resolved.speedMps, .4);
  assert.equal(resolved.dischargeM3s, null);
  const unobserved = resolveRiverFlow(reach({ dischargeM3s: null, velocityMps: .4, depthM: null }));
  assert.equal(unobserved.active, true, 'unknown discharge is distinct from an explicit zero');
  assert.equal(unobserved.speedMps, .4);
});

test('continuity uses explicitly supplied width and depth and preserves the estimate provenance', () => {
  const resolved = resolveRiverFlow(reach());
  assert.equal(resolved.speedMps, .5, '.1 m3/s divided by 2 m * .1 m is .5 m/s');
  assert.equal(resolved.source.estimateKind, 'modeled-mean-annual');
  const incomplete = reach();
  delete incomplete.depthM;
  assert.equal(resolveRiverFlow(incomplete).active, false, 'discharge alone cannot imply velocity');
});

test('invalid paths, units and missing source attribution cannot activate water', () => {
  const invalid = [
    reach({ dischargeM3s: -1 }), reach({ dischargeM3s: NaN }),
    reach({ velocityMps: Infinity }), reach({ widthM: 0 }), reach({ widthM: 1e9 }), reach({ pathLonLat: [[-109, 38]] }),
    reach({ pathLonLat: [[-109, 91], [-109, 38]] }), reach({ source: null }),
    reach({ source: { ...reach().source, flowDirection: 'unknown' } }),
    reach({ source: { ...reach().source, estimateKind: 'live' } }),
  ];
  for (const river of invalid) {
    assert.ok(riverChannelErrors(river).length, `invalid river ${JSON.stringify(river)}`);
    assert.equal(resolveRiverFlow(river).active, false);
  }
});

test('local projection agrees with the independent normalized DEM landmark coordinates', () => {
  const origin = projectRiverPoint(manifest, [-109.34, 38.58]);
  assert.ok(Math.abs(origin[0]) < 1e-6 && Math.abs(origin[1]) < 1e-6);
  // Pinned La Sal terrain manifest, independently projected by pyproj during
  // the original DEM normalization. Its landmark output is rounded to .1 m.
  const tower = projectRiverPoint(manifest, [-109.3667, 38.6503]);
  assert.ok(Math.abs(tower[0] - -2324.3) < .06, `${tower[0]} east`);
  assert.ok(Math.abs(tower[1] - -7804.2) < .06, `${tower[1]} south`);
  assert.throws(() => projectRiverPoint({ source: { horizontalCrs: 'synthetic' } }, [-109, 38]));
});

test('a narrow channel clips to drawn terrain triangles and retains depth-band ownership', () => {
  const result = buildRiverGeometry(data, view([reach()]), terrain(), { liftM: .2 });
  assert.ok(result.stats.triangles > 0);
  assert.ok(result.bands.near.indices.length && result.bands.far.indices.length);
  assert.equal(result.bands.mid.indices.length, 0);
  let downstreamMin = Infinity, downstreamMax = -Infinity;
  for (const [name, band] of Object.entries(result.bands)) {
    assert.ok(band.positions instanceof Float32Array);
    assert.ok(band.river instanceof Float32Array);
    assert.ok(band.riverDirection instanceof Float32Array);
    assert.ok(band.indices instanceof Uint32Array);
    for (let i = 0; i < band.positions.length / 3; i++) {
      const [x, y, z] = band.positions.slice(3 * i, 3 * i + 3);
      assert.ok(Math.abs(y - (100 + .1 * x + .2 * z + .2)) < .00003, 'river follows actual drawn geometry');
      assert.ok(name === 'near' ? x <= .0001 : x >= -.0001, 'one depth pass owns each clipped part');
      const [along, across, speed] = band.river.slice(3 * i, 3 * i + 3);
      assert.ok(Math.abs(across) <= 1.00001);
      assert.equal(speed, .5);
      downstreamMin = Math.min(downstreamMin, along);
      downstreamMax = Math.max(downstreamMax, along);
      assert.ok(band.riverDirection[2 * i] > .999, 'the digitized eastward path sets downstream');
      assert.ok(Math.abs(band.riverDirection[2 * i + 1]) < .001);
    }
    for (let j = 0; j < band.indices.length; j += 3) {
      const [a, b, c] = band.indices.slice(j, j + 3).map(i => i * 3);
      const p = band.positions;
      const normalY = (p[b + 2] - p[a + 2]) * (p[c] - p[a]) - (p[b] - p[a]) * (p[c + 2] - p[a + 2]);
      assert.ok(normalY > 0, 'triangles face upward');
    }
  }
  assert.ok(downstreamMin < .001 && downstreamMax > 170);
  assert.ok(result.stats.bytes <= riverGeometryBound(view([reach()])));
});

test('missing terrain triangles leave channel gaps rather than bridging no-data', () => {
  const mesh = terrain();
  mesh.bands.far.indices = new Uint32Array();
  const result = buildRiverGeometry(data, view([reach()]), mesh);
  assert.equal(result.bands.far.indices.length, 0);
  for (let i = 0; i < result.bands.near.positions.length; i += 3) assert.ok(result.bands.near.positions[i] <= .0001);
});

test('river vertices retain the source triangle needed to follow nonlinear land movement', () => {
  const geometry = terrain();
  const result = buildRiverGeometry(data, view([reach()]), geometry);
  const music = { waveDir: [1, 0], melodyDir: [0, 1], waveK: 0, phaseRad: 0, melodyK: 0, melodyPhaseRad: 0,
    amplitudeM: 0, kickM: 180, structuralM: 0, melodicM: 0, gestureM: 0 };
  const displacement = p => sceneDeformation(music, p[0], p[2], p[1], [0, 200]);
  let deepestNaiveSink = 0;
  for (const [name, band] of Object.entries(result.bands)) {
    for (const key of ['terrainA', 'terrainB', 'terrainC']) {
      assert.ok(band[key] instanceof Float32Array, `the drawn source triangle ${key} must survive clipping`);
      assert.equal(band[key].length, band.positions.length);
    }
    const source = geometry.bands[name];
    for (let i = 0; i < band.positions.length; i += 3) {
      const p = Array.from(band.positions.slice(i, i + 3));
      const a = Array.from(band.terrainA.slice(i, i + 3));
      const b = Array.from(band.terrainB.slice(i, i + 3));
      const c = Array.from(band.terrainC.slice(i, i + 3));
      assert.ok(Array.from({ length: source.indices.length / 3 }, (_, j) => j).some(j =>
        [a, b, c].every((vertex, k) => vertex.every((v, axis) => v === source.positions[source.indices[j * 3 + k] * 3 + axis]))),
      'source coordinates must belong to one actual drawn triangle');
      const det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
      const u = ((b[2] - c[2]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[2] - c[2])) / det;
      const v = ((c[2] - a[2]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[2] - c[2])) / det;
      const w = 1 - u - v;
      const drawnHeight = u * (a[1] + displacement(a)) + v * (b[1] + displacement(b)) + w * (c[1] + displacement(c));
      const riverHeight = p[1] + u * displacement(a) + v * displacement(b) + w * displacement(c);
      assert.ok(Math.abs(riverHeight - drawnHeight - .15) < .00003, 'interpolating original vertex displacements preserves the .15 m lift');
      deepestNaiveSink = Math.max(deepestNaiveSink, drawnHeight - (p[1] + displacement(p)));
    }
  }
  assert.ok(deepestNaiveSink > .15, 'evaluating the nonlinear field at new ribbon vertices can sink below the drawn terrain');
});

test('geometry has a deterministic allocation bound and never returns a partially truncated channel', () => {
  assert.throws(() => buildRiverGeometry(data, view([reach()]), terrain(), { maxVertices: 3 }), RangeError);
  assert.throws(() => riverGeometryBound(view([reach()]), { maxVertices: Infinity }), RangeError);
  const first = buildRiverGeometry(data, view([reach()]), terrain());
  assert.deepEqual(buildRiverGeometry(data, view([reach()]), terrain()), first);
});

test('non-canyon and tour views never create unsupported river geometry', () => {
  const base = { rivers: [reach()] };
  assert.equal(buildRiverGeometry(data, { ...base, biome: 'CONIFER' }, terrain()).stats.bytes, 0);
  assert.equal(buildRiverGeometry(data, { ...base, biome: 'CANYON', tourManifestUrl: 'tour.json' }, terrain()).stats.bytes, 0);
  for (const rivers of [null, 1, {}, 'wet', [null]]) {
    assert.equal(riverGeometryBound(view(rivers)), 0);
    assert.equal(buildRiverGeometry(data, view(rivers), terrain()).stats.bytes, 0);
  }
});
