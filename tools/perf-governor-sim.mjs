// How the quality ladder (src/render/PerfGovernor.js) answers frame traces.
// No browser and no GPU: synthetic rAF periods and callback work go through
// the real governor, and the level changes are printed.
//
//   node tools/perf-governor-sim.mjs
//
// A trace is a statement about the governor's rules. Which trace a given
// machine produces is a hardware question this tool cannot answer.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PerfGovernor, WARMUP_MS } from '../src/render/PerfGovernor.js';

const VSYNC_MS = 1000 / 60;

/** Deterministic jitter in [-0.6, 0.6) ms, so healthy frames are not exact. */
export function jitterSource(seed = 12345) {
  let state = seed;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return (state / 4294967296 - 0.5) * 1.2; };
}

/**
 * Feed `seconds` of frames to a governor. `frame(index, elapsedMs, level)`
 * returns { delta, work }: the rAF period and that callback's work. As in
 * the frame loop (src/main.js), each sample carries the previous callback's
 * work. Returns the final level and every level change.
 */
export function runTrace(frame, { seconds = 60, startLevel = 0, warmup = true, capFps = 60, governor = null } = {}) {
  const g = governor || new PerfGovernor({ startLevel });
  const origin = 1000;
  let now = origin, level = g.level, previousWork, index = 0;
  if (warmup) g.beginWarmup(now);
  const changes = [];
  while (now - origin < seconds * 1000) {
    const f = frame(index++, now - origin, g.level);
    now += f.delta;
    g.sample(f.delta, now, { capFps, workMs: previousWork });
    previousWork = f.work;
    if (g.level !== level) { changes.push({ atSec: (now - origin) / 1000, from: level, to: g.level }); level = g.level; }
  }
  return { level: g.level, changes };
}

/** True once per `everyMs` of elapsed time. */
const every = (elapsedMs, everyMs) => Math.floor(elapsedMs / everyMs) !== Math.floor((elapsedMs - VSYNC_MS) / everyMs);

export function scenarios() {
  const jitter = jitterSource();
  const healthy = () => VSYNC_MS + jitter();
  return [
    { name: 'healthy 60 Hz, 7 ms of work', seconds: 60,
      frame: () => ({ delta: healthy(), work: 7 }) },
    { name: 'level 0 misses every third vsync; every other level is healthy', seconds: 60,
      frame: (i, t, level) => ({ delta: level === 0 && i % 3 === 0 ? 2 * VSYNC_MS : healthy(), work: 7 }) },
    { name: 'level 0 runs at 20 ms; level 1 is healthy except one 30 ms frame every 4 s', seconds: 180,
      frame: (i, t, level) => ({ delta: level === 0 ? 20 : every(t, 4000) ? 30 : healthy(), work: 7 }) },
    { name: 'starts at level 1; periods healthy; every callback works 12.5 ms', seconds: 180, startLevel: 1,
      frame: () => ({ delta: healthy(), work: 12.5 }) },
    { name: 'starts at level 1; 9 ms of work with one 12 ms callback every 8 s', seconds: 180, startLevel: 1,
      frame: (i, t) => ({ delta: healthy(), work: every(t, 8000) ? 12 : 9 }) },
    { name: '1.5 s of 60 ms frames right after the warm-up, then healthy with ordinary jitter', seconds: 120,
      frame: (i, t) => (t > WARMUP_MS && t < WARMUP_MS + 1500 ? { delta: 60, work: 50 } : { delta: healthy(), work: 7 }) },
    { name: '1.5 s of 60 ms frames right after the warm-up, then exactly 16.67 ms and 6 ms of work', seconds: 120,
      frame: (i, t) => (t > WARMUP_MS && t < WARMUP_MS + 1500 ? { delta: 60, work: 50 } : { delta: VSYNC_MS, work: 6 }) },
    { name: 'starts at level 1; clean for 12 s, then one 40 ms frame every 5 s', seconds: 120, startLevel: 1,
      frame: (i, t) => ({ delta: t > 12500 && every(t, 5000) ? 40 : VSYNC_MS, work: 6 }) },
    { name: 'level 1 and deeper cost more than level 0 did: 22 ms at levels 0 to 3, healthy from level 4', seconds: 180,
      frame: (i, t, level) => ({ delta: level < 4 ? 22 : healthy(), work: 7 }) },
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`warm-up ${WARMUP_MS} ms; times are seconds since the governor started\n`);
  for (const [n, s] of scenarios().entries()) {
    const result = runTrace(s.frame, s);
    const changes = result.changes.map((c) => `${c.atSec.toFixed(1)} s ${c.from}->${c.to}`).join(', ') || 'no change';
    console.log(`${n + 1}. ${s.name} (${s.seconds} s)\n   ends at level ${result.level}: ${changes}`);
  }
}
