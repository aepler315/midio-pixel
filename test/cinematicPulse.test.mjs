import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileCinematicPulse, pulseEnvelopeAt, PULSE_QUIET_FLOOR, PULSE_PEAK,
} from '../src/world/alpine/CinematicPulse.js';
import { rangeCameraMoveAt, MOVE_LIMITS, FINALE_MS } from '../src/world/alpine/RangeCamera.js';
import { compileLandRise } from '../src/world/alpine/LandRise.js';
import { compileLandscapeScore } from '../src/world/alpine/LandscapeScore.js';

const sections = [
  { startMs: 0, endMs: 10000, relEnergy01: 0.2, provenance: 'detected' },
  { startMs: 20000, endMs: 30000, relEnergy01: 0.9, role: 'chorus', provenance: 'detected' },
  { startMs: 40000, endMs: 50000, relEnergy01: 0.3, provenance: 'detected' },
  { startMs: 60000, endMs: 70000, relEnergy01: 0.85, role: 'drop', provenance: 'detected' },
];
const read = () => 0.5;
const compile = (extra = {}) => compileCinematicPulse({ sections, read, durationMs: 80000, ...extra });

test('a trusted musical turn becomes one bounded alternating accent', () => {
  const pulse = compile();
  assert.deepEqual(pulse.cues.map(c => c.timeMs), [20000, 40000, 60000]);
  assert.deepEqual(pulse.cues.map(c => c.sign), [1, -1, 1]);
  assert.ok(Object.isFrozen(pulse.cues));
  assert.equal(pulse.at(10000).accent01, 0);
  assert.equal(pulse.at(15000).accent01, 0, 'the lead is short');
  assert.ok(pulse.at(19500).accent01 > 0, 'the turn is anticipated');
  assert.equal(pulse.at(20000).sign, 1);
  assert.equal(pulse.at(40000).sign, -1);
  assert.equal(pulse.at(70000).accent01, 0, 'the release ends before the next section');
  const push = rangeCameraMoveAt({ timeMs: 20000, sections, durationMs: 80000, seed: 1, pulse });
  const plain = rangeCameraMoveAt({ timeMs: 20000, sections, durationMs: 80000, seed: 1 });
  assert.ok(push.dolly > plain.dolly, 'accent adds gentle forward breathing room');
  assert.ok(push.crane > plain.crane, 'accent lifts crane slightly');
  for (const name of ['dolly', 'yaw', 'crane', 'truck']) {
    assert.ok(push[name] >= MOVE_LIMITS[name][0] - 1e-9 && push[name] <= MOVE_LIMITS[name][1] + 1e-9);
  }
  assert.deepEqual(pulse.at(20000), pulse.at(20000), 'a sample is a pure value');
});

test('the envelope is smooth and zero outside its own turn', () => {
  const pulse = compile();
  const cue = { timeMs: 20000 };
  assert.equal(pulseEnvelopeAt(cue, 19099), 0);
  assert.equal(pulseEnvelopeAt(cue, 20000), 1);
  assert.equal(pulseEnvelopeAt(cue, 20699), 1);
  assert.equal(pulseEnvelopeAt(cue, 22900), 0);
  let prev = 0;
  for (let t = 19100; t <= 20000; t += 50) {
    const e = pulseEnvelopeAt(cue, t);
    assert.ok(e >= prev, `approach at ${t}`);
    prev = e;
  }
  prev = 1;
  for (let t = 20700; t <= 22900; t += 50) {
    const e = pulseEnvelopeAt(cue, t);
    assert.ok(e <= prev, `release at ${t}`);
    prev = e;
  }
  assert.ok(pulse.at(20000).pace01 > pulse.at(15000).pace01);
  for (let t = 0; t < 80000; t += 250) {
    const p = pulse.paceAt(t);
    assert.ok(p >= PULSE_QUIET_FLOOR - 1e-12 && p <= PULSE_PEAK + 1e-12, `pace ${p} at ${t}`);
  }
});

test('re-analysis cannot flip a pulse the listener already heard', () => {
  const first = compile();
  const refinedSections = sections.map((s) => s.startMs === 20000 ? { ...s, startMs: 21000 } : s);
  const next = compileCinematicPulse({ sections: refinedSections, read, durationMs: 80000,
    previous: first, freezeThroughMs: 20500 });
  assert.deepEqual(next.cues[0], first.cues[0]);
  assert.equal(next.at(20000).sign, first.at(20000).sign);
  assert.equal(next.at(20000).accent01, first.at(20000).accent01);
  assert.ok(next.at(40000).sign !== next.at(20000).sign);
});

test('a camera accent adds bounded alternating motion on the same heard clock', () => {
  const pulse = compile();
  const args = { sections, durationMs: 80000, seed: 7, cadenceMs: 80000 };
  const plain = rangeCameraMoveAt({ ...args, timeMs: 20000 });
  const accented = rangeCameraMoveAt({ ...args, timeMs: 20000, pulse });
  assert.ok(Math.abs(accented.dolly - plain.dolly) + Math.abs(accented.yaw - plain.yaw)
    + Math.abs(accented.crane - plain.crane) + Math.abs(accented.truck - plain.truck) > 0);
  for (const t of [19500, 20000, 22000, 40000, 60000]) {
    const move = rangeCameraMoveAt({ ...args, timeMs: t, pulse });
    for (const [channel, [lo, hi]] of Object.entries(MOVE_LIMITS)) {
      assert.ok(move[channel] >= lo - 1e-12 && move[channel] <= hi + 1e-12, `${channel} at ${t}`);
    }
    assert.deepEqual(move, rangeCameraMoveAt({ ...args, timeMs: t, pulse }));
  }
  // No accents during the closing move, so the tail still holds exactly.
  const tail = rangeCameraMoveAt({ ...args, timeMs: 80000 - FINALE_MS + 500, pulse });
  assert.deepEqual(tail, rangeCameraMoveAt({ ...args, timeMs: 80000 - FINALE_MS + 500 }));
});

test('the score feeds its one pulse to both the camera and the climb', () => {
  const shaped = t => t >= 20000 && t < 30000 ? 0.9 : t >= 40000 && t < 50000 ? 0.3 : t >= 60000 ? 0.85 : 0.2;
  const score = compileLandscapeScore({ energyCurves: { globalEnergyNorm: shaped }, sections, durationMs: 80000 });
  assert.ok(score.pulse.cues.length > 0);
  const plainCamera = rangeCameraMoveAt({ timeMs: 20000, sections: score.phrases,
    durationMs: 80000, seed: 0, cadenceMs: score.cadenceMs });
  assert.notDeepEqual(score.at(20000).camera, plainCamera);
  const paced = compileLandRise({ read: shaped, durationMs: 80000, cadenceMs: score.cadenceMs,
    finaleMs: FINALE_MS, paceAt: score.pulse.paceAt });
  const unpaced = compileLandRise({ read: shaped, durationMs: 80000, cadenceMs: score.cadenceMs, finaleMs: FINALE_MS });
  assert.notEqual(paced.progressAt(20000), unpaced.progressAt(20000));
  assert.equal(paced.progressAt(68000), 1);
  assert.equal(paced.at(80000), 1);
  assert.deepEqual(score.at(20000), score.at(20000));
});
