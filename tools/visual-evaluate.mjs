#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { normalizeManifest, manifestForCase, captureSchedule, compareReports, differingFrames, blankFrame } from './lib/visual-evaluation.mjs';
import { snapshotSource, serveSnapshot, sha256 } from './lib/visual-evaluation-server.mjs';
import { openEvaluationSong, renderEvaluationFrame } from './lib/visual-evaluation-browser.mjs';
import { renderRunReport, renderComparisonReport } from './lib/visual-evaluation-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = `npm run visual:eval -- --out .smoke/baseline [--manifest path/to/corpus.json]
npm run visual:eval -- --manifest test/fixtures/visual-evaluation-vfx.json --case q4-palette-both --out .smoke/q4
npm run visual:eval -- --compare .smoke/baseline .smoke/candidate --out .smoke/comparison [--require-identical]

--case selects one case of a VFX matrix manifest (see docs/visual-evaluation-loop.md).

--require-identical fails the comparison (after writing it) unless every PNG
matches. Use it only for repeat runs of identical inputs, as CI does.
Creates a NEW output directory (never overwrites a run). See docs/visual-evaluation-loop.md.
Set PLAYWRIGHT_CHROMIUM_PATH to use an installed Chromium. Outputs contain copies of source audio.
`;
function parseArgs(argv) {
  const args = { manifest: path.join(root, 'test/fixtures/visual-evaluation.json') };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (key === '--require-identical') { args.requireIdentical = true; continue; }
    if (key === '--compare') {
      args.compare = [argv[++i], argv[++i]];
      if (args.compare.some(v => !v || v.startsWith('--'))) throw new Error('--compare needs BEFORE AFTER');
    } else if (['--manifest', '--out', '--case'].includes(key)) {
      const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${key} needs a value`); args[key.slice(2)] = v;
    } else throw new Error(`unknown argument ${key}`);
  }
  if (!args.out) throw new Error('--out is required');
  if (args.requireIdentical && !args.compare) throw new Error('--require-identical only applies to --compare');
  if (args.case && args.compare) throw new Error('--case applies to a capture, not --compare');
  return args;
}
async function newOutput(out) {
  await fs.mkdir(path.dirname(out), { recursive: true });
  try { await fs.mkdir(out); } catch (e) { if (e.code === 'EEXIST') throw new Error(`Output already exists: ${out}; use a new run directory`, { cause: e }); throw e; }
}
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

async function createFixture(song, dest) {
  if (song.fixture === 'contrast') {
    execFileSync(process.execPath, [path.join(root, 'tools/gen-pilot-wav.mjs'), dest, String(song.seconds)], { stdio: 'pipe' });
    return;
  }
  const rate = 44100, samples = song.seconds * rate, b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  if (song.fixture === 'kicks') for (let i = 0; i < samples; i++) {
    const t = (i % rate) / rate; // One isolated low-frequency attack per second.
    const value = t < 0.2 ? 0.8 * Math.exp(-t / 0.035) * Math.sin(2 * Math.PI * 65 * t) : 0;
    b.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  await fs.writeFile(dest, b);
}

async function runCapture(args) {
  const manifestPath = path.resolve(args.manifest);
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (raw?.kind === 'matrix' && !args.case) throw new Error('this manifest is a matrix: pass --case <id>');
  if (args.case && raw?.kind !== 'matrix') throw new Error('--case needs a matrix manifest');
  const manifest = args.case ? manifestForCase(raw, args.case) : normalizeManifest(raw);
  const out = path.resolve(args.out);
  await newOutput(out);
  const angle=process.env.VISUAL_ANGLE || 'swiftshader';
  if(!['swiftshader','gl'].includes(angle))throw new Error('VISUAL_ANGLE must be swiftshader or gl');
  const report = { angle, version: 1, status: 'failed', createdAt: new Date().toISOString(), settings: manifest.settings, songs: [],
    timingScope: 'Fixed export clock. Software WebGL; not a live playback or device FPS measurement.' };
  let server, browser;
  try {
    const snapshot = await snapshotSource(root);
    report.source = { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=normal'), digest: snapshot.digest, hashes: snapshot.hashes };
    await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    server = await serveSnapshot(snapshot);
    browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
      args: [`--use-angle=${angle}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    report.browser = browser.version();
    for (const song of manifest.songs) {
      const dir = path.join(out, song.id); await fs.mkdir(dir);
      const audio = `${song.id}/audio${song.file ? path.extname(song.file).toLowerCase() : '.wav'}`;
      const audioPath = path.join(out, audio);
      const row = { id: song.id, fixture: song.fixture ?? null, audio, frames: [], errors: [], warnings: [] };
      report.songs.push(row);
      if (song.file) await fs.copyFile(path.resolve(path.dirname(manifestPath), song.file), audioPath);
      else await createFixture(song, audioPath);
      row.audioSha256 = sha256(await fs.readFile(audioPath));
      const loadedFiles = new Set();
      console.log(`Loading ${song.id}`);
      const loaded = await openEvaluationSong(browser, { url: server.url, audioPath, settings: manifest.settings, diagnostics: { ...row, loadedFiles } });
      try {
        row.durationMs = loaded.durationMs;
        if (report.environment && JSON.stringify(report.environment) !== JSON.stringify(loaded.environment)) throw new Error('render environment changed between songs');
        report.environment = loaded.environment;
        row.schedule = captureSchedule(song, row.durationMs, manifest.settings);
        row.clips = song.clips ?? [{ startMs: Math.floor(row.durationMs * 0.5), durationMs: Math.min(2000, Math.floor(row.durationMs * 0.25)) }];
        for (const point of row.schedule) {
          const frame = await renderEvaluationFrame(loaded.page, point, manifest.settings);
          if (!frame) continue;
          if (blankFrame(frame.thumbnail)) throw new Error(`${song.id}: blank frame at ${point.timeMs}ms`);
          const bytes = Buffer.from(frame.pngData, 'base64'); delete frame.pngData;
          frame.png = `${song.id}/frame-${String(row.frames.length).padStart(5, '0')}.png`;
          frame.sha256 = sha256(bytes);
          await fs.writeFile(path.join(out, frame.png), bytes); row.frames.push(frame);
          console.log(`${song.id} ${point.timeMs.toFixed(3)}ms → ${frame.actualTimeMs.toFixed(3)}ms, ${frame.range.viewId}`);
        }
        row.loadedFiles = [...loadedFiles].sort();
        if (row.errors.length) throw new Error(`${song.id}: ${row.errors.join('\n')}`);
      } finally { await loaded.context.close(); }
    }
    report.source.changedDuringRun = (await snapshotSource(root)).digest !== report.source.digest;
    if (report.source.changedDuringRun) throw new Error('Source changed during capture; captured snapshot is recorded but run must be repeated');
    report.status = 'passed';
  } catch (e) { report.error = String(e.stack || e); throw e; }
  finally {
    if (browser) await browser.close();
    if (server) await server.close();
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(out, 'index.html'), renderRunReport(report));
    console.log(`Evidence: ${out}/index.html (${report.status})`);
  }
}

// Copy only verified referenced artifacts; no arbitrary report paths or symlinks.
async function copyRun(source, destination, report) {
  await fs.mkdir(destination);
  const base = await fs.realpath(source);
  const files = new Set(['report.json', 'index.html', 'manifest.json']);
  for (const song of report.songs) { files.add(song.audio); for (const f of song.frames) files.add(f.png); }
  for (const file of files) {
    if (typeof file !== 'string' || path.isAbsolute(file) || file.includes('\\') || file.split('/').some(p => p === '..' || p.startsWith('.'))) throw new Error('unsafe evidence path');
    const from = await fs.realpath(path.join(base, file));
    if (!from.startsWith(base + path.sep)) throw new Error('evidence path leaves run directory');
    const target = path.join(destination, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(from, target);
  }
  for (const song of report.songs) {
    if (sha256(await fs.readFile(path.join(destination, song.audio))) !== song.audioSha256) throw new Error('audio evidence hash mismatch');
    for (const f of song.frames) if (sha256(await fs.readFile(path.join(destination, f.png))) !== f.sha256) throw new Error('PNG evidence hash mismatch');
  }
}
async function runComparison(args) {
  const [beforePath, afterPath] = args.compare.map(p => path.resolve(p));
  const before = JSON.parse(await fs.readFile(path.join(beforePath, 'report.json'), 'utf8'));
  const after = JSON.parse(await fs.readFile(path.join(afterPath, 'report.json'), 'utf8'));
  const diff = compareReports(before, after), out = path.resolve(args.out);
  await newOutput(out);
  try {
    await copyRun(beforePath, path.join(out, 'baseline'), before);
    await copyRun(afterPath, path.join(out, 'candidate'), after);
    await fs.writeFile(path.join(out, 'comparison.json'), JSON.stringify(diff, null, 2));
    await fs.writeFile(path.join(out, 'index.html'), renderComparisonReport(diff, before, after));
    console.log(`Comparison: ${out}/index.html · ${diff.frames.filter(f => f.identical).length}/${diff.frames.length} identical PNGs · judgment unreviewed`);
  } catch (e) { await fs.writeFile(path.join(out, 'failure.txt'), String(e.stack || e)); throw e; }
  const differing = differingFrames(diff);
  if (args.requireIdentical && differing.length) {
    throw new Error(`Identical inputs rendered differently at ${differing.length} frame(s): ${differing.slice(0, 8).join(', ')}`);
  }
}
try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) console.log(help);
  else if (args.compare) await runComparison(args);
  else await runCapture(args);
} catch (e) { console.error(e.message); process.exitCode = 1; }
