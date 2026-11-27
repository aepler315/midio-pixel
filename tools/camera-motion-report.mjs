#!/usr/bin/env node
// Camera motion report: drives the real Landscape camera path
// (RangeScene.movedPose with the score's structural move, pulse, reveal
// lens, land rise, Songprint orbit and the scene rail plan) over a
// synthetic song at a fixed 30 fps clock and measures how the drawn camera
// moves. Node only, deterministic, no renderer. Use it to compare camera
// tunings before a render review:
//
//   node tools/camera-motion-report.mjs            # table
//   node tools/camera-motion-report.mjs --json     # machine-readable
//
// Measures, per scenario:
//   lookPeak/lookP99   angular speed of the look direction, deg/s
//   lookAccPeak        angular acceleration of the look direction, deg/s²
//   flowPeak/flowP99   eye speed as a fraction of the eye-to-subject distance
//                      per second (on-screen parallax proxy), 1/s
//   zoomPeak           |d ln tan(fov/2) / dt|, 1/s
//   landKm             mean frame width at the subject distance, km
//   sweeps             seconds with look speed above SWEEP_DEG_S
//
// Scenarios: composed (Songprint orbit from the first frame), handoff (the
// orbit admitted 12 s in, after the rail has played) and rail (a catalog
// view on its authored rail at the default pace).
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { scenePoseAt } from '../src/world/terrain/SceneTravel.js';
import { compileCinematicPulse } from '../src/world/alpine/CinematicPulse.js';
import { rangeCameraMoveAt, FINALE_MS } from '../src/world/alpine/RangeCamera.js';
import { compileSongprintOrbitScore } from '../src/world/alpine/SongprintOrbitScore.js';
import { compileLandRise } from '../src/world/alpine/LandRise.js';
import { compileLensCues, revealLensFromCues } from '../src/render/CameraLens.js';
import { compileSceneRailPlan } from '../src/world/terrain/SceneRailPlan.js';

const FPS = 30;
const SWEEP_DEG_S = 6;
const BASE_M = 2000;
const DURATION_MS = 210000;

// A pop-shaped song: quiet intro, verses, builds, drops and a bridge.
const PLAN = [
  [0, .25, 'intro'], [14000, .45, 'verse'], [36000, .62, 'build'], [48000, .9, 'chorus'],
  [70000, .42, 'verse'], [92000, .68, 'build'], [102000, .93, 'drop'], [124000, .3, 'bridge'],
  [146000, .7, 'build'], [156000, .97, 'chorus'], [186000, .35, 'outro'],
];
const SECTIONS = PLAN.map(([startMs, relEnergy01, role], i) => ({
  startMs, endMs: PLAN[i + 1]?.[0] ?? DURATION_MS, relEnergy01, role, provenance: 'detected', profile: i % 2 ? 'A' : 'A',
}));
const smooth = u => { const t = Math.max(0, Math.min(1, u)); return t * t * (3 - 2 * t); };
function read(t) {
  let i = 0;
  while (i + 1 < SECTIONS.length && SECTIONS[i + 1].startMs <= t) i++;
  const cur = SECTIONS[i].relEnergy01, prev = SECTIONS[i - 1]?.relEnergy01 ?? cur;
  const settle = smooth((t - SECTIONS[i].startMs) / 900);
  const beat = .06 * Math.max(0, Math.sin(2 * Math.PI * t / 500)) ** 6;
  return Math.max(0, Math.min(1, prev + (cur - prev) * settle + beat));
}
const curves = { globalEnergyNorm: read };

function stage() {
  const boundsM = { min: [-22400, BASE_M, -22400], max: [22400, 4800, 22400] };
  const groundAt = (x, z) => Math.abs(x) <= 22400 && Math.abs(z) <= 22400
    ? BASE_M + 400 * Math.exp(-((x - 3200) ** 2 + (z - 11700) ** 2) / 2500000) : NaN;
  const camera = { eyeStartM: [-6200, 2400, 20200], eyeEndM: [-1100, 2600, 18700],
    targetStartM: [-1800, 2900, -4100], targetEndM: [1300, 2850, -4600], fovYDeg: 36 };
  const composition = {
    principal: { slotId: 'B1', pointM: [-3800, 4800, -3900] },
    companion: { slotId: 'H2', pointM: [2800, 4300, -8200] },
  };
  const data = { groundAt, manifest: { kind: 'song-range-stage', boundsM,
    source: { provenance: { composition: { pieces: [{ slotId: 'H1' }, { slotId: 'B2' }, { slotId: 'F2' }] } } },
    landmarks: [{ name: 'West Ridge', localM: [-11000, -9200] },
      { name: 'Eastern Summit', localM: [9100, -7200] }, { name: 'Island', localM: [700, 2100] }] } };
  return { composed: { id: 'composed', camera, songprintComposition: composition }, rail: { id: 'A', camera }, data, composition };
}

function scenario(kind, admittedMs = 0) {
  const { composed, rail, data, composition } = stage();
  const view = kind === 'rail' ? rail : composed;
  const prepared = { data, view, waterLevelM: BASE_M, songprintLandmarks: [composition.principal] };
  const scene = Object.assign(Object.create(RangeScene.prototype), { _movedPoses: new WeakMap() });
  const pulse = compileCinematicPulse({ sections: SECTIONS, read, durationMs: DURATION_MS,
    throughMs: DURATION_MS - FINALE_MS });
  const lensCues = compileLensCues(SECTIONS, DURATION_MS);
  const rise = compileLandRise({ read, durationMs: DURATION_MS, cadenceMs: DURATION_MS, finaleMs: FINALE_MS, paceAt: pulse.paceAt });
  const orbit = kind !== 'rail' ? compileSongprintOrbitScore({ songprint: { passages: [] }, admittedMs,
    cadenceMs: DURATION_MS, finaleMs: FINALE_MS, read, pulse }) : null;
  const plan = compileSceneRailPlan({ sections: SECTIONS, choiceFor: () => ({ view: rail }), durationMs: DURATION_MS,
    curves, response: { smoothingMs: 1200 } });
  const occurrence = plan.occurrences[0];
  const vp = { logicalWidth: 1280, logicalHeight: 720, nominalHeight: 720 };
  const poses = [];
  for (let f = 0; f <= DURATION_MS / 1000 * FPS; f++) {
    const timeMs = f * 1000 / FPS;
    const frame = {
      timeMs, progress01: plan.railStateAt(occurrence.id, timeMs).progress01, rise01: rise.at(timeMs),
      scenicViewport: vp, cameraEffects: revealLensFromCues(lensCues, timeMs),
      cameraMove: rangeCameraMoveAt({ timeMs, sections: SECTIONS, durationMs: DURATION_MS, seed: 7, cadenceMs: DURATION_MS, pulse }),
      performance: orbit ? { songprintOrbit: orbit.at(timeMs) } : {},
    };
    const { pose, proj, tanX } = scene.movedPose(view, frame, prepared);
    poses.push({ timeMs, eyeM: pose.eyeM, targetM: pose.targetM, fovYDeg: proj.fovYDeg, tanX });
  }
  return poses;
}

const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = a => Math.hypot(...a);
const unit = a => { const l = len(a); return a.map(v => v / l); };
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
const pct = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function measure(poses, fromMs = 0) {
  const dt = 1 / FPS, look = [], flow = [], zoom = [], land = [];
  const dirs = poses.map(p => unit(sub(p.targetM, p.eyeM)));
  for (let i = 1; i < poses.length; i++) {
    if (poses[i].timeMs < fromMs) continue;
    const a = poses[i - 1], b = poses[i];
    const distance = len(sub(b.targetM, b.eyeM));
    look.push(angle(dirs[i - 1], dirs[i]) * 180 / Math.PI / dt);
    flow.push(len(sub(b.eyeM, a.eyeM)) / distance / dt);
    zoom.push(Math.abs(Math.log(Math.tan(b.fovYDeg * Math.PI / 360)) - Math.log(Math.tan(a.fovYDeg * Math.PI / 360))) / dt);
    land.push(2 * distance * b.tanX / 1000);
  }
  // Angular acceleration from a 0.2 s smoothed angular speed.
  const k = Math.round(.2 * FPS), smoothed = look.map((_, i) => {
    const w = look.slice(Math.max(0, i - k), i + k + 1); return w.reduce((s, v) => s + v, 0) / w.length;
  });
  const acc = smoothed.slice(1).map((v, i) => Math.abs(v - smoothed[i]) / dt);
  const r = v => Math.round(v * 1000) / 1000;
  return {
    lookPeak: r(Math.max(...look)), lookP99: r(pct(look, .99)), lookAccPeak: r(Math.max(...acc)),
    flowPeak: r(Math.max(...flow)), flowP99: r(pct(flow, .99)), zoomPeak: r(Math.max(...zoom)),
    landKm: r(land.reduce((s, v) => s + v, 0) / land.length), sweeps: r(look.filter(v => v > SWEEP_DEG_S).length / FPS),
  };
}

const report = {};
for (const [kind, admittedMs] of [['composed', 0], ['handoff', 12000], ['rail', 0]]) {
  const poses = scenario(kind, admittedMs);
  report[kind] = { opening: measure(poses.filter(p => p.timeMs <= 8000)), song: measure(poses, 8000) };
  if (admittedMs) report[kind].handoff = measure(poses.filter(p => p.timeMs >= admittedMs - 1000 && p.timeMs <= admittedMs + 9000));
}
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  for (const [kind, parts] of Object.entries(report)) for (const [part, m] of Object.entries(parts)) {
    console.log(`${kind.padEnd(9)} ${part.padEnd(8)} ${Object.entries(m).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
}
