import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRangeNarrative, narrativePressure } from '../src/world/alpine/RangeNarrative.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';

function curves(durationMs, valueAt = () => .5) {
  const c = new EnergyCurves(durationMs);
  for (let i = 0; i < c.n; i++) c.setFrame(i, Array(7).fill(valueAt(i * 20)));
  return c;
}

test('steady music starts relief early and completes near 58% without draw history', () => {
  const s = compileRangeNarrative({ durationMs: 240000, energyCurves: curves(240000) });
  assert.equal(s.sample(0).revelation, 0);
  assert.ok(s.sample(10000).relief > 0);
  assert.equal(s.sample(140000).revelation, 1);
  assert.deepEqual(s.sample(60000), s.sample(60000));
  const early = s.sample(60000);
  s.sample(220000);
  assert.deepEqual(s.sample(60000), early);
  assert.ok(Object.isFrozen(early.cast));
  assert.deepEqual(s.sample(240000).cast, { broshi: 0, midasus: 0, midio: 0 });
});

test('a long silent passage holds accumulated reveal while quiet sustained music advances', () => {
  const s = compileRangeNarrative({ durationMs: 240000,
    energyCurves: curves(240000, t => t >= 60000 && t < 110000 ? 0 : .001) });
  assert.equal(s.sample(70000).revelation, s.sample(100000).revelation);
  assert.ok(s.sample(120000).revelation > s.sample(60000).revelation);
  let prev = 0;
  for (let t = 0; t <= 240000; t += 333) {
    const next = s.sample(t).revelation;
    assert.ok(next >= prev); prev = next;
  }
});

test('silence and unknown duration do not manufacture progress', () => {
  for (const input of [{ durationMs: 100000, energyCurves: curves(100000, () => 0) },
    { durationMs: 0, timeline: [{ tMs: 0, durMs: 500, vel: 1, role: 'MELODY' }] }, { durationMs: 100000 }]) {
    const f = compileRangeNarrative(input).sample(99000);
    assert.equal(f.revelation, 0);
    assert.deepEqual(f.cast, { broshi: 1, midasus: 1, midio: 1 });
  }
});

test('MIDI gate follows actual notes even when synthesized curves retain an ambient floor', () => {
  const s = compileRangeNarrative({ durationMs: 120000, energyCurves: curves(120000), timeline: [
    { tMs: 0, durMs: 20000, src: 'midi', role: 'MELODY', pitch: 72, vel: 1 },
    { tMs: 100000, durMs: 20000, src: 'midi', role: 'MELODY', pitch: 76, vel: 1 },
  ] });
  assert.equal(s.sample(30000).revelation, s.sample(90000).revelation);
});

test('timed MIDI sustains can reveal without curves and synthetic pitch cannot move land', () => {
  const timeline = [{ tMs: 0, durMs: 100000, vel: .8, role: 'MELODY', lane: 'MIDIO', src: 'midi', pitch: 72 },
    { tMs: 0, durMs: 100000, vel: .7, role: 'MELODY', lane: 'MIDASUS', pitch: 96, pitchProvenance: 'synthetic' }];
  const s = compileRangeNarrative({ durationMs: 100000, timeline,
    casting: { midio: 'lead-lane', midasus: 'clean-lane', broshi: 'melody' } });
  const f = s.sample(50000);
  assert.ok(f.revelation > .9);
  assert.ok(f.sources.midio.activity > .5, 'long active note survives the usual 4s lookback');
  assert.ok(f.sources.midio.pitchActivity > .5);
  assert.equal(f.sources.midasus.pitchActivity, 0);
  assert.ok(f.sources.midasus.activity > .5, 'uncertain pitch retains activity');
});

test('fallback sharing is explicit, causal and fixed after compilation', () => {
  const timeline = [{ tMs: 1000, durMs: 1000, vel: 1, role: 'MELODY', pitch: 70, src: 'midi' }];
  const s = compileRangeNarrative({ durationMs: 10000, timeline });
  timeline[0].vel = 0;
  assert.equal(s.sample(900).sources.midasus.activity, 0);
  const f = s.sample(1200);
  assert.equal(f.sources.midasus.source, f.sources.broshi.source);
  assert.equal(f.sources.midasus.activity, 1);
  assert.equal(f.sources.midio.activity, 0);
  assert.equal(f.shortClip, true);
});

test('only detected boundaries can nudge internal handoffs, preserving overall endpoints', () => {
  const input = { durationMs: 240000, energyCurves: curves(240000) };
  const plain = compileRangeNarrative(input);
  const anchor = plain.milestones.broshi[0];
  const decorative = compileRangeNarrative({ ...input, sections: [{ startMs: anchor + 1000, provenance: 'decorative', confidence: 1 }] });
  assert.deepEqual(decorative.milestones, plain.milestones);
  const detected = compileRangeNarrative({ ...input, sections: [{ startMs: anchor + 1000, provenance: 'detected', confidence: 1 }] });
  assert.equal(detected.milestones.broshi[0], anchor + 1000);
  assert.equal(detected.sample(140000).revelation, 1);
});

test('pressure survives hype, stays capped and loses pulse/contraction under reduced policies', () => {
  assert.equal(narrativePressure({ skyDark: 1 }, 1).edgeAlpha, .32);
  assert.equal(narrativePressure({ skyDark: 1 }, 1, { reducedFlash: true }).edgeAlpha, .24);
  assert.equal(narrativePressure({ skyDark: 1 }, 1, { reducedMotion: true }).contraction, 0);
  assert.equal(narrativePressure(null, 1).edgeAlpha, 0);
});

test('a partial analysis bin still reaches the full destination at the duration', () => {
  const s = compileRangeNarrative({ durationMs: 7, timeline: [{ tMs: 0, vel: 1, durMs: 100, src: 'midi' }] });
  assert.equal(s.sample(7).progress, 1);
  assert.equal(s.sample(7).revelation, 1);
});

test('quiet audible music before an abrupt loud intro contributes to progress', () => {
  const s = compileRangeNarrative({ durationMs: 120000,
    energyCurves: curves(120000, t => t < 60000 ? .001 : 1) });
  assert.ok(s.sample(30000).progress > .05);
});

test('boundary nudges preserve the global order of distinct revelation anchors', () => {
  const input = { durationMs: 30000, energyCurves: curves(30000) };
  const plain = compileRangeNarrative(input);
  const boundary = (plain.milestones.relief[1] + plain.milestones.midio[0]) / 2;
  const snapped = compileRangeNarrative({ ...input, sections: [{ startMs: boundary, provenance: 'detected' }] });
  assert.ok(snapped.milestones.relief[1] < snapped.milestones.midio[0]);
});

test('detected-boundary nudges freeze every channel and cast weight across silence', () => {
  const input = { durationMs: 240000, energyCurves: curves(240000, t => t >= 60000 && t < 110000 ? 0 : .5) };
  const plain = compileRangeNarrative(input);
  const s = compileRangeNarrative({ ...input, sections: [{ startMs: plain.milestones.broshi[0] + 1000, provenance: 'detected' }] });
  assert.deepEqual(s.sample(60300), s.sample(100000));
});

test('physical recording noise does not reveal the scene before audible music', () => {
  const c = curves(120000, t => t < 60000 ? .01 : .8);
  c.rmsBands = Array.from({ length: 7 }, () => Float32Array.from({ length: c.n }, (_, i) => i < 3000 ? 1e-5 : .1));
  const s = compileRangeNarrative({ durationMs: 120000, energyCurves: c });
  assert.equal(s.sample(50000).progress, 0);
  assert.deepEqual(s.sample(50000).cast, { midio: 1, broshi: 1, midasus: 1 });
  assert.equal(s.sample(120000).revelation, 1);
});

test('quiet physical music stays audible ahead of a loud passage', () => {
  const c = curves(120000, t => t < 60000 ? .01 : .8);
  c.rmsBands = Array.from({ length: 7 }, () => Float32Array.from({ length: c.n }, (_, i) => i < 3000 ? .0005 : .1));
  assert.ok(compileRangeNarrative({ durationMs: 120000, energyCurves: c }).sample(30000).progress > .05);
});
