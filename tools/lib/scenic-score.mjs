// Scenic shot tours: the cheap CPU scorer (docs/scenic-tours.md, "score").
//
// Every candidate pose is judged from a small depth raster of the view's
// terrain (scenic-terrain.mjs depthRaster: view-space depth per pixel,
// Infinity = sky, hit points, tile presence, water, rays that left the grid).
// Nothing here renders; the shortlist is re-judged by the real renderer.
// Camera convention is occlusionBuffer's (terrain-bake.mjs): forward f =
// target - eye, right r = f x up, up u = r x f, row 0 at the top, pixel
// centres at +0.5; local axes X east, Y up, Z south, metres.
//
// Pose metrics (all fractions are of the whole frame unless noted):
//   terrainFrac/skyFrac/waterFrac  finite hits / sky (not edge) / water hits.
//   holeFrac      hits on tiles the package lacks plus rays that left the
//                 grid; above HOLE_MAX the pose can never ship.
//   nearFrac      depth < 600 m. foregroundFrac: lower-third pixels with
//                 depth < 2500 m, as a frame fraction (so at most 1/3).
//   skyline       per column the first non-sky row from the top (row01, 1 =
//                 no land in that column): mean/min/max, drama = std over
//                 columns, lift = clamp((0.45 - mean) / 0.45, 0, 1), how far
//                 the land rises above the frame's lower 55%.
//   layers        1 + depth jumps (neighbour ratio > 1.6) per column with
//                 terrain, averaged. A jump only counts when the far side runs
//                 on smoothly for another row, so grazing ground at the
//                 horizon (ratios 3, 1.7, 1.4 ...) is one layer, not three.
//   emptiness     largest 4-connected region of one class (sky, or a 10%
//                 log-depth bin), as a frame fraction.
//   subject       relief subjects (peaks, buttes, ridges ...): top, a flank
//                 arc at radius/2 and half height, a base arc at radius (arcs
//                 face the eye, +-75 deg, so a fully exposed peak is not half
//                 self-occluded; their radius is capped at 0.7x the eye's
//                 distance so they never land behind an eye inside the
//                 subject). Flat subjects (lake, valley, shore) sample their
//                 footprint instead: 24 points around polygonM, ~40 on a grid
//                 inside it and 5 along axisM (lakes), 9 along axisM and
//                 5 pairs across it at +-max(300 m, heightM) (valleys: floor
//                 and wall feet); without either, the disc of radiusM as a
//                 lake. Samples snap to the ground (+4 m) when a height
//                 sampler is given and drop by the raster's earth curvature
//                 when given its radius (the default depthRaster curves the
//                 terrain). A sample is visible when in frame and its depth
//                 <= 1.03 x the larger raster depth of its pixel and the one
//                 above (ground at a grazing angle changes depth by more than
//                 3% per row). visibleFrac = visible / all samples (relief) or
//                 / framed samples, at least 4 (flat: a lake wider than the
//                 frame or around the eye is judged on the part in view, and
//                 `size` on how much is in view). screenH/W = extent of the
//                 samples in front, clamped to the frame; size = screenH
//                 (relief) or max(screenW, screenH) (flat); centre = visual
//                 mass (visible samples, else all in front) in NDC; thirds /
//                 centred / placement = distance to the nearest thirds
//                 intersection / the centre / the nearest of {-1/3, 0, 1/3}
//                 per axis (a thirds line, the centre line or both), in frame
//                 units over the thirds-to-centre distance.
//
// Scores are products and weighted means of trapezoid bands, so each is
// bounded to 0..1 and monotone in every metric's distance from its band:
//   composition = (.26 T + .22 K + .14 F + .16 L + .12 E + .10 D)
//                 * (.3 + .7 min(T, K)) * N, and 0 when holeFrac > HOLE_MAX;
//                 an aerial with no sky (skyFrac < .02, terrain > .9) is
//                 .85 (.5 E' + .3 L' + .2 F) N instead (structure, not skyline)
//     T terrain 35-85%, K skyline row 0.25-0.6, F foreground 5-35% (wide and
//     normal lenses; 1 for tele), L layers 2-4, E 1 - ramp(emptiness .6..
//     .9), D drama ramp 0..0.06, N 1 - ramp(nearFrac, allow, allow + .3)
//     with allow .4 for valley/crest moves, .2 otherwise.
//   subjectScore = V * (.15 + .85 S) * (.4 + .6 P)
//     V ramp(visibleFrac 0..0.6), S screen height 0.12-0.55 (relief) or
//     ramp(size, .05, .3) (flat), P 1 - ramp(placement, .25, 1) (thirds
//     lines, intersections and the centre all fine).
//   depthScore = .45 L + .25 ramp(foreground 0..0.08) + .15 D + .15 ramp(lift 0..0.3)
//
// Path terms, from samples every everyM of progress plus the ends, payoffS
// and holdS (sample score = .5 composition + .3 subject + .2 depth for
// shots, .75 composition + .25 depth for links):
//   flow      per sample: flowAt over an 8 m progress step; the lane is
//             interpolated to every path sample, floored at that path
//             segment's rotation term and at 1e-6 (never zero, always finite).
//   parallax  mean of ramp(p90 - p10 of the translational image motion --
//             each hit's motion minus that of its ray at infinity, so pans
//             and zooms add nothing -- per progress metre, 0, PARALLAX_REF).
//   reveal    v = visibleFrac * min(1, size / REVEAL_SIZE); 0.6 *
//             (v(payoff) - v(start)) + 0.4 * (1 - mean v over the first 30%
//             before the payoff) * subjectScore(payoff), clamped to 0..1.
//   payoff    composition * subject at payoffS; hold: its mean over holdS.
//   weakest   minimum over sliding windows (15% of the length) of the mean
//             sample score. holes: max holeFrac (missingTiles listed).
//   signature heading histogram (12 bins, bin k centred on k*30 deg
//             clockwise from north, sums to 1), mean eye AGL, mean
//             horizontal eye-subject distance (median terrain depth for links).
// Aggregates (SHOT_WEIGHTS / LINK_WEIGHTS below, all terms 0..1):
//   shot total = sum(weight * term) * weak * holes * comfort, where
//     weak    = .5 + .5 ramp(weakest, 0, WEAK_OK): a weak stretch costs up
//               to half the shot;
//     holes   = 0 above HOLE_MAX, else 1 - .5 holes / HOLE_MAX;
//     comfort = 1 - ramp(minSpeed * maxFlow, flowMax, 2 flowMax): even the
//               slowest allowed speed would move the picture too fast.
//   payoff and hold carry 46% of the weight; reveal and parallax are pure
//   rewards. Links drop every subject/payoff term.
import { pathPoseAt, lookDir, headingPitch } from '../../src/world/terrain/ShotPath.js';
import { sampleHeight } from './terrain-source.mjs';
// scenic-terrain.mjs supplies only the default raster: a caller passing
// opts.raster (tests, tools) does not need it to load.
const terrain = await import('./scenic-terrain.mjs').catch((loadError) => ({ loadError }));

export const NEAR_M = 20;          // Range camera near plane
export const HOLE_MAX = 0.002;     // larger hole fractions zero composition and totals
export const SHOT_WEIGHTS = Object.freeze({ payoff: .28, hold: .18, composition: .12, subject: .08, depth: .06, reveal: .12, parallax: .08, weakest: .08 });
export const LINK_WEIGHTS = Object.freeze({ composition: .5, depth: .15, parallax: .1, weakest: .25 });
export const WEAK_OK = 0.3;        // window mean sample score that costs nothing
export const REVEAL_SIZE = 0.25;   // subject size (screen height; flat: larger extent) that counts as fully framed for reveal
export const PARALLAX_REF = 1e-3;  // near-far translational image motion (rad per progress metre) that counts as full parallax
const NEAR_FRAC_M = 600, FOREGROUND_M = 2500, LAYER_RATIO = 1.6, EMPTY_BIN = Math.log(1.1), SLACK = 1.03;
const FLOW_STEP_M = 8, FLOW_FLOOR = 1e-6, FLAT_KINDS = new Set(['lake', 'valley', 'shore']), FLAT_MIN = 4;
const THIRD = 1 / 3, THIRD_NORM = Math.hypot(1 / 6, 1 / 6), DEG = Math.PI / 180;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ramp = (v, a, b) => clamp((v - a) / (b - a), 0, 1);
/** Trapezoid: 0 at a, 1 on [b, c], 0 at d. */
const band = (v, a, b, c, d) => (v <= b ? ramp(v, a, b) : 1 - ramp(v, c, d));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** Nearest-rank percentile of a sorted array. */
const pct = (sorted, q) => sorted[clamp(Math.ceil(q * sorted.length) - 1, 0, sorted.length - 1)];

/** Lens class of a vertical FOV (midpoints of the config's 16/26/36 deg). */
export const lensOf = (fovYDeg) => (fovYDeg <= 21 ? 'tele' : fovYDeg >= 31 ? 'wide' : 'normal');

function camera(pose, aspect) {
  const e = pose.eyeM, fx = pose.targetM[0] - e[0], fy = pose.targetM[1] - e[1], fz = pose.targetM[2] - e[2];
  const fl = Math.hypot(fx, fy, fz) || 1, f = [fx / fl, fy / fl, fz / fl];
  const rl = Math.hypot(f[2], f[0]) || 1, r = [-f[2] / rl, 0, f[0] / rl];
  const u = [-r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1]];
  return { e, f, r, u, t: Math.tan(pose.fovYDeg * DEG / 2), aspect };
}
/** Camera-space [right, up, forward] of a world point. */
function toCam(c, x, y, z) {
  const dx = x - c.e[0], dy = y - c.e[1], dz = z - c.e[2];
  return [dx * c.r[0] + dy * c.r[1] + dz * c.r[2], dx * c.u[0] + dy * c.u[1] + dz * c.u[2], dx * c.f[0] + dy * c.f[1] + dz * c.f[2]];
}
/** Angle between tangent-plane points (ax, ay, 1) and (bx, by, 1). */
function tanAngle(ax, ay, bx, by) {
  const cx = ay - by, cy = bx - ax, cz = ax * by - ay * bx;
  return Math.atan2(Math.hypot(cx, cy, cz), ax * bx + ay * by + 1);
}

/** `n` points evenly spaced by arc length around a closed loop [[x, z]...]. */
function loopPoints(loop, n) {
  const m = loop.length, seg = loop.map((p, i) => Math.hypot(loop[(i + 1) % m][0] - p[0], loop[(i + 1) % m][1] - p[1]));
  const total = seg.reduce((a, b) => a + b, 0), out = [];
  for (let k = 0, i = 0, acc = 0; k < n; k++) {
    const at = (k / n) * total;
    while (i < m - 1 && acc + seg[i] < at) acc += seg[i++];
    const p = loop[i], q = loop[(i + 1) % m], t = seg[i] ? (at - acc) / seg[i] : 0;
    out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
  }
  return out;
}

/** Even-odd point-in-polygon test. */
function insideLoop(loop, x, z) {
  let c = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, zi] = loop[i], [xj, zj] = loop[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** A flat subject's footprint [[x, z]...] (cached per subject object):
 *  a lake's polygonM (else, without an axis either, a 24-gon of radiusM)
 *  as 24 shore points and about 40 grid points inside, plus 5 along axisM;
 *  a valley's axisM as 9 floor points and pairs across it at +-max(300 m,
 *  heightM) (the walls' scale) at every other one. */
const footprints = new WeakMap();
function footprint(subject) {
  if (footprints.has(subject)) return footprints.get(subject);
  const [x, , z] = subject.posM, R = subject.radiusM || 300, ax = subject.axisM?.length === 2 ? subject.axisM : null, foot = [];
  const poly = subject.polygonM?.length >= 3 ? subject.polygonM
    : ax ? null : Array.from({ length: 24 }, (_, i) => [x + Math.cos(i * Math.PI / 12) * R, z + Math.sin(i * Math.PI / 12) * R]);
  if (poly) {
    foot.push(...loopPoints(poly, 24));
    let area = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    poly.forEach(([px, pz], i) => {
      const [qx, qz] = poly[(i + 1) % poly.length];
      area += (px * qz - qx * pz) / 2;
      x0 = Math.min(x0, px); x1 = Math.max(x1, px); z0 = Math.min(z0, pz); z1 = Math.max(z1, pz);
    });
    // ~40 cells over the area, at most ~4000 candidates for a thin diagonal loop.
    const step = Math.max(Math.sqrt(Math.abs(area) / 40), Math.sqrt(((x1 - x0) * (z1 - z0)) / 4000), 1e-6);
    for (let gz = z0 + step / 2; gz < z1; gz += step) for (let gx = x0 + step / 2; gx < x1; gx += step) if (insideLoop(poly, gx, gz)) foot.push([gx, gz]);
  }
  if (ax) {
    const k = poly ? 4 : 8, dx = ax[1][0] - ax[0][0], dz = ax[1][1] - ax[0][1], l = Math.hypot(dx, dz) || 1;
    const w = poly ? 0 : Math.max(300, subject.heightM || 0), wx = (-dz / l) * w, wz = (dx / l) * w;
    for (let i = 0; i <= k; i++) {
      const px = ax[0][0] + dx * i / k, pz = ax[0][1] + dz * i / k;
      foot.push([px, pz]);
      if (w && i % 2 === 0) foot.push([px + wx, pz + wz], [px - wx, pz - wz]);
    }
  }
  footprints.set(subject, foot);
  return foot;
}

/** Subject sample points for a pose (see the header): relief subjects get
 *  the top and two eye-facing arcs, flat ones their footprint.
 *  `subject.samplesM` overrides; `groundAt(x, z)` snaps points onto the
 *  terrain (+4 m). */
export function subjectSamples(subject, eyeM, groundAt = null) {
  if (Array.isArray(subject.samplesM)) return subject.samplesM;
  const [x, y, z] = subject.posM, R = subject.radiusM || 300;
  const snap = (px, pz, fallback) => { const g = groundAt ? groundAt(px, pz) : NaN; return [px, Number.isFinite(g) ? g + 4 : fallback, pz]; };
  if (FLAT_KINDS.has(subject.kind)) return footprint(subject).map(([px, pz]) => snap(px, pz, y));
  const relief = Math.max(0, subject.heightM ?? 200), Rs = Math.min(R, 0.7 * Math.hypot(eyeM[0] - x, eyeM[2] - z));
  const toward = Math.atan2(eyeM[2] - z, eyeM[0] - x), pts = [[x, y, z]];
  for (const [rf, hf] of [[0.5, 0.5], [1, 1]]) {
    for (let k = -2; k <= 2; k++) {
      const a = toward + k * 37.5 * DEG;
      pts.push(snap(x + Math.cos(a) * Rs * rf, z + Math.sin(a) * Rs * rf, y - relief * hf));
    }
  }
  return pts;
}

/** Distance (NDC) to the nearest of -1/3, 0, 1/3. */
const toLine = (v) => Math.min(Math.abs(v + THIRD), Math.abs(v), Math.abs(v - THIRD));

function subjectMetrics(raster, cam, samples, curvatureRadiusM, flat = false) {
  const { width: W, height: H, depth } = raster;
  let front = 0, framed = 0, visible = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  let mx = 0, my = 0, vx = 0, vy = 0;
  for (const p of samples) {
    // depthRaster lowers terrain by d^2 / 2R (refracted earth curvature).
    const drop = curvatureRadiusM ? ((p[0] - cam.e[0]) ** 2 + (p[2] - cam.e[2]) ** 2) / (2 * curvatureRadiusM) : 0;
    const [x, y, z] = toCam(cam, p[0], p[1] - drop, p[2]);
    if (z < NEAR_M) continue;
    const nx = x / (z * cam.t * cam.aspect), ny = y / (z * cam.t), cx = clamp(nx, -1, 1), cy = clamp(ny, -1, 1);
    front++; mx += cx; my += cy;
    x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
    if (cx !== nx || cy !== ny) continue;
    framed++;
    // A ground point in the upper half of its pixel lies beyond the depth of
    // that pixel's centre ray but short of the row above's: allow the larger.
    const px = clamp(Math.floor((nx * 0.5 + 0.5) * W), 0, W - 1), py = clamp(Math.floor((0.5 - ny * 0.5) * H), 0, H - 1);
    const i = py * W + px, d = py > 0 ? Math.max(depth[i], depth[i - W]) : depth[i];
    if (z <= d * SLACK) { visible++; vx += nx; vy += ny; }
  }
  // Flat: judged on the framed part, but fewer than FLAT_MIN framed samples
  // is a subject barely in frame.
  const n = flat ? Math.max(framed, Math.min(FLAT_MIN, samples.length)) : samples.length;
  if (!front) return { flat, inFrame: false, visibleFrac: 0, screenH: 0, screenW: 0, size: 0, centerX: null, centerY: null, thirds: null, centred: null, placement: null };
  const cx = visible ? vx / visible : mx / front, cy = visible ? vy / visible : my / front;
  const tx = cx < 0 ? -THIRD : THIRD, ty = cy < 0 ? -THIRD : THIRD, screenH = (y1 - y0) / 2, screenW = (x1 - x0) / 2;
  return {
    flat, inFrame: flat ? framed >= Math.min(FLAT_MIN, samples.length) : framed >= n / 2, visibleFrac: n ? visible / n : 0,
    screenH, screenW, size: flat ? Math.max(screenW, screenH) : screenH, centerX: cx, centerY: cy,
    thirds: Math.hypot((cx - tx) / 2, (cy - ty) / 2) / THIRD_NORM,
    centred: Math.hypot(cx / 2, cy / 2) / THIRD_NORM,
    placement: Math.hypot(toLine(cx) / 2, toLine(cy) / 2) / THIRD_NORM,
  };
}

/**
 * Composition metrics of one pose from its depth raster (see the header).
 * `subject` {posM, radiusM, heightM, kind, samplesM?}; `subjects` adds
 * `othersVisible` (other subjects whose top is visible); `groundAt(x, z)`
 * snaps subject arcs to the terrain.
 */
export function poseMetrics(raster, pose, { subject = null, subjects = null, aspect = null, groundAt = null, curvatureRadiusM = null } = {}) {
  const { width: W, height: H, depth, present = null, water = null, edge = null, tile = null } = raster, n = W * H;
  const cam = camera(pose, aspect ?? W / H);
  const cls = new Int32Array(n), finite = [], missing = new Set();
  const lowRow = Math.round(H * 2 / 3);
  let terrain = 0, sky = 0, holes = 0, wet = 0, near = 0, fg = 0;
  for (let i = 0; i < n; i++) {
    const d = depth[i], hit = d < Infinity, hole = !!edge?.[i] || (hit && present != null && !present[i]);
    if (hit) {
      terrain++; finite.push(d);
      if (water?.[i]) wet++;
      if (d < NEAR_FRAC_M) near++;
      if (d < FOREGROUND_M && i >= lowRow * W) fg++;
    } else if (!edge?.[i]) sky++;
    if (hole) { holes++; if (tile?.[i] >= 0) missing.add(tile[i]); }
    cls[i] = hole ? -2 : hit ? Math.floor(Math.log(Math.max(1, d)) / EMPTY_BIN) : -1;
  }
  // Skyline and layers, column by column.
  const rows = new Float64Array(W);
  let layerSum = 0, layerCols = 0;
  for (let c = 0; c < W; c++) {
    let r = 0;
    while (r < H && !(depth[r * W + c] < Infinity) && !edge?.[r * W + c]) r++;
    rows[c] = r / H;
    let jumps = 0, any = false;
    for (let y = H - 1; y >= 0; y--) {
      const a = depth[y * W + c];
      if (!(a < Infinity)) continue;
      any = true;
      if (y < 1) break;
      const b = depth[(y - 1) * W + c];
      if (!(b < Infinity) || Math.max(a, b) / Math.min(a, b) <= LAYER_RATIO) continue;
      const above = y >= 2 ? depth[(y - 2) * W + c] : Infinity;
      if (above < Infinity && Math.max(b, above) / Math.min(b, above) <= LAYER_RATIO) jumps++;
    }
    if (any) { layerSum += 1 + jumps; layerCols++; }
  }
  const meanRow = rows.reduce((a, b) => a + b, 0) / W;
  const drama = Math.sqrt(rows.reduce((a, r) => a + (r - meanRow) ** 2, 0) / W);
  // Emptiness: largest 4-connected same-class region (explicit stack).
  const seen = new Uint8Array(n), stack = new Int32Array(n);
  let largest = 0;
  for (let i = 0; i < n; i++) {
    if (seen[i] || cls[i] === -2) continue;
    const k = cls[i];
    let top = 0, size = 0;
    stack[top++] = i; seen[i] = 1;
    while (top) {
      const j = stack[--top], x = j % W;
      size++;
      for (const m of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, j - W, j + W]) {
        if (m >= 0 && m < n && !seen[m] && cls[m] === k) { seen[m] = 1; stack[top++] = m; }
      }
    }
    if (size > largest) largest = size;
  }
  finite.sort((a, b) => a - b);
  let othersVisible = 0;
  for (const o of subjects || []) {
    if (o === subject || (subject?.id != null && o.id === subject.id)) continue;
    if (subjectMetrics(raster, cam, [o.posM], curvatureRadiusM).visibleFrac > 0) othersVisible++;
  }
  return {
    fovYDeg: pose.fovYDeg, aspect: cam.aspect,
    terrainFrac: terrain / n, skyFrac: sky / n, holeFrac: holes / n, missingTiles: [...missing].sort((a, b) => a - b), waterFrac: wet / n,
    nearFrac: near / n, foregroundFrac: fg / n, medianDepthM: finite.length ? finite[finite.length >> 1] : null,
    skyline: { meanRow01: meanRow, minRow01: Math.min(...rows), maxRow01: Math.max(...rows), drama, lift: clamp((0.45 - meanRow) / 0.45, 0, 1) },
    layers: layerCols ? layerSum / layerCols : 0,
    subject: subject ? subjectMetrics(raster, cam, subjectSamples(subject, pose.eyeM, groundAt), curvatureRadiusM, FLAT_KINDS.has(subject.kind)) : null,
    othersVisible, emptiness: largest / n, horizonTilt: 0,
  };
}

/** Frame composition 0..1 (header formula); 0 with holes above HOLE_MAX. */
export function composition(m, { lens = null, move = null } = {}) {
  if (!(m.holeFrac <= HOLE_MAX)) return 0;
  const allowNear = move === 'valley' || move === 'crest' ? 0.4 : 0.2;
  // An aerial looking down has no sky by design (over open country it must:
  // the grid's crop edge lies below the horizon). Judge its structure --
  // depth layers, no large empty region, some foreground -- not a skyline,
  // keeping a slight preference for frames that hold the horizon.
  if (m.skyFrac < 0.02 && m.terrainFrac > 0.9) {
    const E = 1 - ramp(m.emptiness, 0.5, 0.85), L = band(m.layers, 1, 1.4, 3.5, 6);
    const F = (lens ?? lensOf(m.fovYDeg)) === 'tele' ? 1 : band(m.foregroundFrac, 0, 0.05, 0.33, 0.34);
    return 0.85 * (0.5 * E + 0.3 * L + 0.2 * F) * (1 - ramp(m.nearFrac, allowNear, allowNear + 0.3));
  }
  const T = band(m.terrainFrac, 0.1, 0.35, 0.85, 0.98);
  const K = band(m.skyline.meanRow01, 0.05, 0.25, 0.6, 0.85);
  const F = (lens ?? lensOf(m.fovYDeg)) === 'tele' ? 1 : band(m.foregroundFrac, 0, 0.05, 0.35, 0.6);
  const L = band(m.layers, 1, 2, 4, 7), E = 1 - ramp(m.emptiness, 0.6, 0.9), D = ramp(m.skyline.drama, 0, 0.06);
  const N = 1 - ramp(m.nearFrac, allowNear, allowNear + 0.3);
  return (0.26 * T + 0.22 * K + 0.14 * F + 0.16 * L + 0.12 * E + 0.10 * D) * (0.3 + 0.7 * Math.min(T, K)) * N;
}

/** Subject framing 0..1 (header formula); 0 without a subject. */
export function subjectScore(m) {
  const s = m.subject;
  if (!s || s.centerX == null) return 0;
  const V = ramp(s.visibleFrac, 0, 0.6), S = s.flat ? ramp(s.size, 0.05, 0.3) : band(s.screenH, 0.02, 0.12, 0.55, 0.9);
  const P = 1 - ramp(s.placement, 0.25, 1);
  return V * (0.15 + 0.85 * S) * (0.4 + 0.6 * P);
}

/** Depth richness 0..1 (header formula). */
export function depthScore(m) {
  return 0.45 * band(m.layers, 1, 2, 4, 7) + 0.25 * ramp(m.foregroundFrac, 0, 0.08)
    + 0.15 * ramp(m.skyline.drama, 0, 0.06) + 0.15 * ramp(m.skyline.lift, 0, 0.3);
}

/** 95th-percentile image motion (radians, in A's lens units) of points at
 *  infinity on a 16x9 grid: the pure rotation (and zoom) term. */
function rotationMotion(camA, camB) {
  const k = camA.t / camB.t, out = new Float64Array(144);
  let i = 0;
  for (let gy = 0; gy < 9; gy++) for (let gx = 0; gx < 16; gx++) {
    const ax = ((gx + 0.5) / 16 * 2 - 1) * camA.t * camA.aspect, ay = (1 - (gy + 0.5) / 9 * 2) * camA.t;
    const w = [camA.r[0] * ax + camA.u[0] * ay + camA.f[0], camA.r[1] * ax + camA.u[1] * ay + camA.f[1], camA.r[2] * ax + camA.u[2] * ay + camA.f[2]];
    const bz = w[0] * camB.f[0] + w[1] * camB.f[1] + w[2] * camB.f[2];
    out[i++] = bz <= 1e-6 ? Math.PI / 2 : tanAngle(ax, ay,
      k * (w[0] * camB.r[0] + w[1] * camB.r[1] + w[2] * camB.r[2]) / bz, k * (w[0] * camB.u[0] + w[1] * camB.u[1] + w[2] * camB.u[2]) / bz);
  }
  return pct(out.sort(), 0.95);
}

/** Image motion of every terrain hit of raster A between poses A and B:
 *  the angle between the hit's direction in A and in B (B scaled to A's
 *  lens, so zoom counts). Sorted motions plus the rotation term. */
function motionField(raster, poseA, poseB) {
  const { width: W, height: H, depth, hitX = null, hitY = null, hitZ = null } = raster, n = W * H;
  const camA = camera(poseA, W / H), camB = camera(poseB, W / H), k = camA.t / camB.t;
  const motion = new Float32Array(n), shift = new Float32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const d = depth[i];
    if (!(d < Infinity)) continue;
    let ax, ay, p;
    // Hit lanes can be NaN (no-data cells): rebuild the point from depth.
    if (hitX && Number.isFinite(hitX[i]) && Number.isFinite(hitY[i]) && Number.isFinite(hitZ[i])) {
      p = [hitX[i], hitY[i], hitZ[i]];
      const a = toCam(camA, p[0], p[1], p[2]);
      if (!(a[2] >= 1e-3)) continue;
      ax = a[0] / a[2]; ay = a[1] / a[2];
    } else {
      ax = (((i % W) + 0.5) / W * 2 - 1) * camA.t * camA.aspect; ay = (1 - ((((i / W) | 0) + 0.5) / H) * 2) * camA.t;
      p = [0, 1, 2].map((j) => camA.e[j] + (camA.r[j] * ax + camA.u[j] * ay + camA.f[j]) * d);
    }
    const b = toCam(camB, p[0], p[1], p[2]);
    if (!(b[2] >= 1)) continue;
    const bx = k * b[0] / b[2], by = k * b[1] / b[2], v = tanAngle(ax, ay, bx, by);
    if (!Number.isFinite(v)) continue;
    // Translational part: offset from where the same ray at infinity lands.
    const w = [0, 1, 2].map((j) => camA.r[j] * ax + camA.u[j] * ay + camA.f[j]);
    const iz = w[0] * camB.f[0] + w[1] * camB.f[1] + w[2] * camB.f[2];
    shift[m] = iz > 1e-6 ? Math.hypot(bx - k * (w[0] * camB.r[0] + w[1] * camB.r[1] + w[2] * camB.r[2]) / iz, by - k * (w[0] * camB.u[0] + w[1] * camB.u[1] + w[2] * camB.u[2]) / iz) : 0;
    motion[m++] = v;
  }
  return { sorted: motion.subarray(0, m).sort(), shift: shift.subarray(0, m).sort(), rotation: rotationMotion(camA, camB) };
}

/**
 * Optical flow of a pose change: 95th percentile of the terrain hits' image
 * motion (floored at the pure rotation term, which is all the sky shows),
 * divided by the progress distance `ds`. Radians per progress metre.
 */
export function flowAt(rasterA, poseA, poseB, ds) {
  const { sorted, rotation } = motionField(rasterA, poseA, poseB);
  return Math.max(sorted.length ? pct(sorted, 0.95) : 0, rotation) / Math.max(1e-6, ds);
}

const sampleQuality = (q, shot) => (shot ? 0.5 * q.composition + 0.3 * q.subject + 0.2 * q.depth : 0.75 * q.composition + 0.25 * q.depth);

/** Minimum over sliding windows (`frac` of the length) of the mean of a
 *  piecewise-linear lane, on a uniform 64-point resampling. */
function weakestWindow(xs, ys, frac = 0.15) {
  if (xs.length === 1) return ys[0];
  const N = 64, a = xs[0], b = xs[xs.length - 1], u = new Float64Array(N);
  for (let i = 0, j = 0; i < N; i++) {
    const x = a + (b - a) * i / (N - 1);
    while (j < xs.length - 2 && xs[j + 1] < x) j++;
    u[i] = ys[j] + (ys[j + 1] - ys[j]) * clamp((x - xs[j]) / Math.max(1e-9, xs[j + 1] - xs[j]), 0, 1);
  }
  const w = Math.max(1, Math.round(frac * N));
  let sum = 0, worst = Infinity;
  for (let i = 0; i < N; i++) {
    sum += u[i];
    if (i >= w) sum -= u[i - w];
    if (i >= w - 1) worst = Math.min(worst, sum / w);
  }
  return worst;
}

function scoreAlong(ctx, path, opts, shot) {
  const { subject = null, subjects = null, lens = null, move = null, everyM = 60, width = 128, height = 72, motion = {} } = opts;
  if (!opts.raster && terrain.loadError) throw terrain.loadError;
  const rasterOf = opts.raster ?? ((pose, o) => terrain.depthRaster(ctx, pose, o));
  const curvatureRadiusM = opts.curvatureRadiusM ?? (opts.raster ? null : terrain.CURVATURE_RADIUS_M);
  const groundAt = opts.groundAt ?? (ctx?.grid ? (x, z) => sampleHeight(ctx.grid, x, z) : null);
  const { s } = path, n = s.length, s0 = s[0], s1 = s[n - 1], len = s1 - s0;
  const payoffS = clamp(opts.payoffS ?? s0 + len / 2, s0, s1);
  const holdS = (opts.holdS ?? [payoffS - 0.1 * len, payoffS + 0.1 * len]).map((v) => clamp(v, s0, s1));
  // Scored positions: every `everyM`, the ends, and (shots) payoff and hold
  // bounds exactly, so those terms are measured rather than interpolated.
  const forced = shot ? [s0, s1, payoffS, holdS[0], holdS[1]] : [s0, s1];
  const marks = [...forced];
  for (let x = s0 + everyM; x < s1; x += everyM) if (forced.every((f) => Math.abs(f - x) > 1)) marks.push(x);
  const xs = [...new Set(marks)].sort((a, b) => a - b);
  const step = Math.min(FLOW_STEP_M, len / 2);
  const samples = xs.map((x) => {
    const pose = pathPoseAt(path, x), back = x + step > s1, poseB = pathPoseAt(path, back ? x - step : x + step);
    const raster = rasterOf(pose, { width, height });
    const metrics = poseMetrics(raster, pose, { subject, subjects, groundAt, curvatureRadiusM });
    const { sorted, shift, rotation } = motionField(raster, pose, poseB);
    const spread = shift.length >= 8 ? (pct(shift, 0.9) - pct(shift, 0.1)) / Math.max(1e-6, step) : 0;
    const q = {
      s: x, metrics, missingTiles: metrics.missingTiles,
      composition: composition(metrics, { lens: lens ?? lensOf(pose.fovYDeg), move }),
      subject: subjectScore(metrics), depth: depthScore(metrics),
      flow: Math.max(sorted.length ? pct(sorted, 0.95) : 0, rotation) / Math.max(1e-6, step),
      parallax: ramp(spread, 0, PARALLAX_REF),
    };
    q.score = sampleQuality(q, shot);
    return q;
  });
  // Flow lane: scored flow interpolated to every path sample, floored at the
  // path's own rotation term between neighbouring samples (never zero).
  const flow = new Float32Array(n), poseOf = (i) => ({ eyeM: [...path.eye.subarray(i * 3, i * 3 + 3)], targetM: [...path.aim.subarray(i * 3, i * 3 + 3)], fovYDeg: path.fov[i] });
  for (let i = 0, j = 0; i < n; i++) {
    while (j < samples.length - 2 && samples[j + 1].s < s[i]) j++;
    const a = samples[j], b = samples[Math.min(j + 1, samples.length - 1)];
    const lerp = b.s > a.s ? a.flow + (b.flow - a.flow) * clamp((s[i] - a.s) / (b.s - a.s), 0, 1) : a.flow;
    const i0 = i < n - 1 ? i : i - 1, aspect = width / height;
    const rot = rotationMotion(camera(poseOf(i0), aspect), camera(poseOf(i0 + 1), aspect)) / Math.max(1e-6, s[i0 + 1] - s[i0]);
    const v = Math.max(lerp, rot, FLOW_FLOOR);
    flow[i] = Number.isFinite(v) ? v : Math.max(Number.isFinite(rot) ? rot : 0, FLOW_FLOOR);
  }
  const at = (x) => samples.find((q) => q.s === x);
  const weakest = weakestWindow(xs, samples.map((q) => q.score));
  const holes = Math.max(...samples.map((q) => q.metrics.holeFrac));
  const missingTiles = [...new Set(samples.flatMap((q) => q.missingTiles))].sort((a, b) => a - b);
  const flowMax = Math.max(...samples.map((q) => q.flow));
  const comfort = 1 - ramp((motion.minSpeedMps ?? 4) * flowMax, motion.flowEnergetic ?? 0.24, 2 * (motion.flowEnergetic ?? 0.24));
  const factor = (0.5 + 0.5 * ramp(weakest, 0, WEAK_OK)) * (holes > HOLE_MAX ? 0 : 1 - 0.5 * holes / HOLE_MAX) * comfort;
  const agg = {
    composition: mean(samples.map((q) => q.composition)), subject: null, depth: mean(samples.map((q) => q.depth)),
    parallax: mean(samples.map((q) => q.parallax)), reveal: null, payoff: null, hold: null, weakest, holes, missingTiles, flowMax, total: 0,
  };
  if (shot) {
    const v = (q) => (q.metrics.subject ? q.metrics.subject.visibleFrac * Math.min(1, q.metrics.subject.size / REVEAL_SIZE) : 0);
    const first = samples[0], pay = at(payoffS);
    const early = mean(samples.filter((q) => q.s <= s0 + 0.3 * (payoffS - s0)).map(v));
    agg.subject = mean(samples.map((q) => q.subject));
    agg.reveal = clamp(0.6 * clamp(v(pay) - v(first), 0, 1) + 0.4 * (1 - early) * pay.subject, 0, 1);
    agg.payoff = pay.composition * pay.subject;
    agg.hold = mean(samples.filter((q) => q.s >= holdS[0] && q.s <= holdS[1]).map((q) => q.composition * q.subject));
    agg.total = Object.entries(SHOT_WEIGHTS).reduce((t, [key, w]) => t + w * agg[key], 0) * factor;
  } else {
    agg.total = Object.entries(LINK_WEIGHTS).reduce((t, [key, w]) => t + w * agg[key], 0) * factor;
  }
  // Signature for the planner's repetition costs.
  const hist = new Array(12).fill(0);
  let agl = 0, aglN = 0, dist = 0;
  for (let i = 0; i < n; i++) {
    const p = poseOf(i), { headingDeg } = headingPitch(lookDir(p));
    hist[Math.round((((headingDeg % 360) + 360) % 360) / 30) % 12] += 1 / n;
    const g = groundAt ? groundAt(p.eyeM[0], p.eyeM[2]) : NaN;
    if (Number.isFinite(g)) { agl += p.eyeM[1] - g; aglN++; }
    if (subject) dist += Math.hypot(p.eyeM[0] - subject.posM[0], p.eyeM[2] - subject.posM[2]) / n;
  }
  const depths = samples.map((q) => q.metrics.medianDepthM).filter(Number.isFinite);
  return {
    samples, flow, aggregate: agg,
    signature: { headingHistogram: hist, meanAglM: aglN ? agl / aglN : null, meanDistanceM: subject ? dist : depths.length ? mean(depths) : null },
  };
}

/**
 * Score a shot path ({s, eye, aim, fov}) around `subject`: per-sample metrics
 * every `everyM` metres of progress (plus the ends, payoffS and holdS), a
 * flow lane per path sample, aggregates and a repetition signature
 * {headingHistogram (12 bins centred on k*30 deg from north), meanAglM,
 * meanDistanceM} (see the header). `raster(pose, {width, height})` defaults
 * to scenic-terrain.mjs depthRaster bound to ctx (subject samples then get
 * its curvature drop; `curvatureRadiusM` overrides); `groundAt(x, z)`
 * defaults to ctx.grid heights; `motion` {minSpeedMps, flowEnergetic} sets
 * comfort. Defaults: payoffS mid-path, holdS payoffS +-10% of the length.
 */
export function scorePath(ctx, path, opts = {}) { return scoreAlong(ctx, path, opts, true); }

/** Score a link path: composition along the way, weakest stretch, holes and
 *  flow; subject, reveal, payoff and hold are null. */
export function linkScore(ctx, path, opts = {}) { return scoreAlong(ctx, path, { ...opts, subject: null }, false); }
