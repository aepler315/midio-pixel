import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECTRAL_CLASSES, sampleSpectralClass, blackbodyRGB, rgbToHue,
  sampleMagnitude, magnitudeToBrightness01, sizeForMagnitude, subPixelDraw,
  twinkleAmplitude, generateCatalogue, galacticBandCenterY, GALACTIC_BAND,
  airmass, extinction01, reddening01, generateDustLanes, generateDeepSky,
  generatePlanets, eclipticY, perceptualStretch, generateOpenClusters,
} from '../src/world/StarCatalogue.js';
import { mulberry32 } from '../src/utils/math.js';

test('spectral class frequencies are right: M dwarfs dominate, O stars are vanishingly rare', () => {
  const rand = mulberry32(1);
  const counts = {};
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const { cls } = sampleSpectralClass(rand);
    counts[cls] = (counts[cls] || 0) + 1;
  }
  // M should be the overwhelming majority (~76% in the real census).
  assert.ok((counts.M || 0) / N > 0.65, `M should dominate, got ${(counts.M || 0) / N}`);
  // O is ~0.00003 of the population -- at N=20000 it should essentially
  // never appear, and must never outnumber M.
  assert.ok((counts.O || 0) < (counts.M || 0), 'O must never outnumber M');
  // Every class in the table should show up at least once at this sample size,
  // except O which is genuinely rare enough that its expected count is < 1.
  for (const c of SPECTRAL_CLASSES) {
    if (c.cls === 'O') continue;
    assert.ok((counts[c.cls] || 0) > 0, `class ${c.cls} never sampled in ${N} draws`);
  }
});

test('blackbody color runs red -> white -> blue as temperature rises, matching real stellar colors', () => {
  const cool = blackbodyRGB(2800);  // M dwarf: should read reddish
  const mid = blackbodyRGB(5800);   // G star (sun-like): should read roughly white
  const hot = blackbodyRGB(20000);  // B star: should read blue-white

  assert.ok(cool.r > cool.b, `cool star should be redder than blue: ${JSON.stringify(cool)}`);
  assert.ok(hot.b >= hot.r, `hot star should be blue-leaning: ${JSON.stringify(hot)}`);
  // Every channel always in valid 0..255 range across the whole stellar span.
  for (const t of [2400, 3000, 5000, 5800, 7500, 10000, 20000, 52000]) {
    const { r, g, b } = blackbodyRGB(t);
    for (const ch of [r, g, b]) {
      assert.ok(Number.isFinite(ch) && ch >= 0 && ch <= 255, `channel out of range at ${t}K: ${ch}`);
    }
  }
});

test('rgbToHue is finite and in [0,360) for every sampled temperature, and 0 for a true achromatic color', () => {
  assert.equal(rgbToHue({ r: 128, g: 128, b: 128 }), 0);
  for (const t of [2400, 4000, 5800, 10000, 30000]) {
    const h = rgbToHue(blackbodyRGB(t));
    assert.ok(Number.isFinite(h) && h >= 0 && h < 360, `hue out of range at ${t}K: ${h}`);
  }
});

test('luminosity function: faint stars vastly outnumber bright ones', () => {
  const rand = mulberry32(2);
  const N = 5000;
  let bright = 0, faint = 0;
  for (let i = 0; i < N; i++) {
    const mag = sampleMagnitude(rand);
    if (mag < 1) bright++;
    if (mag > 5) faint++;
  }
  assert.ok(faint > bright * 3, `expected faint >> bright, got faint=${faint} bright=${bright}`);
});

test('magnitudeToBrightness01 is monotonically decreasing (brighter = lower magnitude = higher brightness) and follows the real 2.512x/mag relation', () => {
  const b0 = magnitudeToBrightness01(-1.2);
  const b1 = magnitudeToBrightness01(-0.2);
  const b2 = magnitudeToBrightness01(0.8);
  assert.ok(b0 > b1 && b1 > b2);
  // One magnitude fainter should be ~1/2.512 the brightness (within the clamp).
  assert.ok(Math.abs(b1 / b0 - 1 / 2.512) < 0.01, `expected ~1/2.512 ratio, got ${b1 / b0}`);
});

test('sizeForMagnitude produces genuinely sub-pixel sizes for the faint end, not clamped to >=1', () => {
  const faintSize = sizeForMagnitude(6.5);
  const brightSize = sizeForMagnitude(-1.2);
  assert.ok(faintSize < 1, `faint star should be sub-pixel, got ${faintSize}`);
  assert.ok(brightSize > faintSize);
});

test('subPixelDraw preserves total light (size^2 * alpha) instead of dropping or rounding up faint stars', () => {
  const trueLight = 0.3 * 0.3 * 0.8; // sizePx=0.3, alpha=0.8
  const { drawSize, drawAlpha } = subPixelDraw(0.3, 0.8);
  assert.equal(drawSize, 1, 'sub-pixel stars still get a real pixel to draw into');
  assert.ok(drawAlpha > 0, 'must not vanish entirely');
  assert.ok(Math.abs(drawAlpha - trueLight) < 1e-9, `expected area-preserved alpha ${trueLight}, got ${drawAlpha}`);
  // A star already >=1px is passed through unchanged.
  const passthrough = subPixelDraw(2.4, 0.6);
  assert.deepEqual(passthrough, { drawSize: 2.4, drawAlpha: 0.6 });
});

test('perceptualStretch(subPixelDraw(...).drawAlpha) preserves a wide dark-sky brightness range after frame multipliers', () => {
  const VISIBLE = 0.01; // matches BiomeManager._drawStarfield's own a<0.01 skip
  const FRAME_ALPHA = 0.48; // starfield ambient floor before twinkle/extinction
  const n = 500;
  const rand = mulberry32(7);
  let sawBelowCutoff = false;
  let sawBrightPoint = false;
  for (let i = 0; i < n; i++) {
    const mag = sampleMagnitude(rand); // real luminosity-function-weighted draw
    const brightness = magnitudeToBrightness01(mag);
    const sizePx = sizeForMagnitude(mag);
    const altitude01 = i / (n - 1);
    const twDepth = twinkleAmplitude(mag, altitude01);
    const tw = i % 2 === 0 ? (1 - twDepth) : 1;
    const drawn = perceptualStretch(subPixelDraw(sizePx, brightness).drawAlpha)
      * FRAME_ALPHA
      * tw
      * extinction01(altitude01);
    if (drawn < VISIBLE) sawBelowCutoff = true;
    if (drawn > 0.05) sawBrightPoint = true;
  }
  assert.ok(sawBelowCutoff, 'expected some faint trough/horizon stars to fall below the draw cutoff');
  assert.ok(sawBrightPoint, 'expected some brighter stars to remain well above 0.05');
});

test('perceptualStretch is monotone (preserves relative star ordering) and always returns 0.18..1', () => {
  let prev = -1;
  for (let a = 0; a <= 1; a += 0.02) {
    const s = perceptualStretch(a);
    assert.ok(s >= 0.18 - 1e-9 && s <= 1 + 1e-9, `out of range at a=${a}: ${s}`);
    assert.ok(s >= prev - 1e-9, 'must be monotone non-decreasing');
    prev = s;
  }
  assert.ok(Math.abs(perceptualStretch(0) - 0.18) < 1e-9, 'a=0 should sit exactly at the floor');
});

test('twinkle amplitude is stronger for fainter (more point-like) stars and near the horizon', () => {
  const brightZenith = twinkleAmplitude(-1, 1);
  const brightHorizon = twinkleAmplitude(-1, 0);
  const faintZenith = twinkleAmplitude(6, 1);
  const faintHorizon = twinkleAmplitude(6, 0);
  assert.ok(faintHorizon > brightHorizon, 'a faint star at the horizon should twinkle hardest');
  assert.ok(brightHorizon > brightZenith, 'the same star twinkles more near the horizon than overhead');
  assert.ok(faintZenith > brightZenith, 'a faint star twinkles more than a bright one at the same altitude');
  for (const a of [brightZenith, brightHorizon, faintZenith, faintHorizon]) {
    assert.ok(a >= 0 && a <= 1, `amplitude out of [0,1]: ${a}`);
  }
});

test('generateCatalogue is deterministic per seed', () => {
  const a = generateCatalogue(42, 200, 1280, 720);
  const b = generateCatalogue(42, 200, 1280, 720);
  assert.deepEqual(a, b);
});

test('generateCatalogue produces the requested count, all finite/bounded, positions inside the field', () => {
  const cat = generateCatalogue(7, 300, 1280, 720);
  assert.equal(cat.length, 300);
  for (const s of cat) {
    assert.ok(s.x >= 0 && s.x <= 1280);
    assert.ok(s.y >= 0 && s.y <= 720);
    assert.ok(Number.isFinite(s.mag));
    assert.ok(s.brightness >= 0 && s.brightness <= 1);
    assert.ok(s.sizePx > 0);
    assert.ok(s.hue >= 0 && s.hue < 360);
    assert.ok(s.altitude01 >= 0 && s.altitude01 <= 1);
  }
});

test('star positions are genuinely uniform, not concentrated on the galactic-plane axis', () => {
  // A previous version biased a fraction of stars toward the band -- even
  // a "gentle" bias measured a 7:1+ peak-to-edge density ratio and read as
  // stars confined to the middle of the sky. Positions are uniform now;
  // the "this is a galaxy" cue comes entirely from the separately-painted
  // milky wash and dust lanes, not from where individual stars sit.
  const cat = generateCatalogue(13, 4000, 1280, 720);
  const bandHalf = 720 * 0.08;
  let inBand = 0;
  for (const s of cat) {
    if (Math.abs(s.y - galacticBandCenterY(s.x / 1280, 720)) <= bandHalf) inBand++;
  }
  const expectedUniform = cat.length * ((bandHalf * 2) / 720);
  assert.ok(Math.abs(inBand - expectedUniform) < expectedUniform * 0.35,
    `band-axis count should track uniform density: inBand=${inBand} expected~${expectedUniform}`);
});

test('the whole sky is populated evenly -- no empty region and no band hoarding it', () => {
  // The regression this exists for: a galactic-plane bias used to take up
  // to 90% of every star into a stripe of the height, so the sky above and
  // below it was visibly empty and the field read as a belt across the
  // middle of the screen rather than as a sky.
  const cat = generateCatalogue(13, 4000, 1280, 720);
  const BANDS = 8;
  const counts = new Array(BANDS).fill(0);
  for (const s of cat) counts[Math.min(BANDS - 1, Math.floor((s.y / 720) * BANDS))]++;
  const uniform = cat.length / BANDS;
  for (let i = 0; i < BANDS; i++) {
    assert.ok(counts[i] > uniform * 0.7 && counts[i] < uniform * 1.3,
      `horizontal band ${i} has ${counts[i]} stars, expected close to the uniform ${uniform.toFixed(0)}`);
  }
});

test('the galactic plane is tilted, not a horizontal stripe', () => {
  const left = galacticBandCenterY(0, 720);
  const right = galacticBandCenterY(1, 720);
  assert.ok(Math.abs(right - left) > 720 * 0.1, 'the plane should visibly rise across the field');
  assert.ok(Math.abs(galacticBandCenterY(0.5, 720) - GALACTIC_BAND.centerFrac * 720) < 1e-6,
    'mid-field should sit exactly on the nominal center');
});

// --- Atmospheric extinction ------------------------------------------------

test('airmass is 1 overhead and rises steeply toward the horizon', () => {
  assert.ok(Math.abs(airmass(1) - 1) < 1e-9, 'the zenith is exactly one air path');
  assert.ok(airmass(0.5) > 1, 'halfway down is more air than overhead');
  assert.ok(airmass(0.1) > airmass(0.5), 'lower still is more air again');
  assert.ok(airmass(0) <= 38, 'the plane-parallel form is capped, never infinite');
});

test('extinction dims monotonically toward the horizon and never fully extinguishes', () => {
  assert.ok(Math.abs(extinction01(1) - 1) < 1e-9, 'nothing is lost at the zenith');
  let prev = extinction01(1);
  for (let a = 0.9; a >= 0; a -= 0.1) {
    const cur = extinction01(a);
    assert.ok(cur <= prev + 1e-9, `extinction must not brighten going down (at ${a})`);
    prev = cur;
  }
  assert.ok(extinction01(0) > 0, 'horizon stars thin out but do not vanish');
  assert.ok(extinction01(0) < 0.5, 'the horizon should still be a big loss');
});

test('reddening is the complement of what survives -- zero overhead, strong at the horizon', () => {
  assert.ok(Math.abs(reddening01(1)) < 1e-9);
  assert.ok(reddening01(0) > reddening01(0.5));
  for (const a of [0, 0.25, 0.5, 0.75, 1]) {
    const r = reddening01(a);
    assert.ok(r >= 0 && r <= 1, `reddening must stay in [0,1], got ${r} at ${a}`);
  }
});

// --- Dust lanes ------------------------------------------------------------

test('dust lanes are deterministic and hug the galactic plane', () => {
  const w = 1280, h = 440;
  const a = generateDustLanes(5, 8, w, h);
  assert.deepEqual(a, generateDustLanes(5, 8, w, h), 'same seed reproduces the lanes');
  assert.equal(a.length, 8);
  const half = h * GALACTIC_BAND.halfFrac;
  for (const d of a) {
    const centerY = galacticBandCenterY(d.x / w, h);
    assert.ok(Math.abs(d.y - centerY) <= half * 0.55,
      'a rift belongs to the band, not the open sky');
    assert.ok(d.rx > d.ry, 'lanes lie along the plane, not across it');
    assert.ok(d.alpha > 0 && d.alpha < 1);
  }
});

// --- Open clusters ---------------------------------------------------------

test('open clusters are compact swarms on the plane, deterministic, members in-field', () => {
  const w = 1280, h = 440;
  const a = generateOpenClusters(4, 4, w, h);
  assert.deepEqual(a, generateOpenClusters(4, 4, w, h), 'deterministic per seed');
  assert.equal(a.length, 4);
  const half = h * GALACTIC_BAND.halfFrac;
  let members = 0;
  for (const c of a) {
    members += c.members.length;
    assert.ok(c.members.length >= 11 && c.members.length <= 18);
    const off = Math.abs(c.y - galacticBandCenterY(c.x / w, h));
    assert.ok(off <= half * 0.55, `cluster center belongs to the disc, off=${off}`);
    let maxR = 0;
    for (const m of c.members) {
      assert.ok(m.x >= 0 && m.x <= w && m.y >= 0 && m.y <= h);
      assert.ok(Number.isFinite(m.mag) && m.sizePx > 0);
      maxR = Math.max(maxR, Math.hypot(m.x - c.x, m.y - c.y));
    }
    assert.ok(maxR < h * 0.08, `members should stay a compact swarm, span=${maxR}`);
  }
  assert.ok(members >= 44, `expected a visible swarm, got ${members} members`);
});

// --- Deep-sky objects ------------------------------------------------------

test('deep sky: clusters and nebulae sit on the plane, galaxies avoid it', () => {
  const w = 1280, h = 440;
  const objs = generateDeepSky(9, 12, w, h);
  assert.deepEqual(objs, generateDeepSky(9, 12, w, h), 'deterministic per seed');
  const half = h * GALACTIC_BAND.halfFrac;
  let galaxies = 0;
  for (const o of objs) {
    const off = Math.abs(o.y - galacticBandCenterY(o.x / w, h));
    if (o.kind === 'galaxy') {
      galaxies++;
      // The zone of avoidance: our own galaxy's dust hides external ones
      // anywhere near the plane, so they may only appear well clear of it.
      assert.ok(off > half, `a galaxy must sit clear of the band, off=${off} half=${half}`);
    } else {
      assert.ok(off <= half * 0.65, `${o.kind} belongs to the disc, off=${off}`);
    }
    assert.ok(o.r > 0 && o.alpha > 0);
  }
  assert.ok(galaxies > 0, 'the mix should actually contain galaxies');
});

// --- Planets ---------------------------------------------------------------

test('planets are distinct, spread out, and strung along the ecliptic', () => {
  const w = 1280, h = 440;
  const ps = generatePlanets(3, 4, w, h);
  assert.deepEqual(ps, generatePlanets(3, 4, w, h), 'deterministic per seed');
  assert.equal(ps.length, 4);
  assert.equal(new Set(ps.map((p) => p.name)).size, ps.length, 'no planet repeats');
  for (const p of ps) {
    // Near the ecliptic -- a separate axis from the galactic plane, so the
    // two structures read as independent rather than one restated.
    assert.ok(Math.abs(p.y - eclipticY(p.x / w, h)) < h * 0.06,
      'a planet should sit close to the ecliptic');
    assert.ok(p.bright > 0 && p.size > 0);
  }
});

test('the ecliptic is a different axis from the galactic plane', () => {
  const h = 440;
  const eclRise = eclipticY(1, h) - eclipticY(0, h);
  const galRise = galacticBandCenterY(1, h) - galacticBandCenterY(0, h);
  assert.ok(eclRise * galRise < 0,
    'the two planes should tilt opposite ways, not restate each other');
});

// --- Bright-star spacing (the "stars are bunched in the middle" bug) ------
//
// Positions being uniform across the whole field (the tests above) does not
// mean the field READS as evenly spread: only the brightest ~8% of a
// realistic magnitude-count population reliably clears the screen's
// visibility floor (perceptualStretch), so that sparse subset is what a
// viewer actually sees. Independent uniform placement (`rand()*w, rand()*h`
// per star) is genuinely random, but genuinely-random point sets produce
// real clumps and real gaps -- not what "evenly spread" looks like to a
// human eye. Measured against the old implementation: one seed put 9 of the
// 45 brightest stars in a 64px-wide bin holding 2.3 stars on average, with
// its two neighboring bins empty.

/** The brightest `frac` fraction of a catalogue, matching how BiomeManager
 *  itself picks the hero tier (lowest-magnitude = brightest). */
function brightestTier(cat, frac = 0.08) {
  const byMag = cat.slice().sort((a, b) => a.mag - b.mag);
  return byMag.slice(0, Math.max(1, Math.round(byMag.length * frac)));
}

test('the brightest stars -- the ones actually visible against the sky -- are spread with real minimum spacing, not clumped by chance', () => {
  const w = 1280, h = 720;
  for (const seed of [1, 42, 12345, 999]) {
    const cat = generateCatalogue(seed, 560, w, h);
    const heroes = brightestTier(cat);
    let minDist = Infinity;
    for (let i = 0; i < heroes.length; i++) {
      for (let j = i + 1; j < heroes.length; j++) {
        const d = Math.hypot(heroes[i].x - heroes[j].x, heroes[i].y - heroes[j].y);
        if (d < minDist) minDist = d;
      }
    }
    // A field this size holding ~45 hero stars has room for real spacing
    // (see the radius calibration in generateCatalogue) -- independent
    // uniform placement has no such floor and routinely lands two stars
    // within a few px of each other.
    assert.ok(minDist > 15,
      `seed ${seed}: closest pair of bright stars is only ${minDist.toFixed(1)}px apart`);
  }
});

test('bright-star density across horizontal bins has no pathological clump-next-to-gap', () => {
  const w = 1280, h = 720, bins = 20;
  for (const seed of [1, 42, 12345, 999]) {
    const cat = generateCatalogue(seed, 560, w, h);
    const heroes = brightestTier(cat);
    const counts = new Array(bins).fill(0);
    for (const s of heroes) counts[Math.min(bins - 1, Math.floor((s.x / w) * bins))]++;
    const mean = heroes.length / bins;
    const variance = counts.reduce((acc, c) => acc + (c - mean) ** 2, 0) / bins;
    // The pre-fix implementation measured variance as high as ~3.8 on this
    // exact scenario (seed 12345: a bin with 9 stars beside two with 0).
    // Blue-noise spacing on the hero tier brings every seed in well under 2.
    assert.ok(variance < 2.2, `seed ${seed}: bright-star bin variance ${variance.toFixed(2)} reads as clumpy`);
  }
});
