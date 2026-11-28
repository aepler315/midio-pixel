import { clamp, clamp01, lerp } from '../utils/math.js';

// The tools ride different material edges and work on different beat divisions.
// Their position is a function of the song clock, so export, pause and seek agree.
const TOOLS = [
  { band: 0.23, offset: 0, interval: 2, travel: 7, rest: 0.48 },
  { band: 0.51, offset: 1, interval: 3, travel: 11, rest: 0.61 },
  { band: 0.79, offset: 2, interval: 4, travel: 13, rest: 0.37 },
];
const TAU = 2 * Math.PI;
const BRASS = '#e2bc79';
const IVORY = '#fff0ce';
const EDGE = '#24252b';

export function sweepTools(scan, bandCount, enabled) {
  if (!enabled || scan.withAudio === false) return [];
  const audible = clamp01(scan.audible);
  const confidence = Number.isFinite(scan.beatPosition) ? clamp01(scan.beatConfidence) : 0;
  const beat = confidence > 0 ? scan.beatPosition : 0;
  const tools = [];
  for (let i = 0; i < Math.min(TOOLS.length, bandCount); i++) {
    const spec = TOOLS[i];
    const age = ((beat - spec.offset) % spec.interval + spec.interval) % spec.interval;
    const strike = confidence * audible * Math.pow(Math.max(0, 1 - age / 0.58), 2);
    const drift = 0.5 + 0.33 * Math.sin(scan.phase + i * 2.1);
    const stride = 0.5 + 0.41 * Math.sin(TAU * beat / spec.travel + i * 2.1);
    tools.push({
      id: i, band: Math.floor(bandCount * spec.band), strike,
      travel: lerp(spec.rest, lerp(drift, stride, confidence), audible),
      opacity: 0.44 + 0.56 * audible,
    });
  }
  return tools;
}

function polygon(ctx, points, fill) {
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 0.045;
  ctx.stroke();
}

function wheel(ctx, x, y, radius, fill) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 0.055;
  ctx.stroke();
}

// The cubic belongs to the rendered blade or fold itself. Use its derivative
// in output pixels to hold the tool against that edge at every canvas aspect.
export function drawSweepTool(ctx, view, tool, cubic, u, color) {
  const [a, b, c, d] = cubic;
  const v = 1 - u;
  const x = v*v*v*a.x + 3*v*v*u*b.x + 3*v*u*u*c.x + u*u*u*d.x;
  const y = v*v*v*a.y + 3*v*v*u*b.y + 3*v*u*u*c.y + u*u*u*d.y;
  const dx = v*v*(b.x-a.x) + 2*v*u*(c.x-b.x) + u*u*(d.x-c.x);
  const dy = v*v*(b.y-a.y) + 2*v*u*(c.y-b.y) + u*u*(d.y-c.y);
  const angle = Math.atan2(view.h * dy, view.w * dx);
  const size = clamp(Math.min(view.w, view.h) * 0.052, 13, 43);
  const pigment = 'rgb(' + color.map(Math.round).join(',') + ')';
  const press = tool.strike;
  ctx.save();
  ctx.scale(1 / view.w, 1 / view.h);
  ctx.translate(x * view.w, y * view.h);
  ctx.rotate(angle);
  ctx.scale(size, size);
  ctx.globalAlpha *= tool.opacity;

  // A momentary bite remains on the contact edge as the tool recoils.
  if (press > 0.02) {
    ctx.beginPath();
    ctx.moveTo(-0.52 - press * 0.8, 0.045);
    ctx.lineTo(0.02, 0.045);
    ctx.strokeStyle = IVORY;
    ctx.lineWidth = 0.035 + 0.08 * press;
    ctx.stroke();
  }

  if (tool.id === 0) {
    // A sail-shaped shuttle closes its two wings around the edge.
    const lift = 0.26 * (1 - press);
    polygon(ctx, [-0.76,-0.06, -0.23,-0.30-lift, 0.64,-0.03, 0.06,0.10], IVORY);
    polygon(ctx, [-0.58,0.02, -0.22,0.21+lift*0.48, 0.63,-0.03, 0.03,0.04], pigment);
    wheel(ctx, -0.19, -0.08, 0.075, BRASS);
  } else if (tool.id === 1) {
    // Two brass rollers share a low ink carriage. It sinks onto the wheels.
    wheel(ctx, -0.33, -0.02, 0.17, BRASS);
    wheel(ctx, 0.34, -0.02, 0.17, IVORY);
    const body = -0.32 + 0.12 * press;
    polygon(ctx, [-0.56,-0.11, -0.36,body, 0.21,body-0.045, 0.54,-0.11, 0.37,-0.04, -0.23,-0.04], pigment);
  } else {
    // A long split stylus stamps the ridge with its lower tine.
    const lift = 0.19 * (1 - press);
    polygon(ctx, [-0.67,-0.22-lift, -0.50,-0.36-lift, 0.74,-0.025, 0.12,0.06], BRASS);
    polygon(ctx, [-0.59,0.12+lift*0.4, -0.38,0.16+lift*0.4, 0.74,-0.025, 0.14,-0.10], IVORY);
    wheel(ctx, -0.31, -0.08, 0.075, pigment);
  }
  ctx.restore();
}
