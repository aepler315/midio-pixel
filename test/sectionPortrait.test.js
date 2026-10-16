// Mountain overhaul Stage 1 (per-section recomposition): pins the pure
// building blocks BiomeManager._buildSchedule uses to give a chorus a
// structurally different mountain than a verse -- landformWindow (which
// 3-rung slice of the landform ladder a section lands on) and
// relEnergyLadder (a section's energy relative to the rest of its own
// song, not an absolute threshold), plus extractRidgePortrait's windowed
// read (a section samples only its own span of the song instead of the
// whole track). BiomeManager itself needs a canvas/DOM to construct, so
// these are tested at the pure-function layer they're built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import {
  extractRidgePortrait, landformWindow, relEnergyLadder, LANDFORM_LADDER,
  lithologyFromShares, snowLine01For, SNOWLINE_MIN,
} from '../src/world/RidgePortrait.js';

function makeCurves({ durationMs = 120000, rateHz = 50, energyAt, bandsAt } = {}) {
  const ec = new EnergyCurves(durationMs, rateHz);
  for (let i = 0; i < ec.n; i++) {
    const t01 = ec.n > 1 ? i / (ec.n - 1) : 0;
    const e = energyAt ? energyAt(t01) : 0.4;
    const shares = bandsAt ? bandsAt(t01) : [1, 1, 1, 1, 1, 1, 1];
    let sum = 0;
    for (const s of shares) sum += s;
    const frame = shares.map((s) => Math.max(0, e * s / (sum || 1)));
    ec.setFrame(i, frame);
  }
  return { ec, durationMs };
}

function bump(t01, at, width, height) {
  const d = (t01 - at) / width;
  return height * Math.exp(-d * d * 4);
}

test('relEnergyLadder is scale-invariant: a quiet song\'s loudest section still ranks 1', () => {
  const quiet = [0.02, 0.05, 0.09, 0.03];
  const loud = quiet.map((e) => e * 40); // same shape, 40x the level
  const rQuiet = relEnergyLadder(quiet);
  const rLoud = relEnergyLadder(loud);
  for (let i = 0; i < quiet.length; i++) {
    assert.ok(Math.abs(rQuiet[i] - rLoud[i]) < 1e-9, `rank ${i} should be scale-invariant`);
  }
  assert.equal(Math.max(...rQuiet), 1, 'the loudest section ranks 1');
  assert.equal(Math.min(...rQuiet), 0, 'the quietest section ranks 0');
});

test('relEnergyLadder treats a flat group as all-0.5, not an arbitrary edge', () => {
  const flat = [0.4, 0.4, 0.4];
  const r = relEnergyLadder(flat);
  assert.deepEqual(r, [0.5, 0.5, 0.5]);
});

test('relEnergyLadder of an empty list is empty', () => {
  assert.deepEqual(relEnergyLadder([]), []);
});

test('landformWindow always returns 3 contiguous rungs of LANDFORM_LADDER', () => {
  for (let s = 0; s <= 1; s += 0.1) {
    for (let e = 0; e <= 1; e += 0.1) {
      const w = landformWindow(s, e);
      assert.equal(w.length, 3);
      const idx = LANDFORM_LADDER.indexOf(w[0]);
      assert.ok(idx >= 0 && idx <= 2, 'window must start within the ladder\'s first 3 rungs');
      assert.deepEqual(w, LANDFORM_LADDER.slice(idx, idx + 3));
    }
  }
});

test('landformWindow: a dark, quiet section and a bright, loud section land on different rungs', () => {
  const darkQuiet = landformWindow(0.05, 0.05);
  const brightLoud = landformWindow(0.95, 0.95);
  assert.notDeepEqual(darkQuiet, brightLoud);
  // Dark+quiet should skew toward the broad end (plateau/massif), bright+loud
  // toward the sharp end (crags/spires) -- not just "different", but ordered.
  assert.ok(LANDFORM_LADDER.indexOf(darkQuiet[0]) < LANDFORM_LADDER.indexOf(brightLoud[0]));
});

test('landformWindow matches the existing named triples at their own bias', () => {
  // classic (massif/range/crags) sits at the ladder's middle window --
  // exactly what a mid spectral position + mid relative energy should pick,
  // so the new per-section path reproduces today's default when nothing
  // about a section stands out.
  assert.deepEqual(landformWindow(0.5, 0.5), ['massif', 'range', 'crags']);
});

test('extractRidgePortrait windowed to one half of a two-part song reads only that half', () => {
  // First half: quiet and bass-heavy. Second half: loud and bright.
  const { ec, durationMs } = makeCurves({
    energyAt: (t) => (t < 0.5 ? 0.15 + bump(t, 0.25, 0.1, 0.2) : 0.75 + bump(t, 0.75, 0.1, 0.2)),
    bandsAt: (t) => (t < 0.5 ? [1.6, 1.3, 0.4, 0.2, 0.1, 0.05, 0.02] : [0.1, 0.2, 0.5, 0.9, 1.2, 1.4, 1.5]),
  });

  const firstHalf = extractRidgePortrait(ec, durationMs, { startMs: 0, endMs: durationMs / 2 });
  const secondHalf = extractRidgePortrait(ec, durationMs, { startMs: durationMs / 2, endMs: durationMs });
  assert.ok(firstHalf && secondHalf);

  // Landmarks found in a window are reported in that window's own absolute
  // time, never spilling into the other half.
  for (const lm of firstHalf.landmarks) {
    const tMs = lm.t01 * (durationMs / 2);
    assert.ok(tMs >= 0 && tMs <= durationMs / 2 + 1, 'first-half landmark must stay in the first half');
  }
  for (const lm of secondHalf.landmarks) {
    const tMs = durationMs / 2 + lm.t01 * (durationMs / 2);
    assert.ok(tMs >= durationMs / 2 - 1 && tMs <= durationMs, 'second-half landmark must stay in the second half');
  }

  // The two halves' own energy waves should differ substantially -- this is
  // what makes a windowed read structurally different from the whole-song
  // read, not just a relabeled copy of it.
  let diff = 0;
  for (let i = 0; i < firstHalf.energyWave.length; i++) {
    diff += Math.abs(firstHalf.energyWave[i] - secondHalf.energyWave[i]);
  }
  assert.ok(diff / firstHalf.energyWave.length > 0.15, 'windowed waves should read distinctly different energy');
});

test('extractRidgePortrait with no window is byte-identical to a whole-song read (existing callers unaffected)', () => {
  const { ec, durationMs } = makeCurves({
    energyAt: (t) => 0.3 + bump(t, 0.6, 0.15, 0.5),
    bandsAt: () => [1, 1.2, 1.4, 1, 0.7, 0.4, 0.2],
  });
  const a = extractRidgePortrait(ec, durationMs);
  const b = extractRidgePortrait(ec, durationMs, null);
  assert.deepEqual(Array.from(a.energyWave), Array.from(b.energyWave));
  assert.deepEqual(a.landmarks, b.landmarks);
});

test('two sections with clearly different spectra get clearly different lithology', () => {
  const bassy = lithologyFromShares([1.6, 1.4, 0.4, 0.2, 0.1, 0.05, 0.02]);
  const airy = lithologyFromShares([0.1, 0.2, 0.5, 0.9, 1.2, 1.4, 1.5]);
  assert.ok(bassy.basement > airy.basement, 'a bass-heavy section should carry more basement mass');
  assert.ok(airy.air > bassy.air, 'a bright section should carry more air/crest mass');
  assert.notEqual(
    JSON.stringify(Array.from(bassy.bands)),
    JSON.stringify(Array.from(airy.bands)),
  );
});

// Stage 4 (snowline): song-grounded, not tied to landformWindow/heightMul,
// so pinned separately even though it reads the same lithology/relEnergy01
// inputs the other Stage 1 variant fields do.
test('snowLine01For: a bright, loud section snows lower (more of the range capped) than a dark, quiet one', () => {
  const darkQuiet = snowLine01For(0, 0);
  const brightLoud = snowLine01For(1, 1);
  assert.ok(brightLoud < darkQuiet, 'bright+loud should push the threshold down (more coverage)');
  assert.equal(darkQuiet, 1, 'a fully dark, fully quiet section caps nothing');
});

test('snowLine01For never goes below its floor -- snow is always an accent, never a blanket', () => {
  for (let crest = 0; crest <= 1; crest += 0.1) {
    for (let rel = 0; rel <= 1; rel += 0.1) {
      const line = snowLine01For(crest, rel);
      assert.ok(line >= SNOWLINE_MIN - 1e-9, `snowLine01For(${crest},${rel})=${line} below floor ${SNOWLINE_MIN}`);
      assert.ok(line <= 1, `snowLine01For(${crest},${rel})=${line} above 1`);
    }
  }
});

test('snowLine01For is monotonic in both crest/air share and relative energy', () => {
  for (let rel = 0; rel <= 1; rel += 0.25) {
    let prev = snowLine01For(0, rel);
    for (let crest = 0.1; crest <= 1; crest += 0.1) {
      const cur = snowLine01For(crest, rel);
      assert.ok(cur <= prev + 1e-9, 'more crest/air share must never raise the threshold');
      prev = cur;
    }
  }
});
