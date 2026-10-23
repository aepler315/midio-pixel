import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tours from '../tools/build-scenic-tours.mjs';
import { samplePath } from '../src/world/terrain/ShotPath.js';
import { shotPaceLimits } from '../src/world/terrain/ShotPlanner.js';

const motion = { maxSpeedMps: 120, minSpeedMps: 4, flowCalm: .07, flowEnergetic: .24, maxYawDegPerSec: 20, maxClimbMps: 22, maxAccelMps2: 3.5 };
const path = (eyes) => {
  const p = samplePath({ eyes, aims: eyes.map(([x, y, z]) => [x, y, z - 10000]), fovs: 30, spacingM: 100 });
  p.flow = Float32Array.from(p.s, () => .0001);
  return p;
};
const shot = (id, p) => ({ id, subjectId: id, move: 'traverse', path: p, payoffS: p.s.at(-1) / 2, score: { total: .8, holes: 0 }, durationMs: { min: 1, ideal: 1, max: 1 } });

// Removing supported climb accounting must make the advertised fast duration
// physically impossible even for a constant-speed traversal of this line.
test('authoring never advertises a steep path faster than the vertical speed bound', () => {
  const p = path([[0, 500, 0], [1000, 1500, 0]]);
  const duration = tours.durationRange(p, p.flow, motion);
  assert.ok(duration.min >= Math.ceil(1000 / 22 * 1000), `a 1000 m climb at 22 m/s needs at least 45455 ms, received ${duration.min}`);
  assert.ok(duration.min <= duration.ideal && duration.ideal <= duration.max);
});

test('cached graph duration refresh uses runtime supported joins and reapplies the transit leash', () => {
  assert.equal(typeof tours.refreshGraphDurations, 'function');
  const a = shot('a', path([[-1000, 0, 0], [0, 1000, 0]]));
  const b = shot('b', path([[1000, 2000, 0], [2000, 2000, 0]]));
  const steep = { from: a, to: b, kind: 'direct', path: path([[0, 1000, 0], [1000, 2000, 0]]), score: { total: .8 }, durationMs: { min: 1, ideal: 1, max: 1 } };
  const c = shot('c', path([[0, 1000, 2000], [1000, 1000, 2000]]));
  const d = shot('d', path([[2000, 1000, 2000], [3000, 1000, 2000]]));
  const flat = { from: c, to: d, kind: 'direct', path: path([[1000, 1000, 2000], [2000, 1000, 2000]]), score: { total: .8 }, durationMs: { min: 1, ideal: 1, max: 1 } };
  const graph = { usable: [a, b, c, d], front: [steep, flat] };
  const original = graph.front.slice();
  const limits = shotPaceLimits({ subjects: [], motion, shots: graph.usable, links: original.map((l, i) => ({ ...l, id: 'link-' + i, from: l.from.id, to: l.to.id })) });
  const result = tours.refreshGraphDurations(graph, motion, 20000);
  assert.ok(a.durationMs.min >= Math.ceil(1000 / 22 * 1000), 'cached shot durations are recomputed too');
  // The last rising cubic meets a horizontal arrival: its vertical
  // derivative peaks at 7/6 of the line's rise/progress, not at the chord slope.
  assert.ok(steep.durationMs.min >= 53030, 'supported arrival needs at least (1000 / 22) * (7 / 6) seconds, within path quantization');
  assert.ok(steep.durationMs.min >= Math.ceil(steep.path.s.at(-1) / limits.link[0].capMps * 1000), 'supported runtime link cap is a lower bound on advertised duration');
  assert.deepEqual(result.pairs, [flat], 'stale short metadata cannot admit the steep transit under the unchanged 20 s leash');
  assert.equal(result.rejectedLinks.length, 1);
  assert.equal(graph.front.length, 2, 'retain rejected cached geometry so later motion settings can reconsider it');
  assert.strictEqual(steep.path, original[0].path);
  assert.deepEqual(tours.refreshGraphDurations(graph, motion, 20000).pairs, result.pairs, 'refresh is stable and does not compound estimates');
});
