import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareTerrainReports } from '../tools/lib/terrain-shading-comparison.mjs';
import { compareReports } from '../tools/lib/visual-evaluation.mjs';

const report = (requested = 'off') => ({ version: 1, status: 'passed', browser: 'test', launchArgs: [],
  source: { commit: 'a'.repeat(40), digest: 'a'.repeat(64), changedDuringRun: false,
    hashes: { 'index.html': 'a'.repeat(64), 'src/main.js': 'b'.repeat(64) } },
  environment: { gl: 'test', vendor: 'test', deviceMemory: 8, dpr: 1 }, experiment: { requested },
  settings: { width: 1280, height: 720, seed: 315, quality: 0, view: 'teton-jackson-lake',
    biome: 'CONIFER', fps: 6, mode: 'sparse', intervalMs: 10000 },
  songs: [{ id: 'test', durationMs: 4000, audioSha256: 'a'.repeat(64), loadedFiles: ['/terrain.bin'],
    schedule: [{ timeMs: 1000, save: true }], frames: [{ timeMs: 1000, actualTimeMs: 1000,
      png: 'x.png', sha256: 'b'.repeat(64), thumbnail: [1, 2, 3, 255, 20, 20, 20, 255],
      terrainShading: { active: true, viewId: 'teton-jackson-lake', effective: requested,
        marker: requested === 'moran', linkedPrograms: 1, allLinked: true, bandsUseMaterial: true },
      cameraState: { position: [1, 2, 3], projection: Array(16).fill(0) },
      controls: { storm: { amount: .4 } }, audio: { heardTimeMs: 1000 }, render: { exposure: 2 },
      output: { width: 1280, height: 720 }, quality: 0, dpr: 1,
      range: { scene: { pending: [] }, narrative: {} }, presentation: { requestedLook: 'pixel', effectiveLook: 'pixel',
        effectiveGrid: { id: 'classic', width: 320, height: 180 }, pixelScale: 'depth', effectivePalette: 'none',
        effectiveDitherMode: 'ordered', output: { width: 1280, height: 720 }, working: { width: 320, height: 180 }, qualityLevel: 0 },
    }] }],
});

test('terrain comparisons reject camera, weather, music, lighting and effective pixel drift', () => {
  const changes = [f => { f.cameraState.position[0]++; }, f => { f.cameraState.projection[0]++; },
    f => { f.controls.storm.amount++; }, f => { f.audio.heardTimeMs++; }, f => { f.render.exposure++; },
    f => { f.presentation.pixelScale = 'original'; }];
  for (const change of changes) {
    const a = report(), b = report('moran'); change(b.songs[0].frames[0]);
    // The general report contract did not catch these paired-state errors.
    assert.doesNotThrow(() => compareReports(a, b));
    assert.throws(() => compareTerrainReports(a, b), /different/);
  }
});

test('terrain comparisons require active shader and settled camera/asset evidence on both sides', () => {
  const changes = [r => { r.songs[0].frames[0].terrainShading.active = false; },
    r => { r.songs[0].frames[0].terrainShading.marker = true; },
    r => { delete r.songs[0].frames[0].cameraState; },
    r => { r.songs[0].frames[0].range.scene.pending = ['terrain']; },
    r => { delete r.songs[0].loadedFiles; }];
  for (const change of changes) {
    const a = report(), b = report('moran'); change(a); change(b);
    assert.throws(() => compareTerrainReports(a, b), /inactive|missing|unsettled/);
  }
});

test('the artistic comparison cannot label OFF as experimental or reverse the pair', () => {
  assert.throws(() => compareTerrainReports(report(), report()), /baseline OFF.*experiment ON/);
  assert.throws(() => compareTerrainReports(report('moran'), report()), /baseline OFF.*experiment ON/);
});

test('pixel change has no artistic acceptance score', () => {
  const a = report(), b = report('moran'); b.songs[0].frames[0].sha256 = 'c'.repeat(64);
  const result = compareTerrainReports(a, b);
  assert.equal(result.terrainState, 'matched');
  assert.equal(result.frames[0].identical, false);
  assert.equal(result.verdict, 'unreviewed');
});
