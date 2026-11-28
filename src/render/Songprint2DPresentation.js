import { landscapeScoreFor } from '../world/alpine/LandscapeScore.js';
import { smoothstep, clamp01 } from '../utils/math.js';
import { hexToRgb } from '../utils/color.js';
import { buildDescriptorFromSongprint, renderFable, revealedSliceIndex } from './SongprintFable.js';

const TAU = Math.PI * 2;
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function rgba(hex, a = 1) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function sampleTimeline(timeline, timeMs) {
  if (!timeline?.loudness?.length) return null;
  const stepMs = timeline.stepMs || 2000;
  const i = timeMs / stepMs;
  const i0 = Math.max(0, Math.min(timeline.loudness.length - 1, Math.floor(i)));
  const i1 = Math.max(0, Math.min(timeline.loudness.length - 1, i0 + 1));
  const t = clamp01(i - i0);
  const lerpArr = (arr) => (arr?.[i0] ?? 0) * (1 - t) + (arr?.[i1] ?? arr?.[i0] ?? 0) * t;
  return {
    loudness: lerpArr(timeline.loudness),
    brightness: lerpArr(timeline.brightness),
    tension: lerpArr(timeline.tension),
    novelty: lerpArr(timeline.novelty),
    major: lerpArr(timeline.major),
  };
}

function energyAt(curves, timeMs) {
  if (!curves) return 0.35;
  if (typeof curves.globalEnergyNorm === 'function') return clamp01(curves.globalEnergyNorm(timeMs));
  if (typeof curves.globalEnergy === 'function') return clamp01(curves.globalEnergy(timeMs));
  return 0.35;
}

function sectionAt(sections, timeMs) {
  if (!Array.isArray(sections)) return null;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (timeMs >= (s.startMs ?? 0) && timeMs < (s.endMs ?? Infinity)) return s;
  }
  return null;
}

function drawBackground(ctx, w, h, score, sample) {
  const mood = score?.mood || {};
  const sky = mood.skyTop || '#101726';
  const mid = mood.skyMid || mood.skyBottom || '#24324d';
  const glow = mood.accent || '#9ad0ff';
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, rgba(sky, 1));
  g.addColorStop(0.55, rgba(mid, 1));
  g.addColorStop(1, rgba('#090c12', 1));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const rg = ctx.createRadialGradient(w * 0.5, h * 0.45, 10, w * 0.5, h * 0.45, Math.max(w, h) * 0.7);
  rg.addColorStop(0, rgba(glow, 0.12 + 0.12 * (sample?.brightness ?? score?.energy01 ?? 0.3)));
  rg.addColorStop(1, rgba(glow, 0));
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, w, h);

  // subtle grid
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  const step = Math.max(24, Math.round(Math.min(w, h) / 18));
  for (let x = 0; x <= w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y <= h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.restore();

  // horizon line
  ctx.strokeStyle = rgba('#ffffff', 0.08);
  ctx.beginPath();
  ctx.moveTo(0, h * 0.82);
  ctx.lineTo(w, h * 0.82);
  ctx.stroke();
}

function drawTimeline(ctx, sim, score, rect, timeMs, durationMs) {
  const { x, y, w, h } = rect;
  const curves = sim?.energyCurves;
  const sections = sim?.sections || sim?.biomes?.sections || [];
  const songprint = sim?.biomes?.songprint || sim?.songprint || null;
  const timeline = songprint?.timeline || null;
  const dur = Math.max(1, durationMs || sim?.durationMs || 1);
  const xAt = (ms) => x + (clamp01(ms / dur) * w);
  const yAt = (v) => y + h - clamp01(v) * h;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  // sections
  for (const s of sections) {
    const a = xAt(s.startMs || 0), b = xAt(s.endMs || dur);
    if (b <= a) continue;
    const role = String(s.role || s.kind || s.label || '');
    const active = timeMs >= (s.startMs || 0) && timeMs < (s.endMs || dur);
    ctx.fillStyle = active ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(a, y, Math.max(1, b - a), h);
    if (b - a > 40) {
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = `${Math.max(9, Math.round(h * 0.14))}px ui-monospace, SFMono-Regular, monospace`;
      ctx.fillText(role.slice(0, 14), a + 4, y + 12);
    }
  }

  // energy curve
  const samples = Math.max(120, Math.floor(w / 4));
  ctx.beginPath();
  for (let i = 0; i <= samples; i++) {
    const ms = (i / samples) * dur;
    const e = energyAt(curves, ms);
    const px = x + (i / samples) * w;
    const py = yAt(e);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = 'rgba(140,220,255,0.95)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // timeline curves if present
  if (timeline?.loudness?.length) {
    const drawSeries = (arr, color, alpha = 0.7) => {
      ctx.beginPath();
      for (let i = 0; i < arr.length; i++) {
        const ms = i * (timeline.stepMs || 2000);
        const px = xAt(ms), py = yAt(arr[i] || 0);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    drawSeries(timeline.brightness, '#ffd36f', 0.55);
    drawSeries(timeline.tension, '#ff8a8a', 0.45);
    drawSeries(timeline.novelty, '#caa0ff', 0.45);
  }

  // playhead
  const px = xAt(timeMs);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px, y + h); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillRect(px - 1, y, 2, h);

  // labels
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = `${Math.max(10, Math.round(h * 0.16))}px system-ui, sans-serif`;
  ctx.fillText('heard-time energy / sections / songprint timeline', x + 8, y + h - 8);
  ctx.restore();
}

const fableCache = new WeakMap();

function getFableImage(songprint, durationMs, size) {
  if (!songprint) return null;
  let entry = fableCache.get(songprint);
  const key = `${size}|${durationMs}|${songprint.fable ? 'fable' : 'timeline'}|${songprint.fable?.slices || songprint.timeline?.loudness?.length || 0}`;
  if (entry?.key === key) return entry;
  const desc = songprint.fable?.chroma ? songprint.fable : buildDescriptorFromSongprint(songprint, durationMs);
  if (!desc) return null;
  const rendered = renderFable(desc, size, { ridges: true });
  entry = { key, desc, rendered, source: songprint.fable?.chroma ? 'fable' : 'timeline' };
  fableCache.set(songprint, entry);
  return entry;
}

function drawSongprintFable(ctx, sim, score, rect, timeMs, durationMs) {
  const songprint = sim?.biomes?.songprint || sim?.songprint || null;
  const timeline = songprint?.timeline || null;
  const passages = Array.isArray(songprint?.passages) ? songprint.passages : [];
  const dur = Math.max(1, durationMs || sim?.durationMs || 1);
  const t01 = clamp01(timeMs / dur);
  const size = Math.max(256, Math.round(Math.min(rect.w, rect.h) * 0.9));
  const fable = getFableImage(songprint, dur, Math.min(768, Math.max(384, Math.floor(size / 64) * 64)));
  const cx = rect.x + rect.w * 0.5;
  const cy = rect.y + rect.h * 0.52;
  const r = Math.min(rect.w, rect.h) * 0.42;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

  if (fable?.rendered) {
    try {
      const img = ctx.createImageData?.(fable.rendered.width, fable.rendered.height);
      const doc = ctx.canvas?.ownerDocument || globalThis.document;
      const c = doc?.createElement?.('canvas');
      if (img && c?.getContext) {
        img.data.set(fable.rendered.data);
        c.width = fable.rendered.width; c.height = fable.rendered.height;
        c.getContext('2d')?.putImageData?.(img, 0, 0);
        const drawSize = r * 2.05;
        ctx.save();
        ctx.globalAlpha = 0.98;
        ctx.drawImage(c, cx - drawSize / 2, cy - drawSize / 2, drawSize, drawSize);
        const reveal = revealedSliceIndex(fable.desc, timeMs, dur) / ((fable.desc.slices - 1) + (fable.desc.lastFraction ?? 1));
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = `rgba(0,0,0,${0.35 * (1 - clamp01(reveal))})`;
        ctx.fillRect(cx - drawSize / 2, cy - drawSize / 2, drawSize, drawSize);
        ctx.restore();
      }
    } catch {
      // Fallback: keep prototype alive in test/mock canvases.
    }
    ctx.strokeStyle = 'rgba(255,232,170,0.95)';
    ctx.lineWidth = Math.max(2, r * 0.01);
    ctx.beginPath();
    ctx.arc(cx, cy, r * (0.12 + 0.88 * clamp01(revealedSliceIndex(fable.desc, timeMs, dur) / ((fable.desc.slices - 1) + (fable.desc.lastFraction ?? 1)))), 0, TAU);
    ctx.stroke();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText('Songprint timeline unavailable; showing fallback.', rect.x + 16, rect.y + 32);
  }

  // passage ticks around the fable
  for (const p of passages) {
    const ms = Number(p.timeMs);
    if (!Number.isFinite(ms)) continue;
    const a = -Math.PI / 2 + clamp01(ms / dur) * TAU;
    const near = 1 - smoothstep(1200, 9000, Math.abs(ms - timeMs));
    const rr = r * (0.95 + 0.08 * clamp01(p.landmark01 ?? 0.5));
    ctx.strokeStyle = `rgba(255,255,255,${0.08 + 0.45 * near})`;
    ctx.lineWidth = 1 + 2 * near;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9);
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    ctx.stroke();
  }

  // playhead line
  const pa = -Math.PI / 2 + t01 * TAU;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(pa) * r, cy + Math.sin(pa) * r);
  ctx.stroke();

  const tonic = Number.isInteger(timeline?.key?.tonic) ? timeline.key.tonic : 0;
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.max(12, Math.round(r * 0.09))}px system-ui, sans-serif`;
  ctx.fillText('Songprint Fable', cx, rect.y + 28);
  ctx.font = `${Math.max(10, Math.round(r * 0.05))}px ui-monospace, SFMono-Regular, monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  const source = fable?.source === 'fable' ? 'fable descriptor' : 'timeline fallback';
  ctx.fillText(`${NOTE_NAMES[tonic]} ${timeline?.key?.major ? 'major' : 'minor'} / ${source} / heard-time reveal`, cx, rect.y + 48);
  ctx.restore();
}

export function drawSongprint2D(ctx, canvas, sim) {
  const w = canvas.width, h = canvas.height;
  const timeMs = Number.isFinite(sim?.heardTimeMs) ? sim.heardTimeMs : (sim?.tSec || 0) * 1000;
  const durationMs = Math.max(1, sim?.durationMs || sim?.biomes?.durationMs || 1);
  const manager = sim?.biomes;
  const score = manager ? landscapeScoreFor(manager).at(timeMs, { preview: !!manager.terrainPreview }) : null;
  const sample = sampleTimeline(manager?.songprint?.timeline || sim?.songprint?.timeline, timeMs) || {};

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  drawBackground(ctx, w, h, score, sample);

  const pad = Math.max(16, Math.round(Math.min(w, h) * 0.04));
  const timelineH = Math.max(72, Math.round(h * 0.18));
  const mainH = h - pad * 3 - timelineH;
  drawSongprintFable(ctx, sim, score, { x: pad, y: pad, w: w * 0.52 - pad, h: mainH }, timeMs, durationMs);

  // right-side info
  const infoX = w * 0.56;
  const infoY = pad;
  const infoW = w - infoX - pad;
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(infoX, infoY, infoW, mainH);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.strokeRect(infoX + 0.5, infoY + 0.5, infoW - 1, mainH - 1);
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  ctx.font = `600 ${Math.max(14, Math.round(h * 0.03))}px system-ui, sans-serif`;
  ctx.fillText('Heard-time song representation (prototype)', infoX + 16, infoY + 30);
  ctx.font = `${Math.max(11, Math.round(h * 0.02))}px ui-monospace, SFMono-Regular, monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  const section = sectionAt(sim?.sections || manager?.sections, timeMs);
  const lines = [
    `time ${Math.round(timeMs)} ms / ${Math.round(durationMs)} ms`,
    `section ${section?.role || section?.label || section?.kind || 'n/a'}`,
    `energy ${Math.round((score?.energy01 ?? energyAt(sim?.energyCurves, timeMs)) * 100)}%  brightness ${Math.round((sample.brightness ?? 0) * 100)}%`,
    `tension ${Math.round((sample.tension ?? 0) * 100)}%  novelty ${Math.round((sample.novelty ?? 0) * 100)}%`,
    `pulse accent ${Math.round((score?.pulse?.accent01 ?? 0) * 100)}%  sign ${score?.pulse?.sign ?? 0}`,
    `camera ${score?.camera?.shot || 'n/a'}  lens half-angle ${((score?.lens?.halfAngleScale ?? 1) * 100).toFixed(0)}%`,
  ];
  lines.forEach((line, i) => ctx.fillText(line, infoX + 16, infoY + 62 + i * 24));

  // small bar meters
  const meterY = infoY + 62 + lines.length * 24 + 20;
  const meterW = infoW - 32;
  const meters = [
    ['loudness', sample.loudness ?? score?.energy01 ?? 0, '#8fd3ff'],
    ['brightness', sample.brightness ?? 0, '#ffd36f'],
    ['tension', sample.tension ?? 0, '#ff8a8a'],
    ['novelty', sample.novelty ?? 0, '#caa0ff'],
    ['major', sample.major ?? 0.5, '#9ef0b0'],
  ];
  meters.forEach((m, i) => {
    const y = meterY + i * 28;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(m[0], infoX + 16, y);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(infoX + 110, y - 10, meterW - 110, 10);
    ctx.fillStyle = rgba(m[2], 0.85);
    ctx.fillRect(infoX + 110, y - 10, (meterW - 110) * clamp01(m[1]), 10);
  });

  drawTimeline(ctx, sim, score, { x: pad, y: h - pad - timelineH, w: w - pad * 2, h: timelineH }, timeMs, durationMs);

  // caption
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = `${Math.max(10, Math.round(h * 0.018))}px system-ui, sans-serif`;
  ctx.fillText('Experimental: not geographic Range. Uses heard-time song data.', pad, h - 6);
  ctx.restore();

  return { presented: true, reason: null };
}
