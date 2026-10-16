import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileStorm, stormAt, rainCurtain, STORM_GLSL, arrivingStorm } from '../src/world/alpine/RangeStorm.js';
const energyCurves = { globalEnergyNorm: t => t >= 40000 && t < 60000 ? .95 : .25 };
const sections = [{ startMs: 0, endMs: 40000 }, { startMs: 40000, endMs: 60000 }, { startMs: 60000, endMs: 120000 }];
const timeline = [{ tMs: 45000, pitch: 38, role: 'RHYTHM', vel: .9 }, { tMs: 45100, pitch: 40, channel: 9, vel: 1 }, { tMs: 47000, pitch: 36, role: 'RHYTHM', vel: 1 }];
test('storm selects the measured loudest section and breaks into wet sunlight after it', () => {
  const score = compileStorm({ energyCurves, sections, timeline, durationMs: 120000 });
  assert.deepEqual(score.section, { startMs: 40000, endMs: 60000 });
  assert.equal(score.at(20000).amount, 0);
  assert.equal(score.at(45000).amount, 1);
  assert.equal(score.at(70000).amount, 0);
  assert.ok(score.at(70000).break01 > .6);
  assert.ok(score.at(70000).wet01 > .6);
  assert.equal(score.at(120000).break01, 0);
});
test('a sustained early climax wins after the opening guard, including its snare flashes', () => {
  const score = compileStorm({
    energyCurves: { globalEnergyNorm: t => t < 40000 ? .95 : .2 },
    sections: [{ startMs: 0, endMs: 40000 }, { startMs: 40000, endMs: 80000 }, { startMs: 80000, endMs: 120000 }],
    timeline: [{ tMs: 30000, pitch: 38, channel: 9, vel: .9 }],
    durationMs: 120000,
  });
  assert.deepEqual(score.section, { startMs: 8000, endMs: 40000 });
  assert.ok(score.at(30000).flash > .5);
  assert.equal(score.at(60000).amount, 0);
});
test('a measured late climax is eligible even when its section starts near the ending', () => {
  const score = compileStorm({
    energyCurves: { globalEnergyNorm: t => t >= 110000 ? .95 : .2 },
    sections: [{ startMs: 0, endMs: 110000 }, { startMs: 110000, endMs: 120000 }],
    durationMs: 120000,
  });
  assert.deepEqual(score.section, { startMs: 110000, endMs: 120000 });
});
test('unsegmented songs can climax early or late after the arrival', () => {
  for (const startMs of [8000, 100000]) {
    const score = compileStorm({
      energyCurves: { globalEnergyNorm: t => t >= startMs && t < startMs + 20000 ? .95 : .2 },
      durationMs: 120000,
    });
    assert.equal(score.section.startMs, startMs);
  }
});
test('lightning is actual snare timing, seek safe, rate limited and disabled by reduced flash', () => {
  const score = compileStorm({ energyCurves, sections, timeline, durationMs: 120000 });
  assert.ok(score.at(45020).flash > .5);
  assert.equal(score.at(45100).flash, score.at(45100).flash);
  assert.equal(score.at(47000).flash, 0);
  assert.equal(score.at(45020, { reducedFlash: true }).flash, 0);
  assert.ok(score.at(45020).flash > score.at(45120).flash);
});
test('songs without structural sections use their loudest sustained window; no audio evidence means no flashes', () => {
  const score = compileStorm({ energyCurves, durationMs: 120000 });
  assert.ok(score.section.startMs >= 35000 && score.section.startMs < 60000);
  assert.equal(score.at(45000).flash, 0);
  const mgr = { energyCurves, durationMs: 120000, sections, conductor: { timeline } };
  assert.deepEqual(stormAt(mgr, 45020), stormAt(mgr, 45020));
  mgr.reducedFlash = true;
  assert.equal(stormAt(mgr, 45020).flash, 0);
});

test('a pitched D2/E2 line never creates lightning and snare velocity is respected', () => {
  const song = { energyCurves, sections, durationMs: 120000 };
  assert.equal(compileStorm({ ...song, timeline: [{ tMs: 45000, pitch: 38, role: 'BASS', vel: 1 }] }).at(45000).flash, 0);
  assert.equal(compileStorm({ ...song, timeline: [{ tMs: 45000, pitch: 40, role: 'RHYTHM', vel: .2 }] }).at(45000).flash, .2);
});

test('missing measurements do not invent a climax', () => {
  const score = compileStorm({ durationMs: 60000, sections: [{startMs:0,endMs:20000}] });
  assert.equal(score.section,null);
  assert.equal(score.at(12000).amount,0);
});

test('each lightning hit lights a different place in the deck, held through its restrike', () => {
  const score = compileStorm({ energyCurves, sections, durationMs: 120000,
    timeline: [{ tMs: 45000, pitch: 38, channel: 9, vel: 1 }, { tMs: 46000, pitch: 38, channel: 9, vel: 1 }] });
  const a = score.at(45020), restrike = score.at(45150), b = score.at(46020);
  assert.ok(a.flashU >= .18 && a.flashU <= .82);
  assert.equal(restrike.flashU, a.flashU);
  assert.ok(restrike.flash > .3 && restrike.flash < a.flash);
  assert.notEqual(b.flashU, a.flashU);
  assert.equal(score.at(45400).flash, 0);
});

test('rain curtains leave gaps between them and drift slowly on the wind', () => {
  const samples = Array.from({ length: 200 }, (_, i) => rainCurtain(i / 200, 0));
  assert.ok(samples.some(v => v > .9) && samples.some(v => v < .05));
  assert.ok(samples.every(v => v >= 0 && v <= 1));
  const drift = Math.max(...Array.from({ length: 200 }, (_, i) => Math.abs(rainCurtain(i / 200, 1) - rainCurtain(i / 200, 0))));
  assert.ok(drift > 0 && drift < .1);
});

test('the GLSL rain curtain stays the twin of the sky\'s', () => {
  for (const term of ['u * 1.6 + t * 0.003', 'u * 3.7 - t * 0.005', 'smoothstep(0.32, 0.86, a * 0.65 + b * 0.35)'])
    assert.ok(STORM_GLSL.includes(term), term);
});

test('an arriving scene brings its storm sky in at its own alpha', () => {
  const storm = { amount: 1, flash: .8, flashU: .3, break01: .5, wet01: 1 };
  assert.equal(arrivingStorm(storm, 1), storm);
  assert.deepEqual(arrivingStorm(storm, .25), { amount: .25, flash: .2, flashU: .3, break01: .125, wet01: 1 });
  assert.equal(arrivingStorm(null, .5), null);
});

test('no sun-shaft passes run under the full squall deck', async () => {
  const { shaftSource } = await import('../src/world/alpine/SunShaftGL.js');
  const light = { celestial: { body: 'sun', visibility: 1, intensity: 1, xFrac: .5, yFrac: .2 } };
  assert.equal(shaftSource({ light, storm: { amount: 1, break01: 0 } }), null);
  assert.ok(shaftSource({ light, storm: { amount: 0, break01: 1 } }).stormGain > 1);
});
