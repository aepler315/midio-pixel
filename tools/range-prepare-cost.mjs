// Main-thread cost of taking one view from bytes to a prepared scene, without
// a GL context (the harness of test/landRiseStageScene.test.mjs): package
// load or stage assembly, then RangeScene.prepare (geometry, water subsets,
// forest). Playback waits for this before the first sound
// (src/render/RenderReadyPlayback.js).
//
//   node tools/range-prepare-cost.mjs <catalog view id | stage | pilot-a|b|c> [--repeat 3]
//   node --cpu-prof --cpu-prof-dir=.smoke/<run> tools/range-prepare-cost.mjs stage
//   node tools/cpuprofile-top.mjs .smoke/<run>/<file>.cpuprofile
//
// "stage" composes the first synthetic song's plan through runtime assembly;
// "pilot-a" runs that pilot layout through the same path. With --repeat only
// the first run's load is cold: later runs read the stage from the assembly
// cache. Times are Node on this host. Shares between steps carry to other
// machines far better than milliseconds do. GPU uploads and shader
// compilation are outside this measurement.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { RULE_DEFAULTS } from '../src/world/alpine/MaterialPackage.js';
import { songRangeView, loadSongRangeStage } from '../src/world/alpine/StageAssembly.js';
import { loadTerrainPackage, sha256Hex } from '../src/world/alpine/RangeAssets.js';
import { planSongRange, pilotPlan } from '../src/world/terrain/SongRangePlan.js';
import MASSIF_CATALOG from '../src/world/terrain/massifCatalogData.js';
import SCENE_CATALOG from '../src/world/terrain/sceneCatalogData.js';
import { syntheticSongs } from './song-range-uniqueness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = pathToFileURL(path.join(root, 'src/assets/range/v2/'));
const diskFetch = async (url) => {
  const file = String(url).startsWith('file:') ? fileURLToPath(url) : fileURLToPath(new URL(new URL(url).pathname.slice(1), ASSETS));
  return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response(null, { status: 404 });
};

/** A RangeScene without a GL context: prepare() runs its CPU work only. */
function sceneFor(view) {
  const material = JSON.parse(fs.readFileSync(new URL(view.materialManifestUrl, ASSETS), 'utf8'));
  const scene = Object.assign(Object.create(RangeScene.prototype), { budget: 'desktop', THREE, residency: new GraphicsResidency({ budgetBytes: 4e9 }),
    tourForest: true, prepared: new Map(), pending: new Map(), contextEpoch: 0, camera: new THREE.PerspectiveCamera(),
    renderer: { getContext: () => ({ getProgramParameter: () => true, isContextLost: () => false }), compile: () => [],
      properties: { get: () => ({ programs: new Map() }) }, initTexture() {} } });
  scene._acquireMaterial = async () => ({ key: 'material', pack: { manifest: { ...material, rules: { ...RULE_DEFAULTS, ...material.rules } } }, textures: { roles: {} } });
  scene._releaseMaterial = () => {};
  return scene;
}

function viewFor(which) {
  if (which === 'stage') {
    for (const song of syntheticSongs(4000, 11)) {
      const plan = planSongRange(song.profile, song.seed);
      if (plan) return songRangeView(plan, { catalog: MASSIF_CATALOG, sceneCatalog: SCENE_CATALOG });
    }
    throw new Error('no synthetic song plans a stage');
  }
  if (/^pilot-[a-z]$/.test(which)) return songRangeView(pilotPlan(`song-range-${which}`, 'CONIFER'), { catalog: MASSIF_CATALOG, sceneCatalog: SCENE_CATALOG });
  const view = SCENE_CATALOG.views.find((v) => v.id === which);
  if (!view) throw new Error(`no view ${which}`);
  return view;
}

/** One cold run: { loadMs, assembleMs, prepareMs, cpuMs, tiles, triangles, trees }. */
export async function prepareCost(which) {
  const view = viewFor(which), cpu = process.cpuUsage(), started = performance.now();
  let assembleMs = null;
  if (view.songRange) {
    const stage = await loadSongRangeStage(view, { catalog: MASSIF_CATALOG, baseUrl: ASSETS.href, fetchImpl: diskFetch, loadPackage: loadTerrainPackage, sha256Hex });
    assembleMs = stage.timings?.assembleMs ?? null;
  }
  const loadMs = performance.now() - started;
  const scene = sceneFor(view), fetch0 = globalThis.fetch;
  globalThis.fetch = diskFetch;
  let prepared;
  const prepareStart = performance.now();
  try { prepared = await scene.prepare(view, { baseUrl: ASSETS.href, generation: 1 }); } finally { globalThis.fetch = fetch0; }
  const prepareMs = performance.now() - prepareStart, used = process.cpuUsage(cpu);
  return { which, viewId: view.id, loadMs, assembleMs, prepareMs, cpuMs: (used.user + used.system) / 1000,
    tiles: prepared.manifest.tiles.length,
    triangles: Object.fromEntries(Object.entries(prepared.geometries || {}).map(([band, g]) => [band, (g.index?.count ?? 0) / 3])),
    trees: prepared.stats?.trees ?? null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const which = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--repeat') || 'stage';
  const repeat = args.includes('--repeat') ? Number(args[args.indexOf('--repeat') + 1]) : 1;
  for (let i = 0; i < repeat; i++) {
    const r = await prepareCost(which);
    const ms = (v) => (v == null ? 'n/a' : `${v.toFixed(0)} ms`);
    console.log(`${r.which} (${r.viewId}) run ${i + 1}: load ${ms(r.loadMs)}${r.assembleMs == null ? '' : ` (assembly ${ms(r.assembleMs)})`}, prepare ${ms(r.prepareMs)}, `
      + `process CPU ${ms(r.cpuMs)}; ${r.tiles} tiles, triangles ${JSON.stringify(r.triangles)}, trees ${JSON.stringify(r.trees)}`);
  }
}
