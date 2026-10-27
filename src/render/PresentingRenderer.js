import { createRenderer } from './WebGLRenderer.js';
import { PixelPresentation, compositePixelFrame, fitPixelRect } from './PixelPresentation.js';
import { pixelRenderPolicy } from './PixelRenderPolicy.js';

export function createPresentingRenderer({ canvas, mode = 'canvas', presentation, residency, rendererFactory = createRenderer }) {
  return new PresentingRenderer({ canvas, mode, presentation, residency, rendererFactory });
}
class PresentingRenderer {
  constructor({ canvas, mode, presentation, residency, rendererFactory }) {
    this.canvas = canvas;
    this.inner = rendererFactory(canvas, mode);
    this.output = new PixelPresentation({ canvas, presentation, residency });
    this._disposed = false;
    this._requestedPresentation = presentation;
    this._experience = 'landscape';
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
    this.output.setPresentation(this._experience === 'trio' ? { ...value, cinematicPixel: false, pixelScale: 'original' } : value);
  }
  getCaptureSource() {
    const source = this._disposed ? null : this.output.getCaptureSource();
    // Recording and export consume the completed hybrid picture (smooth sky,
    // the cinematic cell reconstruction and/or the smooth cast over the
    // pixel frame). Palette diagnostics can still inspect the native
    // terrain raster separately.
    const background = this._captureBackground, overlay = this._captureOverlay, water = this._captureWater, post = this._capturePost, effects = this._captureEffects;
    const { hybridSky, castForeground, waterForeground, smoothEffects } = this.output.diagnostics;
    const cinematicPixel = !!this.output.presentation.cinematicPixel;
    return source && (hybridSky || castForeground || waterForeground || smoothEffects || cinematicPixel || post) ? { ...source, canvas: this.canvas,
      pixelCanvas: source.canvas, width: this.canvas.width, height: this.canvas.height,
      pixelated: false, terrainPixelated: true, hybridSky: !!hybridSky, castForeground: !!castForeground, cinematicPixel,
      drawCaptureFrame: (ctx, width, height, destination) => {
        if (this._disposed || this.output.getCaptureSource() !== source) return false;
        const drawn = compositePixelFrame(ctx, source.canvas, width, height, source.scaling,
          hybridSky ? background : null, destination,
          cinematicPixel ? (ctx, fit) => this.output.drawForeground(ctx, source.canvas, fit, true) : null,
          castForeground ? overlay : null, waterForeground ? (ctx, fit) => water(ctx, fit, true) : null, smoothEffects ? effects : null);
        if (post) post(ctx, drawn.fit);
        return (!hybridSky || drawn.hybridSky) && (!castForeground || drawn.overlay) && (!waterForeground || drawn.water) && (!smoothEffects || drawn.effects);
      } } : source;
  }
  draw(sim, alpha, { preparing = false } = {}) {
    if (this._disposed) return this.output.failFrame('disposed');
    if ((sim?.experience || 'landscape') !== this._experience) {
      this._experience = sim?.experience || 'landscape'; this.setPresentation(this._requestedPresentation);
    }
    this.output.setFrameContext?.({ worldKind: sim?.biomes?.world?.kind ?? null });
    const manager = sim?.biomes;
    const cinematicPixel = !!this.output.presentation.cinematicPixel && this._experience !== 'trio';
    if (manager) {
      manager.cinematicPixel = cinematicPixel;
      manager.setCinematicQuality?.(sim?.perf?.level ?? 0);
    }
    const range = this.inner.rangePresentation;
    const landscape = this._experience !== 'trio' && manager?.world?.kind === 'alpine' && !!range?.enabled;
    const hybridSky = this._experience !== 'trio' && typeof manager?.drawHighResolutionSky === 'function';
    if (manager) manager.highResolutionSky = hybridSky;
    // The cast is laid smoothly over the upscaled frame, so the working
    // buffer must stay separate from the output (as for the sky).
    const castOverlay = landscape && typeof range.drawCastForeground === 'function';
    const waterOverlay = landscape && typeof range.drawWaterForeground === 'function';
    const smoothEffects = this._experience !== 'trio' && typeof manager?.drawHighResolutionMidEffects === 'function';
    if (manager) {
      manager.highResolutionMidEffects = smoothEffects;
      manager.midEffectsOutputSize = smoothEffects ? { width: this.canvas.width, height: this.canvas.height } : null;
    }
    if (range) range.waterOutputSize = waterOverlay ? { width: this.canvas.width, height: this.canvas.height } : null;
    const scene = this.canvasRenderer;
    // Optical effects and HUD draw after the completed Landscape composite.
    const postEffects = this._experience !== 'trio' && typeof scene.drawDeferredPostEffects === 'function';
    scene.deferPostEffects = postEffects;
    if (range && 'castForeground' in range) range.castForeground = castOverlay;
    this.output.qualityLevel = sim?.perf?.level ?? 0;
    const source = this.output.beginFrame({ separate: hybridSky || castOverlay || waterOverlay || postEffects || smoothEffects });
    if (!source) return this.output.diagnostics.frame;
    scene.canvas = source; scene.ctx = source.getContext('2d');
    // Scene captures (opening assembly, freeze, highlight reel) take the
    // finished composite, smooth sky and cast included.
    scene.deferSceneCaptures = hybridSky || castOverlay || waterOverlay || postEffects || smoothEffects || preparing;
    scene.pixelPolicy = pixelRenderPolicy(this.output.presentation);
    this.inner.presentationPixelated = this.output.presentation.pixelated;
    if (range) { range.pixelated = !!this.output.presentation.pixelated; range.pixelPolicy = scene.pixelPolicy; range.cinematicPixel = cinematicPixel; }
    try { this.inner.draw(sim, alpha); }
    catch (err) { scene.discardFrameCaptures?.(); this.output.failFrame('scene-draw'); throw err; }
    if (this._experience !== 'trio' && this.inner.rangePresentation?.enabled && manager?._awaitingTerrain) {
      scene.discardFrameCaptures?.();
      return this.output.failFrame('terrain-not-ready');
    }
    const background = hybridSky && manager.rangeSkyLayer ? (ctx, fit) => {
      const m = manager.rangeSkyLayer.scenicTransform;
      if (!m || m.length !== 6) return false;
      const s = fit.scale, transform = [s * m[0], s * m[1], s * m[2], s * m[3], fit.x + s * m[4], fit.y + s * m[5]];
      ctx.save(); ctx.beginPath(); ctx.rect(fit.x, fit.y, fit.width, fit.height); ctx.clip();
      try { return manager.drawHighResolutionSky(ctx, this.canvas, { transform }); }
      finally { ctx.restore(); }
    } : null;
    // Deferred captions are painted after the water, cast and post effects;
    // otherwise the native plate attenuates the cast as before.
    const caption = scene.pixelCaptionLayout;
    const overlay = castOverlay ? (ctx, fit) => range.drawCastForeground(ctx, fit, caption) : null;
    const water = waterOverlay ? (ctx, fit, capture = false) => range.drawWaterForeground(ctx, fit, caption, { capture }) : null;
    const effects = smoothEffects ? (ctx, fit) => manager.drawHighResolutionMidEffects(ctx, fit) : null;
    const result = this.output.finishFrame({ background, overlay, water, effects });
    const post = postEffects ? (ctx, fit) => scene.drawDeferredPostEffects(ctx, fit) : null;
    if (result?.presented && post) {
      try {
        const fit = fitPixelRect(source.width, source.height, this.canvas.width, this.canvas.height, this.output.presentation.scaling);
        post(this.canvas.getContext('2d'), fit);
      } catch (err) { scene.discardFrameCaptures?.(); this.output.failFrame('post-effects-failed'); throw err; }
    }
    this._captureBackground = result?.presented ? background : null;
    this._captureOverlay = result?.presented ? overlay : null;
    this._captureWater = result?.presented ? water : null;
    this._captureEffects = result?.presented ? effects : null;
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
  dispose() { if (this._disposed) return; this._disposed = true; try { this.inner.dispose(); } finally { this.output.dispose(); } }
}
