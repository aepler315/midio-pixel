import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShotTour } from '../src/world/terrain/ShotPlanner.js';
import { buildShotTimeline, restoreShotTimeline, shotContinuation, shotTimelineData, progressProfile, SHOT_MOTION } from '../src/world/terrain/ShotTimeline.js';
import { pathPoseAt, lookDir, headingPitch } from '../src/world/terrain/ShotPath.js';
import { handleShotMessage } from '../src/world/terrain/shot-worker.js';
import { shotPlanRequest } from '../src/world/terrain/ShotRuntime.js';
import { shotLibraryFixture, anthemSong } from './fixtures/shot-library-fixture.mjs';

const library = shotLibraryFixture(), song = anthemSong();
const plan = (options = {}) => planShotTour(library, { ...song, ...options });
const timeline = plan();
const tl = buildShotTimeline(library, timeline);
const eyeAt = (t, i) => [t.eye[i * 3], t.eye[i * 3 + 1], t.eye[i * 3 + 2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const H = 1000 / 60;

// Eye acceleration from the 60 Hz second difference around time t.
const d2 = (poseAt, t) => { const a = poseAt(t - H).eyeM, b = poseAt(t).eyeM, c = poseAt(t + H).eyeM; return Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1], a[2] - 2 * b[2] + c[2]) / (H / 1000) ** 2; };
// Worst spike at a 100 ms key boundary: the 60 Hz acceleration across the
// boundary against the keys' own accelerations around it. A C1 Catmull-Rom
// stays within (2a_i - a_i+1 + 2a_i - a_i-1) / 2 <= 3x; linear interpolation
// turns a key's velocity change into 100 ms / (1/60 s) = 6x at the boundary.
function worstSpike(t, poseAt, fromMs = 0, toMs = t.durationMs) {
  const keyAcc = (i) => Math.hypot(...[0, 1, 2].map((k) => t.eye[(i + 1) * 3 + k] - 2 * t.eye[i * 3 + k] + t.eye[(i - 1) * 3 + k])) / .01;
  let worst = 0;
  for (let k = Math.max(2, Math.ceil(fromMs / 100)); k * 100 <= toMs && k < t.fov.length - 3; k++) {
    worst = Math.max(worst, d2(poseAt, k * 100) / (Math.max(keyAcc(k - 1), keyAcc(k), keyAcc(k + 1)) + .5));
  }
  return worst;
}

test('the progress profile hits its knots exactly with C1 speed', () => {
  const p = progressProfile([0, 10000, 25000, 40000], [0, 300, 900, 1200], { startSpeed: 20, startAccel: .5 });
  assert.equal(p.sAt(10000), 300); assert.equal(p.sAt(25000), 900); assert.equal(p.sAt(40000), 1200);
  assert.ok(Math.abs(p.vAt(0) - 20) < 1e-9 && Math.abs(p.aAt(0) - .5) < 1e-9);
  for (const t of [10000, 25000]) {
    assert.ok(Math.abs(p.vAt(t - 1e-6) - p.vAt(t + 1e-6)) < 1e-6, 'speed continuous');
    assert.ok(Math.abs(p.aAt(t - 1e-6) - p.aAt(t + 1e-6)) < 1e-4, 'acceleration continuous');
  }
  for (let t = 0; t < 40000; t += 50) assert.ok(Math.abs((p.sAt(t + 50) - p.sAt(t)) / .05 - p.vAt(t + 25)) < .01, 'speed is the slope of progress');
  assert.ok(Math.abs(p.timeAt(600) - 600) < 25000 && Math.abs(p.sAt(p.timeAt(600)) - 600) < 1e-6);
});

test('keyframes are complete, finite and continuous between 100 ms keys', () => {
  const count = Math.ceil(song.durationMs / 100) + 1;
  assert.equal(tl.fov.length, count); assert.equal(tl.eye.length, count * 3); assert.equal(tl.meta.length, count * 4);
  assert.ok([...tl.eye, ...tl.target, ...tl.fov].every(Number.isFinite));
  for (let i = 0; i < count; i++) {
    const item = tl.items[tl.meta[i * 4]];
    assert.ok(item, `key ${i} item`);
    assert.equal(tl.meta[i * 4 + 1], item.kind === 'link' ? 1 : 0);
    if (i) assert.ok(dist(eyeAt(tl, i), eyeAt(tl, i - 1)) <= Math.max(tl.speed[i], tl.speed[i - 1]) * .1 + 1, `jump at key ${i}`);
  }
  const pose = tl.poseAt(60000);
  assert.deepEqual(Object.keys(pose), ['eyeM', 'targetM', 'fovYDeg', 'tour', 'shot']);
  assert.equal(pose.tour, true);
  assert.deepEqual(Object.keys(pose.shot), ['itemIndex', 'kind', 'id', 'subjectId', 'phase']);
  assert.ok(dist(pose.eyeM, pose.targetM) < 20000, 'the target is the path aim point, not a far projection');
});

test('poseAt is C1 across keys at 60 Hz (linear interpolation of the same keys is not)', () => {
  assert.ok(worstSpike(tl, tl.poseAt) < 3, 'no second-difference spike at key boundaries');
  const linear = (t) => {
    const i = Math.min(tl.fov.length - 2, Math.floor(t / 100)), u = (t - i * 100) / 100;
    return { eyeM: [0, 1, 2].map((k) => tl.eye[i * 3 + k] + (tl.eye[(i + 1) * 3 + k] - tl.eye[i * 3 + k]) * u) };
  };
  assert.ok(worstSpike(tl, linear) > 4.5, 'negative control: linear keys spike');
});

test('speed, acceleration, yaw and image flow stay within the motion limits', () => {
  const m = SHOT_MOTION;
  for (const seed of [1, 2, 3, 4, 5]) {
    const lib = seed === 1 ? library : shotLibraryFixture({ seed }), t = seed === 1 ? tl : buildShotTimeline(lib, planShotTour(lib, song)), d = t.diagnostics;
    assert.ok(d.maxProgressSpeedMps <= m.maxSpeedMps && d.maxSpeedMps <= m.maxSpeedMps + .5, 'speed');
    assert.ok(d.minSpeedMps >= m.minSpeedMps - 1e-6, 'never slower than the minimum speed');
    assert.ok(d.maxProgressAccelMps2 <= m.maxAccelMps2 + 1e-6, 'profile acceleration');
    // The eye's own speed: the profile's acceleration plus bend * v^2 where a
    // path trades flying for panning (5% for the 50 ms finite difference).
    assert.ok(d.maxAccelMps2 <= m.maxAccelMps2 * 1.05, `fixture ${seed}: eye acceleration ${d.maxAccelMps2}`);
    assert.ok(Number.isFinite(d.maxLateralAccelMps2), 'sideways acceleration is reported');
    assert.ok(d.maxYawDegPerSec <= m.maxYawDegPerSec, 'yaw');
    assert.ok(d.maxFlowRatio <= 1.05, `image flow ${d.maxFlowRatio} within its comfort limit`);
    // Independently from rendered poses at 10 Hz: speed, its change, yaw.
    let prev = null, prevSpeed = null;
    for (let at = 0; at <= t.durationMs; at += 100) {
      const p = t.poseAt(at), look = headingPitch(lookDir(p));
      if (prev) {
        const v = dist(p.eyeM, prev.p.eyeM) / .1;
        assert.ok(v <= m.maxSpeedMps + .5);
        if (prevSpeed !== null) assert.ok(Math.abs(v - prevSpeed) / .1 <= m.maxAccelMps2 * 1.05, `fixture ${seed}: eye speed change at ${at} ms`);
        assert.ok(Math.abs(((look.headingDeg - prev.look.headingDeg + 540) % 360) - 180) / .1 <= m.maxYawDegPerSec);
        prevSpeed = v;
      }
      prev = { p, look };
    }
  }
});

test('every payoff happens exactly at its planned time', () => {
  assert.ok(tl.payoffs.length >= 3);
  assert.ok(tl.diagnostics.payoffErrorMs < 1);
  for (const p of tl.payoffs) {
    // actualMs is read back from the sampled progress lane.
    const i = p.plannedMs / 100;
    assert.ok(Math.abs(p.actualMs - p.plannedMs) < 1 && tl.meta[i * 4] === p.itemIndex && Math.abs(tl.progress[i] - library.shotById.get(p.shotId).payoffS) < 1e-6);
    const shot = library.shotById.get(p.shotId), want = pathPoseAt(shot.path, shot.payoffS), got = tl.poseAt(p.plannedMs);
    assert.ok(dist(got.eyeM, want.eyeM) < .05 && dist(got.targetM, want.targetM) < .05, `${p.shotId} framed at its payoff`);
    const state = tl.stateAt(p.plannedMs);
    assert.deepEqual([state.kind, state.id, state.phase, state.subjectId], ['shot', p.shotId, 'payoff', shot.subjectId]);
    if (p.moment >= 0) assert.ok(Math.abs(p.plannedMs - timeline.moments[p.moment].timeMs) <= 150);
  }
});

test('off-screen passes are no payoffs; freezing beyond the plan start is refused', () => {
  const visible = [{ startMs: 100000, endMs: song.durationMs }];
  const p = plan({ visible }), t = buildShotTimeline(library, p);
  const hidden = p.items.filter((it) => it.kind === 'shot' && it.hidden);
  assert.ok(hidden.length >= 1, 'the off-screen span passes some shot payoffs');
  assert.ok(t.payoffs.every((x) => visible.some((v) => x.plannedMs >= v.startMs && x.plannedMs <= v.endMs)), 'only on-screen payoffs are reported');
  for (const it of hidden) {
    const i = it.payoffMs / 100;
    assert.ok(t.knots.some((k) => k.timeMs === it.payoffMs), 'still a knot of the profile');
    assert.notEqual(t.meta[i * 4 + 2], 1, 'no payoff phase off screen');
  }
  const start = shotContinuation(tl, 40000);
  assert.throws(() => buildShotTimeline(library, plan({ start }), { previous: tl, frozenThroughMs: start.timeMs + 100 }), /beyond the plan's start/);
});

test('timelines are deterministic and survive structured cloning', () => {
  const again = buildShotTimeline(library, plan());
  for (const k of ['eye', 'target', 'fov', 'meta', 'progress', 'speed']) assert.deepEqual(again[k], tl[k]);
  const clone = restoreShotTimeline(structuredClone(shotTimelineData(tl)));
  for (let t = 0; t <= tl.durationMs; t += 1234) assert.deepEqual(clone.poseAt(t), tl.poseAt(t));
});

test('a replan keeps every committed key bit for bit and continues without a jump', () => {
  const start = shotContinuation(tl, 40000);
  assert.equal(start.timeMs, 43000);
  const changed = plan({ seed: 7, start, sections: song.sections.map((s) => ({ ...s })), roles: song.roles.map((r, i) => ({ ...r, finalChorus: i === 7 })) });
  assert.equal(changed.items[0].id, start.id);
  const next = buildShotTimeline(library, changed, { previous: tl, frozenThroughMs: start.timeMs });
  const k = start.timeMs / 100;
  for (const [lane, size] of [['eye', 3], ['target', 3], ['fov', 1], ['meta', 4], ['progress', 1], ['speed', 1]]) {
    assert.deepEqual(next[lane].subarray(0, (k + 1) * size), tl[lane].subarray(0, (k + 1) * size), `${lane} frozen`);
  }
  for (let t = 0; t <= start.timeMs - 100; t += 37) assert.deepEqual(next.poseAt(t).eyeM, tl.poseAt(t).eyeM);
  for (let i = 0; i < next.fov.length; i++) assert.ok(next.items[next.meta[i * 4]], 'meta points at a timeline item');
  for (let i = k - 5; i <= k + 20; i++) assert.ok(dist(eyeAt(next, i + 1), eyeAt(next, i)) <= Math.max(next.speed[i], next.speed[i + 1]) * .1 + 1);
  assert.ok(Math.abs(next.speed[k + 1] - tl.speed[k + 1]) < SHOT_MOTION.maxAccelMps2 * .1 * .1, 'same speed and acceleration across the horizon');
  assert.ok(worstSpike(next, next.poseAt, start.timeMs - 1000, start.timeMs + 1000) < 3, 'C1 across the horizon');
  assert.ok(next.diagnostics.maxProgressAccelMps2 <= SHOT_MOTION.maxAccelMps2 + 1e-6);
  for (const p of next.payoffs.filter((x) => x.plannedMs > start.timeMs)) assert.ok(Math.abs(p.actualMs - p.plannedMs) < 1);
});

test('rapid replans: each keeps its predecessor through its horizon and continues smoothly', () => {
  let prev = tl;
  for (const [committed, seed] of [[40000, 7], [40400, 8], [41000, 9]]) {
    const start = shotContinuation(prev, committed), k = start.timeMs / 100;
    const next = buildShotTimeline(library, plan({ seed, start }), { previous: prev, frozenThroughMs: start.timeMs });
    for (const [lane, size] of [['eye', 3], ['target', 3], ['fov', 1], ['meta', 4], ['progress', 1], ['speed', 1], ['accel', 1]]) {
      assert.deepEqual(next[lane].subarray(0, (k + 1) * size), prev[lane].subarray(0, (k + 1) * size), `${committed}: ${lane} frozen`);
    }
    for (let i = 0; i < next.fov.length; i++) {
      const item = next.items[next.meta[i * 4]];
      assert.ok(item && next.meta[i * 4 + 1] === (item.kind === 'link' ? 1 : 0), `${committed}: key ${i} item`);
    }
    for (const p of next.payoffs) assert.equal(next.items[p.itemIndex].id, p.shotId, `${committed}: payoff item`);
    for (let i = k - 3; i <= k + 10; i++) assert.ok(dist(eyeAt(next, i + 1), eyeAt(next, i)) <= Math.max(next.speed[i], next.speed[i + 1]) * .1 + 1, `${committed}: step at key ${i}`);
    assert.ok(worstSpike(next, next.poseAt, start.timeMs - 1000, start.timeMs + 1000) < 3, `${committed}: C1 across the horizon`);
    prev = next;
  }
});

test('the worker handler plans, replans from the commit horizon and defers at the end', () => {
  const mgr = { sections: song.sections, durationMs: song.durationMs, energyCurves: { globalEnergy: (t) => song.energy[Math.round(t / 100)] } };
  const request = shotPlanRequest(library, mgr, { seed: 0 });
  assert.ok(!Object.values(request.library).some((v) => v instanceof Map), 'the library crosses postMessage without its Maps');
  const first = handleShotMessage(structuredClone(request));
  assert.ok(first.message.timeline && !first.message.error);
  assert.ok(first.transfer.includes(first.message.timeline.eye.buffer) && first.transfer.includes(first.message.timeline.meta.buffer));
  const committed = restoreShotTimeline(structuredClone(first.message.timeline));
  assert.ok(committed.payoffs.some((p) => p.plannedMs === 128000), 'roles from sectionRoles, energy from the curves');

  const replan = handleShotMessage(structuredClone(shotPlanRequest(library, mgr, { seed: 4, previous: committed, committedThroughMs: 70000 })));
  const next = restoreShotTimeline(replan.message.timeline), k = 73000 / 100;
  assert.deepEqual(next.eye.subarray(0, (k + 1) * 3), committed.eye.subarray(0, (k + 1) * 3));
  assert.deepEqual(next.meta.subarray(0, (k + 1) * 4), committed.meta.subarray(0, (k + 1) * 4));
  assert.ok(dist(eyeAt(next, k + 1), eyeAt(next, k)) <= next.speed[k] * .1 + 1);

  // With no feasible continuation the committed timeline is kept whole.
  const stuck = handleShotMessage(structuredClone(shotPlanRequest(library, mgr, { seed: 4, previous: committed, committedThroughMs: 70000, tunables: { maxSpeedMps: .3, minSpeedMps: .1 } })));
  assert.deepEqual(stuck.message.timeline.eye, committed.eye);
  assert.match(stuck.message.timeline.notes.at(-1), /Refinement deferred: no feasible/);

  const late = handleShotMessage(structuredClone(shotPlanRequest(library, mgr, { previous: committed, committedThroughMs: 168000 })));
  assert.deepEqual(late.message.timeline.eye, committed.eye, 'nothing left to replan keeps the committed timeline');
  assert.match(late.message.timeline.notes.at(-1), /deferred/);
  assert.match(handleShotMessage({ library: null }).message.error, /./);
});

test('replans from every commit time keep the committed motion and never ship a fallback', () => {
  for (const seed of [1, 2, 3]) {
    const lib = seed === 1 ? library : shotLibraryFixture({ seed });
    const mgr = { sections: song.sections, durationMs: song.durationMs, energyCurves: { globalEnergy: (t) => song.energy[Math.round(t / 100)] } };
    // Refined sections: every boundary moved by 1.5 s (as RangeShotTours.refine sees them).
    const moved = song.sections.map((s, i) => ({ ...s, startMs: i ? s.startMs + (i % 2 ? 1500 : -1500) : 0 }));
    const refined = { ...mgr, sections: moved.map((s, i) => ({ ...s, endMs: moved[i + 1]?.startMs ?? song.durationMs })) };
    const first = restoreShotTimeline(structuredClone(handleShotMessage(structuredClone(shotPlanRequest(lib, mgr, { seed: 0 }))).message.timeline));
    let replanned = 0;
    for (const m of [mgr, refined]) {
      for (let c = 0; c < 165000; c += 7500) {
        const next = handleShotMessage(structuredClone(shotPlanRequest(lib, m, { seed: 0, previous: first, committedThroughMs: c }))).message.timeline;
        assert.ok(next && !next.fallback, `fixture ${seed} at ${c}: no fallback shipped`);
        if (/Refinement deferred/.test(next.notes.at(-1))) { assert.deepEqual(next.eye, first.eye); continue; }
        replanned++;
        const k = Math.ceil((c + 3000) / 100);
        assert.deepEqual(next.eye.subarray(0, (k + 1) * 3), first.eye.subarray(0, (k + 1) * 3), `fixture ${seed} at ${c}: frozen prefix`);
        assert.ok(next.diagnostics.maxProgressAccelMps2 <= SHOT_MOTION.maxAccelMps2 + 1e-6, `fixture ${seed} at ${c}: acceleration`);
        for (let i = k - 2; i <= k + 20; i++) assert.ok(dist(eyeAt(next, i + 1), eyeAt(next, i)) <= Math.max(next.speed[i], next.speed[i + 1]) * .1 + 1, `fixture ${seed} at ${c}: step at key ${i}`);
      }
    }
    assert.ok(replanned >= 40, `fixture ${seed}: ${replanned} replans applied (the rest deferred)`);
  }
});
