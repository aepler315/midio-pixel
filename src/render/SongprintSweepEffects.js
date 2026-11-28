import { clamp, clamp01 } from '../utils/math.js';
import { drawSweepTool, sweepTools } from './SongprintSweepEntities.js';
import { drawPaperRoom, printChair, roomRegistration } from './SongprintPaperRoom.js';

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
  const room = roomRegistration(now);
  drawPaperRoom(ctx, view, room, effect);
  // The paper and the tiny tools ride the same sideways pull. The source
  // dial is drawn later in screen space, so the listener can find it again.
  ctx.transform(1, .055 * room.roll, .24 * room.roll, 1 - .14 * room.load,
    -.076 * room.roll, .044 * room.load - .024 * room.roll);
  if (effect === 'fold') {
    drawFold(ctx, view, sampleAt, now, time, entities, room);
  } else {
    drawAperture(ctx, view, now, entities, room);
  }
  ctx.restore();
}

// Three joined faces carry successively newer impressions of the same ridges.
function drawFold(ctx, view, sampleAt, now, time, entities, room) {
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
    // Like the bottom edge of the room, the two creases tip toward a
    // common plane. The delay keeps a previous impression on the far face.
    crest.x += .12 * room.roll * (1 - b.u);
    crest.y += .18 * room.load;
    heel.x -= .14 * room.roll * c.u;
    heel.y -= .13 * room.load;
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
  // Print the familiar chair directly onto the moving sheet. Map each cut
  // through that band's real Bezier rail, including tracer indentations.
  function printOnFace(face, start, span) {
    function onFold(x, y) {
      const across = (.12 + .76 * y) * bands.length;
      const row = Math.floor(across), blend = across - row;
      const a = rails[row][face], b = rails[row + 1][face];
      const u = start + x * span, v = 1 - u;
      const weights = [v*v*v, 3*u*v*v, 3*u*u*v, u*u*u];
      let px = 0, py = 0;
      for (let j = 0; j < 4; j++) {
        px += weights[j] * (a[j].x + blend * (b[j].x - a[j].x));
        py += weights[j] * (a[j].y + blend * (b[j].y - a[j].y));
      }
      return { x: px, y: py };
    }
    printChair(ctx, onFold, '#242431', '#e6c488');
  }
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
    if (face !== 1) {
      ctx.globalAlpha = opacity * (.46 + .44 * room.load);
      printOnFace(face, .37, .17);
      // The first impression has a misregistered neighbour under pressure.
      if (room.load > .01) {
        ctx.globalAlpha = opacity * .64 * room.load;
        printOnFace(face, .65, .17);
      }
      ctx.globalAlpha = opacity;
    }
  }
  for (const tool of tools) {
    const path = rails[tool.band][tool.id];
    drawSweepTool(ctx, view, tool, path, 0.27 + 0.52 * tool.travel, bands[tool.band].ink, room.load);
  }
}

// The eye is a hole in one continuous stack of sheets. Neighboring sheets
// use the same corners, so even a strong contact cannot pull out a free tip.
function drawAperture(ctx, view, scan, entities, room) {
  const rows = scan.rows;
  const outer = Math.max(0.000001, rows[rows.length - 1].r1);
  const bands = scanBands(scan, Math.round(clamp(view.w / 78, 7, 14)));
  const tools = sweepTools(scan, bands.length, entities);
  const repeats = Math.ceil(7 / bands.length);
  const short = Math.min(view.w, view.h);
  const extent = Math.hypot(view.w, view.h) / short;
  const energy = clamp01(scan.energy), attack = clamp01(scan.attack);
  const cx = 0.51 + 0.057 * Math.sin(scan.phase);
  const cy = 0.49 - 0.054 * Math.cos(scan.phase);
  const registration = -1.86 + 0.32 * Math.sin(scan.phase);
  const teeth = [];

  function polar(angle, radius) {
    const x = 0.5 * radius * Math.cos(angle), y = 0.5 * radius * Math.sin(angle);
    return { x: cx + short / view.w * (x + 0.12 * y), y: cy + short / view.h * (y - 0.06 * x) };
  }
  function between(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  function plate(fill, ...points) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.fill();
  }

  // Keep short prints legible by continuing their existing sheets around the
  // opening. Every repeat still belongs to the original band and its tool.
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    const tool = tools.find(t => t.band === i);
    const start = 0.64 * i / bands.length + 0.36 * rows[band.start].r0 / outer;
    const end = 0.64 * (i + 1) / bands.length + 0.36 * rows[band.end - 1].r1 / outer;
    const open = Math.tanh(0.77 * band.gap);
    for (let j = 0; j < repeats; j++) {
      const angle = registration + TAU * (start + (end - start) * j / repeats);
      const span = TAU * (end - start) / repeats;
      const occupant = j === Math.floor(repeats / 2) ? tool : null;
      const press = occupant?.strike ?? 0;
      const reach = 0.29 + 0.18 * open + 0.12 * energy + 0.16 * attack * band.focus + 0.11 * press;
      const flex = span * (0.18 * band.bend + 0.09 * open + 0.12 * press);
      const twist = 0.84 + 0.18 * Math.sin(scan.phase) + flex;
      const ledge = 0.72 + 0.16 * open + 0.09 * Math.cos(angle - scan.phase) + 0.06 * press;
      teeth.push({ band, tool: occupant, open, angle,
        outside: polar(angle - 0.24, 1.6 * extent),
        back: polar(angle - 0.12 + 0.25 * flex, 1.35 + 0.13 * open),
        hinge: polar(angle + 0.38 + flex, ledge),
        eye: polar(angle + twist, reach)
      });
    }
  }

  ctx.globalAlpha *= 0.39 + 0.61 * Math.sqrt(clamp01(scan.audible));
  for (let i = 0; i < teeth.length; i++) {
    const left = teeth[i], right = teeth[(i + 1) % teeth.length];
    const { band, tool, open } = left;
    const light = 0.5 + 0.5 * Math.cos(left.angle - 0.58);
    const mouth = inkLight(band.ink, 0.71 + 0.15 * light, 0.08 + 0.05 * band.focus);
    const gradient = ctx.createLinearGradient(left.back.x, left.back.y, left.outside.x, left.outside.y);
    gradient.addColorStop(0, inkLight(band.ink, 0.67 + 0.22 * light));
    gradient.addColorStop(1, inkLight(band.ink, 0.12 + 0.16 * light));
    plate(gradient, left.outside, right.outside, right.back, left.back);

    // Each page turns through a diagonal crease. Its darker underside gives
    // the next page an edge to slide under as the scanned interval expands.
    plate(inkLight(band.ink, 0.52 + 0.16 * light, 0.035), left.back, right.back, right.hinge);
    plate(inkLight(band.ink, 0.79 + 0.18 * light, 0.05), left.back, right.hinge, left.hinge);
    plate(mouth, left.hinge, right.hinge, right.eye, left.eye);
    // A cast shadow gradually slips out from under the neighboring edge. It
    // dies at the inner fold so the opening keeps its uninterrupted boundary.
    const slip = 0.045 + 0.15 * open + 0.11 * attack * band.focus;
    plate(inkLight(band.ink, 0.25 + 0.08 * light), left.outside,
      between(left.outside, right.outside, slip), between(left.back, right.back, slip * 0.78),
      between(left.hinge, right.hinge, slip * 0.35), left.eye, left.hinge, left.back);
    const stack = 0.11 + 0.14 * open + 0.17 * attack * band.focus + 0.09 * (tool?.strike ?? 0);
    const lowerLeft = between(left.hinge, left.eye, stack);
    const lowerRight = between(right.hinge, right.eye, stack * 0.32);
    plate(inkLight(band.ink, 0.26 + 0.11 * light), left.hinge, right.hinge, lowerRight, lowerLeft);
    for (let leaf = 1; leaf < 4; leaf++) {
      const depth = leaf / 4;
      const l = between(left.hinge, lowerLeft, depth), r = between(right.hinge, lowerRight, depth);
      ctx.strokeStyle = inkLight(band.ink, 0.58, 0.19);
      ctx.lineWidth = (0.65 + 0.5 * band.focus) / short;
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(r.x, r.y);
      ctx.stroke();
    }
    // The tool's cubic is a straight line coincident with this very crease.
    if (tool) tool.path = [left.hinge, between(left.hinge, right.hinge, 1 / 3),
      between(left.hinge, right.hinge, 2 / 3), right.hinge];
  }
  for (const tool of tools) {
    drawSweepTool(ctx, view, tool, tool.path, 0.15 + 0.7 * tool.travel, bands[tool.band].ink, room.load);
  }
}
