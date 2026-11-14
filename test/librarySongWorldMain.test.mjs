import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createSongWorldRecord, describeSongWorld } from '../src/library/SongWorld.js';
import { planSongScenes } from '../src/world/terrain/SongScenePlan.js';
import { dualSummitsSelection } from '../src/world/alpine/DualSummitsMusic.js';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = main.indexOf('function offerWorldsThenStart(');
const source = main.slice(start, main.indexOf('\n}\n', start) + 3);
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
    buildSongProfile: () => profile, resolveSongSeed: () => 88, dualSummitsSelection,
    musicLibrary: { async noteSongWorld(track, record) { calls.push({ track, record }); if (rejectStorage) throw Error('storage unavailable'); } },
    prepareSongTerrain: async (p, seed) => { const plan = planSongScenes(p, seed); plans.push(plan); return plan; },
    pendingWorldStart: null, lastFitDiagnostic: null, recordFitDiagnostic: () => null,
    readBulkExportFromUrl: () => null, DEFAULT_WORLD_ID: 'alpine', BIOME_WAIT_MS: 2500,
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
