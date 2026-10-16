import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWorldFrame, worldAnalysisReady } from '../tools/world-frame.mjs';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { adoptFullAnalysis } from '../src/audio/OpeningAnalysis.js';

test('whole-song captures wait for full analysis and its live scene adoption', () => {
  const data = { opening: { provisional: true }, energyCurves: new EnergyCurves(15000), durationMs: 32000 };
  const openingSim = { analysisOpening: data.opening, energyCurves: data.energyCurves, biomes: { energyCurves: data.energyCurves } };
  globalThis.window = { __SMW: { sim: openingSim } };
  try {
    assert.equal(worldAnalysisReady({ throughMs: 27000 }), false, 'later passages would still clamp to the opening tail');
    // FFT framing rounds the analyzed endpoint down from the media duration.
    const full = { durationMs: 31985, energyCurves: new EnergyCurves(31985) };
    adoptFullAnalysis(data, full);
    assert.equal(worldAnalysisReady({ throughMs: 27000 }), false, 'data adoption alone does not replace the captured scene');
    const fullSim = { analysisOpening: data.opening, energyCurves: data.energyCurves, biomes: { energyCurves: data.energyCurves } };
    window.__SMW.sim = fullSim;
    assert.equal(worldAnalysisReady({ throughMs: 27000 }), true);
    fullSim.biomes.energyCurves = openingSim.energyCurves;
    assert.equal(worldAnalysisReady({ throughMs: 27000 }), false, 'the manager must sample the same admitted analysis');
  } finally { delete globalThis.window; }
});

test('controlled capture seeks before reading the replacement scene and rendering', () => {
  const calls = [];
  const sim = { timeMs: 18080, biomes: { tSec: 18.08, world: { kind: 'nave', response: { smoothingMs: 1400 } } } };
  const replacement = { sim, perf: { level: 6 }, renderer: { draw: (s) => calls.push(['draw', s]) } };
  globalThis.window = { __SMW: { sim: { timeMs: 27080 }, renderer: { draw: (s) => calls.push(['draw', s]) }, seek: (ms) => { calls.push(['seek', ms]); window.__SMW = replacement; } } };
  globalThis.document = { querySelector: () => ({ width: 1280, height: 720 }) };
  try {
    const capture = renderWorldFrame({ atMs: 18000, quality: 0 });
    assert.deepEqual(calls, [['seek', 18000], ['draw', sim]]);
    assert.equal(replacement.perf.level, 0);
    assert.equal(capture.requestedMs, 18000);
    assert.equal(capture.timeMs, 18080);
    assert.equal(capture.response.smoothingMs, 1400);
    assert.deepEqual(capture.backingStore, { width: 1280, height: 720 });
  } finally { delete globalThis.window; delete globalThis.document; }
});

test('capture restores random source when seek throws', () => {
  const original = Math.random;
  globalThis.window = { __SMW: { seek() { throw new Error('seek failed'); } } };
  try { assert.throws(() => renderWorldFrame({ atMs: 1 }), /seek failed/); assert.equal(Math.random, original); }
  finally { delete globalThis.window; }
});

test('capture construction consumes a repeatable RNG sequence without changing global randomness', () => {
  const original = Math.random, samples = [];
  const sim = { timeMs: 1, biomes: { tSec: 0.001, world: {} } };
  globalThis.window = { __SMW: { sim, perf: {}, renderer: { draw() {} }, seek() { samples.push([Math.random(), Math.random()]); } } };
  globalThis.document = { querySelector: () => ({ width: 1280, height: 720 }) };
  try {
    renderWorldFrame({ atMs: 1 }); renderWorldFrame({ atMs: 1 });
    assert.deepEqual(samples[0], samples[1]); assert.equal(Math.random, original);
  } finally { delete globalThis.window; delete globalThis.document; }
});
