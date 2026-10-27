// Small real Simulation/Renderer thumbnail fixture for the color-regime
// highlight reel. Serve the specified source tree first; this harness never
// changes app state or calls a live service. It plays in Trio: procedural
// ranges drawn in Canvas 2D, no terrain to load. Headless only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2];
const output = process.argv[3];
const sourceRoot = process.argv[4];
const includeMatrix = process.argv[5] !== '--capture-only';
if (!url || !output || !sourceRoot) throw new Error('Usage: highlight-reel-smoke.mjs URL OUTPUT SOURCE_ROOT [--capture-only]');
if (existsSync(path.join(output, 'report.json'))) throw new Error('Output already contains a report; preserve prior evidence.');
await fs.mkdir(output, { recursive: true });
const sourceFiles = ['src/render/HighlightReel.js', 'src/render/Renderer.js', 'src/sim/Simulation.js',
  'src/world/DayNight.js', 'src/world/BiomeSchedule.js', 'src/world/alpine/RangeStorm.js', 'src/world/FractureEngine.js'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {};
for (const file of sourceFiles) {
  const local = await fs.readFile(path.join(sourceRoot, file));
  const response = await fetch(new URL(file, `${url}/`));
  if (!response.ok || sha(Buffer.from(await response.arrayBuffer())) !== sha(local)) throw new Error(`Served source differs: ${file}`);
  sourceHashes[file] = sha(local);
}
const SONG_MS = 60000;
execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), path.join(output, 'fixture.wav'), '120', String(SONG_MS / 1000)]);
let browser;
try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/highlight-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><canvas id="stage" width="640" height="360"></canvas>' }));
  await page.goto(`${url}/highlight-fixture`);
  const run = async (songMs, fpsList, matrix) => page.evaluate(async ({ songMs, fpsList, matrix }) => {
    const [{ Simulation }, { Renderer }, { Conductor }, { ParamBus }, { Role }] = await Promise.all([
      import('/src/sim/Simulation.js'), import('/src/render/Renderer.js'), import('/src/core/Conductor.js'),
      import('/src/core/ParamBus.js'), import('/src/core/NoteEvent.js'),
    ]);
    const stepMs = 1000 / 120;
    // A quiet verse, a loud chorus (the climax and a hotter cast palette),
    // and an outro, on a steady kick.
    const energy = t => t > 26000 && t < 40000 ? .9 : .3;
    function fixture({ startMs = 0 } = {}) {
      const conductor = new Conductor();
      conductor.load({ durationMs: songMs, bpm: 120,
        timeline: Array.from({ length: Math.floor(songMs / 500) - 4 }, (_, i) => ({ id: `note:${i}`, tMs: 1000 + i * 500,
          durMs: 80, role: Role.RHYTHM, kick: true, vel: .8, pitch: 36 })),
        barGrid: Array.from({ length: Math.ceil(songMs / 2000) }, (_, i) => ({ ms: i * 2000, tick: i * 4, numerator: 4, denominator: 4 })) });
      const energyCurves = { sample: (_b, t) => energy(t), sampleAll: t => Array(7).fill(energy(t)),
        globalEnergy: energy, globalEnergyNorm: energy };
      const sim = new Simulation(conductor, new ParamBus(), { worldId: 'trio', songSeed: 315,
        energyCurves, conductorCues: { liveCues: [], scheduleCues: [] } });
      sim.biomes.pumpStripPrewarm = () => {};
      const canvas = document.getElementById('stage');
      const renderer = new Renderer(canvas);
      let tick = Math.floor(startMs / stepMs);
      if (startMs) sim.startAt(startMs); else sim.step(0, 0);
      return { sim, canvas, draw(timeMs) {
        while ((tick + 1) * stepMs <= timeMs + 1e-7) { tick++; sim.step(stepMs, tick * stepMs); }
        renderer.draw(sim, 1);
      }, dispose() { renderer.dispose(); sim.dispose(); } };
    }
    const cadence = (fps, start, end) => Array.from({ length: Math.floor(end * fps / 1000) - Math.ceil(start * fps / 1000) + 1 },
      (_, i) => (Math.ceil(start * fps / 1000) + i) * 1000 / fps);
    const rows = [];
    for (const fps of fpsList) {
      const f = fixture();
      try {
        f.draw(0);
        const frames = [];
        for (const event of f.sim.highlightReel.selections) {
          for (const time of cadence(fps, event.visibleStartMs - 60, event.visibleStartMs + 200)) {
            const before = f.sim.highlightReel.frames.length;
            f.draw(time);
            if (f.sim.highlightReel.frames.length > before) frames.push({ label: event.label, frameMs: f.sim.timeMs,
              png: f.canvas.toDataURL('image/png') });
          }
        }
        rows.push({ name: 'cadence', fps, selections: f.sim.highlightReel.selections, thumbnails: f.sim.highlightReel.frames, frames });
      } finally { f.dispose(); }
    }
    if (matrix) {
      const f = fixture();
      try {
        f.draw(0); const first = f.sim.highlightReel.selections[0];
        f.draw(first.visibleStartMs - 100); f.draw(first.visibleEndMs + 100);
        rows.push({ name: 'stall', selections: f.sim.highlightReel.selections, thumbnails: f.sim.highlightReel.frames, frames: [] });
      } finally { f.dispose(); }
      const g = fixture({ startMs: 20000 });
      try { g.draw(20000); rows.push({ name: 'fresh-seek', selections: g.sim.highlightReel.selections, thumbnails: [], frames: [] }); }
      finally { g.dispose(); }
    }
    return rows;
  }, { songMs, fpsList, matrix });
  const rows = await run(SONG_MS, includeMatrix ? [24, 30, 60] : [30], includeMatrix);
  const signature = row => row.selections.map(({ id, category, eventAtMs }) => ({ id, category, eventAtMs }));
  const cadenceRows = rows.filter(row => row.name === 'cadence');
  for (const row of cadenceRows) {
    assert.ok(row.selections.length > 0 && row.selections.length <= 5, 'one to five regimes');
    assert.equal(new Set(row.selections.map(event => event.category)).size, row.selections.length, 'one frame per regime');
    assert.deepEqual(row.thumbnails.map(frame => frame.eventAtMs), row.selections.map(event => event.eventAtMs));
    assert.deepEqual(signature(row), signature(cadenceRows[0]), 'frame cadence cannot change the schedule');
  }
  if (includeMatrix) {
    const row = name => rows.find(entry => entry.name === name);
    assert.equal(row('stall').thumbnails.length, 0); assert.equal(row('stall').selections[0].status, 'missed');
    assert.deepEqual(signature(row('fresh-seek')), signature(cadenceRows[0]));
  }
  for (const row of rows) {
    for (let i = 0; i < row.frames.length; i++) {
      const file = `${row.name}-${row.fps ?? 'fixed'}-frame-${i}.png`;
      await fs.writeFile(path.join(output, file), Buffer.from(row.frames[i].png.split(',')[1], 'base64'));
      row.frames[i].png = file;
    }
    for (let i = 0; i < row.thumbnails.length; i++) {
      const file = `${row.name}-${row.fps ?? 'fixed'}-thumbnail-${i}.jpg`;
      await fs.writeFile(path.join(output, file), Buffer.from(row.thumbnails[i].dataUrl.split(',')[1], 'base64'));
      row.thumbnails[i].dataUrl = file;
    }
  }
  const result = { fixture: { song: 'Regime fixture: quiet verse, loud chorus 26-40 s, steady kick', durationMs: SONG_MS,
    worldId: 'trio', audio: 'Generated 120 BPM diagnostic recording; the energy curve is authored, not inferred from it.' },
  categories: cadenceRows[0].selections.map(event => event.label), rows,
  sourceHashes, browser: await browser.version(), errors };
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Highlight fixture: ${cadenceRows[0].thumbnails.length} thumbnails (${result.categories.join(', ') || 'none'}), ${rows.length} runtime cases, ${errors.length} page errors.`);
  if (errors.length) throw new Error(errors.join('\n'));
  for (const file of sourceFiles) if (sha(await fs.readFile(path.join(sourceRoot, file))) !== sourceHashes[file]) throw new Error(`Source changed during capture: ${file}`);
} finally { await browser?.close(); }
