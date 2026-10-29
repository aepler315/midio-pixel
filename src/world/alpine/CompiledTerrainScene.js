// Compiled terrain experiment: RangeScene's preparation of a view from a
// compiled pack (docs/compiled-terrain-experiment.md). It publishes the same
// PreparedView shape as RangeScene.prepare, built from the pack instead of
// the production package: the production terrain package, its surface
// texture, horizon bake, material textures and terrain shader are never
// loaded for this view. Forest, cast, camera and swell keep their existing
// code, on the ground the pack displays.
import { RangeAssetError, sha256Hex, gunzip } from './RangeAssets.js';
import { compiledManifestPath, validateCompiledManifest, decodeCompiledPack, compiledTerrainData, regroundForest, compiledBandPlan } from './CompiledTerrain.js';
import { COMPILED_GROUP_TILES, buildCompiledScenes, compiledTerrainUniforms, createCompiledAtlas, createCompiledDepthMaterial, createCompiledMaterial, createCompiledReceiver, COMPILED_VERT } from './CompiledTerrainGL.js';
import { sceneUniforms, applyMaterial } from './TerrainMaterial.js';
import { validateWaterRules } from './MaterialPackage.js';
import { placeForestAsync } from './ForestCover.js';
import { createForest } from './ForestGL.js';
import { forestAssetBytes, FOREST_FAMILIES, FOREST_VARIANTS } from './ForestSpeciesAssets.js';
import { ActorsGL } from './ActorsGL.js';
import { castPlan, castWork } from './CastJobs.js';
import { actorRoutes } from './RangeActors.js';
import { mirrorLevelFor } from './WaterMirror.js';
import { shaderFailureLog } from '../../render/GraphicsDiagnostics.js';
import { BANDS } from './TerrainMesh.js';
import { hashSeed } from '../../utils/math.js';

const FOREST_DETAIL_BYTES = BANDS.length * FOREST_FAMILIES * FOREST_VARIANTS * 8;
const FEATURE_BUDGET_BYTES = 0; // no ink hint geometry in compiled modes
const now = () => globalThis.performance?.now?.() ?? Date.now();

async function fetchBytes(url, { signal, fetchImpl = globalThis.fetch }) {
  let res;
  try { res = await fetchImpl(url, { signal }); } catch (err) {
    if (signal?.aborted) throw new RangeAssetError('aborted', `aborted: ${url}`);
    throw new RangeAssetError('http', `fetch failed for ${url}: ${err?.message || err}`);
  }
  if (!res.ok) throw new RangeAssetError('http', `HTTP ${res.status} for ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (signal?.aborted) throw new RangeAssetError('aborted', `aborted: ${url}`);
  return buf;
}

/**
 * Stage 1 of loading a pack: fetch and validate its manifest. It must be the
 * pack for this view and representation, compiled from the terrain package
 * the catalog pins (its manifest hash). Nothing large is fetched yet, so a
 * caller can reserve CPU room from the manifest alone.
 */
export async function loadCompiledManifest(view, representation, { baseUrl, signal = null, fetchImpl, profile = null } = {}) {
  const t0 = now();
  const manifestUrl = new URL(compiledManifestPath(view.id, representation, profile), baseUrl).href;
  const manifestBytes = await fetchBytes(manifestUrl, { signal, fetchImpl });
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); }
  catch { throw new RangeAssetError('manifest', `compiled manifest is not JSON: ${manifestUrl}`); }
  const shape = validateCompiledManifest(manifest);
  if (!shape.ok) throw new RangeAssetError('manifest', `compiled manifest rejected: ${shape.errors.slice(0, 3).join('; ')}`);
  if (manifest.viewId !== view.id || manifest.representation !== representation) {
    throw new RangeAssetError('manifest', `pack is ${manifest.viewId}/${manifest.representation}, not ${view.id}/${representation}`);
  }
  const pinned = manifest.source.terrainPackage?.manifestSha256;
  if (view.terrainManifestSha256 && pinned !== view.terrainManifestSha256) {
    throw new RangeAssetError('hash', `pack was compiled against terrain ${pinned}, catalog pins ${view.terrainManifestSha256}`);
  }
  return { manifest, manifestUrl, manifestSha256: await sha256Hex(manifestBytes), manifestBytes: manifestBytes.byteLength, manifestMs: now() - t0 };
}

/** Stage 2: fetch the payload, verify every byte, decode. */
export async function loadCompiledPayload(head, { signal = null, fetchImpl } = {}) {
  const { manifest } = head;
  const tFetch0 = now();
  const compressed = await fetchBytes(new URL(manifest.payload.url, head.manifestUrl).href, { signal, fetchImpl });
  const tFetched = now();
  let decoded = compressed;
  if (compressed[0] === 0x1f && compressed[1] === 0x8b) {
    if (compressed.byteLength !== manifest.payload.byteLength) throw new RangeAssetError('hash', 'compiled payload length mismatch');
    if (await sha256Hex(compressed) !== manifest.payload.sha256) throw new RangeAssetError('hash', 'compiled payload hash mismatch');
    try { decoded = await gunzip(compressed); } catch (err) { throw new RangeAssetError('decode', `compiled payload decode failed: ${err?.message || err}`); }
  }
  if (decoded.byteLength !== manifest.payload.decodedByteLength) throw new RangeAssetError('hash', 'compiled decoded length mismatch');
  if (await sha256Hex(decoded) !== manifest.payload.decodedSha256) throw new RangeAssetError('hash', 'compiled decoded hash mismatch');
  const tVerified = now();
  let pack, data;
  try {
    pack = decodeCompiledPack(manifest, decoded);
    data = compiledTerrainData(pack);
  } catch (err) { throw new RangeAssetError('decode', err?.message || String(err)); }
  const tDecoded = now();
  return {
    pack, data, manifestSha256: head.manifestSha256,
    bytes: { manifest: head.manifestBytes, compressed: compressed.byteLength, decoded: decoded.byteLength },
    timings: { manifestMs: head.manifestMs, payloadFetchMs: tFetched - tFetch0, verifyMs: tVerified - tFetched, decodeMs: tDecoded - tVerified },
  };
}

/** Both stages (tests and tools). */
export async function loadCompiledPack(view, representation, options = {}) {
  return loadCompiledPayload(await loadCompiledManifest(view, representation, options), options);
}

/** CPU bytes the ground keeps after preparation, from the manifest alone:
 *  TerrainData heights and flow per lattice sample, and the column tops. */
function groundCpuBytes(manifest) {
  const levels = new Map(manifest.settings.levels.map(l => [l.level, l]));
  let bytes = 0;
  for (const c of manifest.chunks) {
    const n = manifest.settings.chunkCells / levels.get(c.level).cellSamples;
    bytes += (n + 1) * (n + 1) * (4 + 1) + (manifest.representation === 'columns' ? n * n * 2 : 0);
  }
  return bytes;
}

/**
 * Prepare `view` from its `representation` pack inside RangeScene.prepare's
 * job (same staleness and context rules). Throws RangeAssetError; the caller
 * decides which reasons fall back to the production renderer.
 */
export async function prepareCompiledView(scene, view, representation, opts, { epoch, stale }) {
  const THREE = scene.THREE;
  const { signal = null, generation = 0, baseUrl } = opts;
  const timings = {};
  const t0 = now();
  const check = (what) => { if (stale()) throw new RangeAssetError('stale', `stale ${view.id} (${what})`); };
  const gpuKey = `range:terrain-gpu:${view.id}:${scene.budget}`;
  const cpuKey = `range:compiled-cpu:${view.id}:${representation}`;
  let cpuRes = null, res = null, published = false;
  let receiver, atlas, uniforms, material, depthMaterial, built, forest, actors, ownershipMaterials = null;
  try {
    const load = { baseUrl, signal, fetchImpl: opts.fetchImpl, profile: scene.compiledTerrain?.request.profile ?? null };
    const head = await loadCompiledManifest(view, representation, load);
    check('manifest');
    if (scene.residency) {
      // Admitted before the payload is fetched. Lives exactly as long as the
      // view's GPU entry (released by _retire). Both payload forms are
      // charged while preparing; only the ground remains once built.
      cpuRes = scene.residency.reserve({ key: cpuKey, owner: 'range-compiled-cpu', generation, evictable: false,
        bytes: head.manifest.payload.byteLength + head.manifest.payload.decodedByteLength + groundCpuBytes(head.manifest) });
      if (!cpuRes) throw new RangeAssetError('budget', `no room for ${view.id} compiled pack`);
    }
    const loaded = await loadCompiledPayload(head, load);
    Object.assign(timings, loaded.timings);
    check('loaded');
    const m = loaded.pack.manifest;
    const data = loaded.data;
    const rules = { ...m.material.rules, ...(view.materialRules || {}) };
    const waterCheck = validateWaterRules(rules);
    if (!waterCheck.ok) throw new RangeAssetError('manifest', `compiled material rules rejected: ${waterCheck.errors.join('; ')}`);

    // Forest: placed on the source lattice (slopes and limits as in
    // production), then re-seated on the displayed ground.
    const tForest = now();
    const smooth = { ...data, groundAt: null };
    const placed = regroundForest(await placeForestAsync(smooth, view, rules, { seed: hashSeed(view.id), signal }), data.groundAt);
    check('forest');
    timings.forestPlaceMs = now() - tForest;

    // Merged draw geometry (seam fill duplicates its chunks; indices may
    // widen to Uint32), kept on the CPU by Three as well as on the GPU.
    const chunkBytes = (c) => c.positions.byteLength + c.normals.byteLength + c.atlas.byteLength + c.indexCount * 4;
    const bandPlan = compiledBandPlan(loaded.pack);
    const meshBytes = 2 * (loaded.pack.chunks.reduce((n, c) => n + chunkBytes(c), 0)
      + [...bandPlan.fringe.mid, ...bandPlan.fringe.near].reduce((n, c) => n + chunkBytes(c), 0));
    const receiverBytes = m.source.grid.width * m.source.grid.height + m.atlas.texels.byteLength;
    const forestBytes = placed.count * 7 * 4 + forestAssetBytes() + FOREST_DETAIL_BYTES;
    const bytes = meshBytes + receiverBytes + 2 * forestBytes + FEATURE_BUDGET_BYTES + 2 * ActorsGL.bytes();
    res = scene.residency?.reserve({ key: gpuKey, bytes, owner: 'range-terrain-gpu', generation }) || null;
    if (scene.residency && !res) throw new RangeAssetError('budget', `no GPU room for ${view.id} compiled ${representation}`);

    const tUpload = now();
    receiver = createCompiledReceiver(THREE, loaded.pack);
    atlas = createCompiledAtlas(THREE, loaded.pack);
    // Upload now, as production does its surface: the textures then drop
    // their CPU views, which pin the decoded payload until first drawn.
    scene.renderer?.initTexture?.(atlas.texture);
    scene.renderer?.initTexture?.(receiver.texture);
    uniforms = sceneUniforms(THREE, compiledTerrainUniforms(THREE, loaded.pack, receiver, atlas));
    // Palette and rules for the forest and cast; no material textures.
    applyMaterial(uniforms, { manifest: { palette: m.material.palette, rules: m.material.rules } }, { roles: {} }, view.materialRules || {});
    material = createCompiledMaterial(THREE, uniforms, representation);
    depthMaterial = createCompiledDepthMaterial(THREE, uniforms);
    const pixelated = scene.pixelated ?? opts.pixelated ?? false;
    ownershipMaterials = scene._createOwnershipMaterials(uniforms, pixelated, false, COMPILED_VERT);
    built = buildCompiledScenes(THREE, loaded.pack, { material, depthMaterial,
      groupTiles: scene.compiledTerrain?.request.groupTiles ?? COMPILED_GROUP_TILES });
    const { scenes, depthScene, depthScenes } = built;
    forest = createForest(THREE, placed, uniforms, { forestDebug: scene.forestDebug });
    for (const band of BANDS) for (const t of forest.byBand[band]) scenes[band].add(t);
    for (const d of forest.depth) depthScene.add(d);
    for (const band of BANDS) for (const d of forest.depthByBand?.[band] || []) depthScenes[band].add(d);
    actors = new ActorsGL(THREE, uniforms);
    const castSeed = hashSeed(`${view.id}:cast`);
    const plan = castPlan(data, view, { waterLevelM: null, seed: castSeed });
    const routes = plan.job === 'wander' ? actorRoutes(data, view, { waterLevelM: null, seed: castSeed }) : null;
    const work = castWork(plan, { data, waterLevelM: null });
    for (const band of BANDS) scenes[band].add(actors.sites.meshes[band], actors.threads.meshes[band], actors.rope.meshes[band]);
    // Link check, as production: a failed program must not publish.
    const gl = scene.renderer.getContext();
    const targets = [...BANDS.map(band => [scenes[band]]), [depthScene],
      ...Object.values(actors.groups).map(group => [group, scene.camera, scenes.far])];
    if (ownershipMaterials) {
      const ownershipScene = new THREE.Scene();
      for (const band of BANDS) for (const d of built.depthBandMeshes[band]) {
        const om = new THREE.Mesh(d.geometry, ownershipMaterials[band]);
        om.position.copy(d.position); om.updateMatrix(); ownershipScene.add(om);
      }
      targets.push([ownershipScene]);
    }
    const checked = new Set();
    for (const [s, camera = scene.camera, target = null] of targets) {
      for (const mat of scene.renderer.compile(s, camera, target)) {
        if (checked.has(mat)) continue;
        checked.add(mat);
        for (const program of scene.renderer.properties.get(mat).programs.values()) {
          if (gl.getProgramParameter(program.program, gl.LINK_STATUS)) continue;
          if (gl.isContextLost()) throw new RangeAssetError('context-lost', `GPU context lost while compiling ${view.id}`);
          throw new RangeAssetError('shader', `${view.id} compiled ${representation}: ${shaderFailureLog(gl, program.program)}`);
        }
      }
    }
    timings.buildMs = now() - tUpload;
    check('built');
    const compiled = {
      representation, profile: scene.compiledTerrain?.request.profile ?? null, manifestSha256: loaded.manifestSha256, payloadSha256: m.payload.sha256,
      compilerVersion: m.compilerVersion, sourceDemSha256: m.source.demSha256, settings: m.settings,
      stats: m.stats, coverage: m.coverage, deform: m.deform, bytes: loaded.bytes, gpuBytes: built.gpuBytes + receiver.bytes + atlas.bytes,
      drawGroups: built.geometryCount, bandDraws: built.bandDraws, groupTiles: built.groupTiles, timings: { ...timings, totalMs: now() - t0 },
    };
    const prepared = {
      view, generation, manifest: data.manifest, data, identity: { compiled: compiled.payloadSha256 },
      surface: { texture: atlas.texture, receiverTexture: receiver.texture }, uniforms, material, depthMaterial, ownershipMaterials, ownershipVertexShader: COMPILED_VERT,
      horizon: null, depthBandMeshes: built.depthBandMeshes, geometries: {}, fringes: {}, fringeMeshes: built.fringeMeshes,
      fringeTravel: built.fringeTravel, scenes, depthScene, depthScenes,
      riverMaterial: null, riverDepthMaterial: null, riverOwnershipMaterials: null, riverGeometries: {}, riverFringeGeometries: {},
      riverDepthMeshes: {}, riverStats: { triangles: 0, fringeTriangles: 0, bytes: 0 },
      forest, stageGL: null, featureGeometries: {}, featureMaterial: null,
      stats: { triangles: m.stats.triangles, vertices: m.stats.vertices, bytes: built.gpuBytes, trees: forest.counts, featureBytes: 0 },
      gpuKey, cpuKey, cpuOwner: { release: () => scene.residency?.releaseReservation(cpuRes) },
      rules, waterLevelM: null, mirrorLevelM: mirrorLevelFor(data, null), materialKey: null, materialOwner: null,
      actors, actorRoutes: routes, castSeed, castPlan: plan, castWork: work,
      compiled, compiledDispose: () => built.dispose(),
    };
    if (res && !scene.residency.commit(res, prepared, (p) => scene._retire(view.id, p))) {
      throw new RangeAssetError('stale', `generation ${generation} cancelled during ${view.id}`);
    }
    if (cpuRes && !scene.residency.commit(cpuRes, null, null)) throw new RangeAssetError('stale', `compiled pack for ${view.id} retired`);
    scene.residency?.shrinkReservation(cpuRes, groundCpuBytes(m));
    if (scene.contextEpoch !== epoch) throw new RangeAssetError('context-lost', `GPU context changed while preparing ${view.id}`);
    published = true;
    return prepared;
  } finally {
    if (!published) {
      if (res) scene.residency.releaseReservation(res);
      if (cpuRes) scene.residency.releaseReservation(cpuRes);
      forest?.dispose(); actors?.dispose(); built?.dispose();
      material?.dispose(); depthMaterial?.dispose();
      for (const om of Object.values(ownershipMaterials || {})) om.dispose();
      receiver?.texture?.dispose();
      atlas?.texture?.dispose();
    }
  }
}
