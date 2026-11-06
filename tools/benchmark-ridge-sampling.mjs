#!/usr/bin/env node
// CPU-only source/history lookup benchmark. It measures neither GPU work nor
// presented frames. Run each source checkout separately with identical options:
// node tools/benchmark-ridge-sampling.mjs --module-root ../midio-pixel --hold
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { moduleRoot: ownRoot, rounds: 3, queries: 120, sourceQueries: 1000, hold: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const key = argv[i];
  if (key === '--help') {
    console.log('Usage: node tools/benchmark-ridge-sampling.mjs [--module-root DIR] [--rounds 1..10] [--queries 10..1000] [--source-queries 10..10000] [--hold]\nFixed 300-second/6000-note fixture; --hold adds a second fixture with one sustained 300-second note. JSON output; CPU-only, no timing acceptance gate.');
    process.exit(0);
  }
  if (key === '--hold') { options.hold = true; continue; }
  const field = { '--module-root': 'moduleRoot', '--rounds': 'rounds', '--queries': 'queries', '--source-queries': 'sourceQueries' }[key];
  if (!field || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(`Unknown or incomplete argument: ${key}`);
  options[field] = field === 'moduleRoot' ? path.resolve(argv[++i]) : Number(argv[++i]);
}
for (const [name, min, max] of [['rounds', 1, 10], ['queries', 10, 1000], ['sourceQueries', 10, 10000]]) {
  if (!Number.isInteger(options[name]) || options[name] < min || options[name] > max) throw Error(`${name} must be an integer from ${min} through ${max}`);
}

const imports = await Promise.all([
  import(pathToFileURL(path.join(options.moduleRoot, 'src/world/RidgeMotionHistory.js'))),
  import(pathToFileURL(path.join(options.moduleRoot, 'src/world/alpine/RangeNarrative.js'))),
]);
const { RidgeMotionHistory } = imports[0];
const { compileLandscapeSources, compileRangeNarrative } = imports[1];
const durationMs = 300000;
const notes = Array.from({ length: 6000 }, (_, i) => ({ tMs: i * 50, durMs: 120,
  vel: .7, src: 'midi', role: 'MELODY', pitch: 60 + i % 12 }));
const fixtures = [{ id: 'short-notes', timeline: notes }];
if (options.hold) fixtures.push({ id: 'short-notes-plus-long-hold', timeline: [
  { tMs: 0, durMs: durationMs, vel: .2, src: 'midi', role: 'MELODY', pitch: 48 }, ...notes,
] });
const digest = value => createHash('sha256').update(value).digest('hex');
const round = n => Number(n.toFixed(6));
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = q => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
  return { samples: values.length, medianMs: percentile(.5), p95Ms: percentile(.95),
    maxMs: round(sorted.at(-1)), totalMs: round(values.reduce((sum, n) => sum + n, 0)) };
}

function measure(make, fixture, { queries, warmup, warmAt, queryAt, select = sample => sample }) {
  const construction = [], samples = [], rounds = [];
  const checksum = createHash('sha256');
  for (let r = 0; r < options.rounds; r++) {
    const start = performance.now();
    const owner = make({ durationMs, timeline: fixture.timeline });
    const constructMs = performance.now() - start;
    construction.push(constructMs);
    for (let i = 0; i < warmup; i++) owner.sample(warmAt(i));
    const timings = [];
    for (let i = 0; i < queries; i++) {
      const before = performance.now();
      const sample = owner.sample(queryAt(i));
      const elapsed = performance.now() - before;
      timings.push(elapsed); samples.push(elapsed);
      // Serialization and hashing are outside the timed call. Every measured
      // result contributes, so comparison catches changed output as well as cost.
      checksum.update(JSON.stringify(select(sample))); checksum.update('\n');
    }
    rounds.push({ round: r + 1, constructMs: round(constructMs), query: summarize(timings) });
  }
  return { construction: summarize(construction), query: summarize(samples),
    checksumSha256: checksum.digest('hex'), rounds };
}

const sourceFiles = {};
for (const file of ['src/world/RidgeMotionHistory.js', 'src/world/alpine/RangeNarrative.js', 'src/world/ActiveIntervalIndex.js']) {
  try { sourceFiles[file] = digest(await fs.readFile(path.join(options.moduleRoot, file))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
let git = null;
try {
  const command = args => execFileSync('git', ['-C', options.moduleRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git = { commit: command(['rev-parse', 'HEAD']), trackedChanges: command(['status', '--porcelain', '--untracked-files=no']) };
} catch { /* A source directory without Git can still be identified by hashes. */ }

const results = [];
for (const fixture of fixtures) {
  const sourceSchedule = { queries: options.sourceQueries, warmup: 100,
    warmAt: i => 250000 + i, queryAt: i => 250000 + i * .123, select: sample => sample.sources };
  results.push({ fixture: fixture.id, noteCount: fixture.timeline.length,
    timelineSha256: digest(JSON.stringify(fixture.timeline)),
    history: measure(input => new RidgeMotionHistory(input), fixture, { queries: options.queries, warmup: 10,
      warmAt: i => 249800 + i * 16.67, queryAt: i => 250000 + i * 16.67 }),
    landscapeSources: measure(compileLandscapeSources, fixture, sourceSchedule),
    narrativeSources: measure(compileRangeNarrative, fixture, sourceSchedule),
  });
}
console.log(JSON.stringify({ schema: 'midio.ridge-sampling-benchmark', version: 1,
  scope: 'CPU-only constructor and sample-call duration; excludes rendering, GPU work, presentation and device playback. No timing acceptance gate.',
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  moduleRoot: options.moduleRoot, git, sourceFiles,
  settings: { durationMs, shortNoteCount: notes.length, spacingMs: 50, shortDurationMs: 120,
    velocity: .7, rounds: options.rounds, historyQueriesPerRound: options.queries,
    sourceQueriesPerRound: options.sourceQueries, historyWarmupQueries: 10, sourceWarmupQueries: 100,
    historyWarmupStartMs: 249800, historyQueryStartMs: 250000, historyQueryStepMs: 16.67,
    sourceQueryStartMs: 250000, sourceQueryStepMs: .123, includeLongHold: options.hold }, results }, null, 2));
