// Range v2 candidate review: render baked views through their real camera
// rail with the diagnostic viewer (src/dev/range-scene-review.html) and
// write per-station frames, a contact sheet and a JSON report.
//
//   node tools/review-range-views.mjs --views <id,id|all> [--stations 5|21]
//        [--modes neutral,silhouette,depth] [--out DIR] [--source cache|published]
//        [--width 1280 --height 720] [--budget desktop|mobile]
//
// Automatic measurements (terrain coverage, skyline shape, flat-wall runs,
// internal relief) are diagnostics that support a recorded visual judgment;
// they never approve a view by themselves.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.gz': 'application/gzip', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** A loopback static server: /src from the repo, /views/<id>/ from a view dir. */
const viewRecords = new Map();

/** Whether `file` lies strictly inside directory `base`. */
export function isInside(base, file) {
  const rel = path.relative(base, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
export function startReviewServer(viewDirFor) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let file = null;
      if (url.pathname.startsWith('/review-view/')) {
        const rec = viewRecords.get(decodeURIComponent(url.pathname.slice('/review-view/'.length)));
        if (!rec) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(rec);
        return;
      }
      // Resolve after decoding and require the result to stay under its
      // root: an encoded slash (..%2f) would otherwise escape it.
      let base = null;
      if (url.pathname.startsWith('/src/')) {
        base = path.join(root, 'src');
        file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      } else if (url.pathname.startsWith('/views/')) {
        const [, , id, ...rest] = url.pathname.split('/');
        base = path.resolve(viewDirFor(decodeURIComponent(id)));
        file = path.resolve(base, ...rest.map(decodeURIComponent));
      }
      if (!file || !isInside(base, file)) { res.writeHead(404); res.end(); return; }
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/** Diagnostics from a silhouette frame (black terrain on white sky). */
function silhouetteMetrics(rgba, width, height) {
  const skyline = new Float32Array(width);
  let terrain = 0;
  for (let x = 0; x < width; x++) {
    let top = height;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      if (rgba[i] < 128) { if (top === height) top = y; terrain++; }
    }
    skyline[x] = top / height;
  }
  // Longest run of columns whose skyline stays within 1.5% of frame height
  // of the run's start while sitting in the upper half: a "flat wall".
  let wall = 0;
  for (let x = 0; x < width;) {
    let e = x + 1;
    while (e < width && Math.abs(skyline[e] - skyline[x]) < 0.015) e++;
    if (skyline[x] < 0.5) wall = Math.max(wall, (e - x) / width);
    x = e;
  }
  let lo = 1, hi = 0, rough = 0;
  for (let x = 0; x < width; x++) {
    lo = Math.min(lo, skyline[x]); hi = Math.max(hi, skyline[x]);
    if (x) rough += Math.abs(skyline[x] - skyline[x - 1]);
  }
  return { terrainCoverage: terrain / (width * height), skylineTop: lo, skylineBottom: hi, skylineRange: hi - lo, skylineTravel: rough, flatWallRun: wall };
}

/** Internal relief: luminance spread inside the terrain of a neutral frame. */
function reliefMetrics(neutral, silhouette, width, height) {
  let n = 0, sum = 0, sum2 = 0, edges = 0;
  for (let y = 1; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const i = (y * width + x) * 4;
      if (silhouette[i] >= 128) continue;
      const l = 0.3 * neutral[i] + 0.59 * neutral[i + 1] + 0.11 * neutral[i + 2];
      const lx = 0.3 * neutral[i - 4] + 0.59 * neutral[i - 3] + 0.11 * neutral[i - 2];
      n++; sum += l; sum2 += l * l;
      if (Math.abs(l - lx) > 10) edges++;
    }
  }
  const mean = n ? sum / n : 0;
  return { reliefStd: n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0, reliefEdgeDensity: n ? edges / n : 0 };
}

async function pagePixels(page) {
  return page.evaluate(() => {
    const src = document.querySelector('canvas');
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    return { png: c.toDataURL('image/png').split(',')[1], rgba: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
  });
}

async function contactSheet(files, cols, out, labels) {
  // Pillow is available alongside GDAL; keep the sheet simple and labelled.
  const py = process.env.MIDIO_GDAL_PYTHON || '/usr/bin/python3.12';
  const script = `
import json, sys
from PIL import Image, ImageDraw
files, cols, out, labels = json.loads(sys.argv[1]), int(sys.argv[2]), sys.argv[3], json.loads(sys.argv[4])
ims = [Image.open(f).convert('RGB') for f in files]
w, h = ims[0].size
scale = 480 / w
tw, th = int(w * scale), int(h * scale)
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * tw, rows * (th + 18)), (24, 26, 30))
d = ImageDraw.Draw(sheet)
for k, im in enumerate(ims):
    x, y = (k % cols) * tw, (k // cols) * (th + 18)
    sheet.paste(im.resize((tw, th)), (x, y + 18))
    d.text((x + 4, y + 3), labels[k], fill=(230, 230, 230))
sheet.save(out, quality=88)
`;
  execFileSync(py, ['-c', script, JSON.stringify(files), String(cols), out, JSON.stringify(labels)]);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const source = opt('--source', 'cache');
  const viewDirFor = (id) => (source === 'published' ? path.join(root, 'src', 'assets', 'range', 'v2', 'terrain') : path.join(root, '.terrain-cache', 'views', id));
  const authoring = JSON.parse(await fs.readFile(path.join(root, 'data', 'terrain', 'scenic-views.json'), 'utf8'));
  const wanted = opt('--views', 'all');
  const ids = wanted === 'all' ? authoring.views.map((v) => v.id) : wanted.split(',');
  const stations = Number(opt('--stations', '5'));
  const modes = opt('--modes', 'neutral,silhouette,depth').split(',');
  const width = Number(opt('--width', '1280')), height = Number(opt('--height', '720'));
  const budget = opt('--budget', 'desktop');
  const out = path.resolve(opt('--out', path.join(root, '.smoke', 'range-review')));
  await fs.mkdir(out, { recursive: true });
  const { server, port } = await startReviewServer(viewDirFor);
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const report = { width, height, stations, modes, budget, browser: browser.version(), renderer: 'SwiftShader (software) unless noted', views: [] };
  try {
    for (const id of ids) {
      const dir = viewDirFor(id);
      const build = JSON.parse(await fs.readFile(path.join(dir, `${id}.build.json`), 'utf8'));
      const manifestBuf = await fs.readFile(path.join(dir, `${id}.terrain.json`));
      // The page reads the view record from the review server, not the
      // asset tree: never write review files into src/assets.
      viewRecords.set(id, JSON.stringify(build.view));
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const q = new URLSearchParams({ manifest: `/views/${id}/${id}.terrain.json`, view: `/review-view/${id}`, budget });
      const pack = opt('--material', null);
      if (pack) q.set('material', `/src/assets/range/v2/materials/${pack}.json`);
      for (const k of ['lightDir', 'lightScale', 'airDensity', 'exposure', 'ambient', 'debugMask']) if (opt(`--${k}`)) q.set(k, opt(`--${k}`));
      await page.goto(`http://127.0.0.1:${port}/src/dev/range-scene-review.html?${q}`);
      await page.waitForFunction(() => window.__review?.ready || window.__review?.error, null, { timeout: 600000 });
      const err = await page.evaluate(() => window.__review.error);
      if (err) throw new Error(`${id}: ${err}`);
      const record = {
        id, manifestSha256: sha(manifestBuf), payloadSha256: build.payloadSha256, cameraSha256: sha(JSON.stringify(build.view.camera)),
        sourceHashes: build.sourceSha256 || [], landmarks: build.landmarks, stats: await page.evaluate(() => window.__review.stats),
        stations: [], pageErrors: errors,
      };
      const files = [], labels = [];
      for (let k = 0; k < stations; k++) {
        const u = stations > 1 ? k / (stations - 1) : 0;
        const perMode = {};
        for (const mode of modes) {
          const r = await page.evaluate((o) => window.__review.render(o), { progress: u, mode, width, height });
          const px = await pagePixels(page);
          const file = path.join(out, `${id}-s${String(k).padStart(2, '0')}-${mode}.png`);
          await fs.writeFile(file, Buffer.from(px.png, 'base64'));
          perMode[mode] = { file: path.relative(root, file), ms: Math.round(r.ms), rgba: px.rgba };
          files.push(file); labels.push(`${id} u=${u.toFixed(2)} ${mode}`);
        }
        const sil = perMode.silhouette?.rgba;
        if (!sil) { for (const m of Object.values(perMode)) delete m.rgba; record.stations.push({ progress: u, frames: perMode, metrics: {} }); continue; }
        const metrics = sil ? { ...silhouetteMetrics(sil, width, height), ...(perMode.neutral ? reliefMetrics(perMode.neutral.rgba, sil, width, height) : {}) } : {};
        for (const m of Object.values(perMode)) delete m.rgba;
        record.stations.push({ progress: u, frames: perMode, metrics });
      }
      await page.close();
      const sheet = path.join(out, `${id}-contact.jpg`);
      await contactSheet(files, modes.length, sheet, labels);
      record.contactSheet = path.relative(root, sheet);
      report.views.push(record);
      const m = record.stations.map((s) => s.metrics);
      console.log(`${id}: ${record.stats.triangles} tris; coverage ${m.map((x) => x.terrainCoverage?.toFixed(2)).join(' ')}; wall ${m.map((x) => x.flatWallRun?.toFixed(2)).join(' ')}; relief ${m.map((x) => x.reliefStd?.toFixed(1)).join(' ')}; ${record.stations.map((s) => s.frames.neutral?.ms).join('/')}ms`);
    }
  } finally {
    await browser.close();
    server.close();
    await fs.writeFile(path.join(out, 'review-report.json'), JSON.stringify(report, null, 1));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
