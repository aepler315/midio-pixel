// Real Chromium upload/analysis/session/UI regression. Routes only provider
// fixtures and read-only observations/private UI entrypoints in served modules.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:8096';
const cases = process.argv.slice(3);
function wav(title, seconds = 12) {
  const count = 16000 * seconds, b = Buffer.alloc(44 + count * 2 + 128);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) b.writeInt16LE(Math.round(3000 * Math.sin(i / 16000 * Math.PI * 440)), 44 + i * 2);
  if (title) { b.write('TAG', b.length - 128); b.write(title, b.length - 125); b.write('Audit Artist', b.length - 95); }
  return b;
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
let failures = 0;
try {
  for (const mode of (cases.length ? cases : ['immediate', 'late', 'failure', 'timeout', 'disabled', 'pending-fail', 'pending-cancel', 'paused', 'replacement', 'source', 'untagged', 'stem', 'long'])) {
    const context = await browser.newContext({ viewport: { width: 960, height: 540 }, acceptDownloads: true });
    console.log(`RUN ${mode}`);
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const requests = [];
    let holding = false;
    let releaseLyrics, releaseDownload;
    const delayed = ['late', 'pending-fail', 'pending-cancel', 'paused', 'replacement'].includes(mode);
    const lyricGate = new Promise(r => { releaseLyrics = r; });
    const downloadGate = new Promise(r => { releaseDownload = r; });
    await page.route('**/src/main.js*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: await response.text() + '\nwindow.__lyricProbe = { loadUrlAudio, cancelUrlLoad, handleFiles, startRecording, finishRecording, togglePause, get recording() { return !!songRecorder?.recording; }, get data() { return lastTimelineData; } };' });
    });
    await page.route('**/src/render/VideoExport.js*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("export function exportFileName({ songName = 'song', presetId = '', ext = 'mp4', date = new Date() } = {}) {", "$&\n globalThis.__exportNameInput = songName;") });
    });
    await page.route('**/lrclib.net/**', async route => {
      requests.push({ url: route.request().url(), at: Date.now() });
      if (holding) await lyricGate;
      if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 4500));
      const record = {
        trackName: 'Tagged Audit Title', artistName: 'Audit Artist', duration: 12,
        syncedLyrics: '[00:00.00]old star\n[00:04.00]heart\n[00:08.00]moon',
      };
      await route.fulfill(mode === 'failure' ? { status: 500, body: 'provider failed' } : { json: route.request().url().includes('/search?') ? [record] : record }).catch(() => {});
    });
    await page.route('**/pending.wav', async route => { await downloadGate; await route.fulfill({ status: 500, body: 'failed download' }).catch(() => {}); });
    try {
      await page.goto(url + '/?renderer=canvas&rangeRenderer=legacy&experience=landscape', { waitUntil: 'domcontentloaded', timeout: 90000 });
      // DOM readiness precedes module evaluation; uploads must wait for the
      // actual loader listeners and the instrumented ownership entrypoints.
      await page.waitForFunction(() => typeof window.__lyricProbe?.handleFiles === 'function', null, { timeout: 45000 });
      if (mode === 'disabled') await page.locator('#lyricGroundingBtn').evaluate(e => e.click());
      const buffer = wav(mode === 'untagged' ? '' : 'Tagged Audit Title', mode === 'long' ? 36 : 12);
      if (delayed) {
        // Prime the real IndexedDB analysis cache so the controlled late
        // lookup starts near playback even on a heavily loaded CI host.
        await page.locator('#fileInput').setInputFiles({ name: 'raw-filename.wav', mimeType: 'audio/wav', buffer });
        await page.waitForFunction(() => !!window.__SMW?.sim, null, { timeout: 45000 });
        await page.waitForTimeout(300);
        await page.evaluate(() => {
          window.__primedSim = window.__SMW.sim;
          for (const key of Object.keys(localStorage)) if (key.startsWith('smw:lyrics:')) localStorage.removeItem(key);
        });
        holding = true;
      }
      if (mode === 'source') {
        await page.evaluate(async bytes => {
          const file = new File([new Uint8Array(bytes)], 'raw-filename.wav', { type: 'audio/wav' });
          await window.__lyricProbe.handleFiles([file], { sourceMetadata: { provider: 'plex', id: 'plex:audit:1', revision: '1', title: 'Source Title', artist: 'Source Artist' } });
        }, [...buffer]);
      } else await page.locator('#fileInput').setInputFiles(mode === 'stem'
        ? [{ name: 'vocals.wav', mimeType: 'audio/wav', buffer }, { name: 'drums.wav', mimeType: 'audio/wav', buffer }]
        : { name: 'raw-filename.wav', mimeType: 'audio/wav', buffer });
      await page.waitForFunction(() => !!window.__SMW?.sim && window.__SMW.sim !== window.__primedSim, null, { timeout: 45000 });
      console.log(`READY ${mode}`);
      const title = mode === 'source' ? 'Source Title' : mode === 'untagged' ? 'raw-filename' : 'Tagged Audit Title';
      assert.equal(await page.evaluate(() => window.__SMW.trackIdentity?.title), title, 'local identity published before optional lookup');
      if (delayed) {
        await page.evaluate(() => { window.__beforeLyrics = { sim: window.__SMW.sim, camera: window.__SMW.sim.camera, audio: window.__SMW.audioEngine, sections: window.__SMW.sim.biomes.sections.map(s => ({ startMs: s.startMs, profile: s.profile })) }; });
        if (mode.startsWith('pending-')) await page.evaluate(() => { window.__pendingB = window.__lyricProbe.loadUrlAudio(location.origin + '/pending.wav'); });
        if (mode === 'pending-fail') { releaseDownload(); await page.evaluate(() => window.__pendingB); }
        if (mode === 'pending-cancel') await page.evaluate(() => window.__lyricProbe.cancelUrlLoad());
        if (mode === 'replacement') {
          await page.locator('#lyricGroundingBtn').evaluate(e => e.click());
          await page.locator('#fileInput').setInputFiles({ name: 'replacement.wav', mimeType: 'audio/wav', buffer: wav('Replacement Title') });
          await page.waitForFunction(() => window.__SMW.trackIdentity?.title === 'Replacement Title');
          releaseLyrics();
          await page.waitForTimeout(300);
          assert.equal(await page.evaluate(() => window.__SMW.trackIdentity.title), 'Replacement Title');
          assert.equal(await page.evaluate(() => window.__SMW.sim.biomes._syncedLyrics), null);
          assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('smw:lyrics:') && key.includes('tagged audit title'))), false, 'retired request cannot repopulate lyric cache');
          console.log('PASS replacement retires A'); continue;
        }
        if (mode === 'paused') await page.evaluate(() => window.__lyricProbe.togglePause());
        releaseLyrics();
        await page.waitForFunction(() => window.__SMW.sim.biomes._syncedLyrics?.length === 3, null, { timeout: 5000 });
        assert.deepEqual(await page.evaluate(() => [window.__SMW.sim === window.__beforeLyrics.sim, window.__SMW.sim.camera === window.__beforeLyrics.camera, window.__SMW.audioEngine === window.__beforeLyrics.audio]), [true, true, true]);
        const boundary = await page.evaluate(() => window.__lyricProbe.data.lyricSession.admissions[0].heardTimeMs);
        assert.ok(boundary > 0);
        if (mode === 'paused') {
          assert.equal(await page.evaluate(() => window.__SMW.audioEngine.ctx.state), 'suspended');
          await page.evaluate(() => window.__lyricProbe.togglePause());
        }
        await page.evaluate(() => window.__SMW.seek(0));
        assert.equal(await page.evaluate(() => window.__SMW.sim.biomes._syncedLyrics), null);
        await page.evaluate(t => window.__SMW.seek(t + 100), boundary);
        assert.equal(await page.evaluate(() => window.__SMW.sim.biomes._syncedLyrics.length), 3);
      }
      if (['failure', 'timeout', 'disabled'].includes(mode)) assert.equal(await page.evaluate(() => window.__SMW.sim.biomes._syncedLyrics), null);
      if (['immediate', 'source', 'untagged', 'stem', 'long'].includes(mode)) assert.equal(await page.evaluate(() => window.__SMW.sim.biomes._syncedLyrics?.length), 3);
      console.log(`ADOPTED ${mode}`);
      // Exercise actual recording completion and the actual exportFileName input.
      await page.evaluate(() => { window.__SMW.seek(0); window.__lyricProbe.startRecording('landscape-720'); });
      await page.waitForFunction(() => window.__lyricProbe.recording, null, { timeout: 15000 });
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.__lyricProbe.finishRecording());
      await page.waitForFunction(() => window.__exportNameInput, null, { timeout: 15000 });
      assert.equal(await page.evaluate(() => window.__exportNameInput), title);
      console.log(`RECORDED ${mode}`);
      await page.evaluate(() => window.__SMW.seek(window.__SMW.durationMs - 100));
      await page.locator('#completePanel').waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await page.locator('#completeSongName').textContent(), title);
      assert.deepEqual(errors, []);
      console.log(`PASS ${mode}: identity, live/history policy, actual Complete and export filename input`);
    } catch (e) { failures++; console.error(`FAIL ${mode}: ${e.stack}`, requests, await page.evaluate(() => ({ identity: window.__SMW?.trackIdentity, admissions: window.__lyricProbe?.data?.lyricSession, lyrics: window.__SMW?.sim.biomes._syncedLyrics, time: window.__SMW?.sim.heardTimeMs, now: Date.now() })).catch(() => null)); }
    finally { releaseLyrics(); releaseDownload(); await context.close(); }
  }
} finally { await browser.close(); }
process.exitCode = failures ? 1 : 0;
