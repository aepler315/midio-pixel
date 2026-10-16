// Evidence only. A calibration target is not a measurement: compare matching
// projected surface anchors with the camera/time held fixed, then normalize.
import { calibrateRangeMusic, sceneDeformation } from '../../src/world/alpine/RangeFrame.js';
import { buildSurfaceTexture, buildReceiverMask, sampleReceiverMask } from '../../src/world/alpine/TerrainMesh.js';
import { glacierSample } from '../../src/world/alpine/GlacierField.js';

export function measureProjectedMotion({ neutralPoints, activePoints, visibleMask, nominalHeight }) {
  if (!(Number.isFinite(nominalHeight) && nominalHeight > 0)) throw new Error('nominal height must be positive and finite');
  if (!neutralPoints || !activePoints || !visibleMask || neutralPoints.length !== activePoints.length
    || neutralPoints.length !== visibleMask.length) throw new Error('projected points and visibility must have matched lengths');
  const distances = [];
  for (let i = 0; i < neutralPoints.length; i++) {
    if (!visibleMask[i]) continue;
    const a = neutralPoints[i], b = activePoints[i];
    if (![a?.x, a?.y, b?.x, b?.y].every(Number.isFinite)) throw new Error(`visible anchor ${i} must have finite coordinates`);
    distances.push(Math.hypot(b.x - a.x, b.y - a.y) * 720 / nominalHeight);
  }
  distances.sort((a, b) => a - b);
  const percentile = q => {
    if (!distances.length) return 0;
    const at = q * (distances.length - 1), lo = Math.floor(at), hi = Math.ceil(at);
    return distances[lo] + (distances[hi] - distances[lo]) * (at - lo);
  };
  return { visibleCount: distances.length, medianPx: percentile(.5), p95Px: percentile(.95), maxPx: distances.at(-1) || 0 };
}

const receiverMasks = new WeakMap();
function receiverSampler(data) {
  let mask = receiverMasks.get(data);
  if (!mask) { mask = buildReceiverMask(buildSurfaceTexture(data)); receiverMasks.set(data, mask); }
  return (x, z) => sampleReceiverMask(mask, (x - data.grid.originM[0]) / data.grid.cellSizeM,
    (z - data.grid.originM[1]) / data.grid.cellSizeM);
}

/** Measure actual prepared mesh vertices through one frozen camera. Neutral
 * removes only music displacement: glacier, light and every camera component
 * stay fixed. Ray hits are matched by triangle/barycentric coordinates so
 * arbitrary terrain re-sampling cannot masquerade as movement.
 *
 * Visibility is TERRAIN-SURFACE visibility in both poses, with crop and an
 * optional conservative foreground strip excluded. Forest, luminous ridges,
 * atmosphere and final compositor pixels are not modeled; this is geometric
 * evidence, not a screenshot or an artistic acceptance result.
 */
export function sampleProjectedTerrainMotion({ THREE, prepared, frame, camera,
  receiverAt = null, columns = 24, rows = 18, outputWidth = null, outputHeight = null,
  foregroundMaxFrac = 0 }) {
  if (!(Number.isInteger(columns) && columns > 0 && Number.isInteger(rows) && rows > 0)) throw new Error('positive sampling dimensions required');
  const vp = frame.scenicViewport;
  outputWidth ||= vp.nominalWidth || vp.logicalWidth;
  outputHeight ||= vp.nominalHeight || vp.logicalHeight;
  const nominalWidth = vp.nominalWidth || vp.logicalWidth, nominalHeight = vp.nominalHeight || vp.logicalHeight;
  const fit = Math.min(outputWidth / nominalWidth, outputHeight / nominalHeight);
  const fittedStage = { width: nominalWidth * fit, height: nominalHeight * fit,
    left: (outputWidth - nominalWidth * fit) / 2, top: (outputHeight - nominalHeight * fit) / 2 };
  const heightRange = [prepared.uniforms.uHeightRange.value.x, prepared.uniforms.uHeightRange.value.y];
  const music = calibrateRangeMusic(frame.music, { view: prepared.view, progress01: frame.progress01,
    heightRange, nominalHeight: vp.nominalHeight || 720 });
  receiverAt ||= receiverSampler(prepared.data);
  const fixedCamera = camera.clone(); fixedCamera.updateMatrixWorld(true);
  const material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
  const neutralMeshes = [], activeMeshes = [], records = new Map();
  const groups = Object.fromEntries(['crest', 'flank', 'near'].map(name => [name, { neutralPoints: [], activePoints: [], visibleMask: [] }]));
  const excluded = { hydro: 0, selfOccluded: 0, cropped: 0, foreground: 0 };
  let waterMaxDisplacementM = 0, sampledSurfaceCount = 0;
  const transform = vp.transform || [1, 0, 0, 1, 0, 0];
  const projected = point => {
    const q = point.clone().project(fixedCamera);
    const x = (q.x + 1) * vp.logicalWidth / 2, y = (1 - q.y) * vp.logicalHeight / 2;
    return { x: transform[0] * x + transform[2] * y + transform[4],
      y: transform[1] * x + transform[3] * y + transform[5], ndc: q };
  };
  const inFrame = p => p.ndc.z >= -1 && p.ndc.z <= 1 && p.x >= fittedStage.left
    && p.x <= fittedStage.left + fittedStage.width && p.y >= fittedStage.top && p.y <= fittedStage.top + fittedStage.height;
  try {
    for (const [band, source] of Object.entries(prepared.geometries)) {
      const neutral = source.clone(), active = source.clone(), sourcePosition = source.attributes.position;
      const n = neutral.attributes.position, a = active.attributes.position, receivers = new Float32Array(n.count);
      for (let i = 0; i < n.count; i++) {
        const x = sourcePosition.getX(i), y = sourcePosition.getY(i), z = sourcePosition.getZ(i);
        const ice = glacierSample(prepared.view.glacier, x, z, y, frame.glacier?.retreat01 || 0);
        const receiver = receiverAt(x, z); receivers[i] = receiver;
        const displacement = sceneDeformation(music, x, z, y, heightRange, receiver) * (1 - ice.coverage01);
        n.setY(i, y + ice.thicknessM); a.setY(i, y + ice.thicknessM + displacement);
        if (receiver === 0) waterMaxDisplacementM = Math.max(waterMaxDisplacementM, Math.abs(displacement));
      }
      for (const geo of [neutral, active]) { geo.computeBoundingSphere(); geo.computeBoundingBox(); }
      const nm = new THREE.Mesh(neutral, material), am = new THREE.Mesh(active, material);
      nm.updateMatrixWorld(); am.updateMatrixWorld();
      neutralMeshes.push(nm); activeMeshes.push(am);
      records.set(nm, { band, active: am, receivers });
    }
    const ray = new THREE.Raycaster(), vec = new THREE.Vector3(), bary = new THREE.Vector3();
    const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
    for (let col = 0; col < columns; col++) {
      let foundCrest = false;
      for (let row = 0; row < rows; row++) {
        ray.setFromCamera({ x: 2 * (col + .5) / columns - 1, y: 1 - 2 * (row + .5) / rows }, fixedCamera);
        const hit = ray.intersectObjects(neutralMeshes, false)[0];
        if (!hit) continue;
        sampledSurfaceCount++;
        const rec = records.get(hit.object), face = hit.face;
        const group = rec.band === 'near' ? 'near' : foundCrest ? 'flank' : 'crest';
        foundCrest = true;
        const n = hit.object.geometry.attributes.position, a = rec.active.geometry.attributes.position;
        v0.fromBufferAttribute(n, face.a); v1.fromBufferAttribute(n, face.b); v2.fromBufferAttribute(n, face.c);
        THREE.Triangle.getBarycoord(hit.point, v0, v1, v2, bary);
        const hydro = [face.a, face.b, face.c].every(i => rec.receivers[i] === 0);
        if (hydro) { excluded.hydro++; continue; }
        vec.copy(hit.point);
        vec.y += (a.getY(face.a) - n.getY(face.a)) * bary.x
          + (a.getY(face.b) - n.getY(face.b)) * bary.y + (a.getY(face.c) - n.getY(face.c)) * bary.z;
        const p0 = projected(hit.point), p1 = projected(vec);
        if (!inFrame(p0) || !inFrame(p1)) { excluded.cropped++; continue; }
        if (Math.max(p0.y, p1.y) > fittedStage.top + fittedStage.height * (1 - foregroundMaxFrac)) { excluded.foreground++; continue; }
        ray.setFromCamera({ x: p1.ndc.x, y: p1.ndc.y }, fixedCamera);
        const activeHit = ray.intersectObjects(activeMeshes, false)[0];
        const distance = fixedCamera.position.distanceTo(vec);
        if (!activeHit || activeHit.distance < distance - Math.max(.001, distance * 1e-7)) { excluded.selfOccluded++; continue; }
        groups[group].neutralPoints.push(p0); groups[group].activePoints.push(p1); groups[group].visibleMask.push(true);
      }
    }
    return {
      classification: 'CPU projection of prepared terrain; terrain self-visibility, not final composited pixels',
      cameraComparison: 'fixed camera, time, glacier and lighting; music displacement only',
      viewId: prepared.view.id, timeMs: frame.timeMs, progress01: frame.progress01,
      camera: { world: fixedCamera.matrixWorld.toArray(), projection: fixedCamera.projectionMatrix.toArray() },
      sampling: { columns, rows, outputWidth, outputHeight, fittedStage, normalizedHeight: 720, foregroundMaxFrac,
        groups: { crest: 'first visible sampled terrain in each column, excluding near band',
          flank: 'remaining far/mid terrain hits', near: 'hits owned by the near terrain band' } },
      calibration: { gain: music.calibrationGain, targetPx: music.targetPx, projectedBoundPx: music.projectedBoundPx,
        totalBoundM: music.totalBoundM, geologicalCapM: Math.min(180, (heightRange[1] - heightRange[0]) * .065) },
      sampledSurfaceCount, excluded, waterMaxDisplacementM,
      groups: Object.fromEntries(Object.entries(groups).map(([name, points]) => [name,
        measureProjectedMotion({ ...points, nominalHeight: fittedStage.height })])),
    };
  } finally {
    for (const mesh of [...neutralMeshes, ...activeMeshes]) mesh.geometry.dispose();
    material.dispose();
  }
}
