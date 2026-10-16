import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  energyCentroid01, profileStart01, profileRate, profileTravelPx, ridgeDepth,
  terrainPreviewStationPx, terrainScrollPx,
} from '../src/world/terrain/ProfileTravel.js';

// The far layer's old crawl: world speed 220 px/s through the 0.10 ratio.
const FAR_PARALLAX_PX_S = 22;

test('a song whose energy is up front opens on the south end', () => {
  const dur = 4000;
  const curves = { globalEnergyNorm: (ms) => (ms < 40 ? 1 : 0) };
  assert.equal(energyCentroid01(curves, dur), 0);
  assert.equal(profileStart01(curves, dur), 0);
});

test('uniform energy does not open on the south end, and a late song opens further north', () => {
  const dur = 4000;
  const even = { globalEnergyNorm: () => 0.6 };
  const late = { globalEnergyNorm: (ms) => (ms >= dur - 80 ? 1 : 0) };
  const evenStart = profileStart01(even, dur);
  const lateStart = profileStart01(late, dur);
  assert.ok(evenStart > 0.25 && evenStart < 0.4, `even ${evenStart}`);
  assert.ok(lateStart > evenStart, `late ${lateStart} should be north of ${evenStart}`);
  assert.ok(lateStart < 0.62, 'the north end is left for the trip');
  assert.equal(profileStart01(even, dur), evenStart);
  assert.equal(profileStart01(null, dur), 0);
  assert.equal(profileStart01(even, 0), 0);
});

test('the far strip does not crawl at the fixed parallax speed', () => {
  assert.ok(profileRate(0) < FAR_PARALLAX_PX_S);
  assert.ok(profileRate(0.4) > FAR_PARALLAX_PX_S);
  assert.notEqual(profileRate(1), FAR_PARALLAX_PX_S);
  const quiet = { globalEnergyNorm: () => 0 };
  const groove = { globalEnergyNorm: () => 0.4 };
  const quietPx = profileTravelPx(30, quiet);
  const groovePx = profileTravelPx(30, groove);
  assert.ok(Math.abs(quietPx - profileRate(0) * 30) < 1e-6);
  assert.ok(quietPx < FAR_PARALLAX_PX_S * 30);
  assert.ok(groovePx > FAR_PARALLAX_PX_S * 30);
  assert.ok(groovePx < profileRate(0.4) * 30);
  assert.equal(profileTravelPx(30, quiet, true), quietPx / 2);
});

test('both scanned ridges open on the song station; the nearer one then pulls ahead', () => {
  const dur = 4000;
  const curves = { globalEnergyNorm: () => 0.5 };
  const width = 8192;
  const atOpen = {
    tSec: 0, curves, durationMs: dur, stripWidth: width,
  };
  const l2 = terrainScrollPx({ ...atOpen, depth: ridgeDepth(0.10, 0.10, 0) });
  const l4 = terrainScrollPx({ ...atOpen, depth: ridgeDepth(0.30, 0.10, 0) });
  assert.ok(Math.abs(ridgeDepth(0.30, 0.10, 0) - 3) < 1e-9);
  assert.equal(l2, l4);
  assert.ok(l2 > 0, 'not the south end');
  const later = { ...atOpen, tSec: 20 };
  const l2Later = terrainScrollPx({ ...later, depth: 1 });
  const l4Later = terrainScrollPx({ ...later, depth: 3 });
  assert.ok(l4Later - l4 > (l2Later - l2) * 2.9);
  assert.ok(ridgeDepth(0.30, 0.10, 1) > 3);
});

test('travel does not jump backward when energy falls, and a seek matches playback', () => {
  const curves = { globalEnergyNorm: (ms) => (ms < 10000 ? 0.2 : 0.7) };
  const before = profileTravelPx(10, curves);
  for (let i = 1; i <= 90; i++) {
    const t = 10 + i / 60;
    const delta = profileTravelPx(t, curves) - profileTravelPx(t - 1 / 60, curves);
    assert.ok(delta > 0 && delta <= profileRate(0.4) / 60 + 1e-8, `invalid displacement ${delta}`);
  }
  assert.equal(profileTravelPx(10, curves), before);
  assert.equal(profileTravelPx(10, { ...curves }), before);
  assert.equal(profileTravelPx(-1, curves), 0);
});

test('geographic preview uses one fixed inspection station', () => {
  assert.equal(terrainPreviewStationPx(8192), 4096);
  assert.equal(terrainPreviewStationPx(NaN), 0);
});
