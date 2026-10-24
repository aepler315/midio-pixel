// Scenic shot tours: candidate shot generation (docs/scenic-tours.md).
//
// Each generator builds complete camera moves around one subject -- an
// approach into the payoff, the payoff itself, a sustained view and a
// departure -- as control points sampled into a ShotPath. Moves follow the
// region's actual structure: reveals start behind a real occluding crest
// found by line of sight, valley and shoreline runs follow measured floors
// and shores, orbits hold a stand-off from the subject's own footprint, and
// distances and lenses scale with the subject's relief. Every eye sample is
// lifted to the conservative clearance floor before the path ships; nothing
// here judges beauty (tools/lib/scenic-score.mjs and the renderer do).
import { samplePath, pathPoseAt, withProgress } from '../../src/world/terrain/ShotPath.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const hyp2 = (x, z) => Math.hypot(x, z);
/** Unit horizontal vector for a heading (degrees clockwise from north, -Z). */
export const headingVec = (deg) => [Math.sin(deg * DEG), -Math.cos(deg * DEG)];
export const headingOf = (dx, dz) => ((Math.atan2(dx, -dz) / DEG) + 360) % 360;
const wrap180 = (d) => ((d % 360) + 540) % 360 - 180;

/** Subject scale: horizontal size and vertical relief that set distances. */
export function subjectScale(subject) {
  const relief = Math.max(60, subject.heightM || 200);
  const size = Math.max(subject.radiusM || 300, relief * 0.9);
  return { relief, size, base: subject.posM[1] - relief };
}

/** Field of view that makes a subject of angular height theta fill `fill`
 *  of the frame, snapped to the region's lens set. */
export function lensFor(theta, lenses, fill = 0.36) {
  const want = clamp(theta / DEG / fill, lenses.tele, lenses.wide);
  const classes = Object.entries(lenses).sort((a, b) => Math.abs(a[1] - want) - Math.abs(b[1] - want));
  return { lens: classes[0][0], fovYDeg: classes[0][1] };
}

/** Straight-line visibility of `point` from `eye` over the DEM (earth
 *  curvature ignored: generators use it at short range only). */
export function lineOfSight(heightAt, eye, point, { stepM = 30, slackM = 4 } = {}) {
  const dx = point[0] - eye[0], dy = point[1] - eye[1], dz = point[2] - eye[2], d = hyp2(dx, dz);
  const n = Math.max(2, Math.ceil(d / stepM));
  for (let i = 1; i < n; i++) {
    const t = i / n, h = heightAt(eye[0] + dx * t, eye[2] + dz * t);
    if (Number.isFinite(h) && h > eye[1] + dy * t + slackM) return false;
  }
  return true;
}

/**
 * Lift a sampled path so every eye sample clears the floor, with a smooth
 * lift envelope (a raised-cosine spread over `spreadM` of progress) so the
 * correction never shows as a bump. Aim points stay. Returns null when the
 * required lift is excessive (the move should be dropped, not flattened).
 */
export function liftToClearance(path, floorAt, { spreadM = 300, maxLiftM = 900 } = {}) {
  const n = path.s.length, need = new Float64Array(n);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const f = floorAt(path.eye[i * 3], path.eye[i * 3 + 2]);
    if (!Number.isFinite(f)) return null;
    need[i] = Math.max(0, f - path.eye[i * 3 + 1]);
    worst = Math.max(worst, need[i]);
  }
  if (worst > maxLiftM) return null;
  if (worst === 0) return path;
  const lift = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!(need[i] > 0)) continue;
    for (let j = 0; j < n; j++) {
      const d = Math.abs(path.s[j] - path.s[i]);
      if (d >= spreadM) continue;
      lift[j] = Math.max(lift[j], need[i] * 0.5 * (1 + Math.cos(Math.PI * d / spreadM)));
    }
  }
  const eye = Float32Array.from(path.eye);
  for (let i = 0; i < n; i++) eye[i * 3 + 1] += lift[i] + (lift[i] > 0 ? 2 : 0);
  // Recheck: the raised-cosine envelope can only add height.
  for (let i = 0; i < n; i++) if (eye[i * 3 + 1] < floorAt(eye[i * 3], eye[i * 3 + 2]) - 0.5) return null;
  return withProgress({ ...path, eye });
}

/** Eye height for an elevation class at (x, z) for a subject. */
function eyeHeight(cls, subject, floor, scale) {
  const top = subject.posM[1];
  if (cls === 'low') return floor + 20;
  if (cls === 'mid') return Math.max(floor + 60, scale.base + 0.55 * scale.relief);
  return Math.max(floor + 120, top + 0.25 * scale.relief + 60);
}

/** Aim point that places the subject's visual mass on a thirds line
 *  (side -1 left, 0 centre, +1 right) for an eye at `eye`. */
function aimPoint(subject, scale, eye, side, fovYDeg, aspect = 16 / 9, heightFrac = 0.55) {
  const p = subject.posM, dx = p[0] - eye[0], dz = p[2] - eye[2], d = Math.max(1, hyp2(dx, dz));
  const hfov = 2 * Math.atan(Math.tan(fovYDeg * DEG / 2) * aspect);
  const shift = side * d * Math.tan(hfov / 6);
  // Offset perpendicular to the line of sight, opposite the requested side,
  // so the subject itself lands on that side of the frame.
  const px = -dz / d, pz = dx / d;
  return [p[0] - px * shift, scale.base + heightFrac * scale.relief, p[2] - pz * shift];
}

/**
 * Whether a downward ray from `eye` leaves the DEM grid before it meets the
 * ground: the package has no terrain beyond the grid, and the app paints
 * such a ray with the sky.
 */
// Earth curvature with standard refraction, as the scorer's raster applies.
const CURVE_R = 6371000 / (1 - 0.13);
export function rayEscapes(ctx, eye, dir, { stepM = 60, maxM = 80000 } = {}) {
  if (!(dir[1] < 0)) return false; // at or above the horizontal: sky
  const g = ctx.grid, x1 = g.originM[0] + (g.width - 1) * g.cellSizeM, z1 = g.originM[1] + (g.height - 1) * g.cellSizeM;
  for (let d = stepM; d <= maxM; d += Math.max(stepM, d * 0.01)) {
    const x = eye[0] + dir[0] * d, y = eye[1] + dir[1] * d, z = eye[2] + dir[2] * d;
    if (x < g.originM[0] || z < g.originM[1] || x > x1 || z > z1) return true;
    const h = ctx.heightAt(x, z) - (d * d) / (2 * CURVE_R);
    if (Number.isFinite(h) && h >= y) return false;
  }
  return false;
}

/** Whether a sampled path's frame tops stay on the grid (every `every`th
 *  sample and the last). */
function pathSeesEdge(ctx, path, { every = 3, aspect = 2.1 } = {}) {
  const n = path.s.length;
  for (let i = 0; i < n; i += every) {
    const k = Math.min(i, n - 1), e = [path.eye[k * 3], path.eye[k * 3 + 1], path.eye[k * 3 + 2]], a = [path.aim[k * 3], path.aim[k * 3 + 1], path.aim[k * 3 + 2]];
    if (!tiltForGridEdge(ctx, [e], [a], path.fov[k], { maxTiltDeg: 0, aspect })) return true;
    if (i + every >= n && k !== n - 1) i = n - 1 - every;
  }
  return false;
}

/**
 * Tilt each aim down (keeping its heading) until no ray in frame leaves the
 * grid more than `edgeDipDeg` below the horizontal. Rays that leave closer
 * to the horizontal show sky in the app, so the grid's far boundary stands
 * in for the horizon; a deeper band would show the land ending well short
 * of it. Views whose far ground is blocked by ridges are unchanged. Null
 * when more than `maxTiltDeg` would be needed.
 */
export function tiltForGridEdge(ctx, eyes, aims, fovs, { maxTiltDeg = 22, aspect = 2.1, extraTiltDeg = 0, edgeDipDeg = ctx.edgeDipDeg ?? 0 } = {}) {
  const out = [], dip = -Math.max(0.1, edgeDipDeg) * DEG;
  for (let i = 0; i < eyes.length; i++) {
    const e = eyes[i], a = aims[i], fov = Array.isArray(fovs) ? fovs[i] : fovs;
    const dx = a[0] - e[0], dy = a[1] - e[1], dz = a[2] - e[2], hd = Math.hypot(dx, dz), dist = Math.hypot(hd, dy);
    let pitch = Math.atan2(dy, hd);
    const half = Math.atan(Math.tan(fov * DEG / 2) * 1.08), hx = Math.atan(Math.tan(fov * DEG / 2) * aspect);
    // The highest downward ray in frame that must meet the ground is the one
    // that runs furthest: the frame top, or the allowed dip below the horizon
    // when that is in frame.
    const ok = (p) => [-hx, -hx / 2, 0, hx / 2, hx].every((yaw) => {
      const h0 = Math.atan2(dx, -dz) + yaw, top = Math.min(p + half * Math.cos(yaw), dip);
      if (top < p - half) return true; // the whole column is above the horizon
      return !rayEscapes(ctx, e, [Math.sin(h0) * Math.cos(top), Math.sin(top), -Math.cos(h0) * Math.cos(top)]);
    });
    let tilt = 0;
    while (!ok(pitch - tilt * DEG)) { tilt += 1.5; if (tilt > maxTiltDeg) return null; }
    if (tilt) tilt += extraTiltDeg;
    if (!tilt) { out.push(a); continue; }
    pitch -= tilt * DEG;
    out.push([e[0] + dx / hd * Math.cos(pitch) * dist, e[1] + Math.sin(pitch) * dist, e[2] + dz / hd * Math.cos(pitch) * dist]);
  }
  return out;
}

/**
 * Raise each aim (keeping its heading and distance) so the horizon stays in
 * frame at least `horizonBelowTop` of the frame height below its top edge,
 * as far as the aim point itself -- the subject's mass -- stays at least
 * `subjectAboveBottom` of the height above the bottom edge. A high eye aimed
 * at the mid-height of a subject a kilometre or two away otherwise looks
 * 20-35 degrees down at near terrain with no sky. Aims already level enough
 * are returned unchanged.
 */
export function keepHorizon(eyes, aims, fovs, { horizonBelowTop = 0.2, subjectAboveBottom = 0.1 } = {}) {
  return aims.map((a, i) => {
    const e = eyes[i], t = Math.tan((Array.isArray(fovs) ? fovs[i] : fovs) * DEG / 2);
    const dx = a[0] - e[0], dy = a[1] - e[1], dz = a[2] - e[2], hd = Math.hypot(dx, dz), dist = Math.hypot(hd, dy);
    if (hd < 1e-6) return a;
    // With no roll, a direction `el` above the horizontal sits on row
    // 0.5 - 0.5 tan(el - pitch) / t (0 top, 1 bottom) for every column.
    const pitch = Math.atan2(dy, hd);
    const lowest = Math.atan((2 * horizonBelowTop - 1) * t), highest = pitch + Math.atan((1 - 2 * subjectAboveBottom) * t);
    const want = Math.max(pitch, Math.min(lowest, highest));
    if (want === pitch) return a;
    return [e[0] + dx / hd * Math.cos(want) * dist, e[1] + Math.sin(want) * dist, e[2] + dz / hd * Math.cos(want) * dist];
  });
}

/** Build a ShotPath from control eyes/aims/fovs: the horizon kept in frame
 *  where the subject allows (ctx.frame), no ray leaving the grid deeper
 *  than ctx.edgeDipDeg, clearance enforced. */
function makePath(ctx, eyes, aims, fovs, { spacingM = 30 } = {}) {
  for (const e of eyes) if (!insideGrid(ctx, e[0], e[2])) return null;
  if (ctx.frame) aims = keepHorizon(eyes, aims, fovs, ctx.frame);
  // Tilt at the control points, then verify the sampled path (aims between
  // control points, and the eye heights clearance gives it) and tilt on.
  for (let extra = 0; extra <= 12; extra += 2) {
    const tilted = tiltForGridEdge(ctx, eyes, aims, fovs, { extraTiltDeg: extra });
    if (!tilted) return null;
    const path = liftToClearance(samplePath({ eyes, aims: tilted, fovs, spacingM, minSamples: 12 }), ctx.clearance.floorAt);
    if (!path) return null;
    if (!pathSeesEdge(ctx, path)) return path;
  }
  return null;
}

function insideGrid(ctx, x, z) {
  const g = ctx.grid, m = ctx.boundaryMarginM ?? 1500;
  return x >= g.originM[0] + m && z >= g.originM[1] + m
    && x <= g.originM[0] + (g.width - 1) * g.cellSizeM - m && z <= g.originM[1] + (g.height - 1) * g.cellSizeM - m;
}

function record(subject, move, path, traits, extra = {}) {
  return { subjectId: subject.id, subjectWeight: subject.weight ?? 1, move, path, traits, lengthM: path.s[path.s.length - 1], tags: [], ...extra };
}

/** Pose traits at progress s for diagnostics and variety costs. */
export function poseTraits(ctx, path, s, subject, lens) {
  const p = pathPoseAt(path, s), d = [p.targetM[0] - p.eyeM[0], p.targetM[1] - p.eyeM[1], p.targetM[2] - p.eyeM[2]];
  const ground = ctx.heightAt(p.eyeM[0], p.eyeM[2]);
  const toEye = [p.eyeM[0] - subject.posM[0], p.eyeM[2] - subject.posM[2]];
  const distanceM = hyp2(...toEye);
  return {
    headingDeg: headingOf(d[0], d[2]), azimuthDeg: headingOf(toEye[0], toEye[1]),
    elevationDeg: Math.atan2(subject.posM[1] - p.eyeM[1], Math.max(1, distanceM)) / DEG,
    aglM: Number.isFinite(ground) ? p.eyeM[1] - ground : 0, distanceM, lens, fovYDeg: p.fovYDeg,
  };
}

// ---------------------------------------------------------------------------
// Generators. Each returns zero or more candidate records.

/** Lateral dolly past the subject at constant-ish distance. */
function traverse(ctx, subject, az, dist, elev, dir, lenses) {
  const sc = subjectScale(subject), [ux, uz] = headingVec(az), along = [-uz * dir, ux * dir];
  const L = clamp(0.45 * dist, 700, 5000), n = 5, eyes = [], aims = [];
  const theta = 2 * Math.atan(sc.relief / 2 / dist);
  const { lens, fovYDeg } = lensFor(theta, lenses, elev === 'high' ? 0.3 : 0.38);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) - 0.5, bow = 1 - 0.15 * (1 - (2 * t) ** 2); // slight arc toward the subject
    const x = subject.posM[0] + ux * dist * bow + along[0] * L * t, z = subject.posM[2] + uz * dist * bow + along[1] * L * t;
    const floor = ctx.clearance.floorAt(x, z);
    eyes.push([x, eyeHeight(elev, subject, floor, sc), z]);
  }
  // Keep heights smooth: one linear ramp between the end heights, floored.
  const y0 = Math.max(...eyes.map((e) => e[1]).slice(0, 2)), y1 = Math.max(...eyes.map((e) => e[1]).slice(-2));
  eyes.forEach((e, i) => { e[1] = Math.max(e[1], lerp(y0, y1, i / (n - 1))); });
  // The subject drifts from one thirds line toward the other.
  for (let i = 0; i < n; i++) aims.push(aimPoint(subject, sc, eyes[i], lerp(dir, -dir, i / (n - 1)) * 0.6, fovYDeg));
  const path = makePath(ctx, eyes, aims, fovYDeg);
  if (!path) return [];
  return [record(subject, 'traverse', path, { lens, elevation: elev, side: dir > 0 ? 'right' : 'left' }, { payoffFrac: 0.5 })];
}

/** Push in toward the subject, holding it on a thirds line. */
function approach(ctx, subject, az, dist, elev, side, lenses) {
  const sc = subjectScale(subject), [ux, uz] = headingVec(az), drift = [-uz, ux];
  const d0 = Math.min(dist * 1.9, dist + 6000), d1 = Math.max(dist * 0.85, (subject.radiusM || 300) + (ctx.standoffM ?? 300) + sc.relief * 0.3);
  const theta = 2 * Math.atan(sc.relief / 2 / d1);
  const { lens, fovYDeg } = lensFor(theta, lenses, 0.42);
  const eyes = [], aims = [], n = 5;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), d = lerp(d0, d1, t), lateral = 0.08 * dist * side * Math.sin(Math.PI * t);
    const x = subject.posM[0] + ux * d + drift[0] * lateral, z = subject.posM[2] + uz * d + drift[1] * lateral;
    eyes.push([x, 0, z]);
  }
  const floors = eyes.map((e) => ctx.clearance.floorAt(e[0], e[2]));
  const yEnd = eyeHeight(elev, subject, Math.max(...floors.slice(-2)), sc);
  const yStart = Math.max(floors[0] + 40, yEnd + (elev === 'low' ? 40 : 120));
  eyes.forEach((e, i) => { e[1] = Math.max(floors[i] + 20, lerp(yStart, yEnd, i / (n - 1))); });
  for (let i = 0; i < n; i++) aims.push(aimPoint(subject, sc, eyes[i], side * 0.5, fovYDeg));
  const path = makePath(ctx, eyes, aims, fovYDeg);
  if (!path) return [];
  return [record(subject, 'approach', path, { lens, elevation: elev, side: side > 0 ? 'right' : side < 0 ? 'left' : 'centre' }, { payoffFrac: 0.78 })];
}

/** Partial orbit around the subject. */
function orbit(ctx, subject, az, dist, elev, sweepDeg, lenses) {
  const sc = subjectScale(subject), steps = Math.max(4, Math.ceil(Math.abs(sweepDeg) / 18));
  const theta = 2 * Math.atan(sc.relief / 2 / dist);
  const { lens, fovYDeg } = lensFor(theta, lenses, 0.38);
  const eyes = [], aims = [];
  for (let i = 0; i <= steps; i++) {
    const a = az + sweepDeg * (i / steps - 0.5), [ux, uz] = headingVec(a);
    const x = subject.posM[0] + ux * dist, z = subject.posM[2] + uz * dist;
    eyes.push([x, 0, z]);
  }
  const floors = eyes.map((e) => ctx.clearance.floorAt(e[0], e[2]));
  const base = eyeHeight(elev, subject, Math.max(...floors), sc);
  eyes.forEach((e, i) => { e[1] = Math.max(floors[i] + 20, base + (elev === 'low' ? 0 : 0.1 * sc.relief * (i / steps))); });
  for (const e of eyes) aims.push(aimPoint(subject, sc, e, 0, fovYDeg, 16 / 9, 0.5));
  const path = makePath(ctx, eyes, aims, fovYDeg);
  if (!path) return [];
  return [record(subject, 'orbit', path, { lens, elevation: elev, side: sweepDeg > 0 ? 'right' : 'left' }, { payoffFrac: 0.5 })];
}

/** Retreat and climb away from the subject, widening into context. */
function pullback(ctx, subject, az, dist, lenses) {
  const sc = subjectScale(subject), [ux, uz] = headingVec(az);
  const d0 = Math.max((subject.radiusM || 300) + (ctx.standoffM ?? 300) + sc.relief * 0.4, dist * 0.6), d1 = Math.min(dist * 2.2, d0 + 9000);
  const near = lensFor(2 * Math.atan(sc.relief / 2 / d0), ctx.lenses, 0.45);
  const fovs = [near.fovYDeg, near.fovYDeg, lerp(near.fovYDeg, ctx.lenses.wide, 0.5), ctx.lenses.wide, ctx.lenses.wide];
  const eyes = [], aims = [], n = 5;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), d = lerp(d0, d1, t * t * (3 - 2 * t));
    eyes.push([subject.posM[0] + ux * d, 0, subject.posM[2] + uz * d]);
  }
  const floors = eyes.map((e) => ctx.clearance.floorAt(e[0], e[2]));
  const y0 = Math.max(floors[0] + 40, sc.base + 0.6 * sc.relief), y1 = Math.max(floors[n - 1] + 200, subject.posM[1] + 0.6 * sc.relief + 200);
  eyes.forEach((e, i) => { e[1] = Math.max(floors[i] + 30, lerp(y0, y1, (i / (n - 1)) ** 1.3)); });
  for (let i = 0; i < n; i++) aims.push(aimPoint(subject, sc, eyes[i], 0, fovs[i], 16 / 9, lerp(0.55, 0.35, i / (n - 1))));
  const path = makePath(ctx, eyes, aims, fovs);
  if (!path) return [];
  return [record(subject, 'pullback', path, { lens: 'wide', elevation: 'high', side: 'centre' }, { payoffFrac: 0.9 })];
}

/** Surface points that stand for a subject seen from `eye`: just above its
 *  summit, and on the flank facing the eye at mid relief. */
export function subjectMarks(ctx, subject, eye) {
  const sc = subjectScale(subject), p = subject.posM;
  const d = Math.max(1, hyp2(eye[0] - p[0], eye[2] - p[2])), ux = (eye[0] - p[0]) / d, uz = (eye[2] - p[2]) / d;
  let flank = null;
  for (let r = 0; r <= Math.max(subject.radiusM || 300, 200) * 1.5; r += 20) {
    const x = p[0] + ux * r, z = p[2] + uz * r, h = ctx.heightAt(x, z);
    if (Number.isFinite(h) && h <= sc.base + 0.5 * sc.relief) { flank = [x, h + 6, z]; break; }
  }
  return { summit: [p[0], p[1] + 6, p[2]], flank: flank || [p[0], p[1] + 6, p[2]] };
}

/**
 * Rise-over reveal: search outward along `az` for a crest that hides the
 * subject from a low eye behind it; start there (subject hidden), climb and
 * advance until the subject stands clear above the crest.
 */
function reveal(ctx, subject, az, lenses) {
  const sc = subjectScale(subject), [ux, uz] = headingVec(az), top = [subject.posM[0], subject.posM[1] + 6, subject.posM[2]];
  const minD = (subject.radiusM || 300) + (ctx.standoffM ?? 300) + sc.relief * 0.5;
  const out = [];
  for (let d = minD; d <= Math.min(16000, minD + 12 * sc.relief + 6000); d += 250) {
    const x = subject.posM[0] + ux * d, z = subject.posM[2] + uz * d;
    if (!insideGrid(ctx, x, z)) break;
    const low = ctx.clearance.floorAt(x, z) + 10;
    const eye = [x, low, z];
    if (lineOfSight(ctx.heightAt, eye, top)) continue; // already visible: no reveal here
    // Find the crest between eye and subject: highest terrain sample above the sight line.
    let crest = null;
    for (let k = 1; k < 60; k++) {
      const t = k / 60, cx = lerp(x, subject.posM[0], t), cz = lerp(z, subject.posM[2], t), h = ctx.heightAt(cx, cz);
      const sight = lerp(low, top[1], t);
      if (Number.isFinite(h) && h > sight && (!crest || h - sight > crest.excess)) crest = { t, x: cx, z: cz, h, excess: h - sight };
    }
    if (!crest || crest.t > 0.6) continue; // the occluder must be a foreground crest, not the subject's own flank
    // End: past the crest, high enough that the subject clears it with margin.
    const tEnd = clamp(crest.t + 0.12, 0.15, 0.75);
    const ex = lerp(x, subject.posM[0], tEnd), ez = lerp(z, subject.posM[2], tEnd);
    const endFloor = ctx.clearance.floorAt(ex, ez);
    let ey = Math.max(endFloor + 40, crest.h + 80);
    const shown = (y) => { const m = subjectMarks(ctx, subject, [ex, y, ez]); return lineOfSight(ctx.heightAt, [ex, y, ez], m.summit) && lineOfSight(ctx.heightAt, [ex, y, ez], m.flank); };
    let tries = 0;
    while (tries < 14 && !shown(ey)) { ey += 60; tries++; }
    if (!shown(ey) || ey - low > 1400) continue;
    const dist = hyp2(ex - subject.posM[0], ez - subject.posM[2]);
    const { lens, fovYDeg } = lensFor(2 * Math.atan(sc.relief / 2 / dist), lenses, 0.4);
    const eyes = [eye, [lerp(x, ex, 0.35), lerp(low, ey, 0.25), lerp(z, ez, 0.35)], [lerp(x, ex, 0.7), lerp(low, ey, 0.75), lerp(z, ez, 0.7)], [ex, ey, ez]];
    const aims = eyes.map((e) => aimPoint(subject, sc, e, 0.35, fovYDeg));
    const path = makePath(ctx, eyes, aims, fovYDeg);
    if (!path) continue;
    // Judge the path that ships (clearance lifts can raise its start): the
    // subject must be hidden at the start and fully shown at the end.
    const n = path.s.length, start = [path.eye[0], path.eye[1], path.eye[2]], end = [path.eye[(n - 1) * 3], path.eye[(n - 1) * 3 + 1], path.eye[(n - 1) * 3 + 2]];
    if (lineOfSight(ctx.heightAt, start, subjectMarks(ctx, subject, start).summit)) continue;
    const em = subjectMarks(ctx, subject, end);
    if (!lineOfSight(ctx.heightAt, end, em.summit) || !lineOfSight(ctx.heightAt, end, em.flank)) continue;
    out.push(record(subject, 'reveal', path, { lens, elevation: 'low', side: 'centre', occluderM: [crest.x, crest.h, crest.z] }, { payoffFrac: 0.8 }));
    if (out.length >= 2) break;
    d += 1500; // the next candidate behind a different crest
  }
  return out;
}

/** Follow a valley floor (or a shoreline) low, looking ahead toward the
 *  subject when it lies near the direction of travel. */
function floorRun(ctx, subject, line, kind, lenses) {
  const pts = line.points, out = [];
  const segLen = clamp(3500, 2000, 6000), stepPts = Math.max(1, Math.round(segLen / 100));
  for (let start = 0; start + stepPts < pts.length; start += Math.max(1, Math.round(stepPts * 0.6))) {
    for (const reverse of [false, true]) {
      let seg = pts.slice(start, start + stepPts + 1);
      if (reverse) seg = seg.slice().reverse();
      const a = seg[0], b = seg[seg.length - 1], dir = headingOf(b[0] - a[0], b[2] - a[2]);
      const toSubject = headingOf(subject.posM[0] - b[0], subject.posM[2] - b[2]);
      if (Math.abs(wrap180(toSubject - dir)) > 50) continue; // subject not ahead
      const control = [0, 0.25, 0.5, 0.75, 1].map((t) => seg[Math.round(t * (seg.length - 1))]);
      const eyes = control.map((p) => [p[0], Math.max(ctx.clearance.floorAt(p[0], p[2]) + 10, p[1] + (kind === 'shore' ? 70 : 110)), p[2]]);
      const sc = subjectScale(subject), dist = hyp2(subject.posM[0] - b[0], subject.posM[2] - b[2]);
      const { lens, fovYDeg } = lensFor(2 * Math.atan(sc.relief / 2 / Math.max(800, dist)), lenses, 0.32);
      const aims = eyes.map((e) => aimPoint(subject, sc, e, 0, fovYDeg, 16 / 9, 0.5));
      const path = makePath(ctx, eyes, aims, fovYDeg);
      if (path) out.push(record(subject, 'valley', path, { lens, elevation: 'low', side: 'centre', along: kind, lineId: line.id }, { payoffFrac: 0.85 }));
      if (out.length >= 2) return out;
    }
  }
  return out;
}

/**
 * Foreground pass: a nearer feature F frames one side of the picture while
 * the subject stands behind it, and a lateral move sweeps F across the frame
 * far faster than the subject (strong parallax between near and far). The
 * eye sits beyond F on the line from the subject, offset so F stays clear of
 * the subject, high enough to see the subject's summit over F.
 */
function foregroundPass(ctx, subject, near, lenses) {
  const out = [], P = subject.posM, F = near.posM;
  const dSF = hyp2(F[0] - P[0], F[2] - P[2]);
  if (dSF < 700 || dSF > 7000) return out;
  const u = [(F[0] - P[0]) / dSF, (F[2] - P[2]) / dSF], perp = [-u[1], u[0]];
  const fr = Math.max(near.radiusM || 200, 150);
  const dEF = clamp(0.55 * dSF, fr + 350, 1800);
  for (const side of [1, -1]) {
    const lateral = side * (fr + 0.35 * dEF), L = clamp(0.7 * dEF, 400, 1400);
    const centre = [F[0] + u[0] * dEF + perp[0] * lateral, F[2] + u[1] * dEF + perp[1] * lateral];
    const eyes = [];
    for (let i = 0; i < 4; i++) {
      const t = i / 3 - 0.5, x = centre[0] - perp[0] * side * L * t, z = centre[1] - perp[1] * side * L * t;
      eyes.push([x, ctx.clearance.floorAt(x, z) + 15, z]);
    }
    // Lift until the subject's summit clears the near feature from every eye.
    const summit = [P[0], P[1] + 6, P[2]];
    let lift = 0;
    while (lift < 900 && !eyes.every((e) => lineOfSight(ctx.heightAt, [e[0], e[1] + lift, e[2]], summit))) lift += 40;
    if (lift >= 900) continue;
    eyes.forEach((e) => { e[1] += lift; });
    // Frame both: aim between them, weighted to the subject; the lens fits
    // their angular separation with room either side.
    const e0 = eyes[1], toS = headingOf(P[0] - e0[0], P[2] - e0[2]), toF = headingOf(F[0] - e0[0], F[2] - e0[2]);
    const sep = Math.abs(wrap180(toS - toF));
    if (sep < 6 || sep > 40) continue;
    const fovYDeg = clamp(Math.round(sep * 1.15 * 9 / 16 * 1.6), lenses.tele, lenses.wide);
    const aims = eyes.map(() => [P[0] * 0.72 + F[0] * 0.28, subjectScale(subject).base + 0.45 * subjectScale(subject).relief, P[2] * 0.72 + F[2] * 0.28]);
    const path = makePath(ctx, eyes, aims, fovYDeg);
    if (path) out.push(record(subject, 'traverse', path, { lens: fovYDeg <= 21 ? 'tele' : fovYDeg >= 31 ? 'wide' : 'normal', elevation: 'low', side: side > 0 ? 'right' : 'left',
      foregroundSubjectId: near.id }, { payoffFrac: 0.55, tags: ['foreground-pass'] }));
  }
  return out;
}

/**
 * Crane rise: start low beside a near flank looking toward the subject,
 * rise steadily (advancing a little) until the valley floor and the
 * subject's neighbours open out below -- a high establishing payoff.
 */
function craneRise(ctx, subject, az, lenses) {
  const sc = subjectScale(subject), [ux, uz] = headingVec(az);
  const d = clamp(3.2 * sc.size, 1500, 9000);
  const x0 = subject.posM[0] + ux * d, z0 = subject.posM[2] + uz * d;
  if (!insideGrid(ctx, x0, z0)) return [];
  const floor0 = ctx.clearance.floorAt(x0, z0);
  const top = Math.max(floor0 + 450, subject.posM[1] + 0.6 * sc.relief + 250);
  const eyes = [0, 0.35, 0.7, 1].map((t) => {
    const dd = d * (1 - 0.18 * t), x = subject.posM[0] + ux * dd, z = subject.posM[2] + uz * dd;
    return [x, Math.max(ctx.clearance.floorAt(x, z) + 10, lerp(floor0 + 10, top, t * t * (3 - 2 * t))), z];
  });
  const { lens, fovYDeg } = lensFor(2 * Math.atan(sc.relief / 2 / d), lenses, 0.3);
  const fovs = [fovYDeg, fovYDeg, lerp(fovYDeg, lenses.wide, 0.5), lenses.wide];
  const aims = eyes.map((e, i) => aimPoint(subject, sc, e, 0, fovs[i], 16 / 9, lerp(0.55, 0.2, i / 3)));
  const path = makePath(ctx, eyes, aims, fovs);
  return path ? [record(subject, 'reveal', path, { lens, elevation: 'high', side: 'centre' }, { payoffFrac: 0.92, tags: ['crane'] })] : [];
}

/** The authored rail as a shot: known-valid, always kept. */
export function railShot(ctx, subject) {
  const c = ctx.camera;
  const eyes = [0, 0.25, 0.5, 0.75, 1].map((t) => c.eyeStartM.map((v, k) => v + (c.eyeEndM[k] - v) * t + (c.eyeArcM?.[k] || 0) * 4 * t * (1 - t)));
  const aims = [0, 0.25, 0.5, 0.75, 1].map((t) => c.targetStartM.map((v, k) => v + (c.targetEndM[k] - v) * t + (c.targetArcM?.[k] || 0) * 4 * t * (1 - t)));
  const path = samplePath({ eyes, aims, fovs: c.fovYDeg, spacingM: 30, minSamples: 12 });
  return record(subject, 'rail', path, { lens: c.fovYDeg <= (ctx.lenses.tele + ctx.lenses.normal) / 2 ? 'tele' : c.fovYDeg >= (ctx.lenses.wide + ctx.lenses.normal) / 2 ? 'wide' : 'normal', elevation: 'mid', side: 'centre' }, { payoffFrac: 0.5, rail: true });
}

/** Landform emphasis: which moves a region favours, and how far out. */
// focusM: the radius of the tour's area. A continuous camera covers only a
// few kilometres per song near the ground (comfortable image flow caps its
// speed), so compact landforms keep their shots close enough to chain.
export const LANDFORMS = Object.freeze({
  butte: { moves: ['orbit', 'traverse', 'reveal', 'approach', 'valley', 'pullback'], distance: [2.6, 5, 9], elevations: ['low', 'mid', 'high'], focusM: 6000 },
  'canyon-butte': { moves: ['reveal', 'valley', 'orbit', 'traverse', 'approach', 'pullback'], distance: [2.6, 5, 9], elevations: ['low', 'mid', 'high'], focusM: 8000 },
  'lake-alpine': { moves: ['valley', 'traverse', 'approach', 'reveal', 'pullback', 'orbit'], distance: [2.2, 4, 7], elevations: ['low', 'mid', 'high'], focusM: 10000 },
  'lake-valley': { moves: ['valley', 'traverse', 'reveal', 'pullback', 'approach'], distance: [2.2, 4, 7], elevations: ['low', 'mid', 'high'], focusM: 8000 },
  alpine: { moves: ['traverse', 'reveal', 'approach', 'orbit', 'valley', 'pullback'], distance: [2.2, 4, 7], elevations: ['mid', 'high', 'low'], focusM: 9000 },
  'alpine-ridge': { moves: ['traverse', 'reveal', 'valley', 'approach', 'pullback', 'orbit'], distance: [2.2, 4, 7], elevations: ['mid', 'high', 'low'], focusM: 9000 },
  massif: { moves: ['traverse', 'approach', 'reveal', 'valley', 'pullback'], distance: [1.6, 2.6, 4], elevations: ['low', 'mid', 'high'], focusM: 16000 },
  volcano: { moves: ['orbit', 'traverse', 'approach', 'pullback', 'reveal'], distance: [1.8, 3, 5], elevations: ['mid', 'high', 'low'], focusM: 13000 },
  rolling: { moves: ['traverse', 'reveal', 'valley', 'approach', 'pullback'], distance: [3, 6, 10], elevations: ['mid', 'high'], focusM: 10000 },
  escarpment: { moves: ['traverse', 'approach', 'reveal', 'valley', 'pullback'], distance: [1.8, 3.2, 6], elevations: ['low', 'mid', 'high'], focusM: 11000 },
  'escarpment-basin': { moves: ['traverse', 'reveal', 'approach', 'valley', 'pullback'], distance: [1.8, 3.2, 6], elevations: ['low', 'mid', 'high'], focusM: 12000 },
  'glacier-valley': { moves: ['valley', 'traverse', 'reveal', 'approach', 'pullback'], distance: [2.2, 4, 7], elevations: ['low', 'mid', 'high'], focusM: 10000 },
});

/**
 * Candidate shots for every subject.
 *   ctx       loadViewContext() result plus clearance, heightAt, lenses,
 *             standoffM, boundaryMarginM
 *   subjects  discoverSubjects() result
 *   lines     { valleys: [...], shores: [...] }
 *   region    regional config block ({ landform, preferAzimuthDeg, ... })
 * Returns records { id, subjectId, move, path, traits, lengthM, payoffFrac }.
 */
export function generateShots(ctx, subjects, lines, region, { azimuths = 8, maxPerSubject = 48 } = {}) {
  const form = LANDFORMS[region.landform] || LANDFORMS.alpine, out = [];
  const lenses = ctx.lenses;
  const railSubject = subjects.find((s) => s.kind === 'rail-target') || subjects[0];
  out.push(railShot(ctx, railSubject));
  for (const subject of subjects) {
    // The rail target is where the authored rail happens to look, often
    // open ground: it seeds the rail shot only.
    if (subject.kind === 'rail-target') continue;
    const sc = subjectScale(subject), list = [], strata = new Map();
    // Keep the generator's angle and distance class for thinning. Geometry
    // can shift the actual midpoint slightly (for example a bowed push-in).
    const add = (records, az, distance) => {
      for (const r of records) {
        if (az === undefined) {
          const eye = pathPoseAt(r.path, r.lengthM / 2).eyeM;
          strata.set(r, { az: Math.round(headingOf(eye[0] - subject.posM[0], eye[2] - subject.posM[2])), distance: 0 });
        } else strata.set(r, { az, distance: distance ?? 0 });
        list.push(r);
      }
    };
    // Viewing azimuths: evenly spread plus the region's preferred ones and
    // the side the authored rail sees the subject from.
    const railEye = ctx.camera.eyeStartM, railAz = headingOf(railEye[0] - subject.posM[0], railEye[2] - subject.posM[2]);
    const azList = [...new Set([...Array.from({ length: azimuths }, (_, i) => (railAz + i * 360 / azimuths) % 360),
      ...(region.preferAzimuthDeg || [])].map((a) => ((Math.round(a) % 360) + 360) % 360))];
    const dists = form.distance.map((k) => clamp(k * sc.size, (subject.radiusM || 300) + (ctx.standoffM ?? 300) + 200, 22000));
    for (const move of form.moves) {
      for (const az of azList) {
        if (move === 'traverse') for (const d of dists) for (const elev of form.elevations) for (const dir of [1, -1]) add(traverse(ctx, subject, az, d, elev, dir, lenses), az, d);
        if (move === 'approach') for (const d of dists.slice(0, 2)) for (const elev of form.elevations) add(approach(ctx, subject, az, d, elev, [1, -1, 0][(Math.round(az) + Math.round(d)) % 3], lenses), az, d);
        if (move === 'orbit') for (const d of dists.slice(0, 2)) for (const elev of form.elevations) for (const sweep of [90, -90]) add(orbit(ctx, subject, az, d, elev, sweep, lenses), az, d);
        if (move === 'pullback') add(pullback(ctx, subject, az, dists[0], lenses), az, dists[0]);
        if (move === 'reveal') add(reveal(ctx, subject, az, lenses), az);
        if (move === 'pullback' && form.elevations.includes('high')) add(craneRise(ctx, subject, az, lenses), az);
      }
      if (move === 'traverse') {
        // Foreground relationships: every other point subject in reach can
        // frame this one.
        for (const near of subjects) {
          if (near === subject || near.kind === 'rail-target' || near.kind === 'lake' || near.kind === 'valley') continue;
          add(foregroundPass(ctx, subject, near, lenses));
        }
      }
      if (move === 'valley') {
        for (const line of [...(lines.valleys || []), ...(lines.shores || [])]) {
          const near = line.points.some((p) => hyp2(p[0] - subject.posM[0], p[2] - subject.posM[2]) < 12 * Math.max(sc.size, 1000));
          if (near) add(floorRun(ctx, subject, line, line.lakeId ? 'shore' : 'valley', lenses));
        }
      }
    }
    // Share the fixed budget across move/tag families and viewing angles.
    // Preferred angles go first; then fill the largest angular gaps so a
    // small budget still sees the far side of a subject. Within each angle,
    // favour elevation, distance and direction classes not already sampled.
    const byMove = new Map();
    for (const r of list) {
      const k = [r.move, ...(r.tags || [])].join('+');
      if (!byMove.has(k)) byMove.set(k, { angles: new Map(), used: new Map(), cursor: 0 });
      const family = byMove.get(k), az = strata.get(r).az;
      if (!family.angles.has(az)) family.angles.set(az, []);
      family.angles.get(az).push(r);
    }
    for (const family of byMove.values()) {
      const remaining = [...family.angles.keys()], order = [];
      for (const preferred of region.preferAzimuthDeg || []) {
        const az = ((Math.round(preferred) % 360) + 360) % 360, at = remaining.indexOf(az);
        if (at >= 0) order.push(...remaining.splice(at, 1));
      }
      while (remaining.length) {
        let best = 0, gap = -1;
        for (let i = 0; i < remaining.length; i++) {
          const d = order.length ? Math.min(...order.map((a) => Math.abs(wrap180(remaining[i] - a)))) : 0;
          if (d > gap) { gap = d; best = i; }
        }
        order.push(...remaining.splice(best, 1));
      }
      family.order = order;
    }
    const classes = (r) => [`elevation:${r.traits.elevation}`, `distance:${strata.get(r).distance}`, `side:${r.traits.side}`];
    const kept = [];
    while (kept.length < maxPerSubject) {
      let added = false;
      for (const family of byMove.values()) {
        if (kept.length >= maxPerSubject) break;
        let pool;
        for (let i = 0; i < family.order.length; i++) {
          const next = family.angles.get(family.order[family.cursor++ % family.order.length]);
          if (next.length) { pool = next; break; }
        }
        if (!pool) continue;
        const repeats = (r) => classes(r).reduce((n, k) => n + (family.used.get(k) || 0), 0);
        let best = 0;
        for (let i = 1; i < pool.length; i++) if (repeats(pool[i]) < repeats(pool[best])) best = i;
        const r = pool.splice(best, 1)[0];
        for (const k of classes(r)) family.used.set(k, (family.used.get(k) || 0) + 1);
        kept.push(r); added = true;
      }
      if (!added) break;
    }
    out.push(...kept);
  }
  out.forEach((r, i) => { r.id = `${r.move}-${r.subjectId}-${String(i).padStart(3, '0')}`; });
  return out;
}
