// Load structured test songs through the real upload and analysis path and
// compare what the app detects -- sections, tour roles, payoff downbeats --
// with the generator's ground truth (tools/gen-song-wav.mjs sidecars).
// Payoff timing is only measurable against the moments the app can know.
//
//   node tools/song-structure-probe.mjs --out .smoke/song-structure song.wav [song2.wav ...]
//
// Each WAV needs its <name>.form.json sidecar beside it. Headless Chromium,
// isolated profile; VISUAL_ANGLE=gl uses the hardware GPU.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';
import { openEvaluationSong } from './lib/visual-evaluation-browser.mjs';
import { DEFAULT_SETTINGS } from './lib/visual-evaluation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Detected boundary nearest each intended one, and the payoff error. */
export function compareStructure(form, detected) {
  const starts = detected.sections.map((s) => s.startMs);
  const nearest = (t) => starts.reduce((best, s) => (Math.abs(s - t) < Math.abs(best - t) ? s : best), Infinity);
  const boundaries = form.sections.slice(1).map((s) => ({ kind: s.kind, intendedMs: s.startMs, detectedMs: nearest(s.startMs),
    errorMs: nearest(s.startMs) - s.startMs }));
  const payoffs = form.payoffs.map((p) => {
    const at = detected.sections.findIndex((s) => Math.abs(s.startMs - p.timeMs) <= 1500);
    return { ...p, detectedMs: at >= 0 ? detected.sections[at].startMs : null, role: at >= 0 ? detected.roles[at]?.role ?? null : null,
      finalChorus: at >= 0 ? !!detected.roles[at]?.finalChorus : false };
  });
  return { boundaries, payoffs,
    maxBoundaryErrorMs: Math.max(0, ...boundaries.map((b) => Math.abs(b.errorMs)).filter(Number.isFinite)),
    missedBoundaries: boundaries.filter((b) => !(Math.abs(b.errorMs) <= 1500)).length,
    missedPayoffs: payoffs.filter((p) => p.detectedMs === null).length };
}

async function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = path.resolve(outAt >= 0 ? args[outAt + 1] : '.smoke/song-structure');
  const songs = args.filter((a, i) => a.endsWith('.wav') && i !== outAt + 1);
  if (!songs.length) throw new Error('usage: node tools/song-structure-probe.mjs --out DIR song.wav [...]');
  await fs.mkdir(out, { recursive: true });
  const angle = process.env.VISUAL_ANGLE || 'swiftshader';
  const snapshot = await snapshotSource(root);
  const server = await serveSnapshot(snapshot);
  const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const report = { createdAt: new Date().toISOString(), angle, source: { digest: snapshot.digest }, songs: [] };
  try {
    for (const wav of songs) {
      const form = JSON.parse(await fs.readFile(wav.replace(/\.wav$/i, '.form.json'), 'utf8'));
      const settings = { ...DEFAULT_SETTINGS, view: 'teton-jackson-lake', biome: 'CONIFER' };
      const row = { file: path.basename(wav), errors: [], warnings: [], events: [] };
      const loaded = await openEvaluationSong(browser, { url: server.url, audioPath: path.resolve(wav), settings, diagnostics: { ...row, loadedFiles: new Set() } });
      try {
        const detected = await loaded.page.evaluate(async () => {
          const { sectionRoles } = await import('/src/world/terrain/SectionRoles.js');
          const mgr = window.__SMW.sim.biomes;
          const sections = (mgr.sections || []).map((s) => ({ startMs: Math.round(s.startMs), endMs: Math.round(s.endMs), label: s.label ?? null,
            kind: s.kind ?? null, relEnergy01: s.relEnergy01 ?? null, chapterId: s.chapterId ?? null, profile: s.profile ?? null }));
          const roles = sectionRoles({ sections: mgr.sections, durationMs: mgr.durationMs, energyCurves: mgr.energyCurves,
            conductorSchedule: mgr.conductorSchedule || [], noteEvents: mgr.conductor?.timeline || [] });
          const energy = [];
          for (let t = 0; t <= mgr.durationMs; t += 100) energy.push(+(mgr.energyCurves?.globalEnergy?.(t) ?? 0).toFixed(5));
          return { durationMs: mgr.durationMs, sections, roles: roles.map((r) => ({ role: r.role, finalChorus: !!r.finalChorus, stops: r.stops || [] })),
            energyStepMs: 100, energy };
        });
        Object.assign(row, { form, detected, comparison: compareStructure(form, detected) });
      } finally { await loaded.context.close(); await loaded.browserDiagnostics.dispose(); }
      report.songs.push(row);
      const c = row.comparison;
      console.log(`${row.file}: ${row.detected.sections.length} sections (intended ${form.sections.length}); max boundary error ${c.maxBoundaryErrorMs} ms; missed boundaries ${c.missedBoundaries}; missed payoffs ${c.missedPayoffs}`);
      for (const [i, s] of row.detected.sections.entries()) console.log(`  ${(s.startMs / 1000).toFixed(2).padStart(7)}s ${String(s.label).padEnd(6)} ${row.detected.roles[i]?.role}${row.detected.roles[i]?.finalChorus ? ' (final chorus)' : ''}`);
    }
  } finally {
    await browser.close(); await server.close();
    await fs.writeFile(path.join(out, 'structure.json'), JSON.stringify(report, null, 1));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
