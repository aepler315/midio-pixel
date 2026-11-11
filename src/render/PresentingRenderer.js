import { createRenderer } from './WebGLRenderer.js';
import { PixelPresentation, compositePixelFrame, fitPixelRect } from './PixelPresentation.js';
import { pixelRenderPolicy } from './PixelRenderPolicy.js';
import { CanvasBuffers } from './CanvasResidency.js';
import { CinematicPixelRenderer } from './CinematicPixel.js';
import { landscapeScoreFor } from '../world/alpine/LandscapeScore.js';
import { landscapeResolutionPlan, landscapeResolutionAt, landscapeResolutionEndpoint, landscapeQualityRung } from './ProgressiveLandscapeResolution.js';

const SKY_LAYER_KEY = 'range:output-sky';
const sameFit = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.scale === b.scale;
/** The composite's sky pass: the high-resolution sky under the scenic
 *  transform scaled into `fit`, clipped to it. */
function drawOutputSky(ctx, manager, fit, canvas) {
  const m = manager.rangeSkyLayer?.scenicTransform;
  if (!m || m.length !== 6) return false;
  const s = fit.scale, transform = [s * m[0], s * m[1], s * m[2], s * m[3], fit.x + s * m[4], fit.y + s * m[5]];
  ctx.save(); ctx.beginPath(); ctx.rect(fit.x, fit.y, fit.width, fit.height); ctx.clip();
  try { return manager.drawHighResolutionSky(ctx, canvas, { transform }); }
  finally { ctx.restore(); }
}

export function createPresentingRenderer({ canvas, mode = 'canvas', presentation, residency, voxelRange = null, rendererFactory = createRenderer }) {
  return new PresentingRenderer({ canvas, mode, presentation, residency, voxelRange, rendererFactory });
}
export class PresentingRenderer {
  constructor({ canvas, mode, presentation, residency, voxelRange, rendererFactory }) {
    this.canvas = canvas;
    this.inner = rendererFactory(canvas, mode);
    this.output = new PixelPresentation({ canvas, presentation, residency });
    this.residency = residency || null;
    this.voxelRange = voxelRange;
    // One high-resolution sky per frame (see _skyLayerFor).
    this._sky = null; this._skyFrame = 0;
    this._disposed = false;
    this._requestedPresentation = presentation;
  }
  get backend() { return this.inner.backend || 'canvas'; }
  get canvasRenderer() { return this.inner.canvasRenderer || this.inner; }
  get drawCount() { return this.inner.drawCount; }
  get composer() { return this.canvasRenderer.composer; }
  set composer(value) { this.canvasRenderer.composer = value; }
  get rangePresentation() { return this.inner.rangePresentation; }
  set rangePresentation(value) { this.inner.rangePresentation = value; }
  get hudInFrame() { return this.inner.hudInFrame; }
  set hudInFrame(value) { this.inner.hudInFrame = value; }
  get rangeListeningActive() { return this.canvasRenderer.rangeListeningActive; }
  get diagnostics() { return this.output.diagnostics; }
  setPresentation(value) {
    this._requestedPresentation = value;
    this.output.setPresentation(value);
  }
  getCaptureSource() {
    const source = this._disposed ? null : this.output.getCaptureSource();
    if (source && (this._directFrame || this._voxelFrame)) return source;
    // Recording and export consume the completed hybrid picture (smooth sky,
    // water, mid effects and/or the cinematic cell reconstruction over the
    // pixel frame). Diagnostics can still inspect the native
    // terrain raster separately.
    const background = this._captureBackground, water = this._captureWater, post = this._capturePost, effects = this._captureEffects;
    const crest = this._captureCrest, shore = this._captureShore, terrain = this._captureTerrain;
    const { hybridSky, waterForeground, smoothEffects, crestForeground, shoreForeground, crestCut } = this.output.diagnostics;
    const cinematicPixel = !!this.output.presentation.cinematicPixel;
    return source && (hybridSky || waterForeground || smoothEffects || crestForeground || shoreForeground || cinematicPixel || post) ? { ...source, canvas: this.canvas,
      pixelCanvas: source.canvas, width: this.canvas.width, height: this.canvas.height,
      pixelated: false, terrainPixelated: true, hybridSky: !!hybridSky, cinematicPixel,
      drawCaptureFrame: (ctx, width, height, destination) => {
        if (this._disposed || this.output.getCaptureSource() !== source) return false;
        const drawn = compositePixelFrame(ctx, source.canvas, width, height, source.scaling,
          hybridSky ? background : null, destination,
          cinematicPixel ? (ctx, fit) => this.output.drawForeground(ctx, source.canvas, fit, true) : null,
          null, waterForeground ? (ctx, fit) => water(ctx, fit, true) : null, smoothEffects ? effects : null,
          crestForeground ? crest : null, shoreForeground ? shore : null, crestCut ? terrain : null);
        if (post) post(ctx, drawn.fit);
        return (!hybridSky || drawn.hybridSky) && (!waterForeground || drawn.water) && (!smoothEffects || drawn.effects)
          && (!crestForeground || drawn.crest) && (!shoreForeground || drawn.shore);
      } } : source;
  }
  draw(sim, alpha, { preparing = false } = {}) {
    if (this._disposed) return this.output.failFrame('disposed');
    this.output.setFrameContext?.({ worldKind: sim?.biomes?.world?.kind ?? null });
    this.output.diagnostics.rangePipeline = this._requestedPresentation?.rangePipeline || 'hybrid';
    if (this.voxelRange || this._requestedPresentation?.directTerrain === true) {
      this.output.setFrameGrid(); this._growthKey = null;
      this.output.diagnostics.progressiveDetail = { active: false };
      if (this.inner.rangePresentation) this.inner.rangePresentation.detailHeightPx = null;
    }
    const wasVoxelFrame = this._voxelFrame;
    this._voxelFrame = false;
    if (this.voxelRange && this.voxelRange.state !== 'unavailable') {
      if (this.voxelRange.state !== 'ready') return this.output.failFrame('voxel-range-preparing');
      const source = this.voxelRange.render(sim.heardTimeMs, this.canvas.width, this.canvas.height);
      if (source) return this._drawVoxelRange(source);
    }
    if (this.voxelRange) {
      this.output.diagnostics.voxelRange = false;
      // The regular GPU scene is cold. On a mid-song loss, use the available
      // legacy scenery immediately. A new transport start can warm Range v2.
      if (wasVoxelFrame) this.rangePresentation = null;
    }
    const manager = sim?.biomes;
    const cinematicPixel = !!this.output.presentation.cinematicPixel;
    if (manager) {
      manager.cinematicPixel = cinematicPixel;
      manager.setCinematicQuality?.(sim?.perf?.level ?? 0);
    }
    const range = this.inner.rangePresentation;
    const landscape = manager?.world?.kind === 'alpine' && !!range?.enabled;
    if (landscape && this._requestedPresentation?.directTerrain === true) return this._drawDirect(sim, alpha, { preparing, manager, range });
    const growing = landscape && this._requestedPresentation?.buildPixelDetail === true
      && !this.voxelRange;
    let growth = null, qualityRung = null, frameRise01 = null;
    if (growing) {
      const layoutKey = `${this.canvas.width}:${this.canvas.height}:${this.output.presentation.scaling}`;
      if (!this._growthKey || this._growthLayoutKey !== layoutKey) {
        this._growthLayoutKey = layoutKey;
        const options = { width: this.canvas.width, height: this.canvas.height, scaling: this.output.presentation.scaling };
        const endpoint = landscapeResolutionEndpoint(options);
        const key = `${endpoint.width}:${endpoint.height}:${options.scaling}`;
        if (this._growthKey !== key) {
          this._growthKey = key;
          this._growthPlan = landscapeResolutionPlan(options);
          this._growthRungLimit = this._growthPlan.maxRung; this._lastGrowthRung = 0; this._growthLimitReason = null;
          this.output.resetFrameGridAdmission();
        }
      }
      // Pixel detail sharpens with the land as it builds through the song.
      growth = landscapeResolutionAt(this._growthPlan, landscapeScoreFor(manager).at(sim.heardTimeMs, { preview: !!manager.terrainPreview }).rise01);
      frameRise01 = growth.rise01;
      qualityRung = sim.exportMode ? this._growthPlan.maxRung : landscapeQualityRung(this._growthPlan, sim.perf?.level ?? 0);
      this.output.setFrameGrid(this._growthPlan.grids[Math.min(growth.rung, qualityRung, this._growthRungLimit)]);
      range.detailHeightPx = this._growthPlan.endpoint.height;
    } else {
      this.output.setFrameGrid();
      this._growthKey = null;
      if (range) range.detailHeightPx = null;
    }
    this.output.diagnostics.progressiveDetail = growth ? { active: true, rise01: frameRise01,
      rung: this._growthPlan.grids.indexOf(this.output.grid), requestedRung: growth.rung, maxRung: this._growthPlan.maxRung,
      qualityRung, memoryRungLimit: this._growthRungLimit,
      requestedGrid: growth.grid, admittedGrid: this.output.grid, endpoint: this._growthPlan.endpoint,
      reason: this.output.diagnostics.frameGridReason || (Math.min(growth.rung, qualityRung) > this._growthRungLimit
        ? this._growthLimitReason : growth.rung > qualityRung ? 'quality' : null) } : { active: false };
    this._directFrame = false;
    this._releaseDirect();
    if (manager) manager.directFullResolution = false;
    if (range) { range.directTerrainMode = false; range.drawTerrainImage = null; range.drawLegacyTerrain = null; }
    const hybridSky = typeof manager?.drawHighResolutionSky === 'function';
    if (manager) manager.highResolutionSky = hybridSky;
    const waterOverlay = landscape && typeof range.drawWaterForeground === 'function';
    // The crest line (RangeCrest.js) needs the separate output composite too.
    const crestOverlay = landscape && typeof range.drawCrestForeground === 'function';
    if (range) range.crestOutputSize = crestOverlay ? { width: this.canvas.width, height: this.canvas.height } : null;
    if (range && 'crestEnabled' in range) range.crestEnabled = crestOverlay;
    const smoothEffects = typeof manager?.drawHighResolutionMidEffects === 'function';
    if (manager) {
      manager.highResolutionMidEffects = smoothEffects;
      manager.midEffectsOutputSize = smoothEffects ? { width: this.canvas.width, height: this.canvas.height } : null;
    }
    if (range) range.waterOutputSize = waterOverlay ? { width: this.canvas.width, height: this.canvas.height } : null;
    const scene = this.canvasRenderer;
    scene.outputCover = false;
    // Optical effects and HUD draw after the completed Landscape composite.
    const postEffects = !!manager?.world && typeof scene.drawDeferredPostEffects === 'function';
    scene.deferPostEffects = postEffects;
    this.output.qualityLevel = sim?.perf?.level ?? 0;
    const separate = hybridSky || waterOverlay || postEffects || smoothEffects || crestOverlay;
    let source = this.output.beginFrame({ separate });
    const fallbackRung = growth ? Math.min(growth.rung, qualityRung, this._growthRungLimit, this._lastGrowthRung) : null;
    if (!source && growth && this.output.diagnostics.frame.reason === 'allocation-denied'
      && this.output.grid !== this._growthPlan.grids[fallbackRung]) {
      // A first frame after a seek may have no old working raster to retain.
      // Admit the last useful rung (Classic on a cold start) once, rather
      // than retrying an oversized allocation on every playback frame.
      this._growthRungLimit = fallbackRung;
      this._growthLimitReason = 'memory';
      this.output.setFrameGrid(this._growthPlan.grids[this._growthRungLimit]);
      source = this.output.beginFrame({ separate });
      Object.assign(this.output.diagnostics.progressiveDetail, { rung: this._growthRungLimit,
        memoryRungLimit: this._growthRungLimit, admittedGrid: this.output.grid, reason: 'memory' });
    }
    if (!source) return this.output.diagnostics.frame;
    scene.canvas = source; scene.ctx = source.getContext('2d');
    // The output sky, drawn at most once this frame: the water backdrop
    // (captured mid-frame) scales it down, and the composite blits it 1:1.
    this._skyFrame++;
    const skyFit = hybridSky
      ? fitPixelRect(source.width, source.height, this.canvas.width, this.canvas.height, this.output.presentation.scaling) : null;
    if (manager) manager.outputSkyLayer = skyFit ? { stageImage: (stage) => this._skyLayerFor(manager, skyFit, stage) } : null;
    // Scene captures (opening assembly, freeze, highlight reel) take the
    // finished composite, smooth sky and water included.
    scene.deferSceneCaptures = hybridSky || waterOverlay || postEffects || smoothEffects || crestOverlay || preparing;
    scene.pixelPolicy = pixelRenderPolicy({ ...this.output.presentation, runtimeGrid: growth ? this.output.grid : null });
    this.inner.presentationPixelated = this.output.presentation.pixelated;
    if (range) { range.pixelated = !!this.output.presentation.pixelated; range.pixelPolicy = scene.pixelPolicy; range.cinematicPixel = cinematicPixel; }
    try { this.inner.draw(sim, alpha); }
    catch (err) { scene.discardFrameCaptures?.(); this.output.failFrame('scene-draw'); throw err; }
    if (this.inner.rangePresentation?.enabled && manager?._awaitingTerrain) {
      if (growth && range.resolutionRefused) {
        const failedRung = this._growthPlan.grids.indexOf(this.output.grid);
        // A heavier incoming view may refuse even the outgoing view's last
        // useful size. Retrying that same size forever cannot recover it.
        this._growthRungLimit = Math.min(this._growthRungLimit, failedRung > this._lastGrowthRung ? this._lastGrowthRung : 0);
        this._growthLimitReason = 'scene-memory';
      }
      scene.discardFrameCaptures?.();
      return this.output.failFrame('terrain-not-ready');
    }
    if (manager) manager.outputSkyLayer = null;
    const skyFrame = this._skyFrame;
    const background = hybridSky && manager.rangeSkyLayer ? (ctx, fit) => {
      // This frame's sky layer, when the backdrop drew one for this exact
      // composite; otherwise (no water, a capture at another size) draw.
      const layer = this._sky;
      if (layer?.frame === skyFrame && sameFit(layer.fit, fit) && layer.outputWidth === ctx.canvas?.width && layer.outputHeight === ctx.canvas?.height) {
        // 1:1 at whole pixels: the fit's area of the layer onto the black frame.
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        try { ctx.drawImage(layer.canvas, fit.x - layer.x, fit.y - layer.y, fit.width, fit.height, fit.x, fit.y, fit.width, fit.height); } finally { ctx.restore(); }
        return layer.drawn;
      }
      return drawOutputSky(ctx, manager, fit, this.canvas);
    } : null;
    // Deferred captions are painted after the water and post effects.
    const caption = scene.pixelCaptionLayout;
    const water = waterOverlay ? (ctx, fit, capture = false) => range.drawWaterForeground(ctx, fit, caption, { capture }) : null;
    const effects = smoothEffects ? (ctx, fit) => manager.drawHighResolutionMidEffects(ctx, fit) : null;
    const crest = crestOverlay ? (ctx, fit, options) => range.drawCrestForeground(ctx, fit, options) : null;
    const terrain = crestOverlay && typeof range.drawCrestTerrain === 'function' ? (ctx, fit, draw, source) => range.drawCrestTerrain(ctx, fit, draw, source) : null;
    const shore = crestOverlay && typeof range.drawShoreForeground === 'function' ? (ctx, fit) => range.drawShoreForeground(ctx, fit) : null;
    const prepare = crestOverlay && typeof range.prepareCrestGrid === 'function' ? (args) => range.prepareCrestGrid(args) : null;
    const result = this.output.finishFrame({ background, water, effects, prepare, crest, shore, terrain });
    if (growth && result?.presented) this._lastGrowthRung = Math.max(0, this._growthPlan.grids.indexOf(this.output.grid));
    const post = postEffects ? (ctx, fit) => scene.drawDeferredPostEffects(ctx, fit) : null;
    if (result?.presented && post) {
      try {
        const fit = fitPixelRect(source.width, source.height, this.canvas.width, this.canvas.height, this.output.presentation.scaling);
        post(this.canvas.getContext('2d'), fit);
      } catch (err) { scene.discardFrameCaptures?.(); this.output.failFrame('post-effects-failed'); throw err; }
    }
    this._captureBackground = result?.presented ? background : null;
    this._captureWater = result?.presented ? water : null;
    this._captureEffects = result?.presented ? effects : null;
    this._captureCrest = result?.presented ? crest : null;
    this._captureShore = result?.presented ? shore : null;
    this._captureTerrain = result?.presented ? terrain : null;
    this._capturePost = result?.presented ? post : null;
    if (result?.presented && !preparing) scene.completeFrameCaptures?.(this.canvas);
    else scene.discardFrameCaptures?.();
    let effectBytes = 0;
    if (scene.pixelPolicy.active) for (const name of ['pixel-glow', 'heat']) {
      const entry = scene._postBuffers?.buffers.get(name);
      if (entry && scene._postBuffers.residency.get(entry.key) === entry.canvas) effectBytes += entry.canvas.width * entry.canvas.height * 4;
    }
    this.output.diagnostics.pixelEffectScratchBytes = effectBytes;
    this.output.diagnostics.ownedPixelScratchBytes = (this.output.diagnostics.ownedPixelScratchBytes || 0) + effectBytes;
    this.output.diagnostics.qualityLevel = sim?.perf?.level ?? null;
    return result;
  }
  _drawVoxelRange(source) {
    const canvas = this.output.beginDirectFrame();
    if (!canvas) return this.output.diagnostics.frame;
    const ctx = canvas.getContext('2d');
    compositePixelFrame(ctx, source, canvas.width, canvas.height, this.output.presentation.scaling);
    const result = this.output.finishDirectFrame();
    this._voxelFrame = !!result.presented;
    Object.assign(this.output.diagnostics, { directTerrain: false, voxelRange: this._voxelFrame,
      effectiveLook: 'pixel', working: { width: source.width, height: source.height } });
    return result;
  }
  _drawDirect(sim, alpha, { preparing, manager, range }) {
    this._directFrame = false;
    const canvas = this.output.beginDirectFrame();
    if (!canvas) return this.output.diagnostics.frame;
    this._directBuffers ||= new CanvasBuffers({ residency: this.output.residency, owner: 'direct-terrain',
      makeCanvas: () => (this.canvas.ownerDocument || globalThis.document).createElement('canvas') });
    const stage = this._directBuffers.ensure('stage', canvas.width, canvas.height);
    if (!stage?.getContext('2d')) return this.output.failFrame('allocation-denied');
    const scene = this.canvasRenderer;
    scene.outputCover = this.output.presentation.scaling === 'cover';
    const policy = pixelRenderPolicy(this.output.presentation);
    scene.canvas = stage; scene.ctx = stage.getContext('2d');
    scene.pixelPolicy = pixelRenderPolicy({ pixelated: false });
    scene.deferPostEffects = false; scene.deferSceneCaptures = preparing;
    this.inner.presentationPixelated = false;
    manager.directFullResolution = true; manager.highResolutionSky = true;
    manager.highResolutionMidEffects = false; manager.midEffectsOutputSize = null;
    range.directTerrainMode = true; range.pixelated = true; range.pixelPolicy = policy;
    range.cinematicPixel = !!this.output.presentation.cinematicPixel;
    range.outputSize = { width: canvas.width, height: canvas.height };
    range.waterOutputSize = { width: canvas.width, height: canvas.height };
    // The direct-terrain experiment keeps its own output-resolution terrain
    // edges and draws no crest line (docs/direct-terrain-experiment.md).
    if ('crestEnabled' in range) range.crestEnabled = false;
    range.crestOutputSize = null;
    range.drawTerrainImage = (ctx, image, stage, region) => this._drawDirectTerrain(ctx, image, stage, region, sim?.perf?.level ?? 0);
    range.drawLegacyTerrain = (ctx, paint) => this._drawDirectGrid(ctx, paint, sim?.perf?.level ?? 0);
    try { this.inner.draw(sim, alpha); }
    catch (error) { scene.discardFrameCaptures?.(); this.output.failFrame('scene-draw'); throw error; }
    if (manager._awaitingTerrain) { scene.discardFrameCaptures?.(); return this.output.failFrame('terrain-not-ready'); }
    const output = canvas.getContext('2d');
    output.save();
    try {
      output.setTransform(1, 0, 0, 1, 0, 0); output.globalAlpha = 1;
      output.globalCompositeOperation = 'copy'; output.drawImage(stage, 0, 0);
    } finally { output.restore(); }
    const result = this.output.finishDirectFrame();
    this._directFrame = !!result.presented;
    if (preparing) scene.discardFrameCaptures?.();
    return result;
  }
  _drawDirectTerrain(ctx, image, stage, region = image, quality = 0) {
    if (!(region.width > 0 && region.height > 0)) return false;
    return this._drawDirectGrid(ctx, target => target.drawImage(image, 0, 0, region.width, region.height, 0, 0, stage.width, stage.height), quality);
  }
  _drawDirectGrid(ctx, paint, quality = 0) {
    const p = this.output.presentation, grid = this.output.grid;
    const out = this.canvas, fit = fitPixelRect(grid.width, grid.height, out.width, out.height,
      p.scaling === 'cover' ? 'cover' : 'fit');
    if (!(fit.scale > 0)) return false;
    // Rasterize the transformed partition on the screen's stable pixel grid.
    // The current clip remains on the destination when the result is copied.
    const width = Math.ceil((out.width - fit.x) / fit.scale);
    const height = Math.ceil((out.height - fit.y) / fit.scale);
    this._directBuffers ||= new CanvasBuffers({ residency: this.output.residency, owner: 'direct-terrain',
      makeCanvas: () => (this.canvas.ownerDocument || globalThis.document).createElement('canvas') });
    const source = this._directBuffers.ensure('partition', width, height);
    const sctx = source?.getContext('2d');
    if (!sctx) return false;
    const m = ctx.getTransform?.() || { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = 'source-over'; sctx.clearRect(0, 0, width, height);
    sctx.setTransform(m.a / fit.scale, (m.b || 0) / fit.scale, (m.c || 0) / fit.scale,
      (m.d ?? 1) / fit.scale, ((m.e || 0) - fit.x) / fit.scale, ((m.f || 0) - fit.y) / fit.scale);
    sctx.imageSmoothingEnabled = false;
    paint(sctx);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    const needsCinematic = !!p.cinematicPixel && quality < 2;
    if (!needsCinematic) this._directCinematic?.suspend();
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const destination = { x: fit.x, y: fit.y, width: width * fit.scale, height: height * fit.scale };
      if (needsCinematic) {
        this._directCinematic ||= new CinematicPixelRenderer({ residency: this.output.residency,
          makeCanvas: () => (this.canvas.ownerDocument || globalThis.document).createElement('canvas') });
        if (this._directCinematic.draw(ctx, source, destination)) return true;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(source, destination.x, destination.y, destination.width, destination.height);
      return true;
    } finally { ctx.restore(); }
  }
  _releaseDirect() {
    this._directBuffers?.dispose(); this._directBuffers = null;
    this._directCinematic?.suspend();
  }
  /** The stage's area of this frame's output sky, for the water backdrop:
   *  { image, sx, sy, sw, sh } or null (no room, an unexpected transform),
   *  in which case the backdrop draws its own sky as before. The layer is
   *  the composite's sky pass in output pixels, over black, covering the
   *  fit and the stage's whole area (the stage overscans the grid), offset
   *  by whole pixels so the composite can blit the fit's part 1:1. */
  _skyLayerFor(manager, fit, stage) {
    const m = manager.rangeSkyLayer?.scenicTransform;
    if (!m || m.length !== 6 || m[1] !== 0 || m[2] !== 0 || !(stage?.width > 0)) return null;
    if (![fit.x, fit.y, fit.width, fit.height].every(Number.isInteger)) return null;
    const s = fit.scale, sx = fit.x + s * m[4], sy = fit.y + s * m[5], sw = s * m[0] * stage.width, sh = s * m[3] * stage.height;
    const x = Math.floor(Math.min(fit.x, sx)), y = Math.floor(Math.min(fit.y, sy));
    const width = Math.ceil(Math.max(fit.x + fit.width, sx + sw)) - x, height = Math.ceil(Math.max(fit.y + fit.height, sy + sh)) - y;
    if (!(width > 0 && height > 0) || width * height > 4 * this.canvas.width * this.canvas.height) return null;
    let layer = this._sky;
    if (!layer || layer.canvas.width !== width || layer.canvas.height !== height) {
      this._releaseSky();
      const res = this.residency?.reserve?.({ key: SKY_LAYER_KEY, bytes: width * height * 4, owner: 'range-sky-detail',
        protect: [...(this.residency?.entries?.keys?.() || [])] });
      if (this.residency?.reserve && !res) return null;
      const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height)
        : Object.assign((this.canvas.ownerDocument || globalThis.document).createElement('canvas'), { width, height });
      const ctx = canvas.getContext('2d');
      if (!ctx) { if (res) this.residency.releaseReservation?.(res); return null; }
      layer = { canvas, ctx, frame: -1, fit: null, drawn: false, x: 0, y: 0, outputWidth: 0, outputHeight: 0 };
      if (res && !this.residency.commit(res, layer, (l) => { l.canvas.width = l.canvas.height = 0; if (this._sky === l) this._sky = null; })) return null;
      this._sky = layer;
    }
    if (layer.frame !== this._skyFrame || !sameFit(layer.fit, fit) || layer.x !== x || layer.y !== y) {
      const ctx = layer.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
      ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, width, height);
      ctx.save();
      try { layer.drawn = !!manager.drawHighResolutionSky(ctx, this.canvas, { transform: [s * m[0], 0, 0, s * m[3], sx - x, sy - y] }); }
      finally { ctx.restore(); }
      Object.assign(layer, { frame: this._skyFrame, fit: { ...fit }, x, y, outputWidth: this.canvas.width, outputHeight: this.canvas.height });
    }
    return layer.drawn ? { image: layer.canvas, sx: sx - x, sy: sy - y, sw, sh } : null;
  }
  _releaseSky() {
    if (!this._sky) return;
    if (this.residency?.release) this.residency.release(SKY_LAYER_KEY);
    if (this._sky) { this._sky.canvas.width = this._sky.canvas.height = 0; this._sky = null; }
  }
  dispose() { if (this._disposed) return; this._disposed = true; this._releaseSky(); this._releaseDirect(); this._directCinematic?.dispose(); try { this.inner.dispose(); } finally { this.output.dispose(); } }
}
