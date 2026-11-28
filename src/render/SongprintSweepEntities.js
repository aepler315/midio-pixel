import { clamp, clamp01, lerp } from '../utils/math.js';

// Three small registration slips travel along different material edges.
// Their position is a function of the song clock, so export, pause and seek agree.
const TOOLS = [
  { band: 0.23, offset: 0, interval: 2, travel: 7, rest: 0.48 },
  { band: 0.51, offset: 1, interval: 3, travel: 11, rest: 0.61 },
  { band: 0.79, offset: 2, interval: 4, travel: 13, rest: 0.37 },
];
const TAU = 2 * Math.PI;

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

function alongEdge(cubic, t, view) {
  const [a, b, c, d] = cubic;
  const v = 1 - t;
  const w0 = v*v*v, w1 = 3*v*v*t, w2 = 3*v*t*t, w3 = t*t*t;
  return {
    x: view.w * (w0*a.x + w1*b.x + w2*c.x + w3*d.x),
    y: view.h * (w0*a.y + w1*b.y + w2*c.y + w3*d.y),
  };
}

// Lift just a short section of the actual crease. Its shorter, lighter
// impression shares that edge, so even the moving accent belongs to the ink.
export function drawSweepTool(ctx, view, tool, cubic, u, color, load = 0) {
  const [a, b, c, d] = cubic;
  const v = 1 - u;
  const dx = 3 * view.w * (v*v*(b.x-a.x) + 2*v*u*(c.x-b.x) + u*u*(d.x-c.x));
  const dy = 3 * view.h * (v*v*(b.y-a.y) + 2*v*u*(c.y-b.y) + u*u*(d.y-c.y));
  const speed = Math.hypot(dx, dy);
  if (speed < .0001) return;
  const scale = clamp(Math.min(view.w, view.h) / 540, .55, 3);
  const press = tool.strike;
  const dt = Math.min(.15, scale * (7 + 4*tool.travel + 9*press) / speed);
  const centre = alongEdge(cubic, u, view);
  const before = alongEdge(cubic, Math.max(0, u-dt), view);
  const after = alongEdge(cubic, Math.min(1, u+dt*.73), view);
  // Local pixel coordinates let the two impressions straddle a curved
  // rail by a fraction of a pixel when they are almost in register.
  const tx = dx / speed, ty = dy / speed;
  const x0 = (before.x-centre.x)*tx + (before.y-centre.y)*ty;
  const y0 = (before.y-centre.y)*tx - (before.x-centre.x)*ty;
  const x1 = (after.x-centre.x)*tx + (after.y-centre.y)*ty;
  const y1 = (after.y-centre.y)*tx - (after.x-centre.x)*ty;
  const offset = scale * (.58 + (2.3 + load) * press);
  ctx.save();
  ctx.scale(1 / view.w, 1 / view.h);
  ctx.translate(centre.x, centre.y);
  ctx.rotate(Math.atan2(dy, dx));
  ctx.globalAlpha *= tool.opacity * (.44 + .40*press);
  ctx.fillStyle = 'rgb(' + color.map(c => Math.round(c*.36)).join(',') + ')';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(0, 0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1, y1 + .63*offset);
  ctx.lineTo(0, offset);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgb(' + color.map(c => Math.round(lerp(c, 213, .34))).join(',') + ')';
  ctx.beginPath();
  ctx.moveTo(x0*.59, y0*.59);
  ctx.lineTo(0, -.54*offset);
  ctx.lineTo(x1*.78, y1*.78);
  ctx.lineTo(0, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
