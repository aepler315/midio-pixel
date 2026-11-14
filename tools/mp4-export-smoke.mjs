// Real browser encoders + ffprobe, independent of song analysis/terrain.
// node tools/mp4-export-smoke.mjs [--out NEW_DIR] [--quick] [--channel chrome]
// Default: six sizes × 30/60 fps, plus transactional direct-file checks.
// This tests codec plumbing; it does not establish song visuals or live FPS.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serveSnapshot } from './lib/visual-evaluation-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DURATION_SECONDS = .1;

async function encodeCase({ resolutionId, fps, direct = false }) {
  const { resolveMp4ExportSettings, exportMp4 } = await import('/src/render/Mp4Export.js');
  const settings = resolveMp4ExportSettings({ resolutionId, fps });
  const canvas = document.querySelector('canvas');
  canvas.width = settings.width; canvas.height = settings.height;
  const ctx = canvas.getContext('2d');
  const audioBuffer = new AudioBuffer({ length: 4800, sampleRate: 48000, numberOfChannels: 2 });
  for (let ch = 0; ch < 2; ch++) {
    const samples = audioBuffer.getChannelData(ch);
    for (let i = 0; i < samples.length; i++) samples[i] = .2 * Math.sin(2 * Math.PI * (ch ? 660 : 440) * i / 48000);
  }
  let directory, handle;
  if (direct) {
    directory = await navigator.storage.getDirectory();
    handle = await directory.getFileHandle('midio-export-smoke.mp4', { create: true });
  }
  const renderFrame = async ms => {
    ctx.fillStyle = '#245599'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(ms / 100 * canvas.width, 0, canvas.width / 10, canvas.height);
    return { presented: true, width: canvas.width, height: canvas.height };
  };
  try {
    const result = await exportMp4({ canvas, audioBuffer, settings, renderFrame,
      writable: direct ? await handle.createWritable() : null });
    if (direct && result.blob !== null) throw new Error('Direct file unexpectedly returned an in-memory movie.');
    const blob = direct ? await handle.getFile() : result.blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    let cancelRolledBack = null;
    if (direct) {
      // An aborted overwrite must keep the completed file byte-for-byte.
      const controller = new AbortController();
      let rejected = false;
      try {
        await exportMp4({ canvas, audioBuffer, settings, signal: controller.signal,
          writable: await handle.createWritable(), renderFrame: async ms => {
            if (ms > 0) controller.abort();
            return renderFrame(ms);
          } });
      } catch (error) { if (error.name !== 'AbortError') throw error; rejected = true; }
      if (!rejected) throw new Error('Cancelled export unexpectedly completed.');
      const after = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      cancelRolledBack = bytes.length === after.length && bytes.every((byte, i) => byte === after[i]);
      if (!cancelRolledBack) throw new Error('Cancelled direct export committed a partial file.');
    }
    return { width: result.width, height: result.height, frames: result.frames, bytes: bytes.byteLength,
      direct, cancelRolledBack, base64: btoa(binary) };
  } finally {
    if (directory) await directory.removeEntry('midio-export-smoke.mp4');
  }
}

function verifyMovie(file, row, fps) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { encoding: 'utf8', windowsHide: true }));
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video?.codec_name, 'h264'); assert.equal(audio?.codec_name, 'aac');
  assert.equal(video.width, row.width); assert.equal(video.height, row.height);
  assert.equal(video.avg_frame_rate, `${fps}/1`); assert.equal(Number(video.nb_frames), row.frames);
  assert.equal(row.frames, fps * DURATION_SECONDS);
  assert.equal(audio.sample_rate, '48000'); assert.equal(audio.channels, 2);
  assert.ok(Number(audio.duration) >= DURATION_SECONDS && Number(audio.duration) < DURATION_SECONDS + 1024 / 48000);
  return { video: { codec: video.codec_name, rate: video.avg_frame_rate, frames: video.nb_frames, duration: video.duration },
    audio: { codec: audio.codec_name, duration: audio.duration, channels: audio.channels } };
}

export async function runMp4ExportSmoke({ outDir, quick = false, channel = 'chrome' } = {}) {
  const out = path.resolve(outDir || path.join(root, '.smoke', `mp4-export-${Date.now()}`));
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(out); // Evidence directories are new; never overwrite a run.
  const files = new Map([['/index.html', Buffer.from('<!doctype html><title>MP4 encoder smoke</title><canvas></canvas>')]]);
  for (const name of ['src/render/Mp4Export.js', 'src/vendor/export/mediabunny.module.js']) {
    files.set('/' + name, await fs.readFile(path.join(root, name)));
  }
  const server = await serveSnapshot({ files });
  let browser;
  const report = { scope: 'Synthetic 100ms moving canvas and stereo 440/660Hz PCM; codec/dimensions/cadence/file transactions only. No song visual or live performance claim.',
    browser: null, channel, recordings: [], directFile: null, pass: false };
  try {
    const launch = { headless: true, args: ['--mute-audio'] };
    if (channel !== 'chromium') launch.channel = channel;
    if (process.env.PLAYWRIGHT_CHROMIUM_PATH) { delete launch.channel; launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH; }
    browser = await chromium.launch(launch);
    report.browser = browser.version();
    const page = await browser.newPage();
    await page.goto(server.url);
    for (const resolutionId of quick ? ['360p'] : ['360p', '480p', '720p', '1080p', '1440p', '2160p']) {
      for (const fps of [30, 60]) {
        const row = await page.evaluate(encodeCase, { resolutionId, fps });
        const name = `${resolutionId}-${fps}.mp4`, file = path.join(out, name);
        await fs.writeFile(file, Buffer.from(row.base64, 'base64')); delete row.base64;
        report.recordings.push({ name, ...row, ...verifyMovie(file, row, fps) });
        console.log(`${name}: ${row.width}×${row.height}, ${row.frames} frames, H.264/AAC`);
      }
    }
    const direct = await page.evaluate(encodeCase, { resolutionId: '360p', fps: 30, direct: true });
    const file = path.join(out, 'direct-file.mp4');
    await fs.writeFile(file, Buffer.from(direct.base64, 'base64')); delete direct.base64;
    report.directFile = { ...direct, ...verifyMovie(file, direct, 30) };
    report.pass = true;
    console.log('Direct file encoding and cancellation rollback passed.');
  } catch (error) {
    report.error = error.stack;
    throw error;
  } finally {
    await browser?.close();
    await server.close();
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return { out, report };
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--quick') options.quick = true;
    else if (args[i] === '--out') options.outDir = args[++i];
    else if (args[i] === '--channel') options.channel = args[++i];
    else throw new Error(`Unknown option ${args[i]}`);
  }
  const result = await runMp4ExportSmoke(options);
  console.log(`MP4 export smoke report: ${path.join(result.out, 'report.json')}`);
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url))) {
  await main();
}
