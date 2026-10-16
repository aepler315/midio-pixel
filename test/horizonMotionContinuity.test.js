import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { RidgeMotionHistory } from '../src/world/RidgeMotionHistory.js';
import { sampleHorizonRidge } from '../src/world/alpine/RidgeMotion.js';

const viewport = { width: 1280, height: 720 };
const crest = { heights: new Float32Array([1, 1]), stepM: 1, windowM: 1, travelM: 0 };
const points = (history, heardTimeMs, tuning) => sampleHorizonRidge({ viewport, crest, history, heardTimeMs, tuning }).points;
const maxDelta = (a, b) => Math.max(...a.map((p, i) => Math.abs(p.y - b[i].y)));

test('Dancing Ridge releases through the audible floor without a geometry step', () => {
  const curves = new EnergyCurves(4000, 50);
  curves.bands.forEach(b => b.fill(.8));
  curves.rmsBands = curves.bands.map(b => Float32Array.from(b, (_, i) => i < 50 ? .01 : 0));
  const history = new RidgeMotionHistory({ energyCurves: curves, durationMs: 4000,
    timeline: [{ tMs: 0, durMs: 2000, vel: 1, role: 'BASS', src: 'audio',
      pitch: 48, pitchConfidence: 1, pitchProvenance: 'tracked' }] });
  assert.ok(history.sample(999.999).activity01 > 0);
  assert.ok(history.sample(999.999).motionMelody.activity > .5);
  assert.equal(history.sample(1000).activity01, 0);
  assert.ok(maxDelta(points(history, 999.999), points(history, 1000)) < .01,
    'an audible gate must not reset the moving crest or its melody phase');
});

test('steady music has one broad carrier and moves less than a pixel per 60Hz frame', () => {
  const history = { sample: () => ({ bands: Array(7).fill(.5), activity01: 1,
    motionPresence01: 1, motionMelody: { activity: 0, pitch01: .5 }, kick01: 0, sources: {} }) };
  const a = points(history, 1500), b = points(history, 1500 + 1000 / 60);
  const inside = a.filter(p => p.x >= 0 && p.x <= viewport.width);
  let turns = 0;
  for (let i = 1; i < inside.length - 1; i++) {
    if ((inside[i].y - inside[i - 1].y) * (inside[i + 1].y - inside[i].y) < 0) turns++;
  }
  assert.ok(turns <= 2, `carrier has ${turns} turning points across the view`);
  assert.ok(maxDelta(a, b) < .5, 'steady music must not produce rapid decorative ripples');
});

test('isolated bands move the ridge as a whole while retaining their local accent', () => {
  const history = { sample: () => ({ bands: [0, .8, 0, 0, 0, 0, 0], activity01: 1,
    motionPresence01: 1, kick01: 0, sources: {} }) };
  const ridge = sampleHorizonRidge({ viewport, crest, history,
    tuning: { crestWavePx: 0, sourceLiftPx: 0, kickLiftPx: 0 } });
  const lifts = ridge.points.map((p, i) => ridge.neutralPoints[i].y - p.y);
  assert.ok(Math.min(...lifts) > 5, 'a band onset should lift the whole mountain outline');
  assert.ok(Math.max(...lifts) > Math.min(...lifts) + 50, 'spectral identity still shapes the crest');
});
