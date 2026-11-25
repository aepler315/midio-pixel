// Positive signed distance to a generated river, in metres. Only pages near a
// channel occupy the texture. Each page shares its last row and column of
// world-space posts with its neighbours, so hardware bilinear sampling on
// either side of a page boundary gives the same bank.
export const RIVER_BANK_MAX_BYTES = 8 * 1024 * 1024;
export const RIVER_BANK_MAX_TEXTURE_SIZE = 2048;
const CORE_SIZE = 32;
const PAGE_POSTS = CORE_SIZE + 1;

function* routedSegments(rivers, [cx, cz]) {
  const segments = [];
  for (const { points } of rivers) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const x = a.x + cx, z = a.z + cz, dx = b.x - a.x, dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      const widthSlope = length ? (b.channelM - a.channelM) / length : 0;
      // The envelope of circles with linearly varying radius. For a point
      // beside the reach, its nearest bank can be slightly downstream of
      // the perpendicular projection if the channel widens there.
      const offset = Math.abs(widthSlope) < 1 ? widthSlope / Math.sqrt(1 - widthSlope ** 2) : 0;
      segments.push({ x, z, ex: x + dx, ez: z + dz, length,
        tx: length ? dx / length : 0, tz: length ? dz / length : 0,
        radius: a.channelM, endRadius: b.channelM, widthSlope, offset });
      if (segments.length % 256 === 0) yield;
    }
  }
  return segments;
}

// Distance inside the union of overlapping variable-radius circles along
// this segment. If one end's circle contains the whole reach it alone wins.
function insideDistance(s, x, z) {
  const dx = x - s.x, dz = z - s.z;
  if (!s.length) return Math.max(s.radius, s.endRadius) - Math.hypot(dx, dz);
  const along = dx * s.tx + dz * s.tz, across = Math.abs(dz * s.tx - dx * s.tz);
  const at = s.widthSlope >= 1 ? s.length : s.widthSlope <= -1 ? 0
    : Math.max(0, Math.min(s.length, along + across * s.offset));
  return s.radius + at * s.widthSlope - Math.sqrt((along - at) ** 2 + across ** 2);
}

function* indexPages(segments, grid, texelSizeM, rangeM) {
  const [ox, oz] = grid.originM, span = CORE_SIZE * texelSizeM;
  const pagesX = Math.ceil((grid.width - 1) * grid.cellSizeM / span);
  const pagesZ = Math.ceil((grid.height - 1) * grid.cellSizeM / span);
  const remaining = RIVER_BANK_MAX_BYTES - pagesX * pagesZ * 2;
  if (pagesX > RIVER_BANK_MAX_TEXTURE_SIZE || pagesZ > RIVER_BANK_MAX_TEXTURE_SIZE || remaining < PAGE_POSTS ** 2) return null;
  const maxSlots = Math.min(Math.floor(remaining / PAGE_POSTS ** 2),
    Math.floor(RIVER_BANK_MAX_TEXTURE_SIZE / PAGE_POSTS) ** 2);
  const bins = new Map();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i], reach = Math.max(s.radius, s.endRadius) + rangeM;
    const left = Math.max(0, Math.floor((Math.min(s.x, s.ex) - reach - ox) / span));
    const right = Math.min(pagesX - 1, Math.floor((Math.max(s.x, s.ex) + reach - ox) / span));
    const top = Math.max(0, Math.floor((Math.min(s.z, s.ez) - reach - oz) / span));
    const bottom = Math.min(pagesZ - 1, Math.floor((Math.max(s.z, s.ez) + reach - oz) / span));
    for (let pz = top; pz <= bottom; pz++) for (let px = left; px <= right; px++) {
      // The distance field is 1-Lipschitz: if the centre lies farther than
      // a half diagonal outside the influence band, the entire page is dry.
      if (insideDistance(s, ox + (px + .5) * span, oz + (pz + .5) * span) < -rangeM - span * Math.SQRT1_2) continue;
      const id = pz * pagesX + px;
      let bin = bins.get(id);
      if (!bin) { bin = []; bins.set(id, bin); }
      bin.push(s);
    }
    if (bins.size > maxSlots) return null;
    if (i % 128 === 127) yield;
  }
  const pageColumns = Math.max(1, Math.ceil(Math.sqrt(bins.size)));
  const width = pageColumns * PAGE_POSTS, height = Math.max(1, Math.ceil(bins.size / pageColumns)) * PAGE_POSTS;
  if (width * height > remaining) return null;
  return { bins, pagesX, pagesZ, pageColumns, width, height };
}

/** Bake the complete world-space courses. isDryGround receives stage XZ: a
 * measured massif standing above the local floor owns that post. The caller
 * can finish synchronously or yield to the browser between generator steps. */
export function* bakeRiverBankAtlasSteps(rivers, grid, centre = [0, 0], isDryGround) {
  const segments = yield* routedSegments(rivers, centre);
  if (!segments.length) return null;
  let texelSizeM = 10, layout;
  for (;;) {
    layout = yield* indexPages(segments, grid, texelSizeM, 2 * texelSizeM);
    if (layout) break;
    // Keep narrow tributaries resolved within the device budget, including
    // unusually dense or large regions. Most songs fit at the first spacing.
    texelSizeM = texelSizeM < 20 ? Math.min(20, texelSizeM * 1.25) : texelSizeM * 1.25;
  }
  const { bins, width, height, pagesX, pagesZ, pageColumns } = layout;
  if (!bins.size) return null;
  const rangeM = 2 * texelSizeM, originM = [...grid.originM];
  const pageTable = new Uint8Array(pagesX * pagesZ * 2);
  const data = new Uint8Array(width * height).fill(1);
  let slot = 0;
  for (const [id, bin] of bins) {
    const ix = id % pagesX * CORE_SIZE, iz = Math.floor(id / pagesX) * CORE_SIZE;
    const start = Math.floor(slot / pageColumns) * PAGE_POSTS * width + slot % pageColumns * PAGE_POSTS;
    const entry = ++slot;
    pageTable[2 * id] = entry & 255;
    pageTable[2 * id + 1] = entry >> 8;
    for (const s of bin) {
      const reach = Math.max(s.radius, s.endRadius) + rangeM;
      const left = Math.max(0, Math.ceil((Math.min(s.x, s.ex) - reach - originM[0]) / texelSizeM) - ix);
      const right = Math.min(CORE_SIZE, Math.floor((Math.max(s.x, s.ex) + reach - originM[0]) / texelSizeM) - ix);
      const top = Math.max(0, Math.ceil((Math.min(s.z, s.ez) - reach - originM[1]) / texelSizeM) - iz);
      const bottom = Math.min(CORE_SIZE, Math.floor((Math.max(s.z, s.ez) + reach - originM[1]) / texelSizeM) - iz);
      for (let j = top; j <= bottom; j++) {
        const z = originM[1] + (iz + j) * texelSizeM, row = start + j * width;
        for (let i = left; i <= right; i++) {
          if (data[row + i] === 255) continue;
          const x = originM[0] + (ix + i) * texelSizeM;
          const encoded = 128 + Math.round(127 * Math.min(1, insideDistance(s, x, z) / rangeM));
          if (encoded > data[row + i]) data[row + i] = encoded;
        }
      }
    }
    if (isDryGround) for (let j = 0; j <= CORE_SIZE; j++) {
      const z = originM[1] + (iz + j) * texelSizeM, row = start + j * width;
      for (let i = 0; i <= CORE_SIZE; i++)
        if (data[row + i] > 1 && isDryGround(originM[0] + (ix + i) * texelSizeM, z)) data[row + i] = 1;
    }
    yield;
  }
  return { data, width, height, pageTable, pagesX, pagesZ, pageColumns, coreSize: CORE_SIZE, texelSizeM, rangeM, originM };
}

/** Signed metres at stage XZ using exactly the shader's bilinear texel and
 * page lookup. Absent pages are dry. */
export function riverBankDistanceAt(atlas, x, z) {
  const { coreSize, texelSizeM, rangeM, originM, pagesX, pagesZ, pageColumns, pageTable, width, data } = atlas;
  const gx = (x - originM[0]) / texelSizeM, gz = (z - originM[1]) / texelSizeM;
  const px = Math.floor(gx / coreSize), pz = Math.floor(gz / coreSize);
  if (px < 0 || pz < 0 || px >= pagesX || pz >= pagesZ) return -rangeM;
  const key = (pz * pagesX + px) * 2, slot = pageTable[key] + 256 * pageTable[key + 1] - 1;
  if (slot < 0) return -rangeM;
  const posts = coreSize + 1, lx = gx - px * coreSize, lz = gz - pz * coreSize;
  const i = Math.floor(lx), j = Math.floor(lz), fx = lx - i, fz = lz - j;
  const k = (Math.floor(slot / pageColumns) * posts + j) * width + slot % pageColumns * posts + i;
  const top = data[k] + (data[k + 1] - data[k]) * fx;
  const bottom = data[k + width] + (data[k + width + 1] - data[k + width]) * fx;
  return (top + (bottom - top) * fz - 128) * rangeM / 127;
}
