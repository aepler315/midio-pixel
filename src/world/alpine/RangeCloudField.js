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

/** Matrix maps sprite unit coordinates [-.5,+.5] into scenic pixels.
 * Alpha includes continuous distance fades; the painter adds daylight or
 * the existing storm envelope. At most121 cells per camera /242 per blend.
 * No sprites, frame buffers or history are allocated or retained here. */
export function cloudBanks({ camera, width, height, timeSec = 0, seed = 0, storm = false, reducedMotion = false } = {}) {
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return [];
  const views = cameras(camera);
  if (!views.length) return [];
  const time = reducedMotion || !Number.isFinite(timeSec) ? 0 : timeSec;
  const wind = [time * 10, time * 3], salt = (seed | 0) + (storm ? 1709 : 0), cells = new Map();
  for (const c of views) {
    const cx = Math.floor((c.pose.eyeM[0] - wind[0]) / CELL_M), cz = Math.floor((c.pose.eyeM[2] - wind[1]) / CELL_M);
    for (let dz = -RING; dz <= RING; dz++) for (let dx = -RING; dx <= RING; dx++) {
      const ix = cx + dx, iz = cz + dz;
      cells.set(`${ix}:${iz}`, [ix, iz]);
    }
  }
  const banks = [];
  for (const [cell, [ix, iz]] of cells) {
    const widthM = (storm ? 10000 : 6000) + hash(ix, iz, salt + 4) * (storm ? 12000 : 8000);
    const heightM = widthM * 128 / 192;
    // Altitude describes the full card's base, not its centre. Even the
    // tallest storm bank remains above the peaks before density masking.
    const world = [(ix + .3 + hash(ix, iz, salt + 1) * .4) * CELL_M + wind[0],
      (storm ? 4500 : 5500) + hash(ix, iz, salt + 2) * 2000 + heightM * .5,
      (iz + .3 + hash(ix, iz, salt + 3) * .4) * CELL_M + wind[1]];
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
    banks.push({ id: `${storm ? 'storm' : 'fair'}:${cell}`, index: Math.floor(hash(ix, iz, salt + 5) * 6), depth: depth / weight,
      x, y, w: Math.hypot(a, b), h: Math.hypot(c, d), matrix, world,
      alpha: weight * ((storm ? .75 : .32) + hash(ix, iz, salt + 6) * (storm ? .25 : .32)) });
  }
  return banks.sort((a, b) => b.depth - a.depth || a.id.localeCompare(b.id));
}
