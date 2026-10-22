// Synthetic scenic shot library (schema midio.shots v1) and a structured
// test song, for the shot-tour planner and timeline tests.
//
// Six subjects stand over a 20 km square (x -8.6..8.6 km, z -6.5..-1.5 km)
// above flat ground at 1200 m. The rail and seventeen shots work an 11 km
// road that arcs around them on the south side (radius 12 km), 300-900 m
// above the ground, strung west to east so that neighbouring shots of
// different subjects start and end near each other and the view turns with
// the road (headings spread over about 60 degrees). Shots are sampled with
// ShotPath.samplePath; links (direct and arc, for every pair whose ends lie
// within 9 km) leave and arrive along the shots' tangents with the aim at
// rest at both joins. Everything goes through packShotPaths and
// decodeShotLibrary, so the fixture is validated against the real manifest
// and path contracts (and carries their 0.1 m quantization).
import { samplePath, progressOf, pathPoseAt, pathTangent, lookDir, headingPitch } from '../../src/world/terrain/ShotPath.js';
import { SHOT_SCHEMA, SHOT_VERSION, packShotPaths, decodeShotLibrary } from '../../src/world/terrain/ShotLibrary.js';

export const FIXTURE_GROUND_M = 1200;
const ROAD_R = 12000, ROAD_CENTRE = [0, -5000], ROAD_M = 11000;
const LENS_FOV = { wide: 36, normal: 26, tele: 16 };
const MOVES = ['traverse', 'approach', 'reveal', 'orbit', 'pullback', 'valley'];
const PAYOFF = { rail: .35, traverse: .5, approach: .75, reveal: .6, orbit: .5, pullback: .3, valley: .65 };
const LENS = { traverse: 'tele', approach: 'normal', reveal: 'wide', orbit: 'normal', pullback: 'wide', valley: 'wide' };
const FOREGROUNDS = ['none', 'trees', 'water', 'ridge'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flowLane = (eye) => Float32Array.from({ length: eye.length / 3 }, (_, i) => 1.2 / Math.max(200, eye[i * 3 + 1] - FIXTURE_GROUND_M));
const smooth = (u) => u * u * (3 - 2 * u);
// Constant-acceleration ease (two parabolas): of all eases from rest to rest
// it changes rate the least, so a link's pan grows and fades as gently as
// its length allows.
const ease = (u) => (u < .5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u));
// Cumulative share of a pan whose rate eases in over the first quarter,
// holds, and eases out over the last: the camera's share of progress spent
// panning then changes slowly (a smoothstep pan would peak at 1.5x the mean).
const PAN = (() => {
  const n = 256, rate = (f) => smooth(Math.min(1, f / .25, (1 - f) / .25)), table = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) table[i] = table[i - 1] + (rate((i - .5) / n)) / n;
  return table.map((v) => v / table[n]);
})();
const pan = (f) => { const at = Math.min(1, Math.max(0, f)) * (PAN.length - 1), i = Math.min(PAN.length - 2, Math.floor(at)); return PAN[i] + (PAN[i + 1] - PAN[i]) * (at - i); };

// Uniform-in-progress resampling of a dense curve (what samplePath does for
// its own spline), used for the links.
function resample(fe, fa, ff, spacingM = 25) {
  const fs = progressOf(fe, fa), total = fs[fs.length - 1], last = fe.length - 1;
  const count = Math.max(8, Math.ceil(total / spacingM) + 1);
  const eye = new Float32Array(count * 3), aim = new Float32Array(count * 3), fov = new Float32Array(count), s = new Float32Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / (count - 1)) * total;
    while (j < last - 1 && fs[j + 1] < target) j++;
    const u = fs[j + 1] > fs[j] ? Math.min(1, Math.max(0, (target - fs[j]) / (fs[j + 1] - fs[j]))) : 0;
    for (let k = 0; k < 3; k++) {
      eye[i * 3 + k] = fe[j][k] + (fe[j + 1][k] - fe[j][k]) * u;
      aim[i * 3 + k] = fa[j][k] + (fa[j + 1][k] - fa[j][k]) * u;
    }
    fov[i] = ff[j] + (ff[j + 1] - ff[j]) * u;
    s[i] = target;
  }
  return { eye, aim, fov, s };
}

function shotRecord(id, subject, move, path, random, hero) {
  const n = path.s.length, lengthM = path.s[n - 1], payoffS = PAYOFF[move] * lengthM;
  const pose = pathPoseAt(path, payoffS), { headingDeg, pitchDeg } = headingPitch(lookDir(pose));
  const dx = pose.eyeM[0] - subject.posM[0], dz = pose.eyeM[2] - subject.posM[2];
  const aglM = pose.eyeM[1] - FIXTURE_GROUND_M, total = (hero ? .62 : .48) + .3 * random();
  const part = () => Math.min(1, Math.max(0, total + (random() - .5) * .2));
  const score = { total, composition: part(), subject: part(), depth: part(), parallax: part(), reveal: part(), render: null };
  score.weakest = Math.min(score.composition, score.subject, score.depth, score.parallax, score.reveal);
  const lens = move === 'rail' ? 'normal' : LENS[move];
  return {
    id, subjectId: subject.id, move, lengthM, payoffS,
    holdS: [Math.max(0, payoffS - .2 * lengthM), Math.min(lengthM, payoffS + .2 * lengthM)],
    durationMs: { min: lengthM / 60 * 1000, ideal: lengthM / 25 * 1000, max: lengthM / 8 * 1000 },
    traits: { headingDeg, azimuthDeg: Math.atan2(dx, -dz) * 180 / Math.PI, elevationDeg: pitchDeg, aglM, distanceM: Math.hypot(dx, dz),
      lens, foreground: FOREGROUNDS[Math.floor(random() * FOREGROUNDS.length)], side: dx * Math.cos(headingDeg * Math.PI / 180) >= 0 ? 'right' : 'left' },
    score, tags: [...(hero ? ['hero'] : []), ...(aglM >= 750 ? ['high'] : [])], path,
  };
}

/** Control points of one move around subject `S` centred on `C`; every move
 *  travels along the road's direction `T` (approach and pullback diagonally). */
function moveControls(move, S, aimPoint, C, T, L, agl) {
  const ux0 = S[0] - C[0], uz0 = S[2] - C[2], ul = Math.hypot(ux0, uz0), u = [ux0 / ul, uz0 / ul], y = FIXTURE_GROUND_M + agl;
  const at = (along, toward, dy = 0) => [C[0] + along * T[0] + toward * u[0], y + dy, C[2] + along * T[1] + toward * u[1]];
  switch (move) {
    case 'traverse': return { eyes: [at(-L / 2, 0), at(0, 0), at(L / 2, 0)], aims: [aimPoint, aimPoint, aimPoint] };
    case 'approach': return { eyes: [at(-.48 * L, -.08 * L, 40), at(0, 0, 20), at(.48 * L, .08 * L)], aims: [aimPoint, aimPoint, aimPoint] };
    case 'pullback': return { eyes: [at(-.48 * L, .08 * L), at(0, 0, 55), at(.48 * L, -.08 * L, 120)], aims: [aimPoint, aimPoint, aimPoint] };
    case 'reveal': {
      // The aim starts behind the subject (against the travel) at rest and
      // eases onto it by 85% of the move, so the pan grows and fades smoothly.
      const eyes = [], aims = [];
      for (let k = 0; k <= 8; k++) {
        const f = k / 8, h = pan((f - .05) / .8), off = 1600 * (1 - h);
        eyes.push(at(-L / 2 + L * f, 0, 60 * f));
        aims.push([aimPoint[0] - off * T[0], aimPoint[1], aimPoint[2] - off * T[1]]);
      }
      return { eyes, aims };
    }
    case 'orbit': {
      const r = Math.hypot(C[0] - S[0], C[2] - S[2]), base = Math.atan2(C[0] - S[0], C[2] - S[2]), span = L / r;
      const eyes = [0, 1, 2, 3, 4].map((k) => { const a = base + span * (k / 4 - .5); return [S[0] + Math.sin(a) * r, y, S[2] + Math.cos(a) * r]; });
      return { eyes, aims: eyes.map(() => aimPoint) };
    }
    default: return { eyes: [at(-L / 2, 60), at(0, 0, 10), at(L / 2, 60)], aims: [aimPoint, aimPoint, aimPoint] }; // valley
  }
}

// Shortest circle-straight-circle path (Dubins) in the horizontal plane from
// p0 heading d0 to p1 heading d1 with turn radius r, densely sampled.
function dubins(p0, d0, p1, d1, r) {
  const perp = (d, side) => [-d[1] * side, d[0] * side];
  const heading = (c, p, side) => { const v = [p[0] - c[0], p[1] - c[1]], l = Math.hypot(...v); return [-v[1] / l * side, v[0] / l * side]; };
  const sweep = (c, a, b, side) => { const t = side * (Math.atan2(b[1] - c[1], b[0] - c[0]) - Math.atan2(a[1] - c[1], a[0] - c[0])); return ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); };
  let best = null;
  for (const s0 of [1, -1]) for (const s1 of [1, -1]) {
    const c0 = [p0[0] + perp(d0, s0)[0] * r, p0[1] + perp(d0, s0)[1] * r], c1 = [p1[0] + perp(d1, s1)[0] * r, p1[1] + perp(d1, s1)[1] * r];
    const dx = c1[0] - c0[0], dz = c1[1] - c0[1], D = Math.hypot(dx, dz), base = Math.atan2(dz, dx);
    const angles = s0 === s1 ? [base + Math.PI / 2, base - Math.PI / 2] : D >= 2 * r ? [base + Math.acos(2 * r / D), base - Math.acos(2 * r / D)] : [];
    for (const a of angles) {
      const n = [Math.cos(a), Math.sin(a)], t0 = [c0[0] + n[0] * r, c0[1] + n[1] * r];
      const t1 = s0 === s1 ? [c1[0] + n[0] * r, c1[1] + n[1] * r] : [c1[0] - n[0] * r, c1[1] - n[1] * r];
      const line = [t1[0] - t0[0], t1[1] - t0[1]], len = Math.hypot(...line), dir = len > 1e-9 ? [line[0] / len, line[1] / len] : heading(c0, t0, s0);
      const h0 = heading(c0, t0, s0), h1 = heading(c1, t1, s1);
      if (h0[0] * dir[0] + h0[1] * dir[1] < .999 || h1[0] * dir[0] + h1[1] * dir[1] < .999) continue;
      const a0 = sweep(c0, p0, t0, s0), a1 = sweep(c1, t1, p1, s1), total = r * (a0 + a1) + len;
      if (!best || total < best.total) best = { total, c0, c1, s0, s1, a0, a1, t0, t1, len };
    }
  }
  if (!best) return null;
  const { c0, c1, s0, s1, a0, a1, t0, t1, len } = best, pts = [];
  const around = (c, from, side, sweepAngle) => {
    const phi = Math.atan2(from[1] - c[1], from[0] - c[0]), n = Math.max(1, Math.ceil(r * sweepAngle / 5));
    for (let i = 0; i < n; i++) { const f = phi + side * sweepAngle * i / n; pts.push([c[0] + Math.cos(f) * r, c[1] + Math.sin(f) * r]); }
  };
  around(c0, p0, s0, a0);
  const nl = Math.max(1, Math.ceil(len / 5));
  for (let i = 0; i < nl; i++) pts.push([t0[0] + (t1[0] - t0[0]) * i / nl, t0[1] + (t1[1] - t0[1]) * i / nl]);
  around(c1, t1, s1, a1);
  pts.push([p1[0], p1[1]]);
  return pts;
}

// Horizontal cubic Hermite from p0 (heading d0) to p1 (heading d1) with
// handles of length m, densely sampled.
function hermite(p0, d0, p1, d1, m) {
  return Array.from({ length: 241 }, (_, i) => {
    const u = i / 240, u2 = u * u, u3 = u2 * u, h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    return [0, 1].map((k) => h00 * p0[k] + h10 * m * d0[k] + h01 * p1[k] + h11 * m * d1[k]);
  });
}

function tightestTurn(pts) {
  let r = Infinity;
  for (let i = 1; i < pts.length - 1; i++) {
    const [p, q, o] = [pts[i - 1], pts[i], pts[i + 1]], A = Math.hypot(q[0] - p[0], q[1] - p[1]), B = Math.hypot(o[0] - q[0], o[1] - q[1]), C = Math.hypot(o[0] - p[0], o[1] - p[1]);
    const area = Math.abs((q[0] - p[0]) * (o[1] - p[1]) - (o[0] - p[0]) * (q[1] - p[1])) / 2;
    if (area > 1e-9) r = Math.min(r, A * B * C / (4 * area));
  }
  return r;
}

// One link from shot a's last sample to shot b's first sample. Horizontally
// the eye leaves and arrives along the shots' headings: the shortest of a
// Dubins curve (300 m turns, 500 m for 'arc') and a Hermite S-curve that
// turns no tighter than 80 m. Its height follows a cubic matching the
// shots' climb rates ('arc' also lifts), and the aim moves with the eye's
// arc length and rests at both joins, so the pan grows and fades with the
// flight. `kinkDeg` turns the departure and arrival headings that far off
// the shots' (left at the start, right at the end): the link then kinks at
// both joins, as many real links do.
function linkPath(a, b, kind, random, { spacingM = 25, radius = kind === 'arc' ? 500 : 300, flow = flowLane, kinkDeg = 0 } = {}) {
  const na = a.path.s.length;
  const pick = (arr, i, k = 3) => Array.from(arr.subarray(i * k, i * k + k));
  const pA = pick(a.path.eye, na - 1), pB = pick(b.path.eye, 0), aimA = pick(a.path.aim, na - 1), aimB = pick(b.path.aim, 0);
  const fovA = a.path.fov[na - 1], fovB = b.path.fov[0];
  const flat = (t) => { const l = Math.hypot(t[0], t[2]); return { d: [t[0] / l, t[2] / l], slope: Math.max(-.6, Math.min(.6, t[1] / l)) }; };
  const turn = (t, deg) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return { ...t, d: [t.d[0] * c - t.d[1] * s, t.d[0] * s + t.d[1] * c] }; };
  const A = turn(flat(pathTangent(a.path, true)), kinkDeg), B = turn(flat(pathTangent(b.path, false)), -kinkDeg);
  const p0 = [pA[0], pA[2]], p1 = [pB[0], pB[2]], chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), lift0 = kind === 'arc' ? 60 + 60 * random() : 0;
  const arcLength = (pts) => { const e = [0]; for (let i = 1; i < pts.length; i++) e.push(e[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return e; };
  const options = [dubins(p0, A.d, p1, B.d, radius), hermite(p0, A.d, p1, B.d, (kind === 'arc' ? 1.4 : 1) * Math.max(100, chord))]
    .filter((pts, i) => pts && (i === 0 || tightestTurn(pts) >= 80)).map((pts) => ({ pts, e: arcLength(pts) }));
  const { pts: flatPts, e: arc } = options.sort((x, y) => x.e.at(-1) - y.e.at(-1))[0]
    || { pts: hermite(p0, A.d, p1, B.d, Math.max(100, chord)), e: arcLength(hermite(p0, A.d, p1, B.d, Math.max(100, chord))) };
  const E = arc.at(-1), lift = Math.min(lift0, .08 * E), fe = [], fa = [], ff = [];
  flatPts.forEach((p, i) => {
    // Quintic height: the shots' climb rates at the joins, no vertical kink.
    const u = arc[i] / E, u3 = u ** 3, u4 = u3 * u, u5 = u4 * u;
    const y = (1 - 10 * u3 + 15 * u4 - 6 * u5) * pA[1] + (u - 6 * u3 + 8 * u4 - 3 * u5) * E * A.slope + (10 * u3 - 15 * u4 + 6 * u5) * pB[1]
      + (-4 * u3 + 7 * u4 - 3 * u5) * E * B.slope + 64 * u3 * (1 - u) ** 3 * lift;
    fe.push([p[0], y, p[1]]);
    fa.push([0, 1, 2].map((k) => aimA[k] + (aimB[k] - aimA[k]) * ease(u)));
    ff.push(fovA + (fovB - fovA) * smooth(u));
  });
  const path = resample(fe, fa, ff, spacingM);
  const n = path.s.length;
  path.eye.set(a.path.eye.subarray((na - 1) * 3, na * 3), 0); path.aim.set(a.path.aim.subarray((na - 1) * 3, na * 3), 0); path.fov[0] = fovA;
  path.eye.set(b.path.eye.subarray(0, 3), (n - 1) * 3); path.aim.set(b.path.aim.subarray(0, 3), (n - 1) * 3); path.fov[n - 1] = fovB;
  path.flow = flow(path.eye);
  return path;
}

/**
 * A decoded library like decodeShotLibrary returns: { viewId, subjects,
 * shots, links, shotById, linkById, linksFrom, subjectById, ... }. `shots`
 * counts the one rail shot (always shot-0). Subjects 1 and 4 are heroes
 * (`hero: true`, shots tagged 'hero').
 */
export function shotLibraryFixture({ shots = 18, seed = 1 } = {}) {
  const random = mulberry32(seed * 7919 + 17), between = (a, b) => a + (b - a) * random();
  const layout = [['peak', 'North Spire'], ['peak', 'Grand Hero'], ['rail-target', 'Rail Target'], ['butte', 'Red Butte'], ['peak', 'Second Hero'], ['ridge', 'Long Ridge']];
  const subjects = layout.map(([kind, name], i) => {
    const hero = i === 1 || i === 4, y = hero ? between(2200, 2500) : between(1500, 2200);
    return { id: `subject-${i}`, kind, name, hero, posM: [-8000 + 3200 * i + between(-600, 600), y, -4000 + between(-2500, 2500)], radiusM: between(400, 900), heightM: y - FIXTURE_GROUND_M };
  });
  const aimOf = (s) => [s.posM[0], s.posM[1] - .25 * s.heightM, s.posM[2]];
  // The road: an arc of radius ROAD_R around ROAD_CENTRE on the south side,
  // travelled west to east; at arc length a it is at road(a) heading T.
  const road = (a, r = ROAD_R) => { const phi = a / ROAD_R; return { C: [ROAD_CENTRE[0] + r * Math.sin(phi), 0, ROAD_CENTRE[1] + r * Math.cos(phi)], T: [Math.cos(phi), -Math.sin(phi)] }; };
  const records = [];
  {
    const rt = subjects[2], y = FIXTURE_GROUND_M + 700, { C, T } = road(0, ROAD_R + 1500);
    const eyes = [[C[0] - 1500 * T[0], y, C[2] - 1500 * T[1]], [C[0], y + 50, C[2] - 200], [C[0] + 1500 * T[0], y, C[2] + 1500 * T[1]]];
    const path = samplePath({ eyes, aims: eyes.map(() => aimOf(rt)), fovs: LENS_FOV.normal, spacingM: 25 });
    path.flow = flowLane(path.eye);
    records.push(shotRecord('shot-0', rt, 'rail', path, random, false));
  }
  // The other shots are strung along the road with short gaps, each about
  // the nearest or second-nearest subject, so neighbours along the road are
  // mostly of different subjects and the view turns as the road bends.
  const others = [0, 1, 3, 4, 5], lengths = Array.from({ length: shots - 1 }, () => between(250, 450));
  const gap = Math.max(100, (ROAD_M - lengths.reduce((n, l) => n + l, 0)) / Math.max(1, shots - 2));
  let cursor = -ROAD_M / 2;
  for (let i = 1; i < shots; i++) {
    const L = lengths[i - 1], { C: C0, T } = road(cursor + L / 2), C = [C0[0], 0, C0[2] + between(-60, 60)];
    cursor += L + gap * between(.6, 1.4);
    const ranked = others.toSorted((a, b) => Math.hypot(subjects[a].posM[0] - C[0], subjects[a].posM[2] - C[2]) - Math.hypot(subjects[b].posM[0] - C[0], subjects[b].posM[2] - C[2]));
    const subject = subjects[ranked[i % 2]], hero = subject.hero;
    const move = MOVES[(i - 1 + 2 * Math.floor((i - 1) / MOVES.length)) % MOVES.length];
    const agl = move === 'valley' ? between(380, 460) : hero ? between(620, 800) : between(520, 800);
    const { eyes, aims } = moveControls(move, subject.posM, aimOf(subject), C, T, L, agl);
    const path = samplePath({ eyes, aims, fovs: LENS_FOV[LENS[move]], spacingM: 25 });
    path.flow = flowLane(path.eye);
    records.push(shotRecord(`shot-${i}`, subject, move, path, random, hero));
  }
  const links = [];
  for (const a of records) for (const b of records) {
    if (a === b) continue;
    const na = a.path.s.length, d = Math.hypot(...[0, 1, 2].map((k) => b.path.eye[k] - a.path.eye[(na - 1) * 3 + k]));
    if (d > 9000) continue;
    for (const kind of ['direct', 'arc']) {
      const path = linkPath(a, b, kind, random), lengthM = path.s[path.s.length - 1], total = .35 + .4 * random() + (kind === 'arc' ? .05 : 0);
      links.push({ id: `link-${a.id}-${b.id}-${kind}`, from: a.id, to: b.id, kind, lengthM,
        durationMs: { min: lengthM / 80 * 1000, max: lengthM / 4 * 1000 }, score: { total, weakest: total - .1 * random() }, path });
    }
  }
  const bytes = packShotPaths([...records, ...links]);
  const strip = ({ path, ...rest }) => rest;
  const hex = (c) => c.repeat(64);
  const manifest = {
    schema: SHOT_SCHEMA, version: SHOT_VERSION, viewId: 'fixture-range-front', regionId: 'fixture', terrainManifestSha256: hex('a'),
    axes: { x: 'east', y: 'up', z: 'south', units: 'metres' }, subjects, shots: records.map(strip), links: links.map(strip),
    payload: { url: 'fixture-range-front.shots.bin.gz', byteLength: bytes.length, sha256: hex('b'), decodedByteLength: bytes.length, decodedSha256: hex('c') },
    provenance: { fixture: true, seed, groundM: FIXTURE_GROUND_M },
  };
  return decodeShotLibrary(manifest, bytes);
}

/**
 * The structured "anthem" test song: chorus downbeats at 48.0, 96.0 and
 * 128.0 s (the final chorus the strongest rise), while the detected section
 * starts are 15.5, 37.5, 45.5, 67.5, 75.5, 85.5, 93.5, 113.5, 127.5 and
 * 153.5 s, up to 2.5 s early. Energy every 100 ms with a beat ripple.
 */
export function anthemSong({ energyStepMs = 100, finalChorusIndex = 9 } = {}) {
  const durationMs = 170000, starts = [0, 15500, 37500, 45500, 67500, 75500, 85500, 93500, 113500, 127500, 153500];
  const labels = ['I', 'V', 'P', 'C', 'X', 'V', 'P', 'C', 'B', 'C', 'O'];
  const roleNames = ['intro', 'verse', 'pre-chorus', 'chorus', 'post-chorus', 'verse', 'pre-chorus', 'chorus', 'bridge', 'chorus', 'outro'];
  const level = (t) => {
    if (t < 16000) return .15;
    if (t < 38000) return .38;
    if (t < 48000) return .42 + .13 * (t - 38000) / 10000;
    if (t < 68000) return .82;
    if (t < 76000) return .62;
    if (t < 86000) return .4;
    if (t < 96000) return .45 + .13 * (t - 86000) / 10000;
    if (t < 114000) return .9;
    if (t < 128000) return .22;
    if (t < 154000) return 1;
    return .3 - .2 * (t - 154000) / 16000;
  };
  const random = mulberry32(99), n = Math.floor(durationMs / energyStepMs) + 1, energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * energyStepMs;
    energy[i] = Math.max(0, level(t) * (1 + .03 * Math.sin(2 * Math.PI * t / 500)) + (random() - .5) * .01);
  }
  const sections = starts.map((startMs, i) => ({ startMs, endMs: starts[i + 1] ?? durationMs, label: labels[i], provenance: 'detected',
    relEnergy01: Math.min(1, level(startMs + 3000)) }));
  const roles = roleNames.map((role, i) => ({ role, confidence: .8, finalChorus: i === finalChorusIndex, stops: [] }));
  return { durationMs, sections, roles, energy, energyStepMs, downbeatsMs: [48000, 96000, 128000] };
}

const MOTION = Object.freeze({ maxSpeedMps: 120, minSpeedMps: 4, flowCalm: .07, flowEnergetic: .24, maxYawDegPerSec: 20, maxClimbMps: 22, maxAccelMps2: 3.5 });
// Flow on the scale the real libraries measure (about 0.0006-0.003 rad per
// progress metre for 100-600 m above the ground).
const realFlow = (eye) => Float32Array.from({ length: eye.length / 3 }, (_, i) => .3 / Math.max(150, eye[i * 3 + 1] - FIXTURE_GROUND_M + 100));
const REAL_PAYOFF = { rail: .45, traverse: .55, approach: .78, reveal: .62, orbit: .48, pullback: .9, valley: .6 };
const REAL_LENS = { rail: 'tele', traverse: 'tele', approach: 'wide', reveal: 'wide', orbit: 'wide', pullback: 'wide', valley: 'normal' };

/**
 * A library shaped like the real ones (Monument Valley: 15 shots of 0.6-1.6
 * km, 45 links of 0.6-2.2 km (median 1.2), 2-4 links per shot, shots sampled every ~29 m
 * and links every ~58 m on the 0.1 m lattice, an isolated rail shot, a hero
 * subject, `motion` limits in the manifest) but with the links the contract
 * asks for: they leave and arrive along the shots' tangents (Dubins turns of
 * 600-900 m), so nothing in them forces a crawl.
 *
 * Two lanes circle the subjects (radius 1.6 and 2.2 km, travelled
 * counter-clockwise); `slots` slots around the loop hold one shot on each
 * lane, each shot linking ahead to both shots of the next slot. A lap is one
 * shot per slot, about 11 km. Shot 0 is the rail (no links). Subject
 * 'hero-butte' (hero) stands in the centre, four more around it.
 * `kinkDeg` makes every link leave and arrive that far off the shots'
 * headings (kinked joins, like the real libraries' links).
 */
export function rangeShotLibraryFixture({ seed = 1, slots = 5, kinkDeg = 0 } = {}) {
  const random = mulberry32(seed * 104729 + 7), between = (a, b) => a + (b - a) * random(), G = FIXTURE_GROUND_M, R = [1600, 2200];
  const subjects = [{ id: 'hero-butte', kind: 'butte', name: 'Hero Butte', hero: true, posM: [0, G + 380, 0], radiusM: 260, heightM: 380 }];
  for (let k = 0; k < 4; k++) {
    const a = (k + .5) * Math.PI / 2 + between(-.3, .3), r = between(900, 1300), h = between(180, 320);
    subjects.push({ id: `butte-${k}`, kind: k === 3 ? 'peak' : 'butte', name: null, posM: [r * Math.cos(a), G + h, r * Math.sin(a)], radiusM: between(120, 300), heightM: h });
  }
  const aimOf = (s) => [s.posM[0], s.posM[1] - .3 * s.heightM, s.posM[2]];
  const order = [0, 1, 2, 3, 4].map((k) => subjects[(k + seed) % 5]);
  const innerMoves = ['approach', 'orbit', 'reveal', 'valley', 'traverse'], outerMoves = ['traverse', 'pullback', 'orbit', 'traverse', 'approach'];
  const records = [];
  const make = (id, subject, move, lane, phi0, L, agl, hero) => {
    const r0 = R[lane], eyes = [], aims = [], target = aimOf(subject);
    // Dense control points: the spline through them then follows the eased
    // moves (and the reveal's pan) closely instead of kinking between them.
    const K = 32;
    for (let k = 0; k <= K; k++) {
      const u = k / K, r = r0 + (move === 'approach' ? -260 * smooth(u) : move === 'pullback' ? 220 * smooth(u) : 0), phi = phi0 + L / r0 * u;
      const y = G + agl + (move === 'pullback' ? 400 * smooth(u) : move === 'approach' ? -50 * smooth(u) : move === 'valley' ? -25 * Math.sin(Math.PI * u) : 0);
      eyes.push([r * Math.cos(phi), y, r * Math.sin(phi)]);
      if (move === 'reveal') {
        // The look starts along the travel, at rest, and pans onto the subject by 70%.
        const ahead = [eyes[k][0] - 3000 * Math.sin(phi), target[1], eyes[k][2] + 3000 * Math.cos(phi)], h = pan(u / .7);
        aims.push([0, 1, 2].map((q) => ahead[q] + (target[q] - ahead[q]) * h));
      } else aims.push(target);
    }
    const path = samplePath({ eyes, aims, fovs: LENS_FOV[REAL_LENS[move] === 'tele' ? 'tele' : REAL_LENS[move]], spacingM: 29.4 });
    path.flow = realFlow(path.eye);
    const n = path.s.length, lengthM = path.s[n - 1], payoffS = REAL_PAYOFF[move] * lengthM, pose = pathPoseAt(path, payoffS), look = headingPitch(lookDir(pose));
    const aglM = pose.eyeM[1] - G, dx = pose.eyeM[0] - subject.posM[0], dz = pose.eyeM[2] - subject.posM[2], total = (hero ? .66 : .55) + .2 * random();
    const pass = move === 'traverse' && random() < .6, tags = [...(pass ? ['foreground-pass'] : []), ...(move === 'pullback' ? ['crane'] : []), ...(hero ? ['hero'] : [])];
    records.push({
      id, subjectId: subject.id, move, lengthM, payoffS, holdS: [Math.max(0, payoffS - .25 * lengthM), Math.min(lengthM, payoffS + .25 * lengthM)],
      durationMs: { min: lengthM / 120 * 1000, ideal: Math.max(16000, lengthM / 100 * 1000), max: lengthM / 4 * 1000 },
      traits: { lens: REAL_LENS[move], elevation: aglM < 200 ? 'low' : aglM < 450 ? 'mid' : 'high', side: dx >= 0 ? 'right' : 'left',
        ...(pass ? { foregroundSubjectId: order[(order.indexOf(subject) + 1) % 5].id } : {}), headingDeg: look.headingDeg, azimuthDeg: Math.atan2(dx, -dz) * 180 / Math.PI,
        elevationDeg: look.pitchDeg, aglM, distanceM: Math.hypot(dx, dz), fovYDeg: LENS_FOV[REAL_LENS[move]], foreground: .33 },
      score: { total, composition: total, subject: total, depth: total, parallax: total, reveal: total, weakest: total - .1, render: null }, tags, path,
    });
  };
  make('rail-0', subjects[1], 'rail', 1, between(0, 2 * Math.PI), 900, 90, false);
  for (let j = 0; j < slots; j++) {
    const phi = j * 2 * Math.PI / slots;
    for (const lane of [0, 1]) {
      const subject = order[(j + 2 * lane) % 5], move = (lane ? outerMoves : innerMoves)[(j + seed) % 5];
      const L = lane ? between(1000, 1550) : between(700, 1250), agl = move === 'valley' ? between(80, 120) : move === 'pullback' ? between(150, 220) : between(110, 330);
      make(`${move}-${subject.id}-${j}${lane ? 'o' : 'i'}`, subject, move, lane, phi + between(-.03, .03), L, agl, !!subject.hero);
    }
  }
  // Links ahead to both shots of the next slot (never to or from the rail).
  const links = [];
  for (let a = 1; a < records.length; a++) {
    const out = [];
    for (let b = 1; b < records.length; b++) {
      if (a === b || Math.floor((b - 1) / 2) !== (Math.floor((a - 1) / 2) + 1) % slots) continue;
      for (const kind of ['direct', 'arc']) {
        const path = linkPath(records[a], records[b], kind, random, { spacingM: 58, radius: kind === 'arc' ? 900 : 600, flow: realFlow, kinkDeg }), lengthM = path.s.at(-1);
        if (lengthM > 2200) continue;
        const total = .55 + .3 * random();
        out.push({ id: `link-${records[a].id}-${records[b].id}-${kind}`, from: records[a].id, to: records[b].id, kind, lengthM,
          durationMs: { min: lengthM / 120 * 1000, ideal: lengthM / 80 * 1000, max: lengthM / 4 * 1000 }, score: { total, weakest: total - .1 }, path });
      }
    }
    // The shortest link to each next shot, and the other kind to some of them (2-4 per shot).
    out.sort((x, y) => x.lengthM - y.lengthM);
    const first = out.filter((l, k) => out.findIndex((m) => m.to === l.to) === k), rest = out.filter((l) => !first.includes(l));
    links.push(...first, ...rest.filter(() => random() < .5));
  }
  const bytes = packShotPaths([...records, ...links]);
  const strip = ({ path, ...rest }) => rest;
  const hex = (c) => c.repeat(64);
  const manifest = {
    schema: SHOT_SCHEMA, version: SHOT_VERSION, viewId: 'fixture-range-loop', regionId: 'fixture', terrainManifestSha256: hex('d'),
    axes: { x: 'east', y: 'up', z: 'south', units: 'metres' }, motion: { ...MOTION }, subjects, shots: records.map(strip), links: links.map(strip),
    payload: { url: 'fixture-range-loop.shots.bin.gz', byteLength: bytes.length, sha256: hex('e'), decodedByteLength: bytes.length, decodedSha256: hex('f') },
    provenance: { fixture: true, shape: 'range', seed, kinkDeg, groundM: G },
  };
  return decodeShotLibrary(manifest, bytes);
}

/**
 * A structured test song from its energy levels: `levels` [[startMs,
 * level | [from, to]], ...] (a pair ramps over the span), with the detected
 * sections starting at `starts` (labelled `roles`) as the analysis path
 * reports them -- early and mislabelled like the real probes -- and the
 * ground-truth payoffs `downbeatsMs` (the last the climax).
 */
export function songFixture({ durationMs, levels, starts, roles, downbeatsMs, finalChorusIndex = -1, energyStepMs = 100, seed = 7 }) {
  const level = (t) => {
    let k = 0;
    while (k + 1 < levels.length && levels[k + 1][0] <= t) k++;
    const [a, v] = levels[k], b = levels[k + 1]?.[0] ?? durationMs;
    return Array.isArray(v) ? v[0] + (v[1] - v[0]) * (t - a) / Math.max(1, b - a) : v;
  };
  const random = mulberry32(seed), n = Math.floor(durationMs / energyStepMs) + 1, energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * energyStepMs;
    energy[i] = Math.max(0, level(t) * (1 + .03 * Math.sin(2 * Math.PI * t / 470)) + (random() - .5) * .01);
  }
  const sections = starts.map((startMs, i) => ({ startMs, endMs: starts[i + 1] ?? durationMs, label: String(i), provenance: 'detected', relEnergy01: Math.min(1, level(startMs + 3000)) }));
  return { durationMs, sections, roles: roles.map((role, i) => ({ role, confidence: .8, finalChorus: i === finalChorusIndex, stops: [] })), energy, energyStepMs, downbeatsMs };
}

/** The "drop" song: drops at 45.0 and 97.5 s (the climax), 142.5 s. */
export const dropSong = () => songFixture({
  durationMs: 142500, downbeatsMs: [45000, 97500],
  levels: [[0, .15], [15000, .35], [37500, [.4, .6]], [45000, .95], [75000, .2], [90000, [.45, .65]], [97500, 1], [127500, [.3, .1]]],
  starts: [0, 5671, 14998, 20618, 29986, 46870, 74972, 78715, 86251, 99359, 129351, 133092, 136833],
  roles: ['intro', 'verse', 'chorus', 'chorus', 'chorus', 'chorus', 'breakdown', 'verse', 'bridge', 'chorus', 'breakdown', 'chorus', 'outro'], finalChorusIndex: 11,
});

/** The "short" song: one chorus at 28.8 s, 60 s. */
export const shortSong = () => songFixture({
  durationMs: 60000, downbeatsMs: [28800],
  levels: [[0, .15], [9600, .4], [28800, .9], [48000, [.3, .1]]],
  starts: [0, 15588, 32388, 47993], roles: ['intro', 'verse', 'bridge', 'outro'],
});
