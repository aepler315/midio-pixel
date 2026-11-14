import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PlaybackSequence } from '../src/library/PlaybackSequence.js';
import { createAudioSelection } from '../src/audio/AudioSelection.js';
import { dualSummitsSelection } from '../src/world/alpine/DualSummitsMusic.js';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function productionSource(name) {
  const declaration = main.indexOf(`function ${name}(`);
  assert.ok(declaration >= 0, `${name} exists`);
  const start = main.slice(0, declaration).endsWith('async ') ? declaration - 6 : declaration;
  const end = main.indexOf('\n}\n', start) + 3;
  return main.slice(start, end);
}
function production(name, bindings) {
  const context = vm.createContext({ videoExportSession: { busy: false, cancel() {} }, syncCameraStudio() {}, ...bindings });
  vm.runInContext(productionSource(name), context);
  return context;
}
const element = () => ({ classList: { add() {}, remove() {} }, textContent: '' });

test('a manual source selection cancels a pending automatic next song', () => {
  let cancelled = 0, cancelledExport = 0;
  const context = production('beginAudioSelection', {
    continuousPlayback: { cancel() { cancelled++; } },
    videoExportSession: { cancel() { cancelledExport++; } },
    audioSelections: { begin: source => ({ source }) }, selectionExportSettings: new WeakMap(),
    exportSetup: { snapshot: () => null }, loadGen: 0, running: false,
    loadAudioFiles: {}, cancelUrlLoad() {},
  });
  context.beginAudioSelection('local');
  assert.equal(cancelled, 1);
  assert.equal(cancelledExport, 1, 'the new song owns the page after cancelling an old export');
});

test('completion preserves results and schedules the next song after recording finalization', () => {
  const finalization = Promise.resolve(); let queued = null;
  const context = production('onSongComplete', {
    running: true, hudEl: element(), audioEngine: { pause() {} }, synth: { stopAll() {} },
    sim: { songSeed: 7, highlightReel: { frames: ['peak'] } }, lastSongSeed: null,
    completeSongNameEl: element(), completeSeedEl: element(), lastTimelineData: {}, lastSongName: 'Track.mp3',
    sessionSongName: () => 'Track.mp3', formatSeed: String, buildRunStats: () => ({}),
    renderResultsGrid() {}, completedReelFrames: [], renderFilmstrip() {}, completePanelEl: element(),
    songRecorder: { recording: true }, finishRecording: () => finalization,
    queueContinuousPlayback: ready => { queued = ready; },
  });
  context.onSongComplete();
  assert.strictEqual(queued, finalization);
  assert.equal(context.running, false);
  assert.equal(context.completeSongNameEl.textContent, 'Track');
});

test('an owned continuation keeps its world and skips the world picker', async () => {
  let played = null, offered = 0;
  const ticket = {};
  const context = production('offerWorldsThenStart', {
    clearCustomWorld() {}, PROFILE_VERSION: 1, buildSongProfile: () => assert.fail('identity already exists'),
    resolveSongSeed: () => 7, prepareSongTerrain: async () => null, dualSummitsSelection,
    recordFitDiagnostic: () => null, lastFitDiagnostic: null, pendingWorldStart: null,
    readBulkExportFromUrl: () => null, URL_PICKS_WORLD: false, experience: 'landscape', BIOME_WAIT_MS: 1,
    worldForExperience: () => 'range', worldExperience: () => 'trio',
    continuousPlayback: { isCurrent: candidate => candidate === ticket },
    playSelectedWorld: id => { played = id; }, renderWorldGrid: () => { offered++; },
    worldSelectEl: { ...element(), showModal() {} }, startChooserPreviews() {}, console, Promise, setTimeout,
  });
  context.offerWorldsThenStart({ songIdentity: { seed: 7, songProfile: { version: 1, watch: {} } } },
    { automaticTicket: ticket, continuationWorldId: 'trio' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(played, 'trio');
  assert.equal(offered, 0);
});

test('a folder change while a file opens cannot start a track from the old folder', async () => {
  let opened, starts = 0;
  const root = {}, library = { root, playable: true, openFile: () => new Promise(resolve => { opened = resolve; }) };
  const context = production('playLibraryTrack', {
    unlockAudio() {}, beginAudioSelection: () => ({}), audioSelections: { isCurrent: () => true, cancel() {} },
    musicLibrary: library, closeLibrary() {}, lastLibraryTrackId: 'old',
    handleFiles: async () => { starts++; return true; },
  });
  const pending = context.playLibraryTrack({ key: 'root/track', path: 'track.mp3' });
  library.root = {}; opened({ name: 'track.mp3' }); await pending;
  assert.equal(starts, 0);
  assert.equal(context.lastLibraryTrackId, 'old');
});

test('opening a completed highlight cancels its pending next song', () => {
  let cancelled = 0;
  const context = production('openFilmstripModal', {
    continuousPlayback: { cancel() { cancelled++; } },
    completedReelFrames: [{ label: 'Peak', dataUrl: 'data:', atMs: 4 }],
    filmstripModalEl: element(), filmstripModalTitleEl: {}, filmstripModalImgEl: {}, filmstripModalDownloadEl: {},
    filmstripModalSaveEl: null, openReelIndex: -1, filmstripCaption: () => 'Peak', syncReelSaveControls() {},
  });
  context.openFilmstripModal(0); assert.equal(cancelled, 1);
});

test('automatic failures try at most three distinct tracks and never open a permission prompt', async () => {
  const attempts = [], ticket = {}, root = {};
  const context = production('startNextLibraryTrack', {
    musicLibrary: { root, playable: true, handle: {}, tracks: ['a', 'b', 'c', 'd'].map(key => ({ key })) },
    continuousPlayback: { isCurrent: candidate => candidate === ticket }, ensureReadPermission: async () => true,
    playbackSequence: new PlaybackSequence({ random: () => 0 }), playbackPrefs: { shuffle: true }, lastLibraryTrackId: null,
    playLibraryTrack: async track => { attempts.push(track.key); return false; }, console,
  });
  const result = await context.startNextLibraryTrack(ticket, 'range');
  assert.equal(attempts.length, 3); assert.equal(new Set(attempts).size, 3); assert.match(result.message, /stopped/i);
  context.ensureReadPermission = async () => false;
  attempts.length = 0;
  assert.match((await context.startNextLibraryTrack(ticket, 'range')).message, /folder access/);
  assert.equal(attempts.length, 0);
});

test('loading cancellation and preparation failure return to Title without presenting mismatched completion results', () => {
  const titles = [], errors = [];
  const context = production('renderContinuousPlaybackState', {
    continuousPhase: 'loading', continuousStatusEl: {}, cancelContinuousBtnEl: {}, running: true,
    completePanelEl: { classList: { remove: () => assert.fail('old completion cannot be shown') } },
    backToTitle: options => titles.push(options), showErrorBanner: message => errors.push(message), syncReelSaveControls() {},
  });
  context.renderContinuousPlaybackState({ phase: 'idle', message: 'Next song cancelled.' });
  assert.equal(titles.length, 1); assert.equal(titles[0].cancelContinuous, false); assert.deepEqual(errors, []);
  context.continuousPhase = 'loading';
  context.renderContinuousPlaybackState({ phase: 'idle', message: 'Continuous play stopped: world failed.' });
  assert.equal(titles.length, 2); assert.deepEqual(errors, ['Continuous play stopped: world failed.']);
});

test('Title revokes a loading selection and its generation even when completion data has already been replaced', () => {
  const selections = createAudioSelection(), ticket = selections.begin('library'); let stopped = 0;
  const context = production('backToTitle', {
    continuousPlayback: { cancel() {} }, audioSelections: selections, loadAudioFiles: {}, loadShow: null,
    auditionPanelEl: element(), lyricsRowEl: element(), cancelUrlLoad() {}, loadGen: 4,
    cameraRun: {}, activeCameraSchedule: {}, stopTimeline: () => { stopped++; },
    completePanelEl: element(), hudEl: element(), closeWorldChooser() {}, stopWorldPreview() {}, pendingWorldStart: {},
    progressEl: element(), loaderEl: element(), startTitleBackdrop() {}, dropzoneEl: { focus() {} },
    lastTimelineData: { title: 'unplayed replacement' },
  });
  context.backToTitle({ cancelContinuous: false });
  assert.equal(ticket.signal.aborted, true); assert.equal(context.loadGen, 5); assert.equal(stopped, 1);
  assert.equal(context.pendingWorldStart, null);
});

test('a failed library decode cannot move the current-track identity', async () => {
  const context = production('playLibraryTrack', {
    unlockAudio() {}, beginAudioSelection: () => ({}), audioSelections: { isCurrent: () => true, cancel() {} },
    musicLibrary: { root: {}, playable: true, openFile: async () => ({ name: 'bad.mp3' }) },
    closeLibrary() {}, lastLibraryTrackId: 'previous', handleFiles: async () => false,
  });
  assert.equal(await context.playLibraryTrack({ key: 'bad' }), false);
  assert.equal(context.lastLibraryTrackId, 'previous');
});

test('a synchronous timeline failure settles an automatic world selection after its pending owner is consumed', () => {
  const ticket = {}, outcomes = []; let starts = 0;
  const context = production('startConfirmedWorld', {
    continuousPlayback: { isCurrent: candidate => candidate === ticket },
    resolveWorldId: id => id,
    lastWorldId: 'range',
    startTimeline() { starts++; throw new Error('Renderer construction failed'); },
    pendingWorldStart: { data: {}, features: {}, profile: {}, extra: {
      automaticTicket: ticket, onAutomaticStart: outcome => outcomes.push(outcome),
    } },
    listWorlds: () => [{ id: 'range' }], ensureLandscapePresentation() {},
    buildWorldVariant: () => ({ world: { id: 'range', instanceId: 'song' } }),
    getCustomWorld: () => null, setCustomWorld() {}, clearCustomWorld() {}, console: { warn() {} },
  });
  vm.runInContext(productionSource('confirmWorld'), context);
  vm.runInContext(productionSource('playSelectedWorld'), context);
  context.playSelectedWorld('range');
  assert.equal(context.pendingWorldStart, null);
  assert.equal(starts, 1);
  assert.equal(outcomes.length, 1, 'the awaiting library handoff must be released');
  assert.equal(outcomes[0].status, 'failed');
});
