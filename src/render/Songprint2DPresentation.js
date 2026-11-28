import { CanvasBuffers } from './CanvasResidency.js';
import { clamp01 } from '../utils/math.js';
import { buildDescriptorFromSongprint, growthField, renderFable, sliceColours } from './SongprintFable.js';
import { createSongprintSweep } from './SongprintSweep.js';
import { drawSweepEffect } from './SongprintSweepEffects.js';

const TAU = Math.PI * 2;

// A provisional recording still has a clock and a level, even before it has
// a tonal print. Uniform chroma keeps its fallback rings circular.
function energyDescriptor(curves, durationMs) {
  const slices = Math.max(1, Math.min(600, Math.ceil(durationMs / 2000)));
  const chroma = new Float32Array(slices * 12).fill(1 / 12);
  const tone = new Float32Array(slices * 3);
  const stepMs = durationMs / slices;
  for (let i = 0; i < slices; i++) {
    tone[i * 3] = 2.9;
    tone[i * 3 + 1] = -1.7;
    tone[i * 3 + 2] = -42 + 38 * clamp01(curves?.globalEnergyNorm?.((i + .5) * stepMs) ?? 0);
  }
  return { slices, sliceSeconds: stepMs / 1000, lastFraction: 1, offsetSeconds: 0, keyAngle: 0, chroma, tone };
}

function drawDial(ctx, score, sample, size, margin, h) {
  const x = margin, y = h - size - margin;
  // The pith can lie well off the silhouette's center. The source image
  // and the scan use the same field, physical scale and position.
  const cx = x + size * (score.fit?.cx ?? .5), cy = y + size * (score.fit?.cy ?? .5);
  const radius = size * (score.fit?.radius ?? .42);
  ctx.save();
  ctx.globalAlpha *= .72;
  if (score.raster) {
    ctx.drawImage(score.raster, x, y, size, size);
  } else {
    // Graphics admission can refuse the optional bitmap. Trace the same
    // measured field directly while the full-screen instrument keeps playing.
    const { field, stride, slices, rays } = score.growth;
    const step = Math.max(1, Math.ceil(slices / 8));
    ctx.strokeStyle = '#aebabc';
    ctx.lineWidth = Math.max(1, size / 180);
    for (let slice = slices; slice > 0; slice -= step) {
      ctx.beginPath();
      for (let j = 0; j < rays; j += 3) {
        const angle = TAU * j / rays, r = field[j * stride + slice] * radius;
        const px = cx + Math.sin(angle) * r, py = cy - Math.cos(angle) * r;
        if (j) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  ctx.restore();
  const dx = Math.sin(sample.phase), dy = -Math.cos(sample.phase);
  const edge = sample.outerRadius * radius;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx * edge, cy + dy * edge);
  ctx.strokeStyle = '#171b1cbd'; ctx.lineWidth = Math.max(1.6, size / 75); ctx.stroke();
  ctx.strokeStyle = '#f3e7cdda'; ctx.lineWidth = Math.max(.8, size / 150); ctx.stroke();
  const r = sample.activeRadius * radius;
  ctx.beginPath(); ctx.arc(cx + dx * r, cy + dy * r, Math.max(1.5, size * .022), 0, TAU);
  ctx.fillStyle = '#ffe6a6'; ctx.fill(); ctx.strokeStyle = '#152022'; ctx.stroke();
}

export class Songprint2DPresentation {
  constructor(canvas, residency) {
    this.buffers = new CanvasBuffers({ residency, owner: 'songprint-2d-raster',
      makeCanvas: () => canvas.ownerDocument.createElement('canvas') });
    this.score = null;
  }

  draw(ctx, canvas, sim, options = {}) {
    const { width: w, height: h } = canvas;
    if (w < 1 || h < 1) return;
    const durationMs = Math.max(1, sim.conductor?.durationMs || sim.durationMs || sim.biomes?.durationMs || 1);
    const timeSec = clamp01((sim.heardTimeMs ?? (sim.tSec || 0) * 1000) / durationMs) * durationMs / 1000;
    const print = sim.biomes?.songprintWeatherPrint;
    let score = this.score;
    if (!score || score.print !== print || score.durationMs !== durationMs
      || (score.energyOnly && score.curves !== sim.energyCurves)) {
      const descriptor = print?.fable ?? buildDescriptorFromSongprint(print, durationMs) ?? energyDescriptor(sim.energyCurves, durationMs);
      const growth = growthField(descriptor, { rays: 180 });
      this.score = score = { print, durationMs, curves: sim.energyCurves, descriptor, growth, lab: sliceColours(descriptor),
        energyOnly: !print?.fable && !print?.timeline?.loudness?.length };
    }
    const timeline = sim.conductor?.timeline;
    const analyzedThroughMs = sim.biomes?.analyzedThroughMs;
    if (score.sim !== sim || score.curves !== sim.energyCurves || score.timeline !== timeline
        || score.beat !== sim.songBeat || score.analyzedThroughMs !== analyzedThroughMs) {
      Object.assign(score, { sim, curves: sim.energyCurves, timeline, beat: sim.songBeat, analyzedThroughMs,
        sample: createSongprintSweep(score.descriptor, score.growth, sim, score.lab) });
    }

    const size = Math.max(1, Math.min(w, h) * .165);
    const rasterSize = Math.max(128, Math.min(512, Math.ceil(size / 64) * 64));
    if (score.rasterSize !== rasterSize) {
      score.rasterSize = rasterSize;
      score.raster = this.buffers.ensure('rings', rasterSize, rasterSize)
        ?? (rasterSize > 128 ? this.buffers.ensure('rings', 128, 128) : null);
      const rasterCtx = score.raster?.getContext('2d');
      score.fit = null;
      if (rasterCtx) {
        const { width } = score.raster;
        const image = renderFable(score.descriptor, width, { growth: score.growth, lab: score.lab });
        const pixels = rasterCtx.createImageData(width, width);
        pixels.data.set(image.data);
        rasterCtx.putImageData(pixels, 0, 0);
        score.fit = { cx: image.centreX / width, cy: image.centreY / width, radius: image.radius / width };
      } else {
        score.raster = null;
      }
    }

    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.imageSmoothingEnabled = true;
      ctx.fillStyle = '#101416'; ctx.fillRect(0, 0, w, h);
      const sampleAt = t => score.sample(t, options);
      drawSweepEffect(ctx, { x: 0, y: 0, w, h }, sampleAt, timeSec, options);
      drawDial(ctx, score, sampleAt(timeSec), size, Math.max(1, size * .18), h);
    } finally {
      ctx.restore();
    }
  }

  dispose() {
    this.score = null;
    this.buffers.dispose();
  }
}
