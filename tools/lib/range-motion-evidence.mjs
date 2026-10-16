// Node side of the evidence harness. Reconstruct the exact budget mesh from
// verified assets; full Three stays a development dependency, never runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import { decodeTerrain } from '../../src/world/alpine/TerrainMesh.js';
import { createBandGeometries } from '../../src/world/alpine/TerrainGL.js';
import { sampleProjectedTerrainMotion } from './range-motion-metrics.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const preparedCache = new Map();
export async function measureTerrainSnapshot({ root, view, frame, camera, budget = 'desktop', outputWidth, outputHeight,
  columns = 24, rows = 18 }) {
  const key = `${root}:${view.id}:${budget}`;
  let prepared = preparedCache.get(key);
  if (!prepared) {
    const manifestPath = path.join(root, 'src/assets/range/v2', view.terrainManifestUrl);
    const manifestBytes = await fs.readFile(manifestPath), manifest = JSON.parse(manifestBytes);
    const payload = await fs.readFile(path.join(path.dirname(manifestPath), manifest.payload.url));
    if (hash(payload) !== manifest.payload.sha256) throw new Error(`terrain payload hash mismatch: ${view.id}`);
    const decoded = manifest.payload.encoding === 'gzip' ? gunzipSync(payload) : payload;
    if (hash(decoded) !== manifest.payload.decodedSha256) throw new Error(`decoded terrain hash mismatch: ${view.id}`);
    const data = decodeTerrain(manifest, decoded);
    prepared = { view, data, geometries: createBandGeometries(THREE, data, { budget }).geometries,
      uniforms: { uHeightRange: { value: new THREE.Vector2(manifest.boundsM.min[1], manifest.boundsM.max[1]) } },
      assetHashes: { manifest: hash(manifestBytes), payload: hash(payload), decoded: hash(decoded) } };
    preparedCache.set(key, prepared);
  }
  const fixedCamera = new THREE.PerspectiveCamera();
  fixedCamera.matrixWorld.fromArray(camera.world);
  fixedCamera.matrixWorld.decompose(fixedCamera.position, fixedCamera.quaternion, fixedCamera.scale);
  fixedCamera.matrixWorldInverse.copy(fixedCamera.matrixWorld).invert();
  fixedCamera.projectionMatrix.fromArray(camera.projection);
  fixedCamera.projectionMatrixInverse.copy(fixedCamera.projectionMatrix).invert();
  const foregroundMaxFrac = view.composition?.foreground === 'ledge' ? view.composition.nearLedgeMaxFrac : 0;
  return { ...sampleProjectedTerrainMotion({ THREE, prepared: { ...prepared, view }, frame, camera: fixedCamera,
    outputWidth, outputHeight, foregroundMaxFrac, columns, rows }),
  assetHashes: prepared.assetHashes, budget };
}
