import { createRenderer } from './WebGLRenderer.js';
import { PixelPresentation, compositePixelFrame } from './PixelPresentation.js';
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
    this.output.setPresentation(this._experience === 'trio' ? { ...value, pixelScale: 'original' } : value);
  }
  getCaptureSource() {
    const source = this._disposed ? null : this.output.getCaptureSource();
    // Recording and export consume the completed hybrid picture (smooth sky
    // and/or the smooth cast over the pixel frame). Palette diagnostics can
    // still inspect the native terrain raster separately.
    const background = this._captureBackground, foreground = this._captureForeground;
    const { hybridSky, castForeground } = this.output.diagnostics;
    return source && (hybridSky || castForeground) ? { ...source, canvas: this.canvas,
      pixelCanvas: source.canvas, width: this.canvas.width, height: this.canvas.height,
      pixelated: false, terrainPixelated: true, hybridSky: !!hybridSky, castForeground: !!castForeground,
      drawCaptureFrame: (ctx, width, height, destination) => {
        if (this._disposed || this.output.getCaptureSource() !== source) return false;
        const drawn = compositePixelFrame(ctx, source.canvas, width, height, source.scaling,
          hybridSky ? background : null, destination, castForeground ? foreground : null);
        return (!hybridSky || drawn.hybridSky) && (!castForeground || drawn.foreground);
      } } : source;
  }
  draw(sim, alpha, { preparing = false } = {}) {
    if (this._disposed) return this.output.failFrame('disposed');
    if ((sim?.experience || 'landscape') !== this._experience) {
      this._experience = sim?.experience || 'landscape'; this.setPresentation(this._requestedPresentation);
    }
    this.output.setFrameContext?.({ worldKind: sim?.biomes?.world?.kind ?? null });
    const manager = sim?.biomes;
    const range = this.inner.rangePresentation;
    const landscape = this._experience !== 'trio' && manager?.world?.kind === 'alpine' && !!range?.enabled;
    const hybridSky = landscape && typeof manager.drawHighResolutionSky === 'function';
    if (manager) manager.highResolutionSky = hybridSky;
    // The cast is laid smoothly over the upscaled frame, so the working
    // buffer must stay separate from the output (as for the sky).
    const castOverlay = landscape && typeof range.drawCastForeground === 'function';
    if (range && 'castForeground' in range) range.castForeground = castOverlay;
    const source = this.output.beginFrame({ separate: hybridSky || castOverlay });
    if (!source) return this.output.diagnostics.frame;
    const scene = this.canvasRenderer;
    scene.canvas = source; scene.ctx = source.getContext('2d');
    scene.deferSceneCaptures = hybridSky || preparing;
    scene.pixelPolicy = pixelRenderPolicy(this.output.presentation);
    this.inner.presentationPixelated = this.output.presentation.pixelated;
    if (range) { range.pixelated = !!this.output.presentation.pixelated; range.pixelPolicy = scene.pixelPolicy; }
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
    const foreground = castOverlay ? (ctx, fit) => range.drawCastForeground(ctx, fit) : null;
    const result = this.output.finishFrame({ background, foreground });
    this._captureBackground = result?.presented ? background : null;
    this._captureForeground = result?.presented ? foreground : null;
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
