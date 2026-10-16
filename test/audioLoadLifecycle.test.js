import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as cache from '../src/audio/AnalysisCache.js';
import { createAudioSelection } from '../src/audio/AudioSelection.js';
import { normalizeSourceMetadata } from '../src/audio/SourceMetadata.js';
import * as sessionIdentity from '../src/audio/AudioSessionIdentity.js';
import { fingerprintBuffer } from '../src/audio/SongFingerprint.js';
import { GrooveFingerprint } from '../src/sim/GrooveFingerprint.js';
import { ensureRidgeMusicSession, upgradeRidgeMusicSession } from '../src/world/RidgeMotionHistory.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import * as opening from '../src/audio/OpeningAnalysis.js';
import {
  AUDIO_LOAD_LIMITS, accumulateDecodedAudioBytes, accumulateDecodedByteLength, decodedAudioByteLength,
  accumulateEncodedAudioBytes, audioAbortError, validateAudioFiles, validateDecodedAudioBuffer, validateDecodedByteLength,
} from '../src/audio/loadLimits.js';

// Execute the real upload orchestrator with browser/audio boundaries replaced.
// Analysis/cache identity remain real; no browser is needed to test ownership.
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const loadSource = main.slice(main.indexOf('async function resolveLyricsForAudio('), main.indexOf('\nfunction handleFile('));
const element = () => ({ classList: { add() {}, remove() {} }, textContent: '' });
function recording(hz = 440) {
  const samples = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i * hz * Math.PI / 4000) * (0.4 + 0.1 * Math.sin(i / 100)));
  return { sampleRate: 8000, length: samples.length, duration: 2, numberOfChannels: 1, getChannelData: () => samples };
}
function harness() {
  const mix = recording();
  const encoded = new ArrayBuffer(1024);
  const keys = [], errors = [];
  const context = vm.createContext({
    ...cache, fingerprintBuffer, GrooveFingerprint, ...opening, ensureRidgeMusicSession, upgradeRidgeMusicSession,
    running: false, sim: null, lastTimelineData: null, bulkExportArmed: false,
    fingerprintBufferOffThread: async (buffer) => fingerprintBuffer(buffer),
    readBulkExportFromUrl: () => null, rangeListening: false, fullAnalysisPending: null, adoptFullAnalysisLive() {},
    AUDIO_LOAD_LIMITS, accumulateDecodedAudioBytes, accumulateDecodedByteLength, decodedAudioByteLength,
    accumulateEncodedAudioBytes, audioAbortError, validateAudioFiles, validateDecodedAudioBuffer, validateDecodedByteLength,
    AbortController, audioSelections: createAudioSelection(), normalizeSourceMetadata, ...sessionIdentity,
    cancelUrlLoad() {}, buildLyricSections: () => null,
    loadGen: 0, groove: new GrooveFingerprint(), lyricsDisabled: true,
    console, bootAudio: async () => {}, showProgress() {},
    showErrorBanner: (error) => errors.push(error),
    audioEngine: { playing: true, decodeFile: async () => mix },
    stopTimeline() { context.audioEngine.playing = false; context.stopped = true; },
    stopTitleBackdrop() {}, stopWorldPreview() {}, closeWorldChooser() {}, pendingWorldStart: {},
    worldSelectEl: element(), progressEl: element(), loaderEl: element(), hudEl: element(),
    auditionHeadingEl: element(), auditionPanelEl: element(), lyricsRowEl: element(),
    loadShow: { start() {}, stop() {}, setStage() {} },
    sumToMixBuffer: () => mix, isVocalStemName: () => false,
    getBundle: async (key) => { keys.push(key); return {}; },
    unpackBundle: () => ({ fromBundle: true }),
    audioToTimeline: async () => ({ fromBundle: true }),
    generateCustomBiomeFromMidi: () => ({}), rememberCustomBiome() {}, paramBus: {},
    muteTimelineSynth: false, lastSongName: '', lastAudioBuffer: null,
    fontRecommender: null, DEV_MODE: false, offerWorldsThenStart() {},
    packBundle: () => ({}), putBundle: async () => {},
    // A load started from the music library reports the decoded duration
    // back to it -- the one fact a folder scan cannot know.
    musicLibrary: { played: [], async notePlayed(track, seconds) { this.played.push([track, seconds]); } },
  });
  vm.runInContext(loadSource, context);
  const load = async (names = ['mix.wav'], options = {}) => {
    await context.loadAudioFiles(names.map((name) => ({ name, arrayBuffer: async () => encoded })), options);
    assert.deepEqual(errors, []);
    return keys.at(-1);
  };
  return { context, load, keys };
}

test('accepting an upload stops the old performance before audio initialization awaits', async () => {
  const { context } = harness();
  context.bootAudio = () => new Promise(() => {});
  context.loadAudioFiles([{ name: 'new.wav' }]);
  assert.equal(context.audioEngine.playing, false);
  assert.equal(context.pendingWorldStart, null);
});

test('a library play reports its decoded duration back, exactly once', async () => {
  const { context, load } = harness();
  const track = { key: 'root\u0000a.wav', path: 'a.wav' };
  const selection = context.beginAudioSelection('library');
  await load(['a.wav'], { selection, localTrack: track });
  assert.deepEqual(context.musicLibrary.played, [[track, 2]]);
  // The claim is consumed, so a later drop that did not come from the
  // library cannot be credited to the last track played from it.
  assert.equal(context.audioSelections.isCurrent(selection), true);
  await load();
  assert.equal(context.musicLibrary.played.length, 1);
});

test('a drop that did not come from the library tells it nothing', async () => {
  const { context, load } = harness();
  await load();
  assert.deepEqual(context.musicLibrary.played, []);
});

test('cache identity changes when the same stem audio is renamed for a different character', async () => {
  const { load } = harness();
  const first = await load(['vocals.wav', 'bass.wav']);
  assert.notEqual(await load(['guitar.wav', 'bass.wav']), first);
});

test('cache identity changes with learned rhythm settings and is stable otherwise', async () => {
  const { context, load } = harness();
  const first = await load();
  assert.equal(await load(), first);
  context.groove.low.count = 16;
  context.groove.low.template[0] = 1;
  assert.notEqual(await load(), first);
});


test('stem content participates in cache identity even when the mixed fingerprint is unchanged', () => {
  const mix = fingerprintBuffer(recording());
  const key = (buffer) => cache.analysisCacheKey(mix, { stems: [{ name: 'bass.wav', buffer }] });
  assert.notEqual(key(recording(440)), key(recording(880)));
});

test('low-information audio bypasses cache lookup and still reaches analysis', async () => {
  const { context, keys } = harness();
  let analyzed = false;
  context.audioToTimeline = async () => { analyzed = true; return { fromBundle: true }; };
  const silence = recording();
  silence.getChannelData = () => new Float32Array(silence.length);
  context.audioEngine.decodeFile = async () => silence;
  await context.loadAudioFiles([{ name: 'silence.wav', arrayBuffer: async () => new ArrayBuffer(1024) }]);
  assert.equal(analyzed, true);
  assert.deepEqual(keys, []);
});

test('a superseded load awaiting audio initialization never starts decoding', async () => {
  const { context } = harness();
  let release;
  context.bootAudio = () => new Promise((resolve) => { release = resolve; });
  let decoded = false;
  context.audioEngine.decodeFile = async () => { decoded = true; };
  const pending = context.loadAudioFiles([{ name: 'old.wav', arrayBuffer: async () => new ArrayBuffer(1024) }]);
  context.loadGen++;
  release();
  await pending;
  assert.equal(decoded, false);
});

test('a superseded audio analysis receives an abort signal', async () => {
  const { context } = harness();
  let analysisStarted;
  const analysisSignal = new Promise((resolve) => { analysisStarted = resolve; });
  context.unpackBundle = () => null;
  context.audioToTimeline = async (_buffer, { signal }) => {
    analysisStarted(signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { fromBundle: true };
  };
  const first = context.loadAudioFiles([{ name: 'old.wav', arrayBuffer: async () => new ArrayBuffer(1024) }]);
  const signal = await analysisSignal;
  const second = context.loadAudioFiles([{ name: 'new.wav', arrayBuffer: async () => new ArrayBuffer(1024) }]);
  await Promise.all([first, second]);
  assert.equal(signal.aborted, true);
});

test('phase-sensitive analysis never shares a cache entry with an in-phase recording', () => {
  const mono = recording();
  const left = mono.getChannelData(0);
  const right = Float32Array.from(left, (x) => -x);
  const stereo = (inverted) => ({ ...mono, numberOfChannels: 2,
    getChannelData: (c) => c && inverted ? right : left });
  const a = fingerprintBuffer(stereo(false)), b = fingerprintBuffer(stereo(true));
  assert.deepEqual(a.frames, b.frames, 'acoustic matching remains phase-safe');
  assert.notEqual(cache.analysisCacheKey(a), cache.analysisCacheKey(b),
    'cached stereo width depends on phase');
});

test('long audio exposes a whole-recording overview while full analysis is pending and after adoption', async () => {
  const { context, load } = harness();
  const buffer = recording();
  buffer.duration = 744.573;
  context.audioEngine.decodeFile = async () => buffer;
  context.sliceAudioBuffer = () => ({ ...buffer, duration: 15 });
  context.setTimeout = (fn) => fn();
  context.getBundle = async () => null;
  context.packBundle = () => ({});
  context.putBundle = async () => {};
  let finish;
  const full = new Promise((resolve) => { finish = resolve; });
  context.audioToTimeline = async (b) => b.duration === 15
    ? { durationMs: 15000, timeline: [{ tMs: 1000 }], barGrid: [] } : full;
  let offered;
  context.offerWorldsThenStart = (data) => { offered = data; };
  await load();
  assert.equal(offered.opening.analyzedMs, 15000);
  assert.ok(offered.audioOverview[200] > 0);
  const overview = offered.audioOverview;
  finish({ durationMs: 744573, timeline: [{ tMs: 600000 }], barGrid: [] });
  await context.fullAnalysisPending;
  assert.equal(offered.opening, undefined);
  assert.equal(offered.audioOverview, overview);
  assert.equal(offered.timeline[0].tMs, 600000);
});

test('landscape listening starts provisionally and adopts the complete analysis', async () => {
  const { context, load } = harness();
  const buffer = recording(); buffer.duration = 120;
  context.audioEngine.decodeFile = async () => buffer;
  context.rangeListening = true;
  context.sliceAudioBuffer = () => ({ ...buffer, duration: 15 });
  context.setTimeout = (fn) => fn();
  context.getBundle = async () => null;
  context.packBundle = () => ({}); context.putBundle = async () => {};
  let finish, offered = null;
  const full = new Promise(resolve => { finish = resolve; });
  context.audioToTimeline = async b => b.duration === 15
    ? { durationMs: 15000, timeline: [], barGrid: [] } : full;
  context.offerWorldsThenStart = data => { offered = data; };
  const loading = load();
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(offered?.opening, 'landscape starts on opening evidence without a reveal wait');
  await loading;
  const pending = context.fullAnalysisPending;
  assert.ok(pending);
  finish({ durationMs: 120000, timeline: [], barGrid: [] });
  await pending;
  assert.equal(offered.opening, undefined);
  assert.equal(offered.durationMs, 120000);
});


test('actual background analysis captures the provisional history before adoption and retains heard-time handoff', async () => {
  const { context, load } = harness();
  const buffer = recording(); buffer.duration = 120;
  context.audioEngine.decodeFile = async () => buffer;
  context.sliceAudioBuffer = () => ({ ...buffer, duration: 15 });
  context.setTimeout = fn => fn(); context.getBundle = async () => null;
  context.packBundle = () => ({}); context.putBundle = async () => {};
  const openingCurves = new EnergyCurves(15000); openingCurves.bands.forEach(b => b.fill(.2));
  const fullCurves = new EnergyCurves(120000); fullCurves.bands.forEach(b => b.fill(.9));
  let finish, offered, prior;
  const full = new Promise(resolve => { finish = resolve; });
  context.audioToTimeline = async b => b.duration === 15
    ? { durationMs: 15000, timeline: [], barGrid: [], energyCurves: openingCurves } : full;
  context.offerWorldsThenStart = data => {
    offered = data; prior = ensureRidgeMusicSession(data, 'load-1:opening');
    context.running = true; context.sim = { heardTimeMs: 5000 };
    context.lastTimelineData = data;
  };
  await load();
  const pending = context.fullAnalysisPending;
  finish({ durationMs: 120000, timeline: [], barGrid: [], energyCurves: fullCurves });
  await pending;
  assert.equal(offered.opening, undefined, 'full adoption actually completed');
  const retained = offered.ridgeMusicSession;
  assert.deepEqual(retained.stateKey, { primaryGeneration: 'load-1:final', previousGeneration: 'load-1:opening', handoffStartMs: 5000, handoffDurationMs: 500 });
  assert.equal(retained.previous, prior.primary);
  assert.equal(retained.sample(5000).bands[0], prior.sample(5000).bands[0]);
  assert.ok(Math.abs(retained.sample(5250).bands[0] - .55) < .001);
  fullCurves.bands.forEach(b => b.fill(0)); openingCurves.bands.forEach(b => b.fill(0));
  assert.ok(Math.abs(retained.sample(5250).bands[0] - .55) < .001, 'both histories are immutable after live data replacement');
});

test('Plex identity is applied with lyrics disabled and does not credit a stale local-library track', async () => {
  const { context, load } = harness();
  const selected = { provider: 'plex', id: 'plex:server:30', revision: 'rev1', title: 'Plex title', artist: 'Plex artist', album: 'Plex album', durationMs: 99000, artworkUrl: null };
  let offered;
  context.offerWorldsThenStart = data => { offered = data; };
  // Simulate a cache bundle made from the same PCM under a previous source.
  context.unpackBundle = () => ({ fromBundle: true, sourceTrack: { provider: 'plex', id: 'plex:server:99' }, lyricIdentity: { title: 'Older title' }, songIdentity: { seed: 315, songProfile: { genre: 'original' } } });
  const selection = context.beginAudioSelection('plex');
  await load(['plex-30.wav'], { selection, sourceMetadata: selected, localTrack: { key: 'stale-local' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(offered.sourceTrack.id, 'plex:server:30');
  assert.equal(offered.lyricIdentity.title, 'Plex title');
  assert.equal(offered.lyricIdentity.durationSec, 2);
  assert.equal(offered.songIdentity.seed, 315);
  assert.deepEqual(context.musicLibrary.played, []);
});

test('fresh source metadata wins full-analysis adoption from a previous source cache', async () => {
  const { context, load } = harness();
  const buffer = recording(); buffer.duration = 120;
  context.audioEngine.decodeFile = async () => buffer;
  context.rangeListening = true;
  context.sliceAudioBuffer = () => ({ ...buffer, duration: 15 });
  context.setTimeout = fn => fn(); context.getBundle = async () => null;
  let finish, offered;
  const full = new Promise(resolve => { finish = resolve; });
  context.audioToTimeline = async b => b.duration === 15 ? { durationMs: 15000, timeline: [], barGrid: [] } : full;
  context.offerWorldsThenStart = data => { offered = data; };
  await load(['plex-30.wav'], { sourceMetadata: { provider: 'plex', id: 'plex:server:30', revision: 'replaced-file', title: 'Current title' } });
  finish({ durationMs: 120000, timeline: [], barGrid: [], sourceTrack: { id: 'old' }, lyricIdentity: { title: 'Old cache title' } });
  await context.fullAnalysisPending;
  assert.equal(offered.sourceTrack.id, 'plex:server:30');
  assert.equal(offered.lyricIdentity.title, 'Current title');
  assert.equal(offered.lyricIdentity.durationSec, 120);
});

test('a decode failure does not report a prepared recording', async () => {
  const { context } = harness();
  context.audioEngine.decodeFile = async () => { throw new Error('Unsupported codec'); };
  assert.equal(await context.loadAudioFiles([{ name: 'bad.flac', arrayBuffer: async () => new ArrayBuffer(10) }]), false);
});

test('a failed pending remote choice leaves the current opening analysis able to finish', async () => {
  const { context, load } = harness();
  const buffer = recording(); buffer.duration = 120;
  context.audioEngine.decodeFile = async () => buffer;
  context.rangeListening = true;
  context.sliceAudioBuffer = () => ({ ...buffer, duration: 15 });
  context.setTimeout = fn => fn(); context.getBundle = async () => null;
  let finish, offered;
  const full = new Promise(resolve => { finish = resolve; });
  context.audioToTimeline = async b => b.duration === 15 ? { durationMs: 15000, timeline: [], barGrid: [] } : full;
  context.offerWorldsThenStart = data => { offered = data; context.running = true; context.lastTimelineData = data; };
  await load();
  const pending = context.fullAnalysisPending;
  const remote = context.beginAudioSelection('plex');
  context.audioSelections.cancel(remote);
  finish({ durationMs: 120000, timeline: [], barGrid: [] });
  await pending;
  assert.equal(offered.opening, undefined);
  assert.equal(context.fullAnalysisPending, null);
});

test('local identity publishes before the optional provider settles', async () => {
  const { context, load } = harness();
  let resolveLyrics, offered;
  context.lyricsDisabled = false;
  context.fetchLyricsCached = () => new Promise(resolve => { resolveLyrics = resolve; });
  context.offerWorldsThenStart = data => { offered = data; };
  await load(['raw.wav'], { sourceMetadata: { provider: 'plex', id: 'plex:audit:1', revision: '1', title: 'Authoritative title', artist: 'Artist' } });
  assert.equal(offered.lyricIdentity.title, 'Authoritative title');
  assert.equal(context.lastSongName, 'Authoritative title');
  assert.equal(offered.syncedLyrics, null);
  resolveLyrics(null);
  await new Promise(setImmediate);
  assert.equal(offered.lyricIdentity.title, 'Authoritative title');
});

test('a still-owning performance admits late lyrics after a remote choice supersedes its ticket', async () => {
  const { context, load } = harness();
  let resolveLyrics, offered;
  const admissions = [];
  context.lyricsDisabled = false;
  context.fetchLyricsCached = () => new Promise(resolve => { resolveLyrics = resolve; });
  context.offerWorldsThenStart = data => { offered = data; };
  await load();
  context.running = true;
  context.lastTimelineData = offered;
  context.sim = { heardTimeMs: 5500, biomes: { adoptLyrics: admission => admissions.push(admission) } };
  context.beginAudioSelection('url');
  resolveLyrics({ synced: [{ tMs: 1000, text: 'heart' }] });
  await new Promise(setImmediate);
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].heardTimeMs, 5500);
  assert.equal(offered.lyricSession.admissions[0], admissions[0]);
  assert.equal(offered.syncedLyrics.length, 1);
});

test('actual handoff retires pending lyrics and cannot mutate the replacement session', async () => {
  const { context, load } = harness();
  let resolveLyrics, offered;
  context.lyricsDisabled = false;
  context.fetchLyricsCached = () => new Promise(resolve => { resolveLyrics = resolve; });
  context.offerWorldsThenStart = data => { offered = data; };
  await load(['old.wav']);
  const old = offered;
  context.running = true; context.lastTimelineData = old;
  context.sim = { heardTimeMs: 5500, biomes: { adoptLyrics() { assert.fail('retired lyrics adopted'); } } };
  context.lyricsDisabled = true;
  await load(['replacement.wav']);
  context.lastTimelineData = offered;
  resolveLyrics({ synced: [{ tMs: 1000, text: 'heart' }] });
  await new Promise(setImmediate);
  assert.equal(offered.lyricIdentity.title, 'replacement');
  assert.equal(offered.syncedLyrics, null);
  assert.equal(old.lyricSession.admissions.length, 0);
});
