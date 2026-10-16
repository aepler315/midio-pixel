// The ridge rewrite (RidgeShape.js): a range is a crest spine with summits
// elevating it, not independent cones maxed against a noise floor. These
// pin the properties that actually distinguish the new silhouette from the
// old one -- each corresponds to a defect visible in the rendered field
// before the rewrite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flankProfile, flankQs, summitMass, apronMass, blurWrap, massingEnvelope,
  crenellation, couloirCarve, flankness, shapeDials,
  FLANK_Q_STEEP, FLANK_Q_SHALLOW, STEEP_WIDTH_MUL, SHALLOW_WIDTH_MUL,
} from '../src/world/RidgeShape.js';
import { ValueNoise1D } from '../src/utils/noise.js';
import { lithologyFromShares } from '../src/world/RidgePortrait.js';

test('flankProfile pins the endpoints and never leaves 0..1', () => {
  for (const q of [0.4, 0.62, 1, 1.35, 2]) {
    assert.equal(flankProfile(0, q), 1, `summit at q=${q}`);
    assert.equal(flankProfile(1, q), 0, `foot at q=${q}`);
    assert.equal(flankProfile(1.4, q), 0, 'past the foot stays 0');
    for (let d = 0; d <= 1; d += 0.05) {
      const v = flankProfile(d, q);
      assert.ok(v >= 0 && v <= 1, `q=${q} d=${d} -> ${v}`);
    }
  }
});

test('flankProfile: q<1 is pinched (a horn), q>1 bulges (a shield) -- and neither is a triangle', () => {
  // The straight-sided triangle is exactly q=1, and a row of those is what
  // the old peakProfile blend was accidentally producing.
  const d = 0.5;
  const triangle = 1 - d;
  assert.ok(flankProfile(d, 0.55) < triangle - 0.02, 'pinched side must sit BELOW the straight line');
  assert.ok(flankProfile(d, 1.35) > triangle + 0.02, 'bulging side must sit ABOVE the straight line');
  assert.ok(Math.abs(flankProfile(d, 1) - triangle) < 1e-9, 'q=1 is the triangle it must avoid');
});

test('a summit is asymmetric: one steep pinched face, one long convex slope', () => {
  const peak = { x: 0, h: 1, w: 100, flip: false };
  // dip=+1 puts the steep face on the left.
  const leftMid = summitMass(-50, peak, 1);
  const rightMid = summitMass(50, peak, 1);
  assert.ok(leftMid !== rightMid, 'the two flanks must not be mirror images');
  // The shallow side reaches further out than the steep side.
  const farSteep = summitMass(-100 * STEEP_WIDTH_MUL * 0.99, peak, 1);
  const farShallow = summitMass(100 * SHALLOW_WIDTH_MUL * 0.99, peak, 1);
  assert.ok(farSteep >= 0 && farShallow >= 0);
  assert.equal(summitMass(-100 * STEEP_WIDTH_MUL * 1.01, peak, 1), 0, 'steep flank ends sooner');
  assert.ok(summitMass(100 * STEEP_WIDTH_MUL * 1.01, peak, 1) > 0, 'shallow flank still going there');
});

test('flip reverses one summit against the regional dip', () => {
  const straight = { x: 0, h: 1, w: 100, flip: false };
  const flipped = { x: 0, h: 1, w: 100, flip: true };
  assert.ok(Math.abs(summitMass(-60, straight, 1) - summitMass(60, flipped, 1)) < 1e-9,
    'a flipped summit is the mirror of an unflipped one');
});

test('flankQs: a spiky character pinches, an organic one bulges -- and the song gets a vote', () => {
  const spiky = flankQs({ shoulder: 0.85, spire: 3.6, spireMix: 0.34 });
  const moundy = flankQs({ shoulder: 0.45, spire: 2.2, spireMix: 0.08 });
  assert.ok(spiky.steep < moundy.steep, 'spiky must pinch the steep face harder');
  assert.ok(spiky.shallow < moundy.shallow, 'spiky must flatten the bulge of the shallow face');

  // The lithology link: this is the path the song's own spectral mass takes
  // into the cross-section. It was dropped once during the rewrite (the old
  // model ran it through massProfile) and had to be put back -- so it is
  // pinned here rather than left to be silently lost again.
  const cfg = { shoulder: 0.66, spire: 2.6, spireMix: 0.2 };
  const airy = lithologyFromShares([0.1, 0.2, 0.4, 0.6, 1.0, 1.3, 1.5]);
  const bassy = lithologyFromShares([1.6, 1.4, 0.5, 0.3, 0.15, 0.08, 0.04]);
  const withAiry = flankQs(cfg, airy, 0.7);
  const withBassy = flankQs(cfg, bassy, 0.7);
  assert.ok(withAiry.steep < withBassy.steep,
    `an airy mix should pinch harder than a bassy one: ${withAiry.steep} vs ${withBassy.steep}`);
  // songMix=0 must be a true no-op, so a layer that ignores the song is
  // byte-identical to passing no lithology at all.
  assert.deepEqual(flankQs(cfg, airy, 0), flankQs(cfg));
});

test('apronMass is broad, additive-friendly, and dies at its reach', () => {
  const peak = { x: 0, h: 1, w: 100 };
  assert.ok(apronMass(0, peak, 2.5) > apronMass(120, peak, 2.5), 'falls off with distance');
  assert.equal(apronMass(260, peak, 2.5), 0, 'ends at its reach');
  assert.ok(apronMass(50, peak, 3) > apronMass(50, peak, 2), 'wider spread carries further');
});

test('blurWrap wraps circularly -- no seam in the massing envelope', () => {
  const n = 64;
  const src = new Float32Array(n);
  src[0] = 1; // a single spike at the seam
  const out = blurWrap(src, 3, 2);
  // Energy must appear on BOTH sides of the seam, not just to the right.
  assert.ok(out[n - 1] > 0, 'blur must bleed backwards across the seam');
  assert.ok(out[1] > 0, 'and forwards');
  assert.ok(Math.abs(out[n - 1] - out[1]) < 1e-6, 'symmetric across the seam');
});

test('massingEnvelope swells under a cluster of summits and never drops below its floor', () => {
  const n = 128;
  const field = new Float32Array(n);
  for (let i = 20; i < 34; i++) field[i] = 1; // one cluster
  const env = massingEnvelope(field, 0.12, 0.2, 8);
  for (const v of env) assert.ok(v >= 0.12 - 1e-6, `envelope fell through its floor: ${v}`);
  assert.ok(env[27] > env[90], 'ground must swell under the cluster and subside away from it');
  assert.ok(env[27] <= 0.12 + 0.2 + 1e-6, 'and never exceed floor + swing');
});

test('detail is anchored to relief: no relief means no texture at all', () => {
  const noise = new ValueNoise1D(5, 256);
  // This is what keeps valleys calm. Uniform noise across the tile was
  // inventing local maxima down on the flats that competed with the song's
  // real summits.
  assert.equal(crenellation(noise, 500, 0, 0.2), 0);
  assert.equal(couloirCarve(noise, 500, 0, 1, 0.2), 0);
  assert.ok(Math.abs(crenellation(noise, 500, 1, 0.2)) > 0);
});

test('couloirs only cut, never add', () => {
  const noise = new ValueNoise1D(9, 256);
  for (let x = 0; x < 3000; x += 37) {
    assert.ok(couloirCarve(noise, x, 1, 1, 0.25) >= 0, 'carve amount is subtracted by the caller, so must be >= 0');
  }
});

test('flankness peaks on slopes and falls away at both flats and apexes', () => {
  assert.ok(flankness(0) < 0.05, 'a flat is not a flank');
  const steep = flankness(0.004);
  assert.ok(steep > flankness(0.0002), 'a real slope beats a near-flat');
  assert.ok(flankness(0.02) < steep, 'and an extreme spike is not a flank either');
});

test('shapeDials keeps the envelope well clear of the summit ceiling', () => {
  // Relief -- summit height above local base -- is what makes a mountain
  // read as a mountain. An envelope that climbs near the ceiling turns the
  // whole range into rolling hills, which is exactly what one mis-tuned
  // pass of these numbers did.
  for (const basement of [0, 0.5, 1]) {
    const litho = { basement, edge: 0.3, air: 0.2 };
    const d = shapeDials({ bed: 0.22, notch: 0.2, teeth: 0.16, apronSpread: 2.6, apronCap: 0.55 }, litho);
    assert.ok(d.spineFloor + d.spineSwing < 0.5,
      `envelope tops out at ${d.spineFloor + d.spineSwing}, leaving too little relief`);
  }
});
