// Shipped views for the tour forest window tests: Teton and Black
// Mountains placed as RangeScene places a two-camera view, their tour
// layer's index, the distinct fixture-song timelines their planner gives,
// and a refinement of one of them (TourForest.js, RangeScene._updateTourForest).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeTerrain } from '../../src/world/alpine/TerrainMesh.js';
import { decodeShotLibrary, cameraFootprint } from '../../src/world/terrain/ShotLibrary.js';
import { placeForest } from '../../src/world/alpine/ForestCover.js';
import { handleShotMessage } from '../../src/world/terrain/shot-worker.js';
import { restoreShotTimeline, shotTimelineData } from '../../src/world/terrain/ShotTimeline.js';
import { tourUniverse, tourForestIndex } from '../../src/world/alpine/TourForest.js';
import { hashSeed } from '../../src/utils/math.js';
import { anthemSong, dropSong, shortSong } from '../fixtures/shot-library-fixture.mjs';
import catalog from '../../src/world/terrain/sceneCatalogData.js';

const RUNTIME = fileURLToPath(new URL('../../src/assets/range/v2/', import.meta.url));
const json = (rel) => JSON.parse(fs.readFileSync(path.join(RUNTIME, rel), 'utf8'));
const gunzip = (dir, url) => { const b = zlib.gunzipSync(fs.readFileSync(path.join(RUNTIME, dir, path.basename(url)))); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };

export const SHIPPED_VIEWS = ['teton-jackson-lake', 'black-mountains-catawba'];
const loaded = new Map();

/** A shipped view with its shot footprint, placed with its own seed. */
export function shippedView(id) {
  if (loaded.has(id)) return loaded.get(id);
  const view = catalog.views.find((v) => v.id === id);
  const manifest = json(view.terrainManifestUrl);
  const data = decodeTerrain(manifest, gunzip('terrain', manifest.payload.url));
  const shots = json(view.shotsManifestUrl);
  const library = decodeShotLibrary(shots, gunzip('tour', shots.payload.url));
  const pack = json(view.materialManifestUrl);
  const rules = { ...pack.rules, ...(view.materialRules || {}) };
  const seed = hashSeed(view.terrainSourceId || view.id);
  const tview = { ...view, cameraPaths: cameraFootprint(library) };
  const placed = placeForest(data, tview, rules, { seed });
  const out = { id, view: tview, rules, seed, library, placed, index: null, timelines: null };
  loaded.set(id, out);
  return out;
}

/** The view's tour layer index, batches numbered as createForest's twins. */
export function shippedIndex(v) {
  v.index ||= tourForestIndex({ ...tourUniverse(v.placed, (kind, band, group) => (kind * 3 + band) * 6 + group), seed: v.seed });
  return v.index;
}

const SONGS = { anthem: anthemSong, drop: dropSong, short: shortSong };
const request = (library, song, seed, extra = {}) => ({ library, sections: song.sections, roles: song.roles, energy: song.energy,
  energyStepMs: song.energyStepMs || 100, durationMs: song.durationMs, visible: [{ startMs: 0, endMs: song.durationMs }], seed, ...extra });
const bytesOf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

/** The distinct timelines the planner gives the fixture songs with seeds
 *  0-5 on this view, named song-seed by their first plan. */
export function fixtureTimelines(v) {
  if (v.timelines) return v.timelines;
  const out = [];
  for (const [name, make] of Object.entries(SONGS)) {
    const song = make();
    for (let seed = 0; seed <= 5; seed++) {
      const { message } = handleShotMessage(request(v.library, song, seed));
      if (message.error) continue;
      const tl = restoreShotTimeline(message.timeline);
      if (tl.fallback) continue;
      if (out.some((o) => o.tl.durationMs === tl.durationMs && bytesOf(o.tl.eye).equals(bytesOf(tl.eye)))) continue;
      out.push({ name: `${name}-${seed}`, tl });
    }
  }
  v.timelines = out;
  return out;
}

/** The anthem's seed-0 plan and its refinement heard through `heardMs`
 *  (later sections moved and the energy reshaped, as a full analysis
 *  would; songwin/replan.mjs). */
export function refinedTimeline(v, heardMs) {
  const song = anthemSong();
  const first = restoreShotTimeline(handleShotMessage(request(v.library, song, 0)).message.timeline);
  const refined = { ...song, sections: song.sections.map((x, i) => (i >= 6 ? { ...x, startMs: x.startMs + 1500, endMs: Math.min(song.durationMs, x.endMs + 1500) } : x)) };
  refined.sections[5] = { ...refined.sections[5], endMs: refined.sections[6].startMs };
  refined.roles = song.roles.map((r, i) => ({ ...r, finalChorus: i === 7, role: i === 8 ? 'chorus' : r.role }));
  refined.energy = Float32Array.from(song.energy, (e, i) => (i * 100 > 70000 ? (Math.floor(i / 150) % 2 ? Math.min(1, e * 1.6) : e * .4) : e));
  const { message } = handleShotMessage(request(v.library, refined, 0, { previous: shotTimelineData(first), committedThroughMs: heardMs }));
  if (message.error) throw new Error(message.error);
  return { first, next: restoreShotTimeline(message.timeline) };
}
