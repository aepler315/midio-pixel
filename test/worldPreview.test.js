import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import {
  pickPreviewPassages, passageStart, describeWorldResponse, previewCacheKey,
  PreviewSession, PREVIEW_SPAN_MS, PREVIEW_VERSION,
} from '../src/ui/WorldPreview.js';
import { buildWorldChoices, moveChoiceIndex } from '../src/ui/WorldChooser.js';

function curvesWithShape(durationMs, loudFrom, loudTo) {
  const curves = new EnergyCurves(durationMs, 50);
  for (let i = 0; i < curves.n; i++) {
    const t = (i / curves.rateHz) * 1000;
    const loud = t >= loudFrom && t < loudTo;
    const v = loud ? 0.9 : 0.08;
    curves.setFrame(i, [v, v, v * 0.6, v * 0.3, 0.05, 0.02, 0.01]);
  }
  return curves;
}

test('passages pick a quiet stretch and a peak from the song energy, not from BPM', () => {
  const durationMs = 32000;
  const passages = pickPreviewPassages({
    energyCurves: curvesWithShape(durationMs, 10000, 24000),
    durationMs,
    bpm: 174,
  });
  assert.ok(passages.quietMs < 10000, 'quiet lands in the opening');
  assert.ok(passages.peakMs >= 10000 && passages.peakMs < 24000, 'peak lands in the loud middle');
  assert.ok(Math.abs(passages.peakMs - passages.quietMs) >= passages.spanMs * 0.45);
  assert.equal(passages.spanMs, PREVIEW_SPAN_MS);
});

test('every world is offered the same two timestamps', () => {
  const durationMs = 180000;
  const data = { energyCurves: curvesWithShape(durationMs, 40000, 90000), durationMs };
  const a = pickPreviewPassages(data);
  const b = pickPreviewPassages(data);
  assert.deepEqual(a, b);
  assert.equal(passageStart(a, 'quiet'), a.quietMs);
  assert.equal(passageStart(a, 'peak'), a.peakMs);
});

test('missing energy falls back to proportional positions without inventing a beat', () => {
  const passages = pickPreviewPassages({ durationMs: 120000 });
  assert.ok(passages.quietMs < passages.peakMs);
  assert.ok(passages.peakMs < 120000);
  assert.equal(pickPreviewPassages({}).durationMs, 0);
});

test('explanatory copy is derived from measurements and never ranks the world', () => {
  const bassHeavy = describeWorldResponse('abyssal', { bass: 0.7, onset: 0.2 });
  assert.match(bassHeavy, /bass/i);
  const sparseCity = describeWorldResponse('city', { onset: 0.1, groove: 0.2 });
  assert.match(sparseCity, /quiet|sparse/i);
  const naveNoLabels = describeWorldResponse('nave', { bass: 0.5 }, { hasLabels: false });
  assert.match(naveNoLabels, /invent/i);
  const naveLabels = describeWorldResponse('nave', { bass: 0.5 }, { hasLabels: true });
  assert.match(naveLabels, /returning/i);
  for (const kind of ['alpine', 'city', 'abyssal', 'airless', 'strip', 'foundry', 'overgrowth', 'nave']) {
    const text = describeWorldResponse(kind, { onset: 0.5, bass: 0.5, groove: 0.5, phrase: 0.5 });
    assert.equal(/%|best|score|match/i.test(text), false, kind);
  }
});

test('cache keys change with world, seed, timestamp and reduced-flash', () => {
  const a = previewCacheKey({ worldId: 'alpine', seed: 315, tMs: 4000 });
  const b = previewCacheKey({ worldId: 'nocturne', seed: 315, tMs: 4000 });
  const c = previewCacheKey({ worldId: 'alpine', seed: 316, tMs: 4000 });
  const d = previewCacheKey({ worldId: 'alpine', seed: 315, tMs: 8000 });
  const e = previewCacheKey({ worldId: 'alpine', seed: 315, tMs: 4000, reducedFlash: true });
  assert.equal(new Set([a, b, c, d, e]).size, 5);
  assert.match(a, new RegExp(`^${PREVIEW_VERSION}\\|`));
});

test('session renders one still at a time, caches, and cancel drops the rest', async () => {
  const order = [];
  let concurrent = 0, maxConcurrent = 0;
  const session = new PreviewSession({
    data: { durationMs: 20000 },
    features: { bass: 0.4 },
    seed: 315,
    worldIds: ['alpine', 'nocturne', 'fathom'],
    schedule: (fn) => { fn(); return () => {}; },
    renderStill: async ({ worldId }) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(worldId);
      concurrent--;
      return `data:${worldId}`;
    },
    onStill: () => {},
  });
  session.enqueueAll();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['alpine', 'nocturne', 'fathom']);
  assert.equal(maxConcurrent, 1);
  assert.equal(session.cache.size, 3);
  const hits = [];
  session.onStill = (e) => hits.push(e);
  session.enqueue('alpine');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].cached, true);

  const late = new PreviewSession({
    data: { durationMs: 20000 },
    worldIds: ['a', 'b', 'c'],
    schedule: (fn) => { const t = setTimeout(fn, 20); return () => clearTimeout(t); },
    renderStill: ({ worldId }) => `data:${worldId}`,
  });
  late.enqueueAll();
  late.cancel();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(late.cache.size, 0);
  assert.equal(late._queue.length, 0);
});

test('only one animated preview runs, and stopPreview releases it before play', () => {
  const disposed = [];
  const audio = { started: 0, stopped: 0 };
  const frames = [];
  let clock = 0;
  const session = new PreviewSession({
    data: { durationMs: 20000 },
    seed: 1,
    reducedFlash: false,
    worldIds: ['alpine', 'nocturne'],
    schedule: (fn) => { fn(); return () => {}; },
    now: () => clock,
    renderStill: ({ worldId }) => `data:${worldId}`,
    createWorld: ({ worldId }) => ({
      canvas: { id: worldId },
      draw() {},
      dispose() { disposed.push(worldId); },
    }),
    playAudio: () => { audio.started++; },
    stopAudio: () => { audio.stopped++; },
    onPreviewFrame: (e) => frames.push(e.worldId),
  });
  session.preview('alpine');
  assert.equal(session.activePreviewId, 'alpine');
  session.preview('nocturne');
  assert.equal(session.activePreviewId, 'nocturne');
  assert.ok(disposed.includes('alpine'));
  session.stopPreview();
  assert.equal(session.activePreviewId, null);
  assert.ok(audio.stopped >= 1);
  session.cancel();
});

test('reduced flash keeps a static still and does not start preview audio', () => {
  const audio = { started: 0 };
  let created = 0;
  const session = new PreviewSession({
    data: { durationMs: 20000 },
    seed: 1,
    reducedFlash: true,
    worldIds: ['alpine'],
    schedule: (fn) => { fn(); return () => {}; },
    renderStill: () => 'data:x',
    createWorld: () => { created++; return { canvas: {}, draw() {}, dispose() {} }; },
    playAudio: () => { audio.started++; },
  });
  session.preview('alpine');
  assert.equal(session.activePreviewId, 'alpine');
  assert.equal(created, 0);
  assert.equal(audio.started, 0);
  session.cancel();
});

test('chooser cards stay one-per-world and carry a description instead of a score', () => {
  const worlds = [
    { id: 'alpine', name: 'The Range', tagline: 'Mountains.', kind: 'alpine' },
    { id: 'nocturne', name: 'After Hours', tagline: 'A city.', kind: 'city' },
  ];
  const choices = buildWorldChoices(worlds, {
    id: 'custom', baseId: 'alpine', name: 'The Range', tagline: 'Mountains.', kind: 'alpine',
  }, { phrase: 0.8, bass: 0.6 });
  assert.equal(choices.length, 2);
  assert.equal(choices[0].playWorldId, 'custom');
  assert.equal(choices[1].playWorldId, 'nocturne');
  assert.match(choices[0].description, /phrase|ridge/i);
  assert.equal(choices.every((c) => !('score' in c) && !('percent' in c)), true);
  assert.equal(moveChoiceIndex(0, -1, 2), 1);
  assert.equal(moveChoiceIndex(1, 1, 2), 0);
});

test('reduced motion alone skips preview clips and participates in the still cache (M3)', async () => {
  let created = 0, audio = 0; const preferences = [];
  const session = new PreviewSession({ data: { durationMs: 20000 }, reducedMotion: true, reducedFlash: false,
    worldIds: ['alpine'], schedule: fn => { fn(); return () => {}; },
    renderStill: args => { preferences.push(args.reducedMotion); return 'data:x'; },
    createWorld: () => { created++; return { canvas: {}, draw() {}, dispose() {} }; },
    playAudio: () => audio++ });
  await session.preview('alpine');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(created, 0); assert.equal(audio, 0);
  assert.deepEqual(preferences, [true]);
  assert.notEqual(previewCacheKey({ worldId: 'alpine' }), previewCacheKey({ worldId: 'alpine', reducedMotion: true }));
  session.cancel();
});

test('the Range chooser explicitly identifies its legacy illustration (M8)', () => {
  const choices = buildWorldChoices([{ id: 'range', name: 'The Range', kind: 'alpine' }, { id: 'city', kind: 'city' }]);
  assert.match(choices[0].previewLabel, /illustration/i);
  assert.equal(choices[1].previewLabel, null);
});
