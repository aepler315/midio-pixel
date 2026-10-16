// Small real Simulation/Renderer thumbnail fixture. Serve the specified source
// tree first; this harness never changes app state or calls a live service.
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
  'src/sim/HypeDirector.js', 'src/world/FractureEngine.js', 'src/render/FilmFinish.js'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {};
for (const file of sourceFiles) {
  const local = await fs.readFile(path.join(sourceRoot, file));
  const response = await fetch(new URL(file, `${url}/`));
  if (!response.ok || sha(Buffer.from(await response.arrayBuffer())) !== sha(local)) throw new Error(`Served source differs: ${file}`);
  sourceHashes[file] = sha(local);
}
execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), path.join(output, 'fixture.wav'), '120', '24']);
let browser;
try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/highlight-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><canvas id="stage" width="640" height="360"></canvas>' }));
  await page.goto(`${url}/highlight-fixture`);
  const result = await page.evaluate(async () => {
    const [{ Simulation }, { Renderer }, { Conductor }, { ParamBus }, { Role }] = await Promise.all([
      import('/src/sim/Simulation.js'), import('/src/render/Renderer.js'), import('/src/core/Conductor.js'),
      import('/src/core/ParamBus.js'), import('/src/core/NoteEvent.js'),
    ]);
    const conductor = new Conductor();
    conductor.load({ durationMs: 24000, bpm: 120, timeline: [1000, 5000, 10000, 15000, 22000].map((tMs, i) => ({
      id: `note:${i}`, tMs, durMs: 80, role: Role.RHYTHM, kick: true, vel: .8, pitch: 36,
    })), barGrid: Array.from({ length: 12 }, (_, i) => ({ ms: i * 2000, tick: i * 4, numerator: 4, denominator: 4 })) });
    const cues = [5000, 9999, 10000, 10001, 15000].map((tMs, i) => ({ id: `drop:${i}`, tMs, kind: 'drop', value: 1 }));
    const energyCurves = {
      sample: () => .1, sampleAll: () => Array(7).fill(.1), globalEnergy: () => .1, globalEnergyNorm: () => .1,
    };
    const sim = new Simulation(conductor, new ParamBus(), { worldId: 'understory', songSeed: 315,
      energyCurves, conductorCues: { liveCues: cues, scheduleCues: [] } });
    const canvas = document.getElementById('stage');
    const renderer = new Renderer(canvas);
    const frames = [];
    let timeMs = 0;
    try {
      sim.step(0, 0);
      for (const target of [0, 4999, 5000, 5100, 9999, 10000, 10001, 10101, 15000, 15100, 21780, 21850, 22100]) {
        while (timeMs < target) {
          const next = Math.min(target, timeMs + 1000 / 120);
          sim.step(next - timeMs, next); timeMs = next;
        }
        renderer.draw(sim, 1);
        frames.push({ heardMs: sim.heardTimeMs ?? sim.timeMs, frameMs: sim.timeMs,
          png: canvas.toDataURL('image/png'), dropAtMs: sim.hype.dropAtMs,
          freezeMs: sim.fracture.freezeMs, reelCount: sim.highlightReel.frames.length });
      }
      return { frames, thumbnails: sim.highlightReel.frames, selections: sim.highlightReel.selections || null,
        categories: [...new Set(sim.highlightReel.frames.map(frame => frame.label))],
        fixture: { song: 'WP23 authored drop fixture', durationMs: 24000, worldId: 'understory', cueTimes: cues.map(cue => cue.tMs),
          audio: 'Generated 120 BPM diagnostic recording; cues are authored, not inferred from this recording.' } };
    } finally { renderer.dispose(); sim.dispose(); }
  });
  result.matrix = result.selections && includeMatrix ? await page.evaluate(async () => {
    const [{ Simulation }, { Renderer }, { Conductor }, { ParamBus }, { Role }, { EnergyCurves }] = await Promise.all([
      import('/src/sim/Simulation.js'), import('/src/render/Renderer.js'), import('/src/core/Conductor.js'),
      import('/src/core/ParamBus.js'), import('/src/core/NoteEvent.js'), import('/src/audio/EnergyCurves.js'),
    ]);
    const rows = [], stepMs = 1000 / 120;
    function fixture({ cueTimes = [5000], durationMs = 24000, lastImpactMs = 22000,
      profile = 'flat', quality = 0, reduced = false, startMs = 0, latencyMs = 0 } = {}) {
      const conductor = new Conductor();
      conductor.load({ durationMs, bpm: 120,
        timeline: profile === 'quiet' ? [] : [1000, lastImpactMs].map((tMs, i) => ({ id: `note:${i}`,
          tMs, durMs: 80, role: Role.RHYTHM, kick: true, vel: .8, pitch: 36 })),
        barGrid: Array.from({ length: Math.ceil(durationMs / 2000) }, (_, i) => ({ ms: i * 2000,
          tick: i * 4, numerator: 4, denominator: 4 })) });
      const energyCurves = new EnergyCurves(durationMs);
      for (let frame = 0; frame < energyCurves.n; frame++) {
        const tMs = frame * 1000 / energyCurves.rateHz;
        const value = profile === 'quiet' ? 0 : profile === 'inferred' && tMs >= 5000 ? .95 : .1;
        for (const band of energyCurves.bands) band[frame] = value;
      }
      const sim = new Simulation(conductor, new ParamBus(), { worldId: 'understory', songSeed: 315,
        energyCurves, outputLatencyMs: () => latencyMs, conductorCues: { liveCues: cueTimes.map((tMs, i) => ({
          id: `drop:${i}`, tMs, kind: 'drop', value: 1 })), scheduleCues: [] } });
      sim.biomes.pumpStripPrewarm = () => {};
      sim.reducedFlash = reduced; sim.reducedMotion = reduced;
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const renderer = new Renderer(canvas);
      let tick = Math.floor(startMs / stepMs);
      if (startMs) sim.startAt(startMs); else sim.step(0, 0);
      sim.perf.setFixtureLevel(quality);
      return { sim, draw(timeMs) {
        while ((tick + 1) * stepMs <= timeMs + 1e-7) { tick++; sim.step(stepMs, tick * stepMs); }
        renderer.draw(sim, 1);
      }, save(name, fps = null) {
        rows.push({ name, fps, quality: sim.perf.level, reducedFlash: sim.reducedFlash,
          selections: sim.highlightReel.selections,
          frames: sim.highlightReel.frames, actualDropAtMs: sim.hype.dropAtMs });
      }, dispose() { renderer.dispose(); sim.dispose(); } };
    }
    const cadenceWindow = (fps, start, end) => Array.from({ length: Math.floor(end * fps / 1000)
      - Math.ceil(start * fps / 1000) + 1 }, (_, i) => (Math.ceil(start * fps / 1000) + i) * 1000 / fps);
    for (const fps of [24, 30, 60]) {
      for (const kind of ['gap', 'inferred', 'coincident']) {
        const f = fixture(kind === 'gap' ? { cueTimes: [6000, 10999, 11000, 11001] }
          : kind === 'inferred' ? { cueTimes: [], profile: 'inferred' }
            : { durationMs: 8000, lastImpactMs: 5220 });
        try {
          f.draw(0);
          const energy = f.sim.highlightReel.selections.find(event => event.source === 'energy');
          const times = kind === 'gap' ? [...cadenceWindow(fps, 5900, 6150), ...cadenceWindow(fps, 10900, 11150)]
            : kind === 'inferred' ? cadenceWindow(fps, energy.eventAtMs - 50, energy.eventAtMs + 110)
              : cadenceWindow(fps, 4900, 5300);
          for (const timeMs of times) f.draw(timeMs);
          f.save(kind, fps);
        } finally { f.dispose(); }
      }
    }
    for (const quality of [0, 6]) {
      const f = fixture({ quality, reduced: true });
      try { for (const time of [4900, 5000, 5100]) f.draw(time); f.save(`reduced-q${quality}`); }
      finally { f.dispose(); }
    }
    for (const [name, options, times] of [
      ['stall', {}, [4900, 5200]], ['quiet-short', { cueTimes: [], durationMs: 3000, profile: 'quiet' }, [0, 1500, 2900]],
      ['output-latency', { latencyMs: 250 }, [4900, 5000, 5100]],
      ['fresh-seek', { startMs: 5200 }, [5200]], ['replay', {}, [0, 5000]], ['export', {}, [0, 5000]],
    ]) {
      const f = fixture(options);
      try { for (const time of times) f.draw(time); f.save(name); }
      finally { f.dispose(); }
    }
    return rows;
  }) : [];
  if (result.selections) {
    assert.deepEqual(result.thumbnails.map(frame => frame.eventAtMs), [5000, 10000, 15000, 21780]);
    assert.equal(result.thumbnails.at(-1).label, 'Finale');
  }
  if (result.matrix.length) {
    for (const name of ['gap', 'inferred', 'coincident']) {
      const rows = result.matrix.filter(row => row.name === name);
      const signature = row => row.selections.map(({ id, eventAtMs }) => ({ id, eventAtMs }));
      assert.deepEqual(signature(rows[0]), signature(rows[1]));
      assert.deepEqual(signature(rows[1]), signature(rows[2]));
      for (const row of rows) {
        if (name === 'gap') assert.deepEqual(row.frames.map(frame => frame.eventAtMs), [6000, 11000]);
        if (name === 'inferred') assert.equal(row.frames[0].eventId, row.selections.find(event => event.source === 'energy').id);
        if (name === 'coincident') assert.deepEqual(row.frames.map(frame => frame.label), ['Finale']);
      }
    }
    const row = name => result.matrix.find(row => row.name === name);
    assert.equal(row('reduced-q0').frames.length, 1);
    assert.equal(row('reduced-q6').frames.length, 0);
    assert.equal(row('reduced-q6').selections[0].status, 'rejected');
    assert.equal(row('stall').frames.length, 0); assert.equal(row('stall').selections[0].status, 'missed');
    assert.equal(row('quiet-short').selections.length, 0);
    assert.equal(row('output-latency').frames[0].atMs, 4750);
    assert.equal(row('output-latency').frames[0].capturedAtMs, 5000);
    const signatures = ['fresh-seek', 'replay', 'export'].map(name => row(name).selections.map(({ id, eventAtMs }) => ({ id, eventAtMs })));
    assert.deepEqual(signatures[0], signatures[1]); assert.deepEqual(signatures[1], signatures[2]);
    assert.equal(row('fresh-seek').selections[0].status, 'missed');
  }
  for (const frame of result.frames) {
    await fs.writeFile(path.join(output, `frame-${frame.frameMs}.png`), Buffer.from(frame.png.split(',')[1], 'base64'));
    delete frame.png;
  }
  for (let i = 0; i < result.thumbnails.length; i++) {
    const frame = result.thumbnails[i];
    await fs.writeFile(path.join(output, `thumbnail-${i}.jpg`), Buffer.from(frame.dataUrl.split(',')[1], 'base64'));
    frame.dataUrl = `thumbnail-${i}.jpg`;
  }
  for (const row of result.matrix) for (let i = 0; i < row.frames.length; i++) {
    const frame = row.frames[i], file = `${row.name}-${row.fps ?? 'fixed'}-${i}.jpg`;
    await fs.writeFile(path.join(output, file), Buffer.from(frame.dataUrl.split(',')[1], 'base64'));
    frame.dataUrl = file;
  }
  result.sourceHashes = sourceHashes; result.browser = await browser.version(); result.errors = errors;
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Highlight fixture: ${result.thumbnails.length} thumbnails, categories ${result.categories.join(', ') || '(none)'}, ${result.matrix.length} runtime cases, ${errors.length} page errors.`);
  if (errors.length) throw new Error(errors.join('\n'));
  for (const file of sourceFiles) if (sha(await fs.readFile(path.join(sourceRoot, file))) !== sourceHashes[file]) throw new Error(`Source changed during capture: ${file}`);
} finally { await browser?.close(); }
