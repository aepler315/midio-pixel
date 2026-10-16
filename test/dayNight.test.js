import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleMs, dayNight, celestialYFracFor, horizonFade,
  celestialXFracFor, sunScreenFrac, cyclePhase01,
  CELESTIAL_RISE_XFRAC, CELESTIAL_SET_XFRAC,
  CELESTIAL_GAP, SUN_SET_PHASE, MOON_SET_PHASE,
} from '../src/world/DayNight.js';

// Each body's zenith is the midpoint of ITS OWN arc, which the gaps move off
// the quarter marks. Derived rather than hard-coded, so the constants stay
// the single source of truth.
const SUN_ZENITH_P = SUN_SET_PHASE / 2;
const MOON_ZENITH_P = (0.5 + MOON_SET_PHASE) / 2;
import { OCEAN_HORIZON_FRAC } from '../src/world/Ocean.js';

test('cycleMs guarantees at least two full cycles for songs long enough to hold them, and never exceeds the song itself', () => {
  for (const durationMs of [300000, 480000, 600000, 3600000]) {
    const c = cycleMs(durationMs);
    assert.ok(c >= 100000 - 1e-6 && c <= 200000 + 1e-6, `cycle out of range for ${durationMs}: ${c}`);
    assert.ok(durationMs / c >= 2 - 1e-6, `must fit at least two cycles for ${durationMs}: ${durationMs / c}`);
  }
  // Short songs (under two minutes) can't fit two 60s+ cycles -- they get
  // one cycle sized to the song, never longer than the song itself.
  for (const durationMs of [1000, 30000, 90000]) {
    const c = cycleMs(durationMs);
    assert.ok(c > 0 && c <= durationMs, `cycle must fit within a short song: ${c} vs ${durationMs}`);
  }
});

test('dayNight: altitudes are bounded, finite, and periodic', () => {
  const cycle = 90000;
  for (let t = -50000; t < 200000; t += 3333) {
    const { sunAlt, moonAlt, night, dawnAlpha, duskAlpha } = dayNight(t, cycle);
    for (const v of [sunAlt, moonAlt, night, dawnAlpha, duskAlpha]) {
      assert.ok(Number.isFinite(v), `non-finite at t=${t}`);
      assert.ok(v >= 0 && v <= 1, `out of [0,1] at t=${t}: ${v}`);
    }
  }
  const a = dayNight(12345, 90000);
  const b = dayNight(12345 + 90000, 90000);
  assert.deepEqual(a, b, 'must be exactly periodic in the cycle length');
});

test('dayNight: sun and moon are never both up, and each is 0 at the other\'s zenith', () => {
  const cycle = 100000;
  for (let t = 0; t < cycle; t += 500) {
    const { sunAlt, moonAlt } = dayNight(t, cycle);
    assert.ok(sunAlt <= 1e-9 || moonAlt <= 1e-9, `both up at t=${t}: sun=${sunAlt} moon=${moonAlt}`);
  }
  const sunZenith = dayNight(cycle * SUN_ZENITH_P, cycle);
  assert.ok(sunZenith.sunAlt > 0.99);
  assert.ok(sunZenith.moonAlt < 1e-6);
  const moonZenith = dayNight(cycle * MOON_ZENITH_P, cycle);
  assert.ok(moonZenith.moonAlt > 0.99);
  assert.ok(moonZenith.sunAlt < 1e-6);
});

test('an empty sky sits between one body setting and the other rising', () => {
  // The property the abutting arcs never had: not merely "never both up",
  // which two arcs meeting at a point satisfy on a technicality, but a real
  // stretch of TIME with nothing above the water at all.
  const cycle = 100000;
  for (const [label, from, to] of [
    ['after sunset, before moonrise', SUN_SET_PHASE, 0.5],
    ['after moonset, before sunrise', MOON_SET_PHASE, 1.0],
  ]) {
    let empty = 0;
    for (let p = 0; p < 1; p += 0.0005) {
      const { sunAlt, moonAlt } = dayNight(p * cycle, cycle);
      if (sunAlt <= 1e-9 && moonAlt <= 1e-9) empty++;
    }
    assert.ok(empty * 0.0005 > CELESTIAL_GAP,
      `the sky must actually be empty for a while (${label})`);
    // ...and specifically across this gap, at its own midpoint.
    const mid = dayNight((from + to) / 2 * cycle, cycle);
    assert.ok(mid.sunAlt <= 1e-9 && mid.moonAlt <= 1e-9,
      `nothing should be up mid-gap (${label})`);
  }
});

test('it is fully night across the empty sky, so the gap reads as darkness', () => {
  const cycle = 100000;
  const mid = dayNight((SUN_SET_PHASE + 0.5) / 2 * cycle, cycle);
  assert.ok(mid.night > 0.98, 'the sun is down and the moon is not up yet');
});

test('dayNight: night is ~0 at sun zenith and ~1 at moon zenith', () => {
  const cycle = 100000;
  assert.ok(dayNight(cycle * 0.25, cycle).night < 0.02);
  assert.ok(dayNight(cycle * 0.75, cycle).night > 0.98);
});

test('celestialYFracFor rises from the ocean horizon toward zenith as altitude increases', () => {
  const horizonY = celestialYFracFor(0);
  const zenithY = celestialYFracFor(1);
  assert.ok(Math.abs(horizonY - OCEAN_HORIZON_FRAC) < 1e-9, 'alt=0 must sit exactly on the sea horizon');
  assert.ok(zenithY < horizonY, 'zenith must be higher on screen (smaller yFrac) than the horizon');
  let prev = horizonY;
  for (let alt = 0; alt <= 1; alt += 0.1) {
    const y = celestialYFracFor(alt);
    assert.ok(y <= prev + 1e-9, 'yFrac must decrease (rise) monotonically with altitude');
    prev = y;
  }
});

test('horizonFade eases a body in/out near the horizon and is fully visible above its band', () => {
  assert.equal(horizonFade(0), 0);
  assert.equal(horizonFade(1), 1);
  assert.ok(horizonFade(0.04) > 0 && horizonFade(0.04) < 1);
  assert.equal(horizonFade(0.5), 1, 'fully faded in well above the horizon band');
});

test('celestialXFracFor carries a body from the rise edge to the set edge, monotonically', () => {
  assert.ok(Math.abs(celestialXFracFor(0) - CELESTIAL_RISE_XFRAC) < 1e-9, 'az=0 is the rising horizon');
  assert.ok(Math.abs(celestialXFracFor(1) - CELESTIAL_SET_XFRAC) < 1e-9, 'az=1 is the setting horizon');
  assert.ok(CELESTIAL_SET_XFRAC < CELESTIAL_RISE_XFRAC, 'bodies rise ahead (right) and set behind (left)');
  let prev = celestialXFracFor(0);
  for (let u = 0; u <= 1; u += 0.05) {
    const x = celestialXFracFor(u);
    assert.ok(x <= prev + 1e-9, `must travel one way only, broke at ${u}`);
    assert.ok(x >= CELESTIAL_SET_XFRAC - 1e-9 && x <= CELESTIAL_RISE_XFRAC + 1e-9, 'stays between the horizons');
    prev = x;
  }
  // Out-of-range input is clamped, not extrapolated off-screen.
  assert.ok(Math.abs(celestialXFracFor(-3) - CELESTIAL_RISE_XFRAC) < 1e-9);
  assert.ok(Math.abs(celestialXFracFor(9) - CELESTIAL_SET_XFRAC) < 1e-9);
});

test('dayNight: each body\'s azimuth runs 0->1 across its own arc and holds at the horizon it left', () => {
  const cycle = 80000;
  for (let t = 0; t < cycle; t += 250) {
    const { sunAz01, moonAz01 } = dayNight(t, cycle);
    for (const v of [sunAz01, moonAz01]) {
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `azimuth out of [0,1] at t=${t}: ${v}`);
    }
  }
  // Sun owns the first half: 0 at its rise, 1 by its set, then parked.
  assert.ok(Math.abs(dayNight(0, cycle).sunAz01 - 0) < 1e-9);
  assert.ok(Math.abs(dayNight(cycle * SUN_ZENITH_P, cycle).sunAz01 - 0.5) < 1e-9);
  assert.ok(Math.abs(dayNight(cycle * MOON_ZENITH_P, cycle).sunAz01 - 1) < 1e-9, 'sun stays set through the night');
  // Moon owns the second: parked at its rise edge all day, then crosses.
  assert.ok(Math.abs(dayNight(cycle * SUN_ZENITH_P, cycle).moonAz01 - 0) < 1e-9, 'moon waits at its rise edge');
  assert.ok(Math.abs(dayNight(cycle * MOON_ZENITH_P, cycle).moonAz01 - 0.5) < 1e-9);
  // ...and parked at the horizon it left through the closing gap, rather than
  // running past 1 or wrapping back.
  assert.ok(Math.abs(dayNight(cycle * (MOON_SET_PHASE + CELESTIAL_GAP / 2), cycle).moonAz01 - 1) < 1e-9,
    'moon stays set through the pre-dawn gap');
});

test('dayNight: altitude and azimuth stay in step, so a body climbs as it crosses', () => {
  const cycle = 90000;
  // Each body is highest exactly halfway across its own arc.
  const sunPeak = dayNight(cycle * SUN_ZENITH_P, cycle);
  assert.ok(sunPeak.sunAlt > 0.999 && Math.abs(sunPeak.sunAz01 - 0.5) < 1e-9);
  const moonPeak = dayNight(cycle * MOON_ZENITH_P, cycle);
  assert.ok(moonPeak.moonAlt > 0.999 && Math.abs(moonPeak.moonAz01 - 0.5) < 1e-9);
  // ...and on the horizon at both ends of it.
  assert.ok(dayNight(0, cycle).sunAlt < 1e-9);
  assert.ok(dayNight(cycle * SUN_SET_PHASE - 1, cycle).sunAlt < 0.01);
});

test('sunScreenFrac: the sun keeps going below the horizon all night', () => {
  const horizon = OCEAN_HORIZON_FRAC;
  const SUN_NADIR_P = SUN_SET_PHASE + (1 - SUN_SET_PHASE) / 2;
  assert.ok(sunScreenFrac(SUN_ZENITH_P).yFrac < horizon, 'above the horizon at midday');
  assert.ok(sunScreenFrac(SUN_NADIR_P).yFrac > horizon, 'below the horizon at midnight');
  assert.ok(Math.abs(sunScreenFrac(0).yFrac - horizon) < 1e-9, 'on the horizon at sunrise');
  assert.ok(Math.abs(sunScreenFrac(SUN_SET_PHASE).yFrac - horizon) < 1e-9, 'on the horizon at sunset');
  // As far under at its nadir as over at its noon -- it's the same circle,
  // even though the gaps make the night half longer than the day half.
  const noonRise = horizon - sunScreenFrac(SUN_ZENITH_P).yFrac;
  const nadirDrop = sunScreenFrac(SUN_NADIR_P).yFrac - horizon;
  assert.ok(Math.abs(noonRise - nadirDrop) < 1e-9, 'the arc is symmetric about the horizon');
  // It retraces its own path underneath rather than jumping across.
  assert.ok(Math.abs(sunScreenFrac(SUN_SET_PHASE).xFrac - sunScreenFrac(SUN_SET_PHASE + 1e-6).xFrac) < 1e-3, 'no jump at sunset');
  assert.ok(Math.abs(sunScreenFrac(0.999).xFrac - sunScreenFrac(0).xFrac) < 1e-2, 'no jump at sunrise');
  for (let p = 0; p <= 1; p += 0.01) {
    const s = sunScreenFrac(p);
    assert.ok(Number.isFinite(s.xFrac) && Number.isFinite(s.yFrac), `non-finite at p=${p}`);
    assert.ok(s.altSigned >= -1 - 1e-9 && s.altSigned <= 1 + 1e-9, `altSigned out of range at p=${p}`);
  }
  // Periodic, like everything else on this clock.
  assert.deepEqual(sunScreenFrac(0.3), sunScreenFrac(1.3));
  assert.deepEqual(sunScreenFrac(0.3), sunScreenFrac(-0.7));
});

test('sunScreenFrac agrees with dayNight about where the sun is while it is up', () => {
  const cycle = 90000;
  for (let p = 0.02; p < SUN_SET_PHASE; p += 0.02) {
    const dn = dayNight(p * cycle, cycle);
    const s = sunScreenFrac(p);
    assert.ok(Math.abs(s.altSigned - dn.sunAlt) < 1e-9, `altitude disagrees at p=${p}`);
    assert.ok(Math.abs(s.xFrac - celestialXFracFor(dn.sunAz01)) < 1e-9, `azimuth disagrees at p=${p}`);
  }
});

test('cyclePhase01 wraps to [0,1) and matches the phase dayNight works in', () => {
  assert.ok(Math.abs(cyclePhase01(0, 1000) - 0) < 1e-9);
  assert.ok(Math.abs(cyclePhase01(250, 1000) - 0.25) < 1e-9);
  assert.ok(Math.abs(cyclePhase01(1250, 1000) - 0.25) < 1e-9, 'wraps forward');
  assert.ok(Math.abs(cyclePhase01(-750, 1000) - 0.25) < 1e-9, 'wraps backward');
  for (const t of [-9999, 0, 12345, 1e9]) {
    const v = cyclePhase01(t, 777);
    assert.ok(v >= 0 && v < 1, `out of [0,1) for t=${t}: ${v}`);
  }
});

// One day per song: dark before dawn, sunrise, the sun's arc, sunset, then
// afterglow to the end (songSkyClock).
test('a song opens in darkness before dawn and closes after sunset', async () => {
  const { songSkyClock, SONG_DAY_MIN_MS } = await import('../src/world/DayNight.js');
  const clock = songSkyClock(180000);
  assert.ok(clock.sunriseMs >= 20000 && clock.sunriseMs <= 24000, `${clock.sunriseMs}`);
  assert.ok(clock.sunsetMs < 180000 && clock.sunsetMs >= 180000 - 18000);
  const at = (ms) => dayNight(ms, clock);
  assert.equal(at(0).night, 1);
  assert.equal(at(0).sunAlt, 0);
  assert.equal(at(0).moonAlt, 0);
  // The sky pales before the sun is up, and the sun is up just after.
  assert.ok(at(clock.sunriseMs - 2000).night < at(1000).night);
  // The night lifts evenly over the dawn, never in a rush: in a long song
  // no two seconds take away more than a tenth of it, and even in the
  // shortest song that holds a day, no more than a fifth.
  for (const [d, most] of [[180000, 0.1], [120000, 0.1], [80000, 0.13], [45000, 0.2], [SONG_DAY_MIN_MS, 0.2]]) {
    const c = songSkyClock(d);
    for (let t = 0; t < c.sunriseMs; t += 250) {
      const drop = dayNight(t, c).night - dayNight(t + 2000, c).night;
      assert.ok(drop <= most, `${d} ms song: night falls ${drop.toFixed(3)} at ${t}`);
    }
  }
  assert.ok(at(clock.sunriseMs + 2000).sunAlt > 0);
  // Noon mid-song; the sun lingers low (slower near the horizon).
  const mid = (clock.sunriseMs + clock.sunsetMs) / 2;
  assert.ok(at(mid).sunAlt > 0.99);
  const early = at(clock.sunriseMs + 10000).sunAlt, later = at(mid - 10000).sunAlt;
  assert.ok(early < 0.35, `${early}`);
  assert.ok(later > 0.9);
  // Sunset at sunsetMs, then dark with no moon to the end.
  assert.ok(at(clock.sunsetMs - 2000).sunAlt > 0);
  assert.equal(at(clock.sunsetMs + 1000).sunAlt, 0);
  for (const t of [clock.sunsetMs + 4000, 180000, 200000]) {
    assert.equal(at(t).night, 1);
    assert.equal(at(t).moonAlt, 0);
  }
  // The sun rises screen right and sets screen left, as in the cycle.
  assert.ok(at(clock.sunriseMs + 500).sunAz01 < 0.05);
  assert.ok(at(clock.sunsetMs - 500).sunAz01 > 0.95);
  // A clock stands in for a cycle length wherever one is taken.
  assert.equal(cyclePhase01(0, clock), MOON_SET_PHASE);
  // Short or unknown songs keep the repeating cycle.
  assert.equal(songSkyClock(SONG_DAY_MIN_MS - 1), null);
  assert.equal(songSkyClock(0), null);
});

test('twilight burns around the sun as it crosses the horizon, dawn and dusk in their own colours', async () => {
  const { songSkyClock, twilightAt, TWILIGHT } = await import('../src/world/DayNight.js');
  const clock = songSkyClock(120000);
  const tw = (ms) => twilightAt(clock.phaseAt(ms));
  assert.ok(tw(0).amount01 < 0.05, 'the opening is dark');
  assert.ok(tw(clock.sunriseMs).amount01 > 0.9, 'sunrise burns');
  assert.equal(tw(clock.sunriseMs).colors, TWILIGHT.dawn);
  assert.ok(tw(60000).amount01 < 0.01, 'none at noon');
  assert.ok(tw(clock.sunsetMs).amount01 > 0.9, 'sunset burns');
  assert.equal(tw(clock.sunsetMs).colors, TWILIGHT.dusk);
  assert.ok(tw(clock.sunsetMs).xFrac < tw(clock.sunriseMs).xFrac, 'set on the left, rise on the right');
  assert.ok(tw(120000).amount01 < tw(clock.sunsetMs).amount01);
});
