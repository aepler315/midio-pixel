// Range v2 Task 14: travel between two scenic views composites both sides
// through the shared travel seam; the outgoing view stays valid throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangePresentation, V2_TRAVEL_BANDS } from '../src/world/alpine/RangePresentation.js';
import { travelSeam, travelSpans, TRAVEL_BANDS } from '../src/world/TravelSeam.js';

const camera = { eyeStartM: [0, 1500, 0], eyeEndM: [10, 1500, 0], targetStartM: [0, 700, -9000], targetEndM: [10, 700, -9000], fovYDeg: 35 };
const view = (id, biome) => ({ id, regionId: 'r', biome, status: 'approved', catalogVersion: 1,
  terrainManifestUrl: `terrain/${id}.terrain.json`, materialManifestUrl: 'materials/m.json', camera,
  characterScores: { energy: .5, rawness: .5, grandeur: .5, dominance: .5 }, evidence: { reviewPath: 'x' } });
const catalog = { catalogVersion: 1, views: [view('a', 'RAINFOREST'), view('b', 'TAIGA')] };
const W = 1408, H = 848;

function fakeScene({ failB = false, holdB = false, sideRoom = true } = {}) {
  const ready = new Set();
  const calls = [];
  const scene = {
    calls, contextLost: false, sideB: false,
    isReady: (id) => ready.has(id),
    prepare: (v) => {
      if (v.id === 'b' && failB) return Promise.reject(Object.assign(new Error('HTTP 404'), { reason: 'http' }));
      if (v.id === 'b' && holdB) return new Promise(() => {});
      ready.add(v.id);
      return Promise.resolve({});
    },
    resize() {}, release() {}, snapshot: () => ({}), pinView(ids, extra = []) { scene.pinned = [].concat(ids, extra); },
    ensureSide() { if (!sideRoom) return false; scene.sideB = true; return true; },
    releaseSide() { scene.sideB = false; },
    renderPartition: (frame, pass, id, opts = {}) => { calls.push({ pass, id, side: opts.side || 'A' }); return { id, width: W, height: H }; },
    renderGround: (frame, id) => ({ canvas: { id, width: W, height: H }, stage: { id, wetMasks: [], pools: [] } }),
  };
  return scene;
}

const inputs = (t, { travel = true } = {}) => ({
  sim: { songSeed: 1, perf: { level: 0 }, biomes: {
    currentBlend: { from: 'RAINFOREST', to: 'TAIGA', t, travel, travelP: t }, sections: [{ profile: { name: 'RAINFOREST' } }],
    tSec: 1, durationMs: 1000, _profile: () => null, groundField: null, energyCurves: null, world: {},
  } },
  pose: { worldX: 0, midioX: 0, midioDrawX: 0, midioY: 0 },
  scenicViewport: { logicalWidth: W, logicalHeight: H, backingWidth: W, backingHeight: H },
  groundViewport: { logicalWidth: W, logicalHeight: H },
});

function recordingCtx() {
  const draws = [];
  let clip = null;
  const stack = [];
  return {
    draws, globalAlpha: 1, globalCompositeOperation: 'source-over',
    save() { stack.push([clip, this.globalAlpha, this.globalCompositeOperation]); },
    restore() { [clip, this.globalAlpha, this.globalCompositeOperation] = stack.pop(); },
    beginPath() {}, rect(x, y, w) { clip = [x, x + w]; }, clip() {}, setTransform() {},
    clearRect() { draws.length = 0; },
    drawImage(img, ...args) { draws.push({ id: img.id, args, clip, alpha: this.globalAlpha, op: this.globalCompositeOperation }); },
  };
}

// The travel composition buffer: records what is blended into it.
const scratches = [];
function fakeCanvas(w, h) {
  const ctx = recordingCtx();
  const c = { id: 'scratch', width: w, height: h, ctx, getContext: () => ctx };
  scratches.push(c);
  return c;
}

/** Opacity at screen x of opaque A and B blended as recorded: A's
 *  source-over alpha plus B's added ('lighter') alpha. */
function coverageAt(draws, x) {
  let a = 0, b = 0;
  for (const d of draws) {
    if (!(x >= d.clip[0] && x < d.clip[1])) continue;
    if (d.op === 'lighter') b += d.alpha; else a = d.alpha + a * (1 - d.alpha);
  }
  return { a, b, total: a + b };
}

async function presentation(sceneOpts) {
  const scene = fakeScene(sceneOpts);
  const p = new RangePresentation({ mode: 'v2', catalog, sceneFactory: async () => scene, makeCanvas: fakeCanvas });
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }], ['TAIGA', { view: catalog.views[1] }]]) }, generation: 1 });
  await p.whenReady({ timeoutMs: 50 }).catch(() => {});
  return { p, scene };
}

test('endpoints: before the travel only the outgoing view draws, after it only the incoming one', async () => {
  const { p, scene } = await presentation();
  for (const [t, want] of [[0, 'a'], [1, 'b']]) {
    scene.calls.length = 0;
    p.setFrameInputs(inputs(t));
    assert.equal(p.beginScenic(), true);
    assert.equal(p.snapshot().incomingViewId, null);
    p.drawPartition(recordingCtx(), 'far', { width: W, height: H });
    assert.deepEqual(scene.calls.map((c) => c.id), [want]);
  }
});

test('25/50/75%: both sides render; the seam moves right to left, nearest layers first; the blend stays opaque', async () => {
  const { p, scene } = await presentation();
  // The incoming view is ready before its seam enters the frame (no fade).
  const start = inputs(0); start.sim.biomes.currentBlend = { from: 'RAINFOREST', to: 'TAIGA', t: 0.001, travel: true, travelP: 0 };
  p.setFrameInputs(start);
  p.beginScenic();
  let prev = Infinity;
  for (const t of [0.25, 0.5, 0.75]) {
    scene.calls.length = 0;
    p.setFrameInputs(inputs(t));
    assert.equal(p.beginScenic(), true);
    assert.equal(p.snapshot().incomingViewId, 'b');
    assert.deepEqual(scene.pinned.filter((k) => !k.startsWith('range:')).sort(), ['a', 'b']);
    assert.ok(scene.pinned.includes('range:travel-scratch'));
    const ctx = recordingCtx();
    p.drawPartition(ctx, 'near', { width: W, height: H });
    assert.deepEqual(scene.calls.map((c) => [c.id, c.side]), [['a', 'A'], ['b', 'B']]);
    // One copy of the blended buffer to the stage.
    assert.deepEqual(ctx.draws.map((d) => d.id), ['scratch']);
    const draws = scratches.at(-1).ctx.draws;
    const { lo, hi } = travelSpans(W, 'L5', t);
    // Solid A left of the seam, solid B right of it, and every column of
    // the feather band fully covered (no see-through stripe).
    if (lo > 1) assert.equal(coverageAt(draws, lo / 2).a, 1);
    if (hi < W - 1) assert.equal(coverageAt(draws, (hi + W) / 2).b, 1);
    for (let x = Math.max(0, lo); x < Math.min(W, hi); x += 7) {
      const c = coverageAt(draws, x);
      assert.ok(Math.abs(c.total - 1) < 1e-9, `coverage ${c.total} at x=${x}`);
    }
    assert.ok(draws.filter((d) => d.id === 'b').every((d) => d.op === 'lighter'), 'B is added, not layered');
    const seam = travelSeam(W, 'L5', t);
    assert.ok(seam < prev);
    prev = seam;
  }
  // The near partition leads the far skyline at the same moment.
  assert.ok(travelSeam(W, 'L5', 0.5) < travelSeam(W, 'L2', 0.5));
});

test('an incoming view that is still loading, or fails, leaves the outgoing view drawing', async () => {
  for (const opts of [{ holdB: true }, { failB: true }]) {
    const { p, scene } = await presentation(opts);
    p.setFrameInputs(inputs(0.5));
    assert.equal(p.beginScenic(), true, 'never a legacy flash mid-travel');
    assert.equal(p.snapshot().incomingViewId, null);
    scene.calls.length = 0;
    p.drawPartition(recordingCtx(), 'mid', { width: W, height: H });
    assert.deepEqual(scene.calls.map((c) => c.id), ['a']);
  }
});

test('no room for the incoming target: the outgoing view carries on, and the target is released after travel', async () => {
  const { p, scene } = await presentation({ sideRoom: false });
  p.setFrameInputs(inputs(0.5));
  assert.equal(p.beginScenic(), true);
  assert.equal(p.snapshot().incomingViewId, null);
  const ok = await presentation();
  ok.p.setFrameInputs(inputs(0.5));
  ok.p.beginScenic();
  assert.equal(ok.scene.sideB, true);
  ok.p.setFrameInputs(inputs(1));
  ok.p.beginScenic();
  assert.equal(ok.scene.sideB, false, 'released once no travel needs it');
  void scene;
});

test('travel never restores a foreground rock stage or its pools', async () => {
  const { p } = await presentation();
  for (const t of [0.1, 0.9]) {
    p.setFrameInputs(inputs(t));
    p.beginScenic();
    p.drawGround(recordingCtx(), { width: W, height: H });
    assert.equal(p.stage, null);
    assert.equal(p.groundReceivers(), null);
    assert.equal(p.hasViewComposition, false, 'removing the stage cannot claim weather ownership for an uncomposed view');
  }
});

test('a view that becomes ready after legacy was on screen fades in over heard time, pure under seek', async () => {
  const { ARRIVAL_SEC } = await import('../src/world/alpine/RangePresentation.js');
  let release;
  const gate = new Promise((r) => { release = r; });
  const scene = fakeScene();
  const prepare = scene.prepare;
  scene.prepare = (v) => gate.then(() => prepare(v));
  const p = new RangePresentation({ mode: 'v2', catalog, sceneFactory: async () => scene });
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }]]) }, generation: 1 });
  const at = (tSec, extra = {}) => {
    const i = inputs(1, { travel: false });
    i.sim.biomes.currentBlend = { from: 'RAINFOREST', to: 'RAINFOREST', t: 1 };
    i.sim.biomes.tSec = tSec;
    Object.assign(i.sim, extra);
    p.setFrameInputs(i);
    return p.beginScenic();
  };
  await p.whenReady({ timeoutMs: 1 }).catch(() => {});
  assert.equal(at(10), false, 'legacy while preparing');
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(at(20), true);
  assert.equal(p.arrival, 0);
  assert.equal(p.arriving, true);
  assert.equal(p.groundReceivers(), null, 'receivers stay legacy mid-fade');
  at(20 + ARRIVAL_SEC / 2);
  const mid = p.arrival;
  assert.ok(mid > 0.3 && mid < 0.7);
  at(20 + ARRIVAL_SEC / 2);
  assert.equal(p.arrival, mid, 'paused: holds');
  const ctx = recordingCtx();
  p.drawPartition(ctx, 'far', { width: W, height: H });
  assert.ok(Math.abs(ctx.draws[0].alpha - mid) < 1e-12, 'drawn at the arrival alpha');
  at(20 + ARRIVAL_SEC + 0.01);
  assert.equal(p.arrival, 1);
  assert.equal(p.arriving, false);
  at(21);
  assert.equal(p.arrival, 1, 'a completed arrival never restarts on its own');
  // Export waits for readiness and never fades.
  at(30, {}); p._legacyShown = true;
  at(31, { exportMode: true });
  assert.equal(p.arrival, 1);
});

test('a view that joins just before the travel ends keeps the handoff until its fade completes', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const scene = fakeScene();
  const prepare = scene.prepare;
  scene.prepare = (v) => (v.id === 'b' ? gate.then(() => prepare(v)) : prepare(v));
  const p = new RangePresentation({ mode: 'v2', catalog, sceneFactory: async () => scene, makeCanvas: fakeCanvas });
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }], ['TAIGA', { view: catalog.views[1] }]]) }, generation: 1 });
  await p.whenReady({ timeoutMs: 1 }).catch(() => {});
  const travel = (tSec, travelP) => { const i = inputs(travelP); i.sim.biomes.tSec = tSec; p.setFrameInputs(i); return p.beginScenic(); };
  const arrived = (tSec) => {
    const i = inputs(1); i.sim.biomes.tSec = tSec;
    i.sim.biomes.currentBlend = { from: 'TAIGA', to: 'TAIGA', t: 1 };
    p.setFrameInputs(i);
    return p.beginScenic();
  };
  travel(10, 0.5);
  release();
  await new Promise((r) => setTimeout(r, 5));
  travel(10.9, 0.97);
  assert.equal(p.snapshot().incomingViewId, 'b');
  assert.equal(p.incomingFade, 0);
  // The blend collapses to the destination while B is still fading in.
  assert.equal(arrived(11.2), true);
  assert.equal(p.snapshot().viewId, 'a', 'A is still drawn under B');
  assert.equal(p.snapshot().incomingViewId, 'b');
  assert.equal(p.seamP, 1, 'seam fully across: only B spans, at its fade');
  assert.ok(p.incomingFade > 0 && p.incomingFade < 1);
  // Once the fade completes, B draws alone.
  arrived(12.2);
  assert.equal(p.snapshot().viewId, 'b');
  assert.equal(p.snapshot().incomingViewId, null);
});

test('an incoming view that becomes ready mid-travel fades in instead of popping', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const scene = fakeScene();
  const prepare = scene.prepare;
  scene.prepare = (v) => (v.id === 'b' ? gate.then(() => prepare(v)) : prepare(v));
  const p = new RangePresentation({ mode: 'v2', catalog, sceneFactory: async () => scene, makeCanvas: fakeCanvas });
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }], ['TAIGA', { view: catalog.views[1] }]]) }, generation: 1 });
  await p.whenReady({ timeoutMs: 1 }).catch(() => {});
  const at = (tSec, travelP) => { const i = inputs(travelP); i.sim.biomes.tSec = tSec; p.setFrameInputs(i); return p.beginScenic(); };
  assert.equal(at(10, 0.2), true);
  assert.equal(p.snapshot().incomingViewId, null, 'still loading: outgoing only');
  release();
  await new Promise((r) => setTimeout(r, 5));
  at(11, 0.75);
  assert.equal(p.snapshot().incomingViewId, 'b');
  assert.equal(p.incomingFade, 0, 'joins invisible');
  const ctx = recordingCtx();
  p.drawPartition(ctx, 'near', { width: W, height: H });
  const draws = scratches.at(-1).ctx.draws;
  for (const x of [10, W / 2, W - 10]) assert.equal(coverageAt(draws, x).a, 1, 'A still fills the frame');
  at(11.6, 0.8);
  assert.ok(p.incomingFade > 0.3 && p.incomingFade < 0.7);
  at(12.3, 0.85);
  assert.equal(p.incomingFade, 1);
});

test('an incoming view ready before the seam enters needs no fade', async () => {
  const { p } = await presentation();
  const i = inputs(0); i.sim.biomes.currentBlend = { from: 'RAINFOREST', to: 'TAIGA', t: 0.0005, travel: true, travelP: 0 };
  p.setFrameInputs(i);
  p.beginScenic();
  assert.equal(p.incomingFade, 1);
});

test('export mode (set by the app, not the simulation) never fades', async () => {
  const scene = fakeScene();
  const p = new RangePresentation({ mode: 'v2', catalog, sceneFactory: async () => scene, makeCanvas: fakeCanvas });
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }]]) }, generation: 1, exportMode: true });
  const i = inputs(1, { travel: false });
  i.sim.biomes.currentBlend = { from: 'RAINFOREST', to: 'RAINFOREST', t: 1 };
  p.setFrameInputs(i);
  assert.equal(p.beginScenic(), false, 'first frame before the runtime is ready is legacy');
  await p.whenReady({ timeoutMs: 50 });
  p.setFrameInputs(i);
  assert.equal(p.beginScenic(), true);
  assert.equal(p.arrival, 1);
});

test('the frame is pinned before side B and the buffer are reserved', async () => {
  const { p, scene } = await presentation();
  const order = [];
  const pin = scene.pinView;
  scene.pinView = (ids, extra) => { order.push('pin'); pin(ids, extra); };
  const ensure = scene.ensureSide;
  scene.ensureSide = () => { order.push('reserve'); return ensure(); };
  p.setFrameInputs(inputs(0.5));
  p.beginScenic();
  assert.ok(order.indexOf('pin') < order.indexOf('reserve'), order.join(','));
});

test('a budget-denied incoming view that gets room later still joins as late and fades', async () => {
  const scene = fakeScene();
  let room = false;
  scene.ensureSide = () => { if (!room) return false; scene.sideB = true; return true; };
  const p = new RangePresentation({ mode: 'v2', catalog, sceneFactory: async () => scene, makeCanvas: fakeCanvas });
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }], ['TAIGA', { view: catalog.views[1] }]]) }, generation: 1 });
  await p.whenReady({ timeoutMs: 50 }).catch(() => {});
  const at = (tSec, travelP) => { const i = inputs(travelP); i.sim.biomes.tSec = tSec; p.setFrameInputs(i); return p.beginScenic(); };
  at(10, 0.3);
  assert.equal(p.snapshot().incomingViewId, null, 'no room: outgoing alone');
  room = true;
  at(10.5, 0.4);
  assert.equal(p.snapshot().incomingViewId, 'b');
  assert.equal(p.incomingFade, 0, 'joins late, not at the advanced seam');
});

test('a held handoff cannot restore foreground ground receivers', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const scene = fakeScene();
  const prepare = scene.prepare;
  scene.prepare = (v) => (v.id === 'b' ? gate.then(() => prepare(v)) : prepare(v));
  const p = new RangePresentation({ mode: 'v2', catalog, sceneFactory: async () => scene, makeCanvas: fakeCanvas });
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }], ['TAIGA', { view: catalog.views[1] }]]) }, generation: 1 });
  await p.whenReady({ timeoutMs: 1 }).catch(() => {});
  const travel = (tSec, travelP) => { const i = inputs(travelP); i.sim.biomes.tSec = tSec; p.setFrameInputs(i); return p.beginScenic(); };
  travel(10, 0.5);
  release();
  await new Promise((r) => setTimeout(r, 5));
  travel(10.9, 0.97);
  const i = inputs(1); i.sim.biomes.tSec = 10.95; i.sim.biomes.currentBlend = { from: 'TAIGA', to: 'TAIGA', t: 1 };
  p.setFrameInputs(i);
  p.beginScenic();
  assert.ok(p.incomingFade < 0.5);
  p.drawGround(recordingCtx(), { width: W, height: H });
  assert.equal(p.stage, null);
  assert.equal(p.groundReceivers(), null);
});

test('the composition buffer is reallocated when either dimension outgrows it', async () => {
  const { p } = await presentation();
  p.setFrameInputs(inputs(0.5));
  p.beginScenic();
  const first = p._scratch;
  const tall = inputs(0.5);
  tall.scenicViewport = { logicalWidth: 600, logicalHeight: 1400, backingWidth: 600, backingHeight: 1400 };
  p.setFrameInputs(tall);
  p.beginScenic();
  assert.ok(p._scratch.height >= 1400, 'taller viewport, same or fewer pixels: new buffer');
  assert.notEqual(p._scratch, first);
});

test('the late-join marker is forgotten once its travel is over', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const scene = fakeScene();
  const prepare = scene.prepare;
  scene.prepare = (v) => (v.id === 'b' ? gate.then(() => prepare(v)) : prepare(v));
  const p = new RangePresentation({ mode: 'v2', catalog, sceneFactory: async () => scene, makeCanvas: fakeCanvas });
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }], ['TAIGA', { view: catalog.views[1] }]]) }, generation: 1 });
  await p.whenReady({ timeoutMs: 1 }).catch(() => {});
  const travel = (tSec, travelP) => { const i = inputs(travelP); i.sim.biomes.tSec = tSec; p.setFrameInputs(i); return p.beginScenic(); };
  travel(10, 0.3); // B still loading: this travel drew A alone
  // The travel ends (seek away) before B joins; B finishes loading later.
  const i = inputs(0); i.sim.biomes.tSec = 50; i.sim.biomes.currentBlend = { from: 'RAINFOREST', to: 'RAINFOREST', t: 1 };
  p.setFrameInputs(i); p.beginScenic();
  release();
  await new Promise((r) => setTimeout(r, 5));
  // A later travel toward the now-ready B, first seen at a nonzero seam:
  // B was ready before it began, so it joins without a late fade.
  travel(80, 0.2);
  assert.equal(p.snapshot().incomingViewId, 'b');
  assert.equal(p.incomingFade, 1);
});

test('the v2 seam feathers in fine whole-pixel bands; the legacy strips keep their four', async () => {
  assert.equal(travelSpans(W, 'L2', 0.5).bands.length, TRAVEL_BANDS, 'legacy default unchanged');
  assert.ok(V2_TRAVEL_BANDS >= 12);
  const { p } = await presentation();
  const start = inputs(0); start.sim.biomes.currentBlend = { from: 'RAINFOREST', to: 'TAIGA', t: 0.001, travel: true, travelP: 0 };
  p.setFrameInputs(start);
  p.beginScenic();
  p.setFrameInputs(inputs(0.6));
  assert.equal(p.beginScenic(), true);
  p.drawPartition(recordingCtx(), 'far', { width: W, height: H });
  const draws = scratches.at(-1).ctx.draws;
  const bBands = draws.filter((d) => d.id === 'b' && d.clip[1] - d.clip[0] < W / 4);
  assert.equal(bBands.length, V2_TRAVEL_BANDS, 'one incoming draw per feather band');
  // Whole-pixel edges, each band meeting the next exactly.
  for (const d of draws) for (const e of d.clip) assert.equal(e, Math.round(e));
  const edges = bBands.map((d) => d.clip).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < edges.length; i++) assert.equal(edges[i][0], edges[i - 1][1]);
  // Weight rises in small steps and every column stays fully covered.
  const { lo, hi } = travelSpans(W, 'L2', p.seamP, V2_TRAVEL_BANDS);
  for (let x = Math.ceil(Math.max(0, lo)); x < Math.min(W, hi); x += 3) {
    assert.ok(Math.abs(coverageAt(draws, x).total - 1) < 1e-9);
  }
});

test('intentional no-stage owns ground without rendering, stale receivers or target retention', async () => {
  const { p, scene } = await presentation();
  const none = { foreground: 'none', nearLedgeMaxFrac: 0 };
  const a = { ...catalog.views[0], composition: none };
  p.sceneByBiome.set('RAINFOREST', { view: a });
  p.sceneByBiome.set('TAIGA', { view: { ...catalog.views[1], composition: none } });
  let renders = 0, releases = 0;
  scene.renderGround = () => { renders++; throw Error('no stage should be built'); };
  scene.releaseGroundTarget = () => releases++;
  for (const t of [0, .5, 1, 1]) {
    p.stage = { pools: ['stale'], wetMasks: ['stale'] };
    p.setFrameInputs(inputs(t));
    assert.equal(p.beginScenic(), true);
    assert.equal(p.drawGround(recordingCtx(), { width: W, height: H }), true);
    assert.equal(p.stage, null);
    assert.equal(p.groundReceivers(), null);
    assert.equal(p.frame.compositions[p.viewId].foreground, 'none');
  }
  assert.equal(renders, 0);
  assert.ok(releases > 0);
});

test('saved ledge metadata on either travel side cannot restore the removed foreground', async () => {
  for (const reverse of [false, true]) {
    const { p, scene } = await presentation();
    const noneId = reverse ? 'b' : 'a';
    for (const v of catalog.views) p.sceneByBiome.set(v.biome, { view: { ...v, composition: { foreground: v.id === noneId ? 'none' : 'ledge', nearLedgeMaxFrac: v.id === noneId ? 0 : .12 } } });
    let releases = 0;
    scene.releaseGroundTarget = () => releases++;
    scene.renderGround = () => { throw new Error('saved ledges must not be rendered'); };
    for (const t of [.1, .9]) {
      const i = inputs(t);
      i.groundViewport = { logicalWidth: 1400, logicalHeight: 800, backingWidth: 700, backingHeight: 400 };
      p.setFrameInputs(i); p.beginScenic();
      assert.equal(p.drawGround(recordingCtx(), { width: 1400, height: 800 }), true);
      assert.equal(p.stage, null);
      assert.equal(p.groundReceivers(), null);
    }
    assert.ok(releases > 0, 'neither side retains a foreground target');
  }
});
