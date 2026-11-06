// Bake the shipped White Mountains heightfield into a local timed voxel mesh.
// Usage: node tools/build-voxel-range.mjs
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { decodeTerrain, terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';
import { createVoxelRangeScore } from '../src/world/alpine/VoxelRangeScore.js';
import { projectPoint } from '../src/world/terrain/SceneTravel.js';
import { railGroundData } from '../src/world/alpine/RailDraw.js';
import catalog from '../src/world/terrain/sceneCatalogData.js';

const VIEW_ID = 'white-mountains-owens';
const CELL_M = 500;
const HEIGHT_STEP_M = 100;
const ALWAYS = 2;
const VERTEX_FIELDS = 8;
const TRIANGLE_CORNERS = [0, 1, 2, 0, 2, 3];
const FOOTHILL_RGB = [0.62, 0.47, 0.31];
const SUMMIT_RGB = [0.76, 0.77, 0.80];
const PACK_MAGIC = 0x32525856;
const LEVELS = [
  { cellSizeM: 500, startProgress: 0, endProgress: 0 },
  { cellSizeM: 250, startProgress: .14, endProgress: .23 },
  { cellSizeM: 125, startProgress: .34, endProgress: .44 },
  { cellSizeM: 62.5, startProgress: .56, endProgress: .68 },
];
const columnKey = (x, z) => `${x},${z}`;

// Top corners wind outward along each of the four sides.
const SIDES = [
  { dx: -1, dz: 0, corners: [0, 1], light: .86 },
  { dx: 0, dz: 1, corners: [1, 2], light: .78 },
  { dx: 1, dz: 0, corners: [2, 3], light: .61 },
  { dx: 0, dz: -1, corners: [3, 0], light: .68 },
];

function bakeColumnLevel(data, camera, { cellSizeM = CELL_M, heightStepM = HEIGHT_STEP_M, revealOrder = null } = {}) {
  const { eyeM } = camera;
  const { originM: [originX, originZ], width, height, cellSizeM: sourceStep } = data.grid;
  const maxX = originX + (width - 1) * sourceStep;
  const maxZ = originZ + (height - 1) * sourceStep;
  const columns = new Map();

  for (let z = Math.floor(originZ / cellSizeM) * cellSizeM; z + cellSizeM / 2 <= maxZ; z += cellSizeM) {
    for (let x = Math.floor(originX / cellSizeM) * cellSizeM; x + cellSizeM / 2 <= maxX; x += cellSizeM) {
      const cx = x + cellSizeM / 2, cz = z + cellSizeM / 2;
      const elevation = terrainHeightAt(data, cx, cz);
      if (!Number.isFinite(elevation)) continue;
      const y = Math.round(elevation / heightStepM) * heightStepM;
      const distance = Math.hypot(cx - eyeM[0], cz - eyeM[2]);
      columns.set(columnKey(x, z), { x, y, z, distance });
    }
  }

  const byElevation = [...columns.values()].sort((a, b) => a.y - b.y || a.distance - b.distance || a.z - b.z || a.x - b.x);
  if (!byElevation.length) throw new Error('Voxel range has no valid height samples');
  const baseY = byElevation[0].y - heightStepM;
  const relief = byElevation.at(-1).y - baseY;
  const openingProgress = createVoxelRangeScore().progressAt(0);
  const openingCount = Math.floor(openingProgress * (columns.size - 1)) + 1;
  // Start with the lowest framed foothills, leaving headroom for the ridges.
  // Keep the altitude and distance order of every column outside this patch.
  const opening = new Set(byElevation.filter(({ x, y, z }) => {
    const p = projectPoint(camera, 16 / 9, [x + cellSizeM / 2, y, z + cellSizeM / 2]);
    return p?.depth >= 1500 && Math.abs(p.x) <= .76 && p.y >= -.90 && p.y <= -.04;
  }).slice(0, openingCount));
  const ordered = [...opening, ...byElevation.filter(column => !opening.has(column))];
  ordered.forEach((column, i) => {
    const parent = revealOrder?.get(columnKey(Math.floor((column.x + cellSizeM / 2) / CELL_M) * CELL_M,
      Math.floor((column.z + cellSizeM / 2) / CELL_M) * CELL_M));
    column.show = parent?.show ?? i / Math.max(1, ordered.length - 1);
  });

  const values = [];
  function emitFace(corners, y0, y1, rgb, light, show, hide) {
    for (const i of TRIANGLE_CORNERS) {
      const [x, z] = corners[i];
      values.push(x, i < 2 ? y0 : y1, z, rgb[0] * light, rgb[1] * light, rgb[2] * light, show, hide);
    }
  }

  for (const { x, y, z, show } of ordered) {
    const top = [[x, z], [x, z + cellSizeM], [x + cellSizeM, z + cellSizeM], [x + cellSizeM, z]];
    const altitude = (y - baseY) / relief;
    const rgb = FOOTHILL_RGB.map((c, i) => c + (SUMMIT_RGB[i] - c) * altitude);
    emitFace(top, y, y, rgb, 1, show, ALWAYS);
    for (const { dx, dz, corners, light } of SIDES) {
      const neighbor = columns.get(columnKey(x + dx * cellSizeM, z + dz * cellSizeM));
      const sharedY = Math.min(y, neighbor?.y ?? baseY);
      const [a, b] = corners.map(i => top[i]);
      const side = [a, b, b, a];
      // The first column closes its own exposed wall until its neighbor joins.
      if (neighbor?.show > show) emitFace(side, baseY, sharedY, rgb, light, show, neighbor.show);
      if (y > sharedY) emitFace(side, sharedY, y, rgb, light, show, ALWAYS);
    }
  }

  const bytes = Buffer.allocUnsafe(values.length * Float32Array.BYTES_PER_ELEMENT);
  values.forEach((value, i) => bytes.writeFloatLE(value, i * Float32Array.BYTES_PER_ELEMENT));
  return { bytes, columns };
}

export function bakeVoxelRange(data, camera) { return bakeColumnLevel(data, camera).bytes; }

function naturalColor(data, x, y, z) {
  const sample = Math.max(22, data.grid.cellSizeM);
  const height = (dx, dz) => {
    const value = terrainHeightAt(data, x + dx, z + dz);
    return Number.isFinite(value) ? value : y;
  };
  const nx = (height(-sample, 0) - height(sample, 0)) / (2 * sample);
  const nz = (height(0, -sample) - height(0, sample)) / (2 * sample);
  const normalLength = Math.hypot(nx, 1, nz);
  const sunlight = Math.max(0, (-.58 * nx + .76 + .29 * nz) / normalLength);
  const altitude = Math.max(0, Math.min(1, (y - 1400) / 2600));
  const foothill = [0.59, 0.47, 0.33], granite = [0.72, 0.70, 0.65], snow = [0.88, 0.90, 0.90];
  const snowMix = Math.max(0, Math.min(1, (y - 3650) / 550)) * Math.max(0, 2 / normalLength - 1);
  const strata = 1 + .025 * Math.sin(y * .035 + Math.sin(x * .004) * .7) + .015 * Math.sin(x * .031 + z * .017);
  return foothill.map((value, i) => {
    const rock = value + (granite[i] - value) * altitude;
    return Math.max(0, Math.min(1, (rock + (snow[i] - rock) * snowMix) * (.50 + .50 * sunlight) * strata));
  });
}

function bakeSmoothLevel(data, cellSizeM, revealOrder) {
  const { originM: [originX, originZ], width, height, cellSizeM: sourceStep } = data.grid;
  const maxX = originX + (width - 1) * sourceStep, maxZ = originZ + (height - 1) * sourceStep;
  const values = [];
  for (let z = Math.ceil(originZ / cellSizeM) * cellSizeM; z + cellSizeM <= maxZ; z += cellSizeM) {
    for (let x = Math.ceil(originX / cellSizeM) * cellSizeM; x + cellSizeM <= maxX; x += cellSizeM) {
      const points = [[x, z], [x, z + cellSizeM], [x + cellSizeM, z + cellSizeM], [x + cellSizeM, z]]
        .map(([px, pz]) => [px, terrainHeightAt(data, px, pz), pz]);
      if (points.some(point => !Number.isFinite(point[1]))) continue;
      const parent = revealOrder.get(columnKey(Math.floor((x + cellSizeM / 2) / CELL_M) * CELL_M,
        Math.floor((z + cellSizeM / 2) / CELL_M) * CELL_M));
      const show = parent?.show ?? 0;
      const colors = points.map(([px, py, pz]) => naturalColor(data, px, py, pz));
      for (const i of TRIANGLE_CORNERS) values.push(...points[i], ...colors[i], show, ALWAYS);
    }
  }
  const bytes = Buffer.allocUnsafe(values.length * 4);
  values.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
  return bytes;
}

/** Version 2 keeps every terrain level in one immutable GPU upload. */
export function bakeProgressiveVoxelRange(data, camera, { smoothCellM = data.grid.cellSizeM * 2, cameraLiftM = 525 } = {}) {
  if (data.tiles) data = railGroundData(data);
  const coarse = bakeColumnLevel(data, camera);
  const levels = [{ ...LEVELS[0], bytes: coarse.bytes }];
  for (const level of LEVELS.slice(1)) levels.push({ ...level,
    bytes: bakeColumnLevel(data, camera, { cellSizeM: level.cellSizeM,
      heightStepM: level.cellSizeM / 5, revealOrder: coarse.columns }).bytes });
  levels.push({ cellSizeM: smoothCellM, startProgress: .84, endProgress: .96, kind: 'smooth',
    bytes: bakeSmoothLevel(data, smoothCellM, coarse.columns) });
  if (levels.some(level => !level.bytes.length)) throw new Error('Progressive terrain level has no geometry');
  const headerBytes = 32 + levels.length * 24;
  if (headerBytes + levels.reduce((sum, level) => sum + level.bytes.length, 0) > 256 * 1024 * 1024) {
    throw new Error('Voxel bake exceeds the 256 MiB runtime pack limit');
  }
  const header = Buffer.alloc(headerBytes);
  header.writeUInt32LE(PACK_MAGIC, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(VERTEX_FIELDS, 8); header.writeUInt32LE(levels.length, 12);
  header.writeFloatLE(cameraLiftM, 16); header.writeUInt32LE(headerBytes, 24);
  let first = 0;
  for (const [index, level] of levels.entries()) {
    const at = 32 + index * 24, count = level.bytes.length / (VERTEX_FIELDS * 4);
    header.writeUInt32LE(first, at); header.writeUInt32LE(count, at + 4);
    header.writeFloatLE(level.cellSizeM, at + 8);
    header.writeFloatLE(level.startProgress, at + 12); header.writeFloatLE(level.endProgress, at + 16);
    header.writeUInt32LE(level.kind === 'smooth' ? 1 : 0, at + 20);
    first += count;
  }
  header.writeUInt32LE(first, 20);
  return Buffer.concat([header, ...levels.map(level => level.bytes)]);
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function createVoxelRangeAsset(view, terrain, compressed, decoded) {
  return {
    schema: 'midio.voxel-range', version: 2, viewId: view.id,
    source: { mode: 'rail', terrainManifestUrl: view.terrainManifestUrl, terrainManifestSha256: view.terrainManifestSha256,
      terrainPayloadSha256: terrain.payload.sha256, demSha256: terrain.source.demSha256 },
    payload: { url: `${view.id}.v2.bin.gz`, encoding: 'gzip', byteLength: compressed.byteLength, sha256: sha256(compressed),
      decodedByteLength: decoded.byteLength, decodedSha256: sha256(decoded) },
  };
}

async function build() {
  const assets = fileURLToPath(new URL('../src/assets/range/v2/', import.meta.url));
  const view = catalog.views.find(candidate => candidate.id === VIEW_ID);
  const manifestPath = path.join(assets, view.terrainManifestUrl);
  const manifestBytes = await fs.readFile(manifestPath);
  if (sha256(manifestBytes) !== view.terrainManifestSha256) throw new Error('Voxel terrain manifest differs from its catalog pin');
  const manifest = JSON.parse(manifestBytes);
  const payload = await fs.readFile(path.join(path.dirname(manifestPath), manifest.payload.url));
  if (sha256(payload) !== manifest.payload.sha256) throw new Error('Voxel terrain payload differs from its manifest pin');
  const { eyeStartM, eyeEndM, targetStartM, fovYDeg } = view.camera;
  const data = decodeTerrain(manifest, gunzipSync(payload));
  let cameraLiftM = 525;
  for (let station = 0; station <= 64; station++) {
    const eye = eyeStartM.map((value, i) => value + (eyeEndM[i] - value) * station / 64);
    const ground = terrainHeightAt(data, eye[0], eye[2]);
    if (Number.isFinite(ground)) cameraLiftM = Math.max(cameraLiftM, ground + 350 - eye[1]);
  }
  const eyeM = [eyeStartM[0], eyeStartM[1] + cameraLiftM, eyeStartM[2]];
  const decoded = bakeProgressiveVoxelRange(data, { eyeM, targetM: targetStartM, fovYDeg }, { cameraLiftM });
  const bytes = gzipSync(decoded, { level: 9 });
  bytes[9] = 0;

  const dir = path.join(assets, 'voxel');
  const output = path.join(dir, `${VIEW_ID}.v2.bin.gz`);
  const temporary = `${output}.${randomUUID()}.tmp`;
  const metadata = path.join(dir, `${VIEW_ID}.v2.js`);
  const temporaryMetadata = `${metadata}.${randomUUID()}.tmp`;
  const asset = createVoxelRangeAsset(view, manifest, bytes, decoded);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(temporary, bytes);
    await fs.writeFile(temporaryMetadata, `// Generated by tools/build-voxel-range.mjs.\nexport default ${JSON.stringify(asset, null, 2)};\n`);
    await fs.rename(temporary, output);
    await fs.rename(temporaryMetadata, metadata);
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.rm(temporaryMetadata, { force: true });
  }
  const triangles = (decoded.length - 32 - (LEVELS.length + 1) * 24) / (3 * VERTEX_FIELDS * Float32Array.BYTES_PER_ELEMENT);
  console.log(`${path.relative(process.cwd(), output)}: ${triangles} stored triangles, ${decoded.length} decoded bytes, ${bytes.length} compressed bytes, camera lift ${cameraLiftM}m, SHA-256 ${sha256(bytes)}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await build();
