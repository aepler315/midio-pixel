// The opening camera's summit search (BuildFocus.js) and the line-of-sight
// test its climb uses (LineOfSight.js), on synthetic views. The cases come
// from the removed CastJobs tests, whose Ascent ran the same search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFocusM } from '../src/world/alpine/BuildFocus.js';
import { seenFrom } from '../src/world/alpine/LineOfSight.js';
import { scenePoseAt } from '../src/world/terrain/SceneTravel.js';
import { LEVEL, summitWorld, cone, lake } from './fixtures/summit-world.mjs';

const nearConeTop = (f) => f != null && Math.hypot(f[0] - 6400, f[2] - 8000) < 200;

test('a cone above a lake gives the opening its summit, on the ground', () => {
  const { data, view } = summitWorld(cone, lake);
  const focus = buildFocusM(data, view, { waterLevelM: LEVEL });
  assert.ok(nearConeTop(focus), `${focus}`);
  assert.ok(Math.abs(focus[1] - cone(focus[0], focus[2])) < 0.01, `off the terrain: ${focus}`);
});

test('a cone with no water still gives the opening its summit', () => {
  const { data, view } = summitWorld(cone);
  const focus = buildFocusM(data, view, { waterLevelM: null });
  assert.ok(nearConeTop(focus), `${focus}`);
});

test('a flat basin has no summit: the opening keeps its authored target', () => {
  const { data, view } = summitWorld(() => LEVEL + 5, lake);
  assert.equal(buildFocusM(data, view, { waterLevelM: LEVEL }), null);
});

test('a summit hidden behind a nearer ridge fails the visibility check', () => {
  // A ridge 3.2 km high at 5 km out hides the cone's face from the rail
  // (its own crest stands too high in the frame to count as a summit). The
  // cone is still a candidate, but most of the climb up its face is out of
  // the middle station's sight, so the search finds no focus.
  const ridge = (x, z) => Math.max(cone(x, z), LEVEL + 2200 * Math.max(0, 1 - Math.abs(z - 3500) / 300));
  const { data, view } = summitWorld(ridge);
  const eye = scenePoseAt(view, { progress01: 0.5 }).eyeM;
  const face = [6400, cone(6400, 7000), 7000];
  assert.equal(seenFrom(data, eye, face), false);
  assert.equal(buildFocusM(data, view, { waterLevelM: null }), null);
  // Without the ridge the same face is in sight and the cone is the focus.
  const open = summitWorld(cone).data;
  assert.equal(seenFrom(open, eye, face), true);
  assert.ok(nearConeTop(buildFocusM(open, view, { waterLevelM: null })));
});
