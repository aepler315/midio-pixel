import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererFixture, energyFixture } from './helpers/highlightRendererFixture.js';
import { ensureRidgeMusicSession, upgradeRidgeMusicSession } from '../src/world/RidgeMotionHistory.js';
import { MAX_FRAMES, MIN_GAP_MS, REGIMES } from '../src/render/HighlightReel.js';
import { FINALE_FREEZE_LEAD_MS } from '../src/core/SongFinale.js';

// The 24 s fixture song holds one whole sky cycle (DayNight's repeating
// cycle for a song under 30 s): high sun ~5 s, sunset ~10 s, night after.
const plan = reel => reel.selections.map(({ id, category, eventAtMs }) => ({ id, category, eventAtMs }));
const climaxEnergy = energyFixture(time => time > 14000 && time < 17000 ? .95 : .1);
const kicks = (from, to, everyMs = 500) => Array.from({ length: Math.floor((to - from) / everyMs) + 1 }, (_, i) => ({
  id: `note:${i}`, tMs: from + i * everyMs, durMs: 80, role: 'RHYTHM', kick: true, vel: .8, pitch: 36 }));
const cadence = (fps, start, end) => Array.from({ length: Math.floor(end * fps / 1000) - Math.ceil(start * fps / 1000) + 1 },
  (_, i) => (Math.ceil(start * fps / 1000) + i) * 1000 / fps);

test('actual Renderer captures the sky regime peaks at identical times at 24/30/60 fps', () => {
  const histories = [];
  for (const fps of [24, 30, 60]) {
    const f = rendererFixture({ cues: [] });
    try {
      const reel = f.drawAt(0);
      assert.deepEqual(reel.selections.map(e => e.category), ['noon', 'sunset', 'night']);
      for (const event of reel.selections) for (const time of cadence(fps, event.eventAtMs - 100, event.eventAtMs + 150)) f.drawAt(time);
      assert.deepEqual(reel.frames.map(frame => frame.label), ['High sun', 'Sunset', 'Deepest night']);
      assert.deepEqual(reel.frames.map(frame => frame.eventAtMs), reel.selections.map(event => event.eventAtMs));
      assert.ok(reel.selections.every(event => event.status === 'captured'));
      histories.push(plan(reel));
    } finally { f.dispose(); }
  }
  assert.deepEqual(histories[0], histories[1]); assert.deepEqual(histories[1], histories[2]);
});

test('the schedule stays out of the finale freeze and holds five regimes at most', () => {
  const f = rendererFixture({ cues: [], energyCurves: climaxEnergy });
  try {
    const reel = f.drawAt(0), limit = f.sim.fracture.finale.freezeAtMs - FINALE_FREEZE_LEAD_MS;
    assert.ok(reel.selections.length <= MAX_FRAMES);
    assert.ok(reel.selections.every(event => Object.hasOwn(REGIMES, event.category) && event.visibleEndMs <= limit));
    assert.equal(reel.selections.some(event => event.category === 'finale'), false);
    for (let i = 1; i < reel.selections.length; i++) assert.ok(reel.selections[i].eventAtMs - reel.selections[i - 1].eventAtMs >= MIN_GAP_MS);
    assert.deepEqual(reel.selections.map(event => event.category), ['noon', 'sunset', 'climax', 'night']);
  } finally { f.dispose(); }
});

test('an actual frame stall across a regime window records a missed peak that a backseek cannot revive', () => {
  const f = rendererFixture({ cues: [] });
  try {
    const reel = f.drawAt(0), noon = reel.selections[0];
    f.drawAt(noon.visibleStartMs - 100); f.drawAt(noon.visibleEndMs + 100);
    assert.equal(reel.frames.length, 0);
    assert.equal(reel.selections[0].status, 'missed');
    f.seekTo(noon.eventAtMs); f.drawAt(noon.eventAtMs);
    assert.equal(reel.selections[0].status, 'missed');
    assert.equal(reel.frames.length, 0);
  } finally { f.dispose(); }
});

test('regime windows run on heard time when output latency delays what is heard', () => {
  const f = rendererFixture({ cues: [] });
  f.sim._outputLatencyFn = () => 250;
  try {
    const reel = f.drawAt(0), noon = reel.selections[0];
    f.drawAt(noon.eventAtMs);
    assert.equal(f.sim.heardTimeMs, noon.eventAtMs - 250);
    assert.equal(reel.frames.length, 0, 'the sky has not reached its peak in heard time yet');
    f.drawAt(noon.eventAtMs + 250);
    assert.equal(reel.frames.length, 1);
    assert.equal(reel.frames[0].atMs, noon.eventAtMs);
    assert.equal(reel.frames[0].capturedAtMs, noon.eventAtMs + 250);
  } finally { f.dispose(); }
});

test('Landscape squall regimes need the drawn Range sky; Trio cannot produce them', () => {
  const stormy = { cues: [], timeline: kicks(1000, 22000), energyCurves: energyFixture(time => time > 9000 && time < 18000 ? .9 : .2) };
  const f = rendererFixture(stormy);
  try {
    const reel = f.drawAt(0), storm = reel.selections.find(event => event.category === 'storm');
    assert.ok(storm, 'the compiled squall is scheduled');
    for (const time of cadence(30, storm.eventAtMs - 100, storm.visibleEndMs + 100)) f.drawAt(time);
    assert.equal(reel.selections.find(event => event.category === 'storm').status, 'rejected',
      'without the Range v2 sky the deck is not on screen');
    assert.equal(reel.frames.some(frame => frame.category === 'storm'), false);
  } finally { f.dispose(); }
  const trio = rendererFixture({ ...stormy, worldId: 'trio' });
  try {
    const categories = trio.drawAt(0).selections.map(event => event.category);
    assert.equal(categories.some(category => ['storm', 'lightning', 'clearing'].includes(category)), false);
    assert.ok(categories.length > 0);
  } finally { trio.dispose(); }
});

test('quiet short input without a sky cycle peak has no highlight candidates', () => {
  const f = rendererFixture({ cues: [], durationMs: 3000, timeline: [], energyCurves: energyFixture(() => 0) });
  try {
    for (const time of [0, 1500, 2900]) f.drawAt(time);
    assert.deepEqual(f.sim.highlightReel.frames, []);
    assert.deepEqual(f.sim.highlightReel.selections, []);
  } finally { f.dispose(); }
});

test('fresh seek, replay and export-style instances share the schedule without reviving missed windows', () => {
  const histories = [];
  for (const start of [0, 7000, 0]) {
    const f = rendererFixture({ cues: [] });
    try {
      f.seekTo(start); const reel = f.drawAt(start);
      histories.push(plan(reel));
      if (start === 7000) assert.equal(reel.selections[0].status, 'missed');
      else {
        const noon = reel.selections[0];
        f.drawAt(noon.eventAtMs); f.seekTo(0); f.drawAt(noon.eventAtMs);
        assert.equal(reel.frames.length, 1);
      }
    } finally { f.dispose(); }
  }
  assert.deepEqual(histories[0], histories[1]); assert.deepEqual(histories[1], histories[2]);
});

test('new analysis evidence keeps reached peaks and replaces only the unplayed future', () => {
  const f = rendererFixture({ cues: [] });
  try {
    const reel = f.drawAt(0);
    const [noon, sunset] = reel.selections;
    f.drawAt(noon.eventAtMs); f.drawAt(sunset.eventAtMs);
    f.sim.energyCurves = climaxEnergy;
    f.drawAt(sunset.eventAtMs + 500);
    assert.deepEqual(reel.selections.map(e => e.category), ['noon', 'sunset', 'climax', 'night']);
    assert.deepEqual(reel.selections.slice(0, 2).map(e => [e.id, e.status]), [[noon.id, 'captured'], [sunset.id, 'captured']]);
    assert.equal(reel.frames.length, 2);
  } finally { f.dispose(); }
});

test('actual RidgeMusic admission reconstructs the same opening/full schedule on seek and export', () => {
  const timeline = [1000, 22000].map((tMs, i) => ({ id: `note:${i}`, tMs, durMs: 80,
    role: 'rhythm', kick: true, vel: .8, pitch: 36 }));
  const opened = { durationMs: 24000, timeline, energyCurves: energyFixture(), conductor: { liveCues: [] } };
  const f = rendererFixture({ cues: [], timeline, ridgeMusicSession: ensureRidgeMusicSession(opened, 'regime-opening') });
  let heard;
  try {
    const reel = f.drawAt(0);
    for (const event of reel.selections.filter(e => e.eventAtMs <= 10000)) f.drawAt(event.eventAtMs);
    f.drawAt(10000);
    heard = plan(reel).filter(e => e.eventAtMs <= 10000);
    assert.equal(heard.length, 2);
  } finally { f.dispose(); }
  const full = { ...opened, energyCurves: climaxEnergy, conductor: { liveCues: [] } };
  const session = upgradeRidgeMusicSession(opened, full, 10000, 'regime-full');
  const histories = [];
  for (const start of [10000, 0, 20000]) {
    const next = rendererFixture({ cues: [], timeline, energyCurves: full.energyCurves, ridgeMusicSession: session });
    try {
      next.seekTo(start); next.drawAt(start);
      const events = plan(next.sim.highlightReel);
      assert.deepEqual(events.filter(e => e.eventAtMs <= 10000), heard, 'already heard peaks stay fixed');
      assert.ok(events.some(e => e.category === 'climax' && e.eventAtMs > 14000), 'the full analysis adds its future climax');
      histories.push(events);
    } finally { next.dispose(); }
  }
  assert.deepEqual(histories[0], histories[1]); assert.deepEqual(histories[1], histories[2]);
});

test('RidgeMusic handoff without a prepared prior reel admits only full-analysis future peaks', () => {
  const timeline = [1000, 22000].map((tMs, i) => ({ id: `note:${i}`, tMs, durMs: 80,
    role: 'rhythm', kick: true, vel: .8, pitch: 36 }));
  const opened = { durationMs: 24000, timeline, energyCurves: energyFixture(), conductor: { liveCues: [] } };
  ensureRidgeMusicSession(opened, 'regime-unprepared-opening');
  const full = { ...opened, energyCurves: climaxEnergy };
  const session = upgradeRidgeMusicSession(opened, full, 10000, 'regime-unprepared-full');
  const f = rendererFixture({ cues: [], timeline, energyCurves: full.energyCurves, ridgeMusicSession: session });
  try {
    f.seekTo(10000); f.drawAt(10000);
    const events = f.sim.highlightReel.selections;
    assert.ok(events.length > 0);
    assert.ok(events.every(event => event.eventAtMs > 10000));
    assert.equal(f.sim.highlightReel.frames.length, 0);
  } finally { f.dispose(); }
});

test('a night peak lost to loading terrain is replaced by a standby still ahead', () => {
  const f = rendererFixture({ cues: [], durationMs: 60000, lastImpactMs: 58000,
    energyCurves: energyFixture(time => time > 30000 && time < 34000 ? .95 : .1) });
  try {
    const reel = f.drawAt(0), [night] = reel.selections, planned = new Set(reel.selections.map(event => event.id));
    assert.equal(night.category, 'night');
    assert.equal(reel.selections.length, MAX_FRAMES);
    // Landscape's terrain is still loading through the opening night.
    let loading = true;
    Object.defineProperty(f.sim.biomes, '_awaitingTerrain', { get: () => loading, set() {}, configurable: true });
    for (const time of cadence(30, night.visibleStartMs - 100, night.visibleEndMs + 50)) f.drawAt(time);
    loading = false;
    assert.equal(reel.selections[0].status, 'rejected');
    const live = reel.selections.filter(event => event.status === 'pending');
    assert.equal(live.length, MAX_FRAMES, 'a standby takes the freed slot');
    const promoted = live.filter(event => !planned.has(event.id));
    assert.equal(promoted.length, 1);
    assert.ok(promoted[0].eventAtMs > night.visibleEndMs);
    for (let i = 1; i < live.length; i++) assert.ok(live[i].eventAtMs - live[i - 1].eventAtMs >= MIN_GAP_MS);
  } finally { f.dispose(); }
});
