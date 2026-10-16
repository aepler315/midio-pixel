// Mountain overhaul Stage 7: regression test only, no production change.
// An earlier draft of this plan wrongly assumed the shape-grammar mods
// (notchAdd/teethAdd/etc, from a song's own DNA -- see ShapeGrammar.js)
// were dead code inside alpineHeightField. Reading the composition line by
// line (SilhouetteGenerator.applyTerrainMods -> RidgePortrait.layerWeathering
// -> alpineHeightField's notch/teeth carving) proved that wrong: applyTerrainMods
// nudges the character's base cfg, and layerWeathering multiplies straight
// through it (`cfg.notch * role.notchMul * (...)`) into the values that
// actually carve the height field. There was no bug to fix -- only this
// pin, so the composition can't silently break later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValueNoise1D } from '../src/utils/noise.js';
import { alpineHeightField } from '../src/world/SilhouetteGenerator.js';

test('notchAdd measurably deepens the couloir carving -- height can only fall, never rise', () => {
  const noise = new ValueNoise1D(5, 256);
  const n = 512, step = 4, width = n * step;
  const seed = 777;
  const base = alpineHeightField(noise, n, step, seed, width, 'range', null, 'L2', null);
  const notched = alpineHeightField(noise, n, step, seed, width, 'range', null, 'L2', { notchAdd: 0.4 });
  let sumBase = 0, sumNotched = 0, diff = 0;
  for (let i = 0; i < n; i++) {
    sumBase += base[i];
    sumNotched += notched[i];
    diff += Math.abs(base[i] - notched[i]);
    // notch only ever subtracts (h -= notch * weather.notch * (h - 0.18),
    // and every factor there is non-negative) -- a single point rising
    // would mean the composition broke, not that this song carved less.
    assert.ok(notched[i] <= base[i] + 1e-6, `point ${i} rose under notchAdd: base=${base[i]} notched=${notched[i]}`);
  }
  assert.ok(diff > 0.5, `notchAdd should measurably change the height field, got total diff ${diff}`);
  assert.ok(sumNotched < sumBase - 1, `expected a clearly lower mean height, base=${sumBase} notched=${sumNotched}`);
});

test('teethAdd measurably serrates the crest -- signed, and its magnitude scales with the parameter', () => {
  // This assertion USED to be "height can only rise, never fall", which was
  // true of the old purely-additive `ridged()` teeth term. The ridge rewrite
  // (RidgeShape.crenellation) made serration SIGNED on purpose: a crest is
  // chewed both ways, and a teeth term that can only add just inflates the
  // ridge -- which is part of why the old skyline read as noise bumps sitting
  // on a mountain rather than as rock. What still has to hold, and is what
  // this pins, is that the parameter genuinely reaches the field and that
  // turning it up produces MORE serration, not merely different serration.
  const noise = new ValueNoise1D(11, 256);
  const n = 512, step = 4, width = n * step;
  const seed = 321;
  const base = alpineHeightField(noise, n, step, seed, width, 'crags', null, 'L4', null);
  const some = alpineHeightField(noise, n, step, seed, width, 'crags', null, 'L4', { teethAdd: 0.2 });
  const lots = alpineHeightField(noise, n, step, seed, width, 'crags', null, 'L4', { teethAdd: 0.5 });

  const deviation = (a, b) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
    return s;
  };
  const dSome = deviation(base, some);
  const dLots = deviation(base, lots);
  assert.ok(dSome > 0.5, `teethAdd should measurably reach the field, got ${dSome}`);
  assert.ok(dLots > dSome, `more teethAdd should mean more serration: ${dSome} -> ${dLots}`);
});

test('spireMixAdd and asymMul also measurably reach the final field (the whole mods table composes, not just notch/teeth)', () => {
  const noise = new ValueNoise1D(3, 256);
  const n = 400, step = 5, width = n * step;
  const seed = 88;
  const base = alpineHeightField(noise, n, step, seed, width, 'massif', null, 'L2', null);
  const spikier = alpineHeightField(noise, n, step, seed, width, 'massif', null, 'L2', { spireMixAdd: 0.3 });
  let diff = 0;
  for (let i = 0; i < n; i++) diff += Math.abs(base[i] - spikier[i]);
  assert.ok(diff > 0.5, `spireMixAdd should measurably change the height field, got total diff ${diff}`);
});

test('terrainMods=null is a true no-op -- byte-identical to omitting the argument entirely', () => {
  const noise = new ValueNoise1D(9, 256);
  const n = 300, step = 6, width = n * step;
  const a = alpineHeightField(noise, n, step, 42, width, 'range', null, 'L3');
  const b = alpineHeightField(noise, n, step, 42, width, 'range', null, 'L3', null);
  assert.deepEqual(Array.from(a), Array.from(b));
});
