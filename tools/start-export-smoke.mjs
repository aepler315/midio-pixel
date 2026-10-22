// Run against a local server. Uses a separate muted, headless browser/profile.
// Saves decoded files and screenshots in an ignored evidence directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8091';
const out = path.resolve(process.argv[3] || '.smoke/start-export');
await fs.mkdir(out, { recursive: true });
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const world = process.argv[4] || 'Trio';
const navigateOnComplete = process.argv[5] === 'navigate';
assert.ok(['Trio', 'Landscape'].includes(world), 'world must be Trio or Landscape');
const browser = await chromium.launch({ executablePath, headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
await context.addInitScript(() => {
  const start = MediaRecorder.prototype.start, stop = MediaRecorder.prototype.stop;
  window.__captureProbe = { requests: [] };
  MediaRecorder.prototype.start = function (...args) { window.__captureProbe.started = performance.now(); return start.apply(this, args); };
  MediaRecorder.prototype.stop = function (...args) { window.__captureProbe.stopped = performance.now(); return stop.apply(this, args); };
  const request = CanvasCaptureMediaStreamTrack.prototype.requestFrame;
  CanvasCaptureMediaStreamTrack.prototype.requestFrame = function (...args) { window.__captureProbe.requests.push(performance.now()); return request.apply(this, args); };
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const report = { world, checks: [], files: [] };
page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') (report.console ||= []).push(message.text()); });
const check = (name, actual) => { assert.ok(actual, name); report.checks.push(name); console.log('PASS', name); };
try {
  await page.goto(url);
  await page.screenshot({ path: path.join(out, 'start.png'), fullPage: true });
  check('Random song is visible on the front screen', await page.locator('#randomSongBtn').isVisible());
  check('Export video is offered before a song', await page.locator('#exportEnabled').isVisible());
  check('the completion panel has no export setup', await page.locator('#completePanel #completeExport, #completePanel #exportPreset').count() === 0);
  await page.locator('#exportEnabled').check();
  await page.locator('[data-export="aspect"]').selectOption('9:16');
  await page.locator('[data-export="resolution"]').selectOption('480');
  await page.locator('[data-export="fps"]').selectOption('24');
  await page.locator('[data-export="encoding"]').selectOption('compact');
  await page.locator('[data-export="framing"]').selectOption('fill');
  check('output summary follows the settings', (await page.locator('#exportSummary').textContent()).includes('480 × 854 · 24 fps'));
  await page.screenshot({ path: path.join(out, 'portrait-setup.png'), fullPage: true });
  await page.reload();
  check('settings persist while exporting remains opt-in', !await page.locator('#exportEnabled').isChecked());
  check('portrait settings survive reload', await page.locator('[data-export="aspect"]').inputValue() === '9:16');
  await page.locator('#titleSettings').evaluate(el => { el.open = true; });
  await page.locator('#generalQuality').focus();
  await page.locator('#generalQuality').press('Home');
  check('general quality is independent of encoding quality', await page.locator('[data-export="encoding"]').inputValue() === 'compact');
  await page.reload();
  check('general quality persists', await page.locator('#generalQuality').inputValue() === '0');
  await page.locator('#titleSettings').evaluate(el => { el.open = true; });
  if (await page.locator('#lyricGroundingBtn').getAttribute('aria-pressed') === 'true') await page.locator('#lyricGroundingBtn').click();
  // Two real files enter through the same directory-input path as a user's folder.
  const folder = path.join(out, 'music'); await fs.mkdir(folder, { recursive: true });
  for (const name of ['first', 'second']) {
    const file = path.join(folder, `${name}.wav`);
    execFileSync(process.execPath, ['tools/gen-test-wav.mjs', file, '120', '6']);
    // A quieter identifiable tail follows the last drum. Exports must retain
    // it even when the show's finale would have faded the live master bus.
    const source = await fs.readFile(file), rate = 44100, extraSamples = rate * 3;
    const extended = Buffer.alloc(source.length + extraSamples * 2); source.copy(extended);
    for (let i = 0; i < extraSamples; i++) {
      const t = i / rate, envelope = Math.min(1, t * 20, (3 - t) * 10);
      extended.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (520 * t + 70 * t * t)) * .18 * envelope * 32767), source.length + i * 2);
    }
    extended.writeUInt32LE(extended.length - 8, 4); extended.writeUInt32LE(extended.length - 44, 40);
    await fs.writeFile(file, extended);
  }
  await page.locator('#stageFps').selectOption('30');
  await page.locator('#libraryFolderInput').setInputFiles(folder);
  await page.waitForFunction(() => document.querySelectorAll('#libraryRecent .recentChip').length === 2);
  await page.getByRole('button', { name: 'Close library', exact: true }).click();
  await page.locator('#exportEnabled').check();
  const downloading = page.waitForEvent('download', { timeout: 120000 }); downloading.catch(() => {});
  await page.locator('#randomSongBtn').click();
  await page.getByRole('button', { name: `Export in ${world}`, exact: true }).click({ timeout: 120000 });
  await page.waitForFunction(() => window.__SMW?.sim && !window.__SMW.paused && window.__SMW.renderReadiness?.status === 'ready');
  check('the general quality slider reaches the live renderer', await page.evaluate(() => window.__SMW.perf.level === 6));
  check('recording uses its own fps target', await page.evaluate(() => window.__SMW.fpsCap === 24));
  const seek = await page.evaluate(() => {
    const before = window.__SMW.audioEngine.nowMs; window.__SMW.seek(8000);
    return { before, after: window.__SMW.audioEngine.nowMs };
  });
  check('canvas/API seeking cannot interrupt a full export', seek.after - seek.before < 500);
  await page.screenshot({ path: path.join(out, 'recording.png') });
  if (navigateOnComplete) {
    await page.locator('#completePanel:not(.hidden)').waitFor({ timeout: 120000 });
    await page.locator('#playAgainBtn').click();
    check('immediate completion navigation returns to the front screen', await page.locator('#randomSongBtn').isVisible());
  }
  const download = await downloading;
  report.captureProbe = await page.evaluate(() => window.__captureProbe);
  const file = path.join(out, download.suggestedFilename()); await download.saveAs(file);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
  const video = probe.streams.find(s => s.codec_type === 'video'), audio = probe.streams.find(s => s.codec_type === 'audio');
  // Browser-produced WebM may omit container duration. Measure the packet
  // endpoint for each track rather than treating absent metadata as failure.
  const packets = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_packets', '-show_entries', 'packet=stream_index,pts_time,duration_time', '-of', 'json', file], { encoding: 'utf8' })).packets;
  const trackEnd = index => Math.max(0, ...packets.filter(p => p.stream_index === index).map(p => Number(p.pts_time) + Number(p.duration_time || 0)));
  const durationSec = Math.max(trackEnd(video.index), trackEnd(audio.index));
  report.trackDuration = { video: trackEnd(video.index), audio: trackEnd(audio.index) };
  check('saved video has the selected portrait dimensions', video?.width === 480 && video?.height === 854);
  check('saved video has an audio track', !!audio);
  check('saved video covers the full source including its quiet tail', trackEnd(video.index) >= 8.8 && trackEnd(audio.index) >= 8.8);
  const times = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim().split(/\s+/).map(Number).filter(Number.isFinite);
  const gaps = times.slice(1).map((t, i) => t - times[i]).filter(n => n > 0);
  // MediaRecorder emits an initial stream frame and uses variable timestamps;
  // pace complete one-second windows rather than claiming constant-rate gaps.
  check('frame pacing respects the target over one-second windows', times.every(start => times.filter(t => t >= start && t < start + 1).length <= 26));
  report.encodedCadence = { requestedFps: 24, averageFps: times.length / durationSec, minimumGap: Math.min(...gaps) };
  // Decode the opening and a late frame: check both contain a picture.
  const pngs = [];
  for (const [name, time] of [['opening', .2], ['ending', 8.5]]) {
    const png = path.join(out, `${name}.png`); pngs.push(png);
    execFileSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-y', png]);
    check(`${name} decodes to an image`, (await fs.stat(png)).size > 2000);
  }
  report.files.push({ file, probe, frameTimes: times, pngs });
  // Cross-correlate independently decoded source/export audio in two windows.
  const sourceName = path.basename(file).startsWith('first -') ? 'first' : 'second';
  const pcm = input => {
    const bytes = execFileSync('ffmpeg', ['-v', 'error', '-i', input, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1']);
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const sourceAudio = pcm(path.join(folder, `${sourceName}.wav`)), encodedAudio = pcm(file);
  const correlate = (start, seconds) => {
    const at = Math.round(start * 8000), length = Math.round(seconds * 8000);
    let best = { correlation: -1, offsetMs: 0, gain: 0 };
    for (let lag = -1200; lag <= 1200; lag++) {
      let dot = 0, aa = 0, bb = 0;
      for (let i = at; i < at + length; i += 4) {
        const a = sourceAudio[i] || 0, b = encodedAudio[i + lag] || 0; dot += a * b; aa += a * a; bb += b * b;
      }
      const correlation = dot / Math.sqrt(aa * bb || 1);
      if (correlation > best.correlation) best = { correlation, offsetMs: lag / 8, gain: dot / aa };
    }
    return best;
  };
  const onsetAudio = correlate(.2, 1.5), tailAudio = correlate(6.5, 1.5);
  report.audio = { onsetAudio, tailAudio };
  check('opening audio matches the source', onsetAudio.correlation > .9);
  check('the encoder does not trim the source opening before video time zero', onsetAudio.offsetMs >= -5);
  check('quiet ending audio matches the source without the live finale fade', tailAudio.correlation > .9 && tailAudio.gain > .65);
  check('audio offset stays stable from opening to tail', Math.abs(onsetAudio.offsetMs - tailAudio.offsetMs) <= 30);
  if (!navigateOnComplete) await page.waitForFunction(() => !document.querySelector('#completePanel').classList.contains('hidden'), null, { timeout: 30000 });
  check('saved playback cap is restored after exporting', await page.evaluate(() => window.__SMW.fpsCap === 30));
  if (!navigateOnComplete) await page.locator('#playAgainBtn').click();
  await page.locator('#exportEnabled').uncheck();
  await page.locator('#randomSongBtn').click();
  await page.getByRole('button', { name: `Play in ${world}`, exact: true }).click({ timeout: 120000 });
  await page.waitForFunction(() => window.__SMW?.sim && !window.__SMW.paused && window.__SMW.renderReadiness?.status === 'ready');
  const secondName = await page.evaluate(() => window.__SMW.trackIdentity?.title);
  check('random song avoids immediately repeating the last library track', !path.basename(file).startsWith(secondName?.replace(/\.wav$/, '') + ' -'));
  await page.locator('#stopBtn').click({ force: true });
  await page.locator('#exportEnabled').check();
  await page.locator('[data-export="fps"]').selectOption('60');
  await page.locator('#randomSongBtn').click();
  await page.getByRole('button', { name: `Export in ${world}`, exact: true }).click({ timeout: 120000 });
  await page.waitForFunction(() => window.__SMW?.renderReadiness?.status === 'ready' && !window.__SMW.paused);
  check('60 fps export overrides a saved 30 fps playback cap', await page.evaluate(() => window.__SMW.fpsCap === 60));
  let cancelledDownload = false;
  const onCancelledDownload = () => { cancelledDownload = true; }; page.on('download', onCancelledDownload);
  await page.locator('#cancelExportBtn').click({ force: true });
  await page.waitForTimeout(500);
  page.off('download', onCancelledDownload);
  check('cancel returns to the front screen without downloading a partial video', await page.locator('#randomSongBtn').isVisible() && !cancelledDownload);
  await page.locator('#exportEnabled').check();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, 'mobile-start.png'), fullPage: true });
  check('mobile layout has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('no uncaught page errors', errors.length === 0);
} catch (error) {
  report.failure = error.stack;
  report.page = await page.evaluate(() => ({ banner: document.querySelector('#errorBannerText')?.textContent,
    library: document.querySelector('#libraryPanel')?.textContent, recent: document.querySelector('#libraryRecent')?.textContent,
    files: [...document.querySelector('#libraryFolderInput').files].map(f => ({ name: f.name, path: f.webkitRelativePath, size: f.size })) })).catch(() => null);
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  report.errors = errors;
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
