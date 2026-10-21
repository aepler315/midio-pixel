// Replay the runtime shot-tour planner offline: plan a view's library against
// a song's analysed sections, roles and energy (as captured by
// tools/song-structure-probe.mjs from the real upload/analysis path), build
// the timeline, and report the shot sequence, the payoff timing against the
// music and the motion diagnostics. Deterministic: the same inputs give the
// same plan as the browser worker.
//
//   node tools/plan-scenic-tour.mjs --library DIR_OR_MANIFEST --structure structure.json [--song anthem.wav]
//        [--seed N] [--out plan.json]
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeShotLibrary } from '../src/world/terrain/ShotLibrary.js';
import { planShotTour } from '../src/world/terrain/ShotPlanner.js';
import { buildShotTimeline, restoreShotTimeline } from '../src/world/terrain/ShotTimeline.js';

/** A library from a directory holding <view>.shots.json + .shots.bin.gz, or a manifest path. */
export async function readLibrary(where) {
  const stat = await fs.stat(where);
  const manifestPath = stat.isDirectory() ? path.join(where, (await fs.readdir(where)).find((f) => f.endsWith('.shots.json'))) : where;
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const decoded = zlib.gunzipSync(await fs.readFile(path.join(path.dirname(manifestPath), manifest.payload.url)));
  return decodeShotLibrary(manifest, new Uint8Array(decoded));
}

/** Song inputs (sections, roles, energy) for one probed song. */
export function songInputs(structure, file = null) {
  const song = file ? structure.songs.find((s) => s.file === file) : structure.songs[0];
  if (!song) throw new Error(`no probed song ${file}`);
  const d = song.detected;
  return { file: song.file, form: song.form, durationMs: Math.round(d.durationMs), sections: d.sections,
    roles: d.roles, energy: Float32Array.from(d.energy), energyStepMs: d.energyStepMs };
}

/** Plan + timeline + a readable report. */
export function replay(library, inputs, { seed = 315, visible = null } = {}) {
  const t0 = performance.now();
  const plan = planShotTour(library, { durationMs: inputs.durationMs, sections: inputs.sections, roles: inputs.roles,
    energy: inputs.energy, energyStepMs: inputs.energyStepMs, visible: visible || [{ startMs: 0, endMs: inputs.durationMs }], seed });
  const t1 = performance.now();
  const timeline = restoreShotTimeline(buildShotTimeline(library, plan));
  const t2 = performance.now();
  const shots = plan.items.filter((i) => i.kind === 'shot').map((i) => {
    const s = library.shotById.get(i.id);
    return { id: i.id, move: s.move, subjectId: s.subjectId, startMs: i.startMs, endMs: i.endMs, payoffMs: i.payoffMs ?? null,
      lens: s.traits.lens, elevation: s.traits.elevation, score: s.score.total };
  });
  // Payoff timing against the song's intended moments (generator ground truth).
  const payoffs = (inputs.form?.payoffs || []).map((p) => {
    const near = shots.filter((s) => s.payoffMs != null).reduce((best, s) => (!best || Math.abs(s.payoffMs - p.timeMs) < Math.abs(best.payoffMs - p.timeMs) ? s : best), null);
    return { ...p, plannedMs: near?.payoffMs ?? null, errorMs: near ? near.payoffMs - p.timeMs : null, shot: near?.id ?? null, move: near?.move ?? null };
  });
  return { plan, timeline, planMs: t1 - t0, timelineMs: t2 - t1, shots, payoffs, moments: plan.moments, notes: plan.notes,
    diagnostics: timeline.diagnostics, fallback: plan.fallback };
}

async function main() {
  const args = process.argv.slice(2), opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  if (!opt('--library') || !opt('--structure')) throw new Error('usage: node tools/plan-scenic-tour.mjs --library DIR --structure structure.json [--song file.wav]');
  const library = await readLibrary(path.resolve(opt('--library')));
  const inputs = songInputs(JSON.parse(await fs.readFile(path.resolve(opt('--structure')), 'utf8')), opt('--song'));
  const r = replay(library, inputs, { seed: Number(opt('--seed') ?? 315) });
  console.log(`${library.viewId} x ${inputs.file}: ${r.shots.length} shots, plan ${r.planMs.toFixed(1)} ms, timeline ${r.timelineMs.toFixed(1)} ms${r.fallback ? `, FALLBACK ${r.fallback}` : ''}`);
  for (const s of r.shots) {
    console.log(`  ${(s.startMs / 1000).toFixed(1).padStart(6)}-${(s.endMs / 1000).toFixed(1).padEnd(6)} payoff ${s.payoffMs == null ? '   -  ' : (s.payoffMs / 1000).toFixed(1).padStart(6)}  ${s.move.padEnd(9)} ${s.lens.padEnd(6)} ${String(s.elevation).padEnd(5)} ${s.subjectId}`);
  }
  for (const p of r.payoffs) console.log(`  ${p.kind} at ${(p.timeMs / 1000).toFixed(1)} s -> planned payoff ${p.plannedMs == null ? 'none' : `${(p.plannedMs / 1000).toFixed(2)} s (${p.errorMs >= 0 ? '+' : ''}${p.errorMs} ms, ${p.move})`}`);
  console.log('  diagnostics', JSON.stringify(r.diagnostics));
  if (r.notes?.length) console.log('  notes', r.notes.slice(0, 8).join(' | '));
  if (opt('--out')) await fs.writeFile(path.resolve(opt('--out')), JSON.stringify({ ...r, plan: { ...r.plan, moments: undefined }, timeline: undefined }, null, 1));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
