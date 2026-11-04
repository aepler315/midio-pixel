// Bake the shipped White Mountains heightfield into a local timed voxel mesh.
// Usage: node tools/build-voxel-range.mjs
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { decodeTerrain, terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';
import { createVoxelRangeScore } from '../src/world/alpine/VoxelRangeScore.js';
import { projectPoint } from '../src/world/terrain/SceneTravel.js';
import catalog from '../src/world/terrain/sceneCatalogData.js';

const VIEW_ID = 'white-mountains-owens';
const CELL_M = 500;
const HEIGHT_STEP_M = 100;
const ALWAYS = 2;
const VERTEX_FIELDS = 8;
const TRIANGLE_CORNERS = [0, 1, 2, 0, 2, 3];
const FOOTHILL_RGB = [0.62, 0.47, 0.31];
const SUMMIT_RGB = [0.76, 0.77, 0.80];

// Top corners wind outward along each of the four sides.
const SIDES = [
  { dx: -1, dz: 0, corners: [0, 1], light: .86 },
  { dx: 0, dz: 1, corners: [1, 2], light: .78 },
  { dx: 1, dz: 0, corners: [2, 3], light: .61 },
  { dx: 0, dz: -1, corners: [3, 0], light: .68 },
];

export function bakeVoxelRange(data, camera) {
  const { eyeM } = camera;
  const { originM: [originX, originZ], width, height, cellSizeM } = data.grid;
  const maxX = originX + (width - 1) * cellSizeM;
  const maxZ = originZ + (height - 1) * cellSizeM;
  const columns = new Map();
  const key = (x, z) => `${x},${z}`;

  for (let z = Math.floor(originZ / CELL_M) * CELL_M; z + CELL_M / 2 <= maxZ; z += CELL_M) {
    for (let x = Math.floor(originX / CELL_M) * CELL_M; x + CELL_M / 2 <= maxX; x += CELL_M) {
      const cx = x + CELL_M / 2, cz = z + CELL_M / 2;
      const elevation = terrainHeightAt(data, cx, cz);
      if (!Number.isFinite(elevation)) continue;
      const y = Math.round(elevation / HEIGHT_STEP_M) * HEIGHT_STEP_M;
      const distance = Math.hypot(cx - eyeM[0], cz - eyeM[2]);
      columns.set(key(x, z), { x, y, z, distance });
    }
  }

  const byElevation = [...columns.values()].sort((a, b) => a.y - b.y || a.distance - b.distance || a.z - b.z || a.x - b.x);
  if (!byElevation.length) throw new Error('Voxel range has no valid height samples');
  const baseY = byElevation[0].y - HEIGHT_STEP_M;
  const relief = byElevation.at(-1).y - baseY;
  const openingProgress = createVoxelRangeScore().progressAt(0);
  const openingCount = Math.floor(openingProgress * (columns.size - 1)) + 1;
  // Start with the lowest framed foothills, leaving headroom for the ridges.
  // Keep the altitude and distance order of every column outside this patch.
  const opening = new Set(byElevation.filter(({ x, y, z }) => {
    const p = projectPoint(camera, 16 / 9, [x + CELL_M / 2, y, z + CELL_M / 2]);
    return p?.depth >= 1500 && Math.abs(p.x) <= .76 && p.y >= -.90 && p.y <= -.04;
  }).slice(0, openingCount));
  const ordered = [...opening, ...byElevation.filter(column => !opening.has(column))];
  ordered.forEach((column, i) => { column.show = i / Math.max(1, ordered.length - 1); });

  const values = [];
  function emitFace(corners, y0, y1, rgb, light, show, hide) {
    for (const i of TRIANGLE_CORNERS) {
      const [x, z] = corners[i];
      values.push(x, i < 2 ? y0 : y1, z, rgb[0] * light, rgb[1] * light, rgb[2] * light, show, hide);
    }
  }

  for (const { x, y, z, show } of ordered) {
    const top = [[x, z], [x, z + CELL_M], [x + CELL_M, z + CELL_M], [x + CELL_M, z]];
    const altitude = (y - baseY) / relief;
    const rgb = FOOTHILL_RGB.map((c, i) => c + (SUMMIT_RGB[i] - c) * altitude);
    emitFace(top, y, y, rgb, 1, show, ALWAYS);
    for (const { dx, dz, corners, light } of SIDES) {
      const neighbor = columns.get(key(x + dx * CELL_M, z + dz * CELL_M));
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
  return bytes;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function build() {
  const assets = fileURLToPath(new URL('../src/assets/range/v2/', import.meta.url));
  const view = catalog.views.find(candidate => candidate.id === VIEW_ID);
  const manifestPath = path.join(assets, view.terrainManifestUrl);
  const manifestBytes = await fs.readFile(manifestPath);
  if (sha256(manifestBytes) !== view.terrainManifestSha256) throw new Error('Voxel terrain manifest differs from its catalog pin');
  const manifest = JSON.parse(manifestBytes);
  const payload = await fs.readFile(path.join(path.dirname(manifestPath), manifest.payload.url));
  if (sha256(payload) !== manifest.payload.sha256) throw new Error('Voxel terrain payload differs from its manifest pin');
  const { eyeStartM, targetStartM, fovYDeg } = view.camera;
  // Use the fixed elevated opening camera from VoxelRange.js.
  const eyeM = [eyeStartM[0], eyeStartM[1] + 525, eyeStartM[2]];
  const bytes = bakeVoxelRange(decodeTerrain(manifest, gunzipSync(payload)), { eyeM, targetM: targetStartM, fovYDeg });

  const dir = path.join(assets, 'voxel');
  const output = path.join(dir, `${VIEW_ID}.bin`);
  const temporary = `${output}.${randomUUID()}.tmp`;
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, output);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  const triangles = bytes.length / (3 * VERTEX_FIELDS * Float32Array.BYTES_PER_ELEMENT);
  console.log(`${path.relative(process.cwd(), output)}: ${triangles} triangles, ${bytes.length} bytes, SHA-256 ${sha256(bytes)}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await build();
