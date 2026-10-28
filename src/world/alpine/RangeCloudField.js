// Finite atmospheric banks on a fixed metric lattice. Cell IDs and world
// positions do not follow the camera; only the bounded candidate lookup does.
const CELL_M = 32000, RING = 5;
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = a => { const n = Math.hypot(...a); return n > 1e-12 ? a.map(v => v / n) : null; };
function hash(x, z, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
}

function cameras(camera) {
  const source = camera?.tourPose ? [{ pose: camera.tourPose, aspect: camera.tourPose.aspect, weight: 1 }]
    : camera?.skyCamera ? [
      { ...camera.skyCamera.from, weight: 1 - clamp(camera.skyCamera.mix || 0) },
      { ...(camera.skyCamera.to || camera.skyCamera.from), weight: clamp(camera.skyCamera.mix || 0) },
    ] : [];
  return source.filter(c => c.weight > 0 && c.pose?.eyeM?.every(Number.isFinite) && c.pose?.targetM?.every(Number.isFinite))
    .flatMap(c => {
      const pose = c.pose, forward = normalize(sub(pose.targetM, pose.eyeM));
      if (!forward || !(pose.fovYDeg > 0 && pose.fovYDeg < 180)) return [];
      let right = normalize(cross(forward, pose.upM || [0, 1, 0]));
      right ||= normalize(cross(forward, [0, 0, 1])) || [1, 0, 0];
      return [{ ...c, aspect: c.aspect || pose.aspect || 16 / 9, forward, right,
        up: cross(right, forward), tan: Math.tan(pose.fovYDeg * Math.PI / 360) }];
    });
}
function project(c, point) {
  const delta = sub(point, c.pose.eyeM), depth = dot(delta, c.forward);
  if (!(depth > (c.pose.near ?? 20)) || depth > (c.pose.far ?? 150000)) return null;
  let x = dot(delta, c.right) / (depth * c.tan * c.aspect), y = dot(delta, c.up) / (depth * c.tan);
  if (c.pose.viewOffset) {
    const { fx = 0, rx = 0, uy = 0 } = c.pose.viewOffset;
    if (!(fx < 1)) return null;
    x = (x - rx / (c.tan * c.aspect)) / (1 - fx);
    y = (y - uy / c.tan) / (1 - fx);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { xFrac: (x + 1) * .5, yFrac: (1 - y) * .5, depth };
}

/** Finite world point through the resolved terrain pose/lens/crop. upM is
 * optional for reflected cameras. Production impact roll remains in the
 * caller's scenic Canvas transform and must not be applied twice here. */
export function projectCloudPoint(camera, point) {
  if (!point?.every(Number.isFinite)) return { xFrac: .5, yFrac: .5, depth: 0, inFront: false, visible: false, viewWeight: 0 };
  let x = 0, y = 0, depth = 0, weight = 0;
  for (const c of cameras(camera)) {
    const p = project(c, point);
    if (!p) continue;
    x += p.xFrac * c.weight; y += p.yFrac * c.weight; depth += p.depth * c.weight; weight += c.weight;
  }
  if (!weight) return { xFrac: .5, yFrac: .5, depth: 0, inFront: false, visible: false, viewWeight: 0 };
  const xFrac = x / weight, yFrac = y / weight;
  return { xFrac, yFrac, depth: depth / weight, inFront: true,
    visible: xFrac >= 0 && xFrac <= 1 && yFrac >= 0 && yFrac <= 1, viewWeight: weight };
}

function sprite(c, world, widthM, heightM, width, height) {
  const centre = project(c, world);
  if (!centre) return null;
  const delta = sub(world, c.pose.eyeM);
  // A volume billboard faces the horizontal view ray and keeps world up.
  // Its projected axes provide perspective scale and tilt, including an
  // inverted reflected up vector, without painting an axis-aligned panel.
  const right = normalize([-delta[2], 0, delta[0]]) || c.right;
  const edge = sign => project(c, world.map((value, i) => value + right[i] * widthM * .5 * sign));
  const left = edge(-1), r = edge(1);
  const top = project(c, [world[0], world[1] + heightM * .5, world[2]]);
  const bottom = project(c, [world[0], world[1] - heightM * .5, world[2]]);
  if (!left || !r || !top || !bottom) return null;
  return [(r.xFrac - left.xFrac) * width, (r.yFrac - left.yFrac) * height,
    (bottom.xFrac - top.xFrac) * width, (bottom.yFrac - top.yFrac) * height,
    centre.xFrac * width, centre.yFrac * height];
}

/** One lattice cell's bank: world centre, width/height (m) and base alpha.
 *  Shared by the painted banks and the ground's cloud shadows, so a shadow
 *  falls exactly under the cloud the sky draws. Writes into `out`. */
export function cloudCell(ix, iz, salt, storm, windX, windZ, out) {
  const widthM = (storm ? 10000 : 6000) + hash(ix, iz, salt + 4) * (storm ? 12000 : 8000);
  const heightM = widthM * 128 / 192;
  // Altitude describes the full card's base, not its centre. Even the
  // tallest storm bank remains above the peaks before density masking.
  out.x = (ix + .08 + hash(ix, iz, salt + 1) * .84) * CELL_M + windX;
  out.y = (storm ? 4500 : 5500) + hash(ix, iz, salt + 2) * 2000 + heightM * .5;
  out.z = (iz + .08 + hash(ix, iz, salt + 3) * .84) * CELL_M + windZ;
  out.widthM = widthM; out.heightM = heightM;
  out.alpha = (storm ? .75 : .32) + hash(ix, iz, salt + 6) * (storm ? .25 : .32);
  return out;
}
const CELL = { x: 0, y: 0, z: 0, widthM: 0, heightM: 0, alpha: 0 };
const SHADOW_RING = 2, SHADOW_CANDIDATES = (2 * SHADOW_RING + 1) ** 2;
// Candidate banks: distance, ix, iz (module scratch; nothing per frame).
const CANDIDATES = new Float64Array(SHADOW_CANDIDATES * 3);
/** Values per caster written by cloudShadowCasters. */
export const CLOUD_CASTER_STRIDE = 6;
// Sub-discs per bank along the fixed wind axis, and the footprint (about
// .35 * widthM from the bank's centre to its end).
const SUB_DISCS = [-.18, 0, .18], ALONG = .17, ACROSS = .26;
export const CLOUD_WIND_AXIS = Object.freeze([10 / Math.hypot(10, 3), 3 / Math.hypot(10, 3)]);
/** Fair-weather banks whose shadows can reach the ground around the eye:
 *  the same cells, salt and wind as cloudBanks(storm=false), selected
 *  around the eye's footprint moved toward the light (a cloud at altitude
 *  h shades the ground h / lightDir.y back along the light). Each bank is
 *  three soft elliptical sub-discs along the wind axis. Writes up to `max`
 *  discs into `out` as [x, altitude, z, radiusAlongM, radiusAcrossM,
 *  opacity] and returns the count, ordered by distance then cell id. */
export function cloudShadowCasters({ eyeM, timeSec = 0, seed = 0, lightDir, max = 16, out } = {}) {
  if (!out || !eyeM || !lightDir || !(lightDir[1] > 0) || !Number.isFinite(eyeM[0]) || !Number.isFinite(eyeM[2])
    || !Number.isFinite(lightDir[0]) || !Number.isFinite(lightDir[2])) return 0;
  const time = Number.isFinite(timeSec) ? timeSec : 0, windX = time * 10, windZ = time * 3, salt = seed | 0;
  const limit = Math.min(max | 0, Math.floor(out.length / CLOUD_CASTER_STRIDE));
  if (!(limit > 0)) return 0;
  // Typical fair-weather card-centre altitude (base 5500-7500 m plus half
  // a 4-9 km card), carried back along the light to the eye's footprint.
  const reach = Math.min(60000, 9500 / Math.max(.05, lightDir[1]));
  const fx = eyeM[0] + lightDir[0] * reach, fz = eyeM[2] + lightDir[2] * reach;
  const cx = Math.floor((fx - windX) / CELL_M), cz = Math.floor((fz - windZ) / CELL_M);
  let n = 0;
  for (let dz = -SHADOW_RING; dz <= SHADOW_RING; dz++) for (let dx = -SHADOW_RING; dx <= SHADOW_RING; dx++) {
    const ix = cx + dx, iz = cz + dz;
    cloudCell(ix, iz, salt, false, windX, windZ, CELL);
    const d = Math.hypot(CELL.x - fx, CELL.z - fz);
    // Insertion by distance, then cell id (iz, ix): deterministic order.
    let k = n++;
    while (k > 0) {
      const o = (k - 1) * 3, pd = CANDIDATES[o];
      if (pd < d || (pd === d && (CANDIDATES[o + 2] < iz || (CANDIDATES[o + 2] === iz && CANDIDATES[o + 1] < ix)))) break;
      CANDIDATES[k * 3] = pd; CANDIDATES[k * 3 + 1] = CANDIDATES[o + 1]; CANDIDATES[k * 3 + 2] = CANDIDATES[o + 2];
      k--;
    }
    CANDIDATES[k * 3] = d; CANDIDATES[k * 3 + 1] = ix; CANDIDATES[k * 3 + 2] = iz;
  }
  let count = 0;
  for (let c = 0; c < n && count < limit; c++) {
    cloudCell(CANDIDATES[c * 3 + 1], CANDIDATES[c * 3 + 2], salt, false, windX, windZ, CELL);
    const opacity = Math.min(1, CELL.alpha / .64);
    for (let s = 0; s < SUB_DISCS.length && count < limit; s++, count++) {
      const o = count * CLOUD_CASTER_STRIDE, along = SUB_DISCS[s] * CELL.widthM;
      out[o] = CELL.x + CLOUD_WIND_AXIS[0] * along; out[o + 1] = CELL.y; out[o + 2] = CELL.z + CLOUD_WIND_AXIS[1] * along;
      out[o + 3] = ALONG * CELL.widthM; out[o + 4] = ACROSS * CELL.widthM; out[o + 5] = opacity;
    }
  }
  return count;
}

/** Matrix maps sprite unit coordinates [-.5,+.5] into scenic pixels.
 * Alpha includes continuous distance fades; the painter adds daylight or
 * the existing storm envelope. At most121 cells per camera /242 per blend.
 * No sprites, frame buffers or history are allocated or retained here. */
export function cloudBanks({ camera, width, height, timeSec = 0, seed = 0, storm = false } = {}) {
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return [];
  const views = cameras(camera);
  if (!views.length) return [];
  const time = Number.isFinite(timeSec) ? timeSec : 0;
  const wind = [time * 10, time * 3], salt = (seed | 0) + (storm ? 1709 : 0), cells = new Map();
  for (const c of views) {
    const cx = Math.floor((c.pose.eyeM[0] - wind[0]) / CELL_M), cz = Math.floor((c.pose.eyeM[2] - wind[1]) / CELL_M);
    for (let dz = -RING; dz <= RING; dz++) for (let dx = -RING; dx <= RING; dx++) {
      const ix = cx + dx, iz = cz + dz;
      cells.set(`${ix}:${iz}`, [ix, iz]);
    }
  }
  const banks = [], placed = {};
  for (const [cell, [ix, iz]] of cells) {
    const { widthM, heightM, alpha } = cloudCell(ix, iz, salt, storm, wind[0], wind[1], placed);
    const world = [placed.x, placed.y, placed.z];
    const matrix = [0, 0, 0, 0, 0, 0];
    let weight = 0, depth = 0;
    for (const c of views) {
      const distance = Math.hypot(...sub(world, c.pose.eyeM));
      const fade = smooth((distance - 20000) / 8000) * smooth((120000 - distance) / 15000);
      if (!fade) continue;
      const projected = sprite(c, world, widthM, heightM, width, height);
      if (!projected) continue;
      const contribution = c.weight * fade;
      for (let i = 0; i < matrix.length; i++) matrix[i] += projected[i] * contribution;
      weight += contribution;
      depth += dot(sub(world, c.pose.eyeM), c.forward) * contribution;
    }
    if (!weight) continue;
    for (let i = 0; i < matrix.length; i++) matrix[i] /= weight;
    const [a, b, c, d, x, y] = matrix, ex = (Math.abs(a) + Math.abs(c)) * .5, ey = (Math.abs(b) + Math.abs(d)) * .5;
    if (x + ex < 0 || x - ex > width || y + ey < 0 || y - ey > height) continue;
    if (!matrix.every(Number.isFinite)) continue;
    banks.push({ id: `${storm ? 'storm' : 'fair'}:${cell}`, index: Math.floor(hash(ix, iz, salt + 5) * 6), shapeSeed: Math.floor(hash(ix, iz, salt + 9) * 4294967296), depth: depth / weight,
      x, y, w: Math.hypot(a, b), h: Math.hypot(c, d), matrix, world,
      alpha: weight * alpha });
  }
  return banks.sort((a, b) => b.depth - a.depth || a.id.localeCompare(b.id));
}
