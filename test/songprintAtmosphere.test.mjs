import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { Conductor } from '../src/core/Conductor.js';
import { ParamBus } from '../src/core/ParamBus.js';
import { Simulation } from '../src/sim/Simulation.js';
import { buildRangeFrame } from '../src/world/alpine/RangeFrame.js';
import { compileLandscapeScore } from '../src/world/alpine/LandscapeScore.js';
import { compileStorm } from '../src/world/alpine/RangeStorm.js';
import { forestWindAt } from '../src/world/alpine/ForestWind.js';

const durationMs = 120000;
const motif = (times, strength = .94) => ({
  landmark01: .42,
  occurrences: times.map(timeMs => ({ timeMs, strength })),
});
const songprint = (...families) => ({
  version: 1, skyline: Array(16).fill(.5), passages: [], phraseFamilies: { version: 1, families },
});
const energy = (lo, hi, start, end, rms = .025) => ({
  globalEnergyNorm: timeMs => timeMs >= start && timeMs < end ? hi : lo,
  rmsBands: [Float32Array.of(rms)],
  sampleRms: () => rms,
});

function manager({ print, curves, enabled = true, admittedMs = 0, preview = false }) {
  // The renderer must use heard time even when the simulation clock is
  // elsewhere. Weather sampling is reversible without advancing it.
  return {
    tSec: 1, durationMs, sections: [], world: { kind: 'alpine' },
    energyCurves: curves, songTerrain: {},
    songprintAtmosphere: enabled, songprintWeatherPrint: print, songprintWeatherAdmittedMs: admittedMs,
    terrainPreview: preview, _profile: () => null,
  };
}

const frameAt = (biomes, heardTimeMs) => buildRangeFrame({
  frameId: heardTimeMs,
  sim: { biomes, heardTimeMs, songSeed: 15 },
  pose: { worldX: 0, midioX: 0 },
});

function gestureAt(frame) {
  return frame.performance.songprintWeather;
}

function clearing(gesture) {
  return 1 - (gesture?.mistDensityMul ?? 1);
}

test('fog clears on independently timed matched returns, with strength from the current take', () => {
  const studio = manager({ print: songprint(motif([20000, 55000])), curves: energy(.25, .81, 49000, 63000) });
  const live = manager({ print: songprint(motif([27000, 63000])), curves: energy(.25, .41, 57000, 72000) });
  const atStudio = gestureAt(frameAt(studio, 55000));
  const atLive = gestureAt(frameAt(live, 63000));
  assert.ok(clearing(atStudio) > .03);
  assert.ok(clearing(atLive) > 0 && clearing(atLive) < clearing(atStudio));
  assert.ok(atStudio.windGust01 > atLive.windGust01 && atLive.windGust01 > 0);
  assert.equal(atStudio.familyIndex, atLive.familyIndex);
  assert.equal(clearing(gestureAt(frameAt(studio, 20000))), 0, 'first occurrence establishes the phrase');
  assert.equal(clearing(gestureAt(frameAt(live, 55000))), 0, 'the second recording keeps its own time');
});

test('identical energy and terrain do not clear fog at a shuffled or unmatched return time', () => {
  const curves = energy(.32, .69, 49000, 82000);
  const aligned = manager({ print: songprint(motif([20000, 55000])), curves });
  const shuffled = manager({ print: songprint(motif([20000, 72000])), curves });
  const unmatched = manager({ print: songprint(motif([20000])), curves });
  assert.ok(clearing(gestureAt(frameAt(aligned, 55000))) > .03);
  assert.ok(clearing(gestureAt(frameAt(shuffled, 72000))) > .03);
  for (const other of [shuffled, unmatched]) {
    assert.equal(clearing(gestureAt(frameAt(other, 55000))), 0);
    assert.equal(gestureAt(frameAt(other, 55000))?.windGust01 ?? 0, 0);
  }
});

test('the weather frame is smooth, seek-safe and requires an admitted, enabled print', () => {
  const print = songprint(motif([20000, 55000]));
  const curves = energy(.24, .72, 49000, 63000);
  const active = manager({ print, curves });
  const first = frameAt(active, 55000);
  assert.ok(clearing(gestureAt(first)) > .03);
  let previous = 0;
  for (let timeMs = 49000; timeMs <= 65000; timeMs += 16) {
    const current = clearing(gestureAt(frameAt(active, timeMs)));
    assert.ok(Math.abs(current - previous) < .015, `no mist snap at ${timeMs} ms`);
    previous = current;
  }
  assert.equal(previous, 0);
  frameAt(active, 90000);
  frameAt(active, 2000);
  assert.deepEqual(frameAt(active, 55000), first);
  assert.deepEqual(frameAt(manager({ print: structuredClone(print), curves }), 55000), first);
  for (const disabled of [
    manager({ print, curves, enabled: false }),
    manager({ print, curves, preview: true }),
    manager({ print, curves, admittedMs: 54000 }),
  ]) assert.equal(clearing(gestureAt(frameAt(disabled, 55000))), 0);
});

test('a Simulation scores Songprint before a delayed first draw', () => {
  const returnMs = 55000;
  const print = songprint(motif([20000, returnMs]));
  print.passages = [{ timeMs: returnMs, strength: .94, landmark01: .42 }];
  const curves = new EnergyCurves(durationMs);
  for (const band of curves.bands) {
    band.fill(.2);
    band.fill(.7, 49 * curves.rateHz, 63 * curves.rateHz);
  }
  const openAtReturn = options => {
    const conductor = new Conductor();
    conductor.load({ durationMs, timeline: [] });
    const sim = new Simulation(conductor, new ParamBus(), { energyCurves: curves, songSeed: 15,
      songTerrain: { byBiome: new Map(), songprint: print }, songprintAtmosphere: true, songprintWeatherPrint: print, ...options });
    // The browser loads measured terrain while the canvas has not painted.
    // Keep its unrelated 2D strip prebake out of this Node fixture.
    sim.biomes.pumpStripPrewarm = () => {};
    sim.startAt(returnMs);
    const frame = frameAt(sim.biomes, returnMs);
    sim.dispose();
    return frame;
  };
  const full = openAtReturn({});
  assert.ok(gestureAt(full)?.windGust01 > 0);
  assert.ok(full.performance.songprintCue?.targets.length);
  const late = openAtReturn({ songprintAdmittedMs: returnMs, songprintWeatherAdmittedMs: returnMs });
  assert.equal(gestureAt(late), undefined);
  assert.equal(late.performance.songprintCue, null);
});

test('an enabled return adds a bounded gust on the existing forest wind', () => {
  const biomes = manager({ print: songprint(motif([20000, 55000])), curves: energy(.24, .72, 49000, 63000) });
  const frame = frameAt(biomes, 55000);
  const gust = gestureAt(frame)?.windGust01;
  assert.ok(gust > 0 && gust <= 1);
  const [gain, lean] = forestWindAt(frame.effects, frame.storm);
  const [gustGain, gustLean] = forestWindAt(frame.effects, frame.storm, [0, 0], gust);
  assert.ok(gustGain >= gain && gustGain <= 1.8);
  assert.ok(gustLean > lean && gustLean - lean < .08);
});

test('a matching phrase cannot make a downpour, and a formed storm may only clear sooner', () => {
  const print = songprint(motif([21000, 61000]));
  const makeStorm = (energyCurves, songprintAtmosphere) => {
    const options = { durationMs, songprint: print, songprintAtmosphere, energyCurves,
      timeline: [45000, 53000].map(tMs => ({ tMs, role: 'RHYTHM', pitch: 38, vel: .9 })) };
    return compileStorm({ ...options, landscape: compileLandscapeScore(options) });
  };
  const dry = makeStorm(energy(.23, .43, 40000, 60000), true);
  const normalizedNoise = makeStorm(energy(.2, .95, 40000, 60000, .00001), true);
  for (const score of [dry, normalizedNoise]) {
    for (const timeMs of [39500, 48000, 60000, 62000]) assert.equal(score.at(timeMs).amount, 0);
  }
  const curves = energy(.22, .95, 40000, 61000);
  const ordinary = makeStorm(curves, false);
  const directed = makeStorm(curves, true);
  assert.deepEqual(directed.section, ordinary.section);
  assert.equal(directed.at(51000).amount, ordinary.at(51000).amount);
  assert.ok(ordinary.at(63000).amount > 0);
  assert.ok(directed.at(63000).amount < ordinary.at(63000).amount);
  assert.deepEqual(directed.at(80000), ordinary.at(80000));
});
