// Start npm run dev first. Exercise a real compiler rejection, rather than
// mocking scene readiness: invalid GLSL in any material the view draws must
// select complete legacy scenery and release the rejected view's resources
// before it can draw. RANGE_SHADER_FAULT picks the material (default terrain).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { openSong, captureFrame } from './range-scene-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] || 'http://127.0.0.1:8080';
const out = path.resolve(process.argv[3] || '.smoke/range-shader-failure');
await fs.mkdir(out, { recursive: true });
const wav = process.argv[4] || path.join(out, 'fixture.wav');
if (!process.argv[4]) execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), wav, '120', '24']);
const FAULTS = {
  terrain: ['src/world/alpine/TerrainMaterial.js', 'export const SCENE_FRAG = /* glsl */`'],
  forest: ['src/world/alpine/ForestGL.js', 'const MESH_FRAG = /* glsl */`'],
  actors: ['src/world/alpine/ActorsGL.js', 'const LANTERN_FRAG = /* glsl */`'],
};
const faultName = process.env.RANGE_SHADER_FAULT || 'terrain';
assert.ok(FAULTS[faultName], `RANGE_SHADER_FAULT must be one of ${Object.keys(FAULTS).join(', ')}`);
const [faultFile, faultMarker] = FAULTS[faultName];
const source = await fs.readFile(path.join(root, faultFile), 'utf8');
const faulty = source.replace(faultMarker, `${faultMarker}\n  deliberately_invalid_${faultName}_shader;`);
assert.notEqual(faulty, source, `fault injection reaches the ${faultName} fragment shader`);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const report = { fault: `invalid ${faultName} GLSL`, audio: path.resolve(wav), timeMs: 12000, browser: browser.version(), passed: false };
try {
  const faultBrowser = { newContext: async options => {
    const context = await browser.newContext(options);
    await context.route(`**/${faultFile}`, route =>
      route.fulfill({ contentType: 'text/javascript', body: faulty }));
    return context;
  } };
  const { context, page, errors } = await openSong(faultBrowser, {
    url, wav,
    width: 640, height: 360,
    params: { rangeTour: 'off', rangeView: 'teton-jackson-lake', seed: '315' },
  });
  try {
    const frame = await captureFrame(page, 12000, { hook: 'conifer' });
    await fs.writeFile(path.join(out, '12000.png'), Buffer.from(frame.png, 'base64'));
    report.range = frame.range;
    report.errors = errors;
    report.resources = await page.evaluate(() => {
      const scene = window.__SMW.sim.biomes.rangePresentation.scene;
      return { prepared: [...scene.prepared.keys()], residency: scene.residency.snapshot() };
    });
    assert.equal(frame.range.active, false, `a failed ${faultName} shader cannot claim an active scene`);
    assert.match(frame.range.failures['teton-jackson-lake'], /^shader:/);
    assert.match(frame.range.failures['teton-jackson-lake'], /ERROR|syntax error/i,
      'retain the native compiler diagnostic, not only a generic link failure');
    assert.deepEqual(report.resources.prepared, []);
    for (const owner of ['range-terrain-gpu', 'range-terrain-cpu', 'range-material']) {
      assert.equal(report.resources.residency.byOwner[owner], undefined, `${owner} released after rejection`);
    }
    assert.ok(!errors.some(error => error.startsWith('gl:')), 'failure handled before first shader use');
    // The phone-accessible report uses the same production controls in the
    // playback dialog, including a selectable fallback when copying is denied.
    // The click handler awaits the clipboard, so read the status it writes
    // after this click, not whatever an earlier click left there.
    const copyReport = async () => {
      await page.locator('#graphicsReportStatus').evaluate(el => { el.textContent = ''; });
      await page.locator('#copyGraphicsReport').click();
      await page.waitForFunction(() => document.getElementById('graphicsReportStatus').textContent !== '');
      return page.locator('#graphicsReportStatus').textContent();
    };
    await context.grantPermissions([]);
    await page.locator('#displaySettingsBtn').click({force:true});
    await page.locator('#graphicsTroubleshooting summary').click();
    assert.match(await copyReport(), /Select and copy/);
    const local = JSON.parse(await page.locator('#graphicsReport').inputValue());
    assert.equal(local.range.active,false);
    assert.match(local.range.failures['teton-jackson-lake'],/ERROR|syntax error/i);
    assert.ok(local.gpu.renderer);
    await context.grantPermissions(['clipboard-read','clipboard-write']);
    assert.match(await copyReport(),/^Copied/);
    const copied=JSON.parse(await page.evaluate(()=>navigator.clipboard.readText()));
    assert.equal(copied.range.reason,local.range.reason);
    assert.equal(JSON.stringify(copied).includes(path.basename(wav)),false);
    report.deviceReport=copied;
    report.passed = true;
    console.log(`Compiler rejection (${faultName}) selects legacy scenery; rejected view resources released.`);
  } finally { await context.close(); }
} finally {
  await browser.close();
  await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
