// Song range composition, Phase 4: the per-slot rise on a composed stage's
// ground. Which slot owns each tile, what the camera stands on, the CPU
// bounds every culler uses, and the wiring of a prepared stage's programs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { assembleStage, pieceBlock, stageSlotOwners, stageRiseSlots, songRangeView } from '../src/world/alpine/StageAssembly.js';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { slotSinkAt, stageRisenHeight, risenLow, risenHigh, risenSphere, riseFromUniforms, risenHeight, SLOT_RISE_SLOTS,
  LAND_RISE_GLSL, SLOT_LAND_RISE_GLSL } from '../src/world/alpine/LandRise.js';
import { cameraPoseAt } from '../src/world/terrain/SceneTravel.js';
import { planSongRange, pilotPlan } from '../src/world/terrain/SongRangePlan.js';
import { RangeScene, slotSinks } from '../src/world/alpine/RangeScene.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { RULE_DEFAULTS } from '../src/world/alpine/MaterialPackage.js';
import { sceneUniforms, useSlotRise, SCENE_VERT } from '../src/world/alpine/TerrainMaterial.js';
import MASSIF_CATALOG from '../src/world/terrain/massifCatalogData.js';
import SCENE_CATALOG from '../src/world/terrain/sceneCatalogData.js';
import { syntheticSongs } from '../tools/song-range-uniqueness.mjs';
import { gunzipSync } from 'node:zlib';

const ASSETS = new URL('../src/assets/range/v2/', import.meta.url);
const pilots = JSON.parse(fs.readFileSync(new URL('../data/terrain/song-range-pilot.json', import.meta.url), 'utf8')).layouts;
const pieceById = new Map(MASSIF_CATALOG.pieces.map((p) => [p.id, p]));
const blocks = new Map();
const blockOf = (id) => {
  if (!blocks.has(id)) {
    const url = new URL(pieceById.get(id).manifestUrl, ASSETS);
    const manifest = JSON.parse(fs.readFileSync(url));
    const decoded = new Uint8Array(gunzipSync(fs.readFileSync(new URL(manifest.payload.url, url))));
    blocks.set(id, pieceBlock(decodeTerrain(manifest, decoded)));
  }
  return blocks.get(id);
};
const plans = [
  ...pilots.map((l) => pilotPlan(l.id, 'CONIFER')),
  ...[...syntheticSongs(3000, 5)].map((s) => planSongRange(s.profile, s.seed)).filter(Boolean).slice(0, 120),
];
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

test('the owner grid places each slot where assembly places its block', () => {
  for (const plan of plans.slice(0, 9)) {
    const grid = stageSlotOwners(plan, MASSIF_CATALOG);
    const run = assembleStage(plan, new Map(plan.slots.map((s) => [s.pieceId, blockOf(s.pieceId)])), { catalog: MASSIF_CATALOG });
    assert.deepEqual(grid.slotIds, ['floor', ...plan.slots.map((s) => s.slotId)]);
    assert.equal(grid.tilesX * grid.tilesZ, run.manifest.tiles.length);
    const counted = new Array(grid.slotIds.length).fill(0);
    for (const o of grid.owners) counted[o]++;
    for (const p of run.placed) {
      const index = grid.slotIds.indexOf(p.slotId), [w, d] = blockOf(p.pieceId).tiles;
      assert.equal(counted[index], w * d, `${p.slotId} covers its block`);
      for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) {
        assert.equal(grid.owners[(p.tileOrigin[1] + dz) * grid.tilesX + p.tileOrigin[0] + dx], index);
      }
    }
  }
});

test('the camera stands on the floor: its ground rises with the song, whatever the slots do', () => {
  // Floor tiles take the song-global sink, so every eye on the rail sees its
  // own ground lowered exactly as LandRiseCamera assumes.
  for (const plan of plans) {
    const grid = stageSlotOwners(plan, MASSIF_CATALOG);
    const template = MASSIF_CATALOG.templates.find((t) => t.id === plan.templateId);
    const random = rng(plan.slots.length * 7 + grid.owners.reduce((a, b) => a + b, 0));
    for (let trial = 0; trial < 4; trial++) {
      const sinks = Array.from({ length: SLOT_RISE_SLOTS }, () => random() * 2 / 3);
      for (let k = 0; k <= 32; k++) {
        const [x, , z] = cameraPoseAt({ camera: template.camera }, k / 32).eyeM;
        const at = slotSinkAt(grid, sinks, x, z);
        assert.equal(at.sink, sinks[0], `${plan.slots[4]?.pieceId}: eye ${k} stands on the floor`);
        assert.equal(at.dx, 0); assert.equal(at.dz, 0);
      }
    }
  }
});

test('neighbouring slots join without a step: the sink is continuous across tile and slot edges', () => {
  const grid = stageSlotOwners(plans[0], MASSIF_CATALOG);
  const sinks = [0.5, 0.1, 0.6, 0.2, 0.65, 0.05, 0.4, 0.3, 0.55];
  const eps = 1e-3;
  for (let i = 0; i < 4000; i++) {
    const x = grid.originM[0] + (i % 70) * grid.tileM / 2 + 1e-4, z = grid.originM[1] + Math.floor(i / 70) * grid.tileM / 2 + 1e-4;
    const a = slotSinkAt(grid, sinks, x - eps, z), b = slotSinkAt(grid, sinks, x + eps, z);
    const c = slotSinkAt(grid, sinks, x, z - eps), d = slotSinkAt(grid, sinks, x, z + eps);
    assert.ok(Math.abs(a.sink - b.sink) < 1e-5 && Math.abs(c.sink - d.sink) < 1e-5, `step at ${x}, ${z}`);
    // The derivatives the normals use agree with the field.
    const m = slotSinkAt(grid, sinks, x + 0.37 * grid.tileM, z + 0.21 * grid.tileM);
    const h = 0.5;
    const fx = (slotSinkAt(grid, sinks, x + 0.37 * grid.tileM + h, z + 0.21 * grid.tileM).sink - slotSinkAt(grid, sinks, x + 0.37 * grid.tileM - h, z + 0.21 * grid.tileM).sink) / (2 * h);
    if (Math.abs(fx - m.dx) > 1e-6) assert.fail(`dx ${m.dx} against ${fx}`);
  }
});

test('culling bounds span every slot: box ends and spheres hold the drawn stage', () => {
  const grid = stageSlotOwners(plans[1], MASSIF_CATALOG);
  const random = rng(99);
  for (let trial = 0; trial < 200; trial++) {
    const sinks = Array.from({ length: SLOT_RISE_SLOTS }, () => random() * 0.66);
    const baseM = 2050, rise = { sink: sinks.reduce((a, b) => a + b) / sinks.length, baseM, sinkLo: Math.min(...sinks), sinkHi: Math.max(...sinks) };
    for (let k = 0; k < 50; k++) {
      const x = grid.originM[0] + random() * grid.tilesX * grid.tileM, z = grid.originM[1] + random() * grid.tilesZ * grid.tileM;
      const y = 1500 + random() * 3000, drawn = stageRisenHeight(grid, sinks, baseM, x, y, z);
      assert.ok(risenLow(y, rise) <= drawn + 1e-9 && drawn <= risenHigh(y, rise) + 1e-9);
      const r = 40 * random(), s = risenSphere(x, y, z, r, rise);
      assert.ok(Math.abs(drawn - s.y) <= s.radius - r + 1e-9);
    }
  }
  // Without a slot span (every catalog view) the bounds are risenHeight exactly.
  const plain = { sink: 0.4, baseM: 1200 };
  for (const y of [-300, 900, 1200, 4400]) {
    assert.equal(risenLow(y, plain), risenHeight(y, 0, plain));
    assert.equal(risenHigh(y, plain), risenHeight(y, 0, plain));
    assert.deepEqual(risenSphere(0, y, 0, 7, plain), { y: risenHeight(y, 0, plain), radius: 7 });
  }
});

test('the uniforms report a stage\'s slot span, and catalog views exactly as before', () => {
  const u = sceneUniforms(THREE, {});
  u.uLandRise.value.set(0.3, 2050);
  assert.deepEqual(riseFromUniforms(u), { sink: 0.3, baseM: 2050 });
  u.uSlotFrame.value.w = 1;
  slotSinks(['floor', 'H1', 'B2'], { rise01: 0.7, slotRise01: { H1: 0.9, B2: 0.4 } }, u.uSlotSink.value);
  assert.deepEqual(Array.from(u.uSlotSink.value, (v) => Math.round(v * 1e6) / 1e6), [0.3, 0.1, 0.6, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3]);
  const rise = riseFromUniforms(u);
  assert.equal(rise.sink, 0.3);
  assert.ok(Math.abs(rise.sinkLo - 0.1) < 1e-6 && Math.abs(rise.sinkHi - 0.6) < 1e-6);
  // A frame with no slot rises (a transition, a fallback) holds every slot at the scalar.
  slotSinks(['floor', 'H1'], { rise01: 0.5 }, u.uSlotSink.value);
  assert.ok(Array.from(u.uSlotSink.value).every((v) => v === 0.5));
});

test('a stage material swaps in the slot rise; catalog sources stay byte for byte', () => {
  assert.ok(SCENE_VERT.includes(LAND_RISE_GLSL));
  const m = useSlotRise(new THREE.ShaderMaterial({ vertexShader: SCENE_VERT, fragmentShader: 'void main() {}' }));
  assert.ok(m.vertexShader.includes(SLOT_LAND_RISE_GLSL) && !m.vertexShader.includes(LAND_RISE_GLSL));
  assert.equal(useSlotRise(m), m, 'swapping twice is a no-op');
  assert.throws(() => useSlotRise(new THREE.ShaderMaterial({ vertexShader: 'void main() {}' })), /LAND_RISE_GLSL/);
});

// A RangeScene without a GL context (railOnlyPrepare.test.mjs's harness).
const material = JSON.parse(fs.readFileSync(new URL('../src/assets/range/v2/materials/dry-conifer.json', import.meta.url), 'utf8'));
function scene() {
  const s = Object.assign(Object.create(RangeScene.prototype), { budget: 'desktop', THREE, residency: new GraphicsResidency({ budgetBytes: 4e9 }), tourForest: true,
    prepared: new Map(), pending: new Map(), contextEpoch: 0, camera: new THREE.PerspectiveCamera(),
    renderer: { getContext: () => ({ getProgramParameter: () => true, isContextLost: () => false }), compile: () => [],
      properties: { get: () => ({ programs: new Map() }) }, initTexture() {} } });
  s._acquireMaterial = async () => ({ key: 'material', pack: { manifest: { ...material, rules: { ...RULE_DEFAULTS, ...material.rules } } }, textures: { roles: {} } });
  s._releaseMaterial = () => {};
  return s;
}
const diskFetch = async (url) => {
  const p = String(url).startsWith('file:') ? fileURLToPath(url) : fileURLToPath(new URL(new URL(url).pathname.slice(1), ASSETS));
  return fs.existsSync(p) ? new Response(fs.readFileSync(p)) : new Response(null, { status: 404 });
};
const materialsOf = (p) => {
  const out = new Set();
  const visit = (o) => o?.traverse?.((n) => { for (const m of [].concat(n.material || [])) if (m?.isShaderMaterial) out.add(m); });
  for (const sc of [...Object.values(p.scenes || {}), p.depthScene, ...Object.values(p.depthScenes || {})]) visit(sc);
  for (const m of [p.material, p.riverMaterial, p.depthMaterial, p.riverDepthMaterial, p.featureMaterial,
    ...Object.values(p.ownershipMaterials || {}), ...Object.values(p.riverOwnershipMaterials || {})]) if (m) out.add(m);
  for (const mesh of [...Object.values(p.forest?.byBand || {}).flat(), ...(p.forest?.depth || []), ...Object.values(p.forest?.depthByBand || {}).flat()]) out.add(mesh.material);
  return [...out].filter((m) => m.vertexShader?.includes('riseLift'));
};

test('a prepared stage draws every program on the slot rise, wired to its owner texture', { timeout: 120000 }, async () => {
  const plan = pilotPlan(pilots[0].id, 'CONIFER');
  const view = songRangeView(plan, { catalog: MASSIF_CATALOG, sceneCatalog: SCENE_CATALOG });
  const s = scene();
  const fetch = globalThis.fetch;
  globalThis.fetch = diskFetch;
  let p;
  try { p = await s.prepare(view, { baseUrl: ASSETS.href, generation: 1 }); } finally { globalThis.fetch = fetch; }
  assert.ok(p?.slotRise, 'the stage has a slot rise');
  assert.deepEqual(p.slotRise.slotIds, ['floor', ...plan.slots.map((x) => x.slotId)]);
  assert.equal(p.uniforms.uSlotOwner.value, p.slotRise.texture);
  assert.deepEqual([p.slotRise.texture.image.width, p.slotRise.texture.image.height], [35, 35]);
  assert.deepEqual(p.uniforms.uSlotFrame.value.toArray(), [-22400, -22400, 1280, 1]);
  const programs = materialsOf(p);
  assert.ok(programs.length >= 8, `${programs.length} rising programs`);
  for (const m of programs) assert.ok(m.userData.slotRise && m.vertexShader.includes('uSlotOwner'), 'every program that rises takes the slot path');
  // Lazily made passes follow the view.
  const own = s._createOwnershipMaterials(p.uniforms, false, false, SCENE_VERT, p.slotRise);
  for (const m of Object.values(own)) assert.ok(m.userData.slotRise);
  // The frame writes each slot's sink.
  slotSinks(p.slotRise.slotIds, { rise01: 0.6, slotRise01: { B2: 0.5, H1: 0.9 } }, p.uniforms.uSlotSink.value);
  assert.ok(Math.abs(p.uniforms.uSlotSink.value[p.slotRise.slotIds.indexOf('B2')] - 0.5) < 1e-6);
  s._disposePrepared?.(p);
});

test('a catalog view prepares exactly as before: no slot rise, no swapped program', { timeout: 120000 }, async () => {
  const view = SCENE_CATALOG.views.find((v) => v.id === 'teton-jackson-lake');
  const s = scene();
  const fetch = globalThis.fetch;
  globalThis.fetch = diskFetch;
  let p;
  try { p = await s.prepare(view, { baseUrl: ASSETS.href, generation: 1 }); } finally { globalThis.fetch = fetch; }
  assert.equal(p.slotRise, null);
  assert.equal(p.uniforms.uSlotFrame.value.w, 0);
  for (const m of materialsOf(p)) assert.ok(!m.userData.slotRise && m.vertexShader.includes(LAND_RISE_GLSL));
  s._disposePrepared?.(p);
});

test('a song with a composed range describes its slots for the score', () => {
  const plan = plans[0];
  const { slots, principal } = stageRiseSlots(plan, MASSIF_CATALOG);
  assert.equal(principal, plan.principal.slotId);
  assert.deepEqual(slots.map((x) => x.slotId), plan.slots.map((x) => x.slotId));
  assert.ok(slots.every((x) => ['horizon', 'back', 'front'].includes(x.row)));
});
