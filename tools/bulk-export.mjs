// Bulk H.264 export. One song in, an MP4 per size and frame rate.
//
// The page steps the sim on the audio clock (see BulkExport.js and the
// bulkExport hooks in main.js) and posts each frame here as raw RGBA.
// ffmpeg muxes those frames with the source audio. Drawing is the slow
// part; 30fps is taken from a 60fps pass when both were asked for, because
// those frames fall on the same timestamps.
//
// Usage: node tools/bulk-export.mjs --help
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  AUDIO_EXTENSIONS, BULK_EXPORT_HELP, bulkFileName, evenExportSize,
  ffmpegRawArgs, frameCount, frameTimeMs, isAudioPath, parseBulkArgs,
  passesFor, songLabels,
} from '../src/render/BulkExport.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function assertFfmpeg(encoder) {
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const text = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  if (probe.error || probe.status !== 0) {
    throw new Error('ffmpeg is not on PATH. Install it, then run this again.');
  }
  const need = encoder === 'h264_nvenc' ? 'h264_nvenc' : 'libx264';
  if (!new RegExp(`\\b${need}\\b`).test(text)) {
    throw new Error(`This ffmpeg has no ${need} encoder, so it cannot write an H.264 MP4.`);
  }
}

async function collectInputs(inputs) {
  const files = [];
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && isAudioPath(entry.name)) files.push(full);
    }
  };
  for (const raw of inputs) {
    const full = path.resolve(raw);
    let st;
    try { st = await fs.stat(full); }
    catch { throw new Error(`Cannot read ${full}`); }
    if (st.isDirectory()) await walk(full);
    else if (isAudioPath(full)) files.push(full);
    else throw new Error(`${full} is not an audio file (${AUDIO_EXTENSIONS.join(', ')}).`);
  }
  files.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return files;
}

async function appIsUp(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
  return res.status < 500;
}

async function ensureApp(url) {
  try {
    if (await appIsUp(url)) return null;
  } catch { /* nothing is listening */ }
  const port = new URL(url).port || '80';
  const child = spawn(process.execPath, [path.join(root, 'tools', 'serve.js'), port], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    try {
      if (await appIsUp(url)) return child;
    } catch { /* still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`Could not reach the app at ${url}. Start it with npm start and rerun.`);
}

function readBody(req, { exact = 0, max = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error(`Frame is ${total} bytes; limit is ${max}.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) reject(new Error('Empty frame.'));
      else if (exact && buf.length !== exact) reject(new Error(`Frame is ${buf.length} bytes; expected ${exact}.`));
      else resolve(buf);
    });
    req.on('error', reject);
  });
}

function startFrameServer() {
  const session = { expected: 0, onFrame: async () => {} };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST' || new URL(req.url, 'http://127.0.0.1').pathname !== '/frame') {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const buf = await readBody(req, { exact: session.exact || 0, max: session.max || (20 * 1024 * 1024) });
      await session.onFrame(buf);
      res.writeHead(204);
      res.end();
    } catch (err) {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err?.message || String(err));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, session, url: `http://127.0.0.1:${port}/frame` });
    });
  });
}

function writeAll(stream, buf) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    stream.once('error', onError);
    const finish = () => {
      stream.off('error', onError);
      resolve();
    };
    if (stream.write(buf)) finish();
    else stream.once('drain', finish);
  });
}

function openEncoder(args) {
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let log = '';
  child.stderr.on('data', (chunk) => {
    log += chunk.toString();
    if (log.length > 24000) log = log.slice(-16000);
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}${log ? `\n${log.trim()}` : ''}`));
    });
  });
  return { child, closed };
}

function closeEncoder(enc) {
  if (!enc.child.stdin.destroyed) enc.child.stdin.end();
  return enc.closed;
}

async function pushExportFrame({ timeMs, url, width, height, jpeg }) {
  const t0 = performance.now();
  let frame = window.__SMW.renderExportFrame(timeMs);
  // Range v2 prepares each section's view as the song reaches it; a frame
  // drawn before its view was ready is drawn again once it is.
  if (await window.__SMW.rangeSettle?.()) frame = window.__SMW.renderExportFrame(timeMs);
  const drawn = performance.now();
  if (!frame?.presented) throw new Error('Export presentation did not complete.');
  if (frame.width !== width || frame.height !== height) {
    throw new Error(`stage is ${frame.width}×${frame.height}, wanted ${width}×${height}`);
  }
  const canvas = document.getElementById('stage');
  let body;
  let packed;
  if (jpeg) {
    // text/plain keeps the POST a simple request. The bytes are still a JPEG.
    body = await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the frame.'))), 'image/jpeg', 0.97);
    });
    packed = performance.now();
  } else {
    body = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    packed = performance.now();
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: jpeg ? { 'Content-Type': 'text/plain' } : undefined,
    body,
  });
  if (!res.ok) throw new Error(await res.text());
  return {
    drawMs: drawn - t0,
    readMs: packed - drawn,
    sendMs: performance.now() - packed,
  };
}

/** Wait for the page to arm export, or stop as soon as it reports it can't.
 *  An arming failure is not an uncaught error: the world-start variant
 *  fallback catches it, so the page records it in __SMW_EXPORT_ERROR
 *  instead. Without this the tool sat out the full ten-minute timeout. */
async function waitForExportReady(page) {
  await page.waitForFunction(
    () => window.__SMW?.exportReady === true || !!window.__SMW_EXPORT_ERROR,
    null,
    { timeout: 600000 },
  );
  const armError = await page.evaluate(() => window.__SMW_EXPORT_ERROR || null);
  if (armError) throw new Error(`Export could not start: ${armError}`);
}

async function loadSong(page, file, { lyrics }) {
  if (!lyrics) {
    await page.locator('#titleSettings').evaluate((node) => { node.open = true; });
    const grounding = page.locator('#lyricGroundingBtn');
    if (await grounding.count() && await grounding.getAttribute('aria-pressed') === 'true') {
      await grounding.click();
    }
  }
  await page.locator('#fileInput').setInputFiles(file);
  // The export page names its world (?experience=), so the song starts
  // straight in it without the chooser.
  await waitForExportReady(page);
  // Range v2 prepares its real-terrain view asynchronously; an export must
  // not bake legacy frames because the first ones arrived before it.
  await page.evaluate(() => window.__SMW.rangeReady?.());
  const info = await page.evaluate(() => ({
    durationMs: window.__SMW.durationMs,
    width: window.__SMW.exportSize.width,
    height: window.__SMW.exportSize.height,
    seed: window.__SMW.songSeed,
    worldId: window.__SMW.worldId,
    experience: window.__SMW.experience,
    worldKind: window.__SMW.sim?.biomes?.world?.kind || window.__SMW.worldId,
  }));
  if (!info?.durationMs) throw new Error('The song loaded with no duration.');
  return info;
}

function formatSeconds(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

async function renderPass({ page, session, frameUrl, pass, audioPath, outDir, label, durationMs, crf, preset, encoder }) {
  const { width, height } = pass.resolution;
  let info = await page.evaluate(() => ({
    width: window.__SMW.exportSize.width,
    height: window.__SMW.exportSize.height,
    durationMs: window.__SMW.durationMs,
  }));
  if (info.width !== width || info.height !== height) {
    info = await page.evaluate(
      (size) => window.__SMW.beginBulkExport(size),
      { width, height },
    );
    await page.evaluate(() => window.__SMW.rangeReady?.());
  }
  if (info.width !== width || info.height !== height) {
    throw new Error(`Stage is ${info.width}×${info.height}; ${pass.resolution.id} needs ${width}×${height}.`);
  }
  const songMs = Math.min(durationMs, info.durationMs || durationMs);
  const frames = frameCount(songMs, pass.drawFps);
  if (!(frames > 0)) throw new Error('Nothing to render.');

  const outputs = [];
  try {
    for (const output of pass.outputs) {
      const fileName = bulkFileName({ songName: label, resolutionId: pass.resolution.id, fps: output.fps });
      const outPath = path.join(outDir, fileName);
      const enc = openEncoder(ffmpegRawArgs({
        width, height, fps: output.fps, audioPath, outPath, crf, preset, encoder,
        pixels: encoder === 'h264_nvenc' ? 'jpeg' : 'raw',
      }));
      outputs.push({ ...output, outPath, enc, framesWritten: 0 });
    }
    const jpeg = encoder === 'h264_nvenc';
    session.exact = jpeg ? 0 : width * height * 4;
    session.max = jpeg ? 20 * 1024 * 1024 : session.exact;
    let frameIndex = 0;
    session.onFrame = async (buf) => {
      const index = frameIndex;
      for (const output of outputs) {
        if (index % output.every !== 0) continue;
        if (output.enc.child.exitCode != null) {
          throw new Error(`ffmpeg closed early while writing ${path.basename(output.outPath)}.`);
        }
        await writeAll(output.enc.child.stdin, buf);
        output.framesWritten++;
      }
      frameIndex++;
    };

    const started = Date.now();
    const timing = { drawMs: 0, readMs: 0, sendMs: 0, n: 0 };
    console.log(`  ${pass.resolution.id}  ${frames} frames at ${pass.drawFps}fps  →  ${outputs.map((o) => `${o.fps}fps`).join(', ')}`);
    for (let i = 0; i < frames; i++) {
      const sample = await page.evaluate(pushExportFrame, {
        timeMs: frameTimeMs(i, pass.drawFps),
        url: frameUrl,
        width,
        height,
        jpeg: encoder === 'h264_nvenc',
      });
      if (sample) {
        timing.drawMs += sample.drawMs;
        timing.readMs += sample.readMs;
        timing.sendMs += sample.sendMs;
        timing.n++;
      }
      const mark = i === frames - 1 || i % pass.drawFps === 0;
      if (mark) {
        const elapsed = (Date.now() - started) / 1000;
        const done = i + 1;
        const eta = done > 0 ? ((frames - done) * elapsed / done) : 0;
        const n = timing.n || 1;
        const pace = `draw ${(timing.drawMs / n).toFixed(0)}ms  read ${(timing.readMs / n).toFixed(0)}ms  send ${(timing.sendMs / n).toFixed(0)}ms`;
        console.log(`    ${formatSeconds(frameTimeMs(i, pass.drawFps))} / ${formatSeconds(songMs)}   ${eta.toFixed(0)}s left   ${pace}`);
      }
    }
    session.onFrame = async () => { throw new Error('Export frame arrived after the pass finished.'); };
    for (const output of outputs) {
      await closeEncoder(output.enc);
      const st = await fs.stat(output.outPath);
      console.log(`    wrote ${path.basename(output.outPath)}  (${(st.size / 1048576).toFixed(1)} MB, ${output.framesWritten} frames)`);
    }
  } catch (err) {
    session.onFrame = async () => { throw new Error('Export session failed.'); };
    for (const output of outputs) {
      try { output.enc.child.kill(); } catch { /* already gone */ }
      await output.enc.closed.catch(() => {});
      try { await fs.unlink(output.outPath); } catch { /* never created */ }
    }
    throw err;
  }
}

async function main() {
  const opts = parseBulkArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(BULK_EXPORT_HELP);
    return;
  }
  if (!opts.inputs.length) {
    console.log(BULK_EXPORT_HELP);
    throw new Error('Name at least one audio file or folder.');
  }
  assertFfmpeg(opts.encoder);
  const files = await collectInputs(opts.inputs);
  if (!files.length) throw new Error('No audio files found.');
  const labels = songLabels(files);
  const passes = passesFor(opts.resolutions, opts.frameRates);
  const outDir = path.resolve(opts.out);
  await fs.mkdir(outDir, { recursive: true });

  const fileCount = files.length;
  const rateList = opts.frameRates.join(' and ');
  console.log(`${fileCount} song${fileCount === 1 ? '' : 's'}  →  ${opts.resolutions.join(', ')} at ${rateList} fps`);
  console.log(`Output: ${outDir}`);
  if (opts.frameRates.includes(60) && opts.frameRates.includes(30)) {
    console.log('30fps files keep every other frame of the 60fps draw.');
  }
  if (opts.maxSeconds != null) console.log(`Each file stops at ${opts.maxSeconds}s.`);

  const serverChild = await ensureApp(opts.url);
  const sink = await startFrameServer();
  let browser = null;
  const stop = async () => {
    try { await browser?.close(); } catch { /* shutting down */ }
    try { sink.server.close(); } catch { /* shutting down */ }
    try { serverChild?.kill(); } catch { /* not ours */ }
  };
  process.once('SIGINT', () => { stop().finally(() => process.exit(1)); });

  try {
    // MIDIO_EXPORT_CHROME=1 uses the installed Chrome build. Playwright's
    // bundled headless shell software-rasterizes, and a 2160p frame is
    // then most of the cost of a long batch.
    const useChrome = process.env.MIDIO_EXPORT_CHROME === '1';
    const launch = {};
    if (useChrome) {
      launch.channel = 'chrome';
      launch.args = [
        '--use-angle=d3d11',
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
      ];
    } else if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
      launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    }
    browser = await chromium.launch(launch);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 780 },
      deviceScaleFactor: 1,
    });
    // Abort off-machine lookups only. A catch-all route would also proxy
    // the frame posts through Playwright, and a 2160p frame is 33MB.
    if (!opts.lyrics) {
      await context.route(/^https:\/\//, (route) => route.abort());
    }
    const page = await context.newPage();
    page.setDefaultTimeout(600000);
    page.on('pageerror', (err) => console.log(`  page: ${err.message}`));

    const first = passes[0].resolution;
    for (let n = 0; n < files.length; n++) {
      const file = files[n];
      console.log(`\n${labels[n]}`);
      const entry = new URL(opts.url);
      entry.searchParams.set('bulkExport', '1');
      entry.searchParams.set('experience', opts.experience);
      entry.searchParams.set('exportW', String(first.width));
      entry.searchParams.set('exportH', String(first.height));
      if (opts.seed != null) entry.searchParams.set('seed', String(opts.seed));
      if (opts.presentation) await page.addInitScript(prefs => localStorage.setItem('midio-pixel:display:v1', JSON.stringify(prefs)), opts.presentation);
      await page.goto(entry.href);
      const info = await loadSong(page, file, opts);
      const durationMs = opts.maxSeconds != null
        ? Math.min(info.durationMs, opts.maxSeconds * 1000)
        : info.durationMs;
      const worldLabel = info.experience === 'trio' ? 'Trio' : info.worldKind && info.worldKind !== info.worldId
        ? `${info.worldKind} (${info.worldId})`
        : (info.worldKind || info.worldId);
      console.log(`  world ${worldLabel}   seed ${info.seed}   ${formatSeconds(info.durationMs)}`);
      const size = evenExportSize({ w: info.width, h: info.height });
      if (!size || size.w !== first.width || size.h !== first.height) {
        throw new Error(`First pass opened at ${info.width}×${info.height}; expected ${first.width}×${first.height}.`);
      }
      for (const pass of passes) {
        await renderPass({
          page,
          session: sink.session,
          frameUrl: sink.url,
          pass,
          audioPath: file,
          outDir,
          label: labels[n],
          durationMs,
          crf: opts.crf,
          preset: opts.preset,
          encoder: opts.encoder,
        });
      }
    }
  } finally {
    await stop();
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exitCode = 1;
});
