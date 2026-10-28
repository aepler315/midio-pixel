import { cloudPuffs, MAX_CLOUD_PUFFS, CLOUD_SHADOW_MAX } from './CloudOcclusion.js';
import { cloudShadowCasters, CLOUD_CASTER_STRIDE, CLOUD_WIND_AXIS } from './RangeCloudField.js';
import { cinematicLightingProfile } from './CinematicLighting.js';
import { shaderFailureLog } from '../../render/GraphicsDiagnostics.js';
import { applyLensFov } from '../../render/CameraLens.js';
import { terrainShadingMode, terrainShadingForView } from './TerrainShadingExperiment.js';
import { resolveRangeComposition, compositionBars } from './RangeComposition.js';
import { rangeRenderPolicy, supportedSamples, msaaOverride, sceneTargetBytes, sideTargetBytes, nearerMask } from './RangeRenderPolicy.js';
// Range v2 GPU scene (plan §6, §7.2). One reusable WebGL2 context, owned
// here, renders transparent terrain partitions that RangePresentation copies
// synchronously into the main stage canvas at the existing pass boundaries.
//
// Occlusion is exact across partitions: each frame starts with one depth
// pass of every band into a reusable render target; each partition then
// draws only its own band with depth-test LEQUAL against that full-scene
// depth, so a partition shows only surfaces that are frontmost. Composited
// in pass order with other painters between them, every pixel has exactly
// one terrain owner and nothing is drawn twice.
//
// Ownership: CPU packages come from RangeAssets under the shared
// GraphicsResidency; GPU meshes, the surface texture and render targets are
// reserved here before creation and released through dispose().
import { prepareTerrainAssets, RangeAssetError } from './RangeAssets.js';
import { createSurfaceTextureAsync, terrainUniforms, createBandGeometries, createBandGeometriesAsync } from './TerrainGL.js';
import { syncGustUniforms, syncWaterMusicUniforms, sceneUniforms, createSceneMaterial, createDepthMaterial, setLinearFromHex, createMaterialTextures, applyMaterial, SCENE_VERT, FEATURE_FRAG } from './TerrainMaterial.js';
import { terrainFeatureSegmentsAsync } from './TerrainFeatures.js';
import { loadMaterialPack, materialGpuBytes, RULE_DEFAULTS, validateWaterRules } from './MaterialPackage.js';
import { placeForestAsync, forestPlacementBound } from './ForestCover.js';
import { SunShaftGL, SHAFT_KEY, shaftSize, shaftSource } from './SunShaftGL.js';
import { rangeQuality, easeRungAmount } from './RangeQuality.js';
import { hashSeed } from '../../utils/math.js';
import { createForest, FOREST_ASSET_BUILD_BYTES, forestGroupingBytes } from './ForestGL.js';
import { forestAssetBytes, FOREST_FAMILIES, FOREST_VARIANTS } from './ForestSpeciesAssets.js';
import { bakeHorizonAsync, createHorizonTexture, horizonBytes } from './TerrainOcclusion.js';
import { planTerrainWindow, terrainWindowCoverage, terrainWindowCovers, tourSummitTiles, terrainPixelProtection, TourWindowCache } from './TerrainWindow.js';
import { TerrainWindowWorker, shareTerrainLanes, terrainLaneBytes } from './TerrainWindowWorkerClient.js';
import { buildTerrainGeometry } from './TerrainMesh.js';
import { buildRockStage } from './RockStage.js';
import { RockStageGL } from './RockStageGL.js';
import { scenePoseAt } from '../terrain/SceneTravel.js';
import { applyCameraMoves, rangeUserCamera } from './RangeCamera.js';
import { BANDS, terrainFringeBytes, terrainHeightAt, SURFACE_BUILD_BYTES_PER_PIXEL } from './TerrainMesh.js';
import { mistParams, mistDrift, easeMistSteps, tourMistCap, tourMistFade, atmosphereMusic } from './RangeAtmosphere.js';
import { mirrorSize, mirrorLevelFor, mirrorCameraFor, mirrorTextureMatrix, MIRROR_CLIP_M, MIRROR_LIFT } from './WaterMirror.js';
import { scenicProjection, calibrateRangeMusic } from './RangeFrame.js';
import { applyGlacierUniforms, glacierErrors, glacierSample } from './GlacierField.js';
import { ActorsGL, SITE_LIGHTS_MAX, CAST_LAYER, CAST_RIBBON_LAYER, enableCastLayers } from './ActorsGL.js';
import { buildRiverGeometry, riverGeometryBound, riverChannelErrors } from './RiverChannel.js';
import { ACTOR_IDS, ACTOR_HUES, ACTOR_LOOK, ACTOR_START, actorRoutes, routePosition } from './RangeActors.js';
import { castPlan, castWork, pathPosition, siteWalk } from './CastJobs.js';
import { flashScreenPoint, rainSeed01, stormKindRow } from './RangeStorm.js';
// Storm light, linear: the deck's underside, the rain-dimmed horizon, the
// rain air, per episode kind (RangeStorm STORM_KINDS zenith/horizon/air).
// The air meets the slate the sky paints at the horizon (drawStormSky).

// Fair-weather shadow casters (RangeCloudField), filled in place per frame.
const CLOUD_SHADOW_CASTERS = 16;
const CASTERS = new Float32Array(CLOUD_SHADOW_CASTERS * CLOUD_CASTER_STRIDE);
const CASTER_LIGHT = [0, 1, 0], CASTER_EYE = [0, 0, 0];
const BACKDROP_KEY = 'range:water-backdrop';
// Full/lite pairs share instances and retain two scalar attributes per batch.
const FOREST_DETAIL_BYTES = BANDS.length * FOREST_FAMILIES * FOREST_VARIANTS * 8;
const RIVER_VERTICES_PER_SET = 60000; // primary surface and seam fill share one admitted bound
/** ?rangeDebug=<mode> terrain diagnostics (uDebugMask in TerrainMaterial). */
export const TERRAIN_DEBUG_MODES = Object.freeze({ masks: 1, slope: 2, albedo: 3, fill: 4, key: 5, roughness: 6, specular: 7, sun: 8 });

const COPY_VERT = /* glsl */`
  out vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
// With multisampling a silhouette pixel is shared between partitions. The
// pre-pass records which band owns each sample (uOwn: far, mid, near
// coverage); a partition is rescaled by the coverage nearer partitions will
// leave it, so disjoint coverage composites to its exact sum and no sky
// shows through a fully covered pixel (RangeRenderPolicy.correctCoverage).
const COPY_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uColor;
  uniform sampler2D uOwn;
  uniform vec3 uNearer;
  uniform float uUseOwn;
  in vec2 vUv;
  out vec4 outColor;
  void main() {
    vec4 c = texture(uColor, vUv);
    if (uUseOwn > 0.5 && c.a > 0.0) {
      float nearer = dot(texture(uOwn, vUv).rgb, uNearer);
      if (nearer > 0.0) c *= min(1.0 / max(1.0 - nearer, 1.0 / 255.0), 1.0 / c.a);
    }
    outColor = c;
  }
`;
// The depth pre-pass, also writing its band's one-hot ownership colour.
const OWNERSHIP_FRAG = /* glsl */`
  precision highp float;
  uniform float uClipBelow;
  in vec3 vRenderedWorld;
  out vec4 outColor;
  void main() { if (vRenderedWorld.y < uClipBelow) discard; outColor = OWNER_COLOUR; }
`;
const OWNER_COLOURS = { far: 'vec4(1.0, 0.0, 0.0, 1.0)', mid: 'vec4(0.0, 1.0, 0.0, 1.0)', near: 'vec4(0.0, 0.0, 1.0, 1.0)' };

const hexToLinear = (THREE, hex, target) => setLinearFromHex(target, hex);

function yieldToMain() {
  return new Promise((res) => setTimeout(res, 0));
}

/** Median height of the package's hydro-flattened water samples (the
 *  valley floor the mist settles on); null when the view has no water. */
function waterLevel(data) {
  const hs = [];
  for (const t of data.tiles.values()) {
    if (!t.flowBytes) continue;
    for (let i = 0; i < t.flowBytes.length; i += 7) if (t.flowBytes[i] === 255 && Number.isFinite(t.heightsM[i])) hs.push(t.heightsM[i]);
  }
  if (!hs.length) return null;
  hs.sort((a, b) => a - b);
  return hs[hs.length >> 1];
}

export class RangeScene {
  /** `THREE` is the local bundle; `residency` the shared ledger. */
  constructor({ THREE, residency, budget = 'desktop', canvas = null, contextAttributes = {}, diag = null }) {
    this.THREE = THREE;
    this.diag = diag;
    // Developer-only representation probe; normal shaders compile it out.
    this.forestDebug = new URLSearchParams(globalThis.location?.search || '').get('forestDebug') === '1';
    this.terrainShading = terrainShadingMode();
    // Developer-only terrain views (?rangeDebug=roughness etc.).
    this.debugMask = TERRAIN_DEBUG_MODES[new URLSearchParams(globalThis.location?.search || '').get('rangeDebug')] ?? 0;
    this.residency = residency;
    this.budget = budget;
    this.canvas = canvas || document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, alpha: true, premultipliedAlpha: true, antialias: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance', ...contextAttributes,
    });
    if (!this.renderer.capabilities.isWebGL2) throw new RangeAssetError('decode', 'WebGL2 unavailable');
    this.renderer.autoClear = false;
    // Edge policy inputs: what this context can multisample, and the
    // developer override. The presentation supplies quality and look.
    this.edge = { capability: supportedSamples(this.renderer.getContext()), override: msaaOverride(), samples: 0, reason: 'not-sized' };
    this.ownership = { A: null, B: null };
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // shaders encode sRGB themselves
    this.camera = new THREE.PerspectiveCamera(35, 16 / 9, 20, 150000);
    this.prepared = new Map(); // viewId -> PreparedView
    this.materials = new Map(); // manifest URL -> { pack, textures, key, users:Set }
    this.pending = new Map(); // viewId -> { generation, job }
    this.materialLoads = new Map(); // manifest URL -> in-flight acquisition
    this.target = null;
    this.sideTargets = { B: null };
    // Lake mirror image per side (optional, like the shafts), drawn once a frame.
    this.mirrors = { A: null, B: null };
    this.mirrorCamera = new THREE.PerspectiveCamera();
    // Moved camera poses per frame and view (see _setCamera).
    this._movedPoses = new WeakMap();
    this.depthCache = { A: { frame: -1, view: null }, B: { frame: -1, view: null } };
    this.size = { width: 0, height: 0 };
    this.contextLost = false;
    this.stats = { depthPasses: 0, partitions: 0, lastPartitionMs: 0, castPasses: 0 };
    // The cast draws in the band passes unless the presentation takes it
    // from renderCast to lay over the pixel frame itself (it clears this).
    this.castInBands = true;
    this._copy = this._createCopy();
    // Each loss and each restore starts a new context epoch: a preparation
    // that straddles either built GPU objects (and dropped the surface
    // texture's CPU pixels) in a context that is gone, so it must not publish.
    this.contextEpoch = 0;
    this.canvas.addEventListener?.('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; this.contextEpoch++; this._invalidateContext(); });
    this.canvas.addEventListener?.('webglcontextrestored', () => { this.contextLost = false; this.contextEpoch++; });
  }

  _createCopy() {
    const THREE = this.THREE;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: COPY_VERT, fragmentShader: COPY_FRAG,
      uniforms: { uColor: { value: null }, uOwn: { value: null }, uNearer: { value: new THREE.Vector3() }, uUseOwn: { value: 0 } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    return { scene, mesh, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
  }

  /** Physical backing size of the partition images. `pixelRatio` is
   *  evidence/LOD context only; widthPx/heightPx are already physical. */
  resize({ widthPx, heightPx, pixelRatio = 1, quality = 0, pixelated = false, pixelHeightPx = null, cinematicPixel = false }) {
    const w = Math.max(2, Math.round(widthPx)), h = Math.max(2, Math.round(heightPx));
    this.pixelRatio = pixelRatio;
    this.pixelated = !!pixelated;
    this.cinematicPixel = !!cinematicPixel;
    this.pixelHeightPx = pixelated && pixelHeightPx > 0 ? pixelHeightPx : null;
    this.pixelScale = 'original';
    for (const p of this.prepared?.values() || []) {
      for (const material of [p.material, p.riverMaterial]) {
        if (!material || !!material.defines?.PIXEL_MATERIAL_SKIP === this.pixelated) continue;
        if (this.pixelated) material.defines.PIXEL_MATERIAL_SKIP = 1;
        else delete material.defines.PIXEL_MATERIAL_SKIP;
        material.needsUpdate = true;
      }
    }
    const policy = rangeRenderPolicy({ widthPx: w, heightPx: h, quality, pixelated, budget: this.budget,
      capability: this.edge?.capability ?? 0, override: this.edge?.override ?? null });
    // Everything a budget fallback depends on. The fallback is retried only
    // when one of these changes -- never per frame, and never on routine
    // ledger churn -- so a refused multisample target does not tear down
    // side B, the mirror and the shafts on every resize call.
    const request = [w, h, quality | 0, !!pixelated, this.edge?.capability ?? 0, this.edge?.override ?? null,
      this.contextEpoch ?? 0, this.budget, this.residency?.budgetBytes ?? null].join('|');
    const live = this.target && (!this.residency || this.residency.has('range:render-target'));
    const sameSize = live && w === this.size.width && h === this.size.height;
    if (sameSize && this._edgeRequest?.key === request) return;
    this._edgeRequest = { key: request, args: { widthPx: w, heightPx: h, pixelRatio, quality, pixelated } };
    this.edge.requestedSamples = policy.samples;
    if (sameSize && policy.samples === this.edge.samples) {
      this.edge.reason = policy.reason;
      return;
    }
    this.releaseShafts();
    const key = 'range:render-target';
    if (this.residency) this.residency.release(key);
    else { this.target?.dispose(); this.ownership?.A?.dispose(); }
    this.target = null;
    if (this.ownership) this.ownership.A = null;
    // Colour RGBA8 + 24/8 depth-stencil ~ 8 bytes per pixel, plus the
    // drawing buffer (4), plus any multisample renderbuffers and the band
    // ownership image -- reserved before creation. A refused multisample
    // budget retries single-sampled before refusing the view.
    let samples = policy.samples, reason = policy.reason;
    let res = this.residency?.reserve({ key, bytes: sceneTargetBytes(w, h, samples), owner: 'range-targets' });
    if (this.residency && !res && samples > 0) {
      samples = 0; reason = 'budget';
      res = this.residency.reserve({ key, bytes: sceneTargetBytes(w, h, 0), owner: 'range-targets' });
    }
    if (this.residency && !res) throw new RangeAssetError('budget', `no room for a ${w}x${h} range target`);
    this.renderer.setPixelRatio(1);
    this._setCanvasSize(w, h);
    this.target = this._scenicTarget(w, h, samples);
    this.ownership ??= { A: null, B: null };
    this.ownership.A = samples > 0 ? this._ownershipTarget(w, h) : null;
    this.edge = { ...this.edge, samples, reason };
    this.size = { width: w, height: h };
    const target = this.target, own = this.ownership.A;
    const dispose = (t) => {
      t.dispose(); own?.dispose();
      if (this.ownership.A === own) this.ownership.A = null;
      if (this.target === t) this.target = null;
    };
    if (res) this.residency.commit(res, target, dispose);
    this.depthCache.A.frame = -1;
    this.releaseMirror('A');
    // The incoming side's target follows the new size on its next use.
    this.releaseSide('B');
  }

  /** A scenic colour+depth target, multisampled when `samples` > 0. Its
   *  resolved texture is read 1:1 by the copy, so it stays nearest-filtered. */
  _scenicTarget(w, h, samples = 0) {
    const THREE = this.THREE;
    const target = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: true, stencilBuffer: false, type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, samples,
    });
    // Pixel targets are single-sampled. Replace their unsampleable depth
    // buffer at creation (same base charge); the scenic target owns its
    // depth texture independently of optional shaft allocation/lifetime.
    if (samples === 0 && THREE.DepthTexture) {
      try {
        target.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
        target.depthTexture.minFilter = target.depthTexture.magFilter = THREE.NearestFilter;
      } catch { /* Depth unavailable: the copy retains the original grid. */ }
    }
    return target;
  }

  /** Resolved band ownership of a multisampled side (see COPY_FRAG). */
  _ownershipTarget(w, h) {
    const THREE = this.THREE;
    return new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: false, stencilBuffer: false, type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
  }

  /** What the scene's edge policy is doing, for diagnostics and evidence. */
  renderDiagnostics() {
    return { size: { ...this.size }, samples: this.edge?.samples ?? 0, requestedSamples: this.edge?.requestedSamples ?? 0,
      edgeReason: this.edge?.reason ?? null,
      capability: this.edge?.capability ?? 0, override: this.edge?.override ?? null,
      ownership: { A: !!this.ownership?.A, B: !!this.ownership?.B }, sideB: !!this.sideTargets?.B,
      drawingBuffer: this.canvasSize ? { ...this.canvasSize } : null };
  }

  /** A second scenic target for the incoming side of a view-to-view
   *  travel, reserved before it exists. False when the budget refuses it
   *  (the outgoing view then keeps drawing alone). */
  ensureSide(side = 'B') {
    if (side !== 'B') return !!this.target;
    if (this.sideTargets.B) return true;
    if (!this.target) return false;
    this.releaseShafts();
    const { width: w, height: h } = this.size;
    const key = 'range:render-target-B';
    // The incoming side matches the main target's samples, so both sides
    // of a travel seam have the same edges.
    const samples = this.edge?.samples ?? 0;
    const res = this.residency?.reserve({ key, bytes: sideTargetBytes(w, h, samples), owner: 'range-targets' });
    if (this.residency && !res) return false;
    const t = this._scenicTarget(w, h, samples);
    const own = samples > 0 ? this._ownershipTarget(w, h) : null;
    this.sideTargets.B = t;
    this.ownership ??= { A: null, B: null };
    this.ownership.B = own;
    if (res) this.residency.commit(res, t, (x) => {
      x.dispose(); own?.dispose();
      if (this.sideTargets.B === x) this.sideTargets.B = null;
      if (this.ownership.B === own) this.ownership.B = null;
    });
    this.depthCache.B.frame = -1;
    return true;
  }

  /** Free the incoming side's target once no transition needs it. */
  releaseSide(side = 'B') {
    if (side !== 'B') return;
    this.releaseMirror('B');
    if (!this.sideTargets?.B) return;
    this.releaseShafts();
    const t = this.sideTargets.B;
    if (this.residency) this.residency.release('range:render-target-B');
    else { t.dispose(); this.ownership?.B?.dispose(); }
    this.sideTargets.B = null;
    if (this.ownership) this.ownership.B = null;
  }

  /** Optional attachments are admitted only after all active base targets,
   * views and travel scratch. No partial A/B bundle can be published. */
  prepareShafts(frame, viewIds) {
    // No sun, no context or no target: nothing to fade, release at once
    // (a returning sun then fades in from zero).
    if (this.contextLost || !shaftSource(frame) || !this.target) {
      this.releaseShafts(); this.shaftEaseAtMs = frame.timeMs; return false;
    }
    // A rung shed or recovery fades the shafts over heard time (A and B
    // views share one presence, advanced once per heard frame); the bundle
    // is released only once the fade reaches 0.
    const dtSec = (frame.timeMs - (this.shaftEaseAtMs ?? -Infinity)) / 1000;
    this.shaftPresence = easeRungAmount(this.shaftPresence, rangeQuality(frame.qualityLevel).sunShafts ? 1 : 0, dtSec);
    this.shaftEaseAtMs = frame.timeMs;
    if (!(this.shaftPresence > 0)) { this.releaseShafts(); return false; }
    const ids = [].concat(viewIds);
    const targets = ids.length > 1 && this.sideTargets.B ? { A: this.target, B: this.sideTargets.B } : { A: this.target };
    const identity = `${ids.join('|')}:${this.size.width}:${this.size.height}:${this.contextEpoch}`;
    if (this.shafts && this.shaftIdentity === identity) return true;
    this.releaseShafts({ keepPresence: true });
    const { width, height } = shaftSize(this.size.width, this.size.height);
    const bytes = width * height * 4 * Object.keys(targets).length + 36;
    // Protect every currently resident essential range entry, including an
    // upcoming view. Optional light cannot evict a view to make itself fit.
    const protect = [...(this.residency?.entries.keys() || [])];
    const res = this.residency?.reserve({ key: SHAFT_KEY, bytes, owner: 'range-shafts', protect });
    if (this.residency && !res) return false;
    const shafts = new SunShaftGL(this.THREE, targets);
    const dispose = (effect) => {
      effect.dispose();
      if (this.shafts === effect) { this.shafts = null; this.shaftIdentity = null; this.shaftPresence = 0; }
      if (this.depthCache) this.depthCache.A.frame = this.depthCache.B.frame = -1;
    };
    if (res && !this.residency.commit(res, shafts, dispose)) return false;
    this.shafts = shafts; this.shaftIdentity = identity; this.shaftViews = ids;
    this.depthCache.A.frame = this.depthCache.B.frame = -1;
    return true;
  }

  /** The side's mirror image target, reserved as optional light: it may
   *  not evict anything resident to fit, and anything may evict it. */
  _ensureMirror(side) {
    const scale = Math.max(1, this.waterOutputScale || 1);
    const { width, height } = mirrorSize(this.size.width * scale, this.size.height * scale);
    const identity = `${width}x${height}:${this.contextEpoch}`;
    const have = this.mirrors[side];
    if (have && have.identity === identity) return have;
    this.releaseMirror(side);
    const key = `range:water-mirror-${side}`;
    const protect = [...(this.residency?.entries.keys() || [])];
    // RGBA8 colour + 24/8 depth.
    const res = this.residency?.reserve({ key, bytes: width * height * 8, owner: 'range-mirror', protect });
    if (this.residency && !res) return null;
    const THREE = this.THREE;
    const target = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: true, stencilBuffer: false, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    const entry = { key, identity, target, frame: -1, view: null, matrix: new THREE.Matrix4() };
    const dispose = (e) => { e.target.dispose(); if (this.mirrors[side] === e) this.mirrors[side] = null; };
    if (res && !this.residency.commit(res, entry, dispose)) return null;
    this.mirrors[side] = entry;
    return entry;
  }

  releaseMirror(side) {
    const m = this.mirrors?.[side];
    if (!m) return;
    if (this.residency) this.residency.release(m.key);
    else m.target.dispose();
    this.mirrors[side] = null;
  }

  /**
   * What the stage holds before the middle distance is drawn (the 2D sky,
   * aurora and distant ranges, and the far partition) is the backdrop the
   * lake reflects: copy the stage area of `ctx` into a small texture the
   * water in the middle and near partitions samples along its (lowered)
   * reflected ray. Only while a prepared view mirrors; otherwise the copy
   * is released.
   */
  captureBackdrop(ctx, stage, frame, drawSky = null) {
    const wanted = !this.contextLost && rangeQuality(frame?.qualityLevel).waterMirror
      && [...this.prepared.values()].some((p) => Number.isFinite(p.mirrorLevelM));
    if (!wanted || !ctx?.canvas || !(stage?.width > 0)) { this.releaseBackdrop(); return false; }
    const scale = Math.max(1, this.waterOutputScale || 1);
    const { width, height } = mirrorSize(this.size.width * scale, this.size.height * scale);
    let b = this.backdrop;
    if (!b || b.width !== width || b.height !== height || b.epoch !== this.contextEpoch) {
      this.releaseBackdrop();
      // The copy canvas and its texture.
      const res = this.residency?.reserve({ key: BACKDROP_KEY, bytes: width * height * 8, owner: 'range-mirror',
        protect: [...(this.residency?.entries.keys() || [])] });
      if (this.residency && !res) return false;
      const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
      const THREE = this.THREE;
      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = false;
      b = { width, height, epoch: this.contextEpoch, canvas, ctx: canvas.getContext('2d'), texture, frame: -1 };
      const dispose = (x) => { this._unbindBackdrop(x.texture); x.texture.dispose(); x.canvas.width = x.canvas.height = 0; if (this.backdrop === x) this.backdrop = null; };
      if (res && !this.residency.commit(res, b, dispose)) return false;
      this.backdrop = b;
    }
    // The stage's rectangle in the canvas: the painter's scale/translate.
    const T = ctx.getTransform?.() || { a: 1, d: 1, e: 0, f: 0 };
    b.ctx.clearRect(0, 0, width, height);
    if (drawSky) {
      b.ctx.save();
      try { drawSky(b.ctx, width, height); }
      finally { b.ctx.restore(); }
    }
    b.ctx.drawImage(ctx.canvas, T.e, T.f, T.a * stage.width, T.d * stage.height, 0, 0, width, height);
    b.texture.needsUpdate = true;
    b.frame = frame?.frameId ?? -1;
    return true;
  }

  releaseBackdrop() {
    if (!this.backdrop) return;
    if (this.residency) this.residency.release(BACKDROP_KEY);
    else { this._unbindBackdrop(this.backdrop.texture); this.backdrop.texture.dispose(); this.backdrop = null; }
    this.backdrop = null;
  }

  /** Every release path (unwanted, resized, evicted, lost context) reaches
   *  here. A view whose mirror is skipped keeps its sampler; three would
   *  reallocate the disposed CanvasTexture from the emptied canvas (0x0,
   *  INVALID_VALUE). Unbind exactly this texture from every view. */
  _unbindBackdrop(texture) {
    for (const p of this.prepared?.values() || []) {
      const u = p.uniforms;
      if (u?.uBackdrop?.value !== texture) continue;
      u.uBackdrop.value = null;
      if (u.uBackdropAmount) u.uBackdropAmount.value = 0;
    }
  }

  /**
   * Draw this side's lake mirror for `frame` (once per frame and view) and
   * point the water at it; without water near the view's level, at a
   * quality that sheds it, or without room, the water keeps its sky
   * reflection.
   */
  _updateForestDetail(p, frame, camera, width, height, kind) {
    if (!p.forest?.updateDetailView) return;
    const key = `${frame.frameId}:${kind}:${width}:${height}`;
    if (p.forestDetailState?.forest === p.forest && p.forestDetailState.key === key) return;
    const state = p.forest.updateDetailView({ camera, width, height, pixelated: !!this.pixelated,
      nearDetail: rangeQuality(frame.qualityLevel).nearDetail });
    p.forestDetailState = { forest: p.forest, key };
    p.forestDetailViews ||= {};
    p.forestDetailViews[kind] = state;
  }

  _prepareMirror(p, frame, side, viewId) {
    const u = p.uniforms;
    u.uViewportPx.value.set(this.size.width, this.size.height);
    const ripple = (m) => 0.0012 + 0.0025 * (m?.groove ?? 0) + 0.004 * (m?.kick01 ?? 0);
    const level = p.mirrorLevelM;
    const wanted = Number.isFinite(level) && rangeQuality(frame.qualityLevel).waterMirror
      && (frame.narrative?.materials ?? 1) > .01;
    const m = wanted ? this._ensureMirror(side) : null;
    // A recovered mirror fades in over heard time; a shed drops it at once
    // (keeping it would prolong the overload). Once per heard frame.
    const dtSec = (frame.timeMs - (p.mirrorEaseAtMs ?? -Infinity)) / 1000;
    p.mirrorFade = easeRungAmount(p.mirrorFade, m ? 1 : 0, dtSec, { down: 'snap' });
    p.mirrorEaseAtMs = frame.timeMs;
    if (!m) { u.uMirrorAmount.value = 0; u.uBackdropAmount.value = 0; if (!wanted) this.releaseMirror(side); return; }
    if (m.frame !== frame.frameId || m.view !== viewId) {
      const r = this.renderer;
      const THREE = this.THREE;
      mirrorCameraFor(THREE, this.camera, level, this.mirrorCamera, MIRROR_LIFT);
      mirrorTextureMatrix(THREE, this.mirrorCamera, m.matrix);
      for (const fm of p.fringeMeshes || []) fm.visible = false;
      u.uMirrorAmount.value = 0;
      // A disabled reflection still has an active sampler. Unbind the
      // previous image before drawing into it to avoid framebuffer feedback.
      u.uMirror.value = null;
      u.uClipBelow.value = level + MIRROR_CLIP_M;
      // Rain over the reflected land stands where the mirror camera sees it;
      // the main camera's matrix is restored below, before the partitions.
      this.mirrorCamera.updateMatrixWorld();
      u.uViewProj.value.multiplyMatrices(this.mirrorCamera.projectionMatrix, this.mirrorCamera.matrixWorldInverse);
      u.uViewportPx.value.set(m.target.width, m.target.height);
      this._updateForestDetail(p, frame, this.mirrorCamera, m.target.width, m.target.height, 'mirror');
      r.setRenderTarget(m.target);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, false);
      const softForest = Object.values(p.forest?.counts || {}).some(n => n > 0);
      // The lake reflects the cast with each band (it never takes the main
      // camera's separate cast pass).
      this.mirrorCamera.layers.set(0);
      if (!softForest) { this.mirrorCamera.layers.enable(3); enableCastLayers(this.mirrorCamera); }
      r.render(p.depthScene, this.mirrorCamera);
      for (const band of BANDS) r.render(p.scenes[band], this.mirrorCamera);
      if (softForest) {
        this.mirrorCamera.layers.set(1);
        for (const band of BANDS) r.render(p.scenes[band], this.mirrorCamera);
        this.mirrorCamera.layers.set(2);
        r.render(p.depthScene, this.mirrorCamera);
        this.mirrorCamera.layers.set(3);
        enableCastLayers(this.mirrorCamera);
        for (const band of BANDS) r.render(p.scenes[band], this.mirrorCamera);
      }
      this.mirrorCamera.layers.set(0); this.mirrorCamera.layers.enable(3);
      u.uClipBelow.value = -1e9;
      m.frame = frame.frameId;
      m.view = viewId;
      this.stats.mirrorPasses = (this.stats.mirrorPasses || 0) + 1;
    }
    u.uViewportPx.value.set(this.size.width, this.size.height);
    u.uMirror.value = m.target.texture;
    u.uMirrorMatrix.value.copy(m.matrix);
    const b = this.backdrop?.frame === frame.frameId ? this.backdrop : null;
    u.uBackdrop.value = b?.texture || null;
    u.uBackdropAmount.value = b ? 1 : 0;
    u.uViewProj.value.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    u.uMirrorLevel.value = level;
    u.uMirrorRipple.value = ripple(frame.music);
    u.uMirrorAmount.value = p.mirrorFade;
  }

  /** The frame's sun-shaft source scaled by the rung fade (null at 0).
   *  The far pass and renderDirectShaft both read it, so display and
   *  capture scatter the same light. */
  _shaftSource(frame) {
    // Before any prepareShafts the rung alone decides, as it always did.
    const presence = this.shaftPresence ?? (rangeQuality(frame.qualityLevel).sunShafts ? 1 : 0);
    if (!(presence > 0)) return null;
    const src = shaftSource(frame);
    return src && { ...src, stormGain: src.stormGain * presence };
  }

  /** Free the shaft bundle. Eviction, context loss, view retirement and
   *  resize also end the fade (presence 0); only a re-allocation inside
   *  prepareShafts keeps it. */
  releaseShafts({ keepPresence = false } = {}) {
    if (!keepPresence) this.shaftPresence = 0;
    const shafts = this.shafts;
    if (!shafts) return;
    // Detach first: the ledger's dispose callback treats a still attached
    // bundle as an eviction (which ends the fade).
    this.shafts = null;
    if (this.residency) this.residency.release(SHAFT_KEY);
    else shafts.dispose();
    if (this.depthCache) this.depthCache.A.frame = this.depthCache.B.frame = -1;
    this.shaftIdentity = null;
  }

  /** The one drawing buffer is shared by scenic and ground images of
   *  different sizes; resize it only when the next copy needs another. */
  _setCanvasSize(w, h) {
    if (this.canvasSize?.width === w && this.canvasSize?.height === h) return;
    this.renderer.setSize(w, h, false);
    this.canvasSize = { width: w, height: h };
  }

  isReady(viewId) { return this.prepared.has(viewId) && !this.contextLost; }

  /** Conservative capability check: sampled lake water or mapped river
   * geometry. A dry view must not pay for the optional water passes. */
  hasWater(viewId) {
    const p = this.prepared.get(viewId);
    return !!p && (Number.isFinite(p.waterLevelM) || (p.riverStats?.triangles || 0) > 0);
  }

  replaceTour(view) {
    const p=this.prepared.get(view.id);if(!p?.windowCache)return;
    p.view=view;p.windowWorker.setTour(view.tour);
    this._invalidateTourWindows(p);
  }

  /** A shot tour's camera timeline for a prepared static view (null: its
   *  authored rail). Prepared resources were built for the library's
   *  footprint, so swapping a song's plan touches no GPU state. */
  setCameraTour(viewId, tour) {
    const p = this.prepared.get(viewId);
    if (!p || p.windowCache || p.cameraTour === tour) return;
    p.cameraTour = tour || null;
    this._movedPoses = new WeakMap();
  }

  _invalidateTourWindows(p, { keepDetail = false } = {}) {
    const active = p.activeWindow;
    p.detailHeldWindow = keepDetail && active && !active.coarse
      && (active.detail?.coverageRevision === (p.coverageRevision || 0) || active === p.detailHeldWindow) ? active : null;
    p.coverageRevision = (p.coverageRevision || 0) + 1;
    p.windowOptions = { ...p.windowOptions, coverageRevision: p.coverageRevision };
    p.windowCache.invalidate(p.activeWindow);
    for(const entry of p.rawAhead?.values()||[])this._dropTourRaw(entry);
    p.rawAhead?.clear();p.prefetchAttempted=null;
    p.coverageRetryAt = 0;
    p.windowPlans = null;
  }

  _updateTourCoverage(p, frame) {
    if (!p?.windowCache || !frame?.scenicViewport) return;
    const coverage = terrainWindowCoverage(frame.scenicViewport);
    const pixelHeightPx = this.pixelated && !p.view?.glacier ? this.pixelHeightPx : null;
    if (p.windowOptions.coverage?.key === coverage.key && (p.windowOptions.pixelHeightPx ?? null) === (pixelHeightPx ?? null)) return;
    const keepDetail = p.windowOptions.coverage?.key === coverage.key;
    p.windowOptions = { ...p.windowOptions, coverage, pixelHeightPx };
    this._invalidateTourWindows(p, { keepDetail });
  }

  _tourWindowResource(p, index, geos, forest, key, coarse = false, reservation = null) {
    let disposed = false;
    const resource = { index, geos, forest, key, coarse,
      destroy: () => {
        if (disposed) return; disposed = true;
        if (p.windowCache?.resident.get(index) === resource) p.windowCache.resident.delete(index);
        for (const g of Object.values(geos.geometries)) g.dispose();
        for (const g of Object.values(geos.fringes)) g.dispose();
        forest.dispose();
      },
      dispose: () => { if (this.residency && key) this.residency.releaseReservation(reservation || { key }); else resource.destroy(); },
    };
    return resource;
  }

  /** Bounded deterministic plans survive retries, but never new coverage,
   * route, source terrain or material rules. */
  _terrainWindowSpec(p, index) {
    let cache = p.windowPlans;
    if (!cache || cache.options !== p.windowOptions || cache.tour !== p.view.tour || cache.data !== p.data || cache.rules !== p.rules) {
      cache = p.windowPlans = { options: p.windowOptions, tour: p.view.tour, data: p.data, rules: p.rules, entries: new Map() };
    }
    if (!cache.entries.has(index)) {
      if (cache.entries.size >= 4) cache.entries.delete(cache.entries.keys().next().value);
      cache.entries.set(index, {});
    }
    return cache.entries.get(index);
  }

  _terrainBuildSpec(p, index) {
    const spec = this._terrainWindowSpec(p, index);
    if (spec.bytes != null) return spec;
    const view = index == null ? p.view : { ...p.view, tourWindowStartMs: index * 8000 };
    const forest = forestPlacementBound(p.data, view, p.rules);
    const scratch = Math.max(forest.placementBytes,
      forest.count * 32 + forestGroupingBytes(forest.count) + FOREST_ASSET_BUILD_BYTES);
    let terrain = 0, plan = null;
    if (index != null) {
      plan = planTerrainWindow(p.data, p.view.tour, index, p.windowOptions);
      for (const tile of p.data.tiles.values()) {
        if (!tile.visible) continue;
        const m = p.data.cells / plan.strides.get(tile.id);
        terrain += 12 * (m + 1) ** 2 + 48 * m * m;
      }
    }
    const bytes = scratch + (index == null ? 0 : 2 * terrain + forest.count * 56 + 2 * 1024 ** 2);
    Object.assign(spec, { plan, bytes });
    return spec;
  }

  _terrainBuildProtect(p, index) {
    const current = p.windowCache?.current ?? p.windowIndex ?? 0;
    // Speculation cannot displace either current or next. A current upgrade
    // may reclaim an unused future window instead of remaining coarse.
    return [p.gpuKey, p.cpuKey, p.materialKey, p.workerKey, p.activeWindow?.key,
      index > current ? p.windowCache?.resident.get(current + 1)?.key : null].filter(Boolean);
  }

  _retireTourSpeculation(p, index) {
    const current = p.windowCache?.current ?? p.windowIndex ?? 0;
    if (index != null && index <= current) for (const [ahead, entry] of p.rawAhead || []) {
      if (ahead > current) { this._dropTourRaw(entry); p.rawAhead.delete(ahead); }
    }
  }

  _canRetryTerrainBuild(p, index) {
    this._retireTourSpeculation(p, index);
    return !this.residency || this.residency.canFit(this._terrainBuildSpec(p, index).bytes, this._terrainBuildProtect(p, index));
  }

  /** Admit the complete build peak before dispatch; executing work retains
   * its charge through cancellation and staged graphics finalization. */
  _admitTerrainBuild(p, index = null) {
    this._retireTourSpeculation(p, index);
    const { plan, bytes } = this._terrainBuildSpec(p, index);
    const key = `range:build:${p.view.id}:${index ?? 'forest'}:${this._buildSerial = (this._buildSerial || 0) + 1}`;
    const protect = this._terrainBuildProtect(p, index);
    this.buildAdmission ||= { requestedBytes: 0, admittedBytes: 0, denials: 0, peakBytes: 0 };
    this.buildAdmission.requestedBytes += bytes;
    const reservation = this.residency?.reserve({ key, bytes,
      owner: index == null ? 'range-forest-build' : 'range-tour-window', generation: 0, evictable: false, protect });
    if (this.residency && !reservation) {
      this.buildAdmission.denials++;
      throw new RangeAssetError('budget', `No room to build terrain window ${index ?? p.view.id}`);
    }
    this.buildAdmission.admittedBytes += bytes;
    this.buildAdmission.peakBytes = Math.max(this.buildAdmission.peakBytes, bytes);
    return { key, reservation, bytes, plan };
  }

  /** Static placement has returned compact records; its temporary chunks
   * no longer belong to this phase. Keep records and the full existing
   * grouping/asset allowances until forest construction completes. */
  _retireForestPlacement(p, entry, placed) {
    if (p.view.tour) return;
    const records = [placed.meshDetail, placed.mesh, placed.billboard].reduce((sum, a) => sum + (a?.byteLength || 0), 0);
    const bytes = records + forestGroupingBytes(placed.count) + FOREST_ASSET_BUILD_BYTES;
    if (bytes > entry.bytes) throw new RangeAssetError('budget', 'Forest records exceed admitted build bound');
    if (this.residency && !this.residency.shrinkReservation(entry.reservation, bytes)) {
      throw new RangeAssetError('stale', 'Forest placement reservation retired');
    }
    entry.bytes = bytes;
  }

  _requestTourRaw(p, index) {
    const entry = this._admitTerrainBuild(p, index);
    entry.coverageRevision = p.coverageRevision || 0;
    entry.done = false;
    try {
      entry.job = p.windowWorker.build(index, p.windowOptions, entry.plan).then(raw => {
        entry.done = true;
        if (entry.cancelled || entry.coverageRevision !== (p.coverageRevision || 0)) throw new RangeAssetError('stale', 'Tour window generation ended');
        return raw;
      }).catch(error => {
        entry.done = true;
        this.residency?.releaseReservation(entry.reservation);
        throw error;
      });
    } catch (error) {
      this.residency?.releaseReservation(entry.reservation);
      throw error;
    }
    return entry;
  }

  _dropTourRaw(entry) {
    entry.cancelled = true;
    // postMessage cancellation is not termination. Pending output still
    // owns its reservation until the worker settles (or is terminated).
    if (entry.done) { entry.job = null; this.residency?.releaseReservation(entry.reservation); }
  }

  async _buildTourWindow(p, index) {
    const generation = p.windowCache.generation;
    const ahead = p.rawAhead?.get(index);
    const entry = ahead || this._requestTourRaw(p, index);
    // The finalizer now owns these bytes through its yields. Speculative
    // cleanup must not release them merely because the worker has finished.
    if (ahead) p.rawAhead.delete(index);
    let geos, forest, transferred = false;
    try {
      const raw = await entry.job;
      if (entry.cancelled || p.windowCache.closed || generation !== p.windowCache.generation || entry.coverageRevision !== (p.coverageRevision || 0) || !this.prepared.has(p.view.id)) {
        throw new RangeAssetError('stale', 'Tour window generation ended');
      }
      const bytes = 2 * (Object.values(raw.built.bands).reduce((n, b) => n + b.positions.byteLength + b.indices.byteLength + b.fringe.byteLength, 0) + raw.placed.count * 7 * 4 + forestAssetBytes() + FOREST_DETAIL_BYTES);
      if (bytes > entry.bytes) throw new RangeAssetError('budget', 'Window exceeded admitted build bound');
      const checkCurrent = () => {
        if (entry.cancelled || p.windowCache.closed || generation !== p.windowCache.generation || entry.coverageRevision !== (p.coverageRevision || 0)
          || this.prepared.get(p.view.id) !== p || this.residency?.cancelled.has(p.generation)) {
          throw new RangeAssetError('stale', 'Tour window generation ended');
        }
      };
      geos = await createBandGeometriesAsync(this.THREE, p.data, { built: raw.built, checkCurrent });
      forest = createForest(this.THREE, raw.placed, p.uniforms, { forestDebug: this.forestDebug });
      const window = this._tourWindowResource(p, index, geos, forest, entry.key, false, entry.reservation);
      window.detail = raw.plan;
      // Promise fulfillment is not cache adoption. Keep this exact resource
      // protected until the cache accepts it or disposes the rejected result.
      window.adopt = () => {
        if (!entry.reservation) return true;
        const owned = this.residency.entries.get(entry.key);
        if (owned?.id !== entry.reservation.id || this.residency.cancelled.has(p.generation)) return false;
        this.residency.retag(entry.key, p.generation);
        owned.evictable = true;
        return true;
      };
      // Raw placement/group arrays leave scope after construction. CPU
      // BufferAttributes and uploads are the retained two-copy charge.
      raw.placed = null;
      this.residency?.shrink(entry.key, bytes);
      if (entry.reservation && !this.residency.commit(entry.reservation, window, w => w.destroy())) throw new RangeAssetError('stale', 'Tour window cancelled');
      transferred = true;
      p.lastWindowBytes = bytes;
      return window;
    } finally {
      entry.job = null;
      if (ahead && p.rawAhead.get(index) === ahead) p.rawAhead.delete(index);
      if (!transferred) {
        forest?.dispose();
        for (const g of Object.values(geos?.geometries || {})) g.dispose();
        for (const g of Object.values(geos?.fringes || {})) g.dispose();
        this.residency?.releaseReservation(entry.reservation);
      }
    }
  }

  _swapTourWindow(p, window) {
    if (p.activeWindow === window) return;
    const previous = p.activeWindow;
    const replacements = new Map();
    for (const band of BANDS) {
      replacements.set(p.geometries[band], window.geos.geometries[band]);
      if (p.fringes[band]) replacements.set(p.fringes[band], window.geos.fringes[band]);
      for (const m of p.forest.byBand[band]) p.scenes[band].remove(m);
      for (const m of window.forest.byBand[band]) p.scenes[band].add(m);
      for (const m of p.forest.depthByBand[band]) p.depthScenes[band].remove(m);
      for (const m of window.forest.depthByBand[band]) p.depthScenes[band].add(m);
    }
    for (const m of p.forest.depth) p.depthScene.remove(m);
    for (const m of window.forest.depth) p.depthScene.add(m);
    for (const scene of [...Object.values(p.scenes), p.depthScene, ...Object.values(p.depthScenes)]) {
      for (const object of scene.children) if (replacements.has(object.geometry)) object.geometry = replacements.get(object.geometry);
    }
    p.geometries = window.geos.geometries; p.fringes = window.geos.fringes; p.forest = window.forest;
    p.activeWindow = window; p.windowIndex = window.index;
    if (p.detailHeldWindow === previous) p.detailHeldWindow = null;
    // pinView ran before this frame resolved its window. Transfer its hold
    // before any later target/material reservation can evict the new mesh.
    if (this.residency) {
      const pinned = [...this.residency.pinned].filter(key => key !== previous?.key);
      this.residency.pin([...pinned, window.key]);
    }
    p.stats = { ...p.stats, ...window.geos.stats, trees: window.forest.counts, windowIndex: window.index, coarse: window.coarse, pixelLimit: window.detail?.pixelLimit, detailNote: window.detail?.detailNote };
    if (previous && (p.windowCache.resident.get(previous.index) !== previous || previous.detail?.coverageRevision !== (p.coverageRevision || 0))) {
      if (p.windowCache.resident.get(previous.index) === previous) p.windowCache.resident.delete(previous.index);
      previous.dispose();
    }
  }

  _ensureTourWindow(p, timeMs, camera = null) {
    if (!p?.windowCache) return;
    const index = Math.max(0, Math.floor(Math.min(timeMs, Math.max(0, p.view.tour.durationMs - 1)) / 8000));
    p.windowCache.current = index;
    const fail = error => { if (error?.reason !== 'stale' && error?.name !== 'AbortError') p.windowNote = error.message; };
    const report = (w, covered, reason = null) => {
      p.windowCoverage = { revision: p.coverageRevision || 0, key: p.windowOptions.coverage?.key,
        covered, reason, activeRevision: w?.detail?.coverageRevision, framing: w?.detail?.coverage,
        pixelLimit: w?.detail?.pixelLimit, maxErrorPx: w?.detail?.maxErrorPx,
        summitPixelLimit: w?.detail?.summitPixelLimit, summitMaxErrorPx: w?.detail?.summitMaxErrorPx,
        protectedTiles: w?.detail?.protectedTiles };
      Object.assign(p.windowCoverage, { detailHeightPx: w?.detail?.detailHeightPx,
        pixelErrorPx: w?.detail?.pixelErrorPx, pixelTrianglesSaved: w?.detail?.pixelTrianglesSaved,
        pixelCoarsenedTiles: w?.detail?.pixelCoarsenedTiles, pixelProtectedTiles: w?.detail?.pixelProtectedTiles,
        pixelCoarsenedMaxErrorPx: w?.detail?.pixelCoarsenedMaxErrorPx });
    };
    let window = p.windowCache.resident.get(index);
    const covers = w => !camera || (w?.detail?.coverageRevision === (p.coverageRevision || 0)
      && terrainWindowCovers(w.detail, camera.pose, camera.proj));
    const rejected = window && !covers(window) ? window : null;
    if (rejected) window = null;
    // A neighbouring full mesh may be held only while it covers the actual
    // view. A turn or a wider viewport needs a new covering reconstruction.
    const detailPending = p.activeWindow && p.activeWindow === p.detailHeldWindow && camera
      && terrainWindowCovers(p.activeWindow.detail, camera.pose, camera.proj);
    const held = !window && p.activeWindow && !p.activeWindow.coarse && Math.abs(p.activeWindow.index - index) <= 1
      && (covers(p.activeWindow) || detailPending) ? p.activeWindow : null;
    if (held) window = held;
    if (!window) {
      if (p.coverageRetryAt > Date.now()) { report(p.activeWindow, false, 'budget'); return false; }
      const spec = this._terrainWindowSpec(p, index);
      const plan = spec.coarse ||= planTerrainWindow(p.data, p.view.tour, index, { ...p.windowOptions, bias: 2 });
      const key = `range:tour-window:${p.view.id}:${p.coverageRevision || 0}:${index}:coarse:${this._buildSerial = (this._buildSerial || 0) + 1}`;
      const bytes = 2 * (plan.triangles * 36 + 256 * 1024);
      const reserve = () => this.residency?.reserve({ key, bytes, owner: 'range-tour-window', generation: p.generation,
        protect: [p.gpuKey, p.cpuKey, p.workerKey, p.activeWindow?.key].filter(Boolean) });
      let reservation = reserve(), retired = null;
      if (this.residency && !reservation && p.activeWindow && !covers(p.activeWindow)) {
        // This mesh cannot be displayed. Retaining it must not force a
        // legacy fallback when its room can admit the covering reconstruction.
        retired = p.activeWindow;
        if (p.windowCache.resident.get(retired.index) === retired) p.windowCache.resident.delete(retired.index);
        p.activeWindow = null;
        retired.dispose();
        reservation = reserve();
      }
      if (this.residency && !reservation) {
        report(p.activeWindow, false, 'budget');
        p.coverageRetryAt = Date.now() + 250;
        p.windowCache.request(index, { replace: true }).catch(fail);
        return false;
      }
      const built = buildTerrainGeometry(p.data, { strides: plan.strides });
      const geos = createBandGeometries(this.THREE, p.data, { built });
      const forest = createForest(this.THREE, { mesh: new Float32Array(), billboard: new Float32Array(), stride: 8, count: 0 }, p.uniforms, { forestDebug: this.forestDebug });
      window = this._tourWindowResource(p, index, geos, forest, key, true, reservation);
      window.detail = plan;
      if (reservation && !this.residency.commit(reservation, window, w => w.destroy())) return;
      if (rejected && rejected !== retired && rejected !== p.activeWindow) rejected.dispose();
      p.windowCache.resident.set(index, window);
    }
    this._swapTourWindow(p, window);
    report(window, covers(window) || !!(held && detailPending), held && detailPending ? 'detail-pending' : null);
    p.windowCoverage.targetDetailHeightPx = p.windowOptions.pixelHeightPx;
    p.windowCache.prune();
    if (window.coarse) p.windowCache.request(index, { replace: true }).catch(fail);
    else if (held) p.windowCache.request(index, { replace: !!detailPending }).catch(fail);
    const currentReady = !window.coarse && p.windowCache.resident.get(index) === window
      && (window.detail?.coverageRevision ?? 0) === (p.coverageRevision || 0);
    if (currentReady && (index + 1) * 8000 < p.view.tour.durationMs) p.windowCache.request(index + 1).catch(fail);
    // Admit against this window's own plan, not the preceding window's
    // size. Keep the admitted result until handoff, disposal or termination.
    p.rawAhead ||= new Map();
    for (const [old, entry] of p.rawAhead) if (old < index || old > index + 2) { this._dropTourRaw(entry); p.rawAhead.delete(old); }
    const aheadIndex = index + 2, next = p.windowCache.resident.get(index + 1);
    if (currentReady && next && !next.coarse && aheadIndex * 8000 < p.view.tour.durationMs && !p.rawAhead.has(aheadIndex) && p.prefetchAttempted !== aheadIndex) {
      p.prefetchAttempted = aheadIndex;
      try {
        const entry = this._requestTourRaw(p, aheadIndex);
        p.rawAhead.set(aheadIndex, entry);
        entry.job.catch(error => {
          if (p.rawAhead.get(aheadIndex) === entry) p.rawAhead.delete(aheadIndex);
          fail(error);
        });
      } catch (error) { fail(error); }
    }
    return p.windowCoverage.covered;
  }

  /**
   * Prepare one view (CPU package + GPU objects). Resolves PreparedView or
   * rejects with RangeAssetError; a stale generation never publishes.
   */
  prepare(view, opts = {}) {
    const iceErrors = glacierErrors(view.glacier);
    if (iceErrors.length) return Promise.reject(new RangeAssetError('decode', iceErrors.join('; ')));
    const { signal = null, generation = 0, baseUrl, isCurrent = () => true } = opts;
    if (this.prepared.has(view.id)) return Promise.resolve(this.prepared.get(view.id));
    const pend = this.pending.get(view.id);
    if (pend) {
      if (pend.generation === generation) return pend.job;
      // An earlier song's load of the same view: once it settles (it
      // publishes, or rejects as stale when its generation is cancelled),
      // prepare for this generation -- never inherit its stale rejection.
      return pend.job.catch(() => {}).then(() => this.prepare(view, opts));
    }
    if (this.contextLost) return Promise.reject(new RangeAssetError('context-lost', `GPU context lost; ${view.id} waits for restore`));
    const epoch = this.contextEpoch;
    const job = (async () => {
      let windowWorker = null;
      const cpuOwner = { holderKey: `range:terrain-gpu:${view.id}:${this.budget}`,
        onRetire: () => {
          windowWorker?.dispose();
          if (res) this.residency?.releaseReservation(res);
        } };
      let mat = null, res = null, published = false;
      const cpu = await prepareTerrainAssets(view, { baseUrl, residency: this.residency, generation, signal, isCurrent, owner: cpuOwner });
      let surface, geos, material, riverMaterial, riverDepthMaterial, riverOwnershipMaterials = null, depthMaterial, ownershipMaterials = null, horizon = null, forest, stageGL, featureMaterial, actors;
      const riverGeometries = {}, riverFringeGeometries = {}, riverDepthMeshes = {};
      let initialWindow = null, workerKey = null, windowReservation = null, buildEntry = null, workerReservation = null;
      const featureGeometries = {};
      // This preparation's hold on its material pack (see _acquireMaterial).
      const materialOwner = { viewId: view.id, holderKey: `range:terrain-gpu:${view.id}:${this.budget}` };
      const stale = () => {
        if (this.contextEpoch !== epoch) throw new RangeAssetError('context-lost', `GPU context changed while preparing ${view.id}`);
        return signal?.aborted || cpuOwner.retired || this.residency?.cancelled.has(generation) || !isCurrent(generation);
      };
      const abortPreparation = () => windowWorker?.dispose();
      signal?.addEventListener('abort', abortPreparation, { once: true });
      try {
        if (stale()) throw new RangeAssetError('stale', `stale ${view.id}`);
        const THREE = this.THREE;
        const est = cpu.manifest.estimatedBytes?.[this.budget];
        const gpuKey = `range:terrain-gpu:${view.id}:${this.budget}`;
        // The verified material pack comes first: its rules place the trees,
        // which are placed on the CPU (a stable lattice) so their instance
        // buffers are counted in the same GPU reservation.
        mat = await this._acquireMaterial(view, { baseUrl, signal, owner: materialOwner });
        if (stale()) throw new RangeAssetError('stale', `stale ${view.id}`);
        const rules = { ...mat.pack.manifest.rules, ...(view.materialRules || {}) };
        const riverErrors = (view.rivers || []).flatMap(r => riverChannelErrors(r));
        if (riverErrors.length) throw new RangeAssetError('manifest', `${view.id}: ${riverErrors.join('; ')}`);
        const waterCheck = validateWaterRules(rules);
        if (!waterCheck.ok) throw new RangeAssetError('manifest', `material rules rejected for ${view.id}: ${waterCheck.errors.join('; ')}`);
        // Placement yields to the event loop as it goes: a view prepared
        // during playback must not freeze frames while its forest is laid.
        let rawWindow = null;
        const waterLevelM = view.riverPolicy?.terrainWater === 'mapped-only' ? null : waterLevel(cpu.data);
        const mirrorLevelM = mirrorLevelFor(cpu.data, waterLevelM);
        const windowOptions = { budget: this.budget, heightPx: this.budget === 'mobile' ? 720 : 1080,
          coverage: terrainWindowCoverage(opts.scenicViewport), coverageRevision: 0,
          pixelHeightPx: (this.pixelated ?? opts.pixelated) && !view.glacier ? (this.pixelHeightPx ?? opts.pixelHeightPx ?? null) : null,
          mirrorLevelM,
          protectedTileIds: view.tour ? tourSummitTiles(cpu.data, opts.tourData?.points) : [] };
        windowOptions.pixelProtectedTileIds = terrainPixelProtection(cpu.data, windowOptions.protectedTileIds);
        const buildOwner = { view, data: cpu.data, rules, windowOptions, cpuKey: cpu.key, gpuKey, materialKey: mat.key };
        if (view.tour) {
          workerKey = `range:tour-worker:${view.id}`;
          const tourBackings = new Set(['eye', 'target', 'fov', 'meta'].map(k => view.tour[k]?.buffer).filter(Boolean));
          const workerControlBytes = 1024 ** 2 + [...tourBackings].reduce((n, b) => n + b.byteLength, 0);
          const workerBytes = (typeof SharedArrayBuffer === 'undefined' ? terrainLaneBytes(cpu.data) : 0) + workerControlBytes;
          workerReservation = this.residency?.reserve({ key: workerKey, bytes: workerBytes,
            owner: 'range-tour-worker', generation: 0, evictable: false, protect: [cpu.key, mat.key] });
          if (this.residency && !workerReservation) throw new RangeAssetError('budget', 'No room for tour window worker');
          const shared = await shareTerrainLanes(cpu.data, { residency: this.residency, protect: [cpu.key, mat.key], signal, isCurrent: () => !stale() });
          if (stale()) throw new RangeAssetError('stale', `stale ${view.id}`);
          if (shared) this.residency?.shrink(workerKey, workerControlBytes);
          buildOwner.workerKey = workerKey;
          buildEntry = this._admitTerrainBuild(buildOwner, 0);
          windowReservation = buildEntry.reservation;
          windowWorker = new TerrainWindowWorker({ data: cpu.data, tour: view.tour, view, rules, seed: hashSeed(view.terrainSourceId || view.id) });
          if (workerReservation && !this.residency.commit(workerReservation, windowWorker, w => w.dispose())) throw new RangeAssetError('stale', 'Tour worker cancelled');
          rawWindow = await windowWorker.build(0, windowOptions, buildEntry.plan);
        } else buildEntry = this._admitTerrainBuild(buildOwner);
        const placed = rawWindow?.placed || await placeForestAsync(cpu.data, view, rules, { seed: hashSeed(view.terrainSourceId || view.id), signal });
        if (stale()) throw new RangeAssetError('stale', `stale ${view.id}`);
        if (!rawWindow) this._retireForestPlacement(buildOwner, buildEntry, placed);
        // CPU arrays stay on BufferAttributes after upload; charge both copies.
        // Instances plus the near conifer assets their batches build.
        const forestBytes = placed.count * 7 * 4 + forestAssetBytes() + FOREST_DETAIL_BYTES;
        // The surface build holds heights, spacing and RGBA (9 B/px).
        // Its temporary lanes retire before receiver construction (RGBA +
        // mask, 5 B/px). Upload drops both CPU texture copies; the view owns
        // the GPU textures, while this build peak is charged as scratch.
        const textureStride = view.tour ? (this.budget === 'mobile' ? 4 : 2) : 1;
        const gridPx = ((cpu.data.grid.width - 1) / textureStride + 1) * ((cpu.data.grid.height - 1) / textureStride + 1);
        const featureBudgetBytes = 2 * 3 * 768 * 6 * 4;
        // The bake's mesh estimate does not know the seam-fill index
        // buffers; their exact size is counted from the tile plan (no
        // geometry built), so the one reservation covers them and a view
        // that cannot fit is denied before the mesh is built.
        const fringeBytes = view.tour ? 0 : terrainFringeBytes(cpu.data, { budget: this.budget });
        // Baked horizon for terrain sun visibility (not for tour windows,
        // whose terrain streams; they keep the unshadowed key).
        const horizonOptions = { maxSize: this.budget === 'mobile' ? 192 : 256 };
        const horizonCost = view.tour || !cpu.data?.grid ? 0 : horizonBytes(cpu.data.grid, horizonOptions);
        const riverBound = 2 * riverGeometryBound(view, { maxVertices: RIVER_VERTICES_PER_SET });
        const bytes = (view.tour ? Math.ceil(gridPx * (4 * 4 / 3 + 1)) + featureBudgetBytes + 2 * ActorsGL.bytes()
          : 2 * ((est?.meshBytes || 0) + fringeBytes + forestBytes) + (est?.surfaceTextureBytes || 0) + gridPx + featureBudgetBytes + 2 * ActorsGL.bytes() + horizonCost) + 2 * riverBound;
        res = this.residency?.reserve({ key: gpuKey, bytes, owner: 'range-terrain-gpu', generation }) || null;
        if (this.residency && !res) throw new RangeAssetError('budget', `no GPU room for ${view.id}`);
        if (rawWindow) {
          const windowBytes = 2 * (Object.values(rawWindow.built.bands).reduce((n, b) => n + b.positions.byteLength + b.indices.byteLength + b.fringe.byteLength, 0) + forestBytes);
          if (windowBytes > buildEntry.bytes) throw new RangeAssetError('budget', 'Initial window exceeded admitted build bound');
          buildEntry.retainedBytes = windowBytes;
        }
        geos = createBandGeometries(THREE, cpu.data, { budget: this.budget, ...(rawWindow ? { built: rawWindow.built } : {}) });
        // Clip narrow mapped channels to the actual drawn triangles: the
        // same LOD, tile boundaries and no-data gaps, with a small depth lift.
        const riverOptions = { maxVertices: RIVER_VERTICES_PER_SET };
        const rivers = buildRiverGeometry(cpu.data, view, geos, riverOptions);
        const riverFringes = buildRiverGeometry(cpu.data, view, { geometries: geos.fringes }, riverOptions);
        for (const [destination, built] of [[riverGeometries, rivers], [riverFringeGeometries, riverFringes]]) for (const band of BANDS) {
          const raw = built.bands[band];
          if (!raw.indices.length) continue;
          const geometry = new THREE.BufferGeometry();
          destination[band] = geometry;
          geometry.setAttribute('position', new THREE.BufferAttribute(raw.positions, 3));
          geometry.setAttribute('river', new THREE.BufferAttribute(raw.river, 3));
          geometry.setAttribute('riverDirection', new THREE.BufferAttribute(raw.riverDirection, 2));
          for (const key of ['terrainA', 'terrainB', 'terrainC']) geometry.setAttribute(key, new THREE.BufferAttribute(raw[key], 3));
          geometry.setIndex(new THREE.BufferAttribute(raw.indices, 1));
          geometry.computeBoundingSphere();
        }
        const riverStats = { ...rivers.stats, fringeTriangles: riverFringes.stats.triangles,
          bytes: rivers.stats.bytes + riverFringes.stats.bytes };
        if (res && riverBound) this.residency.shrink(gpuKey, bytes - 2 * riverBound + 2 * riverStats.bytes);
        await yieldToMain();
        if (stale()) throw new RangeAssetError('stale', `stale ${view.id}`);
        const scratchKey = `range:surface-scratch:${view.id}`;
        const scratch = this.residency?.reserve({ key: scratchKey, bytes: gridPx * SURFACE_BUILD_BYTES_PER_PIXEL, owner: 'range-scratch', generation }) || null;
        if (this.residency && !scratch) throw new RangeAssetError('budget', `no room to build ${view.id} surface`);
        try {
          surface = await createSurfaceTextureAsync(THREE, cpu.data, { stride: textureStride, signal,
            checkCurrent: () => { if (stale()) throw new RangeAssetError('stale', `stale ${view.id}`); } });
          this.renderer?.initTexture?.(surface.texture);
          this.renderer?.initTexture?.(surface.receiverTexture);
        } finally { if (scratch) this.residency.release(scratchKey); }
        await yieldToMain();
        const base = terrainUniforms(THREE, cpu.data, surface);
        const uniforms = sceneUniforms(THREE, base);
        applyMaterial(uniforms, mat.pack, mat.textures, view.materialRules || {});
        uniforms.uDebugMask.value = this.debugMask || 0;
        if (horizonCost) {
          // Optional light: a failed bake leaves the key unshadowed, never
          // the view on legacy scenery.
          try {
            const bake = await bakeHorizonAsync(cpu.data, { ...horizonOptions, signal });
            if (stale()) throw new RangeAssetError('stale', `stale ${view.id}`);
            horizon = createHorizonTexture(THREE, bake);
            uniforms.uHorizon.value = horizon.texture;
            uniforms.uHorizonSize.value.set(bake.width, bake.height);
          } catch (err) {
            if (err instanceof RangeAssetError || signal?.aborted) throw err;
            console.warn(`[range v2] ${view.id}: horizon bake failed; direct light unshadowed`, err);
          }
        }
        material = createSceneMaterial(THREE, uniforms, { forestDebug: this.forestDebug, budget: this.budget,
          pixelated: this.pixelated ?? opts.pixelated ?? false,
          mappedWaterOnly: view.riverPolicy?.terrainWater === 'mapped-only',
          terrainShading: terrainShadingForView(this.terrainShading, view.id) });
        if (Object.keys(riverGeometries).length) {
          riverMaterial = createSceneMaterial(THREE, uniforms, { budget: this.budget, riverSurface: true,
            pixelated: this.pixelated ?? opts.pixelated ?? false });
          riverMaterial.depthFunc = THREE.LessEqualDepth;
          riverMaterial.depthWrite = false;
        }
        featureMaterial = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms,
          vertexShader: SCENE_VERT, fragmentShader: FEATURE_FRAG, transparent: true,
          depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth });
        depthMaterial = createDepthMaterial(THREE, uniforms);
        if (riverMaterial) riverDepthMaterial = createDepthMaterial(THREE, uniforms, { riverSurface: true });
        // The same pre-pass with each band's ownership colour (edge policy).
        ownershipMaterials = this._createOwnershipMaterials(uniforms, this.pixelated ?? opts.pixelated ?? false);
        if (riverMaterial) riverOwnershipMaterials = this._createOwnershipMaterials(uniforms, this.pixelated ?? opts.pixelated ?? false, true);
        await yieldToMain();
        if (stale()) throw new RangeAssetError('stale', `stale ${view.id}`);
        const meshes = {}, depthMeshes = {}, scenes = {};
        const depthScene = new THREE.Scene();
        for (const band of BANDS) {
          meshes[band] = new THREE.Mesh(geos.geometries[band], material);
          meshes[band].frustumCulled = false;
          scenes[band] = new THREE.Scene();
          scenes[band].add(meshes[band]);
          const hints = await terrainFeatureSegmentsAsync(geos.geometries[band].attributes.position.array,
            geos.geometries[band].index.array, { signal,
              checkCurrent: () => { if (stale()) throw new RangeAssetError('stale', `stale ${view.id}`); } });
          const fg = new THREE.BufferGeometry();
          fg.setAttribute('position', new THREE.BufferAttribute(hints, 3));
          featureGeometries[band] = fg;
          const ink = new THREE.LineSegments(fg, featureMaterial);
          ink.frustumCulled = false; ink.renderOrder = 2; ink.layers.set(3);
          scenes[band].add(ink);
          depthMeshes[band] = new THREE.Mesh(geos.geometries[band], depthMaterial);
          depthMeshes[band].frustumCulled = false;
          depthScene.add(depthMeshes[band]);
          if (riverGeometries[band]) {
            const river = new THREE.Mesh(riverGeometries[band], riverMaterial);
            river.frustumCulled = false;
            scenes[band].add(river);
            const depth = new THREE.Mesh(riverGeometries[band], riverDepthMaterial);
            depth.frustumCulled = false;
            riverDepthMeshes[band] = depth;
            depthScene.add(depth);
          }
        }
        // Seam fill: a nearer band's tiles that border a farther band also
        // draw in that farther pass (against the same depth pre-pass, so
        // only where they are the visible surface). The nearer pass covers
        // them; along the seam, where neither pass owned a pixel outright,
        // the farther partition is already the same ground instead of sky.
        // During travel a side draws its nearer bands only in some columns,
        // so there the fill draws from its own scene under the same scissor.
        const fringeMeshes = [], fringeTravel = [];
        for (let b = 1; b < BANDS.length; b++) {
          const g = geos.fringes?.[BANDS[b]];
          if (!g) continue;
          const fm = new THREE.Mesh(g, material);
          fm.frustumCulled = false;
          scenes[BANDS[b - 1]].add(fm);
          fringeMeshes.push(fm);
          const travel = new THREE.Mesh(g, material);
          travel.frustumCulled = false;
          const scene = new THREE.Scene();
          scene.add(travel);
          fringeTravel.push({ band: BANDS[b], pass: BANDS[b - 1], scene });
        }
        this._attachRiverFringes(riverFringeGeometries, riverMaterial, scenes, fringeMeshes, fringeTravel);
        material.depthFunc = THREE.LessEqualDepth;
        material.depthWrite = false;
        forest = createForest(THREE, placed, uniforms, { forestDebug: this.forestDebug });
        if (resolveRangeComposition(view)?.foreground === 'ledge') stageGL = new RockStageGL(THREE, { textures: mat.textures, palette: mat.pack.manifest.palette, rules });
        for (const band of BANDS) for (const m of forest.byBand[band]) scenes[band].add(m);
        for (const d of forest.depth) depthScene.add(d);
        // The cast: lanterns and swarms, moved between band scenes as they
        // travel. CastJobs.js reads this view's job from what the rail sees
        // (tours wander the routes RangeActors.js picks); the lights the
        // job leaves stand in the band that owns the ground under them.
        actors = new ActorsGL(THREE, uniforms);
        const castSeed = hashSeed(`${view.id}:cast`);
        const plan = castPlan(cpu.data, view, { waterLevelM, seed: castSeed });
        // Wandering routes cost a second terrain pass: only a view that
        // wanders gets them here (others build them only if ever needed).
        const routes = plan.job === 'wander' ? actorRoutes(cpu.data, view, { waterLevelM, seed: castSeed }) : null;
        const work = castWork(plan, { data: cpu.data, waterLevelM });
        for (const band of BANDS) scenes[band].add(actors.sites.meshes[band], actors.threads.meshes[band], actors.rope.meshes[band]);
        // Per-band depth scenes for travel frames, where a side's nearer
        // bands are drawn only in some columns (same geometry and material;
        // a mesh has one parent, so these are separate mesh objects).
        const depthScenes = {};
        for (const band of BANDS) {
          depthScenes[band] = new THREE.Scene();
          const dm = new THREE.Mesh(geos.geometries[band], depthMaterial);
          dm.frustumCulled = false;
          depthScenes[band].add(dm);
          if (riverGeometries[band]) {
            const riverDepth = new THREE.Mesh(riverGeometries[band], riverDepthMaterial);
            riverDepth.frustumCulled = false;
            depthScenes[band].add(riverDepth);
          }
          for (const d of forest.depthByBand?.[band] || []) depthScenes[band].add(d);
        }
        // Three's compile() creates programs but does not reject a failed
        // link. Check before publishing: otherwise trees draw over empty
        // terrain, while presentation incorrectly suppresses its fallback.
        // Every band (a band's trees may be absent from the far scene), the
        // cast (not parented until it first appears) and the rock stage.
        const gl = this.renderer.getContext();
        const targets = [...BANDS.map(band => [scenes[band]]), [depthScene],
          ...Object.values(actors.groups).map(group => [group, this.camera, scenes.far])];
        if (stageGL) targets.push([stageGL.scene, stageGL.camera]);
        const checked = new Set();
        // The ownership twins of the depth pre-pass link too (swapped in only
        // for multisampled pre-passes; a failed link must not appear later).
        if (ownershipMaterials) {
          const ownershipScene = new THREE.Scene();
          for (const band of BANDS) {
            const om = new THREE.Mesh(geos.geometries[band], ownershipMaterials[band]);
            om.frustumCulled = false; ownershipScene.add(om);
            if (riverGeometries[band]) {
              const riverOwner = new THREE.Mesh(riverGeometries[band], riverOwnershipMaterials[band]);
              riverOwner.frustumCulled = false; ownershipScene.add(riverOwner);
            }
          }
          targets.push([ownershipScene]);
        }
        for (const [scene, camera = this.camera, target = null] of targets) {
          for (const m of this.renderer.compile(scene, camera, target)) {
            if (checked.has(m)) continue;
            checked.add(m);
            for (const program of this.renderer.properties.get(m).programs.values()) {
              if (gl.getProgramParameter(program.program, gl.LINK_STATUS)) continue;
              if (gl.isContextLost()) throw new RangeAssetError('context-lost', `GPU context lost while compiling ${view.id}`);
              const log = shaderFailureLog(gl, program.program);
              throw new RangeAssetError('shader', `${view.id}: ${log}`);
            }
          }
        }
        const prepared = {
          view, generation, manifest: cpu.manifest, data: cpu.data, identity: cpu.identity, tourCpuKey: opts.tourCpuKey,
          surface, uniforms, material, depthMaterial, ownershipMaterials, horizon, depthBandMeshes: depthMeshes, geometries: geos.geometries, fringes: geos.fringes, fringeMeshes, fringeTravel, scenes, depthScene, depthScenes,
          riverMaterial, riverDepthMaterial, riverOwnershipMaterials, riverGeometries, riverFringeGeometries, riverDepthMeshes, riverStats,
          forest, stageGL, featureGeometries, featureMaterial,
          stats: { ...geos.stats, trees: forest.counts, featureBytes: featureBudgetBytes }, gpuKey, cpuKey: cpu.key, cpuOwner,
          rules, waterLevelM, mirrorLevelM, materialKey: mat.key, materialOwner, actors, actorRoutes: routes, castSeed, castPlan: plan, castWork: work,
        };
        if (windowWorker) {
          prepared.windowWorker = windowWorker;
          this.residency?.retag(workerKey, generation);
          prepared.workerKey = workerKey;
          prepared.workerReservation = workerReservation;
          prepared.windowOptions = windowOptions;
          prepared.windowPlans = buildOwner.windowPlans;
          initialWindow = this._tourWindowResource(prepared, 0, geos, forest, windowReservation?.key, false, windowReservation);
          initialWindow.detail = rawWindow.plan;
          rawWindow.placed = null;
          this.residency?.shrink(buildEntry.key, buildEntry.retainedBytes);
          if (windowReservation && !this.residency.commit(windowReservation, initialWindow, w => w.destroy())) throw new RangeAssetError('stale', 'Initial window cancelled');
          if (windowReservation) {
            this.residency.retag(buildEntry.key, generation);
            this.residency.entries.get(buildEntry.key).evictable = true;
          }
          prepared.windowCache = new TourWindowCache({ build: index => this._buildTourWindow(prepared, index),
            canRetry: index => this._canRetryTerrainBuild(prepared, index), isDisplayed: window => window === prepared.activeWindow });
          prepared.windowCache.resident.set(0, initialWindow);
          prepared.windowIndex = 0;
          prepared.activeWindow = initialWindow;
        }
        if (stale()) throw new RangeAssetError('stale', `stale ${view.id}`);
        // Eviction (or any release) of the GPU entry also retires the view
        // from the cache, so no frame can draw disposed resources.
        if (res && !this.residency.commit(res, prepared, (p) => this._retire(view.id, p))) {
          throw new RangeAssetError('stale', `generation ${generation} cancelled during ${view.id}`);
        }
        this.prepared.set(view.id, prepared);
        published = true;
        if (!view.tour) this.residency?.releaseReservation(buildEntry?.reservation);
        return prepared;
      } catch (err) {
        if (!published) {
          if (workerReservation) this.residency?.releaseReservation(workerReservation);
          if (!this.residency) windowWorker?.dispose();
          if (res) this.residency.releaseReservation(res);
          if (mat) this._releaseMaterial(view.id, materialOwner);
          // The decoded terrain is only worth its ledger charge to a view
          // that publishes.
          cpuOwner.release?.();
          if (!initialWindow) forest?.dispose();
          actors?.dispose();
          stageGL?.dispose();
          material?.dispose();
          riverMaterial?.dispose();
          riverDepthMaterial?.dispose();
          for (const m of Object.values(riverOwnershipMaterials || {})) m.dispose();
          for (const g of Object.values(riverGeometries)) g.dispose();
          for (const g of Object.values(riverFringeGeometries)) g.dispose();
          depthMaterial?.dispose();
          for (const m of Object.values(ownershipMaterials || {})) m.dispose();
          horizon?.texture?.dispose();
          featureMaterial?.dispose();
          for (const g of Object.values(featureGeometries)) g.dispose();
          surface?.texture?.dispose();
          surface?.receiverTexture?.dispose();
          if (!initialWindow) for (const g of Object.values(geos?.geometries || {})) g.dispose();
          if (!initialWindow) for (const g of Object.values(geos?.fringes || {})) g.dispose();
          this.residency?.releaseReservation(buildEntry?.reservation);
        }
        throw err;
      } finally {
        signal?.removeEventListener('abort', abortPreparation);
      }
    })();
    this.pending.set(view.id, { generation, job });
    job.finally(() => { if (this.pending.get(view.id)?.job === job) this.pending.delete(view.id); }).catch(() => {});
    return job;
  }

  /** A prepared view's GPU entry was released (evicted, cancelled or
   *  explicitly): drop it from the cache and free what it holds. */
  _retire(viewId, p) {
    if (this.shaftViews?.includes(viewId)) this.releaseShafts();
    if (this.prepared.get(viewId) === p) {
      this.prepared.delete(viewId);
      if (!p.cpuOwner && !this._cpuKeyInUse(p.cpuKey)) this.residency?.release(p.cpuKey);
      if (!p.materialOwner) this._releaseMaterial(viewId);
    }
    // Only this preparation's own hold: a replacement under the same view
    // id keeps its material.
    if (p.materialOwner) this._releaseMaterial(viewId, p.materialOwner);
    p.cpuOwner?.release?.();
    this._disposePrepared(p);
  }

  /** Depth pre-pass for one pass of a travel side: the pass's band and the
   *  farther ones across the whole width, each nearer band only inside its
   *  [x0, x1] columns (fractions of the width), or not at all. */
  _travelDepth(p, target, pass, bandColumns, { clear = true } = {}) {
    const r = this.renderer;
    const at = BANDS.indexOf(pass);
    const { width: W, height: H } = target;
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    if (clear) r.clear(true, true, false);
    BANDS.forEach((band, i) => {
      if (i <= at) { r.render(p.depthScenes[band], this.camera); return; }
      const cols = bandColumns[band];
      if (!cols) return;
      const x0 = Math.max(0, Math.floor(cols[0] * W)), x1 = Math.min(W, Math.ceil(cols[1] * W));
      if (!(x1 > x0)) return;
      target.scissor.set(x0, 0, x1 - x0, H);
      target.scissorTest = true;
      r.setRenderTarget(target);
      r.render(p.depthScenes[band], this.camera);
      target.scissorTest = false;
      r.setRenderTarget(target);
    });
    this.stats.depthPasses++;
  }

  /** Channels need the same seam fill and scoped travel as the ground
   * below them: their depth pre-pass must not punch a hole in the fill. */
  _attachRiverFringes(geometries, material, scenes, meshes, travel) {
    for (let b = 1; b < BANDS.length; b++) {
      const band = BANDS[b], geometry = geometries[band];
      if (!geometry) continue;
      const mesh = new this.THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      scenes[BANDS[b - 1]].add(mesh);
      meshes.push(mesh);
      const scoped = travel.find(f => f.band === band && f.pass === BANDS[b - 1]);
      if (scoped) {
        const copy = new this.THREE.Mesh(geometry, material);
        copy.frustumCulled = false;
        scoped.scene.add(copy);
      }
    }
  }

  /** A travel side's seam fill for one pass: each nearer band's border
   *  tiles, inside that band's own columns only. */
  _travelFringe(p, target, pass, bandColumns) {
    const r = this.renderer;
    const { width: W, height: H } = target;
    for (const f of p.fringeTravel || []) {
      const cols = f.pass === pass && bandColumns[f.band];
      if (!cols) continue;
      const x0 = Math.max(0, Math.floor(cols[0] * W)), x1 = Math.min(W, Math.ceil(cols[1] * W));
      if (!(x1 > x0)) continue;
      target.scissor.set(x0, 0, x1 - x0, H);
      target.scissorTest = true;
      r.setRenderTarget(target);
      r.render(f.scene, this.camera);
      target.scissorTest = false;
      r.setRenderTarget(target);
    }
  }

  /** Keep what the current frame draws resident: its view's GPU, CPU and
   *  material entries and the two render targets. */
  pinView(viewIds, extraKeys = []) {
    if (!this.residency) return;
    const keys = ['range:render-target', 'range:ground-target', 'range:render-target-B', ...extraKeys];
    for (const id of [].concat(viewIds)) {
      const p = this.prepared.get(id);
      if (p) keys.push(p.gpuKey, p.cpuKey, p.materialKey, p.workerKey, p.tourCpuKey, p.activeWindow?.key);
    }
    this.residency.pin(keys);
  }

  /** One GPU copy per material pack, shared by the views that use it. Its
   *  declared footprint is reserved before any image is decoded, and views
   *  that ask for the same pack concurrently share one load.
   *
   *  Ownership: each consumer passes an `owner` token (a preparation). The
   *  token is recorded as a user and holds a ledger retention lease, so a
   *  pack a cached view still draws is never evicted under pressure. A
   *  cache hit must be the ledger's live resource; an entry the ledger
   *  released is gone from the cache, and its remaining users are retired
   *  rather than left drawing disposed textures. Cancelling one consumer
   *  never cancels the shared fetch for the others; the fetch aborts when
   *  no consumer is left, and a late completion of an abandoned load never
   *  replaces a newer one. */
  async _acquireMaterial(view, { baseUrl, signal, owner = null } = {}) {
    const url = new URL(view.materialManifestUrl, baseUrl).href;
    const token = owner || { viewId: view.id };
    // A finished load can be released by ledger pressure before this
    // continuation runs; look again, a bounded number of times.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw new RangeAssetError('aborted', `material for ${view.id} aborted`);
      const hit = this._liveMaterial(url);
      if (hit) return this._adoptMaterial(hit, view.id, token);
      const load = this.materialLoads.get(url) || this._startMaterialLoad(url, view);
      const entry = await this._awaitMaterialLoad(load, signal, view.id);
      if (this._liveMaterial(url) === entry) return this._adoptMaterial(entry, view.id, token);
    }
    throw new RangeAssetError('budget', `material for ${view.id} was released while loading`);
  }

  /** The cached pack at `url`, only while the ledger still owns it. */
  _liveMaterial(url) {
    const entry = this.materials.get(url);
    if (!entry) return null;
    if (entry.dead || (this.residency && this.residency.get(entry.key) !== entry)) {
      this.materials.delete(url);
      return null;
    }
    return entry;
  }

  _adoptMaterial(entry, viewId, token) {
    if (!entry.users.has(token)) {
      entry.users.set(token, viewId);
      token.lease = this.residency?.retain(entry.key, token.holderKey) || null;
    }
    return entry;
  }

  _startMaterialLoad(url, view) {
    const controller = new AbortController();
    const load = { url, controller, consumers: 0, settled: false, closed: false, res: null };
    load.promise = (async () => {
      const pack = await loadMaterialPack(url, {
        signal: controller.signal, expectSha256: view.materialManifestSha256 || null,
        onManifest: (manifest) => {
          if (load.closed) throw new RangeAssetError('aborted', `material ${manifest.id} abandoned`);
          load.res = this.residency?.reserve({ key: `range:material:${manifest.id}`, bytes: materialGpuBytes(manifest), owner: 'range-material', generation: 0 }) || null;
          if (this.residency && !load.res) throw new RangeAssetError('budget', `no room for material ${manifest.id}`);
        },
      }).catch((err) => { if (load.res) this.residency.releaseReservation(load.res); throw err; });
      const textures = createMaterialTextures(this.THREE, pack);
      const entry = { url, pack, textures, key: `range:material:${pack.manifest.id}`, users: new Map(), reservation: load.res, dead: false };
      entry.dispose = () => {
        if (entry.dead) return;
        entry.dead = true;
        textures.dispose();
        for (const img of pack.images.values()) img.close?.();
        if (this.materials.get(url) === entry) this.materials.delete(url);
        // Released by the ledger (explicitly or by a cancellation) while
        // views still use it: those views go too, never drawing dead
        // textures. Each retirement is matched to its own preparation.
        for (const token of [...entry.users.keys()]) this._retireMaterialUser(entry, token);
      };
      if (load.closed) {
        if (load.res) this.residency.releaseReservation(load.res);
        entry.dispose();
        throw new RangeAssetError('aborted', `material ${pack.manifest.id} abandoned while loading`);
      }
      if (load.res && !this.residency.commit(load.res, entry, entry.dispose)) {
        throw new RangeAssetError('stale', `material ${pack.manifest.id} released while loading`);
      }
      this.materials.set(url, entry);
      return entry;
    })();
    load.promise.then(() => { load.settled = true; }, () => { load.settled = true; });
    this.materialLoads.set(url, load);
    load.promise.finally(() => { if (this.materialLoads.get(url) === load) this.materialLoads.delete(url); }).catch(() => {});
    return load;
  }

  /** One consumer's wait on a shared load. Its own abort rejects only this
   *  wait; the last consumer to leave an unfinished load abandons it. */
  _awaitMaterialLoad(load, signal, viewId) {
    if (signal?.aborted) return Promise.reject(new RangeAssetError('aborted', `material for ${viewId} aborted`));
    load.consumers++;
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      load.consumers--;
      if (load.consumers === 0 && !load.settled) this._abandonMaterialLoad(load);
    };
    return new Promise((resolve, reject) => {
      const onAbort = () => { leave(); reject(new RangeAssetError('aborted', `material for ${viewId} aborted`)); };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      load.promise.then(
        (entry) => { signal?.removeEventListener?.('abort', onAbort); leave(); resolve(entry); },
        (err) => { signal?.removeEventListener?.('abort', onAbort); leave(); reject(err); });
    });
  }

  _abandonMaterialLoad(load) {
    load.closed = true;
    if (this.materialLoads.get(load.url) === load) this.materialLoads.delete(load.url);
    // Frees the key now, so a new load can reserve it; this load's late
    // commit then finds a different reservation and disposes its own work.
    if (load.res) this.residency?.releaseReservation(load.res);
    try { load.controller.abort(); } catch { /* best effort */ }
  }

  /** The ledger released `entry` while `token` still used it. */
  _retireMaterialUser(entry, token) {
    const viewId = entry.users.get(token);
    entry.users.delete(token);
    token.lease?.();
    token.lease = null;
    const p = this.prepared?.get(viewId);
    if (p && p.materialOwner === token) this.release(viewId);
  }

  /** Return one preparation's hold (`owner`), or with no owner every hold
   *  under `viewId`. A pack nobody holds is released. */
  _releaseMaterial(viewId, owner = null) {
    for (const [url, m] of [...this.materials]) {
      for (const [token, id] of [...m.users]) {
        if (owner ? token !== owner : id !== viewId) continue;
        m.users.delete(token);
        token.lease?.();
        token.lease = null;
      }
      if (!m.users.size) {
        if (this.materials.get(url) === m) this.materials.delete(url);
        if (this.residency) {
          if (!this.residency.releaseReservation(m.reservation ?? { key: m.key })) m.dispose?.();
        } else m.dispose ? m.dispose() : m.textures.dispose();
      }
    }
  }

  prepareFrameCoverage(view, frame) {
    const p = this.prepared.get(view.id);
    if (!p?.windowCache) return true;
    this.movedPose(view, frame, p);
    return p.windowCoverage?.covered === true;
  }

  _disposePrepared(p) {
    p.featureMaterial?.dispose();
    for (const g of Object.values(p.featureGeometries || {})) g.dispose();
    p.windowCache?.dispose();
    // An accepted replacement can be resident before the next render has
    // detached the displayed mesh. Its ownership still belongs to this view.
    if (p.windowCache) p.activeWindow?.dispose();
    for (const entry of p.rawAhead?.values() || []) this._dropTourRaw(entry);
    p.rawAhead?.clear();
    if (p.workerKey && this.residency) this.residency.releaseReservation(p.workerReservation || { key: p.workerKey }); else p.windowWorker?.dispose();
    if (!p.windowCache) p.forest?.dispose();
    p.actors?.dispose();
    p.stageGL?.dispose();
    if (!p.windowCache) for (const g of Object.values(p.geometries || {})) g.dispose();
    if (!p.windowCache) for (const g of Object.values(p.fringes || {})) g.dispose();
    p.surface?.texture?.dispose();
    p.surface?.receiverTexture?.dispose();
    p.material?.dispose();
    p.riverMaterial?.dispose();
    p.riverDepthMaterial?.dispose();
    for (const m of Object.values(p.riverOwnershipMaterials || {})) m.dispose();
    for (const g of Object.values(p.riverGeometries || {})) g.dispose();
    for (const g of Object.values(p.riverFringeGeometries || {})) g.dispose();
    p.depthMaterial?.dispose();
    for (const m of Object.values(p.ownershipMaterials || {})) m.dispose();
    p.horizon?.texture?.dispose();
  }

  /** Release one view's GPU and CPU ownership. */
  release(viewId) {
    if (this.shaftViews?.includes(viewId)) this.releaseShafts();
    const p = this.prepared.get(viewId);
    if (!p) return;
    this.prepared.delete(viewId);
    this.residency?.release(p.gpuKey); // disposes via the committed dispose
    if (p.cpuOwner) p.cpuOwner.release();
    else if (!this._cpuKeyInUse(p.cpuKey)) this.residency?.release(p.cpuKey);
    if (!this.residency) this._disposePrepared(p);
    this._releaseMaterial(viewId, p.materialOwner || null);
  }

  /** A source view and its composition variants share one CPU terrain
   *  entry (RangeAssets.prepareTerrainAssets). Owned holds release their own
   *  lease; an unowned release must not retire terrain another prepared view
   *  still draws. */
  _cpuKeyInUse(cpuKey) {
    for (const q of this.prepared.values()) if (q.cpuKey === cpuKey) return true;
    return false;
  }

  /** Camera for this frame: the view's rail pose, projected onto the whole
   *  padded scenic stage so the Canvas transform (zoom, shake, roll) applies
   *  once when the partition is composited. */
  /** Ground height the camera must clear: the DEM plus a glacier view's
   *  ice at this frame's retreat, as TerrainMaterial raises it. */
  _renderedGround(view, frame, data) {
    const ice = view.glacier, retreat01 = frame.glacier?.retreat01 ?? 0;
    return (x, z) => {
      const bed = terrainHeightAt(data, x, z);
      return ice ? glacierSample(ice, x, z, bed, retreat01).surfaceM : bed;
    };
  }

  /** This frame's camera for a view: the rail pose, the lens, and the pose
   *  after the section move and the listener's zoom, lifted clear of the
   *  rendered ground. Computed once per frame and view and shared by the
   *  partition passes and the sky (RangePresentation._skyPan). */
  movedPose(view, frame, p = this.prepared.get(view.id) || null) {
    if (p?.windowCache) this._updateTourCoverage(p, frame);
    const baseRail = scenePoseAt(view, { progress01: view.glacier ? (frame.glacier?.journey01 ?? frame.progress01) : frame.progress01, timeMs: frame.timeMs,
      tour: p?.cameraTour || view.tour });
    const rail = { ...baseRail, fovYDeg: applyLensFov(baseRail.fovYDeg, frame.cameraEffects) };
    const proj = scenicProjection(rail.fovYDeg, frame.scenicViewport);
    // This view's VISIBLE frustum (the overscan margin excluded): the
    // pointer is normalised against the visible stage, and the zoom must
    // stay inside this view's own cone from its very first frame.
    const vp = frame.scenicViewport, m = vp.overscanPx || 0;
    const visW = Math.max(1, vp.logicalWidth - 2 * m), visH = Math.max(1, vp.logicalHeight - 2 * m);
    const tanY = Math.tan((proj.fovYDeg * Math.PI) / 360) * (visH / vp.logicalHeight), tanX = tanY * (visW / visH);
    // Cinematic section moves and the listener's zoom (RangeCamera.js),
    // computed once per frame and view: the partition passes reuse it.
    let poses = this._movedPoses.get(frame);
    if (!poses) this._movedPoses.set(frame, poses = new Map());
    let pose = poses.get(view.id);
    if (!pose) {
      pose = applyCameraMoves(rail, frame.cameraMove, frame.userCamera, {
        heightAt: p?.data ? this._renderedGround(view, frame, p.data) : null, waterLevelM: p?.waterLevelM,
        sampleStepM: p?.data?.grid?.cellSizeM, cone: { tanX, tanY },
        heightRangeM: p?.uniforms ? [p.uniforms.uHeightRange.value.x, p.uniforms.uHeightRange.value.y] : null,
        zoomMode: 'projection' });
      poses.set(view.id, pose);
      this._ensureTourWindow(p, frame.timeMs, { pose, proj });
    }
    return { rail, proj, pose, tanX, tanY };
  }

  _setCamera(view, frame, p = null) {
    const { proj, pose, tanX, tanY } = this.movedPose(view, frame, p);
    const cam = this.camera;
    if (frame.userCamera) rangeUserCamera.noteFrame({ tanX, tanY, userScale: pose.userScale, frameId: frame.frameId });
    cam.fov = proj.fovYDeg;
    cam.aspect = proj.aspect;
    cam.position.set(pose.eyeM[0], pose.eyeM[1], pose.eyeM[2]);
    cam.up.set(0, 1, 0);
    cam.lookAt(pose.targetM[0], pose.targetM[1], pose.targetM[2]);
    cam.clearViewOffset();
    if (pose.viewOffset) {
      const { fx, rx, uy } = pose.viewOffset;
      const fullY = Math.tan(cam.fov * Math.PI / 360), fullX = fullY * cam.aspect;
      const { logicalWidth: width, logicalHeight: height } = frame.scenicViewport;
      cam.setViewOffset(width, height, (fx + rx / fullX) * width / 2,
        (fx - uy / fullY) * height / 2, (1 - fx) * width, (1 - fx) * height);
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    return pose;
  }

  /** Per-frame uniforms: light from where the celestial is drawn, sky and
   *  air colours from the frame, the shared deformation. */
  _setFarForest(p, frame) {
    const drawn = !p.activeWindow?.coarse && (frame.narrative?.materials ?? 1) > .01
      && Object.values(p.forest?.counts || {}).some(count => count > 0);
    p.uniforms.uFarForest.value.set(drawn ? 6500 : 0, drawn ? 7800 : 0,
      p.rules?.treeScale ?? RULE_DEFAULTS.treeScale, rangeQuality(frame.qualityLevel).level + (p.view.tour ? 8 : 0));
    p.uniforms.uForestSeed.value = hashSeed(p.view.terrainSourceId || p.view.id) >>> 0;
  }

  /** Per-scene scratch: uniform code allocates nothing per frame. */
  _scratch() {
    const THREE = this.THREE;
    return this._scratchState ||= { v3: new THREE.Vector3(), color: new THREE.Color(), color2: new THREE.Color(),
      wind: new Float32Array(2) };
  }

  _setUniforms(p, frame) {
    const THREE = this.THREE;
    const u = p.uniforms;
    const n = frame.narrative;
    // Scoped receiver calibration for the retained Black static scenic scene.
    // Receiver irradiance changes before albedo/AO; sky, key and water do not.
    u.uReceiverFillMin.value = p.view.id === 'black-mountains-catawba'
      && !p.view.tour && p.view.cameraPaths?.some(line => line?.length) ? .32 : 0;
    this._setFarForest(p, frame);
    u.uNarrative.value.set(n?.relief ?? 1, n?.atmosphere ?? 1, n?.materials ?? 1, n?.features ?? 1);
    u.uNarrativeInk.value = n ? (1 - n.materials) * (1 - n.skyDark) : 0;
    applyGlacierUniforms(u, p.view.glacier, frame.glacier);
    const m = calibrateRangeMusic(frame.music, { view: p.view, progress01: frame.progress01,
      heightRange: [u.uHeightRange.value.x, u.uHeightRange.value.y], nominalHeight: frame.scenicViewport?.nominalHeight || 720 });
    u.uDeformAmp.value = m.amplitudeM;
    u.uDeformKick.value = m.kickM;
    u.uDeformGesture.value = m.gestureM;
    u.uDeformMelodic.value = m.melodicM;
    u.uDeformStructural.value = m.structuralM;
    u.uMelodyK.value = m.melodyK;
    u.uMelodyDir.value.set(...m.melodyDir);
    u.uMelodyPhase.value = m.melodyPhaseRad;
    u.uDeformK.value = m.waveK;
    u.uDeformDir.value.set(m.waveDir[0], m.waveDir[1]);
    u.uDeformPhase.value = m.phaseRad;
    u.uTime.value = frame.timeMs / 1000;
    m.gusts.forEach((g, i) => { u.uGustAge.value[i] = g.ageSec; u.uGustAmp.value[i] = g.amp01 * (1 + (frame.storm?.amount || 0) * .8); u.uGustDir.value[i] = g.dir; });
    syncGustUniforms(u);
    syncWaterMusicUniforms(u, frame.effects);
    const rung = rangeQuality(frame.qualityLevel);
    u.uForestKeep.value = rung.forestKeep;
    // Trees show with the narrative's materials; the detail ring shows one
    // of its two representations (RangeQuality nearDetail).
    const treesShown = !n || n.materials > .01;
    if (p.forest?.applyVisibility) p.forest.applyVisibility({ shown: treesShown, nearDetail: rung.nearDetail });
    else {
      for (const objects of Object.values(p.forest?.byBand || {})) for (const tree of objects) tree.visible = treesShown;
      for (const tree of p.forest?.depth || []) tree.visible = treesShown;
      for (const objects of Object.values(p.forest?.depthByBand || {})) for (const tree of objects) tree.visible = treesShown;
    }
    const c = frame.light.celestial;
    // Unproject the celestial's stage position into a world direction.
    const ndcX = c.xFrac * 2 - 1, ndcY = 1 - c.yFrac * 2;
    const dir = c.worldDirection ? new THREE.Vector3(...c.worldDirection) : new THREE.Vector3(ndcX, ndcY, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    u.uLightDir.value.copy(dir.normalize());
    const night = frame.light.night01;
    const storm = frame.storm || { amount: 0, flash: 0, wet01: 0, break01: 0 };
    const cinematic = cinematicLightingProfile({ enabled: this.cinematicPixel, night01: night, storm01: storm.amount });
    u.uCinematic.value.set(...cinematic.light);
    u.uCinematicAir.value.set(...cinematic.air);
    const strength = c.body ? c.intensity : 0;
    hexToLinear(THREE, c.colorHex, u.uLightColor.value).multiplyScalar(strength);
    // Receiver fill fades once; sky radiance also feeds air and water's
    // reflection, so it keeps the frame's authored environment colors.
    const ambient = frame.light.ambientMultiplier ?? 1;
    const visibility = v => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    const bodies = frame.light.state;
    // Keep moonlit receivers readable with the existing sheltered fill.
    // Existing horizon visibility blends the handoff while daylight and true gaps keep their fill.
    // An authored Landscape moon is lit only as far as its disc shows (discAlpha).
    const moon = bodies?.moon;
    const moonShare = visibility(night) * visibility(moon?.discAlpha ?? moon?.visibility) * (1 - visibility(bodies?.sun?.visibility));
    u.uMoonAmbientScale.value = 2.5 * .65 * (1 - ambient) * moonShare;
    u.uAmbientScale.value = 2.5 * ambient + u.uMoonAmbientScale.value;
    u.uStorm.value.set(storm.amount, storm.flash, storm.break01, storm.wet01);
    // Under the squall the sun is gone behind the deck; the sky's own
    // (darkened, below) radiance is most of what lights the land.
    u.uLightColor.value.multiplyScalar(1 - storm.amount * .92);
    u.uLightColor.value.add(new THREE.Color(.65, .77, 1).multiplyScalar(storm.flash * 1.6));
    u.uAmbientScale.value *= 1 - storm.amount * .15;
    u.uMoonAmbientScale.value *= 1 - storm.amount * .15;
    // Lightning lights the land from inside the deck, where the sky draws it.
    // The rain veil projects through the main camera on every view, mirror or not.
    u.uViewProj.value.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const skyPan = this.skyPan || { x: 0, y: 0 };
    u.uRainShift.value = (skyPan.x || 0) / 2;
    // Rain curtains are world-anchored (STORM_GLSL rainVeil); the seed is
    // the sky's (drawStormSky's song seed), so land and sky hang the same.
    if (u.uRainSeed) u.uRainSeed.value = rainSeed01(frame.seed ?? 0);
    if (storm.flash > 0) {
      const at = flashScreenPoint(storm, skyPan, 1, 1);
      const flashDir = this._scratch().v3.set(at.x * 2 - 1, 1 - at.y * 2, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
      u.uLightDir.value.lerp(flashDir, Math.min(1, storm.flash * 3)).normalize();
    }
    u.uSolarTransmission.value = c.body === 'sun' && strength > 0 ? .18 : 0;
    if (frame.light.sky) {
      hexToLinear(THREE, frame.light.sky.top, u.uSkyZenith.value).multiplyScalar(0.9);
      hexToLinear(THREE, frame.light.sky.horizon, u.uSkyHorizon.value).multiplyScalar(0.9);
      hexToLinear(THREE, frame.light.sky.air || frame.light.sky.horizon, u.uAirColor.value);
    }
    if (frame.motif) {
      // A restrained, steady colour recipe marks repeated verses/choruses.
      // Environment tint stays separate from the resolved physical body
      // color. Air, mist and reflected sky share the same recipe.
      const tone = new THREE.Color().setHSL(frame.motif.hueDeg / 360, .65, .65);
      const tint = new THREE.Color(1, 1, 1).lerp(tone, frame.motif.intensity01);
      u.uSkyZenith.value.multiply(tint);
      u.uSkyHorizon.value.multiply(tint);
      u.uAirColor.value.multiply(tint);
    }
    u.uAirDensity.value = (1 / 55000) * (1 + 0.6 * night) * (p.rules?.airScale ?? RULE_DEFAULTS.airScale);
    if (storm.amount > 0 || storm.break01 > 0) {
      // Slate storm light in the sky, the air and the water's reflection;
      // thick rain air under the squall, then rain-washed clarity after it.
      const k = storm.amount * .95, row = stormKindRow(storm);
      u.uSkyZenith.value.lerp(row.zenith, k);
      u.uSkyHorizon.value.lerp(row.horizon, k);
      u.uAirColor.value.lerp(row.air, k).add(this._scratch().color.setRGB(.65, .77, 1).multiplyScalar(storm.flash * .35));
      u.uAirDensity.value *= 1 + storm.amount * .6 - storm.break01 * .35;
    }
    // Valley mist: anchored at the view's water level, thicker in calm.
    const mp = mistParams({ rules: p.rules, waterLevelM: p.waterLevelM, heightRange: [u.uHeightRange.value.x, u.uHeightRange.value.y],
      tSec: frame.timeMs / 1000, calm01: 1 - (frame.music?.groove ?? 0),
      sea01: frame.cloudSea01 ?? 0, cameraY: this.camera.position.y });
    const quality = rangeQuality(frame.qualityLevel);
    const cameraTour = p.view.tour || p.cameraTour;
    if (cameraTour) {
      // The ceiling follows the route continuously, and the fog thins out
      // as it closes on the valley floor instead of switching off.
      const routeCap = tourMistCap((t) => cameraTour.poseAt(t), frame.timeMs, cameraTour.durationMs);
      mp.topM = Math.min(mp.topM, this.camera.position.y - 120, routeCap);
      const fade = tourMistFade(mp.topM, mp.baseM);
      mp.fill *= fade; mp.density *= fade;
    }
    // The score thins and lights the mist (atmosphereMusic; neutral when silent).
    const am = atmosphereMusic(frame.effects);
    u.uMistDensity.value = mp.density * (n?.atmosphere ?? 1) * am.mistDensityMul;
    // A rung change eases the fog's sampling over heard time (seek snaps).
    const dtSec = (frame.timeMs - (p.mistEaseAtMs ?? -Infinity)) / 1000;
    p.mistSteps = easeMistSteps(p.mistSteps, quality.mistSteps, dtSec);
    p.mistEaseAtMs = frame.timeMs;
    u.uMistSteps.value = p.mistSteps;
    u.uMistBase.value = mp.baseM;
    u.uMistHeight.value = mp.heightM;
    u.uMistTime.value = mp.tSec;
    mistDrift(mp.tSec).forEach((d, i) => u.uMistDrift.value[i].set(d[0], d[1]));
    u.uMistTop.value = mp.topM;
    u.uMistFill.value = mp.fill;
    // Lit mist: the air's colour lifted toward the key light (display domain).
    u.uMistColor.value.copy(u.uAirColor.value).multiplyScalar(1.2)
      .add(this._scratch().color2.copy(u.uLightColor.value).multiplyScalar(0.06 + am.mistGlow));
    u.uMistColor.value.r = Math.min(0.9, u.uMistColor.value.r);
    u.uMistColor.value.g = Math.min(0.9, u.uMistColor.value.g);
    u.uMistColor.value.b = Math.min(0.9, u.uMistColor.value.b);
    u.uCameraPos.value.copy(this.camera.position);
    u.uTourEnabled.value = p.view.tour || p.cameraTour ? 1 : 0;
    u.uTourEye.value.copy(this.camera.position);
    this._setCloudUniforms(p, frame);
    this._setActors(p, frame);
  }

  /** The key light through the sky's clouds (CloudOcclusion). A painted
   *  legacy sky (skyClouds) keeps its moon-only puffs in mode 0; otherwise
   *  the fair-weather banks the high-resolution sky draws cast world-plane
   *  shadows (mode 1) where the rung allows and the light is up. Pure in
   *  heard time and the song seed, so seeks match continuous play. */
  _setCloudUniforms(p, frame) {
    const u = p.uniforms;
    if (!u.uCloudCount) return;
    const c = frame.light?.celestial;
    u.uMoonClouds.value = c?.body === 'moon' ? 1 : 0;
    u.uCloudCount.value = 0;
    if (u.uCloudMode) u.uCloudMode.value = 0;
    if (u.uCloudStrength) u.uCloudStrength.value = 0;
    if (this.skyClouds) {
      if (!u.uMoonClouds.value) return;
      const e = this.camera.matrixWorld.elements;
      const eyeM = this.camera.position.toArray();
      const pose = { eyeM, targetM: [eyeM[0] - e[8], eyeM[1] - e[9], eyeM[2] - e[10]], fovYDeg: this.camera.fov, view: this.camera.view };
      const puffs = cloudPuffs(this.skyClouds.banks, { ...this.skyClouds.options, pose });
      u.uCloudRight.value.set(e[0], e[1], e[2]); u.uCloudUp.value.set(e[4], e[5], e[6]); u.uCloudForward.value.set(-e[8], -e[9], -e[10]);
      u.uCloudCount.value = puffs.length;
      for (let i = 0; i < puffs.length; i++) {
        const puff = puffs[i];
        u.uCloudCenterRadius.value[i].set(puff.centerM[0], puff.centerM[1], puff.centerM[2], puff.radiusXM);
        const shape = u.uCloudShape.value[i >> 1], component = (i % 2) * 2;
        shape.setComponent(component, puff.radiusYM).setComponent(component + 1, puff.opacity);
      }
      return;
    }
    const light = u.uLightDir?.value;
    if (!u.uCloudMode || !light || !c?.body || !rangeQuality(frame.qualityLevel).cloudShadows || !(light.y > .05)) return;
    const unit = v => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    const visible = unit(c.body === 'moon' ? (frame.light.state?.moon?.discAlpha ?? c.visibility ?? 1) : (c.visibility ?? 1));
    const strength = CLOUD_SHADOW_MAX * (1 - unit(frame.storm?.amount)) * visible * (c.intensity > 0 ? 1 : 0);
    if (!(strength > 0)) return;
    const eye = this.camera.position;
    CASTER_EYE[0] = eye.x; CASTER_EYE[1] = eye.y; CASTER_EYE[2] = eye.z;
    CASTER_LIGHT[0] = light.x; CASTER_LIGHT[1] = light.y; CASTER_LIGHT[2] = light.z;
    const timeSec = frame.timeMs / 1000;
    const count = cloudShadowCasters({ eyeM: CASTER_EYE, timeSec, seed: frame.seed ?? 0, lightDir: CASTER_LIGHT,
      max: Math.min(CLOUD_SHADOW_CASTERS, MAX_CLOUD_PUFFS), out: CASTERS });
    for (let i = 0; i < count; i++) {
      const o = i * CLOUD_CASTER_STRIDE;
      u.uCloudCenterRadius.value[i].set(CASTERS[o], CASTERS[o + 1], CASTERS[o + 2], CASTERS[o + 3]);
      const shape = u.uCloudShape.value[i >> 1], component = (i % 2) * 2;
      shape.setComponent(component, CASTERS[o + 4]).setComponent(component + 1, CASTERS[o + 5]);
    }
    u.uCloudRight.value.set(CLOUD_WIND_AXIS[0], 0, CLOUD_WIND_AXIS[1]);
    u.uCloudUp.value.set(-CLOUD_WIND_AXIS[1], 0, CLOUD_WIND_AXIS[0]);
    // The clouds' own wind drift (RangeCloudField) carries the breakup.
    u.uCloudForward.value.set(Number.isFinite(timeSec) ? timeSec * 10 : 0, 0, Number.isFinite(timeSec) ? timeSec * 3 : 0);
    u.uCloudCount.value = count;
    u.uCloudMode.value = count ? 1 : 0;
    u.uCloudStrength.value = count ? strength : 0;
  }

  /**
   * Place the cast for this frame: each actor's lantern and swarm where its
   * job puts it (docs/landscape-cast.md) -- or on its wandering route in a
   * tour -- in the band scene that owns the ground under it, its light in
   * the shared uniforms, Midio's wake and Broshi's parting, and the lights
   * the job has left in this view. Absent actors (no route or plan, no
   * score yet, before the scene arrives) give no light.
   */
  _setActors(p, frame) {
    const THREE = this.THREE;
    const u = p.uniforms;
    const cast = frame.actors;
    const cam = this.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    // Metres per stage pixel (the looks are sized for a 720 px stage).
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360)
      * (cam.view?.enabled ? cam.view.height / cam.view.fullHeight : 1);
    const materials = frame.narrative?.materials ?? 1;
    const tSec = frame.timeMs / 1000;
    // The lights carry the dark: brightest before dawn and after sunset,
    // a soft shimmer at noon.
    const dark = Math.min(1, Math.max(0, frame.light?.night01 ?? 0));
    const presence = (cast?.presence ?? 0) * (materials > .01 ? materials : 0);
    // The lanterns, motes and companions are seen through the same mist and
    // cloud sea as the ground under them, at their true positions on the
    // lifted ground (their shaders' emitterSeen, as for the sites and
    // threads); the light they cast goes with them (ACTOR_GLSL actorShown).
    u.uWakeAmt.value = 0;
    u.uParting.value.w = 0;
    // A shot tour over a rail view keeps the view's job (and every light it
    // has left); only a tour view's own terrain wanders.
    const job = p.view.tour ? null : this._castJob(p, frame);
    const opts = { data: p.data, waterLevelM: p.waterLevelM };
    // A planned view with no job state yet (no schedule) wanders meanwhile.
    if (!job && !p.actorRoutes && p.castPlan && p.data) p.actorRoutes = actorRoutes(p.data, p.view, { ...opts, seed: p.castSeed ?? 0 });
    ACTOR_IDS.forEach((id, k) => {
      const group = p.actors?.groups[id];
      const route = p.actorRoutes?.[id];
      const s = cast?.[id];
      const look = ACTOR_LOOK[id];
      const placed = job?.actors[id];
      const pos = !s || presence <= 0.001 ? null : job ? placed?.pos
        : route ? routePosition(route, s.travel + (ACTOR_START[id] || 0), { ...opts, hoverM: look.hoverM, bobSec: tSec + k * 2.1 }) : null;
      u.uActorColor.value[k].set(0, 0, 0);
      if (!group) return;
      // Lanterns, motes and companions draw with the cast, after the
      // completed forest depth (renderCast, or the band passes' layer 3).
      if (!group.layers.isEnabled(CAST_LAYER)) group.traverse(object => object.layers.set(CAST_LAYER));
      if (!pos) { group.visible = false; return; }
      const at = new THREE.Vector3(pos[0], pos[1], pos[2]);
      const dist = Math.max(1, at.distanceTo(cam.position));
      const display = new THREE.Color().setHSL(ACTOR_HUES[id] / 360, 0.85, 0.62);
      // Light: linear, stronger as the lane plays; dimmed while the team
      // shelter from a storm; Midio's swells into the summit beacon.
      const lin = display.clone().convertSRGBToLinear();
      const beacon = id === 'midio' ? job?.beacon01 ?? 0 : 0;
      const gain = look.lightGain * (0.35 + 0.65 * s.glow) * presence * (0.45 + 1.15 * dark)
        * (job?.dim ?? 1) * (1 + beacon * ((job?.beaconGain ?? 2) - 1));
      u.uActorPos.value[k].copy(at);
      u.uActorColor.value[k].set(lin.r * gain, lin.g * gain, lin.b * gain);
      u.uActorRadius.value[k] = look.lightM * (1 + 2 * beacon);
      // The lantern and swarm draw a little toward the camera from the
      // light itself, so the ground it hovers over does not cut its halo.
      const mpp0 = (2 * dist * tanHalf) / 720;
      const haloPx = look.haloPx * (1 + 0.6 * beacon);
      const push = Math.min(dist * 0.25, 3 * haloPx * mpp0);
      const toCam = cam.position.clone().sub(at).normalize();
      const v = p.actors.uniforms[id];
      v.uCenter.value.copy(at).addScaledVector(toCam, push);
      v.uAnchor.value.copy(at);
      v.uRight.value.copy(right);
      v.uUp.value.copy(up);
      v.uMpp.value = mpp0 * (dist - push) / dist;
      v.uHaloPx.value = haloPx;
      v.uColor.value.copy(display);
      v.uGlow.value = Math.max(s.glow, beacon);
      v.uPresence.value = presence * (0.55 + 0.45 * dark) * (job?.dim ?? 1);
      v.uTime.value = tSec + k * 37;
      v.uWanderPx.value = look.wanderPx * (1 + 0.5 * s.glow);
      // A kindling: motes stream from the lantern into the new light.
      const fly = placed?.fly;
      v.uFly.value = fly ? fly.t : 0;
      if (fly) v.uFlyTarget.value.set(...fly.pos);
      // Companions trail along the same way, each a little behind and
      // weaving about it.
      (p.actors.companions[id] || []).forEach((c, j) => {
        const lag = job ? placed.lag?.[j] ?? pos
          : routePosition(route, s.travel + (ACTOR_START[id] || 0) - (j + 1) * 0.5, { ...opts, hoverM: look.hoverM, bobSec: tSec + j * 1.3 });
        const w = tSec * (0.7 + 0.2 * j) + j * 2.1;
        const cp = new THREE.Vector3(lag[0], lag[1], lag[2])
          .addScaledVector(right, Math.sin(w) * 18 * mpp0).addScaledVector(up, Math.cos(w * 1.3) * 10 * mpp0);
        const cd = Math.max(1, cp.distanceTo(cam.position));
        const cpush = Math.min(cd * 0.25, 30 * mpp0);
        c.uCenter.value.copy(cp).addScaledVector(cam.position.clone().sub(cp).normalize(), cpush);
        c.uAnchor.value.set(lag[0], lag[1], lag[2]);
        c.uMpp.value = mpp0 * (cd - cpush) / cd;
        c.uGlow.value = s.glow * 0.6;
      });
      group.visible = true;
      const tile = this._tileAt(p.data, pos[0], pos[2]);
      const band = BANDS.includes(tile?.band) ? tile.band : 'far';
      if (group.parent !== p.scenes[band]) p.scenes[band].add(group);
      // Midio's wake runs back along his heading on the water.
      const tail = job ? placed.wakeTail
        : id === 'midio' && route.kind === 'water' && Number.isFinite(cast.midio.trail) ? routePosition(route, cast.midio.trail, opts) : null;
      if (id === 'midio' && tail) {
        u.uWake.value.set(pos[0], pos[2], tail[0], tail[2]);
        u.uWakeAmt.value = presence * (0.3 + 0.7 * s.glow);
      }
      if (id === 'broshi') u.uParting.value.set(pos[0], pos[2], 90, presence * (0.35 + 0.65 * s.glow));
    });
    this._setCastLights(p, frame, job, presence, dark, right, up, tanHalf);
  }

  /**
   * This view's job at heard time: where each actor stands, what it is
   * kindling, the beacon, and which lights are lit. Null with no job (a
   * tour, a view with nowhere to work, or no schedule yet).
   */
  _castJob(p, frame) {
    const plan = p.castPlan, work = p.castWork;
    const state = frame.actors?.jobs?.[p.view.id];
    const schedule = frame.actors?.schedule;
    if (!plan || plan.job === 'wander' || !state || !schedule) return null;
    const t = frame.timeMs;
    const opts = { data: p.data, waterLevelM: p.waterLevelM };
    const unit = x => Math.max(0, Math.min(1, x));
    // When each light kindles (seek-safe: compiled once per schedule). A
    // review's progress override lights what that progress has reached.
    const times = schedule.kindleTimes(p.view.id, work.marks) || [];
    const reached = (k) => {
      const m = work.marks[k];
      if (!state.override) return t >= times[k];
      return Number.isFinite(m.p) ? m.p <= state.p : m.after.every(reached);
    };
    const since = (k) => (state.override ? (reached(k) ? Infinity : -1) : t - times[k]);
    const flyFor = (actor) => {
      let best = null;
      for (const l of work.lights) {
        const age = since(l.mark);
        if (l.actor === actor && age >= 0 && age < 800 && (!best || age < best.age)) best = { age, pos: l.pos };
      }
      for (const th of work.threads) {
        const age = since(th.mark);
        if (actor === 'midasus' && age >= 0 && age < 800 && (!best || age < best.age)) best = { age, pos: th.b };
      }
      return best ? { t: best.age / 800, pos: best.pos } : null;
    };
    const p01 = state.p, shelter = state.shelter01;
    const out = { actors: {}, beacon01: 0, beaconGain: state.climax ? 2 : 1.5, dim: 1, reached, since, state, times };
    if (plan.job === 'ascent') {
      out.dim = 1 - 0.4 * shelter;
      out.beacon01 = state.payoff01;
      const onWater = (x) => x < plan.waterU;
      const lead = pathPosition(plan, p01, { ...opts, hoverM: onWater(p01) ? ACTOR_LOOK.midio.hoverM : ACTOR_LOOK.midio.climbM });
      out.actors.midio = { pos: lead, fly: flyFor('midio'),
        wakeTail: onWater(p01) ? pathPosition(plan, Math.max(0, p01 - 0.04), opts) : null };
      // Broshi walks the shore to the landing while Midio is on the water.
      const ub = Math.max(0, p01 - state.offsets.broshi);
      let porter;
      if (onWater(ub) && plan.shoreStart) {
        const f = ub / plan.waterU, a = plan.shoreStart, b = plan.landing;
        const x = a[0] + (b[0] - a[0]) * f, z = a[2] + (b[2] - a[2]) * f;
        const h = terrainHeightAt(p.data, x, z);
        porter = [x, (Number.isFinite(h) ? h : b[1]) + ACTOR_LOOK.broshi.hoverM, z];
      } else porter = pathPosition(plan, Math.max(ub, plan.waterU), { ...opts, hoverM: ACTOR_LOOK.broshi.climbM });
      out.actors.broshi = { pos: porter, fly: flyFor('broshi') };
      // Midasus scouts ahead on the path, six feet up (her light washes the
      // next pitch before the others reach it).
      const um = Math.min(1, p01 + state.offsets.midasus);
      const scout = (x) => pathPosition(plan, x, { ...opts, hoverM: ACTOR_LOOK.midasus.climbM });
      out.actors.midasus = { pos: scout(um), lag: [1, 2, 3].map(j => scout(Math.max(0, um - 0.012 * j))), fly: flyFor('midasus') };
    } else {
      // In a storm they pause in place (the schedule slows them); no dimming.
      out.beacon01 = 0;
      const walk = (actor, hoverM) => {
        const w = work.walkers[actor];
        const at = w?.sites.length ? siteWalk(w.sites, w.dues, p01) : null;
        return at ? [at[0], at[1] + hoverM, at[2]] : null;
      };
      out.actors.broshi = { pos: walk('broshi', ACTOR_LOOK.broshi.hoverM), fly: flyFor('broshi') };
      const midio = walk('midio', ACTOR_LOOK.midio.hoverM);
      out.actors.midio = { pos: midio, fly: flyFor('midio'),
        wakeTail: work.walkers.midio?.water && midio ? siteWalk(work.walkers.midio.sites, work.walkers.midio.dues, Math.max(0, p01 - 0.02)) : null };
      // Midasus flies the thread being surveyed along the ground, six feet
      // up; between threads she waits at its far end (the next one's start).
      const along = (th, f) => {
        const pts = th.points, x = unit(f) * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(x)), g = x - i;
        return pts[i].map((v, c) => v + (pts[i + 1][c] - v) * g);
      };
      let flown = null, f = 0, next = null;
      for (const th of work.threads) {
        const age = since(th.mark);
        if (age < 0) { next = th; break; }
        flown = th; f = unit(age / 1500);
      }
      const first = work.threads[0];
      let scout = flown ? along(flown, f) : first ? first.a : null;
      // A thread with no ground to lie on is never drawn (castWork), so the
      // next may start at another cairn: she glides over to it in the
      // 1.5 s before it starts instead of jumping there when it does.
      if (flown && next && f >= 1 && flown.b.some((v, c) => v !== next.a[c])) {
        const g = unit(1 + since(next.mark) / 1500), e = g * g * (3 - 2 * g);
        scout = flown.b.map((v, c) => v + (next.a[c] - v) * e);
      }
      out.actors.midasus = { pos: scout, fly: flyFor('midasus'),
        lag: scout ? [1, 2, 3].map(j => (flown ? along(flown, f - 0.04 * j) : scout)) : null };
    }
    return out;
  }

  /** The lights the job has left in this view, and Midasus's threads. */
  _setCastLights(p, frame, job, presence, dark, right, up, tanHalf) {
    const THREE = this.THREE;
    const sites = p.actors?.sites, threads = p.actors?.threads, rope = p.actors?.rope;
    if (!sites || !threads) return;
    const work = p.castWork, schedule = frame.actors?.schedule;
    // Lay the sites out once per schedule: the job's lights, then a camp
    // light at each camp (known when the schedule is). The slots the lights
    // leave hold the most recent camps made so far, so every camp stands
    // while it is among them (in practice a view makes far fewer).
    const lights = work?.lights || [];
    const campSlots = Math.max(0, SITE_LIGHTS_MAX - lights.length);
    const hue = (id, l = 0.62) => new THREE.Color().setHSL(ACTOR_HUES[id] / 360, 0.85, l).convertSRGBToLinear();
    const bandAt = (pos) => this._tileAt(p.data, pos[0], pos[2])?.band;
    if (p.castLayoutFor !== schedule || !p.castCamps) {
      p.castLayoutFor = schedule;
      const camps = p.castPlan?.job === 'ascent' ? schedule?.views?.[p.view.id]?.camps || [] : [];
      p.castCamps = camps.map(c => pathPosition(p.castPlan, c.p, { data: p.data, waterLevelM: p.waterLevelM, hoverM: 3 }));
      p.castCampFrom = null;
      // Each thread keeps its drape, in the nearest band any of it lies
      // over: every partition tests against all bands' depth, so only a
      // nearer partition drawn later could paint over a stretch of it.
      const nearest = (points) => BANDS[Math.max(-1, ...points.map(q => BANDS.indexOf(bandAt(q))))];
      threads.setThreads((work?.threads || []).map(th => ({ points: th.points, a: th.a, b: th.b, band: nearest(th.points) })));
      rope?.setThreads(work?.rope ? [{ points: work.rope, band: nearest(work.rope) }] : []);
    }
    const made = job?.state.camps ?? 0;
    const campFrom = Math.max(0, Math.min(made, p.castCamps.length) - campSlots);
    if (p.castCampFrom !== campFrom) {
      p.castCampFrom = campFrom;
      sites.setSites([
        ...lights.map(l => ({ pos: l.pos, band: bandAt(l.pos), color: hue(l.actor), sizePx: l.kind === 'line' ? 5 : 9 })),
        ...p.castCamps.slice(campFrom, campFrom + campSlots).map(pos => ({ pos, band: bandAt(pos), color: hue('midio', 0.7), ring: hue('broshi'), sizePx: 9 })),
      ]);
    }
    sites.uniforms.uRight.value.copy(right);
    sites.uniforms.uUp.value.copy(up);
    sites.uniforms.uTanHalf.value = tanHalf;
    // Placed lights follow the lanterns' day law at 40% of their gain.
    const gain = 0.4 * (0.45 + 1.15 * dark) * presence;
    sites.uniforms.uGain.value = gain * ACTOR_LOOK.broshi.lightGain;
    // Threads are faint: a survey line, not a light.
    threads.setLook(new THREE.Color().setHSL(ACTOR_HUES.midasus / 360, 0.85, 0.7).convertSRGBToLinear(), 0.6 * gain);
    const low = rangeQuality(frame.qualityLevel).level >= 4;
    // Rung 4 keeps 12 of the 32 fixed-line lights; the rest fade out (and
    // back in on recovery) over heard time instead of popping.
    const dtSec = (frame.timeMs - (p.castFadeAtMs ?? -Infinity)) / 1000;
    p.castFade = easeRungAmount(p.castFade, low ? 0 : 1, dtSec);
    p.castFadeAtMs = frame.timeMs;
    const fuse = job?.state.fuse01 ?? 0;
    lights.forEach((l, k) => {
      const fade = l.kind === 'line' && !l.low ? p.castFade : 1;
      if (!job || !(fade > 0)) { sites.setState(k, 0); return; }
      const age = job.since(l.mark);
      // A light comes up as its motes arrive, then never goes out. On the
      // climax the fuse runs up the fixed lines, flaring each once.
      const lit = age < 0 ? 0 : Math.min(1, age / 800);
      const f = l.kind === 'line' && fuse > 0 && fuse < 1 ? Math.exp(-(((fuse - (l.u - p.castPlan.waterU) / (1 - p.castPlan.waterU)) / 0.06) ** 2)) : 0;
      sites.setState(k, lit * fade, f * fade);
    });
    for (let j = 0; j < Math.min(campSlots, p.castCamps.length - campFrom); j++) sites.setState(lights.length + j, made > campFrom + j ? 1 : 0);
    if (rope && work?.rope) {
      // The rope runs up to the light Broshi is fixing, growing into it as
      // it comes up, and to the summit with the payoff; the fuse runs along it.
      const climb = (u) => (u - p.castPlan.waterU) / (1 - p.castPlan.waterU);
      let front = 0, done = 0, last = 0;
      lights.forEach((l, k) => {
        if (!job || l.kind !== 'line') return;
        const age = job.since(l.mark), from = k ? climb(lights[k - 1].u) : 0;
        last = climb(l.u);
        if (age < 0) return;
        front = Math.max(front, from + (last - from) * Math.min(1, age / 800));
        done++;
      });
      const payoff = job?.state.payoff01 ?? 0;
      if (done && done === lights.length) front = Math.max(front, last + (1 - last) * payoff);
      rope.setState(0, front, 0.55 + 0.45 * payoff, fuse > 0 && fuse < 1 ? fuse : -10);
      rope.setLook(hue('broshi', 0.7), 0.6 * gain);
    }
    (work?.threads || []).forEach((th, k) => {
      if (!job) { threads.setState(k, 0, 0); return; }
      const age = job.since(th.mark);
      const reveal = age < 0 ? 0 : Math.min(1, age / 1500);
      // The finish: the closing thread first, then outward, each brightening
      // once (the climax), or all settling to a steady glow.
      const n = work.threads.length, order = Math.min(k + 1, n - 1 - k) / Math.max(1, n / 2);
      const flare = job.state.climax && fuse > 0 && fuse < 1 ? Math.exp(-(((fuse - order) / 0.12) ** 2)) : 0;
      threads.setState(k, reveal, (0.55 + 0.45 * (job.state.payoff01 ?? 0)) * (1 + 1.5 * flare));
    });
  }

  _tileAt(data, x, z) {
    const { grid, cells } = data;
    const ix = Math.floor((x - grid.originM[0]) / grid.cellSizeM / cells);
    const iz = Math.floor((z - grid.originM[1]) / grid.cellSizeM / cells);
    return data.byIndex.get(`${ix},${iz}`) || null;
  }

  // Atmosphere has its own copy boundary. It must never enter the terrain
  // alpha mask consumed by crest light and the sampled mountain skyline.
  renderSkyGiants() { return null; }

  /** Draw `texture` 1:1 into the current target. With `coverage`
   *  ({ own, pass }) the partition is rescaled by the ownership of the
   *  bands nearer than `pass` (see COPY_FRAG). */
  _copyTexture(texture, coverage = null) {
    const u = this._copy.mesh.material.uniforms;
    u.uColor.value = texture;
    if (u.uUseOwn) {
      u.uUseOwn.value = coverage ? 1 : 0;
      u.uOwn.value = coverage ? coverage.own : null;
      if (coverage) u.uNearer.value.fromArray(nearerMask(coverage.pass));
    }
    this.renderer.render(this._copy.scene, this._copy.camera);
  }

  /** The full-scene depth pre-pass, also recording which band owns each
   *  sample, then resolving that into `own` (cleared by the caller). */
  _createOwnershipMaterials(uniforms, pixelated, riverSurface = false) {
    if (pixelated) return null;
    const THREE = this.THREE;
    return Object.fromEntries(BANDS.map(band => [band, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: SCENE_VERT,
      fragmentShader: OWNERSHIP_FRAG.replace('OWNER_COLOUR', OWNER_COLOURS[band]), uniforms,
      ...(riverSurface ? { defines: { RIVER_SURFACE: 1 } } : {}),
    })]));
  }

  _renderOwnership(p, target, own) {
    const r = this.renderer;
    // Legacy nonpixel callers can enable multisampling after preparation.
    p.ownershipMaterials ||= this._createOwnershipMaterials(p.uniforms, false);
    const meshes = p.depthBandMeshes || {};
    for (const band of BANDS) if (meshes[band] && p.ownershipMaterials?.[band]) meshes[band].material = p.ownershipMaterials[band];
    if (Object.keys(p.riverDepthMeshes || {}).length) p.riverOwnershipMaterials ||= this._createOwnershipMaterials(p.uniforms, false, true);
    for (const band of BANDS) if (p.riverDepthMeshes?.[band] && p.riverOwnershipMaterials?.[band]) p.riverDepthMeshes[band].material = p.riverOwnershipMaterials[band];
    try { r.render(p.depthScene, this.camera); }
    finally {
      for (const band of BANDS) {
        if (meshes[band]) meshes[band].material = p.depthMaterial;
        if (p.riverDepthMeshes?.[band]) p.riverDepthMeshes[band].material = p.riverDepthMaterial;
      }
    }
    // The render resolved the samples into target.texture: keep that.
    r.setRenderTarget(own);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    this._copyTexture(target.texture);
    r.setRenderTarget(target);
  }

  /**
   * Render one scenic partition ('far' | 'mid' | 'near') of `frame` and
   * return the canvas holding it (valid until the next render call; copy it
   * before calling again). Null when nothing can be drawn for this view.
   */
  renderPartition(frame, pass, viewId = frame.viewFromId, { side = 'A', bandColumns = null } = {}) {
    const p = this.prepared.get(viewId);
    const target = side === 'B' ? this.sideTargets.B : this.target;
    if (!p || this.contextLost || !target) return null;
    const t0 = performance.now();
    const r = this.renderer;
    // The camera is shared: set this side's pose for every pass, even when
    // its depth pre-pass (kept per side) is reused.
    this._setCamera(p.view, frame, p);
    if (p.windowCache && p.windowCoverage?.covered === false) return null;
    this._setUniforms(p, frame);
    this._prepareMirror(p, frame, side, viewId);
    this._updateForestDetail(p, frame, this.camera, this.size.width, this.size.height, 'main');
    const softForest = Object.values(p.forest?.counts || {}).some(n => n > 0);
    // The cast draws once, after the near partition (renderCast), against
    // the whole scene's depth. A travel frame (each side's nearer bands
    // only in some columns) and a caller with no smooth layer to put it in
    // (castInBands, set by the presentation) keep it in the band passes.
    const castInBands = this.castInBands !== false || !!bandColumns;
    this.camera.layers.set(0);
    if (!softForest) { this.camera.layers.enable(3); if (castInBands) enableCastLayers(this.camera); }
    const source = pass === 'far' ? this._shaftSource(frame) : null;
    const forestDepth = p.uniforms.uNarrativeInk.value >= .005
      || (castInBands && this._castShown(p))
      || !!(source && this.shafts);
    // The backdrop holds the far partition itself: far water reflecting it
    // would feed back into the next copy, so it keeps the ground mirror only.
    if (pass === 'far') p.uniforms.uBackdropAmount.value = 0;
    const depth = this.depthCache[side];
    if (bandColumns && p.depthScenes) {
      // Travel: this side draws its nearer bands only in some columns (the
      // other side supplies them elsewhere), so its depth pre-pass holds a
      // nearer band only where it is drawn -- otherwise this pass keeps
      // holes shaped like ridges the frame never shows.
      this._travelDepth(p, target, pass, bandColumns);
      depth.frame = -1;
      depth.owned = false;
    } else if (depth.frame !== frame.frameId || depth.view !== viewId) {
      r.setRenderTarget(target);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, false);
      const own = this.ownership?.[side];
      if (own) this._renderOwnership(p, target, own);
      else r.render(p.depthScene, this.camera);
      depth.owned = !!own;
      depth.frame = frame.frameId;
      depth.view = viewId;
      this.stats.depthPasses++;
    }
    // During travel a side's nearer bands draw only in some columns: its
    // seam fill draws there too (below), never over ground the other side
    // owns.
    for (const fm of p.fringeMeshes || []) fm.visible = !bandColumns;
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    p.uniforms.uDiag.value = this.diag === 'markers' && pass === 'far' ? 1 : 0;
    r.render(p.scenes[pass], this.camera);
    if (bandColumns) this._travelFringe(p, target, pass, bandColumns);
    if (softForest) {
      // Accumulate soft crowns over receivers and each other before their
      // hard depth cut: a half-covered front crown must keep the rear colour.
      this.camera.layers.set(1);
      r.render(p.scenes[pass], this.camera);
      // Keep opaque depth for the next partition when nobody consumes the
      // hard crown cut. A combined cut must never masquerade as opaque depth.
      if (forestDepth) {
        this.camera.layers.set(2);
        if (bandColumns && p.depthScenes) this._travelDepth(p, target, pass, bandColumns, { clear: false });
        else r.render(p.depthScene, this.camera);
        depth.frame = -1;
        this.camera.layers.set(3);
        if (castInBands) enableCastLayers(this.camera);
        r.render(p.scenes[pass], this.camera);
      }
    }
    // What the cast pass will find in this side's target after the near
    // partition: whose depth, and whether the trees' crown cut is in it.
    if (pass === 'near') depth.cast = bandColumns ? null : { frame: frame.frameId, view: viewId, forest: !softForest || forestDepth };
    this.camera.layers.set(0); this.camera.layers.enable(3);
    // Far is the single solar boundary, before the inserted Dancing Ridge.
    // During travel its depth was just rebuilt with this side's real columns.
    const scattering = source && this.shafts?.render(r, side, source, this.camera, frame.scenicViewport);
    r.setRenderTarget(null);
    this._setCanvasSize(this.size.width, this.size.height);
    r.clear(true, true, false);
    const owned = !bandColumns && depth.owned && this.ownership?.[side];
    this._copyTexture(target.texture, owned ? { own: owned.texture, pass } : null);
    if (scattering && !this.directTerrainMode) this.shafts.compositeToScreen(r, side, source);
    // Whether translucent sky light now shares the returned image with the
    // terrain: an alpha mask taken from it must not trust faint pixels.
    this.lastShafted = !!scattering;
    this.stats.partitions++;
    this.stats.lastPartitionMs = performance.now() - t0;
    return this.canvas;
  }

  /** Resolve the already accumulated shaft field at output resolution. The
   * depth guard stays tied to the terrain grid, retaining its hard edges. */
  renderDirectShaft(frame, width, height, { side = 'A' } = {}) {
    const source = this._shaftSource(frame);
    if (!source || !this.shafts?.buffers?.[side] || !this.shafts?.targets?.[side]) return null;
    const r = this.renderer;
    r.setRenderTarget(null); this._setCanvasSize(Math.max(2, Math.round(width)), Math.max(2, Math.round(height)));
    r.clear(true, true, false); this.shafts.compositeToScreen(r, side, source);
    return this.canvas;
  }

  /** Whether any of a view's cast would draw a pixel this frame: a lantern
   *  out, or a light or thread laid out and lit (laid out but dark, as
   *  before the first kindling or with the cast absent, draws nothing). */
  _castShown(p) {
    const a = p.actors;
    if (!a) return false;
    if (Object.values(a.groups || {}).some(group => group.visible)) return true;
    return [a.sites, a.threads, a.rope].some(set => set?.drawn?.());
  }

  /**
   * The cast alone -- lanterns, motes, companions, placed lights, threads
   * and the fixed line -- for `frame`, drawn right after this side's near
   * partition into the same target with only its colour cleared: the depth
   * there is still every band's pre-pass (plus the trees' crown cut, added
   * here if the near partition did not need it), so the land and trees in
   * front hide it exactly and no later partition paints over it. Returns
   * the canvas holding it (valid until the next render call) for the
   * presentation to lay smoothly over the pixel frame, or null when there
   * is nothing to draw or the target no longer holds that near partition.
   */
  renderCast(frame, viewId = frame.viewFromId, { side = 'A' } = {}) {
    const p = this.prepared.get(viewId);
    const target = side === 'B' ? this.sideTargets.B : this.target;
    const depth = this.depthCache[side], near = depth?.cast;
    if (!p || this.contextLost || !target || near?.frame !== frame.frameId || near.view !== viewId) return null;
    depth.cast = null; // one cast pass per near partition
    if (!this._castShown(p)) return null;
    const r = this.renderer;
    r.setRenderTarget(target);
    if (!near.forest) {
      this.camera.layers.set(2);
      r.render(p.depthScene, this.camera);
      depth.frame = -1; // no longer plain opaque depth
    }
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    // On this cleared layer every ribbon draws first, and where one folds
    // over itself (or crosses another) it keeps its brightest layer instead
    // of summing into beads (SurveyThreads setOverlap); then every light is
    // added over them, as it is over the land. (No depth is written, so
    // band order never changes what hides what.)
    const ribbons = [p.actors?.threads, p.actors?.rope].filter(Boolean);
    for (const set of ribbons) set.setOverlap(this.THREE.MaxEquation);
    this.camera.layers.set(CAST_RIBBON_LAYER);
    try { for (const band of BANDS) r.render(p.scenes[band], this.camera); }
    finally { for (const set of ribbons) set.setOverlap(this.THREE.AddEquation); }
    this.camera.layers.set(CAST_LAYER);
    for (const band of BANDS) r.render(p.scenes[band], this.camera);
    this.camera.layers.set(0); this.camera.layers.enable(3);
    r.setRenderTarget(null);
    this._setCanvasSize(this.size.width, this.size.height);
    r.clear(true, true, false);
    this._copyTexture(target.texture);
    this.stats.castPasses = (this.stats.castPasses || 0) + 1;
    return this.canvas;
  }

  _waterRenderTarget(w, h, { capture = false } = {}) {
    const native = !capture && w === this.size.width && h === this.size.height;
    const property = capture ? 'captureWaterTarget' : native ? 'nativeWaterTarget' : 'waterTarget';
    const key = capture ? 'range:water-capture-output' : native ? 'range:water-native-mask' : 'range:water-output';
    if (!this[property] || this[property].width !== w || this[property].height !== h) {
      if (this.residency) this.residency.release(key); else this[property]?.dispose();
      this[property] = null;
      const protect = [...(this.residency?.entries.keys() || [])];
      // Colour, depth and drawing buffer. Never evict the terrain to add water.
      const res = this.residency?.reserve({ key, bytes: w * h * 12, owner: 'range-water-output', protect });
      if (this.residency && !res) return null;
      const target = this._scenicTarget(w, h);
      this[property] = target;
      if (res && !this.residency.commit(res, target, t => {
        t.dispose(); if (this[property] === t) this[property] = null;
      })) { this[property] = null; target.dispose(); return null; }
    }
    return this[property];
  }

  /** Render water at display resolution against the complete terrain and
   * forest depth. The caller must copy the returned transient canvas before
   * another scene render. A refused allocation leaves the native pass intact. */
  renderWater(frame, viewId, width, height, { pass = null, side = 'A', bandColumns = null, capture = false } = {}) {
    const p = this.prepared.get(viewId);
    if (!p || this.contextLost || !this.target || !(width > 0 && height > 0)) return null;
    const w = Math.max(2, Math.round(width)), h = Math.max(2, Math.round(height));
    const outputTarget = (this._waterRenderTarget || RangeScene.prototype._waterRenderTarget).call(this, w, h, { capture });
    if (!outputTarget) return null;
    const r = this.renderer, u = p.uniforms, hidden = [];
    this._setCamera(p.view, frame, p);
    this._setUniforms(p, frame);
    this._prepareMirror(p, frame, side, viewId);
    u.uViewportPx.value.set(w, h);
    r.setRenderTarget(outputTarget);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    try {
      // Terrain and the hard forest cut hide water behind land and trees.
      this.camera.layers.set(0); this.camera.layers.enable(2);
      if (bandColumns && pass && p.depthScenes) this._travelDepth(p, outputTarget, pass, bandColumns, { clear: false });
      else r.render(p.depthScene, this.camera);
      this.camera.layers.set(0);
      // Non-partitioned forest meshes share layer 0 with terrain.
      for (const band of BANDS) for (const mesh of p.forest?.byBand?.[band] || []) {
        hidden.push([mesh, mesh.visible]); mesh.visible = false;
      }
      u.uWaterOnly.value = 1;
      for (const band of pass ? [pass] : BANDS) {
        r.render(p.scenes[band], this.camera);
        if (bandColumns) this._travelFringe(p, outputTarget, band, bandColumns);
      }
      u.uWaterOnly.value = 0;
      r.setRenderTarget(null);
      this._setCanvasSize(w, h);
      r.clear(true, true, false);
      this._copyTexture(outputTarget.texture);
      return this.canvas;
    } finally {
      u.uWaterOnly.value = 0;
      u.uViewportPx.value.set(this.size.width, this.size.height);
      for (const [mesh, visible] of hidden) mesh.visible = visible;
      this.camera.layers.set(0); this.camera.layers.enable(3);
      r.setRenderTarget(null);
    }
  }

  /** Full-resolution cast, with the same terrain/forest depth and optional
   * travel ownership as the scenic band it follows. */
  renderDirectCast(frame, viewId, width, height, { side = 'A', bandColumns = null } = {}) {
    const p = this.prepared.get(viewId);
    if (!p || this.contextLost || !this.target || !this._castShown(p)) return null;
    const w = Math.max(2, Math.round(width)), h = Math.max(2, Math.round(height));
    const target = this._waterRenderTarget(w, h);
    if (!target) return null;
    const r = this.renderer, u = p.uniforms;
    this._setCamera(p.view, frame, p); this._setUniforms(p, frame);
    u.uViewportPx.value.set(w, h);
    r.setRenderTarget(target); r.setClearColor(0x000000, 0); r.clear(true, true, false);
    try {
      this.camera.layers.set(0); this.camera.layers.enable(2);
      if (bandColumns && p.depthScenes) this._travelDepth(p, target, 'near', bandColumns, { clear: false });
      else r.render(p.depthScene, this.camera);
      r.clear(true, false, false);
      const ribbons = [p.actors?.threads, p.actors?.rope].filter(Boolean);
      for (const set of ribbons) set.setOverlap(this.THREE.MaxEquation);
      this.camera.layers.set(CAST_RIBBON_LAYER);
      try { for (const band of BANDS) r.render(p.scenes[band], this.camera); }
      finally { for (const set of ribbons) set.setOverlap(this.THREE.AddEquation); }
      this.camera.layers.set(CAST_LAYER);
      for (const band of BANDS) r.render(p.scenes[band], this.camera);
      r.setRenderTarget(null); this._setCanvasSize(w, h); r.clear(true, true, false);
      this._copyTexture(target.texture); return this.canvas;
    } finally {
      u.uViewportPx.value.set(this.size.width, this.size.height);
      this.camera.layers.set(0); this.camera.layers.enable(3); r.setRenderTarget(null);
    }
  }

  releaseWaterTarget() {
    if (this.residency) { this.residency.release('range:water-output'); this.residency.release('range:water-native-mask'); this.residency.release('range:water-capture-output'); }
    else { this.waterTarget?.dispose(); this.nativeWaterTarget?.dispose(); this.captureWaterTarget?.dispose(); }
    this.waterTarget = null;
    this.nativeWaterTarget = null;
    this.captureWaterTarget = null;
  }

  /**
   * Render the fixed-ground rock stage for `frame` at the ground backing
   * size and return { canvas, stage } -- the canvas valid until the next
   * render call, the stage carrying exact pool polygons (wet masks).
   */
  renderGround(frame, viewId = frame.viewFromId, { viewport = null } = {}) {
    if (frame.compositions?.[viewId]?.foreground === 'none') return null;
    const p = this.prepared.get(viewId);
    if (!p?.stageGL || this.contextLost) return null;
    const composition = frame.compositions?.[viewId] ?? resolveRangeComposition(p.view);
    if (composition?.foreground === 'none') return null;
    const vp = viewport || frame.groundViewport;
    const w = Math.max(2, Math.round(vp.backingWidth)), h = Math.max(2, Math.round(vp.backingHeight));
    if (!this.groundTarget || this.groundTarget.width !== w || this.groundTarget.height !== h) {
      const key = 'range:ground-target';
      this.releaseShafts();
      this.releaseGroundTarget();
      const res = this.residency?.reserve({ key, bytes: w * h * 8, owner: 'range-targets' });
      if (this.residency && !res) return null;
      const THREE = this.THREE;
      this.groundTarget = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      if (res) this.residency.commit(res, this.groundTarget, (t) => { t.dispose(); if (this.groundTarget === t) this.groundTarget = null; });
    }
    const bars = compositionBars(frame.groundBars, vp, composition);
    const stage = buildRockStage({ bars, slabCount: composition ? 1 : undefined, width: vp.logicalWidth, height: vp.logicalHeight,
      worldX: frame.worldX, originX: frame.originX, seed: frame.seed });
    const u = p.uniforms;
    // The scene's key light, re-expressed for the stage: from behind and
    // above, on the celestial's side of the frame.
    const THREE = this.THREE;
    // A lightning flash lights the stage from its strike, as it does the land.
    const storm = frame.storm, strike = Math.min(1, (storm?.flash || 0) * 3);
    const at = strike > 0 ? flashScreenPoint(storm, this.skyPan, vp.logicalWidth, vp.logicalHeight) : null;
    const key = at ? { x: frame.light.ground.x + (at.x - frame.light.ground.x) * strike,
      y: frame.light.ground.y + (at.y - frame.light.ground.y) * strike } : frame.light.ground;
    // Stage normals use +Y upward; the recorded ground anchor is Canvas
    // +Y downward. Keep the existing shallow depth/rock calibration.
    const lightDir = new THREE.Vector3((key.x - vp.logicalWidth * .5) / vp.logicalHeight,
      (vp.logicalHeight - key.y) / vp.logicalHeight, -0.45).normalize();
    p.stageGL.update(stage, { width: vp.logicalWidth, height: vp.logicalHeight, frame, lightDir,
      skyZenith: u.uSkyZenith.value, skyHorizon: u.uSkyHorizon.value });
    // The celestial key, tempered for up-facing slab tops (see RockStageGL's
    // ambient note for the measured calibration).
    p.stageGL.uniforms.uKeyColor.value.copy(u.uLightColor.value).multiplyScalar(0.3);
    p.stageGL.uniforms.uDiag.value = this.diag === 'markers' ? 1 : 0;
    const r = this.renderer;
    this._setCanvasSize(w, h);
    r.setRenderTarget(this.groundTarget);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(p.stageGL.scene, p.stageGL.camera);
    r.setRenderTarget(null);
    r.clear(true, true, false);
    this._copyTexture(this.groundTarget.texture);
    return { canvas: this.canvas, stage };
  }

  releaseGroundTarget() {
    if (this.residency) this.residency.release('range:ground-target');
    else this.groundTarget?.dispose();
    this.groundTarget = null;
  }

  _invalidateContext() {
    this.releaseWaterTarget();
    this.releaseShafts();
    this.releaseBackdrop();
    this.releaseMirror('A');
    this.releaseMirror('B');
    if (this.residency) this.residency.release('range:render-target');
    else { this.target?.dispose(); this.ownership?.A?.dispose(); }
    if (this.ownership) this.ownership.A = null;
    this.releaseGroundTarget();
    this._copy?.mesh.geometry.dispose();
    this._copy?.mesh.material.dispose();
    // Retire handles during the lost event, before Three creates the next
    // context epoch. Deleting old buffers/VAOs after restoration is an
    // INVALID_OPERATION on real drivers. Legacy draws while we re-prepare.
    for (const id of [...this.prepared.keys()]) this.release(id);
    this.size = { width: 0, height: 0 };
    this.target = null;
    this.releaseSide('B');
    this.depthCache.A.frame = this.depthCache.B.frame = -1;
  }

  snapshot() {
    return {
      prepared: [...this.prepared.keys()], pending: [...this.pending.keys()], contextLost: this.contextLost,
      rivers: [...this.prepared.values()].filter(p => p.view.rivers).map(p => ({ viewId: p.view.id, ...p.riverStats })),
      buildAdmission: { requestedBytes: 0, admittedBytes: 0, denials: 0, peakBytes: 0, ...this.buildAdmission },
      windows: [...this.prepared.values()].filter(p=>p.windowCache).map(p=>({id:p.view.id,index:p.windowIndex,resident:[...p.windowCache.resident.keys()],detail:p.activeWindow?.detail,coverage:p.windowCoverage,note:p.windowNote,stats:p.stats,forestDetail:p.forestDetailViews})),
      size: { ...this.size }, stats: { ...this.stats }, sideB: !!this.sideTargets.B,
      edge: { samples: this.edge?.samples ?? 0, requestedSamples: this.edge?.requestedSamples ?? 0, reason: this.edge?.reason ?? null, capability: this.edge?.capability ?? 0 },
    };
  }

  dispose() {
    this.releaseWaterTarget();
    this.releaseShafts();
    this.releaseBackdrop();
    this.releaseMirror('A');
    for (const id of [...this.prepared.keys()]) this.release(id);
    this.releaseSide('B');
    this.residency?.release('range:render-target');
    this.releaseGroundTarget();
    if (!this.residency) { this.target?.dispose(); this.ownership?.A?.dispose(); }
    this._copy.mesh.geometry.dispose();
    this._copy.mesh.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }
}
