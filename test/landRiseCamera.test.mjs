import assert from 'node:assert/strict';
import test from 'node:test';
import { landRiseBase, landRiseCamera, landRiseFov } from '../src/world/alpine/LandRiseCamera.js';
import { OPENING_ZOOM_START_MS, OPENING_ZOOM_MS } from '../src/core/OpeningTimeline.js';
import { projectPoint } from '../src/world/terrain/SceneTravel.js';

test('the empty opening keeps the authored eye over the same ground', () => {
  const pose = { eyeM: [0, 1400, 5000], targetM: [0, 1800, 0], fovYDeg: 35 };
  const opening = landRiseCamera(pose, { rise01: 0, baseM: 1000, groundM: 1200 });
  assert.deepEqual(opening.eyeM, [0, 1200, 5000]);
  assert.deepEqual(opening.targetM, [0, 1000, 0]);
  assert.equal(opening.fovYDeg, pose.fovYDeg);
});

test('the growing summit stays framed through a close lens and seeks reconstruct it', () => {
  const pose = { eyeM: [0, 2000, 5000], targetM: [0, 2000, 0], fovYDeg: 9 };
  const focusM = [600, 3000, 400], options = { baseM: 1000, groundM: 1800, focusM };
  assert.deepEqual(landRiseCamera(pose, { ...options, rise01: 0 }).targetM, [600, 1000, 400]);
  let lastDistance = Infinity;
  for (let i = 0; i <= 140; i++) {
    const rise01 = i / 200, camera = landRiseCamera(pose, { ...options, rise01 });
    const apex = [focusM[0], 1000 + rise01 * (focusM[1] - 1000), focusM[2]];
    const projected = projectPoint(camera, 16 / 9, apex);
    assert.ok(projected && Math.abs(projected.x) < .73 && Math.abs(projected.y) < .73, `apex at rise ${rise01}`);
    const distance = Math.hypot(camera.eyeM[0] - focusM[0], camera.eyeM[2] - focusM[2]);
    assert.ok(distance <= lastDistance + 1e-7);
    lastDistance = distance;
    assert.deepEqual(camera, landRiseCamera(pose, { ...options, rise01 }));
  }
  assert.strictEqual(landRiseCamera(pose, { ...options, rise01: 1 }), pose);
});

test('very distant views do not retreat toward the scene far plane', () => {
  const pose = { eyeM: [0, 3000, 80000], targetM: [0, 2500, 0], fovYDeg: 35 };
  const camera = landRiseCamera(pose, { rise01: 0, baseM: 100, groundM: 2000 });
  const distance = Math.hypot(...camera.eyeM.map((v, i) => v - camera.targetM[i]));
  assert.ok(distance < 100000, `opening target remains inside the 150km far plane: ${distance}`);
  assert.equal(camera.eyeM[2], pose.eyeM[2]);
});

test('a nearby framed summit cannot fall below a narrow view during the rise', () => {
  const pose = { eyeM: [0, 2947.8209886234254, 27987.597344443202],
    targetM: [0, 3429.1743799112737, 0], fovYDeg: 18.109597178408876 };
  const focusM = [52.20366387862334, 2837.030888380848, 26333.716589069816];
  const options = { baseM: 0, groundM: 253.75552931789971, focusM };
  for (let i = 0; i <= 1000; i++) {
    const rise01 = i / 1000, camera = landRiseCamera(pose, { ...options, rise01 });
    const projected = projectPoint(camera, 16 / 9, [focusM[0], rise01 * focusM[1], focusM[2]]);
    assert.ok(projected && Math.abs(projected.y) < 1 && Math.abs(projected.x) < 1, `rise ${rise01}: ${JSON.stringify(projected)}`);
  }
  assert.strictEqual(landRiseCamera(pose, { ...options, rise01: 1 }), pose);
});

test('the opening preserves clearance without sampling a different foreground', () => {
  const pose = { eyeM: [0, 400, 5000], targetM: [0, 900, 0], fovYDeg: 35 };
  let reads = 0;
  const options = { rise01: .4, baseM: 0, groundM: 100, focusM: [0, 900, 0],
    groundAt(x, z) { reads++; assert.equal(x, 0); assert.ok(z > 5000); return 16000; } };
  const camera = landRiseCamera(pose, options);
  assert.equal(reads, 0);
  assert.deepEqual(camera.eyeM, [0, 340, 5000]);
  const projected = projectPoint(camera, 16 / 9, [0, 900 * .4, 0]);
  assert.ok(projected && Math.abs(projected.y) <= .73, 'retargeting follows the safety lift');
  landRiseCamera(pose, { ...options, overview: false });
  assert.equal(reads, 0, 'admitted windowed tours do not add terrain lookups');
  assert.strictEqual(landRiseCamera(pose, { ...options, rise01: 1 }), pose);
  assert.equal(reads, 0, 'the complete endpoint keeps its exact original pose');
});

test('tours retain their admitted lens and moving action during growth', () => {
  const pose = { eyeM: [20, 1700, 5000], targetM: [2000, 2200, -3000], fovYDeg: 35, tour: true };
  const options = { rise01: 0, baseM: 1000, groundM: 1500 };
  const opening = landRiseCamera(pose, options);
  assert.equal(opening.eyeM[0], pose.eyeM[0]);
  assert.equal(opening.eyeM[2], pose.eyeM[2], 'the tour does not retreat into another foreground');
  assert.equal(opening.eyeM[1], 1200);
  assert.deepEqual(opening.targetM, [2000, 1000, -3000]);
  assert.equal(opening.fovYDeg, pose.fovYDeg);
  assert.deepEqual(opening, landRiseCamera(pose, { ...options, focusM: [-10000, 5000, -20000] }), 'a static cast summit cannot redirect a tour');
  const unmarked = { ...pose }; delete unmarked.tour;
  assert.deepEqual(landRiseCamera(unmarked, { ...options, overview: false }).eyeM, opening.eyeM,
    'a selected tour can identify an unmarked pose provider explicitly');
  const staticShots = landRiseCamera(pose, { ...options, overview: true });
  assert.deepEqual(staticShots.eyeM, opening.eyeM, 'generated shots keep the same source eye');
  assert.equal(landRiseCamera(pose, { ...options, rise01: .7 }).fovYDeg, pose.fovYDeg);
  assert.strictEqual(landRiseCamera(pose, { ...options, rise01: 1 }), pose);
});

test('the close opening clears growing ground and returns to exact authored clearance', () => {
  const pose = { eyeM: [10, 1900, 20], targetM: [2000, 3500, -3000], fovYDeg: 24 };
  const start = landRiseCamera(pose, { rise01: 0, baseM: 1000, groundM: 1800 });
  assert.equal(start.eyeM[1], 1100);
  assert.equal(start.targetM[1], 1000);
  const middle = landRiseCamera(pose, { rise01: .5, baseM: 1000, groundM: 1800 });
  assert.equal(middle.eyeM[1] - (1000 + .5 * (1800 - 1000)), 100);
  assert.equal(middle.targetM[1], 2250);
  const approached = landRiseCamera(pose, { rise01: .75, baseM: 1000, groundM: 1800 });
  assert.equal(approached.eyeM[1] - (1000 + .75 * (1800 - 1000)), 100);
  assert.equal(approached.eyeM[0], pose.eyeM[0]);
  assert.equal(approached.eyeM[2], pose.eyeM[2]);
  assert.strictEqual(landRiseCamera(pose, { rise01: 1, baseM: 1000, groundM: 1800 }), pose);
  assert.deepEqual(start, landRiseCamera(pose, { rise01: 0, baseM: 1000, groundM: 1800 }));
  assert.equal(pose.eyeM[1], 1900, 'sampling never changes the authored camera');
});

test('the floor stays fixed across rail/tour changes and accepts negative elevations', () => {
  const p = { modeWater: { rail: { waterLevelM: -30 } }, waterLevelM: 500, data: { manifest: { boundsM: { min: [0, -100, 0] } } } };
  assert.equal(landRiseBase(p), -30);
  p.modeWater.rail.waterLevelM = null;
  assert.equal(landRiseBase(p), -100);
  assert.equal(landRiseBase({}), 0);
  const pose = { eyeM: [0, 500, 0], targetM: [0, 1000, -2000] };
  assert.equal(landRiseCamera(pose, { rise01: 0, baseM: -100 }).eyeM[1], 500);
  assert.equal(landRiseCamera(pose, { rise01: .75, baseM: -100 }).eyeM[1], 500);
});

test('the opening close-up lets go on its own clock while the land keeps building', () => {
  const magnification = (rise, timeMs) => Math.tan(35 * Math.PI / 360) / Math.tan(landRiseFov(35, rise, timeMs) * Math.PI / 360);
  // Before the clock starts, and with no clock at all, framing follows rise alone.
  for (const rise of [0, .2, 1 / 3, .5]) {
    assert.equal(landRiseFov(35, rise, 0), landRiseFov(35, rise));
    assert.equal(landRiseFov(35, rise, OPENING_ZOOM_START_MS - 1), landRiseFov(35, rise));
  }
  assert.ok(Math.abs(magnification(0, 0) - 24) < 1e-9, 'flat ground opens at the full close-up');
  // A low land does not hold the close-up past the opening.
  const end = OPENING_ZOOM_START_MS + OPENING_ZOOM_MS;
  for (const rise of [0, 1 / 3, .5]) {
    assert.equal(landRiseFov(35, rise, end), 35, `authored lens by ${end} ms at ${rise} relief`);
    let last = Infinity;
    for (let t = OPENING_ZOOM_START_MS; t <= end; t += 100) {
      const m = magnification(rise, t);
      assert.ok(m <= last + 1e-12, 'the close-up only widens');
      assert.ok(rise * m <= 1 + 1e-12, 'and stays inside the terrain detail bound');
      last = m;
    }
  }
  // The summit aim releases on the same clock.
  const pose = { eyeM: [0, 1400, 5000], targetM: [0, 1800, 0], fovYDeg: 35 };
  const options = { rise01: 1 / 3, baseM: 1000, groundM: 1200, focusM: [800, 2400, -600], aspect: 16 / 9 };
  const held = landRiseCamera(pose, { ...options, timeMs: 0 }), released = landRiseCamera(pose, { ...options, timeMs: end });
  assert.notDeepEqual(held.targetM, released.targetM, 'the opening aims at the summit, then hands back the authored aim');
});
