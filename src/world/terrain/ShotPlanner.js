// Scenic shot tours: the planner (docs/scenic-tours.md).
//
// Strings a view's shots and links together against one song. Every shot's
// payoff lands on a payoff *slot*: an energy impact (ShotMusic), a phrase
// start, or a filler in a long gap, on a grid of the whole song (so a replan
// sees the slots the committed plan used; a replan also gets the committed
// timeline's later knots as slots). Payoff slots lie inside the visible
// intervals. Off screen the camera only has to keep moving legally: there the
// fillers are *pass-through* knots (`hidden`), where a shot passes its
// payoffS unseen -- no payoff, no reward, and the costs of what a viewer
// would see (repetition, link quality, pace, speed changes) scale with the
// share of the leg on screen. Between two knots the camera covers one *leg*:
// the rest of the shot after its payoff, a link, and the next shot up to its
// payoff. A leg's mean speed must fit [minSpeed, cap], cap = min(maxSpeed,
// flowLimit / max flow, sqrt(maxAccel / bend)) over each part of the leg
// (rest of a shot, link, next shot), the flow limit running from flowCalm to
// flowEnergetic with the music's lowest intensity while that part plays, and
// the speed profile that ShotTimeline will build through the knots
// (intervalLimits, the same knot rules) must keep the eye's acceleration in
// the limit: |a| + v^2 * bend <= maxAccel, where `bend` is the largest change
// of the eye's share of progress on the leg (joins included) -- at a steady
// progress speed v the eye still speeds up or slows by bend * v^2 where a
// path trades flying for panning. The eye's sideways acceleration v^2 * turn
// (curvature) is unlimited -- turning comfort is the yaw limit -- unless
// `vectorAccelRatio` holds the whole acceleration to that multiple of
// maxAccel (then also v^2 * turn <= sqrt(ratio^2 - 1) * maxAccel).
//
// `bend` and `turn` are measured on the curve the timeline draws through the
// decoded samples (pathPoseAt's spline at smoothPoseAt's pace), at their
// largest over each segment, not at a few fixed points. On the libraries'
// 0.1 m lattice that includes quantization: on shots sampled every ~29 m it
// is about 6e-4/m (the drawn eye's speed jitters by 2.2 m/s2 at 60 m/s and
// 4.7 at 90 m/s at a steady pace, about half from the s lane and half from
// the eye lane), on links sampled every ~58 m about a quarter of that. Only a
// finer lattice (or coarser shot sampling) removes it; the planner does not
// pretend it is not drawn. Real bends (a link's kinks at its joins, a shot's
// pan) are usually far larger and are what limit links.
//
// Search: knots in time order, each holding a beam of states (last shot,
// its payoff at that knot, recent history), at most one per (shot, previous
// subject) and `beamWidth` in all. Every state expands over its shot's links
// and the next few impact slots (and strong ones further on) that its leg
// can reach at the minimum speed or faster, however long the leg, plus the
// few visible and pass-through slots nearest a comfortable pace (slower ones
// up to `fillerReachMs` on) and the ones from which the shot's rest would
// just reach the song end; the song
// end is tried from every state, inside its shot, through one more link into
// a last shot, or -- only when a state has no other way to the end -- inside
// that link. The best complete plan wins, so the climax shot, the final
// chorus and the outro are chosen together, never committed greedily.
//
// Costs: shot quality times slot importance (strong impacts at a section
// start heavier, the climax heaviest, a bonus for a hero subject there --
// most for its best shots),
// link quality, repetition (subject, move runs, heading, elevation, lens,
// foreground passes), the music's character (calm slots want gentle moves,
// energetic ones approaches, reveals and passes), pace (against a
// comfortable pace for the music, `comfortFlow` of the image-flow limit;
// a leg under `crawlRatio` of it crawls and pays per second), stretches of
// more than `payoffGapMs` on screen without a payoff (also when an on-screen
// window closes without one; the first payoff of each window earns
// `window`), every strong impact or climax passed on screen without a payoff
// (`missStrong`), speed changes between legs, and the ending (a pullback,
// high or crane shot for the outro, more after a hero climax).
//
// A replan (`start` from shotContinuation) holds its first leg to the hard
// limits only and, landing on the committed timeline's next knot, keeps that
// knot's speed (`plan.pin`): the committed sequence stays among its choices.
// It chooses from the same options a fresh plan has: the committed element's
// own leg is not charged for what it repeats (every continuation pays that
// alike), and riding the committed element to the song end without its
// payoff is only a last resort.
// Motion limits: the defaults, then the library's region `motion`, then
// `tunables`.
//
// Pure and deterministic: ties break by creation order, which follows shot
// and link order; `seed` only perturbs shot and link rewards slightly.
import { musicMoments } from './ShotMusic.js';
import { pathLaneAt } from './ShotPath.js';
import { SHOT_MOTION, SHOT_KEY_MS, knotSpeed, intervalLimits, itemKnots, progressProfile, shotSupportedPath } from './ShotTimeline.js';

export const SHOT_TUNABLES = Object.freeze({
  ...SHOT_MOTION,
  beamWidth: 256, statesPerShot: 3, fillerReachMs: 90000, impactsPerLeg: 2, strongPerLeg: 2, freeSlotsPerLeg: 2, hiddenSlotsPerLeg: 2, fillerGapMs: 8000, fillerSpacingMs: 4000,
  capMargin: 1, vectorAccelRatio: 0, endViaMs: 60000, comfortFlow: .85, crawlRatio: .5, payoffGapMs: 30000, strongWindowMs: 3000,
  weights: Object.freeze({ shot: 3, scoreBase: .5, impact: 3, strong: 1.5, climax: 2.5, showing: .3, link: .5, comfort: .06, crawl: .3, gap: .25, window: 90, hiddenComfort: .15,
    change: .8, timing: .002, sameSubject: 300, recentSubject: 1, olderSubject: .5, sameMove: .8, moveRun: 4, heading: .3, run: .4, foregroundRun: .6, reuse: 3,
    calmEnergetic: 1.2, energyGentle: .5, impactGentle: .3, missStrong: 40, climaxHero: 60, climaxHeroAny: 12, outro: 2, outroMove: 1.5, endInLink: 4,
    railOpen: 2, wideOpen: 1, energeticOpen: 2.5, linkTime: .04, seedJitter: .2 }),
});

const GENTLE = new Set(['rail', 'orbit', 'pullback', 'traverse']), LIVELY = new Set(['reveal', 'approach', 'valley', 'crest']);
const LENSES = ['wide', 'normal', 'tele'], ELEVATIONS = ['low', 'mid', 'high'];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Rebuild the lookup Maps of a library that crossed postMessage. */
export function restoreShotLibrary(library) {
  if (library.shotById instanceof Map && library.linkById instanceof Map && library.linksFrom instanceof Map) return library;
  const linksFrom = new Map(library.shots.map((s) => [s.id, []]));
  for (const l of library.links) linksFrom.get(l.from)?.push(l);
  for (const list of linksFrom.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return { ...library, shotById: new Map(library.shots.map((s) => [s.id, s])), linkById: new Map(library.links.map((l) => [l.id, l])),
    linksFrom, subjectById: new Map(library.subjects.map((s) => [s.id, s])) };
}

// The drawn eye along a path, as ShotTimeline draws it: pathPoseAt's
// uniform Catmull-Rom through the samples (reflected at a path's ends, or
// run through the neighbour's support sample where two items join)
// traversed by smoothPoseAt's Hermite fraction (slopes k0, k1 from the
// neighbouring spacings). With E(x) the eye at progress x, the eye's
// acceleration at progress speed v and progress acceleration a is
// E'' v^2 + E' a. Its part along the travel adds `bend` * v^2 to the
// profile's own (bend = |E'.E''| / |E'|, how fast the eye's share of
// progress changes: where a path trades flying for panning, or the sample
// spacing steps); its sideways part is `turn` * v^2 (turn = |E' x E''| /
// |E'|, the curvature seen per progress metre).
//
// Both are rational functions of the segment fraction t whose largest value
// usually lies inside the segment, not at t = 0, 1/2 or 1 (Teton's
// reveal-jackson-lake-107, segment 15, peaks at t = 0.77 at 2.9x its
// midpoint value). So every segment is scanned at t = 0, 1/4, ..., 1 (the
// scan reads at most 1.52x low over the 22,600 segments of the 14 real
// libraries and the test fixtures), and over a range of a path the leading
// segment, then every segment whose scan comes within BEND_SLACK of the best
// value found, is refined by golden-section search around each local maximum
// of its scan (parabolic steps miss the sharp peaks at kinked joins). That
// matches a dense scan (257-513 points per segment) to 0.15% on every part
// and link (joins included) of the real libraries at a fraction of its cost.
const SCAN = 5, BEND_SLACK = 1.6, GOLDEN_STEPS = 5;
const SCAN_T = Float64Array.from({ length: SCAN }, (_, j) => j / (SCAN - 1));
// Per scan point: the Hermite fraction u, du/dt and d2u/dt2 as coefficients of k0, k1 and 1.
const SCAN_B = new Float64Array(SCAN * 9);
SCAN_T.forEach((t, j) => {
  const t2 = t * t;
  SCAN_B.set([t2 * t - 2 * t2 + t, t2 * t - t2, 3 * t2 - 2 * t2 * t, 3 * t2 - 4 * t + 1, 3 * t2 - 2 * t, 6 * t - 6 * t2, 6 * t - 4, 6 * t - 2, 6 - 12 * t], j * 9);
});
// One segment's curve: Catmull-Rom derivative coefficients per axis
// (E'(u) = c + A u + B u^2 / 2, E''(u) = A + B u), the Hermite slopes and ds.
const curve = new Float64Array(12);
// Exact range of a quadratic, including its interior extremum.
function quadraticAbsMax(c, b, a, lo, hi) {
  let best = Math.max(Math.abs(c + lo * (b + lo * a)), Math.abs(c + hi * (b + hi * a)));
  const x = a ? -b / (2 * a) : -1;
  if (x > lo && x < hi) best = Math.max(best, Math.abs(c + x * (b + x * a)));
  return best;
}
// A conservative bound on |d eyeY / d progress| on the same Catmull-Rom
// curve and Hermite fraction as smoothPoseAt. The two quadratic factors
// attain their maxima separately; four subintervals keep the product tight
// on uneven spacing. Uniform spacing is exact and takes the fast path.
function verticalSlopeBound(c, A, B, k0, k1, ds, lo = 0, hi = 1) {
  if (k0 === 1 && k1 === 1) return quadraticAbsMax(c, A, B / 2, lo, hi) / ds;
  const alpha = k0 + k1 - 2, beta = 3 - 2 * k0 - k1;
  let best = 0;
  for (let i = 0; i < 4; i++) {
    // Fixed cells make the conservative range monotone as a prefix grows.
    // Moving the cell edges with `hi` could lower the bound and invalidate
    // the terminal speed search, even though the true maximum cannot fall.
    const a = Math.max(lo, i / 4), b = Math.min(hi, (i + 1) / 4);
    if (!(b > a)) continue;
    best = Math.max(best, quadraticAbsMax(c, A, B / 2, a * (k0 + a * (beta + a * alpha)), b * (k0 + b * (beta + b * alpha))) * quadraticAbsMax(k0, 2 * beta, 3 * alpha, a, b) / ds);
  }
  return best;
}
function loadSegment(p, before, ds, after, ends) {
  for (let k = 0; k < 3; k++) {
    const p0 = p[k], p1 = p[3 + k], p2 = p[6 + k], p3 = p[9 + k];
    curve[k] = .5 * (p2 - p0); curve[3 + k] = 2 * p0 - 5 * p1 + 4 * p2 - p3; curve[6 + k] = 3 * (-p0 + 3 * p1 - 3 * p2 + p3);
  }
  curve[9] = ends ? 2 * ds / (before + ds) : 1; curve[10] = ends ? 2 * ds / (ds + after) : 1; curve[11] = ds;
}
// The bend (q = 0) or turn (q = 1) of the loaded segment at fraction t:
// with d = E'/du and C = dE'/du / du (per unit u), E' = d du and
// E'' = C du^2 + d ddu, so bend = |du^2 d.C + ddu |d|^2| / |d|.
function drawnAt(t, q) {
  const k0 = curve[9], k1 = curve[10], ds = curve[11], t2 = t * t, t3 = t2 * t;
  const u = (t3 - 2 * t2 + t) * k0 + (t3 - t2) * k1 + 3 * t2 - 2 * t3, hu = .5 * u * u;
  const du = ((3 * t2 - 4 * t + 1) * k0 + (3 * t2 - 2 * t) * k1 + 6 * t - 6 * t2) / ds, ddu = ((6 * t - 4) * k0 + (6 * t - 2) * k1 + 6 - 12 * t) / (ds * ds), du2 = du * du;
  const dx = curve[0] + curve[3] * u + curve[6] * hu, dy = curve[1] + curve[4] * u + curve[7] * hu, dz = curve[2] + curve[5] * u + curve[8] * hu;
  const cx = curve[3] + curve[6] * u, cy = curve[4] + curve[7] * u, cz = curve[5] + curve[8] * u, dd = dx * dx + dy * dy + dz * dz;
  if (!(dd * du2 > 1e-12)) return 0;
  const b = Math.abs(du2 * (dx * cx + dy * cy + dz * cz) + ddu * dd) / Math.sqrt(dd);
  if (!q) return b;
  const ex = cx * du2 + dx * ddu, ey = cy * du2 + dy * ddu, ez = cz * du2 + dz * ddu;
  return Math.sqrt(Math.max(0, ex * ex + ey * ey + ez * ez - b * b));
}
// Golden-section search for the largest value of quantity q in [a, c].
function refineMax(q, a, c) {
  const g = .3819660112501051;
  let x1 = a + g * (c - a), x2 = c - g * (c - a);
  let f1 = drawnAt(x1, q), f2 = drawnAt(x2, q);
  for (let k = 0; k < GOLDEN_STEPS; k++) {
    if (f1 > f2) { c = x2; x2 = x1; f2 = f1; x1 = a + g * (c - a); f1 = drawnAt(x1, q); } else { a = x1; x1 = x2; f1 = f2; x2 = c - g * (c - a); f2 = drawnAt(x2, q); }
  }
  return f1 > f2 ? f1 : f2;
}
// The loaded segment's scan of quantity q into out[0..SCAN).
function scanSegment(out, q) {
  for (let j = 0; j < SCAN; j++) out[j] = drawnAt(SCAN_T[j], q);
}
// The refined maximum of quantity q over the loaded segment, from its scan:
// every local maximum of the scan that could still be the largest, or beat
// `floor`, is searched (so the result is exact wherever it is above floor).
function segmentMax(scan, q, floor = 0) {
  let best = 0;
  for (let j = 0; j < SCAN; j++) best = Math.max(best, scan[j]);
  const least = Math.max(best, floor);
  for (let j = 0; j < SCAN; j++) {
    const v = scan[j];
    if (v * BEND_SLACK < least || (j > 0 && v < scan[j - 1]) || (j < SCAN - 1 && v < scan[j + 1])) continue;
    best = Math.max(best, refineMax(q, SCAN_T[Math.max(0, j - 1)], SCAN_T[Math.min(SCAN - 1, j + 1)]));
  }
  return best;
}

// Per path: each segment's scan maximum per quantity and, once refined, its
// refined maximum (-1 until then), exact above the floor it was refined at.
const pathCurves = new WeakMap(), points = new Float64Array(12), scanBuf = new Float64Array(SCAN);
function loadPathSegment(path, i) {
  const { s, eye } = path, n = s.length, ds = s[i + 1] - s[i];
  for (let k = 0; k < 3; k++) {
    const p1 = eye[i * 3 + k], p2 = eye[i * 3 + 3 + k];
    points[k] = i > 0 ? eye[i * 3 - 3 + k] : 2 * p1 - p2; points[3 + k] = p1; points[6 + k] = p2; points[9 + k] = i + 2 < n ? eye[i * 3 + 6 + k] : 2 * p2 - p1;
  }
  loadSegment(points, i > 0 ? s[i] - s[i - 1] : ds, ds, i + 2 < n ? s[i + 2] - s[i + 1] : ds, n >= 3);
  return ds > 0;
}
// The scan of quantity q on every segment of a path (drawnAt inlined: this
// runs over every sample of a library on each fresh copy the worker plans with).
function curvesOf(path, q) {
  let c = pathCurves.get(path);
  if (!c) pathCurves.set(path, c = { scan: [null, null], refined: [null, null], floor: [null, null] });
  if (c.scan[q]) return c;
  const { s, eye } = path, n = s.length, m = Math.max(0, n - 1), B = SCAN_B, out = c.scan[q] = new Float64Array(m), refined = c.refined[q] = new Float64Array(m).fill(-1);
  c.floor[q] = new Float64Array(m);
  // Bend already reads the same vertical cubic coefficients. Fill its cheap
  // analytic climb bounds in that pass instead of rereading every path.
  const climb = q === 0 && !c.scan[2] ? c.scan[2] = new Float64Array(m) : null;
  const climbRefined = climb ? c.refined[2] = new Float64Array(m).fill(-1) : null;
  if (climb) c.floor[2] = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const ds = s[i + 1] - s[i];
    if (!(ds > 0)) { refined[i] = 0; if (climb) climbRefined[i] = 0; continue; }
    const k0 = n >= 3 ? 2 * ds / ((i > 0 ? s[i] - s[i - 1] : ds) + ds) : 1, k1 = n >= 3 ? 2 * ds / (ds + (i + 2 < n ? s[i + 2] - s[i + 1] : ds)) : 1;
    const o = i * 3, ids = 1 / ds;
    if (q === 2) {
      const y1 = eye[o + 1], y2 = eye[o + 4], y0 = i > 0 ? eye[o - 2] : 2 * y1 - y2, y3 = i + 2 < n ? eye[o + 7] : 2 * y2 - y1;
      if (y0 === y1 && y1 === y2 && y2 === y3) out[i] = refined[i] = 0;
      else {
        const c = .5 * (y2 - y0), A = 2 * y0 - 5 * y1 + 4 * y2 - y3, B = 3 * (-y0 + 3 * y1 - 3 * y2 + y3);
        if (k0 === 1 && k1 === 1) out[i] = refined[i] = quadraticAbsMax(c, A, B / 2, 0, 1) / ds;
        else out[i] = Math.max(Math.abs(c), Math.abs(c + A / 2), Math.abs(c + A + B / 2)) * Math.max(Math.abs(k0), Math.abs(3 - k0 - k1), Math.abs(k1)) / ds;
      }
      continue;
    }
    let x1 = eye[o], x2 = eye[o + 3], x0 = i > 0 ? eye[o - 3] : 2 * x1 - x2, x3 = i + 2 < n ? eye[o + 6] : 2 * x2 - x1;
    const cx = .5 * (x2 - x0), ax = 2 * x0 - 5 * x1 + 4 * x2 - x3, bx = 3 * (-x0 + 3 * x1 - 3 * x2 + x3);
    x1 = eye[o + 1]; x2 = eye[o + 4]; x0 = i > 0 ? eye[o - 2] : 2 * x1 - x2; x3 = i + 2 < n ? eye[o + 7] : 2 * x2 - x1;
    const cy = .5 * (x2 - x0), ay = 2 * x0 - 5 * x1 + 4 * x2 - x3, by = 3 * (-x0 + 3 * x1 - 3 * x2 + x3);
    if (climb) {
      if (cy === 0 && ay === 0 && by === 0) climb[i] = climbRefined[i] = 0;
      else if (k0 === 1 && k1 === 1) climb[i] = climbRefined[i] = quadraticAbsMax(cy, ay, by / 2, 0, 1) / ds;
      else climb[i] = Math.max(Math.abs(cy), Math.abs(cy + ay / 2), Math.abs(cy + ay + by / 2)) * Math.max(Math.abs(k0), Math.abs(3 - k0 - k1), Math.abs(k1)) / ds;
    }
    x1 = eye[o + 2]; x2 = eye[o + 5]; x0 = i > 0 ? eye[o - 1] : 2 * x1 - x2; x3 = i + 2 < n ? eye[o + 8] : 2 * x2 - x1;
    const cz = .5 * (x2 - x0), az = 2 * x0 - 5 * x1 + 4 * x2 - x3, bz = 3 * (-x0 + 3 * x1 - 3 * x2 + x3);
    let most = 0;
    for (let j = 0; j < SCAN * 9; j += 9) {
      const u = B[j] * k0 + B[j + 1] * k1 + B[j + 2], du = (B[j + 3] * k0 + B[j + 4] * k1 + B[j + 5]) * ids, ddu = (B[j + 6] * k0 + B[j + 7] * k1 + B[j + 8]) * ids * ids;
      const hu = .5 * u * u, dx = cx + ax * u + bx * hu, dy = cy + ay * u + by * hu, dz = cz + az * u + bz * hu, dd = dx * dx + dy * dy + dz * dz;
      if (!(dd * du * du > 1e-12)) continue;
      // E' = d du, E'' = C du^2 + d ddu (C = A + B u): bend = |du^2 d.C + ddu |d|^2| / |d|.
      const ex = ax + bx * u, ey = ay + by * u, ez = az + bz * u, du2 = du * du, w = du2 * (dx * ex + dy * ey + dz * ez) + ddu * dd;
      let v = w * w / dd;
      if (q) { const qx = ex * du2 + dx * ddu, qy = ey * du2 + dy * ddu, qz = ez * du2 + dz * ddu; v = qx * qx + qy * qy + qz * qz - v; }
      if (v > most) most = v;
    }
    out[i] = Math.sqrt(most);
  }
  return c;
}
/** The largest bend (q = 0) or turn (q = 1) of a path's drawn eye over
 *  progress [a, b] (1/m), or `floor` if that is larger (segments that cannot
 *  beat it are not refined). */
function rangeMax(path, a, b, q, floor = 0) {
  const { s } = path, c = curvesOf(path, q), scan = c.scan[q], refined = c.refined[q], floors = c.floor[q], n = scan.length;
  let i0 = 0, i1 = n - 1, best = floor;
  while (i0 < n && s[i0 + 1] < a) i0++;
  while (i1 >= i0 && s[i1] > b) i1--;
  if (q === 2) {
    // First refine the leading analytic upper bound. Any other whole
    // segment below the resulting best cannot affect the range maximum.
    // The upper bound is used only to skip work, never returned as a
    // sampled approximation or substituted for the fixed-cell bound.
    let top = -1, upper = best;
    for (let i = i0; i <= i1; i++) if (s[i] >= a && s[i + 1] <= b && scan[i] > upper) { upper = scan[i]; top = i; }
    if (top >= 0 && refined[top] < 0) {
      loadPathSegment(path, top);
      refined[top] = verticalSlopeBound(curve[1], curve[4], curve[7], curve[9], curve[10], curve[11]);
    }
    if (top >= 0) best = Math.max(best, refined[top]);
    for (let i = i0; i <= i1; i++) {
      const ds = s[i + 1] - s[i], lo = clamp((a - s[i]) / ds, 0, 1), hi = clamp((b - s[i]) / ds, 0, 1);
      if (!(hi > lo)) continue;
      if (lo === 0 && hi === 1) {
        if (refined[i] < 0 && scan[i] > best) {
          loadPathSegment(path, i);
          // Tighten the cheap Bernstein hull only for a segment still in
          // contention, before computing the fixed-cell result.
          const upper = quadraticAbsMax(curve[1], curve[4], curve[7] / 2, 0, 1) * quadraticAbsMax(curve[9], 2 * (3 - 2 * curve[9] - curve[10]), 3 * (curve[9] + curve[10] - 2), 0, 1) / curve[11];
          scan[i] = Math.min(scan[i], upper);
          if (scan[i] > best) refined[i] = verticalSlopeBound(curve[1], curve[4], curve[7], curve[9], curve[10], curve[11]);
        }
        if (refined[i] >= 0) best = Math.max(best, refined[i]);
      }
      else {
        loadPathSegment(path, i);
        best = Math.max(best, verticalSlopeBound(curve[1], curve[4], curve[7], curve[9], curve[10], curve[11], lo, hi));
      }
    }
    return best;
  }
  let top = -1;
  for (let i = i0; i <= i1; i++) {
    const v = refined[i] >= 0 ? refined[i] : scan[i];
    if (v > best) { best = v; top = i; }
  }
  // The leading segment first (it usually holds the maximum), then any other
  // whose scan could still beat what is known.
  const refine = (i) => { loadPathSegment(path, i); scanSegment(scanBuf, q); refined[i] = segmentMax(scanBuf, q, best); floors[i] = best; if (refined[i] > best) best = refined[i]; };
  if (top >= 0 && refined[top] < 0) refine(top);
  for (let i = i0; i <= i1; i++) if ((refined[i] < 0 || floors[i] > best) && scan[i] * BEND_SLACK >= best) refine(i);
  return best;
}

/** Over progress [a, b] of a path: max and integral of its flow lane, and
 *  the drawn eye's largest `bend` there (and `turn`, when asked; 1/m). */
function laneStats(path, a, b, withTurn = false, withBend = true) {
  const { s, flow } = path, n = s.length;
  let prevS = a, prevF = flow ? pathLaneAt(path, flow, a) : 1 / 500, max = prevF, int = 0;
  if (flow) {
    for (let i = 0; i < n && s[i] < b; i++) {
      if (s[i] <= a) continue;
      int += (s[i] - prevS) * (flow[i] + prevF) / 2; max = Math.max(max, flow[i]); prevS = s[i]; prevF = flow[i];
    }
  }
  const fb = flow ? pathLaneAt(path, flow, b) : 1 / 500;
  return { max: Math.max(max, fb, 1e-9), int: Math.max(0, int + (b - prevS) * (fb + prevF) / 2), bend: withBend ? rangeMax(path, a, b, 0) : 0, climb: withBend ? rangeMax(path, a, b, 2) : 0, turn: withTurn ? rangeMax(path, a, b, 1) : 0 };
}

/** Bend and turn of the two segments where path A's end joins path B's
 *  start, drawn as ShotTimeline joins them: each runs its Catmull-Rom
 *  through a support sample on the other's end chord, scaled to its own
 *  sample spacing (so the spline is uniform there: slope 1 at the join). */
function joinCurve(A, B) {
  const na = A.s.length, nb = B.s.length, out = [0, 0, 0];
  if (na < 2 || nb < 2) return out;
  const dsA = A.s[na - 1] - A.s[na - 2], dsB = B.s[1] - B.s[0];
  if (!(dsA > 0 && dsB > 0)) return out;
  // A's last segment: p3 is the support past A's end toward B's second sample.
  for (let k = 0; k < 3; k++) {
    const p1 = A.eye[(na - 2) * 3 + k], p2 = A.eye[(na - 1) * 3 + k];
    points[k] = na >= 3 ? A.eye[(na - 3) * 3 + k] : 2 * p1 - p2; points[3 + k] = p1; points[6 + k] = p2; points[9 + k] = p2 + (B.eye[3 + k] - p2) * dsA / dsB;
  }
  loadSegment(points, na >= 3 ? A.s[na - 2] - A.s[na - 3] : dsA, dsA, dsA, true);
  for (let q = 0; q < 2; q++) { scanSegment(scanBuf, q); out[q] = segmentMax(scanBuf, q); }
  out[2] = verticalSlopeBound(curve[1], curve[4], curve[7], curve[9], curve[10], curve[11]);
  // B's first segment: p0 is the support before B's start toward A's second-last sample.
  for (let k = 0; k < 3; k++) {
    const p1 = B.eye[k], p2 = B.eye[3 + k];
    points[k] = p1 + (A.eye[(na - 2) * 3 + k] - p1) * dsB / dsA; points[3 + k] = p1; points[6 + k] = p2; points[9 + k] = nb >= 3 ? B.eye[6 + k] : 2 * p2 - p1;
  }
  loadSegment(points, dsB, dsB, nb >= 3 ? B.s[2] - B.s[1] : dsB, true);
  for (let q = 0; q < 2; q++) { scanSegment(scanBuf, q); out[q] = Math.max(out[q], segmentMax(scanBuf, q)); }
  out[2] = Math.max(out[2], verticalSlopeBound(curve[1], curve[4], curve[7], curve[9], curve[10], curve[11]));
  return out;
}

// Song-independent per-library tables, cached per decoded library.
const indexes = new WeakMap();
function libraryIndex(library) {
  let ix = indexes.get(library);
  if (ix) return ix;
  const shots = library.shots, links = library.links, n = shots.length, shotIndex = new Map(shots.map((s, i) => [s.id, i]));
  const subjects = new Map(library.subjects.map((s, i) => [s.id, i])), foregrounds = new Map();
  const L = new Float64Array(n), pay = new Float64Array(n), head = [], tail = [];
  shots.forEach((s, i) => {
    L[i] = s.path.s[s.path.s.length - 1]; pay[i] = clamp(s.payoffS, 0, L[i]);
    head.push(laneStats(s.path, 0, pay[i])); tail.push(laneStats(s.path, pay[i], L[i]));
  });
  // Foreground: a pass in front of something else (tag), or the trait when it names a kind.
  const fgOf = (s) => {
    const f = s.tags?.includes('foreground-pass') ? 'pass' : typeof s.traits?.foreground === 'string' ? s.traits.foreground : 'none';
    if (!foregrounds.has(f)) foregrounds.set(f, foregrounds.size);
    return foregrounds.get(f);
  };
  const agl = (s) => s.traits?.aglM ?? 500;
  const elevOf = (s) => (ELEVATIONS.includes(s.traits?.elevation) ? ELEVATIONS.indexOf(s.traits.elevation) : agl(s) < 450 ? 0 : agl(s) < 750 ? 1 : 2);
  const highOf = (s) => agl(s) >= 750 || !!s.tags?.includes('high') || s.traits?.elevation === 'high';
  const heroes = new Set(library.subjects.filter((s) => s.hero).map((s) => s.id));
  for (const s of shots) if (s.tags?.includes('hero')) heroes.add(s.subjectId);
  if (!heroes.size) {
    const top = shots.filter((s) => s.move !== 'rail').sort((a, b) => b.score.total - a.score.total || byId(a, b))[0];
    if (top) heroes.add(top.subjectId);
  }
  const heroTop = new Uint8Array(n);
  for (const subject of heroes) {
    const own = shots.map((s, i) => [s, i]).filter(([s]) => s.subjectId === subject).sort(([a], [b]) => b.score.total - a.score.total || byId(a, b));
    for (const [, i] of own.slice(0, own.length >= 6 ? 3 : 2)) heroTop[i] = 1;
  }
  // A link's flow now; its bend (with both joins) when first needed (linkBend):
  // the planner never needs it for a link no leg can fly in time, and dense
  // long links are most of a library's samples.
  const joinTurn = new Float64Array(links.length), pre = planningTablesOf(library);
  const joinedLinks = new Array(links.length);
  const linkPath = (j) => joinedLinks[j] ??= shotSupportedPath(links[j].path,
    library.shotById.get(links[j].from)?.path, library.shotById.get(links[j].to)?.path);
  const linkStats = links.map((l) => laneStats(l.path, 0, l.path.s[l.path.s.length - 1], false, false));
  ix = {
    shots, links, shotIndex, L, pay, head, tail, heroTop,
    hero: Uint8Array.from(shots, (s) => +heroes.has(s.subjectId)),
    subj: Int32Array.from(shots, (s) => subjects.get(s.subjectId) ?? -1),
    move: shots.map((s) => s.move), gentle: Uint8Array.from(shots, (s) => +(GENTLE.has(s.move) && !s.tags?.includes('foreground-pass'))),
    // Lively: approaches, reveals and the like, and passes in front of a foreground.
    lively: Uint8Array.from(shots, (s) => +(LIVELY.has(s.move) || !!s.tags?.includes('foreground-pass'))),
    heading: Float64Array.from(shots, (s) => s.traits?.headingDeg ?? NaN),
    elev: Int8Array.from(shots, elevOf),
    lens: Int8Array.from(shots, (s) => LENSES.indexOf(s.traits?.lens)), fg: Int16Array.from(shots, fgOf),
    score: Float64Array.from(shots, (s) => s.score.total),
    high: Uint8Array.from(shots, (s) => +highOf(s)), wide: Uint8Array.from(shots, (s) => +(s.traits?.lens === 'wide')),
    // An ending: a pullback, a high shot or a crane reveal.
    outro: Uint8Array.from(shots, (s) => +(s.move === 'pullback' || highOf(s) || !!s.tags?.includes('crane'))),
    rail: shots.findIndex((s) => s.move === 'rail'),
    lFrom: Int32Array.from(links, (l) => shotIndex.get(l.from)), lTo: Int32Array.from(links, (l) => shotIndex.get(l.to)),
    lL: Float64Array.from(links, (l) => l.path.s[l.path.s.length - 1]), lMax: Float64Array.from(linkStats, (x) => x.max), lBend: new Float64Array(links.length).fill(-1), lClimb: new Float64Array(links.length).fill(-1), lTurn: new Float64Array(links.length),
    lInt: Float64Array.from(linkStats, (x) => x.int), lScore: Float64Array.from(links, (l) => l.score.total),
    out: shots.map(() => []),
  };
  const linkIndex = new Map(links.map((l, j) => [l, j]));
  // Code-unit id order (not locale order), so ties break the same everywhere.
  shots.forEach((s, i) => { ix.out[i] = (library.linksFrom.get(s.id) || []).toSorted(byId).map((l) => linkIndex.get(l)).filter((j) => j !== undefined); });
  // A longer or lower-scored alternative can be the only legal ending:
  // feasibility also depends on flow, bends and both joins.
  ix.outEnd = ix.out;
  ix.linkBend = (j) => {
    if (ix.lBend[j] < 0 && pre) { ix.lBend[j] = pre.linkBend[j]; joinTurn[j] = pre.joinTurn[j]; }
    if (ix.lBend[j] < 0) {
      const l = links[j], A = library.shotById.get(l.from)?.path, B = library.shotById.get(l.to)?.path;
      const a = A ? joinCurve(A, l.path) : [0, 0, 0], b = B ? joinCurve(l.path, B) : [0, 0, 0];
      ix.lBend[j] = rangeMax(l.path, 0, ix.lL[j], 0, Math.max(a[0], b[0])); joinTurn[j] = Math.max(a[1], b[1]);
      ix.lClimb[j] = rangeMax(l.path.s.length === 2 ? linkPath(j) : l.path, 0, ix.lL[j], 2, Math.max(a[2], b[2]));
    }
    return ix.lBend[j];
  };
  ix.linkClimb = (j) => {
    if (ix.lClimb[j] < 0 && pre?.linkClimb) ix.lClimb[j] = pre.linkClimb[j];
    if (ix.lClimb[j] < 0) {
      const l = links[j], A = library.shotById.get(l.from)?.path, B = library.shotById.get(l.to)?.path;
      const a = A ? joinCurve(A, l.path)[2] : 0, b = B ? joinCurve(l.path, B)[2] : 0;
      ix.lClimb[j] = rangeMax(l.path.s.length === 2 ? linkPath(j) : l.path, 0, ix.lL[j], 2, Math.max(a, b));
    }
    return ix.lClimb[j];
  };
  ix.remainingLinkClimb = (j, from, before) => {
    const B = library.shotById.get(links[j].to)?.path;
    // Either the link or the next shot can be the terminal item. Their
    // outgoing support differs, so retain a bound for both topologies.
    return Math.max(rangeMax(shotSupportedPath(links[j].path, before), from, ix.lL[j], 2), rangeMax(shotSupportedPath(links[j].path, before, B), from, ix.lL[j], 2), B ? rangeMax(shotSupportedPath(B, links[j].path), 0, pay[ix.lTo[j]], 2) : 0);
  };
  const supportedTails = new WeakMap();
  ix.tailClimb = (i, before) => {
    const path = shots[i].path;
    if (!before || pay[i] >= path.s[1]) return tail[i].climb;
    const supported = shotSupportedPath(path, before);
    if (!supportedTails.has(supported)) supportedTails.set(supported, rangeMax(supported, pay[i], L[i], 2));
    return supportedTails.get(supported);
  };
  ix.joinTurn = joinTurn;
  // Turns (zero until asked for: only a vector limit and the reports need them).
  let turns = false;
  ix.withTurns = () => {
    if (turns) return ix;
    turns = true;
    shots.forEach((s, i) => { head[i].turn = rangeMax(s.path, 0, pay[i], 1); tail[i].turn = rangeMax(s.path, pay[i], L[i], 1); });
    links.forEach((l, j) => { ix.linkBend(j); ix.lTurn[j] = Math.max(rangeMax(l.path, 0, ix.lL[j], 1), joinTurn[j]); });
    return ix;
  };
  indexes.set(library, ix);
  return ix;
}

// Sideways acceleration (v^2 * turn) is unlimited -- turning comfort is the
// yaw limit -- unless `vectorAccelRatio` (> 1) holds the eye's whole
// acceleration to that multiple of maxAccel: then sqrt(ratio^2 - 1) *
// maxAccel is left for it beside a full maxAccel along the travel.
const sidewaysAccel = (T) => (T.vectorAccelRatio > 1 ? Math.sqrt(T.vectorAccelRatio ** 2 - 1) * T.maxAccelMps2 : Infinity);
// The speed at which a steady eye reaches the acceleration limits on a bend and turn.
const climbCap = (T, climb) => !(Number.isFinite(T.maxClimbMps) && T.maxClimbMps > 0) ? 0 : climb > 0 ? T.maxClimbMps / climb : Infinity;
const curveCap = (T, bend, turn) => Math.min(bend > 0 ? Math.sqrt(T.maxAccelMps2 / bend) : Infinity, turn > 0 ? Math.sqrt(sidewaysAccel(T) / turn) : Infinity);

/**
 * A library's song-independent planning tables, which a fresh copy would
 * otherwise rebuild on every plan: each link's bend with both joins and the
 * joins' turn, the costliest part of a cold plan. The worker computes them
 * and returns them for reuse by later requests. A library carrying them plans exactly
 * as one without, measuring nothing it already holds. Tables that do not
 * match the library's links (ids and sample counts) are ignored.
 */
export function shotPlanningTables(library) {
  library = restoreShotLibrary(library);
  const ix = libraryIndex(library);
  library.links.forEach((_, j) => { ix.linkBend(j); ix.linkClimb(j); });
  return { linkIds: library.links.map((l) => l.id), samples: Int32Array.from(library.links, (l) => l.path.s.length),
    linkBend: Float64Array.from(ix.lBend), linkClimb: Float64Array.from(ix.lClimb), joinTurn: Float64Array.from(ix.joinTurn) };
}

function planningTablesOf(library) {
  const t = library.planningTables, links = library.links, n = links.length;
  if (!t || t.linkIds?.length !== n || t.samples?.length !== n || t.linkBend?.length !== n || t.joinTurn?.length !== n) return null;
  for (let j = 0; j < n; j++) if (t.linkIds[j] !== links[j].id || t.samples[j] !== links[j].path.s.length || !(t.linkBend[j] >= 0)) return null;
  if (t.linkClimb != null && (t.linkClimb.length !== n || !Array.from(t.linkClimb).every((v) => Number.isFinite(v) && v >= 0))) return null;
  return t;
}

/** Speed caps (m/s) of every shot's head (entry to payoff) and tail and of
 *  every link with its joins: the speed limit, the energetic flow limit and
 *  the drawn eye's tangential bend (and its turn, when `vectorAccelRatio`
 *  limits it). { head, tail, link: [{lengthM, capMps, bendPerM, turnPerM}] } */
export function shotPaceLimits(library, tunables = {}) {
  library = restoreShotLibrary(library);
  const T = { ...SHOT_TUNABLES, ...(library.motion || {}), ...tunables }, ix = libraryIndex(library).withTurns();
  const part = (lengthM, max, bend, turn, climb) => ({ lengthM, capMps: Math.min(T.maxSpeedMps, T.flowEnergetic / max, curveCap(T, bend, turn), climbCap(T, climb)), bendPerM: bend, turnPerM: turn, climbPerM: climb });
  return {
    head: ix.shots.map((_, i) => part(ix.pay[i], ix.head[i].max, ix.head[i].bend, ix.head[i].turn, ix.head[i].climb)),
    tail: ix.shots.map((_, i) => part(ix.L[i] - ix.pay[i], ix.tail[i].max, ix.tail[i].bend, ix.tail[i].turn, ix.tail[i].climb)),
    link: ix.links.map((_, j) => part(ix.lL[j], ix.lMax[j], ix.linkBend(j), ix.lTurn[j], ix.linkClimb(j))),
  };
}

function hash01(seed, text) {
  let h = (2166136261 ^ (seed * 2654435761)) >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Range queries over a lane on the 100 ms lattice: prefix mean and sparse-table min.
function rangeTables(lane) {
  const n = lane.length, prefix = new Float64Array(n + 1), table = [Float64Array.from(lane)];
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + lane[i];
  for (let w = 1; 2 * w <= n; w *= 2) {
    const last = table.at(-1), next = new Float64Array(n - 2 * w + 1);
    for (let i = 0; i < next.length; i++) next[i] = Math.min(last[i], last[i + w]);
    table.push(next);
  }
  const log = new Uint8Array(n + 1);
  for (let k = 2; k <= n; k++) log[k] = log[k >> 1] + 1;
  const lo = (a) => clamp(Math.floor(a / SHOT_KEY_MS), 0, n - 1), hi = (b) => clamp(Math.ceil(b / SHOT_KEY_MS), 0, n - 1);
  return {
    mean: (a, b) => { const i = lo(a), j = Math.max(i, hi(b)); return (prefix[j + 1] - prefix[i]) / (j - i + 1); },
    min: (a, b) => { const i = lo(a), j = Math.max(i, hi(b)), l = log[j - i + 1]; return Math.min(table[l][i], table[l][j - (1 << l) + 1]); },
  };
}

/**
 * Plan one song's shot tour. Returns { durationMs, moments, calm, items:
 * [{kind, id, startMs, endMs, sFrom, sTo, payoffMs?, moment?, hidden?}],
 * notes, cost, fallback, start, pin, intensity, intensityStepMs, visible,
 * stats }. Items tile [start?.timeMs ?? 0, durationMs]: shot, link, shot,
 * ... A shot item's payoffMs is when the camera passes its payoffS (null for
 * a last shot the song ends in before its payoff); `hidden` marks one off
 * screen, which is no payoff. `visible` null means the whole song is on
 * screen; [] means none of it. Moments carry `strong` (top third by
 * strength, at a section start) and `climax`.
 */
export function planShotTour(library, { durationMs = 0, sections = [], roles = [], energy = null, energyStepMs = 100,
  visible = null, seed = 0, start = null, tunables = {} } = {}) {
  library = restoreShotLibrary(library);
  const T = { ...SHOT_TUNABLES, ...(library.motion || {}), ...tunables, weights: { ...SHOT_TUNABLES.weights, ...tunables.weights } }, w = T.weights;
  const turnsOn = sidewaysAccel(T) < Infinity, ix = turnsOn ? libraryIndex(library).withTurns() : libraryIndex(library), { shots, links, L, pay } = ix, nShots = shots.length;
  durationMs = Math.max(0, Number(durationMs) || 0);
  const music = musicMoments({ durationMs, sections, roles, energy: energy || [], energyStepMs });
  // Strong impacts: the top third by strength, at a section start (a chorus
  // or drop boundary, or within strongWindowMs of any detected start).
  const ranked = music.impacts.map((m) => m.strength).sort((a, b) => b - a), cut = ranked[Math.max(0, Math.ceil(ranked.length / 3) - 1)] ?? Infinity;
  const starts = sections.map((s) => s.startMs).filter((t) => t > 0);
  const moments = music.impacts.map((m) => ({ ...m, climax: m === music.climax,
    strong: m.strength >= cut && (m.boundary || starts.some((t) => Math.abs(t - m.timeMs) <= T.strongWindowMs)) }));
  const nLane = Math.ceil(durationMs / SHOT_KEY_MS) + 1, intensity = Float32Array.from({ length: nLane }, (_, i) => music.intensityAt(i * SHOT_KEY_MS));
  const t0 = start ? clamp(Math.round(start.timeMs), 0, durationMs) : 0, notes = [];
  const intervals = (visible ?? [{ startMs: 0, endMs: durationMs }]).map((v) => ({ startMs: Math.max(0, v.startMs), endMs: Math.min(durationMs, v.endMs) }))
    .filter((v) => v.endMs >= v.startMs);
  const visibleAt = (t) => intervals.some((v) => t >= v.startMs && t <= v.endMs);
  const base = { durationMs, moments, calm: music.calm, start, intensity, intensityStepMs: SHOT_KEY_MS, visible: intervals, seed };
  const startIndex = start ? (start.itemKind === 'link' ? library.links.findIndex((l) => l.id === start.id) : ix.shotIndex.get(start.id) ?? -1) : -1;
  // A manually supplied start has no committed predecessor. Only evidence
  // carried by shotContinuation may install support from the previous item.
  const preceding = start?.before, precedingRec = preceding && (preceding.itemKind === 'link' ? library.linkById.get(preceding.id) : library.shotById.get(preceding.id));
  const startBefore = precedingRec && preceding.sTo >= precedingRec.path.s.at(-1) - 1e-6
    && (start.itemKind === 'link' ? preceding.itemKind === 'shot' && library.linkById.get(start.id)?.from === preceding.id
      : preceding.itemKind === 'link' && precedingRec.to === start.id) ? precedingRec.path : null;

  const finish = (items, cost, fallback, stats, pin = null) => {
    const payoffOf = (i) => (items[i].kind === 'shot' ? pay[ix.shotIndex.get(items[i].id)] : null);
    const { G, times, prog } = itemKnots(items, payoffOf, t0, durationMs);
    const profile = progressProfile(times, prog, { startSpeed: start?.speedMps ?? null, startAccel: start?.accelMps2 ?? 0, pin });
    items.forEach((it, i) => { it.startMs = i ? items[i - 1].endMs : t0; it.endMs = i === items.length - 1 ? durationMs : profile.timeAt(G[i + 1]); });
    return { ...base, items, notes, cost, fallback, pin, stats };
  };
  // Not physically checked: a continued element stretched at a uniform pace
  // from its committed speed (the worker keeps the committed timeline instead).
  const fallbackPlan = (reason) => {
    notes.push(`fallback: ${reason}`);
    let items;
    if (start && startIndex >= 0) {
      if (start.itemKind === 'link') {
        const to = ix.lTo[startIndex];
        items = [{ kind: 'link', id: start.id, sFrom: start.s, sTo: ix.lL[startIndex] }, { kind: 'shot', id: shots[to].id, sFrom: 0, sTo: L[to], payoffMs: null, moment: -1, hidden: false }];
      } else items = [{ kind: 'shot', id: start.id, sFrom: start.s, sTo: L[startIndex], payoffMs: start.payoffMs ?? null, moment: -1, hidden: false }];
    } else {
      const rail = ix.rail >= 0 ? ix.rail : shots.map((s, i) => i).sort((a, b) => ix.score[b] - ix.score[a] || byId(shots[a], shots[b]))[0];
      // A preview (no duration) holds the rail's payoff view.
      items = [{ kind: 'shot', id: shots[rail].id, sFrom: durationMs > 0 ? 0 : pay[rail], sTo: durationMs > 0 ? L[rail] : pay[rail], payoffMs: null, moment: -1, hidden: false }];
    }
    // Stretch uniformly over the remaining song; a payoff ahead keeps its place on that pace.
    const total = items.reduce((n, it) => n + it.sTo - it.sFrom, 0);
    let at = 0;
    for (const it of items) {
      const i = ix.shotIndex.get(it.id);
      if (it.kind === 'shot' && it.payoffMs === null && pay[i] > it.sFrom && total > 0 && durationMs > t0) {
        it.payoffMs = clamp(Math.round((t0 + (at + pay[i] - it.sFrom) / total * (durationMs - t0)) / SHOT_KEY_MS) * SHOT_KEY_MS, t0 + SHOT_KEY_MS, durationMs);
        it.hidden = !visibleAt(it.payoffMs);
      }
      at += it.sTo - it.sFrom;
    }
    return finish(items, Infinity, reason, null);
  };
  if (!nShots) throw new Error('shot library has no shots');
  if (!(durationMs > t0)) return fallbackPlan(durationMs ? 'nothing left to plan' : 'no duration');
  if (start && startIndex < 0) return fallbackPlan('committed element missing from the library');

  const lanes = rangeTables(intensity), vis = rangeTables(Float64Array.from({ length: nLane }, (_, i) => +visibleAt(i * SHOT_KEY_MS)));
  const flowAt = (I) => T.flowCalm + (T.flowEnergetic - T.flowCalm) * I;
  const inCalm = (t) => music.calm.some((c) => t >= c.startMs && t <= c.endMs);
  // Where the on-screen stretch containing t began (for the payoff-gap rule).
  const shownFrom = (t) => { let from = t; for (const v of intervals) if (t >= v.startMs && t <= v.endMs) from = Math.min(from, v.startMs); return from; };

  // Slots on a grid of the whole song (independent of t0), then the
  // committed knots of a replan; only those after t0 are used.
  const slotMap = new Map();
  const addSlot = (t, slot) => { const old = slotMap.get(t); if (!old || slot.imp > old.imp) slotMap.set(t, { t, ...slot }); };
  moments.forEach((m, k) => {
    const t = Math.round(m.timeMs / SHOT_KEY_MS) * SHOT_KEY_MS;
    if (t > 0 && t <= durationMs && visibleAt(t)) {
      addSlot(t, { kind: 'impact', moment: k, strength: m.strength, climax: m.climax, strong: m.strong, timing: Math.abs(t - m.timeMs),
        imp: w.impact * (1 + 1.5 * m.strength + (m.boundary ? .5 : 0) + (m.strong ? w.strong : 0)) * (m.climax ? w.climax : 1) });
    }
  });
  const near = (t, gap) => [...slotMap.keys()].some((u) => Math.abs(u - t) < gap);
  for (const p of music.phrases) {
    const t = Math.round(p / SHOT_KEY_MS) * SHOT_KEY_MS;
    if (t > 0 && t < durationMs && visibleAt(t) && !near(t, 2000)) addSlot(t, { kind: 'phrase', moment: -1, imp: .4 });
  }
  const free = (t) => (visibleAt(t) ? { kind: 'filler', moment: -1, imp: .25 } : { kind: 'hidden', moment: -1, imp: 0 });
  const fences = [0, ...[...slotMap.keys()].sort((a, b) => a - b), durationMs];
  for (let k = 1; k < fences.length; k++) {
    const gap = fences[k] - fences[k - 1];
    if (gap <= T.fillerGapMs) continue;
    const count = Math.ceil(gap / T.fillerSpacingMs) - 1;
    for (let q = 1; q <= count; q++) {
      const t = Math.round((fences[k - 1] + gap * q / (count + 1)) / SHOT_KEY_MS) * SHOT_KEY_MS;
      if (t > 0 && t < durationMs) addSlot(t, free(t));
    }
  }
  for (const t of [start?.next?.timeMs, ...(start?.knots || [])]) if (Number.isFinite(t) && t > t0 && t < durationMs && !slotMap.has(t)) addSlot(t, free(t));
  const slots = [...slotMap.values()].filter((s) => s.t > t0).sort((a, b) => a.t - b.t);
  slots.forEach((s) => {
    s.calm = inCalm(s.t) || intensity[Math.round(s.t / SHOT_KEY_MS)] < .3; s.lively = !s.calm && intensity[Math.round(s.t / SHOT_KEY_MS)] >= .6;
    s.climax = !!s.climax; s.strong = !!s.strong; s.strength ??= 0; s.timing ??= 0; s.from = shownFrom(s.t);
    // How much the first payoff of its on-screen stretch is worth: `window` for a stretch of payoffGapMs or more.
    s.window = w.window * Math.min(1, intervals.filter((v) => s.t >= v.startMs && s.t <= v.endMs).reduce((m, v) => Math.max(m, v.endMs - v.startMs), 0) / T.payoffGapMs);
  });
  const pick = (test) => slots.map((s, i) => i).filter((i) => test(slots[i]));
  const impactSlots = pick((s) => s.kind === 'impact'), strongSlots = pick((s) => s.kind === 'impact' && (s.strong || s.climax));
  const visSlots = pick((s) => s.kind === 'phrase' || s.kind === 'filler'), hidSlots = pick((s) => s.kind === 'hidden');
  const timesOf = (list) => Float64Array.from(list, (i) => slots[i].t);
  const impactT = timesOf(impactSlots), strongT = timesOf(strongSlots), visT = timesOf(visSlots), hidT = timesOf(hidSlots);
  const nextSlot = start?.next ? slots.findIndex((s) => s.t === start.next.timeMs) : -1;
  const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
  // A strong impact (or the climax) on screen in (ta, tb) that the tour passes
  // without a payoff costs `missStrong`: more than a hero climax is worth, so
  // a tour only gives up a drop for the climax's subject when both drops
  // cannot be had.
  const missedStrong = (ta, tb) => w.missStrong * Math.max(0, lowerBound(strongT, tb) - lowerBound(strongT, ta + 1));

  const jitter = Float64Array.from(shots, (s) => w.seedJitter * (hash01(seed, s.id) - .5));
  const linkJitter = Float64Array.from(links, (l) => w.seedJitter * (hash01(seed, l.id) - .5));
  const amax = T.maxAccelMps2, aside = sidewaysAccel(T), vmin = T.minSpeedMps, pinned = Number.isFinite(start?.speedMps);
  const startSpeed = pinned ? start.speedMps : null, startAccel = pinned && Number.isFinite(start.accelMps2) ? start.accelMps2 : 0;
  // A leg's speed cap over [ta, tb]: the speed limit, the bend's share of the
  // acceleration limit (the eye's acceleration is the profile's plus bend *
  // v^2; its share of progress is at most 1), and per part of the leg (rest
  // of a shot, link, next shot; `parts` = [length, max flow, ...]) the flow
  // limit at the quietest music while that part is on screen -- the parts'
  // times assume a steady pace, widened by up to 2 s for the profile's swing.
  // The upper bound (the most energetic music) prunes a leg's reachable slots.
  const capBound = (leg) => Math.min(T.maxSpeedMps, flowAt(1) / leg.max, curveCap(T, leg.bend, leg.turn), climbCap(T, leg.climb));
  const legCap = (ta, tb, leg) => {
    const parts = leg.parts, span = tb - ta, slack = Math.min(2000, .15 * span);
    let cap = Math.min(T.maxSpeedMps, curveCap(T, leg.bend, leg.turn), climbCap(T, leg.climb)), at = 0;
    for (let k = 0; k < parts.length; k += 2) {
      const a = ta + span * at / leg.D, b = ta + span * (at + parts[k]) / leg.D;
      at += parts[k];
      cap = Math.min(cap, flowAt(lanes.min(Math.max(ta, a - slack), Math.min(tb, b + slack))) / parts[k + 1]);
    }
    return cap;
  };
  const okLimits = (lim, cap, bend, turn) => lim.maxAccel + lim.peak * lim.peak * bend <= amax + 1e-9 && lim.peak * lim.peak * turn <= aside + 1e-9
    && lim.peak <= cap + 1e-9 && lim.low >= vmin - 1e-9;
  // Pace over [ta, tb] for `len` metres with flow integral `int`: the
  // comfortable pace (the music's flow limit over the leg's mean flow, at
  // most the speed limit) and the cost of flying it at v -- off the
  // comfortable pace (`comfortFlow` of it, within the cap) by the log ratio,
  // and per second below `crawlRatio` of it by the share it falls short (so
  // a crawl costs at most `crawl` per second: the climax still outweighs a
  // slow outro) -- both scaled by how much of it is on screen.
  const paceCost = (ta, tb, len, int, cap, v, seen) => {
    const dtS = (tb - ta) / 1000, ref = Math.min(T.maxSpeedMps, flowAt(lanes.mean(ta, tb)) * len / Math.max(1e-9, int));
    const target = clamp(T.comfortFlow * ref, vmin, Math.max(vmin, cap));
    let cost = w.comfort * dtS * Math.abs(Math.log(v / target)) * (w.hiddenComfort + (1 - w.hiddenComfort) * seen);
    if (v < T.crawlRatio * ref) cost += seen * w.crawl * dtS * (1 - v / (T.crawlRatio * ref));
    return cost;
  };
  // More than payoffGapMs on screen without a payoff, per second; and the
  // same for every on-screen stretch that closes in [ta, tb) (tb not in it)
  // with no payoff since `shownAt` -- a window that passes unpaid costs what
  // a late payoff in it would.
  const gapCost = (from, to) => w.gap * Math.max(0, to - from - T.payoffGapMs) / 1000;
  const closedGaps = (shownAt, ta, tb) => {
    let cost = 0;
    for (const v of intervals) if (v.endMs >= ta && v.endMs < tb && !(tb >= v.startMs && tb <= v.endMs)) cost += gapCost(Math.max(shownAt, v.startMs), v.endMs);
    return cost;
  };
  const repeatCost = (P, B) => {
    const s1 = ix.subj[B];
    let repeat = 0;
    if (s1 === P.s1) repeat += w.sameSubject; else if (s1 === P.s2) repeat += w.recentSubject; else if (s1 === P.s3) repeat += w.olderSubject;
    const moveRun = ix.move[B] === P.move ? P.moveRun + 1 : 1;
    if (moveRun >= 2) repeat += w.sameMove;
    if (moveRun >= 3) repeat += w.moveRun;
    if (Math.abs(((ix.heading[B] - P.heading + 540) % 360) - 180) < 30) repeat += w.heading;
    const elevRun = ix.elev[B] === P.elev ? P.elevRun + 1 : 1, lensRun = ix.lens[B] === P.lens ? P.lensRun + 1 : 1, fgRun = ix.fg[B] === P.fg ? P.fgRun + 1 : 1;
    repeat += w.run * (elevRun - 1 + lensRun - 1) + w.foregroundRun * (fgRun - 1);
    for (let q = P; q && !q.root; q = q.parent) if (q.shot === B) { repeat += w.reuse; break; }
    if (P.root && P.shot === B) repeat += w.reuse;
    return { repeat, moveRun, elevRun, lensRun, fgRun };
  };

  // Root state: the song start, or the committed element of a replan.
  const root = { root: true, t: t0, shot: -1, cost: 0, serial: 0, parent: null, s1: -1, s2: -1, s3: -1, move: null, moveRun: 0, heading: NaN,
    elev: -1, elevRun: 0, lens: -1, lensRun: 0, fg: -1, fgRun: 0, climax: 0, vbar: 0, rem: 0, endBase: 0, pending: null, pinV: null,
    shownAt: shownFrom(t0), paidFrom: -1 };
  if (start) {
    if (start.itemKind === 'link') {
      const j = startIndex, B = ix.lTo[j], part = laneStats(links[j].path, start.s, ix.lL[j], turnsOn);
      root.pending = { kind: 'link', link: j, shot: B, D: ix.lL[j] - start.s + pay[B], max: Math.max(part.max, ix.head[B].max), int: part.int + ix.head[B].int,
        bend: Math.max(ix.linkBend(j), ix.head[B].bend), climb: ix.remainingLinkClimb(j, start.s, startBefore), turn: Math.max(ix.lTurn[j], ix.head[B].turn), linkRest: ix.lL[j] - start.s, linkPart: ix.lL[j] - start.s, parts: [ix.lL[j] - start.s, part.max, pay[B], ix.head[B].max] };
      root.s1 = ix.subj[ix.lFrom[j]];
    } else if (start.s < pay[startIndex] - 1e-6) {
      const X = startIndex, part = laneStats(shotSupportedPath(shots[X].path, startBefore), start.s, pay[X], turnsOn);
      root.pending = { kind: 'shot', link: -1, shot: X, D: pay[X] - start.s, max: part.max, int: part.int, bend: part.bend, climb: part.climb, turn: part.turn, parts: [pay[X] - start.s, part.max] };
    } else {
      const X = startIndex, part = laneStats(shotSupportedPath(shots[X].path, startBefore), start.s, L[X], turnsOn);
      Object.assign(root, { shot: X, rem: L[X] - start.s, remMax: part.max, remInt: part.int, remBend: part.bend, remClimb: part.climb, remTurn: part.turn, endBase: start.s, s1: ix.subj[X], move: ix.move[X], moveRun: 1,
        heading: ix.heading[X], elev: ix.elev[X], elevRun: 1, lens: ix.lens[X], lensRun: 1, fg: ix.fg[X], fgRun: 1 });
    }
    // The committed timeline's last knot so far, when on screen in this
    // stretch, was its last payoff: the gap rule counts from there.
    const last = Math.max(start.lastKnotMs ?? -1, Number.isFinite(start.payoffMs) ? start.payoffMs : -1);
    if (last >= 0 && visibleAt(last) && shownFrom(last) === shownFrom(t0) && visibleAt(t0)) { root.shownAt = Math.max(root.shownAt, last); root.paidFrom = shownFrom(t0); }
  }

  const incomingBefore = (P) => P.root ? startBefore : P.link >= 0 ? links[P.link].path : P.continued && P.parent?.root ? startBefore : null;
  // Choosing an outgoing link can reshape the same source segment as the
  // incoming support on a two-sample shot. It can also reshape the head
  // already checked when a payoff lies in the final source segment. Check
  // the selected pair together, and recheck the preceding interval's cap.
  const withDeparture = (P, leg, j) => {
    const path = shots[P.shot].path, n = path.s.length;
    const headChanges = !P.root && P.endBase > path.s[n - 2];
    if (n !== 2 && !headChanges) return leg;
    const before = incomingBefore(P), both = n === 2 && before;
    if (!both && !headChanges) return leg;
    const supported = shotSupportedPath(path, before, links[j].path);
    if (both) leg.climb = Math.max(leg.climb, rangeMax(supported, P.endBase, L[P.shot], 2));
    if (headChanges) {
      const from = P.continued && P.parent?.root && start?.itemKind === 'shot' ? start.s : 0;
      leg.priorCap = Math.min(P.cap, climbCap(T, rangeMax(supported, from, P.endBase, 2)));
    }
    return leg;
  };

  const W = Math.max(1, T.beamWidth | 0), buckets = new Array(slots.length).fill(null);
  let serial = 1, best = null, lastResort = null, expansions = 0, kept = 0;
  const prune = (bucket) => {
    bucket.list.sort((a, b) => a.cost - b.cost || a.serial - b.serial);
    const seen = new Set(), perShot = new Map(), out = [];
    for (const s of bucket.list) {
      const key = s.shot * 4096 + s.s2 + 1, n = perShot.get(s.shot) || 0;
      if (seen.has(key) || n >= T.statesPerShot) continue;
      seen.add(key); perShot.set(s.shot, n + 1); out.push(s);
      if (out.length >= W) break;
    }
    bucket.list = out; bucket.worst = out.length >= W ? out[out.length - 1].cost : Infinity;
  };

  // One leg from state P to shot B's payoff at slot si, through link j.
  // True when the leg is legal (whether or not its state survives the beam).
  const evaluate = (P, leg, si) => {
    const slot = slots[si], B = leg.shot, dtS = (slot.t - P.t) / 1000, v = leg.D / dtS;
    expansions++;
    if (!(dtS > 0)) return false;
    // The committed start's first leg is held to the hard limits only, and
    // keeps the committed knot's speed when it lands on that knot.
    const committed = P.root && !!start, pinV = committed && si === nextSlot && shots[B].id === start.next.id ? start.next.speedMps : null;
    let cap = legCap(P.t, slot.t, leg);
    if (!committed && (v < vmin - 1e-9 || v > T.capMargin * cap)) return false;
    let Vk = v, Ak = 0;
    if (P.root) { if (pinned) { Vk = startSpeed; Ak = startAccel; } }
    else {
      Vk = P.pinV ?? knotSpeed(P.vbar, P.dt, v, dtS);
      if (!okLimits(intervalLimits(P.V, P.A, Vk, 0, P.vbar, P.dt), leg.priorCap ?? P.cap, P.bend, P.turn)) return false;
    }
    if (!okLimits(intervalLimits(Vk, Ak, pinV ?? v, 0, v, dtS), cap, leg.bend, leg.turn)) return false;
    if (leg.lazyLink >= 0) {
      // Legal without its link's own bend: measure that now and check again.
      leg.bend = Math.max(leg.bend, ix.linkBend(leg.lazyLink)); leg.climb = Math.max(leg.climb, ix.linkClimb(leg.lazyLink)); leg.lazyLink = -1;
      cap = legCap(P.t, slot.t, leg);
      if (!committed && v > T.capMargin * cap) return false;
      if (!okLimits(intervalLimits(Vk, Ak, pinV ?? v, 0, v, dtS), cap, leg.bend, leg.turn)) return false;
    }
    // Soft costs of what a viewer sees scale with the leg's share on screen.
    const hidden = slot.kind === 'hidden', seen = vis.mean(P.t, slot.t);
    let cost = P.cost + paceCost(P.t, slot.t, leg.D, leg.int, cap, v, seen) + w.timing * slot.timing;
    const before = P.root ? startSpeed : P.cv;
    if (before > 0) cost += seen * w.change * Math.abs(Math.log(v / before));
    let shownAt = P.shownAt;
    cost += closedGaps(P.shownAt, P.t, slot.t) + missedStrong(P.t, slot.t);
    if (!hidden) {
      // The first payoff of an on-screen stretch is worth more: a window that
      // passes without one is worse than a climax on another subject.
      if (P.paidFrom !== slot.from) cost -= slot.window;
      cost += gapCost(Math.max(P.shownAt, slot.from), slot.t); shownAt = slot.t;
    }
    if (!hidden) cost -= w.shot * (w.scoreBase + ix.score[B]) * (slot.imp + w.showing) * (1 + jitter[B]);
    if (leg.link >= 0 && !leg.continued) cost -= seen * w.link * ix.lScore[leg.link] * (1 + linkJitter[leg.link]);
    if (leg.link >= 0) cost += seen * w.linkTime * dtS * leg.linkPart / leg.D;
    // The music's character: calm slots want gentle moves, lively ones
    // approaches, reveals and passes (the climax wants its hero instead).
    if (!hidden && slot.calm && ix.lively[B]) cost += w.calmEnergetic;
    if (!hidden && slot.lively && !slot.climax && ix.gentle[B]) cost += w.energyGentle;
    if (slot.kind === 'impact' && !slot.climax && slot.strength >= .5 && ix.gentle[B]) cost += w.impactGentle;
    let climax = P.climax;
    if (slot.climax) {
      climax = ix.hero[B] ? 2 : 1;
      if (ix.hero[B]) cost -= ix.heroTop[B] ? w.climaxHero : w.climaxHeroAny;
    }
    // (The committed element's own leg repeats whatever it repeats: every
    // continuation pays that alike, so it is not charged.)
    const r = repeatCost(P, B);
    if (!(committed && leg.continued)) cost += seen * r.repeat;
    if (P.root && !start) {
      let open = ix.lively[B] && !ix.gentle[B] ? w.energeticOpen : 0;
      if (ix.move[B] === 'rail') open -= w.railOpen; else if (ix.high[B] || ix.wide[B]) open -= w.wideOpen;
      cost += seen * open;
    }
    let bucket = buckets[si];
    if (!bucket) bucket = buckets[si] = { list: [], worst: Infinity };
    if (cost >= bucket.worst) return true;
    bucket.list.push({ root: false, t: slot.t, si, shot: B, link: leg.link, continued: !!leg.continued, parent: P, cost, serial: serial++,
      rem: L[B] - pay[B], remMax: ix.tail[B].max, remInt: ix.tail[B].int, remBend: ix.tail[B].bend, remClimb: ix.tailClimb(B, leg.link >= 0 ? links[leg.link].path : leg.continued ? startBefore : null), remTurn: ix.tail[B].turn, endBase: pay[B], V: Vk, A: Ak, vbar: v, dt: dtS, cap, bend: leg.bend, turn: leg.turn,
      s1: ix.subj[B], s2: P.s1, s3: P.s2, move: ix.move[B], moveRun: r.moveRun, heading: ix.heading[B], elev: ix.elev[B], elevRun: r.elevRun, lens: ix.lens[B], lensRun: r.lensRun,
      fg: ix.fg[B], fgRun: r.fgRun, climax, pending: null, pinV, shownAt, paidFrom: hidden ? P.paidFrom : slot.from,
      // The pace the next leg's speed change is measured from: on the committed knot, the committed leg's (as the plan that made it saw it).
      cv: pinV != null && Number.isFinite(start.next.legMps) ? start.next.legMps : v });
    if (bucket.list.length >= 3 * W) prune(bucket);
    return true;
  };

  // A leg tries the next few impacts it can reach (and the next strong
  // ones beyond them) as far as it reaches at the minimum speed, and the
  // visible and the pass-through slots nearest a comfortable pace (separate
  // quotas; slower ones up to fillerReachMs on).
  // Quotas count legal legs (a leg's slots nearest its bounds may still be
  // too fast for the music there); at most twice the quota are tried.
  const nearest = (P, leg, times, list, at, lo, hi, quota, hiRight = hi) => {
    let left = lowerBound(times, at) - 1, right = left + 1, taken = 0, tried = 0;
    while (taken < quota && tried < 2 * quota) {
      const okL = left >= 0 && times[left] >= lo && times[left] <= hi, okR = right < times.length && times[right] <= hiRight;
      if (!okL && !okR) break;
      if (okR && (!okL || times[right] - at <= at - times[left])) { if (times[right] >= lo) { taken += evaluate(P, leg, list[right]); tried++; } right++; }
      else { taken += evaluate(P, leg, list[left]); tried++; left--; }
    }
  };
  const expandLeg = (P, leg) => {
    if (!(leg.D > 0)) return;
    const committed = P.root && !!start;
    if (leg.lazyLink >= 0) {
      // A link's bend is measured the first time a leg through it could reach
      // a slot at all (as far as the leg can go at the minimum speed).
      if (!committed && P.t + 1000 * leg.D / (T.capMargin * capBound(leg)) > Math.min(durationMs, P.t + 1000 * leg.D / vmin)) return;
      if (committed || ix.lBend[leg.lazyLink] >= 0) { leg.bend = Math.max(leg.bend, ix.linkBend(leg.lazyLink)); leg.climb = Math.max(leg.climb, ix.linkClimb(leg.lazyLink)); leg.lazyLink = -1; }
    }
    const capHi = capBound(leg);
    let lo = P.t + 1000 * leg.D / ((committed ? 1 : T.capMargin) * capHi);
    // The cap over the leg's own earliest span (the music there) tightens it.
    if (!committed && lo < durationMs) lo = Math.max(lo, P.t + 1000 * leg.D / (T.capMargin * legCap(P.t, lo, leg)));
    // One reach for every kind of slot: as far as the leg can go at the minimum speed.
    const hi = Math.min(durationMs, P.t + 1000 * leg.D / vmin);
    if (committed && nextSlot >= 0 && shots[leg.shot].id === start.next.id) evaluate(P, leg, nextSlot);
    if (lo > hi) return;
    let last = -1;
    for (let k = lowerBound(impactT, lo), n = 0, tried = 0; k < impactT.length && impactT[k] <= hi && n < T.impactsPerLeg && tried < 2 * T.impactsPerLeg; k++, tried++) {
      n += evaluate(P, leg, impactSlots[k]); last = k;
    }
    for (let k = lowerBound(strongT, lo), n = 0, tried = 0; k < strongT.length && strongT[k] <= hi && n < T.strongPerLeg && tried < 2 * T.strongPerLeg; k++) {
      if (lowerBound(impactT, strongT[k]) > last) { n += evaluate(P, leg, strongSlots[k]); tried++; }
    }
    const ref = Math.min(T.maxSpeedMps, flowAt(lanes.mean(P.t, P.t + 1000 * leg.D / Math.max(vmin, 20))) * leg.D / Math.max(1e-9, leg.int));
    const pace = clamp(T.comfortFlow * ref, vmin, T.capMargin * capHi);
    const at = P.t + 1000 * leg.D / pace;
    // Fillers slower than the comfortable pace: at most fillerReachMs on (a search bound, not a rule).
    const near = Math.min(hi, P.t + T.fillerReachMs);
    nearest(P, leg, visT, visSlots, at, lo, hi, T.freeSlotsPerLeg, near);
    nearest(P, leg, hidT, hidSlots, at, lo, hi, T.hiddenSlotsPerLeg, near);
    // And the knot from which the shot's rest would carry the camera to the
    // song end at this pace, so a quiet or off-screen ending has a way out.
    const end = durationMs - 1000 * (L[leg.shot] - pay[leg.shot]) / pace;
    if (end > at + 1000) { nearest(P, leg, visT, visSlots, end, lo, hi, 1, near); nearest(P, leg, hidT, hidSlots, end, lo, hi, 1, near); }
  };
  const expand = (P) => {
    if (P.pending) { const p = P.pending; expandLeg(P, { shot: p.shot, link: p.link, continued: true, D: p.D, max: p.max, int: p.int, bend: p.bend, climb: p.climb, turn: p.turn, linkPart: p.linkPart || 0, parts: p.parts }); return; }
    if (P.shot < 0) {
      for (let B = 0; B < nShots; B++) expandLeg(P, { shot: B, link: -1, D: pay[B], max: ix.head[B].max, int: ix.head[B].int, bend: ix.head[B].bend, climb: ix.head[B].climb, turn: ix.head[B].turn, parts: [pay[B], ix.head[B].max] });
      return;
    }
    for (const j of ix.out[P.shot]) {
      const B = ix.lTo[j];
      expandLeg(P, withDeparture(P, { shot: B, link: j, D: P.rem + ix.lL[j] + pay[B], max: Math.max(P.remMax, ix.lMax[j], ix.head[B].max), int: P.remInt + ix.lInt[j] + ix.head[B].int,
        bend: Math.max(P.remBend, ix.head[B].bend), climb: Math.max(P.remClimb, ix.head[B].climb), lazyLink: j, turn: Math.max(P.remTurn, ix.lTurn[j], ix.head[B].turn), linkPart: ix.lL[j], parts: [P.rem, P.remMax, ix.lL[j], ix.lMax[j], pay[B], ix.head[B].max] }, j));
    }
  };

  // Bound only the prefix that an ending actually traverses. The final item
  // has no outgoing support: a neighbour changes its curve only when the
  // selected plan actually reaches that neighbour. Each topology therefore
  // has its own monotone prefix bound and speed-search interval.
  const endingClimb = (P, via = -1) => {
    let entries;
    if (P.pending?.kind === 'link') entries = [[links[P.pending.link].path, start.s], [shots[P.pending.shot].path, 0]];
    else if (P.pending) entries = [[shots[P.pending.shot].path, start.s]];
    else entries = [[shots[P.shot].path, P.endBase]];
    if (via >= 0) entries.push([links[via].path, 0], [shots[ix.lTo[via]].path, 0]);
    const before = incomingBefore(P);
    let at = 0;
    return entries.map(([path, from], last) => {
      const lo = at, hi = at += path.s.at(-1) - from;
      const paths = entries.slice(0, last + 1).map(([p], i) => shotSupportedPath(p, i ? entries[i - 1][0] : before, i < last ? entries[i + 1][0] : null));
      return { lo, hi, bound: (distance) => {
        let max = 0;
        for (let i = 0; i <= last && distance > 0; i++) {
          const [p, a] = entries[i], take = Math.min(p.s.at(-1) - a, distance);
          max = rangeMax(paths[i], a, a + take, 2, max); distance -= take;
        }
        return max;
      } };
    });
  };

  // The song end from state P over its last tau seconds, with `avail` metres
  // ahead at most and `least` at least: the speed nearest the comfortable
  // pace that keeps the last interval in the limits, or undefined.
  const endSpeed = (P, tau, least, avail, end, quick = false) => {
    if (end.climbRanges) {
      // Support can change at each reached neighbour. Search the separate
      // monotone intervals, then prefer the one nearest the comfort target.
      const ref = T.comfortFlow * Math.min(T.maxSpeedMps, flowAt(lanes.mean(P.t, durationMs)) * end.D / Math.max(1e-9, end.int));
      let candidate, feasible = false;
      for (let i = 0; i < end.climbRanges.length; i++) {
        const range = end.climbRanges[i], low = Math.max(least, range.lo + (i ? 2e-6 : 0)), high = Math.min(avail, range.hi);
        if (high < low) continue;
        const result = endSpeed(P, tau, low, high, { ...end, climbRanges: null, climbAt: range.bound }, quick);
        if (result !== null) feasible = true;
        if (result && (!candidate || Math.abs(result.v - ref) < Math.abs(candidate.v - ref))) candidate = result;
      }
      return candidate || (quick && !feasible ? null : undefined);
    }
    const baseCap = legCap(P.t, durationMs, end.climbAt ? { ...end, climb: 0 } : end), lo = Math.max(vmin, least / tau);
    const capAt = (v) => end.climbAt ? Math.min(baseCap, climbCap(T, end.climbAt(v * tau))) : baseCap;
    let hi = Math.min(T.capMargin * baseCap, avail / tau);
    if (hi < lo || lo > T.capMargin * capAt(lo) + 1e-9) return quick ? null : undefined;
    // Within one support topology, fixed analytic cells make the
    // conservative prefix bound monotone. Keep all acceleration checks.
    if (hi > T.capMargin * capAt(hi)) {
      let low = lo, high = hi;
      for (let k = 0; k < 24; k++) { const mid = (low + high) / 2; if (mid <= T.capMargin * capAt(mid)) low = mid; else high = mid; }
      hi = low;
    }
    const ref = Math.min(T.maxSpeedMps, flowAt(lanes.mean(P.t, durationMs)) * end.D / Math.max(1e-9, end.int)), comfort = clamp(T.comfortFlow * ref, lo, hi);
    const before = P.root ? startSpeed : P.cv, keep = clamp(before || comfort, lo, hi);
    const ok = (u) => {
      const cap = capAt(u), Vk = P.root ? (pinned ? startSpeed : u) : P.pinV ?? knotSpeed(P.vbar, P.dt, u, tau), Ak = P.root ? startAccel : 0;
      return (P.root || okLimits(intervalLimits(P.V, P.A, Vk, 0, P.vbar, P.dt), end.priorCap ?? P.cap, P.bend, P.turn)) && okLimits(intervalLimits(Vk, Ak, u, 0, u, tau), cap, end.bend, end.turn);
    };
    // The last knot's committed speed (a replan's pin) is a candidate too: a
    // continuation that keeps the committed sequence must find its ending.
    const pinV = P.pinV != null ? clamp(P.pinV, lo, hi) : comfort;
    let v = (quick ? [comfort, keep, pinV] : [comfort, keep, pinV, (comfort + keep) / 2, hi, lo]).find(ok);
    // Clamping can collapse all quick choices to one infeasible speed even
    // when a slower legal ending exists. Try three distinct interior speeds
    // after those original choices, with the same physical checks.
    if (v === undefined && quick && hi > lo && comfort === keep && keep === pinV) v = [.5, .25, .75].map(share => lo + (hi - lo) * share).find(ok);
    // On a committed knot the feasible speeds may lie between the candidates: try 15 spread over [lo, hi].
    if (v === undefined && !quick && P.pinV != null) for (let k = 1; k < 16 && v === undefined; k++) { const u = lo + (hi - lo) * ((k * 9) % 16) / 16; if (ok(u)) v = u; }
    return v === undefined ? undefined : { v, cap: capAt(v), crawl: v < T.crawlRatio * ref };
  };
  const endCosts = (P, tau, v, cap, len, int) => {
    const seen = vis.mean(P.t, durationMs), before = P.root ? startSpeed : P.cv;
    let cost = paceCost(P.t, durationMs, len, int, cap, v, seen);
    if (before > 0) cost += seen * w.change * Math.abs(Math.log(v / before));
    return { cost, seen };
  };
  // The song end from state P: ride on inside its current element, or (from
  // a shot, when that is impossible or would crawl) through one more link
  // into a last shot that the song ends in before its payoff -- or, at a
  // cost, inside that link. An ending on a pullback, high or crane shot
  // earns `outroMove`, and `outro` more after a hero climax.
  const terminal = (P) => {
    if (P.root && !start) return;
    const tau = (durationMs - P.t) / 1000, avail = P.pending ? P.pending.D - .5 : P.rem;
    const end = P.pending ? { ...P.pending } : { D: Math.max(1e-9, P.rem), max: P.remMax, int: P.remInt, bend: P.remBend, climb: P.remClimb, turn: P.remTurn, parts: [Math.max(1e-9, P.rem), P.remMax] };
    if (climbCap(T, end.climb) < T.maxSpeedMps && climbCap(T, end.climb) < legCap(P.t, durationMs, { ...end, climb: 0 })) end.climbRanges = endingClimb(P);
    const gap = gapCost(Math.max(P.shownAt, shownFrom(durationMs)), durationMs) + closedGaps(P.shownAt, P.t, durationMs) + missedStrong(P.t, durationMs + 1);
    let inside = null;
    if (tau <= 1e-9) {
      if (P.root || okLimits(intervalLimits(P.V, P.A, P.vbar, 0, P.vbar, P.dt), P.cap, P.bend, P.turn)) inside = { cost: P.cost + gap, v: 0, seen: 1, crawl: false };
    } else {
      const sp = endSpeed(P, tau, 0, avail, end);
      if (sp) {
        const c = endCosts(P, tau, sp.v, sp.cap, Math.min(avail, sp.v * tau), end.int * Math.min(1, sp.v * tau / end.D));
        inside = { cost: P.cost + gap + c.cost, v: sp.v, seen: c.seen, crawl: sp.crawl };
      }
    }
    if (inside) {
      let cost = inside.cost;
      if (P.shot >= 0 && !P.pending && ix.outro[P.shot]) cost -= (w.outroMove + (P.climax === 2 ? w.outro : 0)) * (tau > 0 ? inside.seen : 1);
      // A replan's committed element ridden to the song end without its
      // payoff is a last resort: a fresh plan has no such ending (it ends
      // after a payoff, or within endViaMs of one), so it must not undercut
      // the committed continuation.
      if (P.pending) lastResort = { cost, state: P, e: inside.v * Math.max(0, tau), via: -1 };
      else if (!best || cost < best.cost) best = { cost, state: P, e: inside.v * Math.max(0, tau), via: -1 };
    }
    if (P.shot < 0 || P.pending || !(tau > 0) || (inside && !inside.crawl) || tau * 1000 > T.endViaMs) return;
    // An ending in transit only when this state has no other way to the end.
    let reached = !!inside, transit = null;
    for (const j of ix.outEnd[P.shot]) {
      const B = ix.lTo[j], through = P.rem + ix.lL[j], room = .98 * pay[B];
      if (!(room > 1)) continue;
      const leg = withDeparture(P, { D: through + room, max: Math.max(P.remMax, ix.lMax[j], ix.head[B].max), int: P.remInt + ix.lInt[j] + ix.head[B].int * .98,
        bend: Math.max(P.remBend, ix.linkBend(j), ix.head[B].bend), climb: Math.max(P.remClimb, ix.linkClimb(j), ix.head[B].climb), turn: Math.max(P.remTurn, ix.lTurn[j], ix.head[B].turn), parts: [P.rem, P.remMax, ix.lL[j], ix.lMax[j], room, ix.head[B].max] }, j);
      if (climbCap(T, leg.climb) < T.maxSpeedMps && climbCap(T, leg.climb) < legCap(P.t, durationMs, { ...leg, climb: 0 })) leg.climbRanges = endingClimb(P, j);
      const sp = endSpeed(P, tau, through + 1, through + room, leg, true);
      // (null: the last shot is out of reach at any legal speed.)
      if (sp === null) {
        if (reached) continue;
        // Too far to reach the last shot: end in the link itself, if it is
        // not too fast for that either (`endInLink` for an ending in transit).
        const part = withDeparture(P, { D: through, max: Math.max(P.remMax, ix.lMax[j]), int: P.remInt + ix.lInt[j], bend: Math.max(P.remBend, ix.linkBend(j)), climb: Math.max(P.remClimb, ix.linkClimb(j)), turn: Math.max(P.remTurn, ix.lTurn[j]), parts: [P.rem, P.remMax, ix.lL[j], ix.lMax[j]] }, j);
        part.climbRanges = leg.climbRanges;
        const mid = endSpeed(P, tau, P.rem + 1, through - 1, part, true);
        if (!mid) continue;
        const e = mid.v * tau, c = endCosts(P, tau, mid.v, mid.cap, e, P.remInt + ix.lInt[j] * Math.min(1, (e - P.rem) / ix.lL[j]));
        const candidate = { cost: P.cost + c.cost + gap + c.seen * (w.endInLink + w.linkTime * tau * (e - P.rem) / e), state: P, e, via: j, inLink: true };
        if (!transit || candidate.cost < transit.cost) transit = candidate;
        continue;
      }
      if (!sp) continue;
      reached = true;
      const e = sp.v * tau, c = endCosts(P, tau, sp.v, sp.cap, e, P.remInt + ix.lInt[j] + ix.head[B].int * Math.min(1, (e - through) / pay[B]));
      let total = P.cost + c.cost + gap + c.seen * repeatCost(P, B).repeat;
      total -= c.seen * w.link * ix.lScore[j] * (1 + linkJitter[j]);
      total += c.seen * w.linkTime * tau * ix.lL[j] / e;
      // A partial final shot earns only the share of its head actually played;
      // entering an outro by a metre must not buy the full ending reward.
      if (ix.outro[B]) total -= c.seen * (w.outroMove + (P.climax === 2 ? w.outro : 0)) * clamp((e - through) / pay[B], 0, 1);
      if (!best || total < best.cost) best = { cost: total, state: P, e, via: j };
    }
    if (!reached && transit && (!best || transit.cost < best.cost)) best = transit;
  };

  expand(root); terminal(root);
  for (let si = 0; si < slots.length; si++) {
    const bucket = buckets[si];
    if (!bucket) continue;
    prune(bucket); buckets[si] = null; kept += bucket.list.length;
    for (const P of bucket.list) { terminal(P); expand(P); }
  }
  const stats = { slots: slots.length, kept, expansions };
  best ??= lastResort;
  if (!best) return fallbackPlan('no feasible shot sequence');

  // Items from the winning chain.
  const chain = [];
  for (let s = best.state; s; s = s.parent) chain.push(s);
  chain.reverse();
  const items = [];
  let open = null;
  const shotItem = (B, sFrom, slot) => ({ kind: 'shot', id: shots[B].id, sFrom, sTo: L[B], payoffMs: slot ? slot.t : null,
    moment: slot ? slot.moment : -1, hidden: slot ? slot.kind === 'hidden' : false });
  if (root.pending?.kind === 'link') items.push({ kind: 'link', id: start.id, sFrom: start.s, sTo: ix.lL[root.pending.link] });
  else if (start && !root.pending) { open = shotItem(root.shot, start.s, null); open.payoffMs = start.payoffMs ?? null; items.push(open); }
  for (let k = 1; k < chain.length; k++) {
    const st = chain[k], slot = slots[st.si];
    if (st.link >= 0 && !st.continued) {
      if (open) open.sTo = L[ix.shotIndex.get(open.id)];
      items.push({ kind: 'link', id: links[st.link].id, sFrom: 0, sTo: ix.lL[st.link] });
    }
    open = shotItem(st.shot, k === 1 && root.pending?.kind === 'shot' ? start.s : 0, slot);
    items.push(open);
  }
  if (best.via >= 0) {
    // Through one more link into the last shot, which the song ends in (or into the link only).
    const j = best.via, X = ix.shotIndex.get(open.id), B = ix.lTo[j];
    open.sTo = L[X];
    if (best.inLink) items.push({ kind: 'link', id: links[j].id, sFrom: 0, sTo: Math.min(ix.lL[j], best.e - best.state.rem) });
    else {
      items.push({ kind: 'link', id: links[j].id, sFrom: 0, sTo: ix.lL[j] });
      items.push({ ...shotItem(B, 0, null), sTo: Math.min(pay[B], best.e - (best.state.rem + ix.lL[j])) });
    }
  } else if (chain.length > 1 || !root.pending) open.sTo = Math.min(L[ix.shotIndex.get(open.id)], best.state.endBase + best.e);
  else if (root.pending.kind === 'shot') items.push({ ...shotItem(root.pending.shot, start.s, null), sTo: start.s + best.e });
  else {
    // Ending inside the committed link, or just past it before the next payoff.
    const link = items[0], rest = root.pending.linkRest;
    if (best.e <= rest) link.sTo = start.s + best.e;
    else items.push({ ...shotItem(root.pending.shot, 0, null), sTo: best.e - rest });
  }
  const nonEmpty = items.filter((it) => it.sTo - it.sFrom > 1e-6);
  const shown = nonEmpty.filter((it) => it.kind === 'shot' && Number.isFinite(it.payoffMs) && !it.hidden && it.payoffMs > t0);
  const hit = shown.filter((it) => it.moment >= 0).length;
  const ahead = moments.filter((m) => m.timeMs > t0), climaxAhead = ahead.some((m) => m.climax);
  const strongAhead = ahead.filter((m) => m.strong && visibleAt(m.timeMs)), strongHit = strongAhead.filter((m) => shown.some((it) => it.moment >= 0 && moments[it.moment] === m)).length;
  notes.push(`payoffs on ${hit} of ${ahead.length} impacts (${strongHit} of ${strongAhead.length} strong)${climaxAhead ? `; climax ${best.state.climax === 2 ? 'on a hero shot' : best.state.climax ? 'on a non-hero shot' : 'missed'}` : ''}`);
  for (const v of intervals) {
    if (v.endMs - Math.max(v.startMs, t0) >= 10000 && !shown.some((it) => it.payoffMs >= v.startMs && it.payoffMs <= v.endMs)) notes.push(`no payoff on screen ${v.startMs}-${v.endMs} ms`);
  }
  const pin = chain[1]?.pinV != null ? { timeMs: chain[1].t, speedMps: chain[1].pinV } : null;
  return finish(nonEmpty.length ? nonEmpty : items, best.cost, null, stats, pin);
}
