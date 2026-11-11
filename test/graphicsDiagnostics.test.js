import test from 'node:test';
import assert from 'node:assert/strict';
import { graphicsReport, performanceBlock, shaderFailureLog } from '../src/render/GraphicsDiagnostics.js';

test('shader diagnostics retain the native compiler error when the link log is generic', () => {
  const gl={getProgramInfoLog:()=> 'Fragment shader is not compiled.',getAttachedShaders:()=>[1,2],
    getShaderInfoLog:s=>s===2?'ERROR: 0:172: too many uniforms':''};
  assert.match(shaderFailureLog(gl,{}),/0:172: too many uniforms/);
});
test('shader diagnostics stay bounded and tolerate a lost context', () => {
  assert.ok(shaderFailureLog({getProgramInfoLog:()=> 'x'.repeat(10000)},{}).length<=768);
  assert.equal(shaderFailureLog({getProgramInfoLog(){throw Error('lost');}},{}),'program link failed');
});
test('verbose successful-shader warnings cannot displace the failed compiler error', () => {
  const gl={COMPILE_STATUS:1,getProgramInfoLog:()=> 'not compiled',getAttachedShaders:()=>[1,2],
    getShaderParameter:s=>s===1,getShaderInfoLog:s=>s===1?'warning '.repeat(500):'ERROR: native fragment failure'};
  assert.match(shaderFailureLog(gl,{}),/ERROR: native fragment failure/);
});
test('a graphics report distinguishes loading, permanent fallback and active v2 without song data', () => {
  const range={active:false,mode:'v2',reason:'shader: native error',runtime:'ready',failures:{view:'native error'},
    scene:{pending:[],prepared:[],contextLost:false},residency:{budget:'mobile',denials:3},privateTrack:'/personal/audio.wav'};
  const report=graphicsReport({range,profile:{look:'pixel'},canvas:{width:320,height:180},env:{navigator:{userAgent:'Android Chrome',maxTouchPoints:5},devicePixelRatio:3,location:{href:'secret-url'}}});
  assert.equal(report.range.reason,range.reason);assert.equal(report.range.residency.denials,3);
  assert.equal(report.device.touchPoints,5);assert.equal(report.device.dpr,3);
  assert.equal(JSON.stringify(report).includes('personal'),false);assert.equal(JSON.stringify(report).includes('secret-url'),false);
  assert.equal(graphicsReport({range:{...range,reason:'preparing',scene:{pending:['view']}}}).range.reason,'preparing');
  assert.equal(graphicsReport({range:{...range,active:true,reason:null}}).range.active,true);
});
test('reporting before playback or after context loss never creates a graphics context', () => {
  assert.equal(graphicsReport().range,null);
  const gl={isContextLost:()=>true,getParameter(){throw Error('lost');}};
  assert.equal(graphicsReport({gl}).gpu.contextLost,true);
});
test('the graphics report identifies the active voxel renderer without pack URLs', () => {
  const status = { state: 'ready', viewId: 'white-mountains-owens', triangles: 14268, progress: .5,
    packUrl: 'http://private/path' };
  assert.deepEqual(graphicsReport({ voxelRange: status }).voxelRange,
    { state: 'ready', viewId: 'white-mountains-owens', triangles: 14268, progress: .5 });
  assert.equal(Object.hasOwn(graphicsReport(), 'voxelRange'), false);
});

// Stub governor snapshot in the shape PerfGovernor.diagnostics publishes
// (frame-cost plan, Phase 0); the governor itself is tested elsewhere.
const stats = (count, median, p95, max) => ({ count, median, p95, max });
const governorSnapshot = (events = []) => ({ workTimingEnabled: true, framePeriodMs: 1000 / 60, observedWorkMs: 9.5,
  workHeadroomMs: 7, probeLevel: null, probeUntilMs: null, level: 2, minLevel: 0, sinceStartMs: 61000,
  levelMs: [30000, 1000, 30000, 0, 0, 0, 0],
  counters: { samples: 3600, overBudget: 40, workPressure: 12, noHeadroom: 30, levelChanges: events.length },
  events, eventsDropped: Math.max(0, events.length - 32),
  frames: { periodMs: stats(600, 16.7, 18.9, 40), workMs: stats(300, 9, 12, 20), syncWaitMs: stats(300, 1.5, 4, 9) } });
const shed = (i) => ({ atMs: 1000 * i, from: 0, to: 1, cause: 'period', periodMs: 33.3, workMs: 9, overCount: 10, workOverCount: 2 });
const fullInput = () => ({ level: 2, fpsCap: 60, presentedFps: 58.2, callbackFps: 59.9, governor: governorSnapshot([shed(1)]),
  syncWait: { last: { totalMs: 2.5, calls: 3, crestRead: 1, crestEdgesRead: 0.5, probeCollect: 0.75, probeSyncRead: 0, presenterGetError: 0.25,
    copyFrom() {} } },
  drawn: { viewId: 'song-range-stage', songRangeId: 'k1', tiles: 412, geometryTriangles: 1596074,
    trees: { mesh: 26265, billboards: 318203 }, mirror: true, backdrop: false } });

test('the performance block carries the governor record, waits and drawn view', () => {
  const block = performanceBlock(fullInput());
  assert.equal(block.level, 2); assert.equal(block.fpsCap, 60); assert.equal(block.presentedFps, 58.2); assert.equal(block.callbackFps, 59.9);
  assert.deepEqual(block.governor.events, [shed(1)]);
  assert.equal(block.governor.counters.overBudget, 40); assert.deepEqual(block.governor.levelMs, [30000, 1000, 30000, 0, 0, 0, 0]);
  assert.equal(block.governor.sinceStartMs, 61000); assert.equal(block.governor.framePeriodMs, 1000 / 60);
  assert.deepEqual(block.syncWait.last, { totalMs: 2.5, calls: 3, crestRead: 1, crestEdgesRead: 0.5, probeCollect: 0.75, probeSyncRead: 0, presenterGetError: 0.25 });
  assert.deepEqual(block.syncWait.stats, stats(300, 1.5, 4, 9));
  assert.deepEqual(block.drawn, fullInput().drawn);
  assert.equal(block.gpuTimer, null);
  assert.doesNotThrow(() => JSON.stringify(block));
});

test('missing performance pieces become nulls and never throw', () => {
  for (const input of [undefined, {}, { governor: {} }, { governor: { events: 'x', counters: 3, frames: { workMs: null } } },
    { syncWait: null, drawn: { trees: null } }, { level: NaN, fpsCap: Infinity, drawn: { viewId: { long: 'object' } } }]) {
    const block = performanceBlock(input);
    assert.equal(block.syncWait.stats, null);
    assert.equal(block.drawn.trees.mesh, null);
    assert.equal(block.drawn.viewId, null);
    assert.equal(block.gpuTimer, null);
  }
  const bare = performanceBlock({ governor: { workTimingEnabled: false, framePeriodMs: 16.7 } });
  assert.equal(bare.governor.framePeriodMs, 16.7);
  assert.equal(bare.governor.levelMs, null); assert.equal(bare.governor.frames, null); assert.deepEqual(bare.governor.events, []);
  assert.equal(performanceBlock().governor, null); assert.equal(performanceBlock().level, null);
});

test('the performance block keeps at most the newest 32 governor events', () => {
  const events = Array.from({ length: 40 }, (_, i) => shed(i));
  const block = performanceBlock({ governor: governorSnapshot(events) });
  assert.equal(block.governor.events.length, 32);
  assert.equal(block.governor.events[0].atMs, 8000);
  assert.equal(block.governor.events[31].atMs, 39000);
  assert.equal(block.governor.eventsDropped, 8);
});

test('a graphics report includes the performance block only when given one', () => {
  assert.equal(graphicsReport().performance, null);
  const report = graphicsReport({ performance: fullInput() });
  assert.deepEqual(report.performance, performanceBlock(fullInput()));
  assert.equal(report.version, 1);
});
