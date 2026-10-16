import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flightSchedule, assertExportTime } from '../tools/lib/glacial-smoke-schedule.mjs';

test('motion is rendered before later song samples on the forward-only export clock', () => {
  const schedule = flightSchedule([12000, 150000, 159000, 300000, 345000], true);
  assert.equal(schedule.length, 113);
  for (let i = 1; i < schedule.length; i++) assert.ok(schedule[i].timeMs >= schedule[i - 1].timeMs);
  const motion = schedule.filter(e => e.type === 'motion');
  assert.equal(motion[0].timeMs, 150000);
  assert.equal(motion.at(-1).timeMs, 150000 + 107 * 1000 / 12);
  assert.ok(schedule.indexOf(motion.at(-1)) < schedule.findIndex(e => e.type === 'sample' && e.timeMs === 159000));
});

test('samples are sorted even without motion and invalid song times are rejected', () => {
  assert.deepEqual(flightSchedule([159000, 12000], false).map(e => e.timeMs), [12000, 159000]);
  assert.throws(() => flightSchedule([NaN]), /finite/);
  assert.throws(() => flightSchedule([-1]), /finite/);
});

test('the smoke rejects a clamped late frame and permits only one simulation tick of rounding', () => {
  assert.throws(() => assertExportTime({ timeMs: 345000 }, 150000), /requested/);
  assert.throws(() => assertExportTime({}, 150000), /requested/);
  assert.doesNotThrow(() => assertExportTime({ timeMs: 150004 }, 150000));
});
