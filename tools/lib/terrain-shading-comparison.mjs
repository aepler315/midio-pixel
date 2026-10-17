import assert from 'node:assert/strict';
import { compareReports, blankFrame } from './visual-evaluation.mjs';

// A changed image is not evidence of improvement. This only establishes
// that the artistic comparison changed shading, not the scene or camera.
export function compareTerrainReports(before, after) {
  assert.ok(before.experiment?.requested === 'off' && after.experiment?.requested === 'moran',
    'artistic comparison requires baseline OFF followed by experiment ON');
  const diff = compareReports(before, after);
  assert.deepEqual(before.launchArgs, after.launchArgs, 'different browser flags');
  const presentationKeys = ['requestedLook', 'effectiveLook', 'effectiveGrid', 'pixelScale',
    'effectivePalette', 'effectiveDitherMode', 'output', 'working', 'qualityLevel'];
  for (let i = 0; i < before.songs.length; i++) {
    const a = before.songs[i], b = after.songs[i];
    const assetsA = a.loadedFiles ?? before.songs[0].loadedFiles;
    const assetsB = b.loadedFiles ?? after.songs[0].loadedFiles;
    assert.ok(Array.isArray(assetsA) && assetsA.length, 'missing loaded assets');
    assert.deepEqual(assetsA, assetsB, 'different loaded assets');
    a.frames.forEach((f, n) => {
      const g = b.frames[n], label = `${a.id}@${f.timeMs}`;
      for (const [frame, report] of [[f, before], [g, after]]) {
        assert.equal(blankFrame(frame.thumbnail), false, `blank scene: ${label}`);
        const activation = frame.terrainShading, expected = report.experiment?.requested;
        assert.ok(['off', 'moran'].includes(expected), 'missing shading request');
        assert.ok(activation?.active && activation.viewId === 'teton-jackson-lake'
          && activation.effective === expected && activation.marker === (expected === 'moran')
          && activation.linkedPrograms > 0 && activation.allLinked && activation.bandsUseMaterial,
        `inactive or unverified terrain shading: ${label}`);
        assert.ok(frame.cameraState?.projection?.length === 16 && frame.cameraState?.position?.length === 3,
          `missing actual camera: ${label}`);
        assert.deepEqual(frame.range?.scene?.pending, [], `unsettled assets: ${label}`);
      }
      for (const key of ['cameraState', 'controls', 'audio', 'render', 'output', 'quality', 'dpr']) {
        assert.notEqual(f[key], undefined, `missing ${key}: ${label}`);
        assert.deepEqual(f[key], g[key], `different ${key}: ${label}`);
      }
      assert.deepEqual(f.view ?? 'authored camera', g.view ?? 'authored camera', `different view: ${label}`);
      for (const key of presentationKeys) {
        assert.notEqual(f.presentation?.[key], undefined, `missing presentation ${key}: ${label}`);
        assert.deepEqual(f.presentation[key], g.presentation?.[key], `different presentation ${key}: ${label}`);
      }
      assert.deepEqual(f.range.narrative, g.range.narrative, `different narrative state: ${label}`);
    });
  }
  return { ...diff, terrainState: 'matched', verdict: 'unreviewed' };
}
