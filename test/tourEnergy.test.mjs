import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareTourTimeline } from '../src/world/terrain/TourRuntime.js';

test('tour worker samples energy across the song in milliseconds, including later phrases', async () => {
  const previous = globalThis.Worker;
  let request;
  globalThis.Worker = class {
    postMessage(message) {
      request = message;
      queueMicrotask(() => this.onmessage({ data: { tour: { previewPose: { eyeM: [0, 1, 0], targetM: [0, 1, 1], fovYDeg: 35 } } } }));
    }
    terminate() {}
  };
  try {
    await prepareTourTimeline({}, { sections: [], durationMs: 1000, energyCurves: { globalEnergy: ms => ms / 1000 } });
    assert.deepEqual([...request.energy], [0, .25, .5, .75, 1]);
  } finally { globalThis.Worker = previous; }
});
