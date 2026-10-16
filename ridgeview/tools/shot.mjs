// Render Ridgeview headlessly and save screenshots.
//   node tools/shot.mjs "<query>" out.png [--w 1280 --h 720 --wait 60 --script js]
// Uses the local tile proxy (?proxy=1) and waits for the terrain to settle.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createServer } from './serve.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const query = args[0] ?? '';
const out = args[1] ?? 'shot.png';
const W = Number(opt('w', 1280)), H = Number(opt('h', 720)), waitS = Number(opt('wait', 90));

const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => fs.existsSync(p));

export async function shoot({ query, out, W = 1280, H = 720, waitS = 90, script = null, keepOpen = false }) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) logs.push(`http ${r.status()}: ${r.url()}`); });
  const url = `http://127.0.0.1:${port}/?proxy=1&test=1&${query}`;
  await page.goto(url);
  const t0 = Date.now();
  let stable = 0, info = null, lastFrame = -1;
  while (Date.now() - t0 < waitS * 1000) {
    await page.waitForTimeout(1000);
    info = await page.evaluate(() => {
      const e = window.__rv?.engine;
      if (!e) return null;
      return { frame: e.frameNo, wanted: e.tiles.stats.wanted, drawn: e.tiles.stats.drawn, built: e.tiles.stats.built, building: e.tiles.jobs.size, queue: e.tiles.queue.length, dem: e.dem.queue.size + e.dem.inFlight, maxZ: e.tiles.stats.maxZ, exposure: e.exposure };
    }).catch(() => null);
    const idle = info && info.wanted === 0 && info.building === 0 && info.queue === 0 && info.dem === 0 && info.drawn > 0;
    // Only count checks that saw new frames: slow software GL can sit between frames.
    if (!idle) stable = 0;
    else if (info.frame > lastFrame) { stable++; lastFrame = info.frame; }
    if (stable >= 3) break;
  }
  if (script) await page.evaluate(script);
  await page.evaluate(() => { window.__rv.paused = true; });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__rv.still());
  await page.screenshot({ path: out, timeout: 180000 });
  if (!keepOpen) { await browser.close(); server.close(); }
  return { info, logs, seconds: (Date.now() - t0) / 1000, page, browser, server };
}

if (process.argv[1]?.endsWith('shot.mjs')) {
  const r = await shoot({ query, out, W, H, waitS, script: opt('script', null) });
  console.log(JSON.stringify(r.info), `${r.seconds.toFixed(1)} s`);
  for (const l of r.logs.slice(0, 30)) console.log(l.slice(0, 600));
}
