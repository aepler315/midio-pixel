// Tour forest windows (src/world/alpine/TourForest.js): which mesh-ring
// trees a static view's shot tour draws as meshes, on synthetic forests and
// timelines with sharp turns, fast travel and large spline overshoot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TourForestSchedule, windowSet, crDeviation, simplify3, polylineDist2, tourMeshVisible, tourKey, tourWindowCount,
  TOUR_MARGIN_M, TOUR_TAU_M, TOUR_EPS_M, TOUR_WINDOW_MS, TOUR_FADE_MS,
} from '../src/world/alpine/TourForest.js';
import { SHOT_KEY_MS } from '../src/world/terrain/ShotTimeline.js';
import { rng, keyTimeline, wanderKeys, syntheticPlaced, syntheticIndex, r2Sweep, stateBits, bitOf } from './helpers/tourForestFixtures.mjs';

let shared = null;
function forest() {
  if (shared) return shared;
  const placed = syntheticPlaced();
  shared = { placed, index: syntheticIndex(placed) };
  return shared;
}
// 300 m/s with a turn every 1.2 s, and 800 m back-and-forth steps in
// window 5 (a spline overshoot of 100 m past the keys).
const FAST = { durationMs: 40000, speed: 300, shuttle: [200, 236] };
const fastTour = () => keyTimeline(wanderKeys(FAST), FAST.durationMs);
const scheduleFor = (index, tl, options) => { const s = new TourForestSchedule(index, options); s.setTimeline(tl); return s; };
const sameBits = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

/** Zig-zag keys: a sharp turn on the second segment and on the third from
 *  last (the ends' reflections decide them), and between, short steps
 *  between long reversals, where the curve leaves its chord by exactly the
 *  bound. */
function zigzagKeys() {
  const keys = [[0, 0, 0], [0, 0, 10], [600, 0, 10], [1200, 0, 10]];
  for (let i = 0; i < 6; i++) {
    const [x, y, z] = keys.at(-1);
    keys.push([x, y, z + 10], [i % 2 ? x + 600 : x - 600, y + 5, z + 10]);
  }
  const [x, y, z] = keys.at(-1);
  keys.push([x, y, z + 10], [x + 600, y, z + 10], [x + 1200, y, z + 10], [x + 1200, y, z + 20]);
  return keys;
}

test('the Catmull-Rom bound holds on every segment, end segments included, and is tight', () => {
  const keys = zigzagKeys(), count = keys.length;
  for (const tl of [keyTimeline(keys, (count - 1) * SHOT_KEY_MS), fastTour()]) {
    let tight = 0;
    const n = tl.fov.length, last = Math.min(n - 2, Math.floor(tl.durationMs / SHOT_KEY_MS));
    for (let k = 0; k <= last; k++) {
      const bound = crDeviation(tl.eye, n, k);
      let worst = 0;
      for (let i = 0; i < 200; i++) {
        const t = k * SHOT_KEY_MS + i * SHOT_KEY_MS / 200;
        if (t > tl.durationMs) break;
        const e = tl.poseAt(t).eyeM, u = i / 200;
        const chord = [0, 1, 2].map(c => tl.eye[3 * k + c] + u * (tl.eye[3 * k + 3 + c] - tl.eye[3 * k + c]));
        const d = Math.hypot(e[0] - chord[0], e[1] - chord[1], e[2] - chord[2]);
        assert.ok(d <= bound + 1e-6, `segment ${k} of ${n}: ${d} m from its chord, bound ${bound}`);
        worst = Math.max(worst, d);
      }
      if (bound > 1 && worst > .99 * bound) tight++;
    }
    if (tl.fov.length === count) assert.ok(tight >= 5, `${tight} segments reach their bound`);
  }
});

test('Douglas-Peucker keeps every point within tau of the kept polyline', () => {
  const r = rng(4), pts = new Float64Array(3 * 400);
  for (let i = 0; i < 400; i++) pts.set([i * 7 + r() * 3, Math.sin(i / 9) * 20, (i % 50) * 2 + r() * 4], 3 * i);
  for (const tau of [0, .5, 2, 10]) {
    const kept = simplify3(pts, tau);
    assert.deepEqual([...kept.subarray(0, 3)], [...pts.subarray(0, 3)]);
    assert.deepEqual([...kept.subarray(-3)], [...pts.subarray(-3)]);
    for (let i = 0; i < 400; i++) assert.ok(Math.sqrt(polylineDist2(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2], kept)) <= tau + 1e-9);
    if (tau >= 2) assert.ok(kept.length < pts.length / 2, `tau ${tau} keeps ${kept.length / 3}`);
  }
});

test('every tree within its ring of the eye is a mesh at every frame (R2)', () => {
  const { index } = forest(), tl = fastTour(), s = scheduleFor(index, tl);
  const sweep = r2Sweep(index, s, tl, { stepMs: 10 });
  assert.equal(sweep.misses, 0, `${sweep.misses} of ${sweep.checked} in-ring trees drawn as billboards`);
  assert.equal(sweep.notBoth, 0, 'every in-ring tree is in both sets');
  assert.ok(sweep.checked > 1e7 && sweep.frames === 4001);
  // The overshoot window's set reaches past its keys by the bound.
  assert.ok(windowSet(index, tl, 5).delta > 90);
});

test('a tree changes representation only well beyond its ring', () => {
  const { index } = forest(), tl = keyTimeline(wanderKeys({ speed: 150, seed: 5 }), 40000), s = scheduleFor(index, tl);
  const { pos, reach, vars, words } = index;
  let prev = null, prevEye = null, flips = 0, minSlack = Infinity;
  const union = new Uint32Array(words);
  for (let t = 0; t <= tl.durationMs; t += 20) {
    const st = s.stateAt(t), cur = { a: st.a, b: st.b, f: st.f }, eye = tl.poseAt(t).eyeM;
    if (prev && (prev.a !== cur.a || prev.b !== cur.b || prev.f !== cur.f)) {
      for (let w = 0; w < words; w++) union[w] = prev.a.bits[w] | prev.b.bits[w] | cur.a.bits[w] | cur.b.bits[w];
      for (let w = 0; w < words; w++) for (let m = union[w]; m; m &= m - 1) {
        const u = 32 * w + 31 - Math.clz32(m & -m), id = vars[2 * u + 1];
        if (tourMeshVisible(stateBits(prev, u), id, prev.f) === tourMeshVisible(stateBits(cur, u), id, cur.f)) continue;
        flips++;
        const at = e => Math.hypot(pos[3 * u] - e[0], pos[3 * u + 1] - e[1], pos[3 * u + 2] - e[2]);
        minSlack = Math.min(minSlack, Math.min(at(prevEye), at(eye)) - reach[u]);
      }
    }
    prev = cur; prevEye = eye;
  }
  assert.ok(flips > 1000, `${flips} flips`);
  // M = 50 m, less the eye's travel between frames (3 m at 150 m/s).
  assert.ok(minSlack >= 45, `a flip ${minSlack.toFixed(1)} m beyond its ring`);
  assert.equal(TOUR_MARGIN_M, 50);
});

test('a replan re-serves the playhead window at once, keeping only windows whose keys are unchanged', () => {
  const { index } = forest();
  const oldKeys = wanderKeys({ speed: 150, seed: 9 }), heard = 28200;
  // The same keys through 30.2 s; then the eye swings 600 m aside within a
  // second, inside window 7 (28 to 32 s).
  const newKeys = oldKeys.map((p, i) => {
    const off = Math.min(600, Math.max(0, i - 302) * 60);
    return [p[0] + off * .6, p[1], p[2] - off * .8];
  });
  const old = keyTimeline(oldKeys, 40000), next = keyTimeline(newKeys, 40000);
  const s = scheduleFor(index, old);
  for (let t = 0; t <= heard; t += 10) { s.stateAt(t); s.prefetch(t); }
  const before = new Map(s.cache);
  assert.ok(before.has(7) && before.has(6), 'the old timeline reached window 7');
  s.setTimeline(next);
  for (let w = 0; w <= 6; w++) if (before.has(w)) assert.equal(s.cache.get(w), before.get(w), `window ${w} carried over`);
  assert.equal(s.cache.has(7), false, 'the playhead window is recomputed');
  const fresh = windowSet(index, next, 7);
  assert.ok(sameBits(s.stateAt(29000).a.bits, fresh.bits));
  assert.notEqual(s.stateAt(29000).a, before.get(7));
  assert.ok(!sameBits(fresh.bits, before.get(7).bits), 'the replan moves window 7\'s set');
  const sweep = r2Sweep(index, s, next, { fromMs: heard, toMs: 34000, stepMs: 10, onFrame: t => s.prefetch(t) });
  assert.equal(sweep.misses, 0, `${sweep.misses} of ${sweep.checked} in-ring trees missed after the replan`);
  assert.ok(sweep.checked > 1e6);
});

test('the state is a pure function of the timeline and the time, whatever the seek order or cache size', () => {
  const { index } = forest(), tl = fastTour();
  const times = [];
  for (let t = 0; t < 12000; t += 37) times.push(t);
  times.push(3000, 3000, 3000, 3499, 3500, 3501, 3999, 4000, 4001, 4499, 4500, 4501, 39999, 40000, 1e9, -50, NaN, 20500, 7600, 19999, 0);
  const r = rng(2);
  for (let i = 0; i < 300; i++) times.push(Math.floor(r() * 41000));
  const persistent = scheduleFor(index, tl), small = scheduleFor(index, tl, { cacheWindows: 2 });
  const fresh = new Map();
  for (const t of times) {
    const p = persistent.stateAt(t), q = small.stateAt(t), f = scheduleFor(index, tl).stateAt(t);
    persistent.prefetch(t); small.prefetch(t);
    for (const st of [p, q]) {
      assert.equal(st.f, f.f, `f at ${t}`);
      assert.ok(sameBits(st.a.bits, f.a.bits) && sameBits(st.b.bits, f.b.bits), `sets at ${t}`);
      assert.equal(st.a.w, f.a.w); assert.equal(st.b.w, f.b.w);
    }
    const key = p.a.w;
    if (!fresh.has(key)) fresh.set(key, windowSet(index, tl, key).bits);
    assert.ok(sameBits(p.a.bits, fresh.get(key)));
  }
  assert.ok(small.cache.size <= 2 && persistent.cache.size <= 32);
  assert.ok(small.computes > persistent.computes, 'the small cache recomputed');
});

test('the state follows the 4 s windows and their 1 s dissolves', () => {
  const { index } = forest(), tl = fastTour(), s = scheduleFor(index, tl);
  const W = tourWindowCount(tl);
  assert.equal(W, 11);
  const at = t => { const st = s.stateAt(t); return [st.a.w, st.b.w, st.f]; };
  assert.deepEqual(at(0), [0, 0, 1]);
  assert.deepEqual(at(3499), [0, 0, 1]);
  assert.deepEqual(at(3500), [0, 1, 0]);
  assert.deepEqual(at(4000), [0, 1, .5]);
  assert.deepEqual(at(4499), [0, 1, .999]);
  assert.deepEqual(at(4500), [1, 1, 1]);
  assert.deepEqual(at(39600), [9, 10, .1]);
  assert.deepEqual(at(36600), [9, 9, 1]);
  // The song ends halfway through its last boundary's dissolve.
  assert.deepEqual(at(40000), [9, 10, .5]);
  assert.deepEqual(at(-1), [0, 0, 1]);
  assert.deepEqual(at(1e9), [9, 10, .5]);
  const short = scheduleFor(index, keyTimeline(wanderKeys({ durationMs: 41000 }), 41000));
  assert.deepEqual([short.stateAt(41000).a.w, short.stateAt(41000).b.w, short.stateAt(41000).f], [10, 10, 1]);
  assert.equal(TOUR_FADE_MS, 1000); assert.equal(TOUR_WINDOW_MS, 4000);
  // A tree in both sets stays a mesh; in one, it dissolves by its own key.
  const st = s.stateAt(4000);
  let a = 0, b = 0;
  for (let u = 0; u < index.count; u++) {
    const bits = stateBits(st, u);
    if (bits === 1) a++; if (bits === 2) b++;
  }
  assert.ok(a > 100 && b > 100, `${a} leaving, ${b} arriving`);
});

test('the guard: every poseAt eye is covered; an eye guard + 1 m off the path is not, in either window', () => {
  const { index } = forest(), tl = fastTour(), s = scheduleFor(index, tl);
  for (let t = 0; t <= tl.durationMs; t += 10) assert.ok(s.covers(s.stateAt(t), tl.poseAt(t).eyeM), `poseAt eye at ${t}`);
  assert.ok(s.covers(s.all, [NaN, NaN, NaN]), 'ALL has no guard');
  assert.equal(s.covers(s.stateAt(100), [NaN, 0, 0]), false);
  const e3 = windowSet(index, tl, 3), e8 = windowSet(index, tl, 8);
  let tested = 0;
  for (let i = 0; i < e3.pts.length / 3; i++) {
    const v = [e3.pts[3 * i], e3.pts[3 * i + 1], e3.pts[3 * i + 2]];
    if (Math.sqrt(polylineDist2(...v, e8.pts)) < 3 * e8.guard + 10) continue;
    for (const [dy, inside] of [[e3.guard + 1, false], [e3.guard - .01, true]]) {
      const eye = [v[0], v[1] + dy, v[2]];
      if (inside !== (Math.sqrt(polylineDist2(...eye, e3.pts)) <= e3.guard)) continue;
      assert.equal(s.covers({ a: e3, b: e3, f: 1 }, eye), inside, `${dy} m above a key of window 3`);
      assert.equal(s.covers({ a: e3, b: e8, f: .5 }, eye), false, 'far from the incoming window');
      assert.equal(s.covers({ a: e8, b: e3, f: .5 }, eye), false, 'far from the outgoing window');
      tested++;
    }
  }
  assert.ok(tested >= 8, `${tested} offsets`);
  assert.ok(Math.abs(e3.guard - (e3.delta + TOUR_TAU_M + TOUR_EPS_M)) < 1e-12);
});

test('a tree\'s representation follows the documented truth table', () => {
  const r = rng(8);
  for (let i = 0; i < 2000; i++) {
    const id = i < 4 ? [0, 1, .5, 1 / 4099][i] : r(), key = tourKey(id), f = i % 7 === 0 ? [0, 1][i % 2] : r();
    assert.ok(key >= 0 && key < 1);
    assert.equal(tourMeshVisible(0, id, f), false, 'in neither set: a billboard');
    assert.equal(tourMeshVisible(3, id, f), true, 'in both: a mesh');
    assert.equal(tourMeshVisible(1, id, f), key >= Math.fround(f), 'leaving: until the fade passes its key');
    assert.equal(tourMeshVisible(2, id, f), key < Math.fround(f), 'arriving: once the fade passes its key');
    assert.notEqual(tourMeshVisible(1, id, f), tourMeshVisible(2, id, f), 'one of a leaving and an arriving tree at each key');
  }
  for (const id of [.1, .7]) {
    assert.equal(tourMeshVisible(1, id, 0), true); assert.equal(tourMeshVisible(1, id, 1), false);
    assert.equal(tourMeshVisible(2, id, 0), false); assert.equal(tourMeshVisible(2, id, 1), true);
  }
  // The key is the Float32 product the shader forms.
  assert.equal(tourKey(.3), Math.fround(Math.fround(.3) * 4099) - Math.floor(Math.fround(Math.fround(.3) * 4099)));
  // Keys spread evenly over trees.
  const deciles = new Array(10).fill(0);
  for (let i = 0; i < 20000; i++) deciles[Math.floor(tourKey(r()) * 10)]++;
  for (const c of deciles) assert.ok(Math.abs(c - 2000) < 200, `decile ${c}`);
});

test('a window set holds exactly the trees nearer its path than reach + M + delta + tau + eps', () => {
  const { index } = forest(), tl = fastTour();
  for (const w of [0, 5, 10]) {
    const e = windowSet(index, tl, w);
    let size = 0;
    for (let u = 0; u < index.count; u++) {
      const th = index.reach[u] + TOUR_MARGIN_M + e.delta + TOUR_TAU_M + TOUR_EPS_M;
      const inside = polylineDist2(index.pos[3 * u], index.pos[3 * u + 1], index.pos[3 * u + 2], e.pts) < th * th;
      assert.equal(bitOf(e.bits, u), inside ? 1 : 0, `window ${w} tree ${u}`);
      size += inside;
    }
    assert.equal(e.size, size);
    assert.ok(size > 1000 && size < index.count / 2);
  }
  const all = index.all.bits;
  assert.equal(all.length, Math.ceil(index.count / 32));
  let n = 0;
  for (let u = 0; u < 32 * all.length; u++) n += bitOf(all, u);
  assert.equal(n, index.count, 'ALL holds every tree and no more');
});
