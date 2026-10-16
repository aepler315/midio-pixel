import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/utils/math.js';
import { buildDisasterSchedule, DisasterDirector } from '../src/sim/DisasterDirector.js';
import { QuakeDirector } from '../src/sim/QuakeDirector.js';
import { FireDirector } from '../src/sim/FireDirector.js';

test('buildDisasterSchedule: too short a song gets no disasters at all', () => {
  const rand = mulberry32(1);
  assert.deepEqual(buildDisasterSchedule(rand, 10000, []), []);
});

test('buildDisasterSchedule: a long song without hotspots still gets a scheduled quake', () => {
  const rand = mulberry32(2);
  const sched = buildDisasterSchedule(rand, 180000, []);
  assert.equal(sched.length, 1);
  assert.equal(sched[0].kind, 'quake');
  assert.ok(sched[0].tMs > 0 && sched[0].tMs < 180000);
});

test('buildDisasterSchedule: anchors near a supplied hotspot, not at a fixed fraction', () => {
  const rand = mulberry32(3);
  const hotspot = 90000;
  const sched = buildDisasterSchedule(rand, 180000, [hotspot]);
  assert.ok(Math.abs(sched[0].tMs - hotspot) <= 6000, `expected near ${hotspot}, got ${sched[0].tMs}`);
});

test('DisasterDirector: never fires before its own scheduled time', () => {
  const d = new DisasterDirector(9, 180000, [90000]);
  const quake = new QuakeDirector(9);
  d.update(0, 0, { quake });
  assert.equal(d.justStruck, false);
  assert.equal(quake.active, false);
});

test('DisasterDirector: fires exactly once at its scheduled time, and strikes the quake', () => {
  const d = new DisasterDirector(9, 180000, [90000]);
  const quake = new QuakeDirector(9);
  const strikeMs = d._schedule[0].tMs;
  d.update(strikeMs, 500, { quake });
  assert.equal(d.justStruck, true);
  assert.equal(d.struckKind, 'quake');
  // A second update at the same instant must not re-fire.
  d.update(strikeMs, 500, { quake });
  assert.equal(d.justStruck, false);
});

test('DisasterDirector: exclusivity -- reports activeKind while the quake is still live', () => {
  const d = new DisasterDirector(9, 180000, [90000]);
  const quake = new QuakeDirector(9);
  const strikeMs = d._schedule[0].tMs;
  d.update(strikeMs, 0, { quake });
  quake.update(strikeMs, 0.016, null);
  d.update(strikeMs + 16, 0, { quake });
  assert.equal(d.activeKind, 'quake');
});

test('DisasterDirector: never exceeds its own schedule length even run for a very long time', () => {
  const d = new DisasterDirector(9, 180000, [90000]);
  const quake = new QuakeDirector(9);
  let t = 0;
  let fires = 0;
  for (let i = 0; i < 20000; i++) {
    t += 100;
    d.update(t, 0, { quake });
    quake.update(t, 0.1, null);
    if (d.justStruck) fires++;
  }
  assert.equal(fires, d._schedule.length);
});

// durationMs below QUAKE_MIN_DURATION_MS (30000) so buildDisasterSchedule
// returns an empty schedule -- these tests isolate the threshold-triggered
// fire path from the pre-scheduled quake path.
test('DisasterDirector: never triggers a wildfire below the dryness threshold', () => {
  const d = new DisasterDirector(9, 5000, []);
  const fire = new FireDirector();
  const weather = { dryness01: 0.3 };
  d.update(500000, 0, { fire, weather }); // well past MIN_GAP_MS from construction (-Infinity)
  assert.equal(d.justStruck, false);
  assert.equal(fire.active, false);
});

test('DisasterDirector: triggers a wildfire once dryness01 crosses the trigger threshold', () => {
  const d = new DisasterDirector(9, 5000, []);
  const fire = new FireDirector();
  const weather = { dryness01: 0.9 };
  d.update(500000, 1234, { fire, weather, windAngle: 0 });
  assert.equal(d.justStruck, true);
  assert.equal(d.struckKind, 'fire');
  fire.update(500000, 0.016);
  assert.equal(fire.active, true);
  assert.equal(fire.originWorldX, 1234);
});

test('DisasterDirector: wildfire respects the per-song budget -- never fires twice', () => {
  const d = new DisasterDirector(9, 5000, []);
  const fire = new FireDirector();
  const weather = { dryness01: 0.95 };
  let t = 500000;
  let fireCount = 0;
  for (let i = 0; i < 2000; i++) {
    t += 100;
    d.update(t, 0, { fire, weather });
    fire.update(t, 0.1);
    if (d.justStruck && d.struckKind === 'fire') fireCount++;
  }
  assert.equal(fireCount, 1, 'wildfire should strike at most once per song');
});

test('DisasterDirector: exclusivity -- a quake and a live-triggered fire never overlap', () => {
  const d = new DisasterDirector(9, 180000, [90000]);
  const quake = new QuakeDirector(9);
  const fire = new FireDirector();
  const weather = { dryness01: 0.95 }; // dry enough for fire to want to strike immediately
  const strikeMs = d._schedule[0].tMs;
  d.update(strikeMs, 0, { quake, fire, weather });
  assert.equal(d.struckKind, 'quake', 'the pre-scheduled quake should win when both are eligible the same frame');
  quake.update(strikeMs, 0.016, null);
  // Next frame: quake is now active, so fire must not also strike.
  d.update(strikeMs + 16, 0, { quake, fire, weather });
  assert.equal(d.justStruck, false);
  assert.equal(d.activeKind, 'quake');
});
