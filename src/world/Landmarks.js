// Landmark geometry baked into the parallax silhouettes: an L-system
// engine plus biome-specific painters, drawn once into the L4/L5
// strip canvases at generation time -- infinite per-song variety at zero
// per-frame cost. This is what turns a palette into a place: JADE grows
// trees, ARCTIC crystals, SAKURA torii, CYBER lattice masts, VOID monoliths,
// EMBER spires, TWILIGHT menhirs, SOLAR obelisks, ABYSS chimneys, DUNE arches,
// CORAL fans, LUMEN mushrooms, AURUM sheaves, NEBULA floating isles.
import { mulberry32 } from '../utils/math.js';
import { ridgeYAt } from './SilhouetteGenerator.js';

/** Classic parallel-rewrite L-system expansion. */
export function expandLSystem(axiom, rules, iterations) {
  let s = axiom;
  for (let i = 0; i < iterations; i++) {
    let next = '';
    for (const ch of s) next += rules[ch] ?? ch;
    s = next;
  }
  return s;
}

/**
 * Interpret an L-system string as turtle graphics, returning line
 * segments instead of drawing -- pure and unit-testable. Understands
 * F (draw forward), + / - (turn), [ / ] (push/pop state). Depth is the
 * bracket nesting level, for stroke-width tapering.
 */
export function turtleSegments(program, {
  stepLen = 8, angleDeg = 22.5, startX = 0, startY = 0, startAngleDeg = -90, stepDecay = 1,
} = {}) {
  const segments = [];
  const stack = [];
  let x = startX, y = startY, ang = (startAngleDeg * Math.PI) / 180, len = stepLen, depth = 0;
  const turn = (angleDeg * Math.PI) / 180;
  for (const ch of program) {
    if (ch === 'F') {
      const nx = x + Math.cos(ang) * len, ny = y + Math.sin(ang) * len;
      segments.push({ x1: x, y1: y, x2: nx, y2: ny, depth });
      x = nx; y = ny;
    } else if (ch === '+') ang += turn;
    else if (ch === '-') ang -= turn;
    else if (ch === '[') { stack.push({ x, y, ang, len, depth }); depth++; len *= stepDecay; }
    else if (ch === ']') { ({ x, y, ang, len, depth } = stack.pop()); }
  }
  return segments;
}

// --- Painters: (ctx, x, rootY, scale, rand, color) -> void, silhouette-filled ---

function paintTree(iters, angle) {
  return (ctx, x, rootY, scale, rand, color) => {
    const program = expandLSystem('X', { X: 'F-[[X]+X]+F[+FX]-X', F: 'FF' }, iters);
    const segs = turtleSegments(program, {
      stepLen: 2.4 * scale, angleDeg: angle + (rand() * 6 - 3),
      startX: x, startY: rootY, startAngleDeg: -90 + (rand() * 10 - 5),
    });
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    for (const s of segs) {
      ctx.lineWidth = Math.max(0.9, (4.5 - s.depth) * 0.6 * scale);
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }
  };
}

function paintCrystals(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const n = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    // Wider, stubbier facets, and a short tip relative to the body -- the
    // old proportions (4-9px half-width against a body up to 85px tall,
    // topped with a tip facet stretched out to 2.2x that width again)
    // read as a bare needle at NearField's 3-5x foreground blowup, with
    // the long thin tip facet reading as a stray thread off the point.
    // A real crystal cluster is faceted and stout, not threadlike.
    const w = (9 + rand() * 9) * scale;
    const h = (26 + rand() * 40) * scale;
    const tilt = (rand() * 2 - 1) * 0.4;
    const cx = x + (i - n / 2) * 13 * scale;
    ctx.save();
    ctx.translate(cx, rootY);
    ctx.rotate(tilt);
    // Two shoulder facets before the tip, not one long taper straight to
    // a point -- reads as a faceted mineral rather than a cone.
    ctx.beginPath();
    ctx.moveTo(-w, 0);
    ctx.lineTo(-w * 0.62, -h * 0.55);
    ctx.lineTo(-w * 0.28, -h);
    ctx.lineTo(0, -h - w * 0.9); // the tip facet
    ctx.lineTo(w * 0.28, -h);
    ctx.lineTo(w * 0.62, -h * 0.55);
    ctx.lineTo(w, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function paintTorii(ctx, x, rootY, scale, rand, color) {
  const H = (62 + rand() * 16) * scale, span = 50 * scale, pw = 6 * scale;
  ctx.fillStyle = color;
  ctx.save();
  ctx.translate(x, rootY);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * span / 2 - pw / 2, 0);
    ctx.lineTo(side * span / 2 + pw / 2, 0);
    ctx.lineTo(side * span / 2 * 0.9 + pw / 2, -H);
    ctx.lineTo(side * span / 2 * 0.9 - pw / 2, -H);
    ctx.closePath();
    ctx.fill();
  }
  // Upper lintel, gently upswept at the ends; plain tie-beam below it.
  ctx.beginPath();
  ctx.moveTo(-span / 2 - 15 * scale, -H - 2 * scale);
  ctx.quadraticCurveTo(0, -H - 12 * scale, span / 2 + 15 * scale, -H - 2 * scale);
  ctx.lineTo(span / 2 + 13 * scale, -H + 5 * scale);
  ctx.quadraticCurveTo(0, -H - 4 * scale, -span / 2 - 13 * scale, -H + 5 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(-span / 2 - 4 * scale, -H + 13 * scale, span + 8 * scale, 5 * scale);
  ctx.restore();
}

function paintLatticeTower(ctx, x, rootY, scale, rand, color) {
  const H = (120 + rand() * 45) * scale;
  const halfBase = 20 * scale, halfTop = 4 * scale;
  const panels = 6;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7 * scale;
  ctx.beginPath();
  for (const side of [-1, 1]) {
    ctx.moveTo(x + side * halfBase, rootY);
    ctx.lineTo(x + side * halfTop, rootY - H);
  }
  for (let i = 0; i < panels; i++) {
    const t0 = i / panels, t1 = (i + 1) / panels;
    const w0 = halfBase + (halfTop - halfBase) * t0, w1 = halfBase + (halfTop - halfBase) * t1;
    const y0 = rootY - H * t0, y1 = rootY - H * t1;
    ctx.moveTo(x - w0, y0); ctx.lineTo(x + w1, y1);
    ctx.moveTo(x + w0, y0); ctx.lineTo(x - w1, y1);
  }
  ctx.moveTo(x, rootY - H);
  ctx.lineTo(x, rootY - H - 18 * scale); // antenna
  ctx.stroke();
}

function paintMonoliths(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const n = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < n; i++) {
    const w = (13 + rand() * 9) * scale, h = (55 + rand() * 55) * scale;
    const floatOff = i === n - 1 ? -(18 + rand() * 30) * scale : 0; // the last one levitates
    ctx.save();
    ctx.translate(x + (i - n / 2) * 30 * scale, rootY + floatOff);
    ctx.rotate((rand() * 2 - 1) * 0.14);
    ctx.fillRect(-w / 2, -h, w, h);
    ctx.restore();
  }
}

function paintSpires(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const n = 2 + Math.floor(rand() * 2);
  const SEGS = 6;
  for (let i = 0; i < n; i++) {
    const H = (55 + rand() * 60) * scale;
    const wBase = (17 + rand() * 9) * scale;
    const cx = x + (i - n / 2) * 26 * scale;
    // A real eroded rock spire doesn't summit dead center over its own
    // base -- offsetting the apex is what breaks the "cone" read a
    // dead-center peak always gives, regardless of how jagged its flanks
    // are.
    const apexX = cx + (rand() - 0.5) * wBase * 0.8;
    const left = [], right = [];
    for (let k = 0; k <= SEGS; k++) {
      const t = k / SEGS; // 0 at base, 1 at apex
      // Bulging taper -- widest through the lower-mid body, not a
      // straight-sided cone -- so the silhouette reads as a weathered
      // column, and per-side jitter so left/right never mirror each
      // other into a symmetric hat outline.
      const bodyW = wBase * Math.pow(1 - t, 0.8) * (0.82 + 0.32 * Math.sin(t * Math.PI));
      const midX = cx + (apexX - cx) * t;
      const y = rootY - H * t;
      left.push({ x: midX - bodyW * (0.5 + (rand() - 0.5) * 0.35), y });
      right.push({ x: midX + bodyW * (0.5 + (rand() - 0.5) * 0.35), y });
    }
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (let k = 1; k < left.length; k++) ctx.lineTo(left[k].x, left[k].y);
    ctx.lineTo(apexX, rootY - H);
    for (let k = right.length - 1; k >= 0; k--) ctx.lineTo(right[k].x, right[k].y);
    ctx.closePath();
    ctx.fill();
  }
}

function paintMenhirs(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const n = 5 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const w = (7 + rand() * 5) * scale, h = (16 + rand() * 18) * scale;
    ctx.save();
    ctx.translate(x + (i - n / 2) * 15 * scale, rootY);
    ctx.rotate((rand() * 2 - 1) * 0.1);
    ctx.fillRect(-w / 2, -h, w, h);
    ctx.restore();
  }
}

function paintRuinTower(ctx, x, rootY, scale, rand, color) {
  const H = (75 + rand() * 25) * scale, wB = 15 * scale, wT = 11 * scale;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - wB, rootY);
  ctx.lineTo(x - wT, rootY - H);
  // Broken crenellated top: three teeth, one shattered short.
  const teeth = [1, 0.45 + rand() * 0.3, 1];
  for (let i = 0; i < 3; i++) {
    const tx0 = x - wT + (i / 3) * 2 * wT, tx1 = x - wT + ((i + 0.6) / 3) * 2 * wT;
    ctx.lineTo(tx0, rootY - H - 7 * scale * teeth[i]);
    ctx.lineTo(tx1, rootY - H - 7 * scale * teeth[i]);
    ctx.lineTo(tx1, rootY - H);
  }
  ctx.lineTo(x + wT, rootY - H);
  ctx.lineTo(x + wB, rootY);
  ctx.closePath();
  ctx.fill();
}

function paintReeds(ctx, x, rootY, scale, rand, color) {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  const n = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const h = (18 + rand() * 22) * scale;
    const cx = x + (i - n / 2) * 4 * scale;
    const lean = (rand() * 2 - 1) * 6 * scale;
    ctx.lineWidth = Math.max(0.8, 1.4 * scale);
    ctx.beginPath();
    ctx.moveTo(cx, rootY);
    ctx.quadraticCurveTo(cx + lean * 0.5, rootY - h * 0.6, cx + lean, rootY - h);
    ctx.stroke();
  }
}

function paintObelisks(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  for (const side of [-1, 1]) {
    const H = (90 + rand() * 30) * scale, wB = 6 * scale, wT = 3.6 * scale;
    const cx = x + side * 22 * scale;
    ctx.beginPath();
    ctx.moveTo(cx - wB, rootY);
    ctx.lineTo(cx - wT, rootY - H);
    ctx.lineTo(cx, rootY - H - 9 * scale); // pyramidion
    ctx.lineTo(cx + wT, rootY - H);
    ctx.lineTo(cx + wB, rootY);
    ctx.closePath();
    ctx.fill();
  }
}

/** Hydrothermal chimneys / black smokers for ABYSS — stacked irregular stacks. */
function paintChimneys(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const n = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < n; i++) {
    const H = (50 + rand() * 70) * scale;
    const wB = (8 + rand() * 7) * scale;
    const wT = wB * (0.45 + rand() * 0.25);
    const cx = x + (i - (n - 1) / 2) * 22 * scale;
    const lean = (rand() * 2 - 1) * 0.12;
    ctx.save();
    ctx.translate(cx, rootY);
    ctx.rotate(lean);
    // Main stack body, slightly waisted mid-height.
    ctx.beginPath();
    ctx.moveTo(-wB, 0);
    ctx.lineTo(-wB * 0.85, -H * 0.45);
    ctx.lineTo(-wT, -H);
    ctx.lineTo(wT, -H);
    ctx.lineTo(wB * 0.85, -H * 0.45);
    ctx.lineTo(wB, 0);
    ctx.closePath();
    ctx.fill();
    // Flared vent lip + a short mineral plume silhouette above.
    const lip = wT * 1.55;
    ctx.beginPath();
    ctx.moveTo(-lip, -H);
    ctx.lineTo(-wT * 0.7, -H - 6 * scale);
    ctx.lineTo(wT * 0.7, -H - 6 * scale);
    ctx.lineTo(lip, -H);
    ctx.closePath();
    ctx.fill();
    const plumeH = (10 + rand() * 18) * scale;
    ctx.beginPath();
    ctx.moveTo(-wT * 0.35, -H - 5 * scale);
    ctx.quadraticCurveTo(-wT * 0.9, -H - plumeH * 0.55, -wT * 0.2, -H - plumeH);
    ctx.quadraticCurveTo(0, -H - plumeH * 0.7, wT * 0.2, -H - plumeH);
    ctx.quadraticCurveTo(wT * 0.9, -H - plumeH * 0.55, wT * 0.35, -H - 5 * scale);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/** Desert sandstone arch for DUNE. */
function paintArch(ctx, x, rootY, scale, rand, color) {
  const H = (55 + rand() * 40) * scale;
  const span = (36 + rand() * 20) * scale;
  const thick = (10 + rand() * 6) * scale;
  ctx.fillStyle = color;
  ctx.beginPath();
  // Outer horseshoe
  ctx.moveTo(x - span, rootY);
  ctx.lineTo(x - span - thick * 0.2, rootY - H * 0.55);
  ctx.quadraticCurveTo(x, rootY - H - thick, x + span + thick * 0.2, rootY - H * 0.55);
  ctx.lineTo(x + span, rootY);
  ctx.lineTo(x + span - thick, rootY);
  ctx.lineTo(x + span - thick * 0.85, rootY - H * 0.5);
  ctx.quadraticCurveTo(x, rootY - H + thick * 0.6, x - span + thick * 0.85, rootY - H * 0.5);
  ctx.lineTo(x - span + thick, rootY);
  ctx.closePath();
  ctx.fill();
}

/** Branching coral fan for CORAL. */
function paintCoralFan(ctx, x, rootY, scale, rand, color) {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  const branches = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < branches; i++) {
    const ang = -Math.PI / 2 + (i - (branches - 1) / 2) * 0.28 + (rand() * 0.12 - 0.06);
    const len = (28 + rand() * 36) * scale;
    ctx.lineWidth = Math.max(1.2, (3.2 - i * 0.15) * scale);
    ctx.beginPath();
    ctx.moveTo(x, rootY);
    const mx = x + Math.cos(ang) * len * 0.55 + (rand() * 2 - 1) * 4 * scale;
    const my = rootY + Math.sin(ang) * len * 0.55;
    const ex = x + Math.cos(ang) * len;
    const ey = rootY + Math.sin(ang) * len;
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();
    // Tip knobs
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ex, ey, 2.2 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Cluster of mushroom caps for LUMEN. */
function paintMushrooms(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const n = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const stemH = (14 + rand() * 28) * scale;
    const stemW = (2.5 + rand() * 2) * scale;
    const capR = (8 + rand() * 12) * scale;
    const cx = x + (i - (n - 1) / 2) * 16 * scale;
    // Stem
    ctx.fillRect(cx - stemW / 2, rootY - stemH, stemW, stemH);
    // Cap (half-ellipse dome)
    ctx.beginPath();
    ctx.ellipse(cx, rootY - stemH, capR, capR * 0.55, 0, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
  }
}

/** Harvest sheaves / grain stacks for AURUM. */
function paintSheaves(ctx, x, rootY, scale, rand, color) {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  const bundles = 3 + Math.floor(rand() * 2);
  for (let b = 0; b < bundles; b++) {
    const bx = x + (b - (bundles - 1) / 2) * 14 * scale;
    const stalks = 7 + Math.floor(rand() * 4);
    for (let i = 0; i < stalks; i++) {
      const lean = (i - stalks / 2) * 0.12 + (rand() * 0.08 - 0.04);
      const h = (22 + rand() * 18) * scale;
      ctx.lineWidth = Math.max(0.8, 1.3 * scale);
      ctx.beginPath();
      ctx.moveTo(bx, rootY);
      ctx.quadraticCurveTo(bx + lean * h * 0.4, rootY - h * 0.55, bx + Math.sin(lean) * h * 0.35, rootY - h);
      ctx.stroke();
    }
    // Binding band
    ctx.lineWidth = 1.6 * scale;
    ctx.beginPath();
    ctx.moveTo(bx - 5 * scale, rootY - 12 * scale);
    ctx.lineTo(bx + 5 * scale, rootY - 12 * scale);
    ctx.stroke();
  }
}

/** Floating rock isles for NEBULA. */
function paintFloatIsles(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const n = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < n; i++) {
    const floatY = -(20 + rand() * 50) * scale;
    const w = (18 + rand() * 22) * scale;
    const h = (8 + rand() * 10) * scale;
    const cx = x + (i - (n - 1) / 2) * 36 * scale;
    ctx.save();
    ctx.translate(cx, rootY + floatY);
    ctx.rotate((rand() * 2 - 1) * 0.15);
    // Craggy top, flat-ish underside
    ctx.beginPath();
    ctx.moveTo(-w, 0);
    ctx.lineTo(-w * 0.7, -h * 0.6);
    ctx.lineTo(-w * 0.2, -h);
    ctx.lineTo(w * 0.15, -h * 0.75);
    ctx.lineTo(w * 0.65, -h * 0.9);
    ctx.lineTo(w, -h * 0.2);
    ctx.lineTo(w * 0.7, h * 0.35);
    ctx.lineTo(-w * 0.5, h * 0.4);
    ctx.closePath();
    ctx.fill();
    // Tiny dangling spire under one isle
    if (rand() > 0.45) {
      ctx.beginPath();
      ctx.moveTo(-3 * scale, h * 0.3);
      ctx.lineTo(0, h * 0.3 + 12 * scale);
      ctx.lineTo(3 * scale, h * 0.3);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Hollow geode rind with inward-pointing crystal teeth for GEODE. */
function paintGeode(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const R = (22 + rand() * 16) * scale;
  const teeth = 7 + Math.floor(rand() * 4);
  // Outer stone shell (slightly flattened)
  ctx.beginPath();
  ctx.ellipse(x, rootY - R * 0.55, R * 1.15, R * 0.95, 0, 0, Math.PI * 2);
  ctx.fill();
  // Carve the hollow by overpainting is not available — instead draw the
  // cavity as a ring of facet spikes pointing inward from the rim.
  ctx.beginPath();
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const a1 = ((i + 0.5) / teeth) * Math.PI * 2;
    const a2 = ((i + 1) / teeth) * Math.PI * 2;
    const outer = R * (0.95 + rand() * 0.08);
    const inner = R * (0.35 + rand() * 0.2);
    const ox = x + Math.cos(a0) * outer * 0.9;
    const oy = rootY - R * 0.55 + Math.sin(a0) * outer * 0.75;
    const tipX = x + Math.cos(a1) * inner * 0.7;
    const tipY = rootY - R * 0.55 + Math.sin(a1) * inner * 0.55;
    const ox2 = x + Math.cos(a2) * outer * 0.9;
    const oy2 = rootY - R * 0.55 + Math.sin(a2) * outer * 0.75;
    if (i === 0) ctx.moveTo(ox, oy);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(ox2, oy2);
  }
  ctx.closePath();
  ctx.fill();
  // A few freestanding crystal shards beside the shell
  const shards = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < shards; i++) {
    const sx = x + (i - shards / 2) * 18 * scale + R * 0.9;
    const h = (16 + rand() * 22) * scale;
    const w = (3 + rand() * 3) * scale;
    ctx.beginPath();
    ctx.moveTo(sx - w, rootY);
    ctx.lineTo(sx - w * 0.4, rootY - h);
    ctx.lineTo(sx, rootY - h - w * 1.4);
    ctx.lineTo(sx + w * 0.4, rootY - h);
    ctx.lineTo(sx + w, rootY);
    ctx.closePath();
    ctx.fill();
  }
}

// --- Real biomes (RealBiomes.js). Stands, not single props: a forest is
// many trees, and a lone tree on a real skyline reads as a monument. ---

/** A stand of spruce/fir: narrow stacked cones on short trunks. */
function paintSpruceStand(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const n = 3 + Math.floor(rand() * 5);
  for (let i = 0; i < n; i++) {
    const tx = x + (i - n / 2) * (5 + rand() * 4) * scale;
    const h = (14 + rand() * 16) * scale;
    const w = h * (0.22 + rand() * 0.08);
    const tiers = 3;
    for (let k = 0; k < tiers; k++) {
      const base = rootY - h * (0.1 + k * 0.26);
      const top = base - h * (0.5 - k * 0.06);
      const half = w * (1 - k * 0.22);
      ctx.beginPath();
      ctx.moveTo(tx - half, base);
      ctx.lineTo(tx, top);
      ctx.lineTo(tx + half, base);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillRect(tx - 0.8 * scale, rootY - h * 0.12, 1.6 * scale, h * 0.14);
  }
}

/** Broad, flat-crowned pines and oaks: a few rounded crowns on trunks. */
function paintPineOak(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const n = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const tx = x + (i - n / 2) * (11 + rand() * 6) * scale;
    const h = (14 + rand() * 12) * scale;
    ctx.fillRect(tx - 1 * scale, rootY - h * 0.6, 2 * scale, h * 0.6);
    const lobes = 3 + Math.floor(rand() * 2);
    for (let k = 0; k < lobes; k++) {
      ctx.beginPath();
      ctx.ellipse(tx + (k - (lobes - 1) / 2) * 3.4 * scale, rootY - h * (0.72 + rand() * 0.12),
        (4 + rand() * 2.5) * scale, (3 + rand() * 1.5) * scale, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Low scrub: a run of rounded bushes hugging the ground (sage, chamise). */
function paintScrub(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const n = 4 + Math.floor(rand() * 5);
  for (let i = 0; i < n; i++) {
    const bx = x + (i - n / 2) * (6 + rand() * 5) * scale;
    const r = (2.2 + rand() * 2.6) * scale;
    ctx.beginPath();
    ctx.ellipse(bx, rootY - r * 0.55, r * 1.3, r, 0, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
  }
}

/** Saguaro: a column with one or two upturned arms. */
function paintSaguaro(ctx, x, rootY, scale, rand, color) {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  const h = (20 + rand() * 18) * scale;
  const w = 3.2 * scale;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x, rootY);
  ctx.lineTo(x, rootY - h);
  const arms = 1 + Math.floor(rand() * 2);
  for (let a = 0; a < arms; a++) {
    const side = a === 0 ? (rand() < 0.5 ? -1 : 1) : -1 * Math.sign(rand() - 2);
    const at = rootY - h * (0.35 + rand() * 0.2);
    const out = (5 + rand() * 3) * scale * side;
    ctx.moveTo(x, at);
    ctx.lineTo(x + out, at);
    ctx.lineTo(x + out, at - h * (0.25 + rand() * 0.15));
  }
  ctx.stroke();
}

/** Butte or mesa: a flat-topped block with talus slopes. */
function paintButte(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const H = (26 + rand() * 30) * scale;
  const top = (10 + rand() * 26) * scale;
  const talus = (12 + rand() * 8) * scale;
  const cliff = top * 0.08;
  ctx.beginPath();
  ctx.moveTo(x - top - talus, rootY);
  ctx.lineTo(x - top - cliff, rootY - H * 0.42);
  ctx.lineTo(x - top, rootY - H);
  ctx.lineTo(x + top, rootY - H);
  ctx.lineTo(x + top + cliff, rootY - H * 0.42);
  ctx.lineTo(x + top + talus, rootY);
  ctx.closePath();
  ctx.fill();
}

/** Tundra: scattered erratic boulders, nothing taller than a person. */
function paintBoulders(ctx, x, rootY, scale, rand, color) {
  ctx.fillStyle = color;
  const n = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const bx = x + (i - n / 2) * (9 + rand() * 6) * scale;
    const r = (2.5 + rand() * 3.5) * scale;
    ctx.beginPath();
    ctx.ellipse(bx, rootY - r * 0.5, r * (1.2 + rand() * 0.5), r, 0, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
  }
}

export const LANDMARKS = {
  JADE: [paintTree(4, 22.5)],
  ARCTIC: [paintCrystals],
  SAKURA: [paintTorii, paintTree(3, 25)],
  CYBER: [paintLatticeTower],
  VOID: [paintMonoliths],
  EMBER: [paintSpires],
  TWILIGHT: [paintMenhirs, paintRuinTower],
  SOLAR: [paintObelisks],
  STORM: [paintTree(3, 32)], // sparse wind-blasted trees
  MIRROR: [paintReeds], // lakeside reeds, low enough to keep the water reads clear
  ABYSS: [paintChimneys], // hydrothermal chimneys on the abyssal ridge
  DUNE: [paintArch],
  CORAL: [paintCoralFan],
  LUMEN: [paintMushrooms],
  AURUM: [paintSheaves, paintTree(3, 20)],
  NEBULA: [paintFloatIsles],
  GEODE: [paintGeode, paintCrystals],
  // Real biomes (RealBiomes.js). ICEFIELD has none: nothing grows there.
  TUNDRA: [paintBoulders],
  TAIGA: [paintSpruceStand],
  RAINFOREST: [paintSpruceStand, paintSpruceStand],
  CONIFER: [paintSpruceStand],
  PINE_OAK: [paintPineOak],
  BROADLEAF: [paintPineOak],
  CHAPARRAL: [paintScrub, paintPineOak],
  STEPPE: [paintScrub],
  CANYON: [paintButte, paintScrub],
  DESERT: [paintSaguaro, paintScrub],
};

/**
 * Sprinkle a biome's landmarks onto a generated silhouette strip. Each
 * one roots on the noise ridge at its own x (sunk a few px into the fill
 * so silhouettes merge seamlessly), kept clear of the strip's wrap seam.
 */
export function decorateStrip(strip, biomeName, seed, color, { count = 3, scale = 1 } = {}) {
  const painters = LANDMARKS[biomeName];
  if (!painters) return;
  const ctx = strip.getContext('2d');
  const rand = mulberry32(seed >>> 0 || 1);
  const margin = 120;
  const span = strip.width - margin * 2;
  for (let i = 0; i < count; i++) {
    const x = margin + ((i + 0.15 + rand() * 0.7) / count) * span;
    const rootY = ridgeYAt(strip, x) + 6;
    const painter = painters[Math.floor(rand() * painters.length)];
    painter(ctx, x, rootY, scale * (0.85 + rand() * 0.4), rand, color);
  }
}
