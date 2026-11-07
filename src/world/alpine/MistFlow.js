// A small, static geography field for mist that forms low and moves upstream.
// R: source-ground elevation normalized over heightRange; G: low-source-
// connected valley affinity; B: distance upstream / distanceM; A: valid ground.
// All four channels interpolate in one RGBA8 texture tap. The CPU reads the
// same packed bytes, including their quantization and sample-centre mapping.
import { terrainHeightAt } from './TerrainMesh.js';
import { buildTerrainHierarchy, buildTerrainHierarchyAsync, CHANNEL_AREA_M2 } from './TerrainHierarchy.js';
import { finishPreparation, prepareInSlices } from './PreparationSteps.js';

export const MIST_FLOW_MAX_SAMPLES = 96;
const unit = v => Math.max(0, Math.min(1, v));
const smooth = (a, b, v) => { const t = unit((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const byte = v => Math.round(unit(v) * 255);

/** Match the source grid's first and last sample centres. A shared fixed
 * maximum keeps the flow geography independent of the frame's quality rung. */
function* latticeSteps(data, { maxSamples = MIST_FLOW_MAX_SAMPLES } = {}) {
  const g = data.grid;
  if (!g || !(g.width > 1 && g.height > 1 && g.cellSizeM > 0)
    || !g.originM?.every(Number.isFinite)) throw new Error('Mist flow needs a finite terrain grid');
  const spanX = (g.width - 1) * g.cellSizeM, spanZ = (g.height - 1) * g.cellSizeM;
  const cap = Math.max(2, Math.min(MIST_FLOW_MAX_SAMPLES, Math.floor(Number.isFinite(maxSamples) ? maxSamples : MIST_FLOW_MAX_SAMPLES)));
  const cellM = Math.max(g.cellSizeM, Math.max(spanX, spanZ) / (cap - 1));
  const width = Math.max(2, Math.min(cap, Math.round(spanX / cellM) + 1));
  const height = Math.max(2, Math.min(cap, Math.round(spanZ / cellM) + 1));
  const heights = new Float32Array(width * height);
  for (let z = 0; z < height; z++) {
    const zm = g.originM[1] + spanZ * z / (height - 1);
    for (let x = 0; x < width; x++) heights[z * width + x] = terrainHeightAt(data, g.originM[0] + spanX * x / (width - 1), zm);
    yield;
  }
  return { width, height, heights, cellXM: spanX / (width - 1), cellZM: spanZ / (height - 1),
    originM: [...g.originM], extentM: [spanX, spanZ] };
}

// Coarse cells can be larger than the original fixed channel area. Requiring
// 32 contributing cells preserves valleys instead of marking every
// highland cell as a channel and resetting all HAND values to zero.
function hierarchyOptions(lattice) {
  return { channelAreaM2: Math.max(CHANNEL_AREA_M2, 32 * lattice.cellXM * lattice.cellZM) };
}

function* fieldSteps(lattice, hierarchy) {
  const { width, height, heights, originM, extentM } = lattice;
  const N = width * height, { down, hand, distM, drainOrder } = hierarchy.fields;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < N; i++) if (Number.isFinite(heights[i])) {
    min = Math.min(min, heights[i]); max = Math.max(max, heights[i]);
  }
  if (!Number.isFinite(min)) { min = 0; max = 1; }
  // Even a flat field has a finite elevation decode and a non-zero scale.
  const heightRange = [min, Math.max(min + 1, max)];
  const span = heightRange[1] - min;
  // Only outlets in the lower part of the range feed mist. High crop edges
  // and high islands next to no-data are not independent mist generators.
  const sourceCeilingM = min + Math.max(12, Math.min(180, (max - min) * .18));
  const roots = new Int32Array(N).fill(-1);
  let affinity = new Float32Array(N);
  const ridgeGuard = new Float32Array(N);
  let distanceM = 1, sources = 0, valleyCells = 0;
  const radiusX = Math.max(2, Math.min(6, Math.ceil(300 / lattice.cellXM)));
  const radiusZ = Math.max(2, Math.min(6, Math.ceil(300 / lattice.cellZM)));
  const localHand = i => {
    let h = hand[i];
    if (h <= 35) return h;
    const x = i % width, z = (i - x) / width;
    // A wide, flat valley floor can have several parallel drainage rows.
    // Some collect too little area to become channels; their raw HAND then
    // incorrectly includes the whole climb from the outlet. Share a nearby
    // channel floor across a bounded lateral neighborhood, after projecting
    // its slope along the channel back to the query. Otherwise a channel
    // farther uphill can lend its higher elevation across a dividing ridge.
    for (let dz = -radiusZ; dz <= radiusZ; dz++) {
      const zz = z + dz;
      if (zz < 0 || zz >= height) continue;
      for (let dx = -radiusX; dx <= radiusX; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        const n = zz * width + xx;
        if (!drainOrder[n] || roots[n] < 0 || heights[roots[n]] > sourceCeilingM) continue;
        const d = down[n];
        if (d < 0) continue;
        const alongX = (xx - d % width) * lattice.cellXM;
        const alongZ = (zz - Math.floor(d / width)) * lattice.cellZM;
        const length2 = alongX * alongX + alongZ * alongZ;
        const along = (-dx * lattice.cellXM * alongX - dz * lattice.cellZM * alongZ) / length2;
        const floorM = heights[n] + along * Math.max(0, heights[n] - heights[d]);
        if (floorM > heights[i] + 35) continue;
        h = Math.min(h, Math.max(0, heights[i] - floorM));
      }
    }
    return h;
  };
  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(heights[i]) || roots[i] >= 0) continue;
    let j = i;
    while (roots[j] < 0 && down[j] >= 0) j = down[j];
    const root = roots[j] >= 0 ? roots[j] : j;
    roots[j] = root;
    j = i;
    while (roots[j] < 0) { roots[j] = root; j = down[j]; }
    if ((i & 255) === 255) yield;
  }
  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(heights[i])) continue;
    if (down[i] < 0 && heights[i] <= sourceCeilingM) sources++;
    if (heights[roots[i]] <= sourceCeilingM) {
      // A broad shoulder lets banks spread over the valley sides. HAND
      // confines them beneath the ridges even far upstream of the source.
      const handM = localHand(i);
      affinity[i] = 1 - smooth(35, 170, handM);
      ridgeGuard[i] = 1 - smooth(70, 170, handM);
      if (affinity[i] > 0) { distanceM = Math.max(distanceM, distM[i]); valleyCells++; }
    }
    if ((i & 1023) === 1023) yield;
  }
  // Root catchments and coarse drainage can leave angular bank edges. Two
  // small tent passes soften their boundary inside the connected valley.
  // The original terrain-derived guard pins ridges, holes and disconnected
  // high catchments to zero; neighboring zero cells feather the inside edge.
  for (let pass = 0; pass < 2; pass++) {
    const filtered = new Float32Array(N);
    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        const i = z * width + x;
        if (!(ridgeGuard[i] > 0)) continue;
        let sum = 0, weights = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= width || zz >= height) continue;
          const n = zz * width + xx;
          const tent = (dx === 0 ? 2 : 1) * (dz === 0 ? 2 : 1);
          const w = Number.isFinite(heights[n]) ? tent * (1 - smooth(100, 250, Math.abs(heights[i] - heights[n]))) : tent;
          sum += affinity[n] * w; weights += w;
        }
        filtered[i] = Math.min(ridgeGuard[i], weights > 0 ? sum / weights : 0);
      }
      yield;
    }
    affinity = filtered;
  }
  const texture = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const o = i * 4, valid = Number.isFinite(heights[i]);
    texture[o] = valid ? byte((heights[i] - min) / span) : 0;
    texture[o + 1] = byte(affinity[i]);
    texture[o + 2] = valid ? byte(distM[i] / distanceM) : 0;
    texture[o + 3] = valid ? 255 : 0;
    if ((i & 1023) === 1023) yield;
  }
  return { width, height, texture, originM, extentM, heightRange, distanceM,
    stats: { sourceCeilingM, sources, valleyCells, cellXM: lattice.cellXM, cellZM: lattice.cellZM } };
}

export function buildMistFlow(data, options = {}) {
  const lattice = finishPreparation(latticeSteps(data, options));
  const hierarchy = buildTerrainHierarchy(lattice, hierarchyOptions(lattice));
  return finishPreparation(fieldSteps(lattice, hierarchy));
}

/** The live path yields between bounded rows/packing blocks and inside the
 * existing hydrology builder. Pauses/seeks never rebuild or integrate it. */
export async function buildMistFlowAsync(data, options = {}) {
  const lattice = await prepareInSlices(latticeSteps(data, options), options);
  const hierarchy = await buildTerrainHierarchyAsync(lattice, { ...hierarchyOptions(lattice), ...options });
  return prepareInSlices(fieldSteps(lattice, hierarchy), options);
}

const outside = () => ({ groundM: 0, valley01: 0, upstreamM: 0, valid01: 0 });
/** Linear GL sampling uses uv*(size-1)/size + .5/size. This is its exact
 * byte-space twin, with explicit no-field/outside handling before clamping. */
export function sampleMistFlow(field, x, z) {
  if (!field || !Number.isFinite(x) || !Number.isFinite(z)) return outside();
  const { width: W, height: H, originM, extentM, texture } = field;
  const u = (x - originM[0]) / extentM[0], v = (z - originM[1]) / extentM[1];
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return outside();
  const fx = u * (W - 1), fz = v * (H - 1);
  const ix = Math.min(W - 2, Math.floor(fx)), iz = Math.min(H - 2, Math.floor(fz));
  const tx = fx - ix, tz = fz - iz;
  const at = (dx, dz, c) => texture[((iz + dz) * W + ix + dx) * 4 + c];
  const read = c => (at(0, 0, c) * (1 - tx) * (1 - tz) + at(1, 0, c) * tx * (1 - tz)
    + at(0, 1, c) * (1 - tx) * tz + at(1, 1, c) * tx * tz) / 255;
  return { groundM: field.heightRange[0] + read(0) * (field.heightRange[1] - field.heightRange[0]),
    valley01: read(1), upstreamM: read(2) * field.distanceM, valid01: read(3) };
}

/** Keep the packed CPU lane for emitter queries; charge it and the GPU lane.
 * The upload has no mips, color conversion, or vertical flip. */
export function createMistFlowTexture(THREE, field) {
  const texture = new THREE.DataTexture(field.texture, field.width, field.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return { texture, field, bytes: field.texture.byteLength * 2 };
}
