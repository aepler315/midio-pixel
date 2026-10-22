import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReelTimeline } from '../tools/lib/shot-reel-timeline.mjs';
import vm from 'node:vm';

// Serialize the exact production factory injected by shot-reel, so a hidden
// Node-only dependency cannot make this test pass while browser use breaks.
const browserFactory = vm.runInNewContext(`(${createReelTimeline.toString()})`);
const spans = [{ id: 'first', move: 'rail', startMs: 0, endMs: 1000 }, { id: 'last', move: 'orbit', startMs: 1000, endMs: 2000 }];
const paths = [
  { id: 'first', s: [0, 10], eye: [0, 1, 2, 10, 1, 2], aim: [0, 2, -10, 10, 2, -10], fov: [30, 30] },
  { id: 'last', s: [0, 10], eye: [100, 3, 4, 110, 3, 4], aim: [100, 4, -20, 110, 4, -20], fov: [20, 20] },
];
const timeline = browserFactory(paths, spans);
const indexTimeline = createReelTimeline(paths, spans);

for (const [timeMs, id, eyeX] of [[0, 'first', 0], [1000, 'last', 100], [1500, 'last', 105], [2000, 'last', 110], [2500, 'last', 110]]) {
  test(`reel camera at ${timeMs} ms uses ${id} shot and expected pose`, () => {
    const pose = timeline.poseAt(timeMs);
    assert.equal(pose.shot.id, id);
    assert.equal(pose.eyeM[0], eyeX);
    const frame = indexTimeline.frameAt(timeMs);
    assert.equal(frame.shot, id, 'evidence index label matches the rendered shot');
    assert.equal(frame.index, id === 'first' ? 0 : 1);
    if (timeMs >= 2000) assert.equal(frame.progress, 1, 'final pose remains at its endpoint');
  });
}
