import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCameraMoves, cameraMoveKeys, rangeCameraMoveAt, RangeUserCamera,
  NEUTRAL_MOVE, OPENING_MOVE, MOVE_LIMITS, MIN_MOVE_MS, MOVE_TRAVEL_MS, USER_FX_MAX,
} from '../src/world/alpine/RangeCamera.js';
import { wheelZoomFactor } from '../src/ui/RangeZoomInput.js';
import { cameraBasis, projectPoint } from '../src/world/terrain/SceneTravel.js';

const SECTIONS = [0, 20000, 24000, 50000, 90000, 140000].map((startMs, i) => ({ startMs, relEnergy01: (i % 3) / 2 }));
const DUR = 180000;
const POSE = { eyeM: [0, 1500, 20000], targetM: [0, 2500, 0], fovYDeg: 35 };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('moves open risen, end on the wide risen finale, and stay inside their limits', () => {
  const keys = cameraMoveKeys(SECTIONS, DUR, 7);
  assert.deepEqual(keys[0], { fromMs: 0, tMs: 0, ...OPENING_MOVE });
  assert.equal(keys[1].kind, 'establish');
  assert.ok(keys[1].crane < OPENING_MOVE.crane, 'the opening settles down into the land');
  const last = keys.at(-1);
  assert.equal(last.tMs, DUR);
  assert.equal(last.kind, 'finale');
  assert.equal(last.dolly, 0);
  assert.ok(last.crane > 0);
  for (const k of keys) {
    for (const [name, [lo, hi]] of Object.entries(MOVE_LIMITS)) {
      assert.ok(k[name] >= lo - 1e-9 && k[name] <= hi + 1e-9, `${name} ${k[name]} outside ${lo}..${hi}`);
    }
  }
});

test('moves start on structural turns, far apart, and travel then hold', () => {
  const keys = cameraMoveKeys(SECTIONS, DUR, 7);
  const starts = keys.slice(1, -1).map((k) => k.fromMs);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= MIN_MOVE_MS);
  for (const t of starts) assert.ok(SECTIONS.some((s) => s.startMs === t), `move at ${t} is not on a section boundary`);
  assert.ok(!starts.includes(24000), 'a section 4 s after another must not start its own move');
  for (let i = 1; i < keys.length; i++) {
    assert.ok(keys[i].fromMs >= keys[i - 1].tMs, 'moves never overlap');
    if (keys[i].kind !== 'finale') assert.ok(keys[i].tMs - keys[i].fromMs >= MOVE_TRAVEL_MS[0] - 1e-9 && keys[i].tMs - keys[i].fromMs <= MOVE_TRAVEL_MS[1]);
  }
  // Between moves the camera holds perfectly still.
  const at = (t) => rangeCameraMoveAt({ timeMs: t, sections: SECTIONS, durationMs: DUR, seed: 7 });
  const k = keys[1], next = keys[2];
  assert.ok(next.fromMs > k.tMs + 1000, 'a hold follows the first move');
  assert.deepEqual(at(k.tMs + 1), at(next.fromMs - 1));
  assert.equal(at(k.tMs + 1).kind, 'hold');
});

test('the biggest energy change wins a crowded stretch', () => {
  const secs = [{ startMs: 0, relEnergy01: 0.5 }, { startMs: 30000, relEnergy01: 0.55 }, { startMs: 38000, relEnergy01: 1 }, { startMs: 90000, relEnergy01: 0.5 }];
  const keys = cameraMoveKeys(secs, DUR, 1);
  const starts = keys.slice(1, -1).map((k) => k.fromMs);
  assert.ok(starts.includes(38000) && !starts.includes(30000), String(starts));
});

test('a falling section pulls back and rises', () => {
  const keys = cameraMoveKeys([{ startMs: 0, relEnergy01: 0.5 }, { startMs: 30000, relEnergy01: 1 }, { startMs: 80000, relEnergy01: 0.1 }], DUR, 3);
  const push = keys.find((k) => k.fromMs === 30000), back = keys.find((k) => k.fromMs === 80000);
  assert.equal(back.kind, 'pullback');
  assert.ok(back.dolly < push.dolly && back.crane > push.crane);
});

test('the move is a continuous pure function of heard time', () => {
  const at = (t) => rangeCameraMoveAt({ timeMs: t, sections: SECTIONS, durationMs: DUR, seed: 7 });
  assert.deepEqual(at(61234), at(61234));
  for (let t = 0; t < DUR; t += 250) {
    const a = at(t), b = at(t + 250);
    for (const k of ['dolly', 'yaw', 'crane', 'truck']) assert.ok(Math.abs(a[k] - b[k]) < 0.004, `${k} jumps at ${t}`);
  }
});

test('reduced motion and previews hold the authored camera', () => {
  assert.equal(rangeCameraMoveAt({ timeMs: 50000, sections: SECTIONS, durationMs: DUR, reducedMotion: true }), NEUTRAL_MOVE);
  assert.equal(rangeCameraMoveAt({ timeMs: 50000, sections: SECTIONS, durationMs: DUR, preview: true }), NEUTRAL_MOVE);
  assert.equal(rangeCameraMoveAt({ timeMs: 50000, sections: SECTIONS, durationMs: 0 }), NEUTRAL_MOVE);
});

test('a neutral move and no zoom leave the rail pose alone', () => {
  const out = applyCameraMoves(POSE, NEUTRAL_MOVE, null);
  assert.deepEqual(out.eyeM, POSE.eyeM);
  assert.deepEqual(out.targetM, POSE.targetM);
});

test('a push brings the eye toward the target; an orbit keeps its distance', () => {
  const D = dist(POSE.eyeM, POSE.targetM);
  const push = applyCameraMoves(POSE, { dolly: 0.1, yaw: 0, crane: 0, truck: 0 }, null);
  assert.ok(Math.abs(dist(push.eyeM, push.targetM) - 0.9 * D) < 1e-6);
  const orbit = applyCameraMoves(POSE, { dolly: 0, yaw: 0.05, crane: 0, truck: 0 }, null);
  assert.ok(Math.abs(dist(orbit.eyeM, orbit.targetM) - D) < 1e-6);
  assert.notEqual(orbit.eyeM[0], POSE.eyeM[0]);
});

test('a move never sinks the eye into a hillside', () => {
  // Open valley under the rail, a ridge just beside it.
  const ridge = (x) => (Math.abs(x) > 100 ? 1480 : 1000);
  const out = applyCameraMoves(POSE, { dolly: 0, yaw: 0, crane: 0, truck: 0.02 }, null, { heightAt: ridge });
  assert.ok(Math.abs(out.eyeM[0]) > 100);
  assert.ok(out.eyeM[1] >= 1480 + 250 - 1e-9);
});

test('the zoom flies along the pointer ray, so the point under the pointer stays put', () => {
  const cam = new RangeUserCamera({ now: () => 0 });
  const tanY = Math.tan((35 * Math.PI) / 360);
  cam.noteFrame({ tanX: tanY * 16 / 9, tanY });
  cam.zoomAt(1.5, 0.4, -0.3);
  const user = { ...cam.target };
  const out = applyCameraMoves(POSE, null, user);
  // A point on the original pointer ray, far beyond the zoom distance.
  const { forward, right, up } = cameraBasis(POSE);
  const ray = forward.map((f, i) => f + right[i] * 0.4 * tanY * 16 / 9 + up[i] * -0.3 * tanY);
  const far = POSE.eyeM.map((v, i) => v + ray[i] * 60000);
  const before = projectPoint(POSE, 16 / 9, far), after = projectPoint(out, 16 / 9, far);
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6);
  assert.ok(Math.abs(after.x - 0.4) < 1e-6 && Math.abs(after.y + 0.3) < 1e-6);
});

test('the zoom stays inside the authored view cone, so the frame never leaves the map', () => {
  const cam = new RangeUserCamera({ now: () => 0 });
  for (let i = 0; i < 40; i++) cam.zoomAt(1.3, 1, 1);
  const { fx, rx, uy } = cam.target;
  assert.ok(fx <= USER_FX_MAX + 1e-9);
  assert.ok(Math.abs(rx) <= fx * cam.tan.x + 1e-9 && Math.abs(uy) <= fx * cam.tan.y + 1e-9);
  for (let i = 0; i < 80; i++) cam.zoomAt(1 / 1.3, -1, 0);
  assert.deepEqual(cam.target, { fx: 0, rx: 0, uy: 0 });
});

test('the zoom stops short of the ground instead of flying into it', () => {
  const slope = (x, z) => 1000 + Math.max(0, 15000 - z) * 0.2; // rising toward the target
  const out = applyCameraMoves(POSE, null, { fx: USER_FX_MAX, rx: 0, uy: -0.1 }, { heightAt: slope });
  assert.ok(out.userScale < 1);
  assert.ok(out.eyeM[1] >= slope(out.eyeM[0], out.eyeM[2]) + 249);
  assert.ok(out.userScale > 0);
});

test('the zoom eases instead of snapping', () => {
  let now = 0;
  const cam = new RangeUserCamera({ now: () => now });
  cam.sample();
  cam.zoomAt(2);
  now = 16;
  const a = cam.sample();
  assert.ok(a.fx > 0 && a.fx < cam.target.fx);
  now = 5000;
  assert.equal(cam.sample().fx, cam.target.fx);
});

test('wheel deltas map to gentle zoom factors in every delta mode', () => {
  assert.ok(wheelZoomFactor({ deltaY: -100 }) > 1);
  assert.ok(wheelZoomFactor({ deltaY: 100 }) < 1);
  assert.equal(wheelZoomFactor({ deltaY: -3, deltaMode: 1 }), wheelZoomFactor({ deltaY: -48 }));
  assert.equal(wheelZoomFactor({ deltaY: -100000 }), 2);
});

test('a loud section pushes in', () => {
  const keys = cameraMoveKeys([{ startMs: 0, relEnergy01: 0.2 }, { startMs: 30000, relEnergy01: 1 }, { startMs: 80000, relEnergy01: 0.2 }], DUR, 3);
  const loud = keys.find((k) => k.fromMs === 30000);
  assert.equal(loud.kind, 'push');
  assert.ok(loud.dolly > 0.1);
});

test('a narrow ridge between coarse samples still stops the zoom', () => {
  // A 40 m wide wall halfway along a long flight.
  const wall = (x, z) => (Math.abs(z - 9000) < 20 ? 5000 : 0);
  const out = applyCameraMoves(POSE, null, { fx: USER_FX_MAX, rx: 0, uy: 0 }, { heightAt: wall, sampleStepM: 30 });
  assert.ok(out.userScale < 1);
  assert.ok(out.eyeM[2] > 9000);
});

test('a narrower view re-clamps an edge zoom into its cone', () => {
  const cam = new RangeUserCamera({ now: () => 0 });
  cam.noteFrame({ tanX: 0.56, tanY: 0.315 });
  for (let i = 0; i < 10; i++) cam.zoomAt(1.3, 1, 1);
  cam.current = { ...cam.target };
  cam.noteFrame({ tanX: 0.25, tanY: 0.14 });
  for (const o of [cam.target, cam.current]) {
    assert.ok(Math.abs(o.rx) <= o.fx * 0.25 + 1e-9 && Math.abs(o.uy) <= o.fx * 0.14 + 1e-9);
  }
});

test('a low authored eye can still zoom forward over flat ground', () => {
  const low = { eyeM: [0, 1060, 20000], targetM: [0, 1200, 0], fovYDeg: 35 };
  const gentle = (x, z) => 1000 + (20000 - z) * 0.001; // rises 1 m per km
  const out = applyCameraMoves(low, null, { fx: 0.3, rx: 0, uy: 0 }, { heightAt: gentle });
  assert.ok(out.userScale > 0.9);
});

test('zooming in at the cap does not turn into a sideways pan', () => {
  const cam = new RangeUserCamera({ now: () => 0 });
  for (let i = 0; i < 40; i++) cam.zoomAt(1.5, 0, 0);
  const before = { ...cam.target };
  cam.zoomAt(1.5, 1, 0);
  assert.deepEqual(cam.target, before);
});

test('a move in a low-authored view still clears a mesa', () => {
  const low = { eyeM: [0, 1060, 20000], targetM: [0, 1200, 0], fovYDeg: 35 };
  const mesa = (x) => (Math.abs(x) > 100 ? 1300 : 1000);
  const out = applyCameraMoves(low, { dolly: 0, yaw: 0, crane: 0, truck: 0.02 }, null, { heightAt: mesa });
  assert.ok(out.eyeM[1] >= 1300 + 30 - 1e-9);
});

test('during view travel the narrower view and shorter flight win within a frame', () => {
  const cam = new RangeUserCamera({ now: () => 0 });
  cam.noteFrame({ tanX: 0.3, tanY: 0.2, userScale: 0.5, frameId: 7 });
  cam.noteFrame({ tanX: 0.6, tanY: 0.4, userScale: 1, frameId: 7 });
  assert.deepEqual(cam.tan, { x: 0.3, y: 0.2 });
  assert.equal(cam.userScale, 0.5);
  cam.noteFrame({ tanX: 0.6, tanY: 0.4, userScale: 1, frameId: 8 });
  assert.deepEqual(cam.tan, { x: 0.6, y: 0.4 });
});

test('zooming out at the same pointer retraces the zoom in', () => {
  const cam = new RangeUserCamera({ now: () => 0 });
  cam.noteFrame({ tanX: 0.56, tanY: 0.315 });
  cam.zoomAt(1.5, 0.5, -0.4);
  cam.zoomAt(1 / 1.5, 0.5, -0.4);
  for (const k of ['fx', 'rx', 'uy']) assert.ok(Math.abs(cam.target[k]) < 1e-9, k);
});

test('a view clamps the zoom snapshot into its own cone', () => {
  const user = { fx: 0.5, rx: 0.3, uy: 0 };
  const wide = applyCameraMoves(POSE, null, user);
  const narrow = applyCameraMoves(POSE, null, user, { cone: { tanX: 0.2, tanY: 0.1 } });
  const lateral = (o) => { const { right } = cameraBasis(POSE); return o.eyeM.reduce((s, v, i) => s + (v - POSE.eyeM[i]) * right[i], 0); };
  const D = dist(POSE.eyeM, POSE.targetM);
  assert.ok(lateral(narrow) <= 0.5 * 0.2 * D + 1e-6);
  assert.ok(lateral(wide) > lateral(narrow));
});

test('a short song makes no move shorter than the minimum before its finale', () => {
  const keys = cameraMoveKeys([{ startMs: 0, relEnergy01: 1 }], 21000, 1);
  assert.deepEqual(keys.map((k) => k.kind), ['rest', 'finale']);
  const keys2 = cameraMoveKeys([{ startMs: 0, relEnergy01: 1 }, { startMs: 8000, relEnergy01: 0 }], 60000, 1);
  assert.deepEqual(keys2.map((k) => k.kind), ['rest', 'establish', 'finale']);
});

test('a low view keeps the deformation pad over high ground, not over its floor', () => {
  const low = { eyeM: [0, 1060, 20000], targetM: [0, 1200, 0], fovYDeg: 35 };
  const mesa = (x) => (Math.abs(x) > 100 ? 1300 : 1000);
  const out = applyCameraMoves(low, { dolly: 0, yaw: 0, crane: 0, truck: 0.02 }, null, { heightAt: mesa, heightRangeM: [1000, 1300] });
  assert.ok(out.eyeM[1] >= 1300 + 50 + 180 - 1e-9);
  const flat = applyCameraMoves(low, null, { fx: 0.3, rx: 0, uy: 0 }, { heightAt: () => 1000, heightRangeM: [1000, 1300] });
  assert.ok(flat.userScale > 0.9);
});
