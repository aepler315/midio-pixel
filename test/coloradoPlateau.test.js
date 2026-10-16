// The southern-Utah shape language.
//
// An alpine flank is one continuous curve from summit to foot. That is the
// right primitive for rock built by uplift and carved by ice, and the wrong
// one for the Colorado Plateau, where flat-lying layers of alternating
// hardness erode LAYER BY LAYER. These pin the features that make the
// difference readable -- and the correctness property the first version got
// wrong twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  plateauProfile, pickFormation, varyFormation, isolationFor, spaceByIsolation,
  PLATEAU_FORMS, PLATEAU_FORM_NAMES,
} from '../src/world/ColoradoPlateau.js';

const sample = (form, n = 400) =>
  Array.from({ length: n }, (_, i) => plateauProfile(i / (n - 1), form));

test('every formation is monotonic -- a rise anywhere is a notch, not a mesa', () => {
  // The correctness property. The first version broke it twice: a dome fell
  // to 0.4 across its cap and then restarted the cliff stack at 1.0, and the
  // reef's monoclinal tilt pushed a bench below the segment after it. Both
  // read as a bite taken out of the rock.
  for (const name of PLATEAU_FORM_NAMES) {
    const h = sample(PLATEAU_FORMS[name], 2000);
    for (let i = 1; i < h.length; i++) {
      assert.ok(h[i] <= h[i - 1] + 1e-9,
        `${name} rises at ${i}: ${h[i - 1]} -> ${h[i]}`);
    }
  }
});

test('a butte is FLAT ON TOP -- the one thing an alpine flank cannot do', () => {
  // No summit, no horn, no apex. A table.
  for (const name of ['MONUMENT', 'MESA', 'STAIRCASE', 'SPIRE']) {
    const f = PLATEAU_FORMS[name];
    const atCentre = plateauProfile(0, f);
    const atCapEdge = plateauProfile(f.cap * 0.95, f);
    assert.equal(atCentre, 1, `${name} should start at full height`);
    assert.equal(atCapEdge, 1, `${name}'s caprock must be flat, got ${atCapEdge}`);
  }
});

test('the cliff is a WALL, not a steep slope', () => {
  // A Monument Valley face is within a few degrees of plumb. In profile that
  // means most of the formation's height is given up over a tiny fraction of
  // its width -- and that ratio is what makes it read as rock rather than as
  // a hill.
  const f = PLATEAU_FORMS.MONUMENT;
  const h = sample(f, 4000);
  let steepest = 0;
  for (let i = 1; i < h.length; i++) steepest = Math.max(steepest, (h[i - 1] - h[i]) * h.length);
  assert.ok(steepest > 6, `the cliff should be near-vertical, steepest slope was ${steepest}`);
});

test('a talus apron sits at the foot, shallower than the cliff above it', () => {
  const f = PLATEAU_FORMS.MONUMENT;
  const cliffSlope = (plateauProfile(f.cap + 0.01, f) - plateauProfile(f.cap + f.cliff, f)) / f.cliff;
  const talusStart = 1 - f.talus;
  const talusSlope = (plateauProfile(talusStart + 0.02, f) - plateauProfile(0.99, f)) / (0.97 - f.talus);
  assert.ok(cliffSlope > talusSlope * 2,
    `the break from wall to debris fan should be abrupt: ${cliffSlope} vs ${talusSlope}`);
  assert.equal(plateauProfile(1, f), 0, 'and it reaches the floor');
});

test('a staircase has more storeys than a monument', () => {
  // Cliff-bench-cliff-bench is the Grand Staircase in cross-section, and it
  // is why these read as architecture rather than as a hillside. Count the
  // near-flat runs.
  const shelves = (form) => {
    const h = sample(form, 3000);
    let count = 0, run = 0;
    for (let i = 1; i < h.length; i++) {
      const drop = h[i - 1] - h[i];
      if (drop < 0.0004) run++;
      else { if (run > 25) count++; run = 0; }
    }
    if (run > 25) count++;
    return count;
  };
  assert.ok(shelves(PLATEAU_FORMS.STAIRCASE) > shelves(PLATEAU_FORMS.MONUMENT),
    'the staircase should show more shelves');
});

test('a dome is rounded where the others are flat -- Capitol Dome', () => {
  const d = PLATEAU_FORMS.DOME;
  const crown = plateauProfile(0, d);
  const rim = plateauProfile(d.cap * 0.95, d);
  assert.equal(crown, 1);
  assert.ok(rim < 0.98, `a dome must curve across its cap, got ${rim}`);
  // ...but still stands on a cliff band rather than replacing one.
  assert.ok(plateauProfile(d.cap + d.cliff, d) < rim - 0.05, 'the cliff below it survives');
});

test('the reef leans -- the Waterpocket Fold is a monocline', () => {
  // Its storeys are not evenly stacked: later ones give up more height.
  const f = PLATEAU_FORMS.REEF;
  const flat = { ...f, tilt: 0 };
  const h1 = sample(f, 1500), h0 = sample(flat, 1500);
  let differs = 0;
  for (let i = 0; i < h1.length; i++) if (Math.abs(h1[i] - h0[i]) > 0.005) differs++;
  assert.ok(differs > 60, `tilt should visibly reshape the stack, ${differs} samples differed`);
  assert.ok(f.tilt > 0, 'and the reef is the form that carries it');
});

test('Monument Valley stands apart -- the empty floor is the read', () => {
  // Buttes that touch are a mountain range. The isolation IS the landscape.
  assert.ok(isolationFor(PLATEAU_FORMS.MONUMENT) > isolationFor(PLATEAU_FORMS.MESA));
  assert.ok(isolationFor(PLATEAU_FORMS.MONUMENT) > 2, 'monuments want real space around them');
  assert.ok(isolationFor(PLATEAU_FORMS.REEF) < 1.5, 'a reef is continuous by definition');
});

test('formation choice is song-driven and deterministic', () => {
  // The lithology decides what a section LEANS toward, not what it is limited
  // to. The first version branched instead of weighting -- `if (crest > 0.62)
  // return r < 0.55 ? MONUMENT : SPIRE` -- and because lithology is constant
  // across a section, every summit in it drew from the same two forms. That
  // is why the country read as a row of trapezoids. So these assert the
  // FAMILY, which is the real intent; pinning two names is what enforced the
  // sameness.
  const fixed = () => 0.5;
  assert.equal(pickFormation(fixed, { crest: 0.9 }), pickFormation(fixed, { crest: 0.9 }),
    'same inputs must build the same country');

  // The lean is DISTRIBUTIONAL, so it has to be measured over the
  // distribution. Asserting what a single fixed r returns tests the order of
  // the weight list, not the weighting -- adding a form anywhere above the
  // one being checked moves the answer without changing the behaviour at all.
  const share = (opts, family) => {
    let n = 0;
    for (let i = 0; i < 500; i++) {
      if (pickFormation(() => (i + 0.5) / 500, opts).family === family) n++;
    }
    return n / 500;
  };
  const bright = { crest: 0.9, foot: 0.2, spiky: 0.8 };
  const bassy = { crest: 0.2, foot: 0.9, spiky: 0.2 };
  // A bright, high-crest section erodes down to towers.
  assert.ok(share(bright, 'tower') > share(bassy, 'tower'),
    'a bright section should lean toward towers');
  // A bass-heavy one leaves broad layered tables.
  assert.ok(share(bassy, 'table') > share(bright, 'table'),
    'a bass-heavy section should lean toward tables');
  // A leaning section reefs.
  assert.equal(pickFormation(() => 0.1, { tilt: 0.8 }), PLATEAU_FORMS.REEF);
});

test('a section reaches many formations, not two', () => {
  // The regression that matters for how this looks on screen. One section
  // means one lithology, so if the choice is a branch on lithology every
  // summit in view is one of two shapes.
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const r = () => (i + 0.5) / 200;
    seen.add(pickFormation(r, { crest: 0.7, foot: 0.4, spiky: 0.6 }));
  }
  assert.ok(seen.size >= 6,
    `a single section should reach many landforms, only found ${seen.size}`);
});

test('the vocabulary is skeletons, not one skeleton with parameters', () => {
  // A row of trapezoids is what you get when every form is a caprock over a
  // cliff stack. Domes, cones, badlands and towers are different FUNCTIONS.
  const kinds = new Set(PLATEAU_FORM_NAMES.map((n) => PLATEAU_FORMS[n].kind));
  assert.ok(kinds.size >= 5, `expected several distinct skeletons, got ${[...kinds].join(', ')}`);
});

test('width and height vary as much as shape does', () => {
  // Two formations with different cross-sections still read as the same
  // object if they are drawn the same width and the same height.
  const widths = PLATEAU_FORM_NAMES.map((n) => PLATEAU_FORMS[n].widthMul);
  const heights = PLATEAU_FORM_NAMES.map((n) => PLATEAU_FORMS[n].heightMul);
  // Around 7x. Not the real geology -- a true fin is a hundred times longer
  // than it is thick -- because drawn honestly at this scale a fin is one
  // pixel across and reads as a render artifact rather than as rock. See the
  // module header: this is the one place the vocabulary knowingly lies.
  assert.ok(Math.max(...widths) / Math.min(...widths) > 5,
    'a fin and a mesa must not be the same width');
  // The desert floor is genuinely low -- that is the point of it, and the
  // reason the dramatic rock reads as dramatic. So the spread is wide and
  // there is no floor under it.
  assert.ok(Math.max(...heights) / Math.min(...heights) > 4,
    'the desert floor and a laccolith must not be the same height');
  // What the field actually needs is enough TALL forms that a random draw
  // still spans its range. An earlier version enforced this with a floor
  // under every form, which is what left the region with no low country.
  const tall = heights.filter((h) => h > 0.55).length;
  assert.ok(Math.max(...heights) === 1, 'the tallest form anchors the ceiling');
  assert.ok(tall >= heights.length / 3,
    `a third of forms should be tall enough to carry a skyline, only ${tall} are`);
});

test('a laccolith is a mountain: rounded summit, no flat top, no cliff band', () => {
  // The Henry Mountains are 11,000ft and look nothing like a butte. This is
  // the one silhouette the butte vocabulary cannot approximate.
  const f = PLATEAU_FORMS.LACCOLITH;
  assert.equal(plateauProfile(0, f), 1);
  assert.ok(plateauProfile(0.04, f) > 0.995, 'the summit is rounded, not a cusp');
  assert.ok(plateauProfile(0.5, f) < 0.85 && plateauProfile(0.5, f) > 0.5, 'steep flanks');
  // No shelf on the FLANKS: a mountain has no bench to stand on. The crown
  // itself is excluded, because a rounded summit has near-zero slope by
  // definition -- that is what makes it rounded, not a bench.
  let flatRuns = 0, run = 0;
  const h = sample(f, 2000);
  for (let i = Math.floor(h.length * 0.15); i < h.length; i++) {
    if (h[i - 1] - h[i] < 0.0002) run++; else { if (run > 40) flatRuns++; run = 0; }
  }
  assert.equal(flatRuns, 0, 'a laccolith has no benches on its flanks');
});

test('a tower spends its height immediately below the cap', () => {
  // What makes a hoodoo a column rather than a cone: the wall.
  const f = PLATEAU_FORMS.NEEDLE;
  const belowCap = plateauProfile(f.cap + 0.001, f);
  const quarterOut = plateauProfile(f.cap + (1 - f.cap) * 0.25, f);
  assert.ok(belowCap > 0.9, 'still full height just under the cap');
  assert.ok(quarterOut < 0.55,
    `a quarter of the way down the wall it should have lost most of its height, got ${quarterOut}`);
});

test('varying a formation keeps it monotonic and keeps its family', () => {
  // Per-summit jitter must not be able to bite a notch out of the rock.
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const name of PLATEAU_FORM_NAMES) {
    for (let k = 0; k < 25; k++) {
      const v = varyFormation(PLATEAU_FORMS[name], rand);
      assert.equal(v.kind, PLATEAU_FORMS[name].kind, `${name} changed skeleton`);
      assert.equal(v.family, PLATEAU_FORMS[name].family);
      const h = sample(v, 1200);
      for (let i = 1; i < h.length; i++) {
        assert.ok(h[i] <= h[i - 1] + 1e-9, `varied ${name} rises at ${i}`);
      }
    }
  }
});

test('varying actually varies -- no two summits are the same rock', () => {
  let seed = 11;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const widths = new Set();
  for (let i = 0; i < 30; i++) widths.add(varyFormation(PLATEAU_FORMS.MESA, rand).widthMul);
  assert.ok(widths.size > 25, 'each summit should get its own copy');
});

test('spikiness chooses towers over tables -- the shape grammar still reaches the rock', () => {
  // Under the alpine model this bent a superellipse exponent. There is no
  // exponent here, so it has to choose the FORMATION instead -- and if it
  // does not, spireMixAdd stops reaching the height field entirely.
  const towerish = (f) => f === PLATEAU_FORMS.MONUMENT || f === PLATEAU_FORMS.SPIRE;
  let spikyTowers = 0, organicTowers = 0;
  for (let i = 0; i < 40; i++) {
    const r = () => (i + 0.5) / 40;
    if (towerish(pickFormation(r, { spiky: 1 }))) spikyTowers++;
    if (towerish(pickFormation(r, { spiky: 0 }))) organicTowers++;
  }
  assert.ok(spikyTowers > organicTowers,
    `a spiky song should erode to towers: ${spikyTowers} vs ${organicTowers}`);
});

test('degenerate input never throws or escapes 0..1', () => {
  for (const name of PLATEAU_FORM_NAMES) {
    for (const d of [-1, 0, 0.5, 1, 2, NaN]) {
      const h = plateauProfile(d, PLATEAU_FORMS[name]);
      assert.ok(Number.isFinite(h) && h >= 0 && h <= 1, `${name} at d=${d}: ${h}`);
    }
  }
  assert.ok(Number.isFinite(plateauProfile(0.5, null)), 'a missing form falls back');
});

test('no form overshoots the height ceiling', () => {
  // Anything above 1 is resolved by clamp01 in the height field, which saws
  // the tops off exactly the formations that most need them -- the same bug
  // silhouetteAlpine's "summits are not clipped into flat-topped mesas"
  // exists to catch. Caught by that test when LACCOLITH was first given a
  // heightMul of 1.48.
  let seed = 3;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const name of PLATEAU_FORM_NAMES) {
    assert.ok(PLATEAU_FORMS[name].heightMul <= 1,
      `${name} would clip at ${PLATEAU_FORMS[name].heightMul}`);
    for (let k = 0; k < 40; k++) {
      assert.ok(varyFormation(PLATEAU_FORMS[name], rand).heightMul <= 1,
        `${name} clips once varied`);
    }
  }
});

test('spacing follows the landform, not a constant', () => {
  // The composition half of the region's character, and the half the shape
  // vocabulary alone cannot carry. Monument Valley is as much about the empty
  // floor as about the rock; Bryce is the opposite. Until this, every summit
  // stood the same distance from its neighbours whatever it was.
  // Started CROWDED, in a tile with room to spread. Laying them out evenly
  // across a wide tile proves nothing: both landforms are then already
  // further apart than either claims, so neither pushes and the two come out
  // identical -- which is exactly what the first version of this test
  // measured.
  const mk = (form, n) => Array.from({ length: n }, (_, i) => ({
    x: 100 + i * 12, w: 40, form,
  }));
  const spread = (peaks, width) => {
    const xs = peaks.map((p) => p.x).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 0; i < xs.length; i++) {
      const d = i === xs.length - 1 ? width - xs[i] + xs[0] : xs[i + 1] - xs[i];
      gaps.push(d);
    }
    return Math.min(...gaps);
  };
  const W = 2048;
  const monuments = spaceByIsolation(mk(PLATEAU_FORMS.MONUMENT, 8), W);
  const hoodoos = spaceByIsolation(mk(PLATEAU_FORMS.HOODOO, 8), W);
  assert.ok(spread(monuments, W) > spread(hoodoos, W) * 1.5,
    `monuments must stand further apart than hoodoos: ${spread(monuments, W)} vs ${spread(hoodoos, W)}`);
});

test('spacing wraps, because the strip tiles', () => {
  // Two summits either side of the seam are neighbours. A version that
  // forgot that would leave a permanent crowd at x=0 -- and the seam is the
  // one place the eye is guaranteed to keep seeing, since it scrolls past on
  // every repeat.
  const W = 1000;
  const peaks = [{ x: 5, w: 60, form: PLATEAU_FORMS.MONUMENT },
    { x: 995, w: 60, form: PLATEAU_FORMS.MONUMENT }];
  spaceByIsolation(peaks, W);
  const half = W / 2;
  const wrapDx = (d) => (d > half ? d - W : d < -half ? d + W : d);
  assert.ok(Math.abs(wrapDx(peaks[1].x - peaks[0].x)) > 20,
    'summits straddling the seam should have been pushed apart');
});

test('spacing keeps every summit inside the tile', () => {
  const W = 800;
  const peaks = Array.from({ length: 10 }, (_, i) => ({
    x: 400 + i, w: 50, form: PLATEAU_FORMS.MONUMENT,
  }));
  spaceByIsolation(peaks, W);
  for (const p of peaks) {
    assert.ok(p.x >= 0 && p.x < W, `x escaped the tile: ${p.x}`);
    assert.ok(Number.isFinite(p.x));
  }
});

test('spacing is a no-op on degenerate input', () => {
  assert.deepEqual(spaceByIsolation([], 100), []);
  assert.equal(spaceByIsolation(null, 100), null);
  const one = [{ x: 5, w: 10, form: PLATEAU_FORMS.MESA }];
  assert.equal(spaceByIsolation(one, 0)[0].x, 5, 'a zero-width tile changes nothing');
});
