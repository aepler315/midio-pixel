import assert from 'node:assert/strict';
import test from 'node:test';
import { TourForestSchedule, windowSet } from '../src/world/alpine/TourForest.js';
import { keyTimeline, syntheticPlaced, syntheticIndex } from './helpers/tourForestFixtures.mjs';

test('growth windows retain trees that enter the camera ring when heights flatten', () => {
  const index = syntheticIndex(syntheticPlaced({ extent: 500, spacing: 100 }));
  const tl = keyTimeline([[0, 10000, 0], [0, 10000, -10], [0, 10000, -20]], 100);
  assert.equal(windowSet(index, tl, 0).size, 0, 'the full-height camera is far above these trees');
  assert.ok(windowSet(index, tl, 0, { horizontal: true }).size > 0, 'flattening brings them into range');
  const schedule = new TourForestSchedule(index, { horizontal: true });
  schedule.setTimeline(tl);
  const state = schedule.stateAt(0);
  assert.ok(schedule.covers(state, [0, 100, 0]), 'moving down with the ground keeps its window');
  assert.equal(schedule.covers(state, [10000, 100, 0]), false, 'lateral moves still enforce the coverage guard');
});
