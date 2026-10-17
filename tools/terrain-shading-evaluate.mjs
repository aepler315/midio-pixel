// Matched real-application captures for the bounded Mount Moran experiment.
// Uses the existing upload, analysis, simulation, camera and export path.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot, sha256 } from './lib/visual-evaluation-server.mjs';
import { openEvaluationSong, renderEvaluationFrame } from './lib/visual-evaluation-browser.mjs';
import { normalizeManifest, captureSchedule } from './lib/visual-evaluation.mjs';
import { renderRunReport } from './lib/visual-evaluation-report.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => {
  if (i % 2 === 0) pairs.push([value.replace(/^--/, ''), all[i + 1]]);
  return pairs;
}, []));
assert.ok(args.out && args.manifest, 'usage: --manifest FILE --out DIR [--root DIR] [--shading off|moran] [--close 1]');
const root = path.resolve(args.root || '.'), out = path.resolve(args.out), shading = args.shading || 'off';
assert.ok(['off', 'moran'].includes(shading));
const manifest = normalizeManifest(JSON.parse(await fs.readFile(args.manifest, 'utf8')));
assert.equal(manifest.songs.length, 1, 'one bounded recording per run');
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.mkdir(out); // Never overwrite evidence.
const report = { version: 1, status: 'failed', createdAt: new Date().toISOString(), settings: manifest.settings, songs: [],
  experiment: { requested: shading, close: args.close === '1', sourceRoot: root },
  timingScope: 'Offline fixed-clock capture wall times, including software GPU and readback; not live FPS.' };
let browser, server, loaded;
try {
  const snapshot = await snapshotSource(root);
  report.source = { digest: snapshot.digest, hashes: snapshot.hashes,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim() };
  server = await serveSnapshot(snapshot);
  const launchArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  if (process.env.TERRAIN_IN_PROCESS === '1') launchArgs.push('--in-process-gpu');
  report.launchArgs = launchArgs;
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}), args: launchArgs });
  report.browser = browser.version();
  const song = manifest.songs[0], dir = path.join(out, song.id);
  await fs.mkdir(dir);
  const audio = `${song.id}/audio${song.file ? path.extname(song.file) : '.wav'}`, audioPath = path.join(out, audio);
  if (song.file) await fs.copyFile(path.resolve(path.dirname(path.resolve(args.manifest)), song.file), audioPath);
  else {
    assert.equal(song.fixture, 'contrast');
    execFileSync(process.execPath, [path.join(root, 'tools/gen-pilot-wav.mjs'), audioPath, String(song.seconds)]);
  }
  const row = { id: song.id, fixture: song.fixture, audio, audioSha256: sha256(await fs.readFile(audioPath)), frames: [], errors: [], warnings: [] };
  report.songs.push(row);
  const loadedFiles = new Set(), start = performance.now();
  console.log('Loading', song.id, shading);
  loaded = await openEvaluationSong(browser, { url: server.url, audioPath,
    settings: { ...manifest.settings, debug: { ...manifest.settings.debug, terrainShading: shading } }, diagnostics: { ...row, loadedFiles } });
  report.loadWallMs = performance.now() - start;
  report.environment = loaded.environment;
  row.durationMs = loaded.durationMs;
  row.clips = song.clips || [];
  row.schedule = captureSchedule(song, loaded.durationMs, manifest.settings);
  const verifyActivation = (requireActive = true) => loaded.page.evaluate(({ expected, requireActive }) => {
    const smw = window.__SMW, scene = smw.sim.biomes.rangePresentation.scene;
    const p = scene.prepared.get('teton-jackson-lake'), m = p?.material;
    const programs = [...(scene.renderer.properties.get(m)?.programs?.values() || [])];
    const gl = scene.renderer.getContext();
    const actual = { requested: new URLSearchParams(location.search).get('terrainShading'),
      effective: m?.userData?.terrainShading || 'off', marker: !!m?.fragmentShader?.includes('MORAN_TERRAIN_SHADING'),
      linkedPrograms: programs.length, allLinked: programs.every(v => gl.getProgramParameter(v.program, gl.LINK_STATUS)),
      viewId: smw.rangeState.viewId, active: smw.rangeState.active,
      bandsUseMaterial: ['far', 'mid', 'near'].every(b => p.scenes[b].children.some(mesh => mesh.material === m)) };
    if (actual.effective !== expected || actual.marker !== (expected === 'moran') || !actual.allLinked || !actual.linkedPrograms || !actual.bandsUseMaterial)
      throw new Error('Terrain shading did not reach compiled material: ' + JSON.stringify(actual));
    if (requireActive && (!actual.active || actual.viewId !== 'teton-jackson-lake'))
      throw new Error('Terrain shading view is inactive: ' + JSON.stringify(actual));
    return actual;
  }, { expected: shading, requireActive });
  const cameraState = () => loaded.page.evaluate(() => {
    const scene = window.__SMW.sim.biomes.rangePresentation.scene, camera = scene.camera;
    return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
      projection: camera.projectionMatrix.toArray(), matrixWorld: camera.matrixWorld.toArray(),
      fov: camera.fov, aspect: camera.aspect, userCameraEnabled: window.__SMW.sim.userCameraEnabled };
  });
  report.experiment.compiledMaterial = await verifyActivation(false);
  for (const point of row.schedule) {
    const began = performance.now();
    const frame = await renderEvaluationFrame(loaded.page, point, manifest.settings);
    if (!frame) continue;
    frame.captureWallMs = performance.now() - began;
    frame.view = 'authored camera';
    const bytes = Buffer.from(frame.pngData, 'base64'); delete frame.pngData;
    frame.png = `${song.id}/frame-${String(row.frames.length).padStart(5, '0')}.png`; frame.sha256 = sha256(bytes);
    frame.terrainShading = await verifyActivation();
    frame.cameraState = await cameraState();
    await fs.writeFile(path.join(out, frame.png), bytes); row.frames.push(frame);
    // Checkpoint the record so an interrupted run retains honest partial evidence.
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`${point.timeMs}ms: ${(frame.captureWallMs / 1000).toFixed(2)}s wall`);
  }
  if (args.close === '1') {
    // The existing listener zoom, settled deterministically, on the final
    // authored pose. No camera-path or production-camera changes.
    await loaded.page.evaluate(async () => {
      const { rangeUserCamera } = await import('/src/world/alpine/RangeCamera.js');
      const scene = window.__SMW.sim.biomes.rangePresentation.scene;
      rangeUserCamera.reset();
      rangeUserCamera.noteFrame({ tanX: Math.tan(scene.camera.fov * Math.PI / 360) * scene.camera.aspect,
        tanY: Math.tan(scene.camera.fov * Math.PI / 360) });
      rangeUserCamera.zoomAt(1.8, .55, .25);
      rangeUserCamera.sample(performance.now() + 10000);
      window.__SMW.sim.userCameraEnabled = true;
    });
    const point = { ...row.schedule.at(-1), save: true, checkpoint: true, clips: [] };
    const began = performance.now();
    const frame = await renderEvaluationFrame(loaded.page, point, manifest.settings);
    frame.captureWallMs = performance.now() - began;
    const bytes = Buffer.from(frame.pngData, 'base64'); delete frame.pngData;
    frame.png = `${song.id}/close.png`; frame.sha256 = sha256(bytes); frame.view = 'listener zoom 1.8x';
    frame.terrainShading = await verifyActivation();
    frame.cameraState = await cameraState();
    // A separate song row keeps the settled listener zoom in the existing
    // report/hash/comparison contract without duplicating a schedule time.
    report.songs.push({ ...row, id: `${song.id}-close`, schedule: [point], clips: [], frames: [frame] });
    await fs.writeFile(path.join(out, frame.png), bytes);
  }
  row.loadedFiles = [...loadedFiles].sort();
  for (const song of report.songs) song.loadedFiles = row.loadedFiles;
  assert.deepEqual(row.errors, [], 'page/shader errors');
  report.source.changedDuringRun = (await snapshotSource(root)).digest !== snapshot.digest;
  assert.equal(report.source.changedDuringRun, false, 'source changed during capture');
  report.status = 'passed';
} catch (e) { report.error = String(e.stack || e); throw e; }
finally {
  await loaded?.context.close(); await browser?.close(); await server?.close();
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(out, 'index.html'), renderRunReport(report));
  console.log(out, report.status);
}
