import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import {
  pickPreviewPassages, passageStart, describeWorldResponse, previewCacheKey,
  PreviewSession, PREVIEW_SPAN_MS, PREVIEW_VERSION,
} from '../src/ui/WorldPreview.js';
import { buildWorldChoices, moveChoiceIndex } from '../src/ui/WorldChooser.js';
import { listWorlds } from '../src/world/Worlds.js';

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
  const phrased = describeWorldResponse('alpine', { phrase: 0.7, bass: 0.6 });
  assert.match(phrased, /phrase/i);
  assert.match(phrased, /bass/i);
  const atmospheric = describeWorldResponse('alpine', { phrase: 0.2 });
  assert.match(atmospheric, /atmosphere/i);
  const grooving = describeWorldResponse('alpine', { groove: 0.7 }, { experience: 'trio' });
  assert.match(grooving, /kick/i);
  const drifting = describeWorldResponse('alpine', { groove: 0.2 }, { experience: 'trio' });
  assert.match(drifting, /space ridge/i);
  const shaped = describeWorldResponse('unregistered-kind', { contrast: 0.6, form: 0.5 });
  assert.match(shaped, /contrast/i);
  const plain = describeWorldResponse('unregistered-kind', { contrast: 0.2, form: 0.2 });
  assert.match(plain, /as measured/i);
  assert.equal(new Set([phrased, atmospheric, grooving, drifting, shaped, plain]).size, 6);
  for (const text of [phrased, atmospheric, grooving, drifting, shaped, plain]) {
    assert.equal(/%|best|score|match/i.test(text), false, text);
  }
});

test('cache keys change with world, seed and timestamp', () => {
  const a = previewCacheKey({ worldId: 'alpine', seed: 315, tMs: 4000 });
  const b = previewCacheKey({ worldId: 'trio', seed: 315, tMs: 4000 });
  const c = previewCacheKey({ worldId: 'alpine', seed: 316, tMs: 4000 });
  const d = previewCacheKey({ worldId: 'alpine', seed: 315, tMs: 8000 });
  assert.equal(new Set([a, b, c, d]).size, 4);
  assert.match(a, new RegExp(`^${PREVIEW_VERSION}\\|`));
});

test('session renders one still at a time, caches, and cancel drops the rest', async () => {
  const order = [];
  let concurrent = 0, maxConcurrent = 0;
  const session = new PreviewSession({
    data: { durationMs: 20000 },
    features: { bass: 0.4 },
    seed: 315,
    worldIds: ['alpine', 'trio', 'unregistered-world'],
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
  assert.deepEqual(order, ['alpine', 'trio', 'unregistered-world']);
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
    worldIds: ['alpine', 'trio'],
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
  session.preview('trio');
  assert.equal(session.activePreviewId, 'trio');
  assert.ok(disposed.includes('alpine'));
  session.stopPreview();
  assert.equal(session.activePreviewId, null);
  assert.ok(audio.stopped >= 1);
  session.cancel();
});

test('chooser cards stay one-per-world and carry a description instead of a score', () => {
  const worlds = [
    { id: 'alpine', name: 'Landscape', tagline: 'Mountains.', kind: 'alpine', experience: 'landscape' },
    { id: 'trio', name: 'Trio', tagline: 'The cast.', kind: 'alpine', experience: 'trio' },
  ];
  const choices = buildWorldChoices(worlds, {
    id: 'custom', baseId: 'alpine', name: 'Landscape', tagline: 'Mountains.', kind: 'alpine',
  }, { phrase: 0.8, bass: 0.6 });
  assert.equal(choices.length, 2);
  assert.equal(choices[0].playWorldId, 'custom');
  assert.equal(choices[1].playWorldId, 'trio');
  assert.deepEqual(choices.map((c) => c.experience), ['landscape', 'trio']);
  assert.match(choices[0].description, /phrase|ridge/i);
  assert.match(choices[1].description, /trio|Midasus/i);
  assert.equal(choices.every((c) => !('score' in c) && !('percent' in c)), true);
  assert.equal(moveChoiceIndex(0, -1, 2), 1);
  assert.equal(moveChoiceIndex(1, 1, 2), 0);
});

test('the Landscape chooser card explicitly identifies its legacy illustration (M8)', () => {
  const choices = buildWorldChoices(listWorlds());
  assert.deepEqual(choices.map((c) => c.worldId), ['alpine', 'trio']);
  assert.match(choices[0].previewLabel, /illustration/i);
  assert.equal(choices[1].previewLabel, null, 'Trio plays what its card shows');
});
