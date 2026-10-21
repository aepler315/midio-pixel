// Before/after motion evidence for camera tours from two visual:eval runs of
// the identical manifest (docs/visual-evaluation-loop.md): side-by-side MP4
// clips with the matching audio, a checkpoint contact sheet, and an index of
// timestamps, camera state, shot state, source identity and settings.
//
//   node tools/tour-evidence.mjs --base .smoke/x/base/<run> --cand .smoke/x/cand/<run> --out DIR [--label NAME]
//
// Needs ffmpeg on PATH. Outputs are review evidence: keep them out of git
// (AGENTS.md) and attach them to a release.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const FONT = process.platform === 'win32' ? 'C\\:/Windows/Fonts/consola.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const ffmpeg = (args) => execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const label = (text, x = 10) => `drawtext=fontfile='${FONT}':text='${text.replace(/[':]/g, ' ')}':x=${x}:y=10:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6`;

/** Frames of clip `k` from a report, ordered by time. */
export function clipFrames(song, k) {
  return song.frames.filter((f) => f.clips?.includes(k)).sort((a, b) => a.timeMs - b.timeMs);
}

/** Checks that two reports are a matched pair (same manifest, audio, schedule). */
export function matchedPair(a, b) {
  const problems = [];
  const same = (x, y, what) => { if (JSON.stringify(x) !== JSON.stringify(y)) problems.push(what); };
  same(a.settings, b.settings, 'settings');
  same(a.environment, b.environment, 'render environment');
  a.songs.forEach((s, i) => {
    const t = b.songs[i];
    if (!t) { problems.push(`song ${s.id} missing`); return; }
    same(s.audioSha256, t.audioSha256, `${s.id} audio`);
    same(s.clips, t.clips, `${s.id} clips`);
    same(s.frames.map((f) => f.timeMs), t.frames.map((f) => f.timeMs), `${s.id} frame times`);
  });
  return problems;
}

const camera = (f) => f.camera ? { eyeM: f.camera.eyeM?.map((v) => +v.toFixed(1)), forward: f.camera.forward?.map((v) => +v.toFixed(4)),
  fovYDeg: +(f.camera.fovYDeg ?? 0).toFixed(2), shot: f.camera.shot?.shot ? { id: f.camera.shot.shot.id, kind: f.camera.shot.shot.kind,
    phase: f.camera.shot.shot.phase, subjectId: f.camera.shot.shot.subjectId } : (f.camera.shot ? { state: f.camera.shot.state, reason: f.camera.shot.reason } : null) } : null;

export async function buildEvidence({ base, cand, out, name = null, fps = null }) {
  const A = JSON.parse(await fs.readFile(path.join(base, 'report.json'), 'utf8'));
  const B = JSON.parse(await fs.readFile(path.join(cand, 'report.json'), 'utf8'));
  const problems = matchedPair(A, B);
  if (problems.length) throw new Error(`not a matched pair: ${problems.join(', ')}`);
  await fs.mkdir(out, { recursive: true });
  const rate = fps || A.settings.fps;
  const id = name || A.settings.view || 'view';
  const index = { view: A.settings.view, biome: A.settings.biome, settings: A.settings, environment: A.environment, browser: A.browser,
    before: { commit: A.source.commit, digest: A.source.digest, dirty: A.source.dirty, overrides: A.overrides || null },
    after: { commit: B.source.commit, digest: B.source.digest, dirty: B.source.dirty, overrides: B.overrides || null },
    clips: [], checkpoints: [] };
  for (const [si, song] of A.songs.entries()) {
    const other = B.songs[si];
    // Side-by-side clips with the song's audio for exactly that window.
    for (const [k, clip] of song.clips.entries()) {
      const fa = clipFrames(song, k), fb = clipFrames(other, k);
      if (!fa.length) continue;
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tour-evidence-'));
      try {
        for (const [side, frames, dir] of [['a', fa, base], ['b', fb, cand]]) {
          await fs.mkdir(path.join(tmp, side));
          for (const [i, f] of frames.entries()) await fs.copyFile(path.join(dir, f.png), path.join(tmp, side, `${String(i).padStart(5, '0')}.png`));
        }
        const startS = fa[0].actualTimeMs / 1000, file = `${id}-${song.id}-${String(Math.round(startS)).padStart(3, '0')}s.mp4`;
        ffmpeg(['-framerate', String(rate), '-i', path.join(tmp, 'a', '%05d.png'), '-framerate', String(rate), '-i', path.join(tmp, 'b', '%05d.png'),
          '-ss', startS.toFixed(3), '-t', (fa.length / rate).toFixed(3), '-i', path.join(base, song.audio),
          '-filter_complex', `[0]${label('before - authored rail')}[l];[1]${label('after - shot tour')}[r];[l][r]hstack=inputs=2,drawtext=fontfile='${FONT}':text='${song.id} %{pts\\:hms\\:${startS.toFixed(3)}}':x=(w-tw)/2:y=h-34:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6[v]`,
          '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '160k', '-shortest', path.join(out, file)]);
        index.clips.push({ file, song: song.id, audioSha256: song.audioSha256, startMs: fa[0].actualTimeMs, endMs: fa.at(-1).actualTimeMs, frames: fa.length, fps: rate,
          before: { first: camera(fa[0]), last: camera(fa.at(-1)) }, after: { first: camera(fb[0]), last: camera(fb.at(-1)),
            shots: [...new Map(fb.map((f) => camera(f)?.shot).filter((s) => s?.id).map((s) => [s.id, s])).values()] } });
      } finally { await fs.rm(tmp, { recursive: true, force: true }); }
    }
    // Checkpoints: before | after rows.
    const cps = song.frames.filter((f) => f.checkpoint);
    if (cps.length) {
      const sheet = `${id}-${song.id}-checkpoints.png`, inputs = [], filters = [];
      cps.forEach((f, i) => {
        const g = other.frames.find((x) => x.timeMs === f.timeMs);
        inputs.push('-i', path.join(base, f.png), '-i', path.join(cand, g.png));
        const t = (f.actualTimeMs / 1000).toFixed(1);
        filters.push(`[${2 * i}]scale=480:-2,${label(`${t}s before`)}[a${i}];[${2 * i + 1}]scale=480:-2,${label(`${t}s after`)}[b${i}];[a${i}][b${i}]hstack[r${i}]`);
        index.checkpoints.push({ song: song.id, timeMs: f.actualTimeMs, before: { png: f.png, sha256: f.sha256, camera: camera(f) }, after: { png: g.png, sha256: g.sha256, camera: camera(g) } });
      });
      filters.push(`${cps.map((_, i) => `[r${i}]`).join('')}vstack=inputs=${cps.length}[v]`);
      ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '[v]', path.join(out, sheet)]);
      index.sheet = sheet;
    }
  }
  await fs.writeFile(path.join(out, `${id}-evidence.json`), JSON.stringify(index, null, 1));
  return index;
}

async function main() {
  const args = process.argv.slice(2), opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  if (!opt('--base') || !opt('--cand') || !opt('--out')) throw new Error('usage: node tools/tour-evidence.mjs --base DIR --cand DIR --out DIR [--label NAME]');
  const index = await buildEvidence({ base: path.resolve(opt('--base')), cand: path.resolve(opt('--cand')), out: path.resolve(opt('--out')), name: opt('--label') });
  console.log(`${index.view}: ${index.clips.length} clips, ${index.checkpoints.length} checkpoints -> ${opt('--out')}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
