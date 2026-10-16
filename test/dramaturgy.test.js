import { test } from 'node:test';
import assert from 'node:assert/strict';
import { castBiomes, classifyTransition, intensityBudget, dayArc, BIOME_TEMPERATURE } from '../src/world/Dramaturgy.js';

const COLD = new Set(['ARCTIC', 'MIRROR', 'SAKURA', 'TWILIGHT']);
const HOT = new Set(['CYBER', 'EMBER', 'SOLAR']);

test('castBiomes sends the extremes to matching biomes and orders the middle by temperature', () => {
  const cast = castBiomes([0.05, 0.95, 0.1, 0.9], 7);
  assert.equal(cast.length, 4);
  // The coldest and hottest sections must land squarely in their bands;
  // mid sections may wander within the seeded jitter, but their biome
  // temperatures must still respect the sections' energy ordering.
  assert.ok(COLD.has(cast[0]), `coldest section got ${cast[0]}`);
  assert.ok(HOT.has(cast[1]), `hottest section got ${cast[1]}`);
  assert.ok(BIOME_TEMPERATURE[cast[2]] < BIOME_TEMPERATURE[cast[3]],
    `cold-ish (${cast[2]}) must cast cooler than hot-ish (${cast[3]})`);
});

test('castBiomes never repeats a biome back to back, and always returns valid names', () => {
  const energies = Array.from({ length: 24 }, (_, i) => 0.5 + 0.5 * Math.sin(i));
  const cast = castBiomes(energies, 3);
  for (let i = 0; i < cast.length; i++) {
    assert.ok(cast[i] in BIOME_TEMPERATURE);
    if (i > 0) assert.notEqual(cast[i], cast[i - 1]);
  }
  assert.deepEqual(castBiomes([], 1), []);
});

test('classifyTransition: the strongest effect goes to the strongest boundary', () => {
  // The ladder used to run cut / shutter / fade downward, which had it
  // backwards -- `cut` is a brief 0.35-alpha flash while `shutter` closes the
  // screen for a whole bar, so the mildest visual sat on the sharpest musical
  // turn and the most violent one on merely-moderate turns.
  assert.equal(classifyTransition(0.9, 1), 'shutter', 'a sharp turn earns the shutter');
  assert.equal(classifyTransition(0.5, 1), 'cut', 'a moderate one gets the flash');
  assert.equal(classifyTransition(0.1, 1), 'fade');
  assert.equal(classifyTransition(0.5, 0), 'fade'); // degenerate maxNovelty
});

test('the shutter is the rarest style -- most boundaries never earn one', () => {
  // Sharpness is normalized against the song's own strongest turn, so a
  // uniform sweep is a fair stand-in for "boundaries across a whole song".
  const styles = [];
  for (let s = 0; s <= 1.0001; s += 0.02) styles.push(classifyTransition(s, 1));
  const shutters = styles.filter((x) => x === 'shutter').length;
  assert.ok(shutters / styles.length < 0.28, `shutter should stay rare, got ${shutters}/${styles.length}`);
  assert.ok(shutters > 0, 'but it must still be reachable');
});

test('intensityBudget stages the show: restrained start, full middle, bounded finale', () => {
  const start = intensityBudget(0);
  const mid = intensityBudget(0.5);
  const end = intensityBudget(1);
  assert.ok(start >= 0.35 && start < 0.6, `intro too loud/quiet: ${start}`);
  assert.ok(mid > 0.95, `mid-song should be full: ${mid}`);
  assert.ok(end <= 1 + 1e-9);
  let prev = -1;
  for (let p = 0; p <= 0.5; p += 0.02) {
    const b = intensityBudget(p);
    assert.ok(b >= prev - 1e-9, 'budget must ramp monotonically through the intro');
    prev = b;
  }
});

test('dayArc: sun climbs to zenith mid-song; dawn and dusk tints stay at their own ends', () => {
  const dawn = dayArc(0), noon = dayArc(0.5), dusk = dayArc(1);
  assert.ok(noon.celestialYFrac < dawn.celestialYFrac, 'zenith must sit higher (smaller y) than dawn');
  assert.ok(noon.celestialYFrac < dusk.celestialYFrac);
  assert.ok(dawn.dawn.alpha > 0.1);
  assert.equal(noon.dawn.alpha, 0);
  assert.equal(noon.dusk.alpha, 0);
  assert.ok(dusk.dusk.alpha > 0.15);
});

test('dayArc hazeWarm peaks at both ends of the song and dips at zenith', () => {
  assert.ok(dayArc(0).hazeWarm > 0.9);
  assert.ok(dayArc(1).hazeWarm > 0.9);
  assert.ok(dayArc(0.5).hazeWarm < 0.05);
  let prev = dayArc(0).hazeWarm;
  for (let p = 0.02; p <= 0.35; p += 0.02) {
    const v = dayArc(p).hazeWarm;
    assert.ok(v <= prev + 1e-9, `hazeWarm must fall monotonically approaching zenith, p=${p}`);
    prev = v;
  }
  prev = dayArc(0.65).hazeWarm;
  for (let p = 0.67; p <= 1; p += 0.02) {
    const v = dayArc(p).hazeWarm;
    assert.ok(v >= prev - 1e-9, `hazeWarm must rise monotonically past zenith, p=${p}`);
    prev = v;
  }
});
