#!/usr/bin/env node
// Controlled Canvas2D oracle, not a Landscape FPS or hardware-GPU benchmark.
// Isolated, headless, muted; reports and PNGs stay in the requested .smoke dir.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build, transform } from 'esbuild';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = { baseline: 'a12a641', out: '.smoke/ridge-output-regression', frames: 0 };
const options = { '--baseline': 'baseline', '--out': 'out', '--browser': 'browser', '--timing-frames': 'frames', '--cpu-canvas': 'cpuCanvas' };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--help' || flag === '-h') {
    console.log('node tools/ridge-output-regression.mjs [--baseline a12a641] [--out .smoke/ridge-output-regression] [--browser FILE] [--timing-frames 0..120] [--cpu-canvas /absolute/path/to/@napi-rs/canvas]\nRuns exact baseline/current Canvas2D pixel comparisons, an independent neighbor-mean oracle, width/gap/occlusion checks, and optional explicitly software-only submission/flush timings. CPU Skia fallback is separately labeled and does not establish browser/GPU behavior.');
    process.exit(0);
  }
  assert.ok(options[flag], `unknown option: ${flag}`);
  const value = process.argv[++i];
  assert.ok(value && !value.startsWith('--'), `${flag} requires a value`);
  args[options[flag]] = value;
}
args.frames = Number(args.frames);
assert.ok(Number.isInteger(args.frames) && args.frames >= 0 && args.frames <= 120, 'timing-frames must be an integer from 0 through 120');
const out = path.resolve(root, args.out);
await fs.mkdir(out, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const helperPath = path.join(root, 'src/render/CrestPixelColors.js');
const rendererPath = path.join(root, 'src/world/alpine/RangeCrest.js');
const baselineSource = execFileSync('git', ['show', `${args.baseline}:src/render/CrestPixelColors.js`], { cwd: root, encoding: 'utf8' });
const baselineCommit = execFileSync('git', ['rev-parse', args.baseline], { cwd: root, encoding: 'utf8' }).trim();
const [helperSource, rendererSource] = await Promise.all([fs.readFile(helperPath), fs.readFile(rendererPath)]);
const [currentBundle, baselineBundle] = await Promise.all([
  build({ stdin: { contents: 'export { RangeCrest } from "./src/world/alpine/RangeCrest.js"; export { CrestColorPattern } from "./src/render/CrestPixelColors.js";', resolveDir: root }, bundle: true, format: 'iife', globalName: 'RidgeCurrent', write: false }),
  transform(baselineSource, { format: 'iife', globalName: 'RidgeBaseline' }),
]);
const executablePath = args.browser || process.env.PLAYWRIGHT_CHROMIUM_PATH;
let browser;
const report = { baselineCommit, baselineHelperSha256: hash(baselineSource), currentHelperSha256: hash(helperSource),
  currentRendererSha256: hash(rendererSource), bundleSha256: hash(currentBundle.outputFiles[0].contents),
  scope: 'Controlled opaque Canvas2D scenes using actual RangeCrest.drawCrest; not full Landscape rendering or presented FPS.',
  timingScope: 'Explicit software/SwiftShader browser. Submission includes instrumentation. Flush is a deliberate harness-only full-canvas CPU readback after production draw; neither number establishes hardware GPU or presented throughput.',
  errors: [] };
try {
  let page;
  if (!args.cpuCanvas) {
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true,
      args: ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    report.browser = browser.version();
    report.execution = 'Headless Chromium, explicit software/SwiftShader';
    page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    page.on('pageerror', e => report.errors.push(e.message));
    await page.addScriptTag({ content: currentBundle.outputFiles[0].text });
    await page.addScriptTag({ content: baselineBundle.code });
  } else {
    report.execution = 'CPU Skia via @napi-rs/canvas; browser and GPU behavior not tested';
    report.timingScope = 'CPU Skia only, including instrumentation; no browser, hardware GPU, presentation, or full Landscape throughput measurement.';
  }
  const runOracle = async ({ frames, baselineLabel, runtimeLabel }) => {
    const { RangeCrest, CrestColorPattern: Current } = globalThis.RidgeCurrent;
    const { CrestColorPattern: Baseline } = globalThis.RidgeBaseline;
    const check = (value, message) => { if (!value) throw Error(message); };
    const rawCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    const gpuCanvas = rawCanvas(1, 1);
    let gl;
    try { gl = gpuCanvas.getContext('webgl'); } catch { /* CPU-only fallback has no WebGL. */ }
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    const bands = ['far', 'mid', 'near'];
    const metrics = () => ({ allocations: [], copies: 0, copyPixels: 0, clears: 0, clearPixels: 0,
      compositeCopies: {}, strokes: 0, widths: [], productionOutputReads: 0 });
    const makeOwner = (Type, stats) => new Type({ makeCanvas(w, h) {
      const canvas = rawCanvas(w, h), ctx = canvas.getContext('2d');
      stats.allocations.push({ width: w, height: h, bytes: w * h * 4 });
      const copy = ctx.drawImage.bind(ctx), clear = ctx.clearRect.bind(ctx);
      ctx.drawImage = (...a) => {
        stats.copies++; stats.copyPixels += a.length === 9 ? a[3] * a[4] : a[0].width * a[0].height;
        const op = `${ctx.globalCompositeOperation}@${ctx.globalAlpha}`;
        stats.compositeCopies[op] = (stats.compositeCopies[op] || 0) + 1;
        return copy(...a);
      };
      ctx.clearRect = (...a) => { stats.clears++; stats.clearPixels += a[2] * a[3]; return clear(...a); };
      return canvas;
    } });
    const sourcePixels = (w, h, seed, flatY = null, scene = null) => {
      const image = new ImageData(w, h);
      const colors = [[44, 92, 158], [146, 106, 174], [190, 110, 80], [46, 100, 78]];
      const heights = scene ? bands.map(band => Float32Array.from({ length: w }, (_, x) => {
        const points = scene[band];
        if (!points?.length || x < points[0][0] || x > points.at(-1)[0]) return Infinity;
        return points[Math.min(points.length - 1, Math.max(0, Math.floor(x - points[0][0])))][1];
      })) : null;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        image.data[p] = ((x * 17 + y * y * 7 + seed * 31) % 128) * 2;
        image.data[p + 1] = ((x * x * 3 + y * 29 + seed * 13) % 128) * 2;
        image.data[p + 2] = ((x * 13 + y * y * 11 + seed * 19) % 128) * 2;
        image.data[p + 3] = 255;
        if (heights) {
          let band = 0;
          for (let i = 0; i < heights.length; i++) if (y + .5 >= heights[i][x]) band = i + 1;
          const shade = band ? ((Math.floor(x / 6) * 7 + Math.floor(y / 6) * 11 + seed) % 7) * 2 : Math.floor(y / 12) * 2;
          for (let c = 0; c < 3; c++) image.data[p + c] = colors[band][c] + shade;
        }
        if (flatY !== null && Math.abs(y - flatY) <= 1) image.data.set(y === flatY ? [16, 28, 40, 255] : [180, 140, 220, 255], p);
      }
      return image;
    };
    const meanPattern = (image, ctx) => {
      const { width: w, height: h, data } = image, mean = new ImageData(w, h), canvas = rawCanvas(w, h);
      for (let y = 1; y < h - 1; y++) for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) mean.data[p + c] = Math.round((data[p - w * 4 + c] + data[p + w * 4 + c]) / 2);
        mean.data[p + 3] = 255;
      }
      canvas.getContext('2d').putImageData(mean, 0, 0);
      return ctx.createPattern(canvas, 'no-repeat');
    };
    const makeBand = (fit, points, skip = []) => {
      const W = Math.ceil(fit.width / fit.scale), n = points?.length || 0;
      const geometry = n ? { count: n, x: new Float32Array(n), y: new Float32Array(n), column: new Int32Array(n) } : null;
      for (let i = 0; i < n; i++) {
        geometry.x[i] = (points[i][0] - fit.x) / fit.scale;
        geometry.y[i] = (points[i][1] - fit.y) / fit.scale;
        geometry.column[i] = Math.max(0, Math.min(W - 1, Math.floor(geometry.x[i])));
      }
      const g = { geometry, skip: new Uint8Array(W), chunks: [], line: new Float32Array(W).fill(NaN) };
      for (const column of skip) g.skip[column] = 1;
      return g;
    };
    const crestFor = (spec, owner) => {
      const crest = new RangeCrest();
      crest._grid = Object.fromEntries(bands.map(band => [band, makeBand(spec.fit, spec[band], spec.skip?.[band])]));
      crest.snapshot = { frameId: 1, fade: spec.fade ?? 1, grid: { width: Math.ceil(spec.fit.width / spec.fit.scale), height: Math.ceil(spec.fit.height / spec.fit.scale) },
        splitReady: false, splitAlpha: 0, outputGeometry: true };
      crest._colorPattern = owner;
      return crest;
    };
    const render = (spec, image, owner, stats) => {
      const canvas = rawCanvas(spec.w, spec.h), ctx = canvas.getContext('2d', { alpha: false });
      ctx.putImageData(image, 0, 0);
      const read = ctx.getImageData.bind(ctx), stroke = ctx.stroke.bind(ctx);
      ctx.getImageData = () => { stats.productionOutputReads++; throw Error('production output readback is forbidden'); };
      ctx.stroke = () => { stats.strokes++; stats.widths.push(ctx.lineWidth); return stroke(); };
      const crest = crestFor(spec, owner === 'reference' ? { prepare: target => meanPattern(image, target) } : owner);
      crest.drawCrest(ctx, spec.fit, 1);
      check(stats.productionOutputReads === 0, `${spec.name}: output readback attempted`);
      check(stats.widths.every(width => width === 1), `${spec.name}: non-physical stroke width`);
      return { canvas, data: read(0, 0, spec.w, spec.h).data };
    };
    const difference = (a, b) => {
      let pixels = 0, channels = 0, max = 0, alpha = 0, first = null;
      for (let i = 0; i < a.length; i += 4) {
        let changed = false;
        for (let c = 0; c < 4; c++) {
          const d = Math.abs(a[i + c] - b[i + c]);
          if (!d) continue;
          channels++; changed = true; max = Math.max(max, d); if (c === 3) alpha++;
          first ||= { pixel: i / 4, channel: c, a: a[i + c], b: b[i + c] };
        }
        if (changed) pixels++;
      }
      return { pixels, channels, max, alpha, first };
    };
    const deltaMetrics = (before, after) => ({ copies: after.copies - before.copies, copyPixels: after.copyPixels - before.copyPixels,
      clears: after.clears - before.clears, clearPixels: after.clearPixels - before.clearPixels, strokes: after.strokes - before.strokes,
      allocations: after.allocations.slice(before.allocations.length), productionOutputReads: after.productionOutputReads - before.productionOutputReads });
    const line = (left, right, y) => Array.from({ length: Math.floor(right - left) + 1 }, (_, i) => [left + i, typeof y === 'function' ? y(left + i, i) : y]);
    const specs = [];
    for (const [label, w, h, scale, fx, fy] of [['integer', 192, 128, 4, 8, 8], ['fractional', 207, 137, 1.75, 5.25, 4.75]]) {
      const fit = { x: fx, y: fy, width: w - 2 * fx, height: h - 2 * fy, scale };
      const common = { w, h, fit };
      const left = Math.ceil(fx + 8) + .5, right = Math.floor(w - fx - 9) + .5, row = Math.floor(h * .45);
      specs.push({ ...common, name: `${label}-one-physical-row`, flatY: row, near: line(left, right, row + .5), probeWidth: { x: Math.floor((left + right) / 2), row } });
      const gaps = line(left, right, row + .5), gapX = Math.floor(w * .4), skipColumn = Math.floor((w * .65 - fx) / scale);
      for (const p of gaps) if (Math.abs(p[0] - gapX) < 4) p[1] = NaN;
      specs.push({ ...common, name: `${label}-missing-and-skipped`, flatY: row, near: gaps, skip: { near: [skipColumn] },
        untouched: [[gapX, row], [Math.floor(fx + (skipColumn + .5) * scale), row]] });
      specs.push({ ...common, name: `${label}-dense-occluded`,
        far: line(left, right, (x, i) => h * .38 + Math.sin(i * .11) * h * .19 + (i === 57 ? -h * .24 : 0)),
        mid: line(left, right, (x, i) => h * .55 + Math.sin(i * .17) * h * .15),
        near: line(left, right, (x, i) => h * .65 + Math.sin(i * .09) * h * .11), fade: .6 });
      // Large then small/moved geometry reuses an allocation; changed scene colors catch stale texels.
      specs.push({ ...common, name: `${label}-reuse-large`, near: line(left, right, (x, i) => h * .5 + Math.sin(i * .08) * h * .3) });
      specs.push({ ...common, name: `${label}-reuse-small-moved`, near: line(left + 27, right - 31, h * .62 + .25) });
      specs.push({ ...common, name: `${label}-offscreen-steep`, near: [[left, -20], [left + 1, h * .65], [right - 1, h + 20], [right, h * .4]] });
      // No fit border here: unsupported first/last source rows must remain unchanged.
      const edgeFit = { x: 0, y: 0, width: w, height: h, scale };
      specs.push({ ...common, fit: edgeFit, name: `${label}-source-edge-rows`, far: line(.5, w - .5, 1.5), mid: line(.5, w - .5, h - 2.5), near: line(.5, w - .5, h - .5),
        untouched: [[Math.floor(w / 2), h - 1]] });
      // A wholly hidden far stroke must not affect pixels behind a nearer silhouette.
      specs.push({ ...common, name: `${label}-hidden-far`, far: line(left, right, row + 16.5), near: line(left, right, row + .5),
        untouched: [[Math.floor(w / 2), row + 16]] });
    }
    for (const [label, w, h, scale, fx, fy] of [['fullhd', 1920, 1080, 6, 0, 0], ['fractional-960x540', 960, 540, 2.875, 6.25, 5.75]]) {
      const fit = { x: fx, y: fy, width: w - fx * 2, height: h - fy * 2, scale };
      specs.push({ name: `${label}-dense-occluded`, w, h, fit, colorfulTerrain: true,
        far: line(Math.ceil(fx) + .5, Math.floor(w - fx) - .5, (x, i) => h * .43 + Math.sin(i * .012) * h * .09),
        mid: line(Math.ceil(fx) + .5, Math.floor(w - fx) - .5, (x, i) => h * .53 + Math.sin(i * .017) * h * .10),
        near: line(Math.ceil(fx) + .5, Math.floor(w - fx) - .5, (x, i) => h * .67 + Math.sin(i * .009) * h * .08) });
    }
    const baselineStats = metrics(), currentStats = metrics();
    const baselineOwner = makeOwner(Baseline, baselineStats), currentOwner = makeOwner(Current, currentStats);
    const cases = [], captures = [], comparisonRows = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i], source = sourcePixels(spec.w, spec.h, i + 3, spec.flatY, spec.colorfulTerrain ? spec : null);
      const beforeBaseline = structuredClone(baselineStats), beforeCurrent = structuredClone(currentStats);
      const baseline = render(spec, source, baselineOwner, baselineStats);
      const current = render(spec, source, currentOwner, currentStats);
      const reference = render(spec, source, 'reference', metrics());
      const baselineDiff = difference(baseline.data, current.data), meanDiff = difference(reference.data, current.data);
      const baselineMetrics = deltaMetrics(beforeBaseline, baselineStats), currentMetrics = deltaMetrics(beforeCurrent, currentStats);
      const bandCount = bands.filter(b => spec[b]?.length).length;
      const checks = [{ name: 'two-neighbor-copies', passed: baselineMetrics.copies === 2 && currentMetrics.copies === 2 },
        { name: 'at-most-one-stroke-per-band', passed: currentMetrics.strokes <= bandCount }];
      if (spec.probeWidth) {
        const { x, row } = spec.probeWidth, changed = [];
        for (let y = 0; y < spec.h; y++) {
          const p = (y * spec.w + x) * 4;
          if (current.data.slice(p, p + 4).some((v, c) => v !== source.data[p + c])) changed.push(y);
        }
        checks.push({ name: 'exactly-one-physical-row', passed: changed.length === 1 && changed[0] === row, changedRows: changed });
      }
      for (const [x, y] of spec.untouched || []) {
        const p = (y * spec.w + x) * 4;
        checks.push({ name: 'gap-hidden-or-unsupported-pixel-unchanged', x, y, passed: current.data.slice(p, p + 4).every((v, c) => v === source.data[p + c]) });
      }
      const passed = baselineDiff.max === 0 && meanDiff.max <= 1 && meanDiff.alpha === 0 && checks.every(check => check.passed);
      cases.push({ name: spec.name, output: [spec.w, spec.h], fit: spec.fit, baselineDiff, meanDiff, checks,
        baseline: baselineMetrics, current: currentMetrics, passed });
      if (!passed || spec.name.endsWith('dense-occluded')) captures.push({ name: spec.name, baseline: baseline.canvas.toDataURL(), current: current.canvas.toDataURL(), reference: reference.canvas.toDataURL() });
      if (spec.colorfulTerrain) comparisonRows.push({ spec, baseline: baseline.canvas, current: current.canvas, baselineDiff });
    }
    baselineOwner.release(); currentOwner.release();
    const sheet = rawCanvas(1008, 32 + comparisonRows.length * 530), sheetCtx = sheet.getContext('2d');
    sheetCtx.fillStyle = '#121820'; sheetCtx.fillRect(0, 0, sheet.width, sheet.height);
    sheetCtx.font = '16px sans-serif'; sheetCtx.fillStyle = '#ffffff';
    sheetCtx.fillText(`${runtimeLabel} synthetic silhouettes — baseline / optimized`, 16, 22);
    for (let i = 0; i < comparisonRows.length; i++) {
      const row = comparisonRows[i], y = 32 + i * 530;
      sheetCtx.fillStyle = '#ffffff'; sheetCtx.font = '15px sans-serif';
      sheetCtx.fillText(`${row.spec.name}; ${row.baselineDiff.pixels} differing output pixels`, 16, y + 22);
      for (const [j, key] of ['baseline', 'current'].entries()) {
        const x = 16 + j * 496;
        sheetCtx.fillText(key === 'baseline' ? `Baseline ${baselineLabel}` : 'Optimized current helper', x, y + 46);
        sheetCtx.imageSmoothingEnabled = false;
        sheetCtx.drawImage(row[key], x, y + 56, 480, 270);
        const middle = Math.floor(row.spec.far.length / 2), point = row.spec.far[middle];
        sheetCtx.fillText('4x physical-pixel detail around the far ridge', x, y + 350);
        sheetCtx.drawImage(row[key], Math.round(point[0]) - 60, Math.round(point[1]) - 18, 120, 36, x, y + 364, 480, 144);
      }
    }
    const timings = [];
    if (frames) for (const [w, h] of [[960, 540], [1920, 1080]]) {
      const fit = { x: 0, y: 0, width: w, height: h, scale: w / 320 };
      const spec = { name: `software-${w}x${h}`, w, h, fit,
        far: line(.5, w - .5, (x, i) => h * .3 + Math.sin(i * .009) * h * .12),
        mid: line(.5, w - .5, (x, i) => h * .48 + Math.sin(i * .007) * h * .1),
        near: line(.5, w - .5, (x, i) => h * .65 + Math.sin(i * .011) * h * .09) };
      const source = rawCanvas(w, h); source.getContext('2d').putImageData(sourcePixels(w, h, 19), 0, 0);
      const sample = Type => {
        const stats = metrics(), owner = makeOwner(Type, stats), crest = crestFor(spec, owner);
        const canvas = rawCanvas(w, h), ctx = canvas.getContext('2d', { alpha: false }), read = ctx.getImageData.bind(ctx);
        ctx.getImageData = () => { stats.productionOutputReads++; throw Error('production output readback is forbidden'); };
        return { stats, owner, crest, ctx, read, samples: [] };
      };
      const pair = { baseline: sample(Baseline), current: sample(Current) };
      for (let i = -5; i < frames; i++) {
        // Alternate order to reduce a consistent first/second bias.
        for (const key of i % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
          const state = pair[key];
          state.ctx.drawImage(source, 0, 0);
          const start = performance.now(); state.crest.drawCrest(state.ctx, fit, 1); const submitted = performance.now();
          state.read(0, 0, w, h); const flushed = performance.now();
          if (i >= 0) state.samples.push({ submissionMs: submitted - start, submissionAndHarnessReadbackMs: flushed - start });
        }
      }
      const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
      const summary = state => {
        check(state.stats.productionOutputReads === 0, 'timing production output readback');
        state.owner.release();
        return { frames, productionOutputReads: state.stats.productionOutputReads,
          medianSubmissionMs: percentile(state.samples.map(s => s.submissionMs), .5),
          p95SubmissionMs: percentile(state.samples.map(s => s.submissionMs), .95),
          medianSubmissionAndHarnessReadbackMs: percentile(state.samples.map(s => s.submissionAndHarnessReadbackMs), .5),
          p95SubmissionAndHarnessReadbackMs: percentile(state.samples.map(s => s.submissionAndHarnessReadbackMs), .95), samples: state.samples };
      };
      timings.push({ width: w, height: h, baseline: summary(pair.baseline), current: summary(pair.current) });
    }
    return { renderer, cases, baselineTotals: baselineStats, currentTotals: currentStats, timings, captures, comparisonPng: sheet.toDataURL(),
      arithmeticTolerance: 'Independent 8-bit arithmetic mean permits at most 1 RGB level for browser alpha-compositing rounding; alpha must match exactly. Baseline/current output must be byte-identical.' };
  };
  const oracleArgs = { frames: args.frames, baselineLabel: args.baseline, runtimeLabel: args.cpuCanvas ? 'CPU Skia' : 'Headless Chromium software' };
  if (args.cpuCanvas) {
    const canvasModule = createRequire(import.meta.url)(path.resolve(args.cpuCanvas));
    report.cpuCanvasVersion = createRequire(import.meta.url)(path.join(path.resolve(args.cpuCanvas), 'package.json')).version;
    const globals = { ImageData: canvasModule.ImageData, performance, structuredClone, console,
      document: { createElement(tag) { assert.equal(tag, 'canvas'); return canvasModule.createCanvas(1, 1); } } };
    report.results = await runInNewContext(`${currentBundle.outputFiles[0].text}\n${baselineBundle.code}\n(${runOracle.toString()})(${JSON.stringify(oracleArgs)})`, globals);
  } else report.results = await page.evaluate(runOracle, oracleArgs);
  for (const capture of report.results.captures) for (const variant of ['baseline', 'current', 'reference']) {
    await fs.writeFile(path.join(out, `${capture.name}-${variant}.png`), Buffer.from(capture[variant].split(',')[1], 'base64'));
  }
  await fs.writeFile(path.join(out, 'comparison.png'), Buffer.from(report.results.comparisonPng.split(',')[1], 'base64'));
  delete report.results.comparisonPng;
  report.results.comparisonImage = 'comparison.png';
  report.results.captures = report.results.captures.map(c => ({ name: c.name, files: ['baseline', 'current', 'reference'].map(v => `${c.name}-${v}.png`) }));
  report.sourceUnchanged = hash(await fs.readFile(helperPath)) === report.currentHelperSha256 && hash(await fs.readFile(rendererPath)) === report.currentRendererSha256;
  report.passed = report.sourceUnchanged && report.errors.length === 0 && report.results.cases.every(c => c.passed);
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, report: path.join(out, 'report.json'), cases: report.results.cases.length,
    failures: report.results.cases.filter(c => !c.passed), baseline: report.results.baselineTotals, current: report.results.currentTotals,
    timings: report.results.timings.map(t => ({ ...t, baseline: { ...t.baseline, samples: undefined }, current: { ...t.current, samples: undefined } })) }, null, 2));
  assert.equal(report.passed, true, 'ridge output regression failed; see report.json');
} catch (error) {
  report.passed = false; report.failure = error.stack;
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  throw error;
} finally {
  await browser?.close();
}
