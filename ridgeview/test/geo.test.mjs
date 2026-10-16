import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../src/core/geo.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);

test('ECEF round trip', () => {
  for (const [lon, lat, h] of [[-110.8, 43.74, 4199], [0, 0, 0], [179.9, -60, -400], [-45, 85, 9000]]) {
    const p = g.lonLatToEcef(lon, lat, h);
    const r = g.ecefToLonLat(...p);
    near(r.lon, lon, 1e-9); near(r.lat, lat, 1e-9); near(r.h, h, 1e-6);
  }
});

test('ENU basis is orthonormal and up matches the position', () => {
  const { east, north, up } = g.enuBasis(-110.8, 43.7);
  for (const v of [east, north, up]) near(g.v3.len(v), 1, 1e-12);
  near(g.v3.dot(east, north), 0, 1e-12);
  near(g.v3.dot(east, up), 0, 1e-12);
  const p = g.v3.norm(g.lonLatToEcef(-110.8, 43.7, 0));
  near(g.v3.dot(p, up), 1, 1e-12);
  // north points toward the pole
  assert.ok(north[2] > 0);
});

test('mercator round trip and tile lookup', () => {
  for (const lat of [-80, -43.2, 0, 12.5, 63.07]) near(g.myToLat(g.latToMy(lat)), lat, 1e-9);
  const t = g.tileAt(-110.8024, 43.7411, 12);
  const b = g.tileBounds(12, t.x, t.y);
  assert.ok(b.west <= -110.8024 && b.east > -110.8024 && b.south <= 43.7411 && b.north > 43.7411);
});

test('distance, bearing and destination agree', () => {
  const d = g.distance(-110.8024, 43.7411, -110.7762, 43.835); // Grand Teton -> Mount Moran
  near(d, 10700, 300);
  const brg = g.bearing(-110.8024, 43.7411, -110.7762, 43.835);
  const [lon, lat] = g.destination(-110.8024, 43.7411, brg, d);
  near(lon, -110.7762, 1e-6); near(lat, 43.835, 1e-6);
});

test('heading/pitch <-> direction', () => {
  for (const [h, p] of [[0, 0], [90, 10], [225, -30], [359, 60]]) {
    const dir = g.headingPitchToDirection(h, p, 10, 46);
    const r = g.directionToHeadingPitch(dir, 10, 46);
    near(((r.heading - h + 540) % 360) - 180, 0, 1e-9); near(r.pitch, p, 1e-9);
  }
});

test('slerp hits endpoints and the midpoint is equidistant', () => {
  const a = [-110.8, 43.7], b = [86.925, 27.988];
  const s0 = g.slerpLonLat(...a, ...b, 0), s1 = g.slerpLonLat(...a, ...b, 1), m = g.slerpLonLat(...a, ...b, 0.5);
  near(s0[0], a[0], 1e-9); near(s1[1], b[1], 1e-9);
  near(g.distance(...a, ...m), g.distance(...m, ...b), 1);
});

test('curvature drop at 50 km is ~170 m with refraction', () => {
  near(g.curvatureDrop(50000), 170, 5);
});
