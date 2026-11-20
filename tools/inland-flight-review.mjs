#!/usr/bin/env node
// Render matched motion clips of a Returning summits inland region on the
// fixed export clock: real upload, analysis, terrain assembly and renderer.
// Writes PNG frames, a per-frame camera log and (with ffmpeg) an MP4 with the
// recording's own audio. Private recordings stay outside the repository.
//
//   node tools/inland-flight-review.mjs --audio song.mp3 --out .smoke/inland/song \
//     [--clip name:startMs:seconds]... [--fps 24] [--width 960] [--height 540]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openSong, captureFrame } from './range-scene-smoke.mjs';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = { clips: [], fps: 24, width: 960, height: 540, grid: 'detailed', stills: [] };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = process.argv[++i];
  if (k === '--audio') args.audio = v;
  else if (k === '--out') args.out = v;
  else if (k === '--clip') args.clips.push(v);
  else if (k === '--still') args.stills.push(Number(v));
  else if (k === '--fps') args.fps = Number(v);
  else if (k === '--width') args.width = Number(v);
  else if (k === '--height') args.height = Number(v);
  else if (k === '--grid') args.grid = v;
  else if (k === '--android') { args.android = v; }
  else if (k === '--url') args.url = v;
  else if (k === '--source') args.source = v;
  else if (k === '--param') { const [key, value] = v.split('='); (args.params ||= {})[key] = value; }
  else throw new Error(`unknown option ${k}`);
}
assert.ok(args.audio && args.out, '--audio and --out are required');
await fs.mkdir(args.out, { recursive: true });

let server, browser;
const log = { android: args.android ?? null, audio: path.basename(args.audio), fps: args.fps, size: [args.width, args.height], clips: [], stills: [] };
try {
  const url = args.url || (server = await serveSnapshot(await snapshotSource(args.source || root))).url;
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--no-sandbox'],
  });
  const t0 = Date.now();
  const { page, errors } = await openSong(browser, { url, wav: args.audio, width: args.width, height: args.height,
    params: { songprintLandscape: 'on', rangeRenderer: 'v2', rangeTour: 'shots', lyrics: '0', rangeGrid: args.grid, ...args.params },
    // --android MEMORY_GB: an Android head unit's user agent and reported memory,
    // so the mobile budget and residency apply (not its GPU or CPU speed).
    ...(args.android ? {
      contextOptions: { userAgent: 'Mozilla/5.0 (Linux; Android 10; JY-UTS18N12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      initScript: `Object.defineProperty(navigator, 'deviceMemory', { get: () => ${Number(args.android)} });`,
    } : {}) });
  log.openMs = Date.now() - t0;
  const describe = () => page.evaluate(() => {
    const smw = window.__SMW, range = smw.sim.biomes.rangePresentation;
    const prepared = range?.scene?.prepared?.get(range.viewId);
    const m = prepared?.data?.manifest;
    return { viewId: range?.viewId, water: range?.scene?.hasWater?.(range.viewId) ?? null, mirrors: range?.scene ? !!(range.scene.mirrors?.A || range.scene.mirrors?.B) : null, budget: range?.scene?.budget, residencyBytes: range?.residency?.budgetBytes ?? null, durationMs: smw.durationMs, inland: !!prepared?.view?.songRange?.plan?.inland,
      plan: prepared?.view?.songRange?.plan && { biome: prepared.view.songRange.plan.biome, slots: prepared.view.songRange.plan.slots.map(s => s.pieceId) },
      rivers: m?.hydrology?.region?.rivers?.length ?? null, riverFlow: m?.hydrology?.riverFlow ?? null,
      tiles: m?.tiles?.length, estimated: m?.estimatedBytes, trees: prepared?.stats?.trees ?? null,
      triangles: prepared?.stats?.triangles ?? null, timings: prepared?.timings ?? null,
      legTimesMs: (() => {
        const score = smw.sim.biomes.landscapeScore, route = prepared?.inlandFlight?.route;
        if (!score?.songprintOrbit || !route) return null;
        const marks = route.times.slice(1, -1), out = [];
        let k = 0;
        for (let t = 0; t <= smw.durationMs && k < marks.length; t += 250) {
          if (score.songprintOrbit.at(t).progress01 >= marks[k]) { out.push(t); k++; }
        }
        return out;
      })(),
      route: prepared?.inlandFlight?.route ? { kind: prepared.inlandFlight.route.kind, times: prepared.inlandFlight.route.times,
        landmarks: prepared.inlandFlight.route.landmarks } : null };
  });
  const pose = () => page.evaluate(() => {
    const range = window.__SMW.sim.biomes.rangePresentation;
    const prepared = range.scene.prepared.get(range.viewId);
    const p = range.scene.camera.userData.rangeCameraPose;
    const ground = prepared?.data ? window.__SMW_groundAt?.(prepared.data, p.eyeM[0], p.eyeM[2]) : null;
    return { eyeM: p.eyeM.map(v => Math.round(v)), targetM: p.targetM.map(v => Math.round(v)), fovYDeg: p.fovYDeg,
      orbit: p.songprintOrbit ? { from: p.songprintOrbit.from, to: p.songprintOrbit.to, travelM: Math.round(p.songprintOrbit.travelM ?? 0),
        progress01: p.songprintOrbit.progress01, mode: p.songprintOrbit.mode ?? null, aglM: p.songprintOrbit.aglM ?? null } : null, ground };
  });
  await page.evaluate(async () => {
    const { terrainHeightAt } = await import('/src/world/alpine/TerrainMesh.js');
    window.__SMW_groundAt = (data, x, z) => { const y = terrainHeightAt(data, x, z); return Number.isFinite(y) ? Math.round(y) : null; };
  });
  for (const timeMs of args.stills) {
    const frame = await captureFrame(page, timeMs);
    const file = path.join(args.out, `still-${String(timeMs).padStart(7, '0')}.png`);
    await fs.writeFile(file, Buffer.from(frame.png, 'base64'));
    log.stills.push({ timeMs, file: path.basename(file), drawMs: Math.round(frame.drawMs), ...(await pose()) });
  }
  log.scene = await describe();
  for (const spec of args.clips) {
    const [name, start, seconds] = spec.split(':');
    const dir = path.join(args.out, name);
    await fs.mkdir(dir, { recursive: true });
    const frames = Math.round(Number(seconds) * args.fps), clip = { name, startMs: Number(start), seconds: Number(seconds), frames: [] };
    const began = Date.now();
    for (let f = 0; f < frames; f++) {
      const timeMs = Math.round(Number(start) + f * 1000 / args.fps);
      const frame = await captureFrame(page, timeMs);
      await fs.writeFile(path.join(dir, `${String(f).padStart(5, '0')}.png`), Buffer.from(frame.png, 'base64'));
      clip.frames.push({ timeMs, drawMs: Math.round(frame.drawMs), ...(await pose()) });
    }
    clip.renderSec = Math.round((Date.now() - began) / 1000);
    log.clips.push(clip);
    const mp4 = path.join(args.out, `${name}.mp4`);
    const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(args.fps), '-i', path.join(dir, '%05d.png'),
      '-ss', String(Number(start) / 1000), '-t', String(seconds), '-i', args.audio,
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-shortest', mp4]);
    clip.mp4 = ff.status === 0 ? path.basename(mp4) : `ffmpeg failed: ${ff.stderr}`;
    await fs.writeFile(path.join(args.out, 'review.json'), JSON.stringify(log, null, 1));
  }
  log.errors = errors;
  log.scene = await describe();
  await fs.writeFile(path.join(args.out, 'review.json'), JSON.stringify(log, null, 1));
  console.log(JSON.stringify({ scene: log.scene, errors, stills: log.stills.length, clips: log.clips.map(c => [c.name, c.frames.length, c.renderSec]) }, null, 1));
} finally {
  await browser?.close();
  await server?.close?.();
}
