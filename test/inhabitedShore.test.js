import test from 'node:test';
import assert from 'node:assert/strict';
import { SEA_TOP_FRAC, SKY_BOTTOM_FRAC, shoreTopY, shipPose, broshiPose, midasusPose, kickHop01 } from '../src/world/InhabitedShore.js';
import { resolveLandscapePresentation } from '../src/world/LandscapePresentation.js';

const W = 1280, H = 720;

test('the frame divides into thirds: sky, land, sea', () => {
  assert.equal(SKY_BOTTOM_FRAC, 1 / 3);
  assert.equal(SEA_TOP_FRAC, 2 / 3);
  for (let x = 0; x <= W; x += 40) {
    const y = shoreTopY(x, W, H);
    assert.ok(y < H * SEA_TOP_FRAC && y > H * 0.6, `beach edge sits just above the sea at x=${x}`);
  }
});

test('each resident keeps to its own third for the whole song', () => {
  for (let t = 0; t < 600; t += 0.37) {
    const ship = shipPose(t, W, H, { bass: 1, energy: 1 });
    assert.ok(ship.y > H * SEA_TOP_FRAC && ship.y < H, `ship on the sea at ${t}`);
    const broshi = broshiPose(t, W, H, { kick: 1 });
    assert.ok(broshi.y > H * 0.55 && broshi.y < H * SEA_TOP_FRAC, `Broshi on the beach at ${t}`);
    assert.ok(broshi.x >= W * 0.1 - 1e-6 && broshi.x <= W * 0.5 + 1e-6);
    const midasus = midasusPose(t, W, H, { treble: 1 });
    assert.ok(midasus.y > 0 && midasus.y < H * SKY_BOTTOM_FRAC, `Midasus in the sky at ${t}`);
  }
});

test('poses are pure functions of heard time, so seek and export agree', () => {
  for (const t of [0, 12.5, 61, 300]) {
    assert.deepEqual(shipPose(t, W, H, { bass: .4 }), shipPose(t, W, H, { bass: .4 }));
    assert.deepEqual(broshiPose(t, W, H), broshiPose(t, W, H));
    assert.deepEqual(midasusPose(t, W, H), midasusPose(t, W, H));
  }
});

test('the ship travels: it crosses the sea left to right and comes round again', () => {
  const xs = [];
  for (let t = 0; t < 64; t += 1) xs.push(shipPose(t, W, H).x);
  const wraps = xs.slice(1).filter((x, i) => x < xs[i]).length;
  assert.equal(wraps, 1, 'one wrap per crossing');
  assert.ok(Math.max(...xs) > W && Math.min(...xs) < 0, 'it sails fully out of frame before returning');
});

test('Broshi walks both ways and stops to look up', () => {
  const poses = Array.from({ length: 300 }, (_, i) => broshiPose(i * 0.1, W, H));
  assert.ok(poses.some(p => p.facing === 1 && p.walking));
  assert.ok(poses.some(p => p.facing === -1 && p.walking));
  assert.ok(poses.some(p => !p.walking && p.lookUp01 > 0.9));
});

test('reduced motion removes bobbing, pitching and hops but keeps travel', () => {
  const a = shipPose(10, W, H, { bass: 1, reducedMotion: true });
  const b = shipPose(20, W, H, { bass: 1, reducedMotion: true });
  assert.equal(a.rot, 0);
  assert.equal(a.y, b.y);
  assert.notEqual(a.x, b.x);
  assert.equal(broshiPose(3, W, H, { kick: 1, reducedMotion: true }).airborne, 0);
});

test('a kick lifts Broshi briefly and lands him again', () => {
  const hits = [{ tMs: 1000, strength: 1 }];
  assert.equal(kickHop01(hits, 990), 0);
  assert.ok(kickHop01(hits, 1150) > 0.99);
  assert.equal(kickHop01(hits, 1300), 0);
  assert.equal(kickHop01([], 1000), 0);
});

test('listening leaves the landscape clear of the foreground sea and shore residents', () => {
  assert.equal(resolveLandscapePresentation('alpine').inhabitants, false);
  assert.equal(resolveLandscapePresentation('alpine').performers, false);
  assert.equal(resolveLandscapePresentation('fathom').performers, false);
  // Their owners were removed; enabling these dereferences null.
  assert.equal(resolveLandscapePresentation('alpine').decorativeActors, false);
  assert.equal(resolveLandscapePresentation('alpine').artificialNearProps, false);
});

test('a second kick mid-hop never drops Broshi back to the sand', () => {
  const hits = [{ tMs: 1150, strength: 1 }, { tMs: 1000, strength: 1 }];
  assert.ok(kickHop01(hits, 1150) > 0.99, 'still at the first arc apex when the next kick lands');
  let prev = kickHop01(hits, 1000);
  for (let t = 1001; t < 1450; t++) {
    const v = kickHop01(hits, t);
    assert.ok(Math.abs(v - prev) < 0.02, `continuous at ${t}`);
    prev = v;
  }
});

test('reduced motion holds the baby stars in place around Midasus', () => {
  const rel = (t) => {
    const p = midasusPose(t, W, H, { reducedMotion: true });
    return p.babies.map((b, i) => {
      const lagged = midasusPose(t - [0.55, 0.95, 1.35][i], W, H, { reducedMotion: true });
      return [b.x - lagged.x, b.y - (lagged.y)];
    });
  };
  const a = rel(10), b = rel(11.3);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(a[i][0] - b[i][0]) < 1e-9 && Math.abs(a[i][1] - b[i][1]) < 1e-9, `baby ${i} orbit frozen`);
  }
});
