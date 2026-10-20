import test from 'node:test';
import assert from 'node:assert/strict';
import { RangeSkyRenderer, skyProjector } from '../src/world/alpine/RangeSkyRenderer.js';

const camera = { tourPose: { eyeM: [0, 0, 0], targetM: [0, Math.tan(20 * Math.PI / 180), -1],
  fovYDeg: 5, aspect: 16 / 9 } };
function raysAt(time = 12, night = 1) {
  const commands = [], gradients = [], sky = new RangeSkyRenderer();
  sky.seed = 315;
  let points = [];
  const ctx = {
    save() {}, restore() {},
    createLinearGradient(...position) { const gradient = { position, stops: [], addColorStop(at, color) { this.stops.push([at, color]); } }; gradients.push(gradient); return gradient; },
    beginPath() { points = []; }, moveTo(x, y) { points.push([x, y]); }, lineTo(x, y) { points.push([x, y]); },
    closePath() {}, fill() { commands.push({ kind: 'panel', points }); },
    stroke() { commands.push({ kind: 'ray', points, width: this.lineWidth, alpha: this.globalAlpha, stops: this.strokeStyle.stops }); },
  };
  sky._aurora(ctx, skyProjector(camera), 1280, 720, night, time, 1);
  sky.dispose();
  return { commands, gradients };
}
const alpha = color => Number(color.slice(color.lastIndexOf(',') + 1, -1));

test('aurora emission fades to transparent at both ends instead of a cut-off lower ribbon', () => {
  const { gradients } = raysAt();
  assert.ok(gradients.length > 100 && gradients.length < 2000);
  for (const gradient of gradients) {
    assert.equal(alpha(gradient.stops[0][1]), 0, 'lower emission must feather into the sky');
    assert.equal(alpha(gradient.stops.at(-1)[1]), 0, 'upper emission must also dissipate');
    assert.ok(gradient.stops.some(([offset, color]) => offset > 0 && offset < 1 && alpha(color) > 0));
    assert.ok(gradient.stops.every(([, color]) => alpha(color) <= .08), 'emission cannot repaint a broad opaque band');
  }
});

test('aurora uses bounded vertical emission rays without filled horizontal panels', () => {
  const { commands } = raysAt();
  assert.ok(commands.length > 100 && commands.length < 4000);
  assert.ok(commands.every(command => command.kind === 'ray'));
  assert.ok(commands.every(command => command.points.length === 2 && command.points.flat().every(Number.isFinite)));
  assert.ok(commands.every(command => command.width > 0 && command.width <= 14));
  assert.ok(commands.some(command => Math.min(...command.points.map(point => point[1])) < 0
    && Math.max(...command.points.map(point => point[1])) > 720), 'offscreen ray ends cannot drop an intersecting curtain');
});

test('aurora rays reconstruct on random access and stay absent in daylight', () => {
  const first = raysAt(12).commands;
  raysAt(33);
  assert.deepEqual(raysAt(12).commands, first);
  assert.notDeepEqual(raysAt(14).commands, first, 'heard-time motion changes the same world curtain');
  assert.deepEqual(raysAt(12, 0).commands, []);
});
