import test from 'node:test';
import assert from 'node:assert/strict';
import { RangeSkyRenderer } from '../src/world/alpine/RangeSkyRenderer.js';

const pose = { eyeM: [0, 2500, 0], targetM: [0, 3500, -40000], fovYDeg: 50, aspect: 16 / 9 };
function context() {
  return { globalAlpha: 1, save() {}, restore() {}, translate() {}, rotate() {}, transform() {},
    createLinearGradient: () => ({ addColorStop() {} }), fillRect() {}, drawImage() {} };
}
function frame(camera, storm) {
  return { camera: { x: 0, y: 0, tourPose: camera }, seed: 315, sourceWidth: 1280, sourceHeight: 720,
    night: 0, timeSec: 40, colors: { top: '#123456', mid: '#345678', horizon: '#56789a' },
    storm: { amount: storm ? 1 : 0, break01: 0, flash: 0, wet01: 0 } };
}
function stormBanks(camera) {
  const sky = new RangeSkyRenderer(), calls = [];
  for (const name of ['_stars', '_aurora', '_bodies', '_clouds']) sky[name] = () => {};
  sky._stormClouds = (_, banks) => calls.push(structuredClone(banks));
  try { sky.draw(context(), frame(camera, true)); return calls[0]; }
  finally { sky.dispose(); }
}
function shiftedBanks(a, b) {
  const before = new Map(a.map(bank => [bank.id, bank]));
  return b.filter(bank => before.has(bank.id)).map(bank => ({ before: before.get(bank.id), after: bank }));
}

test('storm cloud positions consume tour yaw instead of the zero legacy screen pan', () => {
  const paired = shiftedBanks(stormBanks(pose), stormBanks({ ...pose, targetM: [10000, 3500, -40000] }));
  assert.ok(paired.length > 0, 'the same world clouds remain identifiable across a camera turn');
  assert.ok(paired.some(({ before, after }) => Math.abs(after.x - before.x) > 50));
});

test('storm clouds have finite parallax during terrain-camera travel', () => {
  const translated = { ...pose, eyeM: [3000, 2500, 0], targetM: [3000, 3500, -40000] };
  const paired = shiftedBanks(stormBanks(pose), stormBanks(translated));
  assert.ok(paired.length > 0);
  assert.ok(paired.some(({ before, after }) => Math.abs(after.x - before.x) > 10));
  assert.deepEqual(stormBanks(pose), stormBanks(pose), 'reconstruction is independent of draw/seek order');
});

test('clear-cloud drawing has finite travel parallax as well as camera rotation', () => {
  const sky = new RangeSkyRenderer();
  for (const name of ['_stars', '_aurora', '_bodies']) sky[name] = () => {};
  sky._cloud = () => ({ width: 192, height: 128 });
  const draw = camera => {
    const calls = [], ctx = context();
    ctx.translate = (...values) => calls.push(['translate', ...values]);
    ctx.transform = (...values) => calls.push(['transform', ...values]);
    ctx.drawImage = (_, ...values) => calls.push(['drawImage', ...values]);
    sky.draw(ctx, frame(camera, false)); return calls;
  };
  try {
    const a = draw(pose);
    assert.ok(a.some(values => values[0] === 'drawImage'));
    const translated = { ...pose, eyeM: [3000, 2500, 0], targetM: [3000, 3500, -40000] };
    assert.notDeepEqual(draw(translated), a, 'clouds cannot remain at the same pixels while the camera travels');
    assert.deepEqual(draw(pose), a);
  } finally { sky.dispose(); }
});

test('storm tint keeps cloud interior luminance before applying its alpha mask', () => {
  const operations = [];
  const tint = { globalCompositeOperation: 'source-over', clearRect() {},
    createLinearGradient: () => ({ addColorStop() {} }), fillRect() {},
    drawImage() { operations.push(this.globalCompositeOperation); } };
  const sky = new RangeSkyRenderer({ makeCanvas: () => ({ width: 0, height: 0, getContext: () => tint }) });
  sky._cloud = () => ({ width: 192, height: 128 });
  try {
    sky._stormClouds(context(), [{ id: 'bank0', x: 640, y: 100, w: 300, h: 100, alpha: .8 }],
      { dark: [26, 31, 39], lit: [70, 76, 86], directGain: .35 });
    assert.ok(operations.includes('multiply'), 'the shaded cloud colors must contribute, not only their alpha');
    assert.equal(operations.at(-1), 'destination-in', 'the original soft cloud silhouette is retained');
  } finally { sky.dispose(); }
});
