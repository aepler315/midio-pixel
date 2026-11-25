import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createSongWorldRecord, describeSongWorld } from '../src/library/SongWorld.js';
import { planSongScenes } from '../src/world/terrain/SongScenePlan.js';
import { dualSummitsSelection } from '../src/world/alpine/DualSummitsMusic.js';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = main.indexOf('function offerWorldsThenStart(');
const fn = (name) => { const at = main.indexOf(`function ${name}(`); return main.slice(at, main.indexOf('\n}\n', at) + 3); };
const source = [main.slice(start, main.indexOf('\n}\n', start) + 3), fn('noteLibrarySongWorld'), fn('withSignatureSource')].join('\n');
const profile = { version: 2, watch: { drive: .7, onset: .55, texture: .6, arc: .7, contrast: .6 } };

function element(hidden) {
  const el = { hidden, classList: { add(c) { if (c === 'hidden') el.hidden = true; }, remove(c) { if (c === 'hidden') el.hidden = false; } } };
  return el;
}

function setup({ rejectStorage = false } = {}) {
  const calls = [], warnings = [], plans = [];
  const ui = { progress: [], loader: element(true), hud: element(false), nav: element(false) };
  const context = vm.createContext({ clearCustomWorld() {}, PROFILE_VERSION: 2, createSongWorldRecord,
    showProgress: (text) => ui.progress.push(text), loaderEl: ui.loader, hudEl: ui.hud, rangeNavigationEl: ui.nav,
    buildSongIdentity: (d) => (d.songIdentity?.songProfile ? { ...d.songIdentity } : { seed: 88, songProfile: profile }),
    provisionalIdentity: () => ({ seed: 99, songProfile: profile, provisional: true }), dualSummitsSelection,
    musicLibrary: { async noteSongWorld(track, record) { calls.push({ track, record }); if (rejectStorage) throw Error('storage unavailable'); } },
    lyricsDisabled: false, terrainLyricSections: () => null,
    prepareSongTerrain: async (p, seed) => { const plan = planSongScenes(p, seed); plans.push(plan); return plan; },
    pendingWorldStart: null, lastFitDiagnostic: null, recordFitDiagnostic: () => null,
    readBulkExportFromUrl: () => null, DEFAULT_WORLD_ID: 'alpine', BIOME_WAIT_MS: 2500, IDENTITY_START_HOLD_MS: 5000,
    IDENTITY_SONG_RANGE_WAIT_MS: 20000, IDENTITY_TERRAIN_GIVE_UP_MS: 30000,
    setTimeout: () => 0, continuousPlayback: { isCurrent: () => true }, playSelectedWorld() {},
    console: { warn: (...values) => warnings.push(values), error: (...values) => { throw Error(values.join(' ')); } },
  });
  vm.runInContext(source, context);
  return { context, calls, warnings, plans, ui };
}

test('the actual world start shows the preparing state through the terrain and lyrics waits, except for exports and continuous playback', async () => {
  for (const [extra, covered] of [[{}, true], [{ exportMode: true }, false], [{ automaticTicket: {} }, false]]) {
    const { context, ui } = setup();
    context.offerWorldsThenStart({ durationMs: 120000, timeline: [] }, extra);
    const shown = ui.progress.at(-1) === 'Preparing landscape…' && !ui.loader.hidden && ui.hud.hidden && ui.nav.hidden;
    assert.equal(shown, covered, `cover for ${JSON.stringify(extra)}`);
    await context.pendingWorldStart.terrainReady;
  }
});

test('the actual world start persists the identity profile used by playback, rather than later whole-song features', async () => {
  const { context, calls, plans } = setup(), track = { key: 'song' };
  const data = { songIdentity: { seed: 417, songProfile: profile }, songProfile: { ...profile, watch: { ...profile.watch, drive: .1 } } };
  context.offerWorldsThenStart(data, { localTrack: track });
  await context.pendingWorldStart.terrainReady;
  assert.equal(calls.length, 1); assert.equal(calls[0].track, track);
  assert.deepEqual(calls[0].record, createSongWorldRecord(profile, 417));
  assert.equal(describeSongWorld(calls[0].record).viewId, plans[0].sceneByBiome.get(plans[0].home).view.id);
});

test('a cached timeline waits for initial lyric admission before casting its summits', async () => {
  const { context } = setup();
  context.LYRICS_START_WAIT_MS = 2000;
  context.terrainLyricSections = data => data.lyricSections;
  let resolveLyrics, planned;
  const lyricsReady = new Promise(resolve => { resolveLyrics = resolve; });
  context.prepareSongTerrain = async (_p, _seed, _recent, options) => { planned = options; return {}; };
  const data = { songIdentity: { seed: 42, songProfile: profile, songprint: { version: 1,
    timeline: {}, skyline: Array.from({ length: 16 }, (_, i) => i / 15), passages: [] } } };
  context.offerWorldsThenStart(data, { lyricsReady });
  assert.equal(planned, undefined);
  data.lyricSections = [{ startMs: 15000, endMs: 25000, kind: 'chorus', confidence: .8, familyId: 1 }];
  resolveLyrics();
  await context.pendingWorldStart.terrainReady;
  assert.deepEqual(planned.lyricSections, data.lyricSections);
});

test('a restored recording sends the full print to its landscape and only its skyline to the library', async () => {
  const { context, calls } = setup();
  const songprint = { version: 1, skyline: Array.from({ length: 16 }, (_, i) => i / 15),
    passages: [{ timeMs: 6000, landmark01: .3, strength: .5 }] };
  let planned;
  context.prepareSongTerrain = async (_p, _seed, _recent, options) => { planned = options; return {}; };
  const data = { songIdentity: { seed: 42, songProfile: profile, songprint } };
  context.offerWorldsThenStart(data, { localTrack: { key: 'test' } });
  await context.pendingWorldStart.terrainReady;
  assert.deepEqual(planned.songprint, songprint);
  assert.equal(planned.songRangeWaitMs, context.IDENTITY_SONG_RANGE_WAIT_MS);
  assert.deepEqual(data.songIdentity.songprint, songprint);
  assert.deepEqual(calls[0].record.songprint, { version: songprint.version, skyline: songprint.skyline });
});

test('weather-only analysis keeps the audio fingerprint off the terrain and library paths', async () => {
  const { context, calls } = setup();
  const songprint = { version: 1, skyline: Array(16).fill(.5), passages: [] };
  let planned;
  context.prepareSongTerrain = async (_profile, _seed, _recent, options) => { planned = options; return {}; };
  const data = { songIdentity: { seed: 42, songProfile: profile, songprint },
    songprintLandscapeEnabled: false, songprintAtmosphere: true };
  context.offerWorldsThenStart(data, { localTrack: { key: 'test' } });
  await context.pendingWorldStart.terrainReady;
  assert.equal(planned.songprint, null);
  assert.equal(data.songIdentity.songprint, songprint);
  assert.equal(calls[0].record.songprint, undefined);
});

test('the actual world start records a newly built identity and storage failure cannot delay the pending world', async () => {
  const { context, calls, warnings } = setup({ rejectStorage: true });
  const data = { durationMs: 120000, timeline: [] };
  context.offerWorldsThenStart(data, { localTrack: { key: 'song' } });
  await context.pendingWorldStart.terrainReady;
  await Promise.resolve();
  assert.equal(calls[0].record.seed, 88);
  assert.equal(data.songIdentity.seed, 88);
  assert.equal(context.pendingWorldStart.data, data);
  assert.equal(warnings.length, 1);
});

test('an opening plays a provisional look that is never stored', async () => {
  const { context, calls } = setup();
  const data = { durationMs: 240000, timeline: [], opening: { analyzedMs: 15000 } };
  context.offerWorldsThenStart(data, { localTrack: { key: 'song' } });
  await context.pendingWorldStart.terrainReady;
  assert.equal(data.songIdentity, undefined, 'no identity is frozen from the opening');
  assert.equal(calls.length, 0, 'and none reaches the library');
  assert.equal(context.pendingWorldStart.provisional, true);
  assert.equal(context.pendingWorldStart.seed, 99);
});

test('only the latest terrain preparation lands on the song', async () => {
  const { context } = setup();
  const resolvers = [];
  context.prepareSongTerrain = () => new Promise(resolve => resolvers.push(resolve));
  const data = { durationMs: 240000, timeline: [], opening: { analyzedMs: 15000 } };
  context.offerWorldsThenStart(data);
  const first = context.pendingWorldStart.terrainReady;
  delete data.opening;
  context.offerWorldsThenStart(data);
  const second = context.pendingWorldStart.terrainReady;
  resolvers[1]({ id: 'whole' });
  await second;
  resolvers[0]({ id: 'provisional' });
  await first;
  assert.deepEqual(data.terrain, { id: 'whole' }, 'a late provisional terrain cannot clobber the identity\'s');
});

test('a dropped song does not overwrite an unrelated library row', () => {
  const { context, calls } = setup();
  context.offerWorldsThenStart({ songIdentity: { seed: 417, songProfile: profile } });
  assert.equal(calls.length, 0);
});

test('the actual recent-library chips show the same world and retain their song activation', () => {
  const makeElement = () => ({ children: [], classList: { toggle() {} }, textContent: '',
    append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
    querySelector: () => null, addEventListener(_type, callback) { this.activate = callback; } });
  const known = { key: 'known', title: 'Known song', artist: 'Artist', path: 'known.mp3', songWorld: createSongWorldRecord(profile, 417) };
  const unknown = { key: 'new', title: 'New song', artist: 'Artist', path: 'new.mp3' };
  const recent = makeElement(); let played;
  const context = vm.createContext({ libraryHomeEl: makeElement(), libraryRecentEl: recent, libraryHomeNoteEl: null,
    libraryOpenBtnEl: null, libraryFolderBtnEl: null, libraryFolderFallbackEl: null, libraryFolderHintEl: null, dropzoneEl: null,
    musicLibrary: { tracks: [known, unknown], persistable: true, playable: true }, fallbackUsesFiles: false,
    recentlyPlayed: () => [], displayTitle: track => track.title, displayArtist: track => track.artist,
    describeSongWorld, document: { createElement: makeElement }, playLibraryTrack: track => { played = track; } });
  const begin = main.indexOf('function renderLibraryHome(');
  vm.runInContext(main.slice(begin, main.indexOf('\n}\n', begin) + 3), context);
  context.renderLibraryHome();
  assert.equal(recent.children[0].children[2].textContent, describeSongWorld(known.songWorld).label);
  assert.equal(recent.children[1].children[2].textContent, 'World: play to discover');
  recent.children[0].activate(); assert.equal(played, known);
});
