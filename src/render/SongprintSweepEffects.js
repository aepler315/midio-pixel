import { clamp, clamp01 } from '../utils/math.js';
import { drawSweepTool, sweepTools } from './SongprintSweepEntities.js';

const TAU = Math.PI * 2;
const PAPER = [240, 230, 206];
const FACES_BACK_TO_FRONT = [1, 0, 2];

function inkLight(color, gain, paper = 0) {
  const channels = color.map((value, i) => Math.round(clamp(value * gain + PAPER[i] * paper, 0, 255)));
  return 'rgb(' + channels.join(',') + ')';
}

// A band covers a contiguous run of song seconds. Summarize long runs with
// at most eight width-weighted samples per visible band. Preserve the focus
// of the currently heard slice even when it falls between sampled colors.
function scanBands(scan, limit) {
  const rows = scan.rows;
  const bandCount = Math.min(rows.length, limit);
  const bands = [];
  for (let band = 0; band < bandCount; band++) {
    const start = Math.floor(band * rows.length / bandCount);
    const end = Math.floor((band + 1) * rows.length / bandCount);
    const parts = Math.min(end - start, 8);
    let weight = 0, gap = 0, bend = 0;
    const ink = [0, 0, 0];
    const nearest = clamp(Math.round(scan.activeIndex - 0.5), start, end - 1);
    let focus = clamp01(rows[nearest].focus);
    for (let k = 0; k < parts; k++) {
      const first = start + Math.floor(k * (end - start) / parts);
      const last = start + Math.floor((k + 1) * (end - start) / parts) - 1;
      const row = rows[Math.floor((first + last) / 2)];
      const width = Math.max(0.000001, rows[last].r1 - rows[first].r0);
      for (let ch = 0; ch < 3; ch++) ink[ch] += row.color[ch] * width;
      weight += width;
      gap += row.gap * width;
      bend += row.bend * width;
      focus = Math.max(focus, clamp01(row.focus));
    }
    bands.push({ start, end, gap: gap / weight, bend: bend / weight, focus, ink: ink.map(c => c / weight) });
  }
  return bands;
}

function traverse(ctx, points, reverse = false) {
  const first = points[reverse ? 2 : 1];
  const second = points[reverse ? 1 : 2];
  const end = points[reverse ? 0 : 3];
  ctx.bezierCurveTo(first.x, first.y, second.x, second.y, end.x, end.y);
}

function pastSample(sampleAt, now, time, delay) {
  // At zero, a pure repeated scan already has a full revolution of history.
  // The audio-coupled view only has history the listener has actually heard.
  const t = now.withAudio === false && now.periodSec > 0
    ? ((time - delay) % now.periodSec + now.periodSec) % now.periodSec
    : Math.max(0, time - delay);
  if (t === time) return now;
  const previous = sampleAt(t);
  return previous?.rows?.length === now.rows.length ? previous : now;
}

/** Paint directly into the caller's viewport using a time-addressable score. */
export function drawSweepEffect(ctx, view, sampleAt, timeSec, { effect = 'apertures', entities = true } = {}) {
  if (!view || view.w < 2 || view.h < 2 || !Number.isFinite(timeSec)) return;
  const time = Math.max(0, timeSec);
  const now = sampleAt(time);
  if (!now?.rows?.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x, view.y, view.w, view.h);
  ctx.clip();
  ctx.translate(view.x, view.y);
  ctx.scale(view.w, view.h);
  ctx.lineJoin = 'round';
  if (effect === 'fold') {
    drawFold(ctx, view, sampleAt, now, time, entities);
  } else {
    drawAperture(ctx, view, now, entities);
  }
  ctx.restore();
}

// Three joined faces carry successively newer impressions of the same ridges.
function drawFold(ctx, view, sampleAt, now, time, entities) {
  const samples = [pastSample(sampleAt, now, time, 0.96), pastSample(sampleAt, now, time, 0.34), now];
  const count = now.rows.length;
  const bands = scanBands(now, clamp(Math.round(view.h / 9), 22, 72));
  const tools = sweepTools(now, bands.length, entities);
  const pressure = Math.max(...samples.map(sample => clamp01(sample.audible)));
  const visibility = 0.28 + 0.72 * Math.sqrt(pressure);

  // Each station samples a different scan instant. The crease connects the
  // same chronological layer while position and aperture follow the ray.
  function station(sample, slice) {
    const rows = sample.rows;
    const outer = Math.max(0.000001, rows[count - 1].r1);
    const r = slice === count ? outer : rows[slice].r0;
    const u = clamp01(r / outer);
    const active = clamp(sample.activeIndex, 0, count - 1);
    const activeStart = Math.floor(active);
    const activeRow = rows[activeStart];
    const peak = (activeRow.r0 + (active - activeStart) * (activeRow.r1 - activeRow.r0)) / outer;
    const distance = u - peak;
    const focus = Math.exp(-distance * distance / 0.018);
    const body = Math.sin(Math.PI * u);
    const row = rows[Math.min(slice, count - 1)];
    const prev = rows[Math.max(0, slice - 1)];
    const next = rows[Math.min(count - 1, slice + 1)];
    const bend = (prev.bend + 2 * row.bend + next.bend) * 0.25;
    const bite = clamp01(sample.attack) * focus;
    const mouth = clamp01(sample.energy);
    return { u, body, bend, bite, mouth, outer: clamp01(outer),
      phaseX: Math.sin(sample.phase), phaseY: Math.cos(sample.phase) };
  }
  function rail(slice) {
    const a = station(samples[0], slice);
    const b = station(samples[1], slice);
    const c = station(samples[2], slice);
    const tip = {
      x: -0.10 + 0.09 * a.u,
      y: 0.63 + 0.30 * a.u + 0.09 * a.phaseX + 0.03 * a.body * a.bend
    };
    const crest = {
      x: 0.27 + 0.18 * b.u + 0.065 * b.phaseX + 0.16 * (0.67 - b.outer) + 0.05 * b.bend * b.body,
      y: 0.18 + 0.22 * b.u + 0.07 * b.phaseY + 0.38 * (0.67 - b.outer) - 0.13 * b.bite - 0.065 * b.mouth
    };
    const heel = {
      x: 0.74 - 0.25 * c.u + 0.060 * c.phaseX + 0.24 * (c.outer - 0.67) - 0.065 * c.bend * c.body,
      y: 0.85 - 0.24 * c.u + 0.045 * c.phaseY + 0.13 * c.bite + 0.29 * (c.outer - 0.67)
    };
    const end = {
      x: 1.08 + 0.04 * c.bite,
      y: 0.11 + 0.38 * c.u + 0.085 * c.phaseY + 0.03 * c.bend * c.body
    };
    const faces = [
      [tip, {x: 0.11 + 0.08 * a.u, y: tip.y - 0.05 - 0.18 * a.body},
        {x: crest.x - 0.13, y: crest.y + 0.035 * b.u}, crest],
      [crest, {x: crest.x + 0.11 + 0.09 * b.body, y: crest.y + 0.14 + 0.05 * b.body},
        {x: heel.x - 0.11 - 0.06 * c.body, y: heel.y - 0.10 + 0.04 * c.bite}, heel],
      [heel, {x: heel.x + 0.13 + 0.11 * c.body, y: heel.y + 0.012 - 0.12 * c.mouth},
        {x: 0.92 - 0.11 * c.body, y: end.y + 0.11 + 0.14 * c.u}, end]
    ];
    // A held tool presses the nearby printed bands on its own face.
    for (const tool of tools) {
      const host = bands[tool.band];
      const distance = (slice - host.start) / (host.end - host.start);
      const bite = tool.strike * Math.exp(-0.40 * distance * distance);
      faces[tool.id][1].y += 0.075 * bite;
      faces[tool.id][2].y += 0.075 * bite;
    }
    return faces;
  }
  const rails = bands.map(band => rail(band.start));
  rails.push(rail(count));
  ctx.globalAlpha *= visibility;
  const opacity = ctx.globalAlpha;
  for (const face of FACES_BACK_TO_FRONT) {
    for (let k = 0; k < bands.length; k++) {
      const b = bands[k], top = rails[k][face], bottom = rails[k + 1][face];
      const compressed = 1 / (1 + Math.max(0, b.gap));
      const highlight = 0.025 + 0.14 * b.focus;
      const faceLight = face === 1 ? 0.43 : face === 0 ? 0.82 : 1.02;
      const gain = faceLight * (0.76 + 0.21 * (1 - compressed) + 0.10 * b.bend);
      ctx.fillStyle = inkLight(b.ink, gain, face === 1 ? 0.01 : highlight);
      ctx.beginPath();
      ctx.moveTo(top[0].x, top[0].y);
      traverse(ctx, top);
      ctx.lineTo(bottom[3].x, bottom[3].y);
      traverse(ctx, bottom, true);
      ctx.closePath();
      ctx.fill();

      // An incised edge catches light where the print opens, and a dark
      // impression stays under the turned-back face.
      ctx.globalAlpha = opacity * (face === 1 ? 0.46 : 0.23 + 0.57 * b.focus);
      ctx.strokeStyle = face === 1 ? '#131424' : inkLight(b.ink, 0.72, 0.5);
      ctx.lineWidth = (0.44 + 0.36 * compressed + 0.9 * b.focus) / view.h;
      ctx.beginPath();
      ctx.moveTo(top[0].x, top[0].y);
      traverse(ctx, top);
      const incision = clamp01(now.attack) * b.focus;
      if (face === 2 && incision > 0.07) {
        ctx.save();
        ctx.globalAlpha = opacity * incision;
        ctx.lineWidth += 0.014 * incision;
        ctx.strokeStyle = '#101416';
        ctx.stroke();
        ctx.restore();
      }
      ctx.stroke();
      ctx.globalAlpha = opacity;
    }
  }
  for (const tool of tools) {
    const path = rails[tool.band][tool.id];
    drawSweepTool(ctx, view, tool, path, 0.27 + 0.52 * tool.travel, bands[tool.band].ink);
  }
}

// The broad blades leave an irregular central eye and a slot beside each lip.
function drawAperture(ctx, view, scan, entities) {
  const rows = scan.rows;
  const outer = Math.max(0.000001, rows[rows.length - 1].r1);
  const bands = scanBands(scan, Math.round(clamp(view.w / 74, 7, 14)));
  const tools = sweepTools(scan, bands.length, entities);
  const scale = 1 / Math.min(view.w, view.h);
  const energy = clamp01(scan.energy);
  const attack = clamp01(scan.attack);
  const ratio = clamp(view.w / view.h, 0.75, 2.5);
  const cx = 0.46 + 0.058 * Math.sin(scan.phase);
  const cy = 0.47 - 0.055 * Math.cos(scan.phase);
  const lift = 0.90 - 0.34 * (outer - 0.60);

  function polar(angle, radius) {
    const x = 0.52 * radius * Math.cos(angle);
    const y = 0.56 * radius * Math.sin(angle);
    return { x: cx + x + 0.22 * y, y: cy + y - 0.10 * ratio * x };
  }

  function curve(a1, r1, a2, r2, a3, r3) {
    const p = polar(a1, r1), q = polar(a2, r2), end = polar(a3, r3);
    ctx.bezierCurveTo(p.x, p.y, q.x, q.y, end.x, end.y);
  }

  ctx.globalAlpha *= 0.39 + 0.61 * Math.sqrt(clamp01(scan.audible));
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    const tool = tools.find(t => t.band === i);
    const strike = tool?.strike ?? 0;
    // Reserve part of the circle for chronology so a thin ridge still has
    // a visible blade. The rest of its width comes from the scanned radius.
    const start = 0.64 * i / bands.length + 0.36 * rows[band.start].r0 / outer;
    const end = 0.64 * (i + 1) / bands.length + 0.36 * rows[band.end - 1].r1 / outer;
    const span = TAU * (end - start);
    const open = Math.tanh(band.gap * 0.77);
    const cut = span * (0.025 + 0.10 * open + 0.26 * attack * band.focus + 0.16 * strike);
    const a = TAU * start - 1.83 + cut * 0.5;
    const b = TAU * end - 1.83 - cut * 0.5;
    const reach = lift * (0.23 + 0.16 * open + 0.13 * energy + 0.21 * attack * band.focus + 0.085 * strike);
    const curl = 0.88 + 0.30 * band.bend + 0.15 * open;
    const tail = 1.8;
    const first = polar(a, tail);
    const leadingEdge = [polar(b, tail), polar(b + 0.12, 1.02),
      polar(b + curl - 0.13, reach + 0.17), polar(b + curl, reach)];
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    // Long arcs appear on short recordings when the descriptor has few slices.
    const steps = Math.ceil((b - a) / 0.65);
    for (let step = 1; step <= steps; step++) {
      const p = polar(a + (b - a) * step / steps, tail);
      ctx.lineTo(p.x, p.y);
    }
    traverse(ctx, leadingEdge);
    curve(b + curl - 0.23 * span, reach - 0.025, a + curl + 0.27 * span, reach + 0.02, a + curl, reach + 0.065);
    curve(a + curl - 0.05, reach + 0.22, a + 0.10, 1.10, a, tail);
    ctx.closePath();
    const center = polar(a + curl, reach), rim = polar(a, 1.28);
    const gradient = ctx.createLinearGradient(center.x, center.y, rim.x, rim.y);
    gradient.addColorStop(0, inkLight(band.ink, 0.89, 0.10));
    gradient.addColorStop(0.24, inkLight(band.ink, 0.98, 0.035));
    gradient.addColorStop(0.73, inkLight(band.ink, 0.54, 0.01));
    gradient.addColorStop(1, inkLight(band.ink, 0.21));
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.save();
    ctx.clip();
    for (let mark = 0; mark < 2; mark++) {
      const inset = span * (0.13 + mark * (0.09 + 0.08 * open));
      const point = polar(a + inset, 1.55);
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      curve(a + inset + 0.12, 1.04, a + inset + curl - 0.14, reach + 0.19, a + inset + curl, reach + 0.065);
      ctx.strokeStyle = mark === 0 ? inkLight(band.ink, 0.30) : inkLight(band.ink, 0.85, 0.21);
      ctx.lineWidth = scale * (mark === 0 ? 1.4 + 2.9 * open : 0.65 + 1.2 * band.focus);
      ctx.stroke();
    }
    const lip = leadingEdge[3];
    ctx.beginPath();
    ctx.moveTo(lip.x, lip.y);
    curve(b + curl - 0.23 * span, reach - 0.025, a + curl + 0.27 * span, reach + 0.02, a + curl, reach + 0.065);
    ctx.strokeStyle = inkLight(band.ink, 0.77, 0.36);
    ctx.lineWidth = scale * (2.3 + 2.1 * attack * band.focus);
    ctx.stroke();
    ctx.restore();
    if (tool) tool.path = leadingEdge;
  }
  for (const tool of tools) {
    drawSweepTool(ctx, view, tool, tool.path, 0.59 + 0.35 * tool.travel, bands[tool.band].ink);
  }
}
