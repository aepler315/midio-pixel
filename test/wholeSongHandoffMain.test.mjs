// The production hand-off from a provisional (opening) look to the song's
// whole-song identity (src/main.js adoptWholeSongIdentity), run in a vm with
// its boundaries (terrain, timeline, world tailoring, timers) replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const fn = (name) => {
  const at = main.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} exists`);
  return main.slice(at, main.indexOf('\n}\n', at) + 3);
};
const constants = main.split('\n').filter(line => /^const (IDENTITY_[A-Z_]+|LATE) = /.test(line)).join('\n');
const source = [constants, ...['adoptWholeSongIdentity', 'provisionalStillPreparing', 'withoutRecording', 'rebuildOnWholeAnalysis', 'commitWholeSongIdentity', 'seekSong'].map(fn)].join('\n');

const profile = { version: 2, watch: { drive: 0.6 } };
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup({ running = true, songSeed = 11 } = {}) {
  const timers = [], starts = [], offers = [], library = [], terrains = [];
  const data = { durationMs: 240000, songIdentity: { seed: 42, songProfile: profile }, provisionalSeed: 11,
    worldId: 'custom-1', terrain: { id: 'provisional' }, chapterState: { seed: 11 }, cameraSchedule: {} };
  const context = vm.createContext({
    BIOME_WAIT_MS: 2500, console: { warn() {}, error() {} },
    setTimeout: (cb, ms) => { timers.push({ cb, ms }); return timers.length; },
    pendingWorldStart: null, lastTimelineData: data,
    offerWorldsThenStart: (d, extra) => offers.push({ d, extra }),
    dualSummitsSelection: () => null, withSignatureSource: t => t,
    prepareSongTerrain: (p, seed, recent, options) => new Promise((resolve) => terrains.push({ seed, options, resolve })),
    videoExportSession: { busy: false }, songRecorder: null, pendingCaptureOptions: null, lastAudioBuffer: null,
    running, sim: { songSeed, fitDiagnostic: 'provisional' }, audioEngine: { nowMs: 61000 }, bulkExportArmed: false, paused: false,
    sceneStartMs: 0, stopTimeline: () => { context.running = false; context.stopped = true; },
    startTimeline: (d, extra) => { starts.push({ d, extra }); context.sim = { songSeed: extra.songSeed }; },
    lastStartExtra: { localTrack: { key: 'song' }, playBuffer: {} },
    noteLibrarySongWorld: (track, p, seed) => library.push({ track, seed }),
    recordFitDiagnostic: () => 'whole', lastFitDiagnostic: null,
    getCustomWorld: () => ({ id: 'custom-1' }), setCustomWorld: (w) => { context.custom = w; },
    buildWorldVariant: (base, features) => ({ world: { id: 'custom-2', base, features } }),
    lastBaseWorldId: 'alpine', lastWorldId: 'custom-1', lastSongSeed: 11,
    completeSeedEl: { textContent: '0000000B' }, formatSeed: s => `seed:${s}`,
    updatePauseButtonUI() {}, renderer: { draw() {} }, playbackPreparing: false,
  });
  vm.runInContext(source, context);
  return { context, data, timers, starts, offers, library, terrains };
}

test('a provisional start still waiting on its terrain starts over on the identity', () => {
  const { context, data, offers, terrains } = setup();
  context.pendingWorldStart = { data, provisional: true, extra: { recordingSettings: { fps: 30 }, lyricsReady: 1 } };
  assert.equal(context.adoptWholeSongIdentity(data), null);
  assert.equal(offers.length, 1);
  assert.deepEqual({ ...offers[0].extra }, { lyricsReady: 1 }, 'the legacy recording set-up is not run twice');
  assert.equal(terrains.length, 0);
  assert.equal(data.identityPending, undefined);
});

test('a playing song commits the identity in one rebuild at the heard moment', async () => {
  const { context, data, starts, library, terrains } = setup();
  const done = context.adoptWholeSongIdentity(data);
  assert.equal(data.identityPending, true, 'exports wait while the terrain loads');
  assert.equal(terrains[0].seed, 42);
  assert.ok(Number.isFinite(terrains[0].options.songRangeWaitMs), 'the terrain wait is bounded');
  terrains[0].resolve({ id: 'whole' });
  await done;
  assert.equal(starts.length, 1);
  const { extra } = starts[0];
  assert.equal(extra.songSeed, 42);
  assert.equal(extra.startAtMs, 61000);
  assert.equal(extra.keepAudio, true);
  assert.equal(extra.keepPerfLevel, true);
  assert.equal(extra.chapterState, null, 'nothing continues from the provisional scene');
  assert.equal(extra.cameraRunIntent, 'fresh');
  assert.equal(extra.fitDiagnostic, 'whole');
  assert.deepEqual(data.terrain, { id: 'whole' });
  assert.equal(data.identityPending, undefined);
  assert.equal(data.chapterState, undefined);
  assert.equal(data.worldId, 'custom-2', 'the world is tailored again on the whole song');
  assert.equal(context.custom.base, 'alpine');
  assert.deepEqual(library, [{ track: { key: 'song' }, seed: 42 }]);
});

test('a late terrain rebuilds the show on the whole analysis first, then commits', async () => {
  const { context, data, starts, timers, terrains } = setup();
  const done = context.adoptWholeSongIdentity(data);
  assert.equal(timers[0].ms, 2500);
  timers[0].cb();
  await flush();
  assert.equal(starts.length, 1, 'the show leaves the opening\'s notes behind');
  assert.equal(starts[0].extra.songSeed, 11, 'on its provisional look');
  assert.deepEqual(data.terrain, { id: 'provisional' });
  assert.equal(data.identityPending, true);
  terrains[0].resolve({ id: 'whole' });
  await done;
  assert.equal(starts.length, 2);
  assert.equal(starts[1].extra.songSeed, 42);
  assert.ok(starts.every(({ extra }) => extra.keepPerfLevel === true));
  assert.deepEqual(data.terrain, { id: 'whole' });
});

test('a terrain that never comes is given up on, so exports are not held forever', async () => {
  const { context, data, starts, timers, terrains } = setup();
  const done = context.adoptWholeSongIdentity(data);
  timers[0].cb();
  await flush();
  timers[1].cb();
  await done;
  assert.equal(data.identityPending, undefined);
  assert.equal(data.terrain, null, 'the bundled stand-in, as for a start that misses its wait');
  assert.equal(starts.at(-1).extra.songSeed, 42);
  const count = starts.length;
  terrains[0].resolve({ id: 'whole' });
  await flush();
  assert.deepEqual(data.terrain, { id: 'whole' }, 'kept for the next rebuild');
  assert.equal(starts.length, count, 'without another rebuild');
});

test('a newer hand-off or another song wins over a stale one', async () => {
  const { context, data, starts, terrains } = setup();
  const first = context.adoptWholeSongIdentity(data);
  const second = context.adoptWholeSongIdentity(data);
  terrains[0].resolve({ id: 'stale' });
  await first;
  assert.equal(starts.length, 0);
  context.lastTimelineData = { other: true };
  terrains[1].resolve({ id: 'whole' });
  await second;
  assert.equal(starts.length, 0);
  assert.deepEqual(data.terrain, { id: 'provisional' });
});

test('a seed the listener chose since the provisional start is kept', async () => {
  const { context, data, starts, terrains } = setup({ songSeed: 777 });
  const done = context.adoptWholeSongIdentity(data);
  terrains[0].resolve({ id: 'whole' });
  await done;
  assert.equal(starts[0].extra.songSeed, 777);
  assert.deepEqual(data.terrain, { id: 'whole' });
});

test('on the Complete screen the identity is committed for the replay and shown', async () => {
  const { context, data, starts, terrains } = setup({ running: false });
  const done = context.adoptWholeSongIdentity(data);
  terrains[0].resolve({ id: 'whole' });
  await done;
  assert.equal(starts.length, 0);
  assert.equal(context.lastSongSeed, 42);
  assert.equal(context.completeSeedEl.textContent, 'seed:42');
  assert.equal(data.identityPending, undefined);
});

test('a provisional scene still preparing its start is dropped for the identity', () => {
  const { context, data, offers, terrains } = setup();
  Object.assign(context, { playbackPreparing: true, sceneStartMs: 0, audioEngine: { nowMs: 0 } });
  context.lastStartExtra = { playBuffer: {}, songSeed: 11, startAtMs: 0, recordingSettings: {} };
  assert.equal(context.adoptWholeSongIdentity(data), null);
  assert.equal(context.stopped, true, 'the provisional preparation is abandoned');
  assert.equal(offers.length, 1);
  assert.deepEqual(Object.keys(offers[0].extra), ['playBuffer'], 'the restart takes the identity seed, from the top');
  assert.equal(terrains.length, 0);
  assert.equal(data.identityPending, undefined);
});

test('a scene already playing, or preparing a seek, is handed off in place', async () => {
  for (const state of [{ playbackPreparing: false }, { playbackPreparing: true, sceneStartMs: 30000 }]) {
    const { context, data, offers, terrains } = setup();
    Object.assign(context, state);
    context.adoptWholeSongIdentity(data);
    assert.equal(offers.length, 0);
    assert.equal(terrains.length, 1);
  }
});

test('an opening has nothing to hand off', () => {
  const { context, data, terrains } = setup();
  data.opening = { analyzedMs: 15000 };
  assert.equal(context.adoptWholeSongIdentity(data), null);
  assert.equal(terrains.length, 0);
});

test('seeking preserves the live playback quality level while rebuilding at the requested time', () => {
  const { context, data, starts } = setup();
  context.seekSong(32000);
  assert.equal(starts[0].d, data);
  assert.equal(starts[0].extra.startAtMs, 32000);
  assert.equal(starts[0].extra.keepPerfLevel, true);
});
