import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererFixture, energyFixture } from './helpers/highlightRendererFixture.js';
import { ensureRidgeMusicSession, upgradeRidgeMusicSession } from '../src/world/RidgeMotionHistory.js';

test('actual Renderer retains the Finale whose captureFreeze already changed state', () => {
  const f = rendererFixture({ cues: [], durationMs: 8000, lastImpactMs: 5220 });
  try {
    const reel = f.drawAt(5000);
    assert.equal(f.sim.fracture.isAboutToFreeze, false);
    assert.equal(f.sim.fracture.freezeMs, 5000);
    assert.deepEqual(reel.frames.map(frame => frame.label), ['Finale']);
    assert.equal(reel.frames[0].eventAtMs, 5000);
  } finally { f.dispose(); }
});

test('actual Renderer selects identical event-time gaps at 24/30/60 fps', () => {
  const histories = [];
  for (const fps of [24, 30, 60]) {
    const f = rendererFixture({ cues: [6000, 10999, 11000, 11001].map((tMs, i) => ({
      id: `drop:${i}`, tMs, kind: 'drop', value: 1 })) });
    try {
      for (let frame = 0; frame <= Math.ceil(11200 * fps / 1000); frame++) f.drawAt(frame * 1000 / fps);
      assert.deepEqual(f.sim.highlightReel.frames.map(frame => frame.eventAtMs), [6000, 11000]);
      histories.push(f.sim.highlightReel.selections.map(({ id, eventAtMs }) => ({ id, eventAtMs })));
    } finally { f.dispose(); }
  }
  assert.deepEqual(histories[0], histories[1]); assert.deepEqual(histories[1], histories[2]);
});

test('coincident actual Drop and Finale select Finale by category priority', () => {
  const f = rendererFixture({ durationMs: 8000, lastImpactMs: 5220 });
  try {
    const reel = f.drawAt(5000);
    assert.equal(f.sim.hype.dropCount, 1);
    assert.deepEqual(reel.frames.map(frame => frame.label), ['Finale']);
  } finally { f.dispose(); }
});

test('an actual frame stall across a Drop window records a missed semantic event', () => {
  const f = rendererFixture();
  try {
    f.drawAt(4900); const reel = f.drawAt(5200);
    assert.equal(f.sim.hype.dropCount, 1);
    assert.equal(reel.frames.length, 0);
    assert.equal(reel.selections.find(event => event.category === 'drop').status, 'missed');
    assert.equal(reel.selections.find(event => event.category === 'drop').eventAtMs, 5000);
  } finally { f.dispose(); }
});

test('actual producer windows preserve visible Drops when the heard clock has output latency', () => {
  const f = rendererFixture();
  f.sim._outputLatencyFn = () => 250;
  try {
    const reel = f.drawAt(5000);
    assert.equal(f.sim.heardTimeMs, 4750);
    assert.equal(reel.frames.length, 1);
    assert.equal(reel.frames[0].eventAtMs, 5000);
    assert.equal(reel.frames[0].atMs, 4750);
    assert.equal(reel.frames[0].capturedAtMs, 5000);
  } finally { f.dispose(); }
});

test('actual energy-inferred Drops have stable fixed-step evidence at every frame cadence', () => {
  const histories = [];
  for (const fps of [24, 30, 60]) {
    const f = rendererFixture({ cues: [], energyCurves: energyFixture(time => time < 5000 ? .1 : .95) });
    try {
      f.drawAt(0);
      const candidate = f.sim.highlightReel.selections?.find(event => event.source === 'energy');
      assert.ok(candidate, 'the existing energy detector must remain a reachable highlight producer');
      for (let frame = 1; frame <= Math.ceil((candidate.eventAtMs + 110) * fps / 1000); frame++) f.drawAt(frame * 1000 / fps);
      assert.equal(f.sim.highlightReel.frames[0].eventId, candidate.id);
      assert.equal(f.sim.highlightReel.frames[0].eventAtMs, candidate.eventAtMs);
      histories.push({ id: candidate.id, eventAtMs: candidate.eventAtMs });
    } finally { f.dispose(); }
  }
  assert.deepEqual(histories[0], histories[1]); assert.deepEqual(histories[1], histories[2]);
});

test('Drops capture a live bloom but cannot capture fully shed effects', () => {
  for (const quality of [0, 6]) {
    const f = rendererFixture({ quality });
    try {
      for (const time of [4900, 5000, 5100]) f.drawAt(time);
      const reel = f.sim.highlightReel;
      assert.equal(reel.frames.length, quality === 0 ? 1 : 0);
      if (quality === 6) assert.equal(reel.selections.find(event => event.category === 'drop').status, 'rejected');
    } finally { f.dispose(); }
  }
});

test('quiet short input without actual event evidence has no highlight candidates', () => {
  const f = rendererFixture({ cues: [], durationMs: 3000, timeline: [], energyCurves: energyFixture(() => 0) });
  try {
    for (const time of [0, 1500, 2900]) f.drawAt(time);
    assert.deepEqual(f.sim.highlightReel.frames, []);
    assert.deepEqual(f.sim.highlightReel.selections, []);
  } finally { f.dispose(); }
});

test('fresh seek, replay and export-style instances share winners without reviving missed windows', () => {
  const histories = [];
  for (const start of [0, 5200, 0]) {
    const f = rendererFixture();
    try {
      f.seekTo(start); f.drawAt(start);
      histories.push(f.sim.highlightReel.selections.map(({ id, eventAtMs }) => ({ id, eventAtMs })));
      if (start === 5200) assert.equal(f.sim.highlightReel.selections[0].status, 'missed');
      else {
        f.drawAt(5000); f.seekTo(0); f.drawAt(5000);
        assert.equal(f.sim.highlightReel.frames.length, 1);
      }
    } finally { f.dispose(); }
  }
  assert.deepEqual(histories[0], histories[1]); assert.deepEqual(histories[1], histories[2]);
});

test('new analysis evidence keeps reached candidates and replaces only the unplayed future', () => {
  const f = rendererFixture({ cues: [5000, 15000].map(tMs => ({ id: `old:${tMs}`, tMs, kind: 'drop', value: 1 })) });
  try {
    f.drawAt(0); f.drawAt(5000); f.drawAt(10000);
    f.sim.energyCurves = energyFixture(() => .2);
    f.sim.cues.cues = [2000, 18000].map(tMs => ({ id: `new:${tMs}`, tMs, kind: 'drop', value: 1 }));
    f.drawAt(10000);
    assert.deepEqual(f.sim.highlightReel.selections.filter(e => e.category === 'drop').map(e => e.eventAtMs), [5000, 18000]);
    assert.equal(f.sim.highlightReel.selections[0].status, 'captured');
    assert.equal(f.sim.highlightReel.frames.length, 1);
  } finally { f.dispose(); }
});

test('actual RidgeMusic admission reconstructs the same opening/full winners on seek and export', () => {
  const timeline = [1000, 22000].map((tMs, i) => ({ id: `note:${i}`, tMs, durMs: 80,
    role: 'rhythm', kick: true, vel: .8, pitch: 36 }));
  const cues = [5000, 15000].map(tMs => ({ id: `old:${tMs}`, tMs, kind: 'drop', value: 1 }));
  const opened = { durationMs: 24000, timeline, energyCurves: energyFixture(), conductor: { liveCues: cues } };
  const f = rendererFixture({ cues, timeline, ridgeMusicSession: ensureRidgeMusicSession(opened, 'opening') });
  try { f.drawAt(0); f.drawAt(5000); f.drawAt(10000); }
  finally { f.dispose(); }
  const full = { ...opened, energyCurves: energyFixture(time => time < 14000 ? .1 : .95),
    conductor: { liveCues: [{ id: 'retroactive', tMs: 2000, kind: 'drop', value: 1 },
      { id: 'future', tMs: 18000, kind: 'drop', value: 1 }] } };
  const session = upgradeRidgeMusicSession(opened, full, 10000, 'full');
  const histories = [];
  for (const start of [10000, 0, 20000]) {
    const next = rendererFixture({ cues: full.conductor.liveCues, timeline, energyCurves: full.energyCurves, ridgeMusicSession: session });
    try {
      next.seekTo(start); next.drawAt(start);
      const events = next.sim.highlightReel.selections;
      assert.equal(events[0].eventAtMs, 5000, 'already heard opening event remains fixed');
      assert.ok(events.some(event => event.source === 'energy' && event.eventAtMs > 14000));
      assert.equal(events.some(event => event.eventAtMs === 2000 || event.eventAtMs === 15000), false);
      histories.push(events.map(({ id, eventAtMs }) => ({ id, eventAtMs })));
    } finally { next.dispose(); }
  }
  assert.deepEqual(histories[0], histories[1]); assert.deepEqual(histories[1], histories[2]);
});

test('RidgeMusic handoff preserves a Drop already captured ahead of the heard clock', () => {
  const timeline = [1000, 22000].map((tMs, i) => ({ id: `note:${i}`, tMs, durMs: 80,
    role: 'rhythm', kick: true, vel: .8, pitch: 36 }));
  const cues = [{ id: 'opening', tMs: 5000, kind: 'drop', value: 1 }];
  const opened = { durationMs: 24000, timeline, energyCurves: energyFixture(), conductor: { liveCues: cues } };
  const f = rendererFixture({ cues, timeline, ridgeMusicSession: ensureRidgeMusicSession(opened, 'latency-opening') });
  f.sim._outputLatencyFn = () => 250;
  try {
    f.drawAt(5000);
    assert.equal(f.sim.heardTimeMs, 4750);
    assert.equal(f.sim.highlightReel.frames[0].eventAtMs, 5000);
  } finally { f.dispose(); }
  const full = { ...opened, energyCurves: energyFixture(() => .2),
    conductor: { liveCues: [{ id: 'shifted', tMs: 5001, kind: 'drop', value: 1 }] } };
  const session = upgradeRidgeMusicSession(opened, full, 4750, 'latency-full');
  const histories = [];
  for (const start of [4750, 0, 6000]) {
    const next = rendererFixture({ timeline, cues: full.conductor.liveCues, energyCurves: full.energyCurves, ridgeMusicSession: session });
    try {
      next.seekTo(start); next.drawAt(start);
      assert.equal(next.sim.highlightReel.selections[0].eventAtMs, 5000);
      assert.equal(next.sim.highlightReel.selections[0].id, 'drop:cue:opening');
      histories.push(next.sim.highlightReel.selections.map(({ id, eventAtMs }) => ({ id, eventAtMs })));
    } finally { next.dispose(); }
  }
  assert.deepEqual(histories[0], histories[1]); assert.deepEqual(histories[1], histories[2]);
});

test('RidgeMusic handoff without a prepared prior reel admits only full-analysis future events', () => {
  const timeline = [1000, 22000].map((tMs, i) => ({ id: `note:${i}`, tMs, durMs: 80,
    role: 'rhythm', kick: true, vel: .8, pitch: 36 }));
  const opened = { durationMs: 24000, timeline, energyCurves: energyFixture(), conductor: { liveCues: [] } };
  ensureRidgeMusicSession(opened, 'unprepared-opening');
  const cues = [2000, 18000].map(tMs => ({ id: `full:${tMs}`, tMs, kind: 'drop', value: 1 }));
  const full = { ...opened, conductor: { liveCues: cues } };
  const session = upgradeRidgeMusicSession(opened, full, 10000, 'unprepared-full');
  const f = rendererFixture({ timeline, cues, energyCurves: full.energyCurves, ridgeMusicSession: session });
  try {
    f.seekTo(10000); f.drawAt(10000);
    assert.deepEqual(f.sim.highlightReel.selections.filter(event => event.category === 'drop').map(event => event.eventAtMs), [18000]);
    assert.equal(f.sim.highlightReel.frames.length, 0);
  } finally { f.dispose(); }
});
