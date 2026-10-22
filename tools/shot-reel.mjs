// Every shot of a view's published library, in motion, in the actual
// application (docs/scenic-tours.md, "Rendered review"): the view's tour
// timeline is replaced by one that plays each shot from entry to exit at its
// ideal pace, one after another with a cut between, and the frames are
// rendered on the export clock. Writes the frames, an index (frame -> shot,
// progress, drawn camera) and an MP4 with each shot's id and move burned in.
//
//   VISUAL_ANGLE=gl node tools/shot-reel.mjs --view monument-valley-163 --song song.wav [--fps 12] [--size 960x540] [--out DIR]
//
// The song only drives the export clock and the scene's light and weather
// (a reel needs one at least as long as its longest session, 160 s);
// without --song, .smoke/tour-audio/anthem.wav, as tools/shot-tour-smoke.mjs.
//
// Review evidence: keep it out of git (AGENTS.md).
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';
import { openEvaluationSong, renderEvaluationFrame } from './lib/visual-evaluation-browser.mjs';
import { DEFAULT_SETTINGS } from './lib/visual-evaluation.mjs';
import { decodeShotLibrary } from '../src/world/terrain/ShotLibrary.js';
import SCENE_CATALOG from '../src/world/terrain/sceneCatalogData.js';
import { createReelTimeline } from './lib/shot-reel-timeline.mjs';
import { readReviewLibraryIdentity } from './lib/scenic-review.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT = process.platform === 'win32' ? 'C\\:/Windows/Fonts/consola.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';

/** The reel's schedule: each shot's span on the reel clock (ms). */
export function reelSchedule(shots, { gapMs = 0 } = {}) {
  let t = 0;
  return shots.map((s) => { const span = { id: s.id, move: s.move, startMs: t, endMs: t + s.durationMs.ideal }; t = span.endMs + gapMs; return span; });
}

async function main() {
  const args = process.argv.slice(2), opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const viewId = opt('--view'), fps = Number(opt('--fps', 12)), [width, height] = opt('--size', '960x540').split('x').map(Number);
  const view = SCENE_CATALOG.views.find((v) => v.id === viewId);
  if (!view?.shotsManifestUrl) throw new Error(`${viewId} has no shot library in the catalog`);
  const song = path.resolve(opt('--song', path.join(root, '.smoke', 'tour-audio', 'anthem.wav')));
  if (!(await fs.stat(song).catch(() => null))?.isFile()) throw new Error(`no song at ${song}: pass --song FILE (any audio file at least 160 s long)`);
  const out = path.resolve(opt('--out', path.join(root, '.smoke', 'shot-reels', viewId)));
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(path.join(out, 'frames'), { recursive: true });
  const R = path.join(root, 'src', 'assets', 'range', 'v2');
  const manifestPath = path.join(R, view.shotsManifestUrl);
  const { identity } = await readReviewLibraryIdentity(manifestPath, { viewId, terrainManifestPath: path.join(R, view.terrainManifestUrl) });
  const manifestText = await fs.readFile(manifestPath, 'utf8'), manifest = JSON.parse(manifestText);
  const library = decodeShotLibrary(manifest, new Uint8Array(zlib.gunzipSync(await fs.readFile(path.join(R, 'tour', manifest.payload.url)))));
  // One session plays at most maxMs of reel (the song's export clock ends
  // with the song); longer libraries take several sessions.
  const maxMs = 160000, chunks = [];
  for (const s of library.shots) {
    const last = chunks.at(-1);
    if (!last || last.reduce((t, x) => t + x.durationMs.ideal, 0) + s.durationMs.ideal > maxMs) chunks.push([s]); else last.push(s);
  }
  const schedule = chunks.flatMap((c, ci) => reelSchedule(c).map((x) => ({ ...x, session: ci })));
  // Each shot's path as plain arrays for the page.
  const paths = library.shots.map((s) => ({ id: s.id, s: [...s.path.s], eye: [...s.path.eye], aim: [...s.path.aim], fov: [...s.path.fov] }));
  process.env.VISUAL_RANGE_SHOTS = 'all';
  const snapshot = await snapshotSource(root), server = await serveSnapshot(snapshot);
  const browser = await chromium.launch({ headless: true, args: [`--use-angle=${process.env.VISUAL_ANGLE || 'gl'}`, '--ignore-gpu-blocklist'] });
  const settings = { ...DEFAULT_SETTINGS, width, height, view: viewId, biome: view.biome, quality: 0 };
  const index = { viewId, manifestSha256: identity.manifestSha256, identity, source: snapshot.digest, fps, size: [width, height], schedule, frames: [] };
  let k = 0;
  try {
   for (const [ci, chunk] of chunks.entries()) {
    const spans = schedule.filter((x) => x.session === ci), chunkPaths = paths.filter((p) => chunk.some((s) => s.id === p.id));
    const loaded = await openEvaluationSong(browser, { url: server.url, audioPath: song, settings,
      diagnostics: { errors: [], warnings: [], events: [], loadedFiles: new Set() } });
    const page = loaded.page;
    // The reel's timeline: pathPoseAt over the scheduled shot (uniform
    // Catmull-Rom on samples, as ShotPath does), on the export clock.
    // Inject the same self-contained factory used below to label frames.
    // Keeping clock selection inside it prevents the camera and index from
    // disagreeing at a cut or at the exact end of the final shot.
    await page.evaluate(`(([id, paths, schedule]) => {
      const rp = window.__SMW.sim.biomes.rangePresentation, v = rp.shots.views.get(id);
      const reel = Object.assign(Object.create(v.timeline), (${createReelTimeline.toString()})(paths, schedule));
      v.timeline = reel; rp.scene?.setCameraTour?.(id, reel);
    })(${JSON.stringify([viewId, chunkPaths, spans])})`);
    const timeline = createReelTimeline(chunkPaths, spans);
    const end = spans.at(-1).endMs, step = 1000 / fps;
    for (let j = 0, t = 0; t <= end; j++, k++, t = j * step) {
      const f = await renderEvaluationFrame(page, { timeMs: t, checkpoint: false, clips: [0], save: true }, settings);
      const frame = timeline.frameAt(t);
      const file = `frames/${String(k).padStart(5, '0')}.png`;
      await fs.writeFile(path.join(out, file), Buffer.from(f.pngData, 'base64'));
      index.frames.push({ k, session: ci, timeMs: t, shot: frame.shot, move: frame.move, progress: frame.progress, eyeM: f.camera?.eyeM, forward: f.camera?.forward, file });
    }
    await loaded.context.close();
   }
  } finally { await browser.close(); await server.close?.(); }
  await fs.writeFile(path.join(out, 'reel.json'), JSON.stringify(index, null, 1));
  // MP4 with the current shot's id and move burned in (one drawtext per shot).
  const text = (s) => s.replace(/[':\\]/g, ' ');
  // Labels follow the reel clock across sessions (each starts where the
  // frames before it end).
  const sessionStart = chunks.map((_, ci) => index.frames.find((fr) => fr.session === ci).k * 1000 / fps);
  const labels = schedule.map((x) => ({ ...x, startMs: x.startMs + sessionStart[x.session], endMs: x.endMs + sessionStart[x.session] })).map((x) => `drawtext=fontfile='${FONT}':text='${text(`${x.move} ${x.id}`)}':x=10:y=h-30:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=5:enable='between(t,${(x.startMs / 1000).toFixed(3)},${(x.endMs / 1000).toFixed(3)})'`).join(',');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(out, 'frames', '%05d.png'),
    '-vf', labels, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', path.join(out, `${viewId}-reel.mp4`)], { stdio: 'inherit' });
  // A sheet: each shot a row of five frames across its move.
  const { contactSheet } = await import('./lib/scenic-render.mjs');
  const picks = [], labels2 = [];
  for (const x of schedule) {
    const frames = index.frames.filter((fr) => fr.shot === x.id && fr.session === x.session);
    for (const q of [0.02, 0.25, 0.5, 0.75, 0.98]) {
      const fr = frames.reduce((a, b) => (Math.abs(b.progress - q) < Math.abs(a.progress - q) ? b : a));
      picks.push(await fs.readFile(path.join(out, fr.file)));
      labels2.push(`${x.move} ${x.id.slice(0, 34)} ${Math.round(q * 100)}%`);
    }
  }
  await contactSheet(picks, { columns: 5, labels: labels2, out: path.join(out, `${viewId}-reel-sheet.png`), tileWidth: 288 });
  console.log(`${viewId}: ${schedule.length} shots in ${chunks.length} session(s), ${index.frames.length} frames -> ${out}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
