import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIRE_LAYERS, wireOffset, wireAmplitude, wireColor, contrastRatio, resampleCrest, drawCrestWire,
  crestWave01, CREST_WAVE_BEATS, GLOW_INTENSITY, GLOW_FOOTPRINT,
} from '../src/world/CrestWire.js';
import { hexToRgb, rgbToHsl } from '../src/utils/color.js';
import * as CrestWire from '../src/world/CrestWire.js';

const cfg = WIRE_LAYERS.L4;

test('a supplied musical position keeps the packet independent of the kick interval estimate', () => {
  const trace = (beatSec) => {
    const points = [];
    const ctx = { save() {}, restore() {}, beginPath() {}, stroke() {},
      moveTo(x, y) { points.push([x, y]); }, lineTo(x, y) { points.push([x, y]); } };
    drawCrestWire(ctx, [{ x: 0, y: 20 }, { x: 900, y: 20 }], {
      cfg, color: '#ffffff', amp: 3, sharp: 0, tSec: 123.4,
      glow: false, beatSec, beatPosition: 246.8,
    });
    return points;
  };
  assert.deepEqual(trace(0.5), trace(0.525), 'a kick estimate must not teleport the packet');
});

test('packet intensity stays continuous as it leaves the right edge and re-enters the left', () => {
  for (const x of [0, 10, 990, 1000]) {
    const before = crestWave01(x, 0, 1000, 1 - 1e-7, 0.5);
    const after = crestWave01(x, 0, 1000, 1 + 1e-7, 0.5);
    assert.ok(Math.abs(before - after) < 0.001, `packet snaps at x=${x}: ${before} -> ${after}`);
  }
});

test('the crest clock follows offset downbeats, tempo changes, meters and backward seeks', () => {
  assert.equal(typeof CrestWire.CrestBeatClock, 'function');
  const clock = new CrestWire.CrestBeatClock([
    { ms: 250, numerator: 3 }, { ms: 1750, numerator: 4 },
    { ms: 4750, numerator: 4 },
  ]);
  assert.equal(clock.at(0.25), 0);
  assert.equal(clock.at(1.25), 2);
  assert.equal(clock.at(1.75), 3);
  assert.equal(clock.at(2.5), 4);
  assert.equal(clock.at(4.75), 7);
  assert.equal(clock.at(5.5), 8, 'last bar continues at the last measured beat period');
  assert.equal(clock.at(1.25), 2, 'seeking backward is history-independent');
  assert.ok(Math.abs(clock.at(1.75 - 1e-7) - clock.at(1.75 + 1e-7)) < 1e-5);
  assert.equal(new CrestWire.CrestBeatClock([]).at(2), 4);
  assert.equal(new CrestWire.CrestBeatClock([{ ms: 250 }]).at(0.75), 1);
});

test('a shared MIDI meter-change downbeat is counted once using the new meter', () => {
  const clock = new CrestWire.CrestBeatClock([
    { ms: 0, numerator: 3 }, { ms: 1500, numerator: 3 },
    { ms: 1500, numerator: 4 }, { ms: 3500, numerator: 4 },
  ]);
  assert.equal(clock.at(1.5), 3);
  assert.equal(clock.at(2), 4);
  assert.equal(clock.at(3.5), 7);
  assert.ok(Math.abs(clock.at(1.5 - 1e-7) - clock.at(1.5 + 1e-7)) < 1e-5);
});

test('quiet is a sine, loud is a zigzag, and both stay within the amplitude', () => {
  const quarter = cfg.wavelength / 4;
  // At a quarter wavelength both shapes peak at the amplitude.
  assert.ok(Math.abs(wireOffset(quarter, 0, cfg, 3, 0) - 3) < 1e-9);
  assert.ok(Math.abs(wireOffset(quarter, 0, cfg, 3, 1) - 3) < 1e-9);
  // An eighth of the way the sine is already at 0.707, the zigzag only at 0.5.
  const eighth = cfg.wavelength / 8;
  assert.ok(Math.abs(wireOffset(eighth, 0, cfg, 1, 0) - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(wireOffset(eighth, 0, cfg, 1, 1) - 0.5) < 1e-9);
  for (let x = 0; x < 200; x += 1.7) assert.ok(Math.abs(wireOffset(x, 3.1, cfg, 3, 0.6)) <= 3 + 1e-9);
});

test('the wave travels along the crest over time', () => {
  assert.notEqual(wireOffset(5, 0, cfg, 3, 0), wireOffset(5, 0.05, cfg, 3, 0));
});

test('a quiet band barely buzzes and a hot band drives the wire', () => {
  const quiet = wireAmplitude(cfg, 1, 1, 0, 0);
  const hot = wireAmplitude(cfg, 1, 1, 0, 1);
  assert.ok(hot > quiet);
  const quarterBuzz = 1 / (13 * 4);
  assert.equal(wireAmplitude(cfg, 0.4, 0.4, 0, 0), wireAmplitude(cfg, 0.4, 0.4, quarterBuzz, 0));
  assert.notEqual(wireAmplitude(cfg, 0.4, 0.4, 0, 1), wireAmplitude(cfg, 0.4, 0.4, quarterBuzz, 1));
});

test('the crest pulse crosses the line once per two beats', () => {
  const beat = 0.5;
  const atStart = crestWave01(0, 0, 1000, 0, beat, 0);
  const atFar = crestWave01(1000, 0, 1000, 0, beat, 0);
  assert.equal(atStart, 0, 'the packet fades in after wrapping');
  assert.ok(atFar < 0.05);
  const half = beat * CREST_WAVE_BEATS * 0.5;
  const mid = crestWave01(500, 0, 1000, half, beat, 0);
  assert.ok(mid > 0.5, `mid ${mid} should sit on the packet`);
  assert.ok(crestWave01(0, 0, 1000, half, beat, 0) < mid);
});

test('the glow is 45% as bright and 70% as wide as the original halo', () => {
  const widths = [];
  const alphas = [];
  const ctx = {
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, save() {}, restore() {},
    set lineWidth(v) { widths.push(v); },
    set globalAlpha(v) { alphas.push(v); },
    set strokeStyle(_v) {}, set lineJoin(_v) {}, set lineCap(_v) {}, set globalCompositeOperation(_v) {},
  };
  drawCrestWire(ctx, [{ x: 0, y: 10 }, { x: 90, y: 20 }], {
    cfg, color: '#ff00ff', amp: 2, sharp: 0, tSec: 0, alpha: 1, glow: true,
  });
  assert.ok(Math.abs(widths[0] - 14 * GLOW_FOOTPRINT) < 1e-9);
  assert.ok(Math.abs(widths[1] - 6 * GLOW_FOOTPRINT) < 1e-9);
  assert.ok(Math.abs(alphas[0] - 0.07 * GLOW_INTENSITY) < 1e-9);
  assert.ok(Math.abs(alphas[1] - 0.18 * GLOW_INTENSITY) < 1e-9);
});

test('loudness and the kick grow the wire, and it buzzes', () => {
  const at = (loud, kick, t) => wireAmplitude(cfg, loud, kick, t);
  const quarterBuzz = 1 / (13 * 4); // a quarter of a buzz cycle
  assert.ok(at(1, 0, 0) > at(0, 0, 0));
  assert.ok(at(0, 1, 0) > at(0, 0, 0));
  assert.notEqual(at(0.5, 0.5, 0), at(0.5, 0.5, quarterBuzz));
});

test('the wire colour stands out from the ridge and the sky behind it, on the ridge\'s complement', () => {
  const pairs = [['#2a3a2f', '#9fb7c9'], ['#e8ecef', '#c9d8e8'], ['#1b1028', '#0a0612'], ['#6e5a3a', '#e9b872']];
  for (const [body, behind] of pairs) {
    const c = wireColor(body, behind);
    assert.ok(Math.min(contrastRatio(c, body), contrastRatio(c, behind)) >= 1.2, `${c} on ${body}/${behind}`);
    const { l, s } = rgbToHsl(...Object.values(hexToRgb(c)));
    assert.ok(l >= 0.44 && s > 0.9, 'bright and saturated, so it can glow');
  }
  const bodyHue = rgbToHsl(...Object.values(hexToRgb('#6e5a3a'))).h;
  const wireHue = rgbToHsl(...Object.values(hexToRgb(wireColor('#6e5a3a', '#e9b872')))).h;
  const d = Math.abs((((wireHue - bodyHue) % 360) + 360) % 360 - 180);
  assert.ok(d < 10, 'complementary hue');
});

test('a grey ridge on a grey sky takes its hue from the accent', () => {
  const c = wireColor('#555555', '#999999', '#ff3366');
  const h = rgbToHsl(...Object.values(hexToRgb(c))).h;
  assert.ok(Math.abs(h - rgbToHsl(255, 0x33, 0x66).h) < 3);
});

test('the crest is resampled finely and drawn with its glow', () => {
  const line = resampleCrest([{ x: 0, y: 10 }, { x: 8, y: 18 }, { x: 16, y: 10 }], 2);
  assert.equal(line.length, 9);
  assert.equal(line[2].y, 14);
  const calls = [];
  const ctx = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : (...a) => calls.push([k, ...a])),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  drawCrestWire(ctx, [{ x: 0, y: 10 }, { x: 60, y: 30 }], { cfg, color: '#ff00ff', amp: 3, sharp: 0.5, tSec: 1 });
  assert.equal(calls.filter((c) => c[0] === 'stroke').length, 3);
  drawCrestWire(ctx, [{ x: 0, y: 10 }, { x: 60, y: 30 }], { cfg, color: '#ff00ff', amp: 3, sharp: 0.5, tSec: 1, glow: false });
  assert.equal(calls.filter((c) => c[0] === 'stroke').length, 4);
});
