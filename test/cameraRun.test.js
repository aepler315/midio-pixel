import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraRun, openCameraRun, cameraSongOptions, readRailPace, persistRailPace, railPaceControlState } from '../src/ui/CameraRun.js';
import { compileSceneRailPlan, withSceneRailPace } from '../src/world/terrain/SceneRailPlan.js';
const compile = (pace = 3) => compileSceneRailPlan({ sections: [0, 20000, 40000].map((startMs, i) => ({ startMs, profile: `v${i}` })), choiceFor: name => ({ view: { id: name } }), durationMs: 60000, requestedMultiplier: pace, seed: 7, worldId: 'range' });

test('selected pace source wins strictly, including invalid URL and blocked storage', () => {
  const storage = { getItem: () => '2' };
  assert.equal(readRailPace('?rangePace=4', storage), 4);
  assert.equal(readRailPace('?rangePace=bad', storage), 3);
  assert.equal(readRailPace('?rangePace=', storage), 3);
  assert.equal(readRailPace('', storage), 2);
  assert.equal(readRailPace('', { getItem() { throw Error('blocked'); } }), 3);
  for (const pace of [1, 2, 3, 4]) assert.equal(readRailPace(`?rangePace=${pace}`, null), pace);
});

test('pace persistence updates URL without dropping existing settings and tolerates storage errors', () => {
  let replaced;
  const url = persistRailPace(4, { href: 'https://example.test/?rangeTour=off#play', storage: { setItem() { throw Error('blocked'); } }, replace: value => { replaced = value; } });
  assert.equal(url.searchParams.get('rangePace'), '4');
  assert.equal(url.searchParams.get('rangeTour'), 'off');
  assert.equal(url.hash, '#play');
  assert.equal(String(replaced), String(url));
});

test('run high-water commits forward seek and stays committed after rewind and seek zero', () => {
  const run = new CameraRun({ data: {}, seed: 7, requestedMultiplier: 3 });
  run.install('range', compile().snapshot);
  run.reach(45000); run.reach(1200); run.reach(0); run.reach(NaN);
  assert.equal(run.highWaterMs, 45000);
  const before = run.scheduleFor('range');
  const next = run.setPace(4, 'range');
  assert.deepEqual(next.occurrences, before.occurrences);
  assert.equal(run.requestedMultiplier, 4);
  assert.equal(run.highWaterMs, 45000);
  assert.equal(run.scheduleFor('other'), null, 'never borrow incompatible world');
  assert.equal(run.scheduleFor('range'), next, 'return from Trio retains ordinary history');
});

test('future-only repace keeps live history while exports and prior JSON captures remain unchanged', () => {
  const data = {};
  const run = new CameraRun({ data, seed: 7, requestedMultiplier: 3 });
  run.install('range', compile().snapshot); run.reach(15000);
  const old = run.scheduleFor('range'), captured = JSON.parse(JSON.stringify(old));
  const next = run.setPace(4, 'range');
  assert.deepEqual(next.occurrences[0], old.occurrences[0]);
  assert.equal(next.occurrences[1].requestedMultiplier, 4);
  assert.deepEqual(old, captured);
  withSceneRailPace(compile(), 1, 0); // isolated export querying/refitting cannot reach the run
  assert.equal(run.scheduleFor('range'), next);
  assert.equal(run.highWaterMs, 15000);
  assert.equal(data.cameraSchedule, next);
});

test('same seed replay is fresh while unchanged settings reproduce baseline schedule', () => {
  const data = {}, old = new CameraRun({ data, seed: 7 });
  old.install('range', compile().snapshot); old.reach(45000); old.setPace(4, 'range');
  const replay = new CameraRun({ data, seed: 7, requestedMultiplier: 4 });
  replay.install('range', compile(4).snapshot);
  assert.notEqual(replay, old);
  assert.equal(replay.highWaterMs, 0);
  assert.deepEqual(replay.scheduleFor('range'), compile(4).snapshot);
});

test('pace control states distinguish Trio, tours, glacier and ordinary rails', () => {
  assert.equal(railPaceControlState({ experience: 'trio' }).disabled, true);
  assert.match(railPaceControlState({ tourMode: 'shots' }).text, /tour/i);
  assert.match(railPaceControlState({ policy: 'glacier' }).text, /glacier/i);
  assert.match(railPaceControlState({}).text, /next unplayed landscape or replay/i);
});

// These are the same lifecycle dispatch/options called by startTimeline.
test('lifecycle dispatch preserves seek and adopts at historical maximum, while replay and new song are fresh', () => {
  const data = {}, run = openCameraRun(null, { data, seed: 7, requestedMultiplier: 3 });
  run.install('range', compile().snapshot); run.reach(45000); run.reach(100);
  for (const intent of ['preserve']) {
    assert.equal(openCameraRun(run, { data, seed: 7, intent }), run);
  }
  const preserved = cameraSongOptions(run, 'range', 'preserve');
  assert.equal(preserved.cameraSchedule, run.scheduleFor('range'));
  assert.equal(preserved.cameraRefineThroughMs, null);
  assert.equal(openCameraRun(run, { data, seed: 7, intent: 'adopt' }), run);
  const adopted = cameraSongOptions(run, 'range', 'adopt');
  assert.equal(adopted.cameraRefineThroughMs, 45000);
  assert.equal(adopted.cameraSchedule, preserved.cameraSchedule);
  assert.notEqual(openCameraRun(run, { data, seed: 7, intent: 'fresh', requestedMultiplier: 4 }), run);
  assert.notEqual(openCameraRun(run, { data: {}, seed: 7, intent: 'preserve' }), run);
  assert.equal(cameraSongOptions(run, 'other', 'preserve').cameraSchedule, null);
  assert.equal(cameraSongOptions(run, 'range', 'preserve', compile(1).snapshot).cameraSchedule.requestedMultiplier, 1);
  assert.equal(run.requestedMultiplier, 3, 'temporary override does not change preference');
});

test('pace changes while touring refit compatible ordinary future, preserving both histories', () => {
  const run = new CameraRun({ data: {}, seed: 7 });
  run.install('range', compile().snapshot); run.install('range:tetons', compile(2).snapshot); run.reach(10000);
  const oldOrdinary = run.scheduleFor('range');
  run.setPace(4, 'range:tetons');
  assert.deepEqual(run.scheduleFor('range').occurrences[0], oldOrdinary.occurrences[0]);
  assert.equal(run.scheduleFor('range').occurrences[1].requestedMultiplier, 4);
  assert.equal(run.scheduleFor('range:tetons').occurrences[1].requestedMultiplier, 4);
});

// Break caught: a seek replanning a refined tour from zero, rewriting the heard camera.
test('a preserved run carries heard tour timelines to the rebuild at its high-water; fresh runs do not', () => {
  const data = {}, run = openCameraRun(null, { data, seed: 7, requestedMultiplier: 3 });
  const first = { id: 'first' }, refined = { id: 'refined' }, other = { id: 'other' };
  assert.equal(run.tourContinuation(), null);
  run.reach(40000);
  assert.equal(openCameraRun(run, { data, seed: 7, intent: 'preserve', tours: { timelines: new Map([['a', first], ['b', other]]) } }), run);
  run.reach(12000);
  assert.equal(openCameraRun(run, { data, seed: 7, intent: 'preserve', tours: { timelines: new Map([['a', refined]]) } }), run);
  assert.equal(openCameraRun(run, { data, seed: 7, intent: 'preserve', tours: null }), run);
  const carried = run.tourContinuation();
  assert.equal(carried.committedThroughMs, 40000);
  assert.deepEqual([...carried.timelines], [['a', refined], ['b', other]]);
  run.forgetTours();
  assert.equal(run.tourContinuation(), null, 'a tour-mode change does not bring the old tour back');
  run.retainTours({ timelines: new Map([['a', refined]]) });
  const replay = openCameraRun(run, { data, seed: 7, intent: 'fresh', tours: { timelines: new Map([['a', refined]]) } });
  assert.notEqual(replay, run);
  assert.equal(replay.tourContinuation(), null);
});

test('a preserved run carries the views kept on their rail; a tour-mode change forgets them', () => {
  const data = {}, run = openCameraRun(null, { data, seed: 7 }), tour = { id: 'tour' };
  run.reach(25000);
  openCameraRun(run, { data, seed: 7, intent: 'preserve',
    tours: { timelines: new Map([['a', tour]]), railKept: new Map([['b', 'rail kept: the tour spends 62% in transit']]) } });
  const carried = run.tourContinuation();
  assert.deepEqual([...carried.timelines], [['a', tour]]);
  assert.deepEqual([...carried.railKept], [['b', 'rail kept: the tour spends 62% in transit']]);
  assert.equal(carried.committedThroughMs, 25000);
  run.retainTours({ timelines: new Map([['b', tour]]) });
  assert.deepEqual([...run.tourContinuation().railKept], [], 'a view carries one camera choice, the newest');
  run.forgetTours();
  assert.equal(run.tourContinuation(), null);
  run.retainTours({ railKept: new Map([['b', 'rail kept: no payoff on screen']]) });
  assert.deepEqual([...run.tourContinuation().railKept], [['b', 'rail kept: no payoff on screen']], 'a rail alone is still carried');
});

test('analysis adoption while another world is active refines dormant landscape on return', () => {
  const data = {}, run = new CameraRun({ data, seed: 7 });
  run.install('range', compile().snapshot); run.reach(30000);
  openCameraRun(run, { data, seed: 7, intent: 'adopt' });
  assert.equal(cameraSongOptions(run, 'range', 'preserve').cameraRefineThroughMs, 30000);
  run.install('range', compile().snapshot);
  assert.equal(cameraSongOptions(run, 'range', 'preserve').cameraRefineThroughMs, null);
});
