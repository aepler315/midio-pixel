// Offline pilot: can real massifs from different shipped views be composed
// into one song-specific range without visible seams at skyline distance?
//
// This is evidence for a design question, not a renderer or a runtime path.
// It decodes shipped terrain packages with the production decoder, cuts a
// feathered disc of relief around named landmarks, places those discs around
// one fixed viewpoint, and draws a CPU perspective still plus a plan view.
//
// Shipped packages only hold the ground their authored cameras see, so each
// massif keeps the side it showed its own rail turned toward the stage eye.
//
//   node tools/range-compose-pilot.mjs \
//     --massif teton-jackson-lake:"Grand Teton" \
//     --massif sawtooth-redfish-north:"Heyburn Mountain" \
//     --massif san-juan-sneffels-north:"Mount Sneffels" \
//     --out .smoke/range-compose
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync, deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { decodeTerrain, terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';

const ROOT = new URL('..', import.meta.url).pathname;
const TERRAIN_DIR = join(ROOT, 'src/assets/range/v2/terrain');
const M_PER_DEG = 111320;

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function parseArgs(argv) {
  const out = { massifs: [], outDir: '.smoke/range-compose', radiusM: 9000, cellM: 40,
    width: 1280, height: 540, fovXDeg: 62, spreadDeg: 19, eyeAboveM: 220, distanceM: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--massif') { const [view, ...name] = next().split(':'); out.massifs.push({ view, name: name.join(':') }); }
    else if (a === '--out') out.outDir = next();
    else if (a === '--radius') out.radiusM = Number(next());
    else if (a === '--cell') out.cellM = Number(next());
    else if (a === '--spread') out.spreadDeg = Number(next());
    else if (a === '--distance') out.distanceM = Number(next());
    else if (a === '--eye-above') out.eyeAboveM = Number(next());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.massifs.length) throw new Error('give at least one --massif view:"Landmark name"');
  return out;
}

const views = new Map(JSON.parse(readFileSync(join(ROOT, 'data/terrain/scenic-views.json'), 'utf8')).views.map(v => [v.id, v]));
const packages = new Map();
function loadPackage(viewId) {
  if (packages.has(viewId)) return packages.get(viewId);
  const manifest = JSON.parse(readFileSync(join(TERRAIN_DIR, `${viewId}.terrain.json`), 'utf8'));
  const bytes = new Uint8Array(gunzipSync(readFileSync(join(TERRAIN_DIR, manifest.payload.url))));
  const data = decodeTerrain(manifest, bytes);
  packages.set(viewId, data);
  return data;
}

/** Local metres (X east, Z south) about the package centre; adequate at these extents. */
function localM(manifest, [lon, lat]) {
  const [lon0, lat0] = manifest.source.centerLonLat;
  return [(lon - lon0) * Math.cos((lat + lat0) * Math.PI / 360) * M_PER_DEG, -(lat - lat0) * M_PER_DEG];
}

/** A square lattice of relief about a landmark, in a frame whose +v axis
 *  points from the peak toward the view's own rail eye. */
function extractMassif({ view, name }, { radiusM, cellM }) {
  const data = loadPackage(view), record = views.get(view);
  const mark = data.manifest.landmarks.find(l => l.name === name);
  if (!mark) throw new Error(`${view} has no landmark "${name}"; it has ${data.manifest.landmarks.map(l => l.name).join(', ')}`);
  const a = localM(data.manifest, record.rail.eyeStart.lonLat), b = localM(data.manifest, record.rail.eyeEnd.lonLat);
  const eye = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], peak = mark.localM;
  const eyeDistanceM = Math.hypot(eye[0] - peak[0], eye[1] - peak[1]);
  const f = [(eye[0] - peak[0]) / eyeDistanceM, (eye[1] - peak[1]) / eyeDistanceM], r = [f[1], -f[0]];
  const n = 2 * Math.round(radiusM / cellM) + 1, half = (n - 1) / 2;
  const h = new Float32Array(n * n), valid = new Float32Array(n * n);
  const present = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const u = (i - half) * cellM, v = (j - half) * cellM;
    const y = terrainHeightAt(data, peak[0] + u * r[0] + v * f[0], peak[1] + u * r[1] + v * f[1]);
    if (Number.isFinite(y)) { h[j * n + i] = y; valid[j * n + i] = 1; present.push(y); }
  }
  present.sort((x, y) => x - y);
  const baseM = present[Math.floor(present.length * .12)];
  // Feather toward missing ground: blur the validity mask, keep its upper half.
  const blur = (src, radius) => {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (const [from, to, dx, dy] of [[src, tmp, 1, 0], [tmp, out, 0, 1]]) {
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const x = Math.min(n - 1, Math.max(0, i + k * dx)), y = Math.min(n - 1, Math.max(0, j + k * dy));
          sum += from[y * n + x];
        }
        to[j * n + i] = sum / (2 * radius + 1);
      }
    }
    return out;
  };
  const edge = blur(blur(valid, 8), 8);
  const relief = new Float32Array(n * n), mask = new Float32Array(n * n);
  let holes = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, d = Math.hypot(i - half, j - half) / half;
    if (!valid[k]) holes++;
    mask[k] = valid[k] ? (1 - smooth(.5, 1, d)) * smooth(.5, .98, edge[k]) : 0;
    relief[k] = valid[k] ? Math.max(0, h[k] - baseM) : 0;
  }
  return { view, name, n, half, cellM, relief, mask, baseM, eyeDistanceM,
    peakReliefM: mark.demGroundM - baseM, missingShare: holes / (n * n) };
}

function sampleLattice(field, n, x, y) {
  if (!(x >= 0 && y >= 0 && x <= n - 1 && y <= n - 1)) return 0;
  const i = Math.min(n - 2, Math.floor(x)), j = Math.min(n - 2, Math.floor(y)), tx = x - i, ty = y - j;
  const a = field[j * n + i], b = field[j * n + i + 1], c = field[(j + 1) * n + i], d = field[(j + 1) * n + i + 1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** Stage: eye at the origin looking toward -Z, massifs fanned across the view. */
function composeStage(massifs, opts) {
  const { cellM, spreadDeg } = opts;
  const slots = massifs.map((m, i) => {
    const az = (i - (massifs.length - 1) / 2) * spreadDeg * Math.PI / 180;
    const d = opts.distanceM > 0 ? opts.distanceM : m.eyeDistanceM;
    const c = [Math.sin(az) * d, -Math.cos(az) * d], F = [-c[0] / d, -c[1] / d];
    return { m, c, d, az, F, R: [F[1], -F[0]] };
  });
  const reach = Math.max(...slots.map(s => s.d)) + opts.radiusM + 2000;
  const minX = -reach, minZ = -reach, w = Math.ceil(2 * reach / cellM) + 1, hgt = Math.ceil((reach + 2000) / cellM) + 1;
  const land = new Float32Array(w * hgt), owner = new Int8Array(w * hgt).fill(-1), blend = new Float32Array(w * hgt);
  for (let s = 0; s < slots.length; s++) {
    const { m, c, F, R } = slots[s], rad = m.half * m.cellM;
    const i0 = Math.max(0, Math.floor((c[0] - rad - minX) / cellM)), i1 = Math.min(w - 1, Math.ceil((c[0] + rad - minX) / cellM));
    const j0 = Math.max(0, Math.floor((c[1] - rad - minZ) / cellM)), j1 = Math.min(hgt - 1, Math.ceil((c[1] + rad - minZ) / cellM));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = minX + i * cellM - c[0], dz = minZ + j * cellM - c[1];
      const u = (dx * R[0] + dz * R[1]) / m.cellM + m.half, v = (dx * F[0] + dz * F[1]) / m.cellM + m.half;
      const k = sampleLattice(m.mask, m.n, u, v);
      if (!(k > 0)) continue;
      const y = k * sampleLattice(m.relief, m.n, u, v), at = j * w + i;
      if (y > land[at]) { land[at] = y; owner[at] = s; blend[at] = k; }
    }
  }
  return { land, owner, blend, w, h: hgt, minX, minZ, cellM, slots };
}

function stageHeight(stage, x, z) {
  return sampleLattice(stage.land, stage.w, (x - stage.minX) / stage.cellM, (z - stage.minZ) / stage.cellM);
}

/** Slope inside each feather band against the massif's own interior. */
function seamReport(stage) {
  const { land, owner, blend, w, h, cellM } = stage;
  const rows = stage.slots.map(() => ({ band: [], core: [] }));
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
    const k = j * w + i, s = owner[k];
    if (s < 0) continue;
    const slope = Math.hypot(land[k + 1] - land[k - 1], land[k + w] - land[k - w]) / (2 * cellM);
    (blend[k] < .9 ? rows[s].band : rows[s].core).push(slope);
  }
  const q = (v, p) => { if (!v.length) return 0; const s = Float32Array.from(v).sort(); return s[Math.floor(p * (s.length - 1))]; };
  return rows.map((r, s) => ({ massif: stage.slots[s].m.name,
    coreSlopeMedian: +q(r.core, .5).toFixed(3), coreSlopeP95: +q(r.core, .95).toFixed(3),
    featherSlopeMedian: +q(r.band, .5).toFixed(3), featherSlopeP95: +q(r.band, .95).toFixed(3) }));
}

const SUN = (() => { const v = [-.55, .62, .56], l = Math.hypot(...v); return v.map(x => x / l); })();
function shade(stage, x, z, y, distM, topReliefM) {
  const e = stage.cellM;
  const nx = stageHeight(stage, x - e, z) - stageHeight(stage, x + e, z), nz = stageHeight(stage, x, z - e) - stageHeight(stage, x, z + e);
  const len = Math.hypot(nx, 2 * e, nz), light = Math.max(0, (nx * SUN[0] + 2 * e * SUN[1] + nz * SUN[2]) / len);
  const steep = 1 - 2 * e / len, rel = y / topReliefM;
  const forest = [46, 74, 58], rock = [118, 110, 104], snow = [236, 240, 246], plain = [92, 112, 84];
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  let c = mix(plain, forest, smooth(.01, .08, rel));
  c = mix(c, rock, Math.max(smooth(.3, .5, rel), smooth(.25, .5, steep)));
  c = mix(c, snow, smooth(.55, .78, rel) * (1 - smooth(.45, .75, steep)));
  const lit = .28 + .9 * light, haze = 1 - Math.exp(-distM / 42000), sky = [168, 190, 214];
  return c.map((v, i) => Math.min(255, v * lit) * (1 - haze) + sky[i] * haze);
}

function renderStill(stage, opts) {
  const { width: W, height: H, fovXDeg, eyeAboveM } = opts;
  const focal = (W / 2) / Math.tan(fovXDeg * Math.PI / 360);
  const topReliefM = Math.max(...stage.slots.map(s => s.m.peakReliefM));
  const far = Math.max(...stage.slots.map(s => s.d)) + opts.radiusM;
  const mid = stage.slots.reduce((a, s) => a + s.d, 0) / stage.slots.length;
  // Aim so the tallest summit sits in the upper third.
  const horizon = Math.round(H * .30 + focal * (topReliefM - eyeAboveM) / mid);
  const px = new Uint8ClampedArray(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = y / H, o = (y * W + x) * 3;
    px[o] = 96 + 86 * t; px[o + 1] = 138 + 62 * t; px[o + 2] = 196 + 26 * t;
  }
  for (let x = 0; x < W; x++) {
    const dx = (x + .5 - W / 2) / focal, norm = Math.hypot(dx, 1);
    let top = H;
    for (let t = 300; t < far && top > 0; t += Math.max(stage.cellM * .5, t * .0025)) {
      const wx = dx * t, wz = -t, y = stageHeight(stage, wx, wz);
      const sy = Math.floor(horizon - focal * (y - eyeAboveM) / t);
      if (sy >= top) continue;
      const c = y > .5 ? shade(stage, wx, wz, y, t * norm, topReliefM)
        : shade(stage, wx, wz, 0, t * norm, topReliefM).map((v, i) => v * .55 + [70, 104, 132][i] * .45);
      for (let row = Math.max(0, sy); row < top; row++) { const o = (row * W + x) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; }
      top = Math.max(0, sy);
    }
  }
  return { px, W, H };
}

function renderPlan(stage) {
  const step = Math.max(1, Math.ceil(stage.w / 1000)), W = Math.floor(stage.w / step), H = Math.floor(stage.h / step);
  const px = new Uint8ClampedArray(W * H * 3), top = Math.max(...stage.slots.map(s => s.m.peakReliefM));
  const tint = [[255, 214, 170], [176, 222, 255], [198, 255, 190], [255, 190, 236], [255, 250, 170]];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * step * stage.w + i * step, s = stage.owner[k], o = (j * W + i) * 3;
    const x = stage.minX + i * step * stage.cellM, z = stage.minZ + j * step * stage.cellM, e = stage.cellM * step;
    const light = .5 + (stageHeight(stage, x - e, z) - stageHeight(stage, x + e, z) + stageHeight(stage, x, z - e) - stageHeight(stage, x, z + e)) / (4 * e);
    const base = s < 0 ? [58, 78, 96] : tint[s % tint.length].map(v => v * (.35 + .65 * stage.land[k] / top));
    for (let c = 0; c < 3; c++) px[o + c] = base[c] * Math.max(.25, Math.min(1.6, light + .5));
  }
  return { px, W, H };
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function png({ px, W, H }) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(W, 0); head.writeUInt32BE(H, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const opts = parseArgs(process.argv.slice(2));
const massifs = opts.massifs.map(m => extractMassif(m, opts));
const stage = composeStage(massifs, opts);
mkdirSync(opts.outDir, { recursive: true });
writeFileSync(join(opts.outDir, 'still.png'), png(renderStill(stage, opts)));
writeFileSync(join(opts.outDir, 'plan.png'), png(renderPlan(stage)));
const report = {
  note: 'CPU pilot still from shipped packages. Not the production renderer; no forest, water, materials or lighting model.',
  options: { radiusM: opts.radiusM, cellM: opts.cellM, spreadDeg: opts.spreadDeg, fovXDeg: opts.fovXDeg, eyeAboveM: opts.eyeAboveM },
  massifs: stage.slots.map(s => ({ view: s.m.view, name: s.m.name, biome: views.get(s.m.view).biome,
    peakReliefM: Math.round(s.m.peakReliefM), baseM: Math.round(s.m.baseM), sourceEyeDistanceM: Math.round(s.m.eyeDistanceM),
    stageDistanceM: Math.round(s.d), azimuthDeg: +(s.az * 180 / Math.PI).toFixed(1), missingShare: +s.m.missingShare.toFixed(3) })),
  seams: seamReport(stage),
};
writeFileSync(join(opts.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
