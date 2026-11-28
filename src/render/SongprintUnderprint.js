import { clamp, smoothstep } from '../utils/math.js';

// Registration depends on the ink at either side of the ray and pressure at
// the playhead. A quiet interval can occur anywhere in the recording.
export function inkRegistration(scan) {
  const rows = scan.rows;
  const inner = rows[Math.floor(rows.length * .24)];
  const outer = rows[Math.floor(rows.length * .76)];
  const load = scan.withAudio === false ? 0 : smoothstep(.04, .72, scan.sustained ?? 0);
  const tint = (inner.color[0] - outer.color[2]) / 255;
  const bias = .9 * tint + .7 * (inner.bend + outer.bend) + .55 * (inner.gap - outer.gap);
  return { load, roll: load * Math.tanh(bias) };
}

// Keep the ground in the same pigment family as the impression. Folding
// some of its chroma back into its own value leaves room for the bands above.
function stain(row, density) {
  const [r, g, b] = row.color;
  const gray = .25*r + .6*g + .15*b;
  return 'rgb(' + row.color.map(c => Math.round(11 + density * (.55*c + .45*gray))).join(',') + ')';
}

export function drawUnderprint(ctx, view, scan, { load, roll }) {
  const rows = scan.rows;
  const inner = rows[Math.floor(rows.length * .17)];
  const middle = rows[Math.floor(rows.length * .52)];
  const outer = rows[Math.floor(rows.length * .83)];
  const radius = Math.max(1e-6, rows[rows.length - 1].r1);
  const short = Math.min(view.w, view.h);
  const aspect = short / view.h;
  const level = .50 + .28 * (middle.r0 / radius - .5) + .11 * middle.bend;
  const slope = aspect * (.16 * Math.tanh(inner.gap - outer.gap) + .29 * (outer.color[2] - inner.color[0]) / 255);
  // The difference between the two pulls can be either sign. As they pass
  // one another a strip becomes flush, or reads as the back of the next one.
  const slip = aspect * (.025 * Math.tanh(middle.gap - 1) + .10 * roll);
  const x = [-.12, 0, 0, 0, 1.12], y = [], offset = [];
  const positions = [0, .21, .52, .79, 1];
  for (let i = 0; i < positions.length; i++) {
    const u = positions[i];
    const row = rows[Math.floor(u * (rows.length - 1))];
    const crossing = .5 * (row.r0 + row.r1) / radius;
    if (i > 0 && i < positions.length - 1) x[i] = .48 * u + .52 * crossing;
    y[i] = level + (x[i] - .5) * slope + aspect * (.12 * row.bend + .12 * (crossing - u));
    offset[i] = slip * (.40 + .60 * Math.tanh(row.gap)) + aspect * .027 * row.bend * load;
  }

  const ground = ctx.createLinearGradient(0, 0, 1, 1);
  ground.addColorStop(0, stain(inner, .16));
  ground.addColorStop(1, stain(outer, .25));
  ctx.fillStyle = ground;
  ctx.beginPath();
  ctx.rect(0, 0, 1, 1);
  ctx.fill();

  const pool = ctx.createLinearGradient(0, level - .2, 0, 1);
  pool.addColorStop(0, stain(middle, .32));
  pool.addColorStop(1, stain(outer, .18));
  // Re-use this exact deposit above the fold. What moves through it can
  // exchange foreground and background without drawing another outline.
  function printPool() {
    ctx.fillStyle = pool;
    ctx.beginPath();
    ctx.moveTo(x[0], y[0]);
    for (let i = 1; i < x.length; i++) ctx.lineTo(x[i], y[i]);
    ctx.lineTo(x.at(-1), 1.2);
    ctx.lineTo(x[0], 1.2);
    ctx.closePath();
    ctx.fill();
  }
  printPool();

  // Only part of the edge transfers. Both ends taper back into its path.
  ctx.fillStyle = stain(inner, clamp(.29 + .10 * middle.bend, .20, .38));
  ctx.beginPath();
  ctx.moveTo(x[0], y[0]);
  ctx.lineTo(x[1], y[1]);
  ctx.lineTo(x[2], y[2]);
  ctx.lineTo(x[3], y[3]);
  ctx.lineTo(x[2], y[2] + offset[2]);
  ctx.lineTo(x[1], y[1] + offset[1]);
  ctx.closePath();
  ctx.fill();
  return printPool;
}
