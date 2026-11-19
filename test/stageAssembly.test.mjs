import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { assembleStage, loadSongRangeStage, pieceBlock, songRangeView, songRangeViewErrors, stageHash, STAGE_KIND, stageReliefScale, reliefScaleFrom, STAGE_RELIEF,
  INLAND_SURFACE_STRIDE, stageRiseSlots, stageTemplate } from '../src/world/alpine/StageAssembly.js';
import { decodeTerrain, terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';
import { INLAND_RIVER_FLOW, WATER_FLOW } from '../src/world/alpine/TerrainPackage.js';
import { planSongRange, songRangeKey, songReliefJitter } from '../src/world/terrain/SongRangePlan.js';
import { planDualSummitsScene } from '../src/world/terrain/DualSummitsScene.js';
import { inlandHeightAt, makeInlandTerrain } from '../src/world/terrain/InlandTerrain.js';
import { makeInlandWatershed } from '../src/world/terrain/InlandWatershed.js';
import MASSIF_CATALOG from '../src/world/terrain/massifCatalogData.js';
import SCENE_CATALOG from '../src/world/terrain/sceneCatalogData.js';
import { PROFILE_VERSION } from '../src/audio/SongProfile.js';

const ASSETS = new URL('../src/assets/range/v2/', import.meta.url);

test('authored slot placement is bounded, immutable and part of stage identity', () => {
  const plan = planDualSummitsScene('CONIFER');
  const original = MASSIF_CATALOG.templates.find(t => t.id === plan.templateId);
  const t = stageTemplate(MASSIF_CATALOG, plan);
  assert.equal(t.slots.find(s => s.id === 'B2').tiles[0], original.slots.find(s => s.id === 'B2').tiles[0] - 5);
  assert.equal(original.slots.find(s => s.id === 'B2').tiles[0], 17, 'catalog stays untouched');
  assert.notEqual(songRangeKey(plan), songRangeKey({ ...plan, slotOffsets: {} }));
  assert.notEqual(songRangeKey(plan), songRangeKey({ ...plan, camera: { ...plan.camera, fovYDeg: 42 } }));
  for (const slotOffsets of [{ B2: [-100, 0] }, { missing: [0, 0] }, { B2: [.5, 0] }])
    assert.throws(() => stageTemplate(MASSIF_CATALOG, { ...plan, slotOffsets }), /stage slot/);
});
const pilot = JSON.parse(fs.readFileSync(new URL('../data/terrain/song-range-pilot.json', import.meta.url), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');

function loadPackage(url) {
  const manifestBytes = fs.readFileSync(new URL(url, ASSETS));
  const manifest = JSON.parse(manifestBytes);
  const compressed = fs.readFileSync(new URL(manifest.payload.url, new URL(url, ASSETS)));
  const decoded = new Uint8Array(gunzipSync(compressed));
  return { manifest, manifestSha256: sha(manifestBytes), data: decodeTerrain(manifest, decoded),
    bytes: { compressed: compressed.byteLength, decoded: decoded.byteLength } };
}
const pieceById = new Map(MASSIF_CATALOG.pieces.map((p) => [p.id, p]));
const blockCache = new Map();
const blockOf = (id) => {
  if (!blockCache.has(id)) blockCache.set(id, pieceBlock(loadPackage(pieceById.get(id).manifestUrl).data));
  return blockCache.get(id);
};
const planOf = (layout) => ({ version: 1, family: 'dry-conifer', biome: 'CONIFER', templateId: pilot.template, baseM: 2050,
  principal: { slotId: 'B2', pieceId: layout.slots.B2.piece, name: pieceById.get(layout.slots.B2.piece).name },
  slots: MASSIF_CATALOG.templates[0].slots.map((s) => ({ slotId: s.id, pieceId: layout.slots[s.id].piece, mirrored: !!layout.slots[s.id].mirrored })) });
const blocksFor = (plan) => new Map(plan.slots.map((s) => [s.pieceId, blockOf(s.pieceId)]));

test('every catalog piece has a pinned package that decodes as a stride-1 massif piece', () => {
  for (const p of MASSIF_CATALOG.pieces) {
    assert.ok(p.manifestUrl, `${p.id} has no package`);
    const pkg = loadPackage(p.manifestUrl);
    assert.equal(pkg.manifestSha256, p.manifestSha256, `${p.id} pin`);
    const b = pieceBlock(pkg.data);
    assert.equal(b.id, p.id);
    assert.deepEqual(b.tiles, p.tiles);
    let peak = 0;
    for (const v of b.relief) peak = Math.max(peak, v);
    assert.ok(Math.abs(peak - p.peakReliefM) <= 1, `${p.id} peak ${peak} vs ${p.peakReliefM}`);
  }
});

test('runtime assembly reproduces the published Phase 1 stage at every stored sample within 0.09 m', (t) => {
  for (const layout of pilot.layouts) {
    const plan = planOf(layout);
    const run = assembleStage(plan, blocksFor(plan), { catalog: MASSIF_CATALOG, forceStride: 1 });
    const runtime = decodeTerrain(run.manifest, run.decoded);
    const offline = loadPackage(`terrain/${layout.id}.terrain.json`).data;
    let compared = 0, worst = 0;
    for (const t of offline.tiles.values()) {
      const r = runtime.byIndex.get(`${t.ix},${t.iz}`);
      assert.ok(r, `${layout.id}: runtime lacks tile ${t.id}`);
      for (let v = 0; v < t.samples; v++) for (let u = 0; u < t.samples; u++) {
        const a = t.heightsM[v * t.samples + u], b = r.heightsM[(v * t.stride) * r.samples + u * t.stride];
        worst = Math.max(worst, Math.abs(a - b));
        compared++;
      }
    }
    assert.ok(compared > 100000, `${layout.id}: ${compared} samples`);
    assert.ok(worst <= 0.09, `${layout.id}: worst difference ${worst.toFixed(3)} m`);
    t.diagnostic(`${layout.id}: ${compared} samples, worst ${worst.toFixed(4)} m`);
  }
});

test('an assembled stage is a complete, deterministic terrain package with the lake as water', () => {
  const plan = planOf(pilot.layouts[0]);
  const a = assembleStage(plan, blocksFor(plan), { catalog: MASSIF_CATALOG });
  const b = assembleStage(plan, blocksFor(plan), { catalog: MASSIF_CATALOG });
  assert.equal(sha(a.decoded), sha(b.decoded));
  assert.deepEqual(a.manifest, b.manifest);
  assert.equal(a.manifest.kind, STAGE_KIND);
  const t = MASSIF_CATALOG.templates[0];
  assert.equal(a.manifest.tiles.length, ((t.grid.width - 1) / 64) * ((t.grid.height - 1) / 64), 'every tile kept: no holes');
  assert.ok(a.manifest.tiles.every((x) => x.visible && x.lod.desktop >= x.stride && x.lod.mobile >= x.stride));
  const data = decodeTerrain(a.manifest, a.decoded);
  // Lake tiles are stored coarse, so count area (whole tiles), not samples.
  let wetTiles = 0;
  for (const tile of data.tiles.values()) if (tile.flowBytes.every((f) => f === WATER_FLOW)) wetTiles++;
  assert.ok(wetTiles / data.tiles.size > 0.4, `all-water tile share ${wetTiles / data.tiles.size}`);
  // The rail-only rule spends detail near the camera and little far away.
  const strides = a.manifest.tiles.map((x) => x.lod.desktop);
  assert.ok(Math.min(...strides) <= 4 && Math.max(...strides) >= 32, JSON.stringify([Math.min(...strides), Math.max(...strides)]));
});

test('an inland song stage keeps incised channels continuous through the expanded multiresolution grid', async () => {
  const base = planOf(pilot.layouts[0]);
  const inland = makeInlandTerrain(315, { version: 1, skyline: Array.from({ length: 16 }, (_, i) => i / 15) });
  const plan = { ...base, inland };
  const original = stageTemplate(MASSIF_CATALOG, base);
  const extended = stageTemplate(MASSIF_CATALOG, plan);
  const { grid } = extended;
  const tileMetres = 64 * grid.cellSizeM;
  assert.equal((grid.width - 1) * grid.cellSizeM, 89600);
  assert.equal((grid.height - 1) * grid.cellSizeM, 89600);
  for (const [i, slot] of extended.slots.entries()) {
    for (const axis of [0, 1]) assert.equal(grid.originM[axis] + slot.tiles[axis] * tileMetres,
      original.grid.originM[axis] + original.slots[i].tiles[axis] * tileMetres);
  }
  assert.equal(stageRiseSlots(plan, MASSIF_CATALOG).inland, true);
  assert.notEqual(stageHash(plan), stageHash(base));

  const stage = assembleStage(plan, blocksFor(plan), { catalog: MASSIF_CATALOG });
  const data = decodeTerrain(stage.manifest, stage.decoded);
  assert.equal(data.tiles.size, 70 * 70);
  assert.ok(stage.decoded.byteLength < 4 * 1024 * 1024);
  assert.equal(stage.manifest.estimatedBytes.mobile.surfaceTextureBytes,
    Math.round(((grid.width - 1) / INLAND_SURFACE_STRIDE + 1) ** 2 * 16 / 3));
  assert.equal(stage.manifest.hydrology.riverFlow, INLAND_RIVER_FLOW);
  assert.ok(stage.manifest.hydrology.anchors.length > 0);
  let channelTiles = 0, deepestCutM = 0;
  for (const tile of data.tiles.values()) {
    assert.ok(!tile.flowBytes.includes(WATER_FLOW), 'no lake or reflection-plane marker');
    if (!tile.flowBytes.includes(INLAND_RIVER_FLOW)) continue;
    channelTiles++;
    assert.ok(tile.stride <= 4 && tile.lod.mobile <= 8, 'river samples survive in the saved terrain and mobile mesh');
    const x0 = grid.originM[0] + tile.ix * tileMetres, z0 = grid.originM[1] + tile.iz * tileMetres;
    if (x0 + tileMetres >= original.grid.originM[0]) continue;
    const spacingM = tile.stride * grid.cellSizeM;
    for (const [i, flow] of tile.flowBytes.entries()) {
      if (flow !== INLAND_RIVER_FLOW) continue;
      const x = x0 + (i % tile.samples) * spacingM;
      const z = z0 + Math.floor(i / tile.samples) * spacingM;
      deepestCutM = Math.max(deepestCutM, inlandHeightAt(inland, plan.baseM, x, z) - tile.heightsM[i]);
    }
  }
  assert.ok(channelTiles > 20, `channel tiles: ${channelTiles}`);
  assert.ok(deepestCutM > 500, `channel excavation beyond the measured pieces: ${deepestCutM} m`);
  assert.ok([...data.tiles.values()].some(tile => tile.stride === 32), 'outer ridges keep their coarse coverage');
  const [ix, iz] = stage.placed[0].tileOrigin;
  assert.equal(data.byIndex.get(`${ix},${iz}`).stride, 2);
  const watershed = makeInlandWatershed(inland, plan.baseM, stage.manifest.boundsM);
  for (const [x, z] of [[grid.originM[0], grid.originM[1]], [grid.originM[0] + tileMetres, grid.originM[1] + tileMetres]]) {
    const heightM = watershed.sample(x, z, inlandHeightAt(inland, plan.baseM, x, z)).heightM;
    assert.ok(Math.abs(terrainHeightAt(data, x, z) - heightM) <= stage.manifest.quantization.stepM);
  }
  for (const tile of data.tiles.values()) {
    const right = data.byIndex.get(`${tile.ix + 1},${tile.iz}`);
    const bottom = data.byIndex.get(`${tile.ix},${tile.iz + 1}`);
    if (right) for (let z = 0; z <= 64; z += Math.max(tile.stride, right.stride)) {
      const a = z / tile.stride * tile.samples + tile.samples - 1, b = z / right.stride * right.samples;
      assert.equal(tile.heightsM[a], right.heightsM[b]);
      assert.equal(tile.flowBytes[a], right.flowBytes[b]);
    }
    if (bottom) for (let x = 0; x <= 64; x += Math.max(tile.stride, bottom.stride)) {
      const a = (tile.samples - 1) * tile.samples + x / tile.stride, b = x / bottom.stride;
      assert.equal(tile.heightsM[a], bottom.heightsM[b]);
      assert.equal(tile.flowBytes[a], bottom.flowBytes[b]);
    }
  }
  const view = songRangeView(plan, { catalog: MASSIF_CATALOG, sceneCatalog: SCENE_CATALOG });
  const live = await loadSongRangeStage(view, { catalog: MASSIF_CATALOG, baseUrl: ASSETS, loadPackage, sha256Hex: sha, reliefScale: 1 });
  assert.equal(live.identity.decodedSha256, sha(stage.decoded));
  assert.deepEqual(live.manifest.landmarks, stage.manifest.landmarks);
});

test('mirroring a slot mirrors its massif about the block centre', () => {
  const plan = planOf(pilot.layouts[0]);
  const flip = { ...plan, slots: plan.slots.map((s) => s.slotId === 'B2' ? { ...s, mirrored: !s.mirrored } : s) };
  const a = decodeTerrain(...Object.values((({ manifest, decoded }) => ({ manifest, decoded }))(assembleStage(plan, blocksFor(plan), { catalog: MASSIF_CATALOG, forceStride: 1 }))));
  const b = decodeTerrain(...Object.values((({ manifest, decoded }) => ({ manifest, decoded }))(assembleStage(flip, blocksFor(flip), { catalog: MASSIF_CATALOG, forceStride: 1 }))));
  assert.notEqual(stageHash(plan), stageHash(flip));
  const slot = MASSIF_CATALOG.templates[0].slots.find((s) => s.id === 'B2');
  const piece = blockOf(plan.slots.find((s) => s.slotId === 'B2').pieceId);
  const at = [slot.tiles[0] + Math.floor((slot.tiles[2] - piece.tiles[0]) / 2), slot.tiles[1] + Math.floor((slot.tiles[3] - piece.tiles[1]) / 2)];
  const heightAt = (data, gi, gj) => { const t = data.byIndex.get(`${Math.min(34, Math.floor(gi / 64))},${Math.min(34, Math.floor(gj / 64))}`); return t.heightsM[(gj - t.iz * 64) * 65 + (gi - t.ix * 64)]; };
  const i0 = at[0] * 64, j = at[1] * 64 + Math.floor(piece.height / 2), w = piece.width - 1;
  for (const u of [10, 50, Math.floor(w / 2), w - 50]) {
    const ra = heightAt(a, i0 + u, j) - heightAt(a, i0 + u, at[1] * 64);
    const rb = heightAt(b, i0 + (w - u), j) - heightAt(b, i0 + (w - u), at[1] * 64);
    assert.ok(Math.abs(ra - rb) < 2, `column ${u}: ${ra} vs ${rb}`);
  }
});

test('a planned song gets a valid view record that pins its pieces and material', () => {
  let plan = null, seed = 1;
  for (; !plan && seed < 5000; seed++) plan = planSongRange({ version: PROFILE_VERSION, watch: { drive: .5, onset: .3, texture: .4, arc: .5, contrast: .5 } }, seed * 7919);
  assert.ok(plan, 'some seed plans a range');
  const view = songRangeView(plan, { catalog: MASSIF_CATALOG, sceneCatalog: SCENE_CATALOG });
  assert.deepEqual(songRangeViewErrors(view), []);
  assert.equal(view.experimental, true);
  assert.equal(view.biome, plan.biome);
  assert.equal(view.songRange.pieces.length, plan.slots.length);
  assert.equal(view.materialManifestSha256, sha(fs.readFileSync(new URL(view.materialManifestUrl, ASSETS))));
  assert.match(view.id, /^song-range-[0-9a-f]{16}$/);
  assert.deepEqual(songRangeViewErrors({ ...view, songRange: { ...view.songRange, pieces: [] } }), ['songRange pieces']);
});

test('a composed range ends looming: its relief scales until the tallest peak reaches the framing target', () => {
  const plan = planOf(pilot.layouts[0]);
  const measured = assembleStage(plan, blocksFor(plan), { catalog: MASSIF_CATALOG, forceStride: 1 });
  const framed = assembleStage(plan, blocksFor(plan), { catalog: MASSIF_CATALOG, forceStride: 1, reliefScale: 'frame' });
  const s = framed.reliefScale;
  assert.ok(s > 1 && s <= STAGE_RELIEF.maxScale, `scale ${s}`);
  assert.equal(framed.manifest.source.provenance.composition.reliefScale, s);
  assert.equal(measured.reliefScale, 1);
  // Relief scales about the floor; the floor and the lake do not move.
  const a = decodeTerrain(measured.manifest, measured.decoded), b = decodeTerrain(framed.manifest, framed.decoded);
  const t = stageTemplate(MASSIF_CATALOG, plan);
  let checked = 0;
  for (const [key, ta] of a.byIndex) {
    const tb = b.byIndex.get(key);
    for (let k = 0; k < ta.heightsM.length; k += 97) {
      // The template lake (piece tarns sit on scaled relief and move with it).
      const flat = ta.flowBytes?.[k] === WATER_FLOW && Math.abs(ta.heightsM[k] - t.lake.levelM) <= measured.manifest.quantization.stepM;
      // Within the two packages' quantization steps (the step grows with the relief).
      const tol = 2 * Math.max(measured.manifest.quantization.stepM, framed.manifest.quantization.stepM);
      if (flat) { assert.ok(Math.abs(ta.heightsM[k] - tb.heightsM[k]) <= tol, `lake unchanged: ${ta.heightsM[k]} vs ${tb.heightsM[k]}`); continue; }
      checked++;
    }
  }
  assert.ok(checked > 1000);
  for (const [i, p] of framed.placed.entries()) {
    const q = measured.placed[i];
    assert.ok(Math.abs(p.peakReliefM - s * q.peakReliefM) < 1e-6);
    assert.ok(Math.abs((p.stagePeakM - q.stagePeakM) - (s - 1) * q.peakReliefM) < 1e-6, 'peaks rise by the scaled relief above the same floor');
  }
  const peaks = measured.placed.map((p) => ({ x: p.peakLocalM[0], z: p.peakLocalM[1], floorM: p.stagePeakM - p.peakReliefM, reliefM: p.peakReliefM }));
  assert.equal(stageReliefScale(t, peaks), s, 'a pure function of the plan');
  assert.equal(stageReliefScale(t, peaks, { targetY: -1 }), 1, 'a range already tall enough keeps its relief');
  assert.equal(stageReliefScale(t, peaks, { targetY: 5 }), STAGE_RELIEF.maxScale, 'never past the cap');
  const lower = stageReliefScale(t, peaks, { targetY: STAGE_RELIEF.targetY - 0.1 });
  assert.ok(lower < s, 'a lower target needs less stretch');
});

test('two songs with the same layout stand in different terrain', () => {
  const base = planOf(pilot.layouts[0]);
  const a = assembleStage({ ...base, songSeed: 11 }, blocksFor(base), { catalog: MASSIF_CATALOG, forceStride: 1 });
  const b = assembleStage({ ...base, songSeed: 12 }, blocksFor(base), { catalog: MASSIF_CATALOG, forceStride: 1 });
  assert.notEqual(a.reliefScale, b.reliefScale, 'the seed varies the relief');
  assert.notEqual(sha(a.decoded), sha(b.decoded), 'the assembled terrain differs');
  assert.notEqual(songRangeKey({ ...base, songSeed: 11 }), songRangeKey({ ...base, songSeed: 12 }));
  assert.equal(assembleStage(base, blocksFor(base), { catalog: MASSIF_CATALOG, forceStride: 1 }).reliefScale,
    assembleStage({ ...base, songSeed: 11 }, blocksFor(base), { catalog: MASSIF_CATALOG, forceStride: 1 }).reliefScale / songReliefJitter(11),
    'a layout without a song seed keeps measured relief');
});

test('?rangeRelief fixes the scale for review captures; invalid values are ignored', () => {
  assert.equal(reliefScaleFrom(''), null);
  assert.equal(reliefScaleFrom('?rangeRelief=2.5'), 2.5);
  assert.equal(reliefScaleFrom('?rangeRelief=1'), 1);
  for (const bad of ['?rangeRelief=0', '?rangeRelief=-1', '?rangeRelief=99', '?rangeRelief=big']) assert.equal(reliefScaleFrom(bad), null, bad);
});
