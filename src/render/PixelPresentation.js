import { CinematicPixelRenderer } from './CinematicPixel.js';
import { applyPalette, compilePalette } from './PaletteQuantize.js';
import { sharedResidency } from './GraphicsResidency.js';
import { pixelGrid, PIXEL_POLICY_VERSION } from './PixelRenderPolicy.js';
import { PALETTES, resolvePaletteId } from './PaletteCatalog.js';

export function fitPixelRect(srcW, srcH, dstW, dstH, scaling = 'fit', origin = { x: 0, y: 0 }) {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) return { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  const fit = Math.min(dstW / srcW, dstH / srcH);
  const scale = scaling === 'integer' && fit >= 1 ? Math.floor(fit) : fit;
  const width = srcW * scale, height = srcH * scale;
  let x = (dstW - width) / 2, y = (dstH - height) / 2;
  // All coordinates here are device pixels. A fractional parent origin
  // needs the opposite fractional local offset to align the absolute image.
  // Exact centering can leave opposite bars one physical pixel different.
  if (scaling === 'integer' && fit >= 1) {
    x = Math.round(origin.x + x) - origin.x;
    y = Math.round(origin.y + y) - origin.y;
  }
  return { x, y, width, height, scale };
}

/** Recompose at the destination resolution: smooth sky, the native frame
 * (nearest, unless `foreground` -- the cinematic cell reconstruction --
 * draws it and returns true), then an optional water layer and smooth added
 * cast light. Recording must not resample the already combined picture. */
export function compositePixelFrame(ctx, source, width, height, scaling, background = null, destination = null, foreground = null, overlay = null, water = null, effects = null) {
  const fit = destination ? { ...destination, scale: destination.width / source.width }
    : fitPixelRect(source.width, source.height, width, height, scaling);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, width, height);
  const hybridSky = background ? !!background(ctx, fit) : false;
  ctx.imageSmoothingEnabled = false;
  if (!foreground?.(ctx, fit)) ctx.drawImage(source, fit.x, fit.y, fit.width, fit.height);
  let waterDrawn = false;
  if (water) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = 'source-over';
    try { waterDrawn = !!water(ctx, fit); } finally { ctx.restore(); }
  }
  let effectsDrawn = false;
  if (effects) {
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.globalCompositeOperation = 'source-over';
    try { effectsDrawn = !!effects(ctx, fit); } finally { ctx.restore(); }
  }
  let overlaid = false;
  if (overlay) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = 'lighter';
    try { overlaid = !!overlay(ctx, fit); } finally { ctx.restore(); }
  }
  return { hybridSky, fit, overlay: overlaid, water: waterDrawn, effects: effectsDrawn };
}
let nextOwner = 0;
/** Owns only the bounded working buffer. The output belongs to the caller. */
export class PixelPresentation {
  constructor({ canvas, presentation, residency = sharedResidency() }) {
    this.canvas = canvas;
    this.residency = residency;
    this.key = `pixel-presentation:${++nextOwner}`;
    this.maskKey = `${this.key}:dither`;
    this.ditherWeights = null;
    this.working = null;
    this.generation = 0;
    this.frameId = 0;
    this.failures = 0;
    this._securityGeneration = null;
    this._maskDeniedGeneration = null;
    this._ditherFallbackReason = null;
    this._disposed = false;
    this.setPresentation(presentation);
  }
  _invalidateCapture() {
    this.source = null;
    this._pending = null;
    this._capture = null;
  }
  setPresentation(presentation = {}) {
    // This is the shared title/live/export ingress. Raw stale Natural overrides
    // must use the same bounded nearest-neighbor presentation as saved profiles.
    presentation = { ...presentation, pixelated: true, grid: pixelGrid(presentation.grid?.id),
      paletteId: presentation.pixelated === false ? 'none' : presentation.paletteId || 'none',
      pixelScale: 'original' };
    this._invalidateCapture();
    if (JSON.stringify(presentation) === JSON.stringify(this.presentation)) return;
    this.presentation = { ...presentation };
    if (!presentation.cinematicPixel) this.cinematic?.suspend();
    this.grid = presentation.grid;
    this._preparePalette();
    this.generation++;
    this._securityGeneration = null;
    this._maskDeniedGeneration = null;
    this._ditherFallbackReason = null;
    this.diagnostics = { requestedLook: presentation.cinematicPixel ? 'cinematic' : presentation.paletteId === 'none' ? 'pixel' : 'palette',
      effectiveLook: 'pixel', paletteStatus: { applied: false, reason: null, pixels: 0 }, paletteCpuMs: 0, readbackCpuMs: 0,
      requestedGrid: this.grid.id, effectiveGrid: this.grid, pixelScale: presentation.pixelScale, pixelPolicyVersion: PIXEL_POLICY_VERSION,
      requestedPalette: presentation.paletteId || 'none', resolvedPalette: this._resolvedPaletteId, effectivePalette: 'none',
      requestedDitherMode: presentation.ditherMode || 'ordered', effectiveDitherMode: 'ordered', ditherFallbackReason: null,
      frame: { presented: false, generation: this.generation, reason: 'not-rendered' } };
    if (this.working && (this.working.width !== this.grid.width || this.working.height !== this.grid.height)) this._releaseWorking();
    if (!this._needsDitherWeights() || this.ditherWeights && this.ditherWeights.length !== this.grid.pixels) this._releaseDitherWeights();
  }
  _preparePalette() {
    this._resolvedPaletteId = resolvePaletteId(this.presentation.paletteId, this.worldKind);
    const colors = PALETTES[this._resolvedPaletteId]?.colors;
    this.compiledPalette = colors ? compilePalette(colors) : null;
  }
  setFrameContext({ worldKind = null } = {}) {
    if (worldKind === this.worldKind) return;
    this.worldKind = worldKind;
    const next = resolvePaletteId(this.presentation.paletteId, worldKind);
    if (next === this._resolvedPaletteId) return;
    this._invalidateCapture();
    this.generation++; this._securityGeneration = null;
    this._maskDeniedGeneration = null; this._ditherFallbackReason = null;
    this._preparePalette();
    if (!this._needsDitherWeights()) this._releaseDitherWeights();
    this.diagnostics.resolvedPalette = next;
    this.diagnostics.frame = { presented: false, generation: this.generation, reason: 'context-changed' };
  }
  _needsDitherWeights() { return !!this.compiledPalette && this.presentation.ditherMode === 'selective' && this.presentation.dither > 0; }
  _releaseDitherWeights() { this.residency.release(this.maskKey); this.ditherWeights = null; }
  _ensureDitherWeights() {
    if (!this._needsDitherWeights()) return;
    if (this.ditherWeights && this.residency.get(this.maskKey) !== this.ditherWeights) this._releaseDitherWeights();
    if (this.ditherWeights || this._maskDeniedGeneration === this.generation) return;
    const reservation = this.residency.reserve({ key: this.maskKey, bytes: this.grid.pixels, owner: 'pixel-dither', evictable: false });
    let reason = 'allocation-denied';
    if (reservation) {
      try {
        const weights = new Uint8Array(this.grid.pixels);
        if (this.residency.commit(reservation, weights, data => data.fill(0))) { this.ditherWeights = weights; this._ditherFallbackReason = null; return; }
        reason = 'reservation-commit';
      } catch { reason = 'mask-unavailable'; }
      this.residency.releaseReservation(reservation);
    }
    this._maskDeniedGeneration = this.generation;
    this._ditherFallbackReason = reason;
  }
  _releaseWorking() {
    this._invalidateCapture();
    this.residency.release(this.key);
    this.working = null;
  }
  failFrame(reason = 'unavailable') {
    this._invalidateCapture();
    this.failures = Math.min(Number.MAX_SAFE_INTEGER, this.failures + 1);
    const result = { presented: false, generation: this.generation, reason };
    this.diagnostics.frame = { ...result, failures: this.failures };
    return result;
  }
  beginFrame({ separate = false } = {}) {
    const started = performance.now();
    this._invalidateCapture();
    if (this._disposed) { this.failFrame('disposed'); return null; }
    const { canvas } = this;
    if (this._outputSize !== `${canvas.width}x${canvas.height}`) {
      this._outputSize = `${canvas.width}x${canvas.height}`;
      this.generation++; this._securityGeneration = null;
    }
    this.diagnostics.output = { width: canvas.width, height: canvas.height };
    this.diagnostics.frame = { presented: false, generation: this.generation, reason: 'in-progress' };
    let uncommitted = null;
    try {
      const outputContext = canvas.getContext('2d');
      if (!(canvas.width > 0 && canvas.height > 0) || !outputContext || outputContext.isContextLost?.()) {
        this.failFrame('output-context'); return null;
      }
      const grid = this.grid;
      if (!separate && canvas.width === grid.width && canvas.height === grid.height) {
        if (this.working) this._releaseWorking();
        this.source = canvas;
      } else {
        // A released buffer is not usable even if a JS reference survives.
        if (this.working && (this.residency.get(this.key) !== this.working || this.working.width !== grid.width || this.working.height !== grid.height)) this._releaseWorking();
        if (!this.working) {
          const reservation = this.residency.reserve({ key: this.key, bytes: grid.pixels * 4, owner: 'pixel-presentation', evictable: false });
          if (!reservation) {
            this.diagnostics.paletteStatus = { applied: false, reason: 'unavailable', pixels: 0 };
            this.failFrame('allocation-denied'); return null;
          }
          const buffer = (canvas.ownerDocument || globalThis.document).createElement('canvas');
          uncommitted = buffer;
          buffer.width = grid.width; buffer.height = grid.height;
          if (!buffer.getContext('2d')) throw Error('Working context unavailable');
          if (!this.residency.commit(reservation, buffer, c => { c.width = 0; c.height = 0; })) {
            buffer.width = 0; buffer.height = 0; uncommitted = null;
            this.residency.release(this.key);
            this.failFrame('reservation-commit'); return null;
          }
          uncommitted = null;
          this.working = buffer;
        }
        this.source = this.working;
      }
      const ctx = this.source.getContext('2d');
      if (!ctx || ctx.isContextLost?.()) throw Error('Source context unavailable');
      ctx.imageSmoothingEnabled = false;
      this._ensureDitherWeights();
      this.diagnostics.working = { width: this.source.width, height: this.source.height };
      this._pending = { generation: this.generation, outputSize: this._outputSize };
      this._beginCpuMs = performance.now() - started;
      return this.source;
    } catch {
      if (uncommitted) { uncommitted.width = 0; uncommitted.height = 0; }
      this._releaseWorking();
      this.diagnostics.paletteStatus = { applied: false, reason: 'unavailable', pixels: 0 };
      this.failFrame('source-unavailable'); return null;
    }
  }
  /** Begin a frame painted at output resolution, with terrain quantized at its own draw boundaries. */
  beginDirectFrame() {
    this._invalidateCapture();
    if (this._disposed) { this.failFrame('disposed'); return null; }
    const canvas = this.canvas, size = `${canvas.width}x${canvas.height}`;
    if (this._outputSize !== size) { this._outputSize = size; this.generation++; }
    if (!(canvas.width > 0 && canvas.height > 0) || !canvas.getContext('2d') || canvas.getContext('2d').isContextLost?.()) {
      this.failFrame('output-context'); return null;
    }
    this.source = canvas;
    this._pending = { generation: this.generation, outputSize: size };
    this.diagnostics.frame = { presented: false, generation: this.generation, reason: 'in-progress' };
    this.diagnostics.output = { width: canvas.width, height: canvas.height };
    return canvas;
  }
  finishDirectFrame() {
    const pending = this._pending, canvas = this.canvas;
    if (!pending || pending.generation !== this.generation || pending.outputSize !== `${canvas.width}x${canvas.height}`) return this.failFrame('stale-frame');
    this._pending = null;
    const result = { presented: true, generation: this.generation, frameId: ++this.frameId };
    this.diagnostics.frame = result;
    this.diagnostics.directTerrain = true;
    this._capture = { ...result, canvas, pixelated: false, terrainPixelated: true,
      scaling: this.presentation.scaling, width: canvas.width, height: canvas.height,
      outputSize: pending.outputSize, grid: this.grid, pixelPolicyVersion: PIXEL_POLICY_VERSION };
    return result;
  }
  drawForeground(ctx, source, fit, capture = false) {
    if (!this.presentation.cinematicPixel) return false;
    const diagnostic = capture ? 'captureReconstruction' : 'cinematicReconstruction';
    if ((this.qualityLevel || 0) >= 2) {
      this.cinematic?.suspend();
      this.diagnostics[diagnostic] = { applied: false, reason: 'quality', bytes: 0 };
      return false;
    }
    this.cinematic ||= new CinematicPixelRenderer({ residency: this.residency,
      makeCanvas: () => (this.canvas.ownerDocument || globalThis.document).createElement('canvas') });
    const applied = this.cinematic.draw(ctx, source, fit);
    this.diagnostics[diagnostic] = { applied, reason: this.cinematic.reason, bytes: this.cinematic.bytes, strength: applied ? this.cinematic.strength : null };
    if (capture) this.diagnostics.ownedPixelScratchBytes = (this.working ? this.grid.pixels * 4 : 0)
      + (this.ditherWeights?.byteLength || 0) + this.cinematic.bytes + (this.diagnostics.pixelEffectScratchBytes || 0);
    return applied;
  }
  /** `water` is source-over; `overlay` is smooth added cast light. */
  finishFrame({ background = null, overlay = null, water = null, effects = null } = {}) {
    const started = performance.now();
    if (!this.source || !this._pending || this._disposed) {
      return this.diagnostics.frame?.presented === false ? this.diagnostics.frame : this.failFrame('not-rendered');
    }
    const p = this.presentation, source = this.source, pending = this._pending;
    if (pending.generation !== this.generation || pending.outputSize !== `${this.canvas.width}x${this.canvas.height}`
      || source === this.working && this.residency.get(this.key) !== source) return this.failFrame('stale-frame');
    this.diagnostics.hybridSky = false;
    this.diagnostics.castForeground = false;
    this.diagnostics.waterForeground = false;
    this.diagnostics.smoothEffects = false;
    this.diagnostics.skyResolution = null;
    try {
      const sourceContext = source.getContext('2d'), outputContext = this.canvas.getContext('2d');
      if (!sourceContext || sourceContext.isContextLost?.() || !outputContext || outputContext.isContextLost?.()) return this.failFrame('context-lost');
      this.diagnostics.effectiveLook = p.cinematicPixel ? 'cinematic' : 'pixel';
      let status = { applied: false, reason: null, pixels: 0 };
      if (this._resolvedPaletteId !== 'none') {
        if (this._securityGeneration === this.generation) status = { applied: false, reason: 'security', pixels: source.width * source.height };
        else status = applyPalette(source.getContext('2d'), source, { paletteId: this._resolvedPaletteId, dither: p.dither, compiled: this.compiledPalette,
          ditherMode: p.ditherMode, weights: this.ditherWeights, grid: this.grid });
        if (status.reason === 'security') this._securityGeneration = this.generation;
        if (status.applied) this.diagnostics.effectiveLook = 'palette';
      }
      this.diagnostics.paletteStatus = status;
      this.diagnostics.effectivePalette = status.applied ? this._resolvedPaletteId : 'none';
      this.diagnostics.effectiveDitherMode = status.ditherMode || 'ordered';
      this.diagnostics.ditherFallbackReason = this._ditherFallbackReason || (this._resolvedPaletteId === 'rgb332' && p.ditherMode === 'selective' ? 'legacy-rgb332' : null);
      this.diagnostics.paletteCpuMs = status.transformMs ?? status.cpuMs ?? 0;
      this.diagnostics.readbackCpuMs = status.readbackMs || 0;
      this.diagnostics.writebackCpuMs = status.writebackMs || 0;
      this.diagnostics.maskCpuMs = status.maskMs || 0;
      this.diagnostics.paletteTotalCpuMs = status.totalMs || 0;
      this.diagnostics.ownedPixelScratchBytes = (this.working ? this.grid.pixels * 4 : 0) + (this.ditherWeights ? this.ditherWeights.byteLength : 0);
      if (source !== this.canvas) {
        const ctx = this.canvas.getContext('2d');
        if (!ctx) return this.failFrame('output-context');
        const composite = compositePixelFrame(ctx, source, this.canvas.width, this.canvas.height, p.scaling, background, null,
          p.cinematicPixel ? (ctx, fit) => this.drawForeground(ctx, source, fit) : null, overlay, water, effects);
        if (effects && !composite.effects) return this.failFrame('effects-layer-failed');
        const { fit, hybridSky } = composite;
        this.diagnostics.hybridSky = hybridSky;
        this.diagnostics.castForeground = composite.overlay;
        this.diagnostics.waterForeground = composite.water;
        this.diagnostics.smoothEffects = composite.effects;
        this.diagnostics.skyResolution = this.diagnostics.hybridSky ? { width: Math.round(fit.width), height: Math.round(fit.height) } : null;
      }
      this.diagnostics.ownedPixelScratchBytes += this.cinematic?.bytes || 0;
      this._pending = null;
      const result = { presented: true, generation: this.generation, frameId: ++this.frameId };
      this.diagnostics.frame = result;
      this.diagnostics.presentationCpuMs = (this._beginCpuMs || 0) + performance.now() - started;
      this._capture = { ...result, canvas: source, pixelated: true, scaling: p.scaling, pixelScale: p.pixelScale,
        grid: this.grid, paletteId: this.diagnostics.effectivePalette, worldKind: this.worldKind ?? null,
        ditherMode: this.diagnostics.effectiveDitherMode, pixelPolicyVersion: PIXEL_POLICY_VERSION,
        width: source.width, height: source.height, outputSize: pending.outputSize };
      return result;
    } catch { return this.failFrame('presentation-failed'); }
  }
  getCaptureSource() {
    const c = this._capture;
    if (!c || this._disposed || c.generation !== this.generation || c.outputSize !== `${this.canvas.width}x${this.canvas.height}`
      || c.width !== c.canvas.width || c.height !== c.canvas.height
      || c.canvas === this.working && this.residency.get(this.key) !== c.canvas) return null;
    try {
      const sourceContext = c.canvas.getContext('2d'), outputContext = this.canvas.getContext('2d');
      if (!sourceContext || sourceContext.isContextLost?.() || !outputContext || outputContext.isContextLost?.()) return null;
    } catch { return null; }
    return c;
  }
  dispose() {
    if (this._disposed) return;
    this._disposed = true; this.cinematic?.dispose(); this.cinematic = null; this._releaseWorking(); this._releaseDitherWeights();
    this.diagnostics.ownedPixelScratchBytes = 0;
    this.diagnostics.frame = { presented: false, generation: this.generation, reason: 'disposed' };
  }
}
