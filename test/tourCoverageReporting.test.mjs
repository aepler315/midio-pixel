import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTourTimeline } from '../src/world/terrain/TourRuntime.js';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import { tourFixture } from './fixtures/tour-fixture.mjs';

test('worker and presentation carry intended, alternative and ending coverage together', async () => {
  const priorSelf = globalThis.self;
  const messages = [];
  globalThis.self = { postMessage: message => messages.push(message) };
  try {
    await import('../src/world/terrain/tour-worker.js');
    globalThis.self.onmessage({ data: {
      data: tourFixture(), durationMs: 20000, energy: new Float32Array(81).fill(.5),
      sections: [{ startMs: 0, endMs: 20000, role: 'outro', relEnergy01: .5 }], roles: [],
      previous: null, committedThroughMs: 0,
    } });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].error, undefined);
    const tour = messages[0].tour;
    assert.ok(tour.heroCoverage, 'the worker must serialize coverage instead of dropping it at its boundary');
    assert.equal(tour.heroCoverage.total, tour.heroFraming.length);
    assert.ok(tour.heroCoverage.endings.length > 0);
    const presentation = new RangePresentation({ mode: 'v2' });
    try {
      presentation.tour = tour;
      assert.deepEqual(presentation.snapshot().tour.heroCoverage, tour.heroCoverage,
        'capture diagnostics must expose the same semantic report as the planner');
    } finally { presentation.dispose(); }
  } finally { globalThis.self = priorSelf; }
});

test('deferred refinement retains coverage when serializing the previous timeline', async () => {
  const priorWorker = globalThis.Worker;
  let request;
  const heroCoverage = { projectionOnly: true, total: 0, intended: 0, alternative: 0, station: 0, distant: 0, missed: 0, endings: [] };
  const previous = {
    durationMs: 1000, eye: new Float32Array(6), target: new Float32Array(6), fov: new Float32Array([30, 30]),
    meta: new Uint16Array(8), heroes: [], notes: [], heroFraming: [], heroCoverage,
  };
  globalThis.Worker = class {
    postMessage(message) {
      request = message;
      queueMicrotask(() => this.onmessage({ data: { tour: {
        previewPose: { eyeM: [0, 1, 0], targetM: [0, 1, -1], fovYDeg: 35 }, heroCoverage,
      } } }));
    }
    terminate() {}
  };
  try {
    await prepareTourTimeline({}, { durationMs: 1000, sections: [] }, { previous });
    assert.deepEqual(request.previous.heroCoverage, heroCoverage,
      'a deferred worker path returns the serialized previous object, including its diagnostic report');
  } finally { globalThis.Worker = priorWorker; }
});
