import { CanvasBuffers } from './CanvasResidency.js';
import { clamp01 } from '../utils/math.js';
import { buildDescriptorFromSongprint, renderFable, revealedSliceIndex } from './SongprintFable.js';

const TAU = Math.PI * 2;
const PALETTE = ['#ddaa69', '#89c8ce', '#aab5de', '#c0aa89'];
const sectionColor = i => PALETTE[i % PALETTE.length];

function energyAt(sim, timeMs) {
  return clamp01(sim.energyCurves?.globalEnergyNorm?.(timeMs) ?? 0);
}

function clock(timeMs) {
  const seconds = Math.floor(timeMs / 1000);
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

// A neutral ring score gives unpitched or provisional audio a picture too.
// Only level comes from the energy curve. Chroma remains uniform.
function energyDescriptor(sim, durationMs) {
  const slices = Math.min(600, Math.ceil(durationMs / 2000));
  const chroma = new Float32Array(slices * 12).fill(1 / 12);
  const tone = new Float32Array(slices * 3);
  const stepMs = durationMs / slices;
  for (let i = 0; i < slices; i++) {
    tone[i * 3] = 2.9;
    tone[i * 3 + 1] = -1.7;
    tone[i * 3 + 2] = -42 + 38 * energyAt(sim, (i + .5) * stepMs);
  }
  return { slices, sliceSeconds: stepMs / 1000, lastFraction: 1, keyAngle: 0, chroma, tone };
}

function drawBackground(ctx, w, h, cx, cy) {
  ctx.fillStyle = '#0a131a';
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * .64);
  glow.addColorStop(0, '#22343a');
  glow.addColorStop(.6, '#12212a');
  glow.addColorStop(1, '#0a131a');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
}

function traceContour(ctx, growth, x, y, size, slice) {
  const { field, rays, stride, centreX, centreY, width, radius } = growth;
  const scale = size / width;
  const lo = Math.floor(slice), hi = Math.min(lo + 1, growth.slices), mix = slice - lo;
  ctx.beginPath();
  for (let j = 0; j < rays; j += 2) {
    const row = j * stride, angle = TAU * j / rays;
    const r = (field[row + lo] * (1 - mix) + field[row + hi] * mix) * radius;
    const px = x + (centreX + Math.sin(angle) * r) * scale;
    const py = y + (centreY - Math.cos(angle) * r) * scale;
    if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawRings(ctx, art, cx, cy, size, timeMs, durationMs, accent) {
  const r = size * .50;
  ctx.strokeStyle = '#79949a44';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.stroke();
  const angle = -Math.PI / 2 + TAU * timeMs / durationMs;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(cx + r * Math.cos(angle), cy + r * Math.sin(angle), Math.max(2, size * .007), 0, TAU);
  ctx.fill();
  if (timeMs <= 0) return;
  if (!art) {
    const radius = r * timeMs / durationMs;
    const fill = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    fill.addColorStop(0, '#263a41');
    fill.addColorStop(.8, '#45616a');
    fill.addColorStop(1, accent);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.fill();
    return;
  }

  const { descriptor, growth, raster } = art;
  const index = revealedSliceIndex(descriptor, timeMs, durationMs);
  const startOfTail = descriptor.slices - 1;
  const slice = index <= startOfTail ? index : startOfTail + (index - startOfTail) / (descriptor.lastFraction ?? 1);
  const x = cx - size / 2, y = cy - size / 2;
  ctx.save();
  traceContour(ctx, growth, x, y, size, Math.min(slice, descriptor.slices));
  ctx.clip();
  ctx.drawImage(raster, x, y, size, size);
  ctx.restore();
  ctx.strokeStyle = '#ffe1ae99';
  ctx.lineWidth = Math.max(.75, size * .0025);
  ctx.stroke();
}

function drawTimeline(ctx, points, sections, { x, y, w, h }, timeMs, durationMs) {
  const at = ms => x + clamp01(ms / durationMs) * w;
  const head = at(timeMs);
  ctx.fillStyle = '#0c171d';
  ctx.fillRect(x, y, w, h);
  const trace = () => {
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const px = x + w * i / (points.length - 1);
      const py = y + h * (.88 - .67 * points[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
  };
  trace();
  ctx.fillStyle = '#3b555d';
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, head - x, h);
  ctx.clip();
  trace();
  ctx.fillStyle = '#ad8e65';
  ctx.fill();
  ctx.restore();

  for (let i = 0; i < sections.length; i++) {
    const start = at(sections[i].startMs);
    const end = at(sections[i + 1]?.startMs ?? durationMs);
    ctx.fillStyle = sectionColor(i);
    ctx.fillRect(start, y + h - 2, Math.max(0, end - start - 1), 2);
  }
  ctx.fillStyle = '#f0d5ab';
  ctx.fillRect(head - 1, y, 2, h);
  if (w < 120) return;
  ctx.fillStyle = '#adc0c1';
  ctx.font = Math.max(10, Math.round(h * .26)) + 'px ui-monospace, monospace';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText(clock(timeMs), x, y - 6);
  ctx.textAlign = 'right';
  ctx.fillText(clock(durationMs), x + w, y - 6);
}

export class Songprint2DPresentation {
  constructor(canvas, residency) {
    this.buffers = new CanvasBuffers({ residency, owner: 'songprint-2d-raster',
      makeCanvas: () => canvas.ownerDocument.createElement('canvas') });
    this.score = null;
  }

  draw(ctx, canvas, sim) {
    const { width: w, height: h } = canvas;
    const durationMs = Math.max(1, sim.durationMs || sim.biomes?.durationMs || 1);
    const timeMs = durationMs * clamp01((sim.heardTimeMs ?? (sim.tSec || 0) * 1000) / durationMs);
    const print = sim.biomes?.songprintWeatherPrint;
    const sections = sim.sections || sim.biomes?.sections || [];
    const accent = sectionColor(Math.max(0, sections.findLastIndex(section => section.startMs <= timeMs)));
    const shortest = Math.min(w, h);
    const pad = Math.max(1, shortest * .065);
    const stripHeight = Math.max(1, Math.min(h * .12, 58));
    const artworkHeight = Math.max(1, h - stripHeight - pad * 3);
    const size = Math.max(1, Math.min(w - 2 * pad, artworkHeight));
    const cx = w / 2, cy = pad + artworkHeight / 2;
    const rasterSize = Math.min(640, Math.max(256, Math.ceil(size / 128) * 128));
    let score = this.score;
    if (!score || score.sim !== sim || score.print !== print || score.curves !== sim.energyCurves || score.durationMs !== durationMs) {
      const descriptor = print?.fable ?? buildDescriptorFromSongprint(print, durationMs) ?? energyDescriptor(sim, durationMs);
      const points = Array.from({ length: 161 }, (_, i) => energyAt(sim, durationMs * i / 160));
      this.score = score = { sim, print, curves: sim.energyCurves, durationMs, descriptor, points, art: null, rasterSize: null };
    }
    if (score.rasterSize !== rasterSize) {
      score.rasterSize = rasterSize;
      const raster = this.buffers.ensure('rings', rasterSize, rasterSize)
        ?? (rasterSize > 256 ? this.buffers.ensure('rings', 256, 256) : null);
      const rasterCtx = raster?.getContext('2d');
      score.art = null;
      if (rasterCtx) {
        const { width } = raster;
        const { data, ...growth } = renderFable(score.descriptor, width, { rays: 240 });
        const pixels = rasterCtx.createImageData(width, width);
        pixels.data.set(data);
        rasterCtx.putImageData(pixels, 0, 0);
        score.art = { raster, growth, descriptor: score.descriptor };
      }
    }

    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = true;
      ctx.globalCompositeOperation = 'source-over';
      drawBackground(ctx, w, h, cx, cy);
      drawRings(ctx, score.art, cx, cy, size, timeMs, durationMs, accent);
      const stripWidth = Math.min(w - 2 * pad, Math.max(w * .56, size));
      drawTimeline(ctx, score.points, sections,
        { x: (w - stripWidth) / 2, y: h - pad - stripHeight, w: stripWidth, h: stripHeight }, timeMs, durationMs);
    } finally {
      ctx.restore();
    }
  }

  dispose() {
    this.score = null;
    this.buffers.dispose();
  }
}
