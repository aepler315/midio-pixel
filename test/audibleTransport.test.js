import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conductor } from '../src/core/Conductor.js';
import { Simulation } from '../src/sim/Simulation.js';
import { ParamBus } from '../src/core/ParamBus.js';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { GroundField } from '../src/world/GroundField.js';
import { Role, makeNoteEvent } from '../src/core/NoteEvent.js';
import { buildRangeFrame, viewportState } from '../src/world/alpine/RangeFrame.js';

const note = (tMs, vel = .8) => makeNoteEvent({ tMs, pitch: 36, vel, role: Role.RHYTHM, kick: true, src: 'audio' });
const data = (extra = {}) => ({ timeline: [note(1000), note(2000), note(3000)], durationMs: 60000, barGrid: [], bpm: 90, confidence: .9, firstBarMs: 200, ...extra });

test('ground glow samples heard time while the collision clock stays on source time', () => {
  const gf = new GroundField(625, { durationMs: 0 });
  gf.kickGlow(0, 1000, 1);
  gf.update(1250, 0, 0, null, 0, 1100);
  assert.equal(gf._nowMs, 1250);
  const lights = gf.activeGlowScreenLights(0, 400);
  assert.equal(lights.length, 1);
  assert.ok(Math.abs(lights[0].intensity - Math.exp(-.1 / .09)) < 1e-7);
});

test('detected 90 BPM and downbeat survive sparse kick timing', () => {
  const c = new Conductor(); c.load(data());
  const s = new Simulation(c, new ParamBus(), { bpm: 90, songSeed: 3, worldId: 'range' });
  for (const at of [0, 1000, 2000, 3000, 4000, 5000]) {
    s.syncSongBeat(at);
    assert.ok(Math.abs(s.beatAnchor.periodMs - 60000 / 90) < 1e-8);
    assert.ok(Math.abs(s.beatAnchor.anchorMs - 200) < 1e-8);
  }
  assert.equal(s.songBeat.snapshotAt(1000).confidence, .9);
  assert.equal(s.presentationBeatAnchor.confidence, .9, 'the detected phase reaches the ensemble without requiring taps');
  s.dispose();
});

test('a low-confidence local tempo window falls back to global pulse without extending the prior window', () => {
  const c = new Conductor(); c.load(data({ bpm: 120, firstBarMs: 0, localTempo: [
    { tMs: 0, beatPeriodMs: 400, confidence: .9 },
    { tMs: 10000, beatPeriodMs: 750, confidence: .1 },
    { tMs: 20000, beatPeriodMs: 500, confidence: .9 },
  ] }));
  const s = new Simulation(c, new ParamBus(), { songSeed: 3, worldId: 'range' });
  assert.equal(s.songBeat.snapshotAt(15000).periodMs, 500);
  assert.equal(s.songBeat.snapshotAt(15000).beatIndex, 35);
  s.dispose();
});

test('local tempo has source-aligned continuous phase and meter', () => {
  const c = new Conductor(); c.load(data({ bpm: 120, firstBarMs: 0, localTempo: [
    { tMs: 0, beatPeriodMs: 500 }, { tMs: 2000, beatPeriodMs: 1000 },
  ], barGrid: [{ ms: 0, numerator: 3, denominator: 4 }, { ms: 1500, numerator: 3, denominator: 4 }] }));
  const s = new Simulation(c, new ParamBus(), { bpm: 120, songSeed: 3, worldId: 'range' });
  s.syncSongBeat(2500);
  assert.equal(s.beatAnchor.periodMs, 1000);
  assert.equal(s.songBeat.snapshotAt(2500).beatIndex, 4);
  assert.equal(s.songBeat.snapshotAt(2500).phase01, .5);
  assert.equal(s.songBeat.snapshotAt(2500).numerator, 3);
  s.dispose();
});

test('uncertain free-time audio exposes no invented metrical confidence', () => {
  const c = new Conductor(); c.load(data({ confidence: 0, freeTime: true }));
  const s = new Simulation(c, new ParamBus(), { songSeed: 3, worldId: 'range' });
  s.syncSongBeat(5000);
  assert.equal(s.songBeat.snapshotAt(5000).freeTime, true);
  assert.equal(s.songBeat.snapshotAt(5000).confidence, 0);
  assert.equal(s.songBeat.snapshotAt(5000).phase01, 0);
  s.dispose();
});

test('actual Conductor seek retains the same heard-time kick envelope without firing past cues', () => {
  const curves = new EnergyCurves(60000, 50);
  for (let i = 0; i < curves.n; i++) curves.setFrame(i, Array(7).fill(.35));
  const vp = viewportState({ logicalWidth: 1280, logicalHeight: 720, backingWidth: 1280, backingHeight: 720 });
  function frame(seek, presentationTime, lag) {
    const c = new Conductor(); c.load(data({ timeline: [note(1000), note(1200)] }));
    const mgr = new BiomeManager({ conductor: c, energyCurves: curves, durationMs: 60000, canvasWidth: 1280, canvasHeight: 720, groundY: 625, songSeed: 3, worldId: 'range' });
    let fired = 0; c.on('*', () => fired++);
    if (seek) c.seekTo(presentationTime, { primeAhead: true });
    c.dispatchUpTo(presentationTime);
    mgr.visualLagMs = lag;
    mgr.update(presentationTime, 0, curves);
    const f = buildRangeFrame({ frameId: 1, sim: { biomes: mgr, conductor: c, songSeed: 3, stageW: 1280 }, pose: { worldX: 0, midioX: 400 }, scenicViewport: vp, groundViewport: vp });
    const result = { music: f.music, timeMs: f.timeMs, rhythmMs: mgr.worldRhythm?.tMs, fired };
    mgr.dispose(); return result;
  }
  const straight = frame(false, 1100, 0), seek = frame(true, 1100, 0), lagged = frame(true, 1250, 150);
  assert.ok(straight.music.source.kickM > 0, 'the kick is heard (the land itself stays still between moments)');
  assert.deepEqual(seek.music, straight.music);
  assert.deepEqual(lagged.music, straight.music, 'a future dispatch must not replace the last heard kick');
  assert.equal(lagged.timeMs, 1100);
  assert.equal(lagged.rhythmMs, 1000);
  assert.equal(seek.fired, 0);
});
