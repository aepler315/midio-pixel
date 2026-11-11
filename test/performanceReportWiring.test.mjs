// Frame-cost plan, Phase 0: the frame loop hands the governor each rendered
// callback's synchronous wait beside its work, and the graphics report and
// window.__SMW publish the same performance block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SyncWaitLedger } from '../src/render/SyncWaitLedger.js';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import { stageHash } from '../src/world/alpine/StageAssembly.js';
import { songRangeKey } from '../src/world/terrain/SongRangePlan.js';
import { performanceBlock } from '../src/render/GraphicsDiagnostics.js';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const slice = (from, to) => { const s = source.indexOf(from), e = source.indexOf(to, s); assert.ok(s >= 0 && e > s, from); return source.slice(s, e); };
// The production frame() and the report's preallocated ledger copy.
const frameSource = slice('function frame(tRaf) {', '\nfunction applyShowAudio()');
const holderSource = slice('const lastSyncWait = {', '\n};\n') + '\n};\n';

function runtime({ draw = true, hidden = false, paused = false, waitMs = 3 } = {}) {
  let clock = 50;
  const samples = [], syncWaits = new SyncWaitLedger();
  const context = vm.createContext({ running: true, paused, playbackPreparing: false, lastRafMs: 0,
    lastRenderedWorkMs: 8, lastRenderedSyncWaitMs: 2, syncWaits,
    performance: { now: () => clock }, document: { hidden },
    noteFrameGap() {}, perfGovernor: { level: 0, sample: (...args) => samples.push(args) },
    playbackFps: () => 30, fittedPerfLevel: 0, fitCanvas() {}, emaFps: () => 60,
    fpsEma: 60, fpsHudVisible: false, hudIdleTick() {}, keepAwake: { tick() {} },
    audioEngine: { nowMs: 100 }, captureClock: { renderNow: n => n, leadMs: 0 },
    sim: {}, lastNowMs: 0, simTime: 0, acc: 0, STEP_MS: 1000 / 60,
    advanceFixedStepClock: () => ({ lastNowMs: 100, simTime: 100, acc: 0 }),
    bulkExportArmed: false, cameraRun: null, playbackCadence: { shouldDraw: () => draw },
    presentedFps: { sample() {} }, requestAnimationFrame: () => 1,
    rafHandle: null, pendingCaptureOptions: null,
    renderer: { draw: () => { clock += 9; syncWaits.add('crestRead', waitMs); syncWaits.add('presenterGetError', 0.5); return { presented: true }; },
      getCaptureSource: () => ({}) },
    syncCaptionDetails() {}, drawErrors: { record: () => false },
    visionLoop: { maybeSample() { clock += 1; } }, debugOverlay: { render() {} },
    songRecorder: null, updateRecordReadout() {},
    isSongComplete: () => false,
    grooveSaveDue: false, recalibration: { active: false }, applyShowAudio() {},
  });
  new vm.Script(`${holderSource}\nglobalThis.lastSyncWait = lastSyncWait;\n${frameSource}`).runInContext(context);
  return { context, samples, syncWaits, run: t => vm.runInContext(`frame(${t})`, context) };
}

const paired = (samples) => { for (const [, , o] of samples) assert.equal(o.workMs == null, o.syncWaitMs == null, JSON.stringify(o)); };

test('a rendered callback hands the governor its synchronous wait beside its work', () => {
  const r = runtime();
  r.run(17);
  assert.equal(r.samples[0][2].workMs, 8);
  assert.equal(r.samples[0][2].syncWaitMs, 2);
  assert.equal(r.context.lastRenderedWorkMs, 10);
  assert.equal(r.context.lastRenderedSyncWaitMs, 3.5);
  r.run(50);
  assert.equal(r.samples[1][2].workMs, 10);
  // The ledger restarted for the second callback: its own 3.5 ms, not 7.
  assert.equal(r.samples[1][2].syncWaitMs, 3.5);
  assert.equal(r.context.lastRenderedSyncWaitMs, 3.5);
  paired(r.samples);
});

test('the report keeps the last rendered callback\'s ledger across skipped draws', () => {
  const r = runtime();
  r.run(17);
  assert.equal(r.context.lastSyncWait.captured, true);
  assert.equal(r.context.lastSyncWait.crestRead, 3);
  assert.equal(r.context.lastSyncWait.presenterGetError, 0.5);
  assert.equal(r.context.lastSyncWait.calls, 2);
  const kept = r.context.lastSyncWait;
  r.context.playbackCadence.shouldDraw = () => false;
  r.run(34);
  assert.equal(r.context.lastSyncWait, kept, 'copied in place, not reallocated');
  assert.equal(r.context.lastSyncWait.totalMs, 3.5);
  assert.equal(r.syncWaits.totalMs, 0);
});

test('skipped, paused, hidden and failed callbacks clear the wait with the work', () => {
  const skipped = runtime({ draw: false });
  skipped.run(17); skipped.run(34);
  assert.equal(skipped.samples[0][2].syncWaitMs, 2);
  assert.equal(skipped.samples[1][2].workMs, null);
  assert.equal(skipped.samples[1][2].syncWaitMs, null);
  paired(skipped.samples);
  for (const state of [{ paused: true }, { hidden: true }]) {
    const r = runtime(state);
    r.run(17);
    assert.equal(r.context.lastRenderedWorkMs, null);
    assert.equal(r.context.lastRenderedSyncWaitMs, null);
    assert.equal(r.context.lastSyncWait.captured, false);
  }
  const failed = runtime();
  failed.context.renderer.draw = () => { throw new Error('fixture failure'); };
  failed.run(17);
  assert.equal(failed.context.lastRenderedSyncWaitMs, null);
  assert.equal(failed.context.lastSyncWait.captured, false);
});

test('the graphics report and both page hooks build the performance block one way', () => {
  const handler = slice("getElementById('copyGraphicsReport')", '\n});\n');
  assert.match(handler, /performance: performanceReportInput\(\)/);
  const hook = 'performanceReport: () => performanceBlock(performanceReportInput())';
  assert.equal(source.split(hook).length - 1, 2, 'the song hook and the pre-song stub');
  const stub = slice('if (!window.__SMW) window.__SMW = {', '\n};\n');
  assert.match(stub, /get perfLevel\(\) \{ return perfGovernor\?\.level \?\? null; \}/);
  assert.match(stub, /performanceReport: /);
  assert.match(slice('function performanceReportInput() {', '\n}\n'), /perfGovernor\?\.diagnostics \?\? null/);
});

test('a new song\'s governor drops the previous song\'s ledger copy', () => {
  // The report pairs syncWait.last with the governor's record; one song's
  // waits must not sit beside the next song's empty record.
  assert.match(slice('perfGovernor = new PerfGovernor({', '// An offline frame'), /\n {2}lastSyncWait\.captured = false;\n/);
});

test('the drawn view snapshot reads the prepared view without changing it', () => {
  const geometries = { far: { index: { count: 300 } }, mid: { index: { count: 600 } }, near: { index: { count: 3 } } };
  const plan = { templateId: 'plan-1', slots: [{ slotId: 'H1', pieceId: 'x' }] };
  const p = { view: { id: 'stage', songRange: { key: songRangeKey(plan), plan } }, manifest: { tiles: [{}, {}, {}] }, geometries,
    stats: { trees: { meshDetail: 5, mesh: 20, billboard: 300 } }, uniforms: { uMirrorAmount: { value: 0.4 } } };
  const self = { active: true, viewId: 'stage', frame: { frameId: 7 }, scene: { prepared: new Map([['stage', p]]), backdrop: { frame: 7 } } };
  assert.deepEqual(RangePresentation.prototype.drawnSnapshot.call(self), { viewId: 'stage', songRangeId: stageHash(plan), tiles: 3,
    geometryTriangles: 301, trees: { mesh: 25, billboards: 300 }, mirror: true, backdrop: true });
  self.scene.backdrop.frame = 6; p.uniforms.uMirrorAmount.value = 0; delete p.view.songRange;
  const s = RangePresentation.prototype.drawnSnapshot.call(self);
  assert.equal(s.mirror, false); assert.equal(s.backdrop, false); assert.equal(s.songRangeId, null);
  assert.deepEqual(RangePresentation.prototype.drawnSnapshot.call({ active: false, viewId: 'stage', scene: self.scene }),
    { viewId: null, songRangeId: null, tiles: null, geometryTriangles: null, trees: null, mirror: null, backdrop: null });
});

test('a compiled-terrain view reports its own triangle count, never a made-up zero', () => {
  // prepareCompiledView leaves `geometries` empty and keeps the count in stats.
  const snap = (p) => RangePresentation.prototype.drawnSnapshot.call({ active: true, viewId: 'c', frame: null,
    scene: { prepared: new Map([['c', { view: { id: 'c' }, manifest: { tiles: [] }, ...p }]]) } }).geometryTriangles;
  assert.equal(snap({ geometries: {}, stats: { triangles: 2400000 } }), 2400000);
  assert.equal(snap({ geometries: {} }), null);
  assert.equal(snap({}), null);
  assert.equal(snap({ geometries: { far: { index: { count: 9 } } }, stats: { triangles: 5 } }), 3, 'band geometries win when present');
});

test('a composed stage\'s songRangeId stays short and tells real-length layouts apart', () => {
  // Real layout keys run 241-354 characters; the report cuts strings at 128,
  // so the raw key would collide for layouts that differ only late in it.
  const slots = (last) => ['H1', 'H2', 'H3', 'M1', 'M2', 'F1', 'F2'].map((slotId, i) => ({ slotId, mirrored: i % 2 === 0,
    pieceId: i === 6 ? last : `northern-rockies-stone-mountain:summit-21${String(i).padStart(2, '0')}` }));
  const snap = (plan) => RangePresentation.prototype.drawnSnapshot.call({ active: true, viewId: 'v', frame: null,
    scene: { prepared: new Map([['v', { view: { id: 'v', songRange: { key: songRangeKey(plan), plan } } }]]) } });
  const a = { templateId: 'lake-amphitheatre-a', slots: slots('northern-rockies-tuchodi:summit-2101') };
  const b = { templateId: 'lake-amphitheatre-a', slots: slots('northern-rockies-tuchodi:summit-2102') };
  assert.ok(songRangeKey(a).length > 128 && songRangeKey(a).slice(0, 128) === songRangeKey(b).slice(0, 128));
  const ida = performanceBlock({ drawn: snap(a) }).drawn.songRangeId, idb = performanceBlock({ drawn: snap(b) }).drawn.songRangeId;
  assert.equal(ida, stageHash(a));
  assert.match(ida, /^[0-9a-f]{16}$/);
  assert.notEqual(ida, idb);
});
