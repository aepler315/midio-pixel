#!/usr/bin/env node
// Replay a captured initial tour-worker request without browser rendering.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const key = hero => `${hero.pointId}:${hero.timeMs}`;
const argumentsByName = new Map();
for (let at = 2; at < process.argv.length; at += 2) {
  const name = process.argv[at], value = process.argv[at + 1];
  assert.ok(['--request', '--baseline', '--source', '--out'].includes(name) && value, `Unknown or incomplete argument: ${name}`);
  assert.ok(!argumentsByName.has(name), `Repeated argument: ${name}`);
  argumentsByName.set(name, value);
}
assert.ok(argumentsByName.has('--request'),
  'Usage: node tools/tour-coverage-check.mjs --request capture.json [--baseline report.json] [--source DIR] [--out report.json]');
const source = path.resolve(argumentsByName.get('--source') || root);
const sourceUrl = relative => pathToFileURL(path.join(source, relative));
const manifestPath = 'src/assets/range/v2/tour/teton-range-tour.tour.json';
const payloadPath = 'src/assets/range/v2/tour/teton-range-tour.tour.bin.gz';
async function hashSourceGraph() {
  const terrain = path.join(source, 'src/world/terrain');
  const pending = (await fs.readdir(terrain)).filter(name => /\.[cm]?js$/.test(name))
    .map(name => path.join(terrain, name));
  pending.push(path.join(source, manifestPath), path.join(source, payloadPath));
  const hashes = {};
  while (pending.length) {
    const filename = pending.pop(), relative = path.relative(source, filename).split(path.sep).join('/');
    if (Object.hasOwn(hashes, relative)) continue;
    assert.ok(!relative.startsWith('../'), `Source import escapes checkout: ${relative}`);
    const bytes = await fs.readFile(filename);
    hashes[relative] = sha256(bytes);
    if (/\.[cm]?js$/.test(filename)) {
      const imports = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
      for (const match of bytes.toString('utf8').matchAll(imports)) {
        const specifier = match[1] || match[2] || match[3];
        if (specifier.startsWith('.')) pending.push(path.resolve(path.dirname(filename), specifier));
      }
    }
  }
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}
const hashes = await hashSourceGraph();
// Older baselines predate the shared budget helper. Validate their output
// against the candidate's documented rate rules and record that helper too.
const motionUrl = Object.hasOwn(hashes, 'src/world/terrain/TourMotion.js')
  ? sourceUrl('src/world/terrain/TourMotion.js') : new URL('../src/world/terrain/TourMotion.js', import.meta.url);
const motionSha256 = sha256(await fs.readFile(motionUrl));
const harnessSha256 = sha256(await fs.readFile(new URL(import.meta.url)));
const [{ decodeTour, tourClearanceAt }, { planTour }, { buildTourTimeline, measureHeroFraming }] = await Promise.all([
  import(sourceUrl('src/world/terrain/TourPackage.js')),
  import(sourceUrl('src/world/terrain/TourPlanner.js')),
  import(sourceUrl('src/world/terrain/TourTimeline.js')),
]);
const { tourYawBudget } = await import(motionUrl);
const requestPath = path.resolve(argumentsByName.get('--request'));
const requestBytes = await fs.readFile(requestPath), capture = JSON.parse(requestBytes);
const input = capture.tourInputs?.[0]?.data || capture.request || capture;
assert.ok(Array.isArray(input.sections) && Array.isArray(input.energy), 'Initial request must include sections and sampled energy');
assert.ok(input.durationMs > 0 && input.energy.length > 0, 'Coverage replay requires a positive song duration and nonempty sampled energy');
assert.ok(!input.previous && !input.previousPresent,
  'Replay accepts initial requests; refinement needs its original committed typed arrays');
const [manifestBytes, payload] = await Promise.all([
  fs.readFile(sourceUrl(manifestPath)), fs.readFile(sourceUrl(payloadPath)),
]);
const data = decodeTour(JSON.parse(manifestBytes), gunzipSync(payload));
if (input.data?.id) assert.equal(data.id, input.data.id, 'Captured tour package identity');
if (input.data?.payload?.sha256) assert.equal(data.payload.sha256, input.data.payload.sha256, 'Captured tour payload identity');
const energyAt = time => input.energy[Math.min(input.energy.length - 1, Math.max(0, Math.round(time / 250)))];
const plan = planTour(data, { sections: input.sections, roles: input.roles, durationMs: input.durationMs,
  energyAt, reducedMotion: input.reducedMotion });
const tour = buildTourTimeline(data, plan, { reducedMotion: input.reducedMotion });
const origin = tour.routeTimeOriginMs || 0, tau = tour.routeSlowTauSec || 0, scale = tour.scale || 1;
const frames = Array.from({ length: Math.ceil(tour.durationMs / 100) + 1 }, (_, at) => {
  const timeMs = Math.min(tour.durationMs, at * 100), elapsed = Math.max(0, (timeMs - origin) / 1000);
  const clock = origin + 1000 * (elapsed / scale + (tau ? (1 - 1 / scale) * tau * (1 - Math.exp(-elapsed / tau)) : 0));
  return { ...plan.routeAt(clock), timeMs };
});
const yawBudget = tourYawBudget(frames, { reducedMotion: tour.reducedMotion });
const heroes = tour.heroFraming.map((framing, at) => ({ ...tour.heroes[at], ...framing }));
const endings = heroes.filter(hero => hero.finalChorus || hero.role === 'outro');
const preserved = [];
let baseline = null;
if (argumentsByName.has('--baseline')) {
  const baselinePath = path.resolve(argumentsByName.get('--baseline'));
  const bytes = await fs.readFile(baselinePath), report = JSON.parse(bytes);
  const previous = report.songs?.[0]?.frames?.[0]?.range?.tour || report.results?.[0] || report;
  assert.ok(Array.isArray(previous.heroFraming), 'Baseline must retain heroFraming');
  baseline = { path: baselinePath, sha256: sha256(bytes), durationMs: previous.durationMs };
  assert.equal(tour.durationMs, previous.durationMs, 'Baseline and candidate song duration');
  for (const before of previous.heroFraming.filter(hero => hero.framedFraction >= .8)) {
    const hero = tour.heroes.find(candidate => key(candidate) === key(before));
    const after = hero && measureHeroFraming({ ...tour, heroes: [{ ...hero, framingPointId: before.framedPointId }] }, data)[0];
    preserved.push({ pointId: before.pointId, timeMs: before.timeMs,
      framedPointId: before.framedPointId, baselineFramedFraction: before.framedFraction,
      candidateFramedFraction: after?.framedFraction ?? 0, pass: (after?.framedFraction ?? 0) >= .8 });
  }
}
let previous = null, maxYawDegPerSecond = 0, maxClimbMPerSecond = 0;
let minFloorMarginM = Infinity, minCeilingMarginM = Infinity;
let maxYawBudgetExcessDeg = 0, maxStoppedPitchChangeDeg = 0, maxStoppedFovChangeDeg = 0;
const times = [];
for (let time = 0; time < tour.durationMs; time += 25) times.push(time);
times.push(tour.durationMs);
for (const time of times) {
  const pose = tour.poseAt(time);
  assert.ok([...pose.eyeM, ...pose.targetM, pose.fovYDeg].every(Number.isFinite), `Finite pose at ${time}`);
  const band = tourClearanceAt(data.clearance, pose.eyeM[0], pose.eyeM[2]);
  minFloorMarginM = Math.min(minFloorMarginM, pose.eyeM[1] - band.floorY);
  minCeilingMarginM = Math.min(minCeilingMarginM, band.ceilY - pose.eyeM[1]);
  const heading = Math.atan2(pose.targetM[0] - pose.eyeM[0], -(pose.targetM[2] - pose.eyeM[2])) * 180 / Math.PI;
  const pitch = Math.atan2(pose.targetM[1] - pose.eyeM[1],
    Math.hypot(pose.targetM[0] - pose.eyeM[0], pose.targetM[2] - pose.eyeM[2])) * 180 / Math.PI;
  if (previous) {
    const seconds = (time - previous.time) / 1000;
    const turn = Math.abs(((heading - previous.heading + 540) % 360) - 180);
    const capacity = yawBudget(previous.time, time);
    maxYawDegPerSecond = Math.max(maxYawDegPerSecond, turn / seconds);
    maxYawBudgetExcessDeg = Math.max(maxYawBudgetExcessDeg, turn - capacity);
    if (capacity === 0) {
      maxStoppedPitchChangeDeg = Math.max(maxStoppedPitchChangeDeg, Math.abs(pitch - previous.pitch));
      maxStoppedFovChangeDeg = Math.max(maxStoppedFovChangeDeg, Math.abs(pose.fovYDeg - previous.pose.fovYDeg));
    }
    maxClimbMPerSecond = Math.max(maxClimbMPerSecond, Math.abs(pose.eyeM[1] - previous.pose.eyeM[1]) / seconds);
  }
  previous = { time, heading, pitch, pose };
}
assert.deepEqual(await hashSourceGraph(), hashes, 'Source graph changed during replay; rerun after the source is stable');
assert.equal(sha256(await fs.readFile(motionUrl)), motionSha256, 'Yaw validator changed during replay');
assert.equal(sha256(await fs.readFile(new URL(import.meta.url))), harnessSha256, 'Replay harness changed during replay');
const gates = {
  finite: true,
  sampledYaw: maxYawBudgetExcessDeg <= .002,
  sampledHeldPitch: maxStoppedPitchChangeDeg <= .002,
  sampledHeldFov: maxStoppedFovChangeDeg <= .002,
  sampledClimb: maxClimbMPerSecond <= (tour.reducedMotion ? 15 : 30) + .05,
  sampledClearance: minFloorMarginM >= -.05 && minCeilingMarginM >= -.05,
  ...(baseline ? { acceptedBaselineSubjects: preserved.every(hero => hero.pass) } : {}),
};
const report = {
  version: 1, node: process.version, source, hashes, sourceUnchangedAfterReplay: true,
  hashScope: 'All terrain JavaScript modules and their literal relative imports, tour manifest and payload; separate yaw-validator and replay-harness hashes.',
  yawValidator: { path: fileURLToPath(motionUrl), sha256: motionSha256 }, harnessSha256,
  request: { path: requestPath, sha256: sha256(requestBytes) }, baseline,
  durationMs: tour.durationMs, reducedMotion: tour.reducedMotion, scale: tour.scale,
  meanQualityRatio: tour.meanQualityRatio, heroCoverage: tour.heroCoverage ?? null,
  heroFraming: heroes, endingFraming: endings, preserved,
  sampling: { intervalMs: 25, exactEndpoint: tour.durationMs, maxYawDegPerSecond,
    maxYawBudgetExcessDeg, maxStoppedPitchChangeDeg, maxStoppedFovChangeDeg,
    maxClimbMPerSecond, minFloorMarginM, minCeilingMarginM },
  notes: tour.notes, gates,
  limits: 'CPU projection and sampled route safety only. No terrain occlusion, subject pixel footprint, user/cinematic camera transforms, rendered footage, live performance, physical-device measurement, or artistic acceptance. No universal coverage percentage is imposed; missed ending subjects remain explicit.',
};
const output = path.resolve(argumentsByName.get('--out') || path.join(root, '.smoke/tour-coverage/report.json'));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, durationMs: tour.durationMs, heroCount: heroes.length,
  framed: heroes.filter(hero => hero.framedFraction >= .8).length,
  endingMisses: endings.filter(hero => hero.framedFraction < .8).map(hero => ({ pointId: hero.pointId, timeMs: hero.timeMs })), gates }, null, 2));
if (Object.values(gates).some(pass => !pass)) process.exitCode = 1;
