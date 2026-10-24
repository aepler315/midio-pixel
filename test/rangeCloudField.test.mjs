import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { cloudBanks, projectCloudPoint } from '../src/world/alpine/RangeCloudField.js';

const pose = { eyeM: [10000, 3000, 16000], targetM: [15000, 6000, 90000], fovYDeg: 50, aspect: 16 / 9 };
const descriptor = p => ({ tourPose: p });
function projected(p, point) {
  const camera = new THREE.PerspectiveCamera(p.fovYDeg, p.aspect, 20, 150000);
  camera.position.fromArray(p.eyeM); camera.up.fromArray(p.upM || [0, 1, 0]); camera.lookAt(...p.targetM);
  if (p.viewOffset) {
    const { fx, rx, uy } = p.viewOffset, tan = Math.tan(p.fovYDeg * Math.PI / 360);
    camera.setViewOffset(1600, 900, (fx + rx / (tan * p.aspect)) * 800,
      (fx - uy / tan) * 450, (1 - fx) * 1600, (1 - fx) * 900);
  }
  camera.updateMatrixWorld();
  const q = new THREE.Vector3(...point).project(camera);
  return [(q.x + 1) / 2, (1 - q.y) / 2];
}
const banks = (camera = descriptor(pose), extra = {}) => cloudBanks({ camera, width: 1280, height: 720,
  seed: 315, timeSec: 40, ...extra });

test('finite cloud points match actual terrain-camera projection including crop and reflected up', () => {
  for (const p of [pose, { ...pose, viewOffset: { fx: .3, rx: .08, uy: -.04 } },
    { ...pose, upM: [.3, .95, 0] }, { ...pose, eyeM: [10000, -1000, 16000], upM: [0, -1, 0] }]) {
    const point = [17000, 8000, 72000], expected = projected(p, point);
    const actual = projectCloudPoint(descriptor(p), point);
    assert.ok(actual.inFront);
    assert.ok(Math.abs(actual.xFrac - expected[0]) < 1e-10);
    assert.ok(Math.abs(actual.yFrac - expected[1]) < 1e-10);
  }
});

test('clouds acquire real translation parallax while yaw, pitch, zoom and roll follow the same camera', () => {
  const point = [17000, 8000, 72000], before = projectCloudPoint(descriptor(pose), point);
  const translate = { ...pose, eyeM: pose.eyeM.map((v, i) => v + [2000, 100, 500][i]),
    targetM: pose.targetM.map((v, i) => v + [2000, 100, 500][i]) };
  const after = projectCloudPoint(descriptor(translate), point);
  assert.notEqual(after.xFrac, before.xFrac, 'a finite cloud cannot remain glued to a translating camera');
  for (const p of [translate, { ...pose, targetM: [25000, 9000, 90000] },
    { ...pose, fovYDeg: 25 }, { ...pose, upM: [.4, .9, 0] }]) {
    const expected = projected(p, point), actual = projectCloudPoint(descriptor(p), point);
    assert.ok(Math.abs(actual.xFrac - expected[0]) < 1e-10);
    assert.ok(Math.abs(actual.yFrac - expected[1]) < 1e-10);
  }
});

test('both rail cameras project before their route blend', () => {
  const other = { ...pose, eyeM: [8000, 3500, 17000], targetM: [20000, 6500, 90000] };
  const point = [17000, 8000, 72000], a = projected(pose, point), b = projected(other, point);
  const camera = { skyCamera: { from: { pose, aspect: pose.aspect }, to: { pose: other, aspect: other.aspect }, mix: .3 } };
  const actual = projectCloudPoint(camera, point);
  assert.ok(Math.abs(actual.xFrac - (a[0] * .7 + b[0] * .3)) < 1e-10);
  assert.ok(Math.abs(actual.yFrac - (a[1] * .7 + b[1] * .3)) < 1e-10);
  assert.ok(banks(camera).length > 0);
});

test('bounded world banks keep IDs and positions through camera changes, resize and random access', () => {
  const first = banks(), translated = banks(descriptor({ ...pose,
    eyeM: pose.eyeM.map((v, i) => v + [1000, 50, 200][i]), targetM: pose.targetM.map((v, i) => v + [1000, 50, 200][i]) }));
  assert.ok(first.length > 0 && first.length <= 242);
  const movedById = new Map(translated.map(bank => [bank.id, bank]));
  const common = first.filter(bank => movedById.has(bank.id));
  assert.ok(common.length > 0);
  for (const bank of common) assert.deepEqual(movedById.get(bank.id).world, bank.world);
  assert.ok(common.some(bank => Math.abs(movedById.get(bank.id).x - bank.x) > .1));
  const large = banks(descriptor(pose), { width: 2560, height: 1440 });
  for (const bank of first) {
    const big = large.find(other => other.id === bank.id);
    assert.deepEqual(big.world, bank.world);
    assert.ok(Math.abs(big.x - bank.x * 2) < 1e-8);
    assert.ok(Math.abs(big.w - bank.w * 2) < 1e-8);
    assert.ok(bank.alpha > 0 && bank.alpha <= 1);
    assert.equal(bank.matrix.length, 6);
    assert.ok(bank.matrix.every(Number.isFinite));
  }
  banks(descriptor(pose), { timeSec: 200 });
  assert.deepEqual(banks(), first, 'seeking and draw history cannot move a world bank');
});

test('finite sprites retain visible edges, stay bounded near clipping and do not reset at world-cell boundaries', () => {
  let outsideVisible = false;
  for (let yaw = -1; yaw <= 1; yaw += .1) {
    const result = banks(descriptor({ ...pose, targetM: [pose.eyeM[0] + Math.sin(yaw) * 70000, 6000,
      pose.eyeM[2] + Math.cos(yaw) * 70000] }));
    outsideVisible ||= result.some(bank => bank.x < 0 || bank.x > 1280 || bank.y < 0 || bank.y > 720);
  }
  assert.ok(outsideVisible, 'a cloud with an offscreen center can still have a visible projected edge');
  const at = x => banks(descriptor({ ...pose, eyeM: [x, 3000, 16000], targetM: [x + 5000, 6000, 90000] }), { timeSec: 0 });
  const a = at(31999.99), b = at(32000.01);
  assert.deepEqual(a.map(bank => bank.id).sort(), b.map(bank => bank.id).sort(), 'crossing a lattice cell cannot reset the visible sky');
  for (const result of [banks(descriptor({ ...pose, fovYDeg: 5 })), banks(descriptor({ ...pose, eyeM: [0, 8000, 0], targetM: [0, 8001, 0] }))]) {
    assert.ok(result.length <= 242);
    assert.ok(result.every(bank => bank.matrix.every(Number.isFinite) && Number.isFinite(bank.w) && Number.isFinite(bank.h)));
  }
});

test('a blended bank changes continuously when one rail crosses its distance fade boundary', () => {
  const bank = banks()[0], world = bank.world;
  const aimed = (distance, lateral = 0) => ({ ...pose,
    eyeM: [world[0] + lateral, world[1] - 4000,
      world[2] - Math.sqrt(distance * distance - lateral * lateral - 4000 * 4000)], targetM: world });
  const close = aimed(60000, 20000);
  const at = distance => banks({ skyCamera: { from: { pose: aimed(distance) }, to: { pose: close }, mix: .5 } })
    .find(candidate => candidate.id === bank.id);
  const outside = at(120000.01), inside = at(119999.99);
  assert.ok(outside && inside, 'the other rail keeps this bank visible across the boundary');
  for (let i = 0; i < 6; i++) assert.ok(Math.abs(inside.matrix[i] - outside.matrix[i]) < .01,
    `affine component ${i} must fade continuously instead of gaining a full rail contribution`);
  assert.ok(Math.abs(inside.alpha - outside.alpha) < 1e-8);
});

test('the full cloud card stays above its finite fair or storm base altitude', () => {
  const depth = 60000, tan = Math.tan(pose.fovYDeg * Math.PI / 360);
  for (const storm of [false, true]) for (const bank of banks(descriptor(pose), { storm })) {
    const horizontal = { ...pose, eyeM: [bank.world[0], bank.world[1], bank.world[2] - depth], targetM: bank.world };
    const same = banks(descriptor(horizontal), { storm }).find(candidate => candidate.id === bank.id);
    assert.ok(same);
    // A horizontal terrain camera has constant depth along the vertical
    // card edge, so its real height follows directly from perspective size.
    const physicalHeight = same.h * 2 * depth * tan / 720;
    assert.ok(same.world[1] - physicalHeight * .5 >= (storm ? 4500 : 5500) - 1e-7,
      `${same.id} paints below its cloud-base altitude`);
  }
});

test('overlapping finite banks paint from far to near with stable depth diagnostics', () => {
  const length = Math.hypot(...pose.targetM.map((value, i) => value - pose.eyeM[i]));
  const forward = pose.targetM.map((value, i) => (value - pose.eyeM[i]) / length);
  for (const storm of [false, true]) {
    const result = banks(descriptor(pose), { storm });
    const depths = result.map(bank => bank.world.reduce((total, value, axis) => total + (value - pose.eyeM[axis]) * forward[axis], 0));
    for (let i = 1; i < depths.length; i++) assert.ok(depths[i - 1] >= depths[i], 'a farther bank cannot paint over a nearer bank');
    for (let i = 0; i < result.length; i++) {
      assert.ok(Math.abs(result[i].depth - depths[i]) < 1e-7);
    }
  }
});
