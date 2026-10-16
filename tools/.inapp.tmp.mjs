// In-app frame per forced view (export mode, full scene with cast).
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { openSong, captureFrame } from './range-scene-smoke.mjs';
const [out, wav, t = '30000', ...ids] = process.argv.slice(2);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const id of ids) {
  const s = await openSong(browser, { url: 'http://127.0.0.1:8092', wav, width: 1280, height: 720, params: { rangeRenderer: 'v2', rangeView: id } });
  // The export clock only runs forward: draw the opening assembly out first
  // (it lasts ~1.3 s), then the evidence frame.
  for (const w of [0, 400, 800, 1200, 1600, 2000]) await s.page.evaluate((ms) => window.__SMW.renderExportFrame(ms), w);
  const f = await captureFrame(s.page, Number(t));
  await fs.writeFile(`${out}/${id}-${t}.png`, Buffer.from(f.png, 'base64'));
  console.log(id, 'active', f.range.active, f.range.viewId, f.range.reason || '', 'errors', s.errors.length ? s.errors.slice(0, 2) : 'none');
  await s.context.close();
}
await browser.close();
