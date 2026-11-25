// Positive signed distance to a generated river, in metres. Only pages near a
// channel occupy the texture. Each page shares its last row and column of
// world-space posts with its neighbours, so hardware bilinear sampling on
// either side of a page boundary gives the same bank.
import { riverIslandDistance, sampleRiverbed } from './Riverbed.js';

export const RIVER_BANK_MAX_BYTES = 8 * 1024 * 1024;
export const RIVER_BANK_MAX_TEXTURE_SIZE = 2048;
// The active beach extends farther across fine alluvium than exposed rock.
export const ROCK_SHORE_M = 6, SAND_SHORE_M = 32;


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
      segments.push({ a, b, x, z, ex: x + dx, ez: z + dz, length,
        tx: length ? dx / length : 0, tz: length ? dz / length : 0,
        radius: a.channelM, endRadius: b.channelM, widthSlope, offset });
      if (segments.length % 256 === 0) yield;
    }
  }
  return segments;
}

// Distance inside the union of overlapping variable-radius circles along
// this segment. If one end's circle contains the whole reach it alone wins.
function insideDistance(s, x, z, sample, best = -Infinity) {
  const dx = x - s.x, dz = z - s.z;
  const along = dx * s.tx + dz * s.tz, lateral = dz * s.tx - dx * s.tz, across = Math.abs(lateral);
  const at = s.widthSlope >= 1 ? s.length : s.widthSlope <= -1 ? 0
    : Math.max(0, Math.min(s.length, along + across * s.offset));
  const radial = s.length ? Math.sqrt((along - at) ** 2 + across ** 2) : Math.hypot(dx, dz);
  const outer = (s.length ? s.radius + at * s.widthSlope : Math.max(s.radius, s.endRadius)) - radial;
  // Point bars can only narrow this envelope. A losing segment cannot
  // change either the chosen shoreline or its material.
  if (outer <= best) return outer;
  if (sample && s.a.hydro && s.b.hydro) {
    sampleRiverbed(s.a, s.b, s.length ? at / s.length : 0, lateral < 0 ? -radial : radial, sample);
    return sample.signedWetDistanceM;
  }
  return outer;
}

function routedFalls(rivers, [cx, cz]) {
  const falls = [];
  for (const river of rivers) for (const f of river.falls ?? []) {
    const dx = f.footX - f.x, dz = f.footZ - f.z, length = Math.hypot(dx, dz);
    if (!(length > 0 && f.widthM > 0)) continue;
    falls.push({ x: f.x + cx, z: f.z + cz, ex: f.footX + cx, ez: f.footZ + cz,
      tx: dx / length, tz: dz / length, length, half: .5 * f.widthM });
  }
  return falls;
}

function* indexPages(segments, falls, grid, texelSizeM, rangeM, channels, coreSize) {
  const posts = coreSize + 1;
  const [ox, oz] = grid.originM, span = coreSize * texelSizeM;
  const pagesX = Math.ceil((grid.width - 1) * grid.cellSizeM / span);
  const pagesZ = Math.ceil((grid.height - 1) * grid.cellSizeM / span);
  const remaining = RIVER_BANK_MAX_BYTES - pagesX * pagesZ * 2;
  if (pagesX > RIVER_BANK_MAX_TEXTURE_SIZE || pagesZ > RIVER_BANK_MAX_TEXTURE_SIZE || remaining < channels * posts ** 2) return null;
  const maxSlots = Math.min(Math.floor(remaining / (channels * posts ** 2)),
    Math.floor(RIVER_BANK_MAX_TEXTURE_SIZE / posts) ** 2);
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
  // Only table entries near a routed lip get a second slot. Include a
  // filtering post outside the supported footprint, including at a page
  // boundary. The main channel still owns which terrain can draw water.
  const fallPages = new Set(), padM = Math.max(grid.cellSizeM, 1.5 * texelSizeM);
  for (const f of falls) {
    const reach = f.half + padM + texelSizeM;
    const left = Math.max(0, Math.floor((Math.min(f.x, f.ex) - reach - ox) / span));
    const top = Math.max(0, Math.floor((Math.min(f.z, f.ez) - reach - oz) / span));
    const right = Math.min(pagesX - 1, Math.floor((Math.max(f.x, f.ex) + reach - ox) / span));
    const bottom = Math.min(pagesZ - 1, Math.floor((Math.max(f.z, f.ez) + reach - oz) / span));
    for (let pz = top; pz <= bottom; pz++) for (let px = left; px <= right; px++) {
      const id = pz * pagesX + px;
      if (bins.has(id)) fallPages.add(id);
    }
  }
  const pageChannels = fallPages.size ? 4 : 2, slots = bins.size + fallPages.size;
  const pageColumns = Math.max(1, Math.ceil(Math.sqrt(slots)));
  const width = pageColumns * posts, height = Math.max(1, Math.ceil(slots / pageColumns)) * posts;
  if (width > RIVER_BANK_MAX_TEXTURE_SIZE || height > RIVER_BANK_MAX_TEXTURE_SIZE
    || width * height * channels + pagesX * pagesZ * pageChannels > RIVER_BANK_MAX_BYTES) return null;
  return { bins, fallPages, padM, pageChannels, pagesX, pagesZ, pageColumns, width, height };
}

const clamp01 = x => Math.max(0, Math.min(1, x));
const smooth = x => { const t = clamp01(x); return t * t * (3 - 2 * t); };

/** The transverse coordinate extends across the whole slot, including
 * dry posts. The weight alone gates falling water. A neighboring dry post
 * must still interpolate the same axis through the lip or bank. */
function writeFallPage(data, start, width, originM, ix, iz, coreSize, step, pad, falls) {
  const span = coreSize * step, halfDiagonal = span * Math.SQRT1_2;
  const cx = originM[0] + (ix + coreSize / 2) * step, cz = originM[1] + (iz + coreSize / 2) * step;
  const distances = falls.map(f => {
    const dx = cx - f.x, dz = cz - f.z, along = Math.max(0, Math.min(f.length, dx * f.tx + dz * f.tz));
    return Math.hypot(dx - along * f.tx, dz - along * f.tz);
  });
  let closest = Infinity;
  for (const distance of distances) closest = Math.min(closest, distance);
  // Distances to a segment change by at most one metre per metre. This
  // keeps every segment that could be globally nearest at any post, plus
  // every active sheet that could reach it. Shared posts therefore get
  // identical bytes even where two waterfalls occupy neighboring pages.
  const candidates = falls.filter((f, i) => distances[i] <= halfDiagonal +
    Math.max(closest + halfDiagonal, Math.hypot(f.half + .5 * step, pad)));
  for (let j = 0; j <= coreSize; j++) {
    const z = originM[1] + (iz + j) * step;
    for (let i = 0; i <= coreSize; i++) {
      const x = originM[0] + (ix + i) * step;
      let best = Infinity, weight = -1, side = 0, progress = 0;
      for (const f of candidates) {
        const dx = x - f.x, dz = z - f.z, along = dx * f.tx + dz * f.tz;
        const across = dz * f.tx - dx * f.tz;
        const outside = Math.max(-along, along - f.length, 0);
        const strength = smooth(1 - outside / pad)
          * smooth((f.half + .5 * step - Math.abs(across)) / Math.min(f.half, step * 1.5));
        const d2 = across * across + outside * outside;
        if (strength > weight || strength === weight && d2 < best) {
          weight = strength; best = d2; side = across; progress = clamp01(along / f.length);
        }
      }
      const pixel = (start + j * width + i) * 4;
      const q = Math.max(0, Math.min(65535, 32768 + Math.round(side * 8)));
      data[pixel] = q & 255; data[pixel + 1] = q >> 8;
      data[pixel + 2] = Math.round(255 * weight); data[pixel + 3] = Math.round(255 * progress);
    }
  }
}

/** Bake the complete world-space courses. isDryGround receives stage XZ: a
 * measured massif standing above the local floor owns that post. The caller
 * can finish synchronously or yield to the browser between generator steps. */
export function* bakeRiverBankAtlasSteps(rivers, grid, centre = [0, 0], isDryGround) {
  const segments = yield* routedSegments(rivers, centre);
  if (!segments.length) return null;
  const channels = segments.some(s => s.a.hydro && s.b.hydro) ? 4 : 1;
  const falls = channels === 4 ? routedFalls(rivers, centre) : [];
  // Smaller pages reduce dry padding around narrow channels in the
  // four-lane format. Keep the older one-lane page layout unchanged.
  const coreSize = channels === 4 ? 16 : 32, posts = coreSize + 1;
  let texelSizeM = 10, layout;
  for (;;) {
    layout = yield* indexPages(segments, falls, grid, texelSizeM, 2 * texelSizeM, channels, coreSize);
    if (layout) break;
    // Keep narrow tributaries resolved within the device budget, including
    // unusually dense or large regions. Most songs fit at the first spacing.
    texelSizeM = texelSizeM < 20 ? Math.min(20, texelSizeM * 1.25) : texelSizeM * 1.25;
  }
  const { bins, fallPages, padM, pageChannels, width, height, pagesX, pagesZ, pageColumns } = layout;
  if (!bins.size) return null;
  const rangeM = 2 * texelSizeM, originM = [...grid.originM];
  const islandPages = new Map(), span = coreSize * texelSizeM;
  for (const river of rivers) for (const island of river.islands ?? []) {
    const reach = Math.max(island.halfLengthM, island.halfWidthM) + rangeM;
    const x = island.x + centre[0] - originM[0], z = island.z + centre[1] - originM[1];
    for (let pz = Math.max(0, Math.floor((z - reach) / span)); pz <= Math.min(pagesZ - 1, Math.floor((z + reach) / span)); pz++) {
      for (let px = Math.max(0, Math.floor((x - reach) / span)); px <= Math.min(pagesX - 1, Math.floor((x + reach) / span)); px++) {
        const key = pz * pagesX + px;
        if (!bins.has(key)) continue;
        if (!islandPages.has(key)) islandPages.set(key, []);
        islandPages.get(key).push(island);
      }
    }
  }
  const pageTable = new Uint8Array(pagesX * pagesZ * pageChannels);
  const data = new Uint8Array(width * height * channels);
  // Unallocated posts are dry. Reserve zero substrate for untouched ground.
  for (let i = 0; i < data.length; i += channels) data[i] = 1;
  const winners = new Float64Array(posts ** 2), sample = {};
  let slot = 0;
  for (const [id, bin] of bins) {
    const ix = id % pagesX * coreSize, iz = Math.floor(id / pagesX) * coreSize;
    const start = Math.floor(slot / pageColumns) * posts * width + slot % pageColumns * posts;
    const entry = ++slot;
    pageTable[pageChannels * id] = entry & 255;
    pageTable[pageChannels * id + 1] = entry >> 8;
    winners.fill(-rangeM);
    for (const s of bin) {
      const reach = Math.max(s.radius, s.endRadius) + rangeM;
      const left = Math.max(0, Math.ceil((Math.min(s.x, s.ex) - reach - originM[0]) / texelSizeM) - ix);
      const right = Math.min(coreSize, Math.floor((Math.max(s.x, s.ex) + reach - originM[0]) / texelSizeM) - ix);
      const top = Math.max(0, Math.ceil((Math.min(s.z, s.ez) - reach - originM[1]) / texelSizeM) - iz);
      const bottom = Math.min(coreSize, Math.floor((Math.max(s.z, s.ez) + reach - originM[1]) / texelSizeM) - iz);
      for (let j = top; j <= bottom; j++) {
        const z = originM[1] + (iz + j) * texelSizeM, row = start + j * width;
        for (let i = left; i <= right; i++) {
          const x = originM[0] + (ix + i) * texelSizeM;
          const pixel = (row + i) * channels, local = j * posts + i;
          const d = insideDistance(s, x, z, channels === 4 ? sample : null, winners[local]);
          if (d <= winners[local]) continue;
          winners[local] = d;
          data[pixel] = 128 + Math.round(127 * Math.min(1, d / rangeM));
          if (channels === 4 && s.a.hydro && s.b.hydro) {
            // Sand, gravel and rock lie on one grain/cohesion scale. Depth
            // uses a square-root encoding to retain shallow pool gradients.
            data[pixel + 1] = 1 + Math.round(127 * (1 + sample.rock - sample.sand));
            data[pixel + 2] = Math.round(255 * Math.sqrt(Math.min(1, Math.max(0, sample.depthM) / 16)));
            data[pixel + 3] = Math.round(255 * sample.foam);
          } else if (channels === 4) data.fill(0, pixel + 1, pixel + 4);
        }
      }
    }
    // Subtract islands from the complete channel union, including where a
    // second reach enters the same pool. All tests are regional coordinates.
    for (const island of islandPages.get(id) ?? []) {
      const reach = Math.max(island.halfLengthM, island.halfWidthM) + rangeM;
      const left = Math.max(0, Math.ceil((island.x + centre[0] - reach - originM[0]) / texelSizeM) - ix);
      const right = Math.min(coreSize, Math.floor((island.x + centre[0] + reach - originM[0]) / texelSizeM) - ix);
      const top = Math.max(0, Math.ceil((island.z + centre[1] - reach - originM[1]) / texelSizeM) - iz);
      const bottom = Math.min(coreSize, Math.floor((island.z + centre[1] + reach - originM[1]) / texelSizeM) - iz);
      for (let j = top; j <= bottom; j++) for (let i = left; i <= right; i++) {
        const x = originM[0] + (ix + i) * texelSizeM - centre[0], z = originM[1] + (iz + j) * texelSizeM - centre[1];
        const d = -riverIslandDistance(island, x, z), pixel = (start + j * width + i) * channels;
        const local = j * posts + i;
        if (d >= winners[local]) continue;
        winners[local] = d;
        const encoded = 128 + Math.round(127 * Math.max(-1, Math.min(1, d / rangeM)));
        data[pixel] = Math.min(data[pixel], encoded);
        if (channels === 4) {
          const shore = Math.max(0, Math.min(1, d / texelSizeM));
          if (d <= 0) data[pixel + 1] = 1 + Math.round(127 * (1 + island.rock - island.sand));
          data[pixel + 2] = Math.round(data[pixel + 2] * Math.sqrt(shore));
          data[pixel + 3] = Math.round(data[pixel + 3] * shore);
        }
      }
    }
    if (isDryGround) for (let j = 0; j <= coreSize; j++) {
      const z = originM[1] + (iz + j) * texelSizeM, row = start + j * width;
      for (let i = 0; i <= coreSize; i++) {
        const pixel = (row + i) * channels;
        if (data[pixel] > 1 && isDryGround(originM[0] + (ix + i) * texelSizeM, z)) {
          data.fill(0, pixel, pixel + channels); data[pixel] = 1;
        }
      }
    }
    yield;
  }
  for (const id of fallPages) {
    const ix = id % pagesX * coreSize, iz = Math.floor(id / pagesX) * coreSize;
    const start = Math.floor(slot / pageColumns) * posts * width + slot % pageColumns * posts;
    const entry = ++slot, key = pageChannels * id;
    pageTable[key + 2] = entry & 255; pageTable[key + 3] = entry >> 8;
    writeFallPage(data, start, width, originM, ix, iz, coreSize, texelSizeM, padM, falls);
    yield;
  }
  return { version: channels === 4 ? 2 : 1, ...(fallPages.size ? { pageChannels } : {}),
    data, width, height, pageTable, pagesX, pagesZ, pageColumns, coreSize, texelSizeM, rangeM, originM };
}

/** Signed metres at stage XZ using exactly the shader's bilinear texel and
 * page lookup. Absent pages are dry. */
export function riverBankDistanceAt(atlas, x, z, material) {
  if (material) material.grain = 0;
  const { coreSize, texelSizeM, rangeM, originM, pagesX, pagesZ, pageColumns, pageTable, width, data } = atlas;
  const gx = (x - originM[0]) / texelSizeM, gz = (z - originM[1]) / texelSizeM;
  const px = Math.floor(gx / coreSize), pz = Math.floor(gz / coreSize);
  if (px < 0 || pz < 0 || px >= pagesX || pz >= pagesZ) return -rangeM;
  const key = (pz * pagesX + px) * (atlas.pageChannels ?? 2), slot = pageTable[key] + 256 * pageTable[key + 1] - 1;
  if (slot < 0) return -rangeM;
  const posts = coreSize + 1, lx = gx - px * coreSize, lz = gz - pz * coreSize;
  const i = Math.floor(lx), j = Math.floor(lz), fx = lx - i, fz = lz - j;
  const channels = atlas.version === 2 ? 4 : 1, row = width * channels;
  const k = ((Math.floor(slot / pageColumns) * posts + j) * width + slot % pageColumns * posts + i) * channels;
  const top = data[k] + (data[k + channels] - data[k]) * fx;
  const bottom = data[k + row] + (data[k + row + channels] - data[k + row]) * fx;
  if (material && channels === 4) {
    const a = data[k + 1] + (data[k + channels + 1] - data[k + 1]) * fx;
    const b = data[k + row + 1] + (data[k + row + channels + 1] - data[k + row + 1]) * fx;
    material.grain = Math.max(-1, (a + (b - a) * fz - 128) / 127);
  }
  return (top + (bottom - top) * fz - 128) * rangeM / 127;
}
