import { createRenderer } from './WebGLRenderer.js';
import { PixelPresentation } from './PixelPresentation.js';
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
  setPresentation(value) { this.output.setPresentation(value); }
  getCaptureSource() { return this._disposed ? null : this.output.getCaptureSource(); }
  draw(sim, alpha) {
    if (this._disposed) return this.output.failFrame('disposed');
    this.output.setFrameContext?.({ worldKind: sim?.biomes?.world?.kind ?? null });
    const source = this.output.beginFrame();
    if (!source) return this.output.diagnostics.frame;
    const scene = this.canvasRenderer;
    scene.canvas = source; scene.ctx = source.getContext('2d');
    scene.pixelPolicy = pixelRenderPolicy({ ...this.output.presentation, reducedMotion: sim?.reducedMotion, reducedFlash: sim?.reducedFlash });
    this.inner.presentationPixelated = this.output.presentation.pixelated;
    const range = this.inner.rangePresentation;
    if (range) { range.pixelated = !!this.output.presentation.pixelated; range.pixelPolicy = scene.pixelPolicy; }
    try { this.inner.draw(sim, alpha); }
    catch (err) { this.output.failFrame('scene-draw'); throw err; }
    const result = this.output.finishFrame();
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
