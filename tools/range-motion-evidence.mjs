// Reproducible geometric probes without a browser. This deliberately makes no
// final-composite, real-recording, shader, motion-clip or device timing claim.
// node tools/range-motion-evidence.mjs --output .smoke/range-motion.json
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import catalog from '../src/world/terrain/sceneCatalogData.js';
import { cameraPoseAt } from '../src/world/terrain/SceneTravel.js';
import { rangeMusicState } from '../src/world/alpine/RangeFrame.js';
import { glacierStateAt } from '../src/world/alpine/GlacierField.js';
import { measureTerrainSnapshot } from './lib/range-motion-evidence.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((all, value, i, array) => {
  if (i % 2 === 0) all.push([value.replace(/^--/, ''), array[i + 1]]); return all;
}, []));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stations = (args.stations || '0.5').split(',').map(Number);
if (stations.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('stations must be within 0..1');
const ids = (args.views || 'teton-jackson-lake-coherent,monument-valley-163-coherent,pend-oreille-valley').split(',');
const cases = {
  quiet: { env: { groove: .06, sustain: .04, scaleMul: 1, kickMul: 1, gesture: 0 }, activity01: .08 },
  'sustained-bass': { env: { groove: .7, sustain: .9, scaleMul: 1.2, kickMul: 1, gesture: 0 }, activity01: .9 },
  'isolated-kick': { env: { groove: 0, sustain: 0, scaleMul: 1, kickMul: 1, gesture: 0 }, evaluatedKick01: 1, activity01: 1 },
  dense: { env: { groove: .9, sustain: .9, scaleMul: 1.3, kickMul: .8, gesture: .8 }, evaluatedKick01: .7,
    activity01: 1, melody: { activity: .8, pitch01: .7, pan: .3 }, structural01: .7 },
};
const report = { classification: 'CPU geometry projection of verified shipped meshes using synthetic musical channel probes; no browser or artistic acceptance',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceChanges: execFileSync('git', ['status', '--porcelain', '--', 'src', 'tools', 'test'], { cwd: root, encoding: 'utf8' }).trim(),
  sources: {}, states: cases, rows: [], unavailable: ['final composite and forest visibility', 'real-song passages', 'moving-camera clips', 'physical device performance'] };
for (const file of ['src/world/alpine/RangeFrame.js', 'src/world/alpine/GlacierField.js', 'src/world/alpine/TerrainMesh.js',
  'src/world/terrain/SceneTravel.js', 'src/world/terrain/sceneCatalogData.js', 'tools/lib/range-motion-metrics.mjs', 'tools/lib/range-motion-evidence.mjs', 'tools/range-motion-evidence.mjs']) {
  report.sources[file] = createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex');
}
for (const id of ids) {
  const view = catalog.views.find(candidate => candidate.id === id);
  if (!view) throw new Error(`unknown view ${id}`);
  for (const progress01 of stations) {
    const pose = cameraPoseAt(view, progress01), camera = new THREE.PerspectiveCamera(pose.fovYDeg, 16 / 9, 20, 150000);
    camera.position.set(...pose.eyeM); camera.lookAt(...pose.targetM); camera.updateMatrixWorld();
    for (const [label, state] of Object.entries(cases)) {
      const timeMs = progress01 * 120000, music = rangeMusicState({ ...state, tSec: timeMs / 1000 });
      if (label === 'isolated-kick') { music.amplitudeM = 0; music.totalBoundM = music.kickM; }
      const frame = { timeMs, progress01, music, glacier: glacierStateAt({ timeMs, durationMs: 120000, progress01 }),
        scenicViewport: { logicalWidth: 1280, logicalHeight: 720, nominalWidth: 1280, nominalHeight: 720, transform: [1, 0, 0, 1, 0, 0] } };
      const result = await measureTerrainSnapshot({ root, view, frame, camera: { world: camera.matrixWorld.toArray(), projection: camera.projectionMatrix.toArray() },
        columns: Number(args.columns || 24), rows: Number(args.rows || 18) });
      report.rows.push({ label, ...result });
      console.error(`${id} ${progress01} ${label}: flank median ${result.groups.flank.medianPx.toFixed(3)} px (${result.groups.flank.visibleCount} anchors)`);
    }
  }
}
if (args.output) { await fs.mkdir(path.dirname(path.resolve(args.output)), { recursive: true }); await fs.writeFile(args.output, JSON.stringify(report, null, 2)); }
else console.log(JSON.stringify(report, null, 2));
