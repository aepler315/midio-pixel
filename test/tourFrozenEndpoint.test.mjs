import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTourTimeline } from '../src/world/terrain/TourTimeline.js';
import { tourFixture } from './fixtures/tour-fixture.mjs';

for (const durationMs of [50, 184, 14951]) {
  test(`a fully committed ${durationMs} ms timeline retains its exact final pose`, () => {
    const data = tourFixture(), point = data.points[0];
    const routeAt = time => ({ posM: [time / 10, 0], floorY: 100, ceilY: 2000,
      speedMps: 0, pointId: point.id, role: 'verse', headingDeg: 0 });
    const plan = { durationMs, previewPointId: point.id, notes: [], heroes: [], segments: [], routeAt };
    const previous = buildTourTimeline(data, plan);
    const next = buildTourTimeline(data, { ...plan, routeAt: () => routeAt(0) }, {
      previous, frozenThroughMs: durationMs, reducedMotion: true,
    });
    for (const field of ['eye', 'target', 'fov', 'meta']) assert.deepEqual(next[field], previous[field], `committed ${field}`);
    assert.deepEqual(next.poseAt(durationMs), previous.poseAt(durationMs));
  });
}
