import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feasibleAzimuth, lightPlacement, Looks } from '../src/scene/Looks.js';
import { Flight } from '../src/scene/Flight.js';
import { CameraRig } from '../src/scene/CameraRig.js';
import { distance } from '../src/core/geo.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);

test('low sun stays where the sun can be', () => {
  // 44N: summer sunrise is ~56 degrees, so a due-north low sun is impossible.
  near(feasibleAzimuth(0, 44), 56.4, 1);
  near(feasibleAzimuth(350, 44), 360 - 56.4, 1);
  assert.equal(feasibleAzimuth(120, 44), 120);
  // Southern hemisphere mirrors through the north.
  const s = feasibleAzimuth(180, -44);
  assert.ok(s < 124 || s > 236, `south az ${s}`);
});

test('golden hour lights the face you look at; backlight puts the sun ahead', () => {
  const ctx = { lat: 43.8, heading: 236, ground: 2070, summit: 4199 };
  const g = lightPlacement('golden', ctx);
  const off = Math.abs(((g.sunAz - ctx.heading + 540) % 360) - 180);
  assert.ok(off > 120, `golden sun should be behind the viewer, off ${off}`);
  const b = lightPlacement('backlit', ctx);
  const offB = Math.abs(((b.sunAz - ctx.heading + 540) % 360) - 180);
  assert.ok(offB < 40, `backlit sun should be ahead, off ${offB}`);
  // Alpenglow: sun just below the horizon.
  const a = lightPlacement('alpenglow', ctx);
  assert.ok(a.sunEl < 0 && a.sunEl >= -2.5, `alpenglow el ${a.sunEl}`);
});

test('looks animate toward their targets and the sun takes the short way', () => {
  const L = new Looks();
  L.setContext({ lat: 44, lon: -110, heading: 236, ground: 2000, summit: 4000 });
  const from = L.cur.sunAz;
  L.setLight('backlit');
  for (let i = 0; i < 60; i++) L.update(0.05);
  near(((L.cur.sunAz % 360) + 360) % 360, lightPlacement('backlit', L.ctx).sunAz, 1e-6);
  assert.ok(Math.abs(L.cur.sunAz - from) <= 180 + 1e-9);
  L.setWeather('winter');
  L.update(0.5);
  assert.ok(L.cur.snowShift < 0 && L.cur.snowShift > -3300, 'snow is on its way down');
  for (let i = 0; i < 80; i++) L.update(0.05);
  assert.equal(L.cur.snowShift, -3300);
});

test('a flight ends exactly on the viewpoint and arcs high on long jumps', () => {
  const from = new CameraRig();
  from.fov = 40;
  from.set(-110.73, 43.77, 2190, 236, 4);
  const to = { lon: -151.0, lat: 63.1, h: 900, heading: 200, pitch: 3, fov: 30, lookDist: 20000 };
  const f = new Flight(from, to, { heightAt: () => 500 });
  let maxH = 0;
  while (!f.done) { f.update(1 / 30); maxH = Math.max(maxH, f.rig.lonLatH.h); }
  const end = f.rig.lonLatH, hp = f.rig.headingPitch();
  near(end.lon, to.lon, 1e-6); near(end.lat, to.lat, 1e-6); near(end.h, to.h, 1e-3);
  near(hp.heading, to.heading, 1e-6); near(hp.pitch, to.pitch, 1e-6);
  near(f.rig.fov, to.fov, 1e-6);
  const dist = distance(-110.73, 43.77, to.lon, to.lat);
  assert.ok(maxH > dist * 0.3, `peak ${maxH} for ${dist}`);
  assert.ok(f.duration > 5 && f.duration <= 8.5);
});

test('a short hop clears the ridge between two viewpoints', () => {
  const from = new CameraRig();
  from.set(-110.73, 43.77, 2190, 236, 4);
  const to = { lon: -110.9, lat: 43.74, h: 2200, heading: 60, pitch: 2, fov: 30 };
  // A 4000 m wall halfway.
  const f = new Flight(from, to, { heightAt: (lon) => (lon < -110.78 && lon > -110.85 ? 4000 : 2000) });
  let minClear = Infinity;
  while (!f.done) {
    f.update(1 / 30);
    const { lon, h } = f.rig.lonLatH;
    if (lon < -110.78 && lon > -110.85) minClear = Math.min(minClear, h - 4000);
  }
  assert.ok(minClear > 0, `clearance ${minClear}`);
});
