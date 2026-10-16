import test from 'node:test';
import assert from 'node:assert/strict';
import * as evaluationBrowser from '../tools/lib/visual-evaluation-browser.mjs';
import { normalizeManifest, captureSchedule, compareReports, imageDifference, differingFrames } from '../tools/lib/visual-evaluation.mjs';

const manifest = (song = {}) => ({ version: 1, songs: [{ id: 'song', fixture: 'contrast', ...song }] });
test('rejects empty, duplicate, unsafe and ambiguous song inputs', () => {
  for (const input of [{ version: 1, songs: [] }, { version: 1, songs: [{ id: '../x', fixture: 'silence' }] },
    { version: 1, songs: [{ id: 'a', fixture: 'silence' }, { id: 'a', fixture: 'kicks' }] },
    manifest({ file: 'song.wav' }), manifest({ timesMs: [] }), manifest({ clips: [{ startMs: -1, durationMs: 1000 }] })]) {
    assert.throws(() => normalizeManifest(input));
  }
  assert.throws(() => normalizeManifest({ ...manifest(), settings: { fps: 0 } }));
  assert.throws(() => normalizeManifest({ ...manifest(), settings: { width: 641 } }));
  assert.throws(() => normalizeManifest({ ...manifest(), settings: { unknown: true } }));
});
test('sorts and de-duplicates checkpoints while capturing every clip frame with preroll', () => {
  const m = normalizeManifest({ ...manifest({ timesMs: [2000, 0, 2000], clips: [{ startMs: 2000, durationMs: 1000 }] }), settings: { fps: 4 } });
  const schedule = captureSchedule(m.songs[0], 4000, m.settings);
  assert.deepEqual(schedule.filter(f => f.checkpoint).map(f => f.timeMs), [0, 2000]);
  assert.deepEqual(schedule.filter(f => f.clips.length).map(f => f.timeMs), [2000, 2250, 2500, 2750]);
  assert.ok(schedule.some(f => f.timeMs === 1000 && !f.save));
  assert.throws(() => captureSchedule({ ...m.songs[0], timesMs: [5000] }, 4000, m.settings), /duration/);
  assert.throws(() => captureSchedule({ ...m.songs[0], clips: [{ startMs: 3500, durationMs: 1000 }] }, 4000, m.settings), /duration/);
});
test('continuous mode draws from zero instead of silently skipping earlier frames', () => {
  const m = normalizeManifest({ ...manifest({ timesMs: [1000], clips: [] }), settings: { mode: 'continuous', fps: 4 } });
  const frames = captureSchedule(m.songs[0], 4000, m.settings);
  assert.deepEqual(frames.map(f => f.timeMs), [0, 250, 500, 750, 1000]);
  assert.equal(frames.filter(f => f.save).length, 1);
});
const report = () => ({ version: 1, status: 'passed', browser: 'chromium-1',
  source: { commit: 'a'.repeat(40), digest: 'a'.repeat(64), hashes: { 'index.html': 'a'.repeat(64), 'src/main.js': 'b'.repeat(64) }, changedDuringRun: false }, environment: { gl: 'software', vendor: 'test', deviceMemory: 8, dpr: 1 },
  settings: { width: 640, height: 360, seed: 315, quality: 0, view: 'teton-jackson-lake', biome: 'CONIFER', fps: 12, mode: 'sparse', intervalMs: 10000 }, songs: [{ id: 'a', audioSha256: 'a'.repeat(64), durationMs: 4000,
    schedule: [{ timeMs: 1000, save: true }], frames: [{ timeMs: 1000, actualTimeMs: 1000, png: 'x.png', sha256: 'b'.repeat(64), thumbnail: [0, 0, 0, 255] }] }] });
test('visual capture validates construction and song seeds independently', () => {
  assert.equal(typeof evaluationBrowser.validateEvaluationSeeds, 'function');
  assert.doesNotThrow(() => evaluationBrowser.validateEvaluationSeeds({ constructionSeed: 315, seed: 1300355259 }, { seed: 315 }));
  assert.throws(() => evaluationBrowser.validateEvaluationSeeds({ constructionSeed: 9, seed: 1300355259 }, { seed: 315 }));
  for (const seed of [undefined, NaN, -1, 0x100000000]) {
    assert.throws(() => evaluationBrowser.validateEvaluationSeeds({ constructionSeed: 315, seed }, { seed: 315 }));
  }
});
test('visual comparison rejects differing actual song seeds', () => {
  const a = report(), b = report();
  a.songs[0].frames[0].seed = 1300355259;
  b.songs[0].frames[0].seed = 315;
  assert.throws(() => compareReports(a, b), /incompatible.*song seed/i);
});
test('comparison rejects missing evidence and mismatched inputs, settings and browser', () => {
  for (const change of [r => { r.status = 'failed'; }, r => { r.browser = 'other'; },
    r => { r.settings.seed = 9; }, r => { r.songs[0].audioSha256 = 'c'.repeat(64); },
    r => { r.songs[0].frames = []; }, r => { r.songs = []; },
    r => { r.songs[0].schedule[0].timeMs = 2; }]) {
    const after = report(); change(after);
    assert.throws(() => compareReports(report(), after), /incompatible|missing|invalid/i);
  }
});
test('comparison reports changed pixels without assigning a quality verdict', () => {
  const a = report(), b = report();
  b.songs[0].frames[0].sha256 = 'c'.repeat(64); b.songs[0].frames[0].thumbnail = [255, 0, 0, 255];
  const diff = compareReports(a, b);
  assert.equal(diff.frames[0].identical, false);
  assert.equal(diff.frames[0].difference.changedFraction, 1);
  assert.equal(diff.verdict, 'unreviewed');
  assert.deepEqual(imageDifference([0, 0, 0, 255], [0, 0, 0, 255]), { changedFraction: 0, meanAbsoluteError: 0 });
});
test('a repeat run names every frame that differs from its identical-input baseline', () => {
  assert.deepEqual(differingFrames(compareReports(report(), report())), []);
  const b = report(); b.songs[0].frames[0].sha256 = 'c'.repeat(64);
  assert.deepEqual(differingFrames(compareReports(report(), b)), ['a@1000']);
});
test('comparison refuses frames drawn at different actual musical times', () => {
  const a = report(), b = report();
  a.songs[0].frames[0].actualTimeMs = 1000;
  b.songs[0].frames[0].actualTimeMs = 1008;
  assert.throws(() => compareReports(a, b), /incompatible.*time/i);
});
test('paired missing provenance cannot masquerade as compatible evidence', () => {
  const deletions = [r => { delete r.browser; }, r => { delete r.environment; }, r => { delete r.settings; },
    r => { delete r.songs[0].durationMs; }, r => { delete r.songs[0].audioSha256; },
    r => { delete r.songs[0].frames[0].actualTimeMs; }, r => { delete r.settings.seed; }, r => { delete r.source; }, r => { r.source.changedDuringRun = true; }];
  for (const remove of deletions) { const a = report(), b = report(); remove(a); remove(b); assert.throws(() => compareReports(a, b), /missing|invalid/i); }
});

test('visual manifests accept independent presentation profiles and reject invalid values', () => {
  const presentation = { version: 1, look: 'palette', quality: 'auto', palette: 'range32', dither: .35, scaling: 'integer' };
  const m = normalizeManifest({ ...manifest(), settings: { presentation } });
  assert.deepEqual(m.settings.presentation, { ...presentation, version: 2, pixelGrid: 'classic', ditherMode: 'ordered' });
  for (const change of [{ look: 'cathode' }, { quality: 'low' }, { scaling: 'stretch' }, { dither: 9 }, { palette: 'missing' }]) {
    assert.throws(() => normalizeManifest({ ...manifest(), settings: { presentation: { ...presentation, ...change } } }));
  }
});
test('visual v2 profiles accept Chroma/world and strictly reject unknown fields', () => {
  const presentation = { version: 2, look: 'palette', quality: 'auto', palette: 'world', dither: .35, ditherMode: 'ordered', pixelGrid: 'classic', scaling: 'fit' };
  assert.deepEqual(normalizeManifest({ ...manifest(), settings: { presentation } }).settings.presentation, presentation);
  for (const change of [{ palette: 'chroma32' }, { palette: 'rgb332' }]) assert.equal(normalizeManifest({ ...manifest(), settings: { presentation: { ...presentation, ...change } } }).settings.presentation.palette, change.palette);
  assert.equal(normalizeManifest({ ...manifest(), settings: { presentation: { ...presentation, ditherMode: 'selective' } } }).settings.presentation.ditherMode, 'selective');
  assert.equal(normalizeManifest({ ...manifest(), settings: { presentation: { ...presentation, pixelGrid: 'detailed' } } }).settings.presentation.pixelGrid, 'detailed');
  for (const change of [{ arbitrary: true }, { pixelGrid: 'arbitrary' }, { ditherMode: 'animated' }]) assert.throws(() => normalizeManifest({ ...manifest(), settings: { presentation: { ...presentation, ...change } } }));
});
test('comparison normalizes valid v1 presentation choices without weakening value validation', () => {
  const a = report(), b = report();
  const p = { version: 1, look: 'palette', quality: 'auto', palette: 'range32', dither: .35, scaling: 'fit' };
  a.settings.presentation = p;
  b.settings.presentation = { ...p, version: 2, pixelGrid: 'classic', ditherMode: 'ordered' };
  assert.equal(compareReports(a, b).frames.length, 1);
  b.settings.presentation.palette = 'chroma32';
  assert.throws(() => compareReports(a, b), /incompatible.*settings/);
  a.settings.presentation.palette = 'chroma32';
  assert.throws(() => compareReports(a, b), /invalid palette/);
});

test('a bounded continuous capture draws every frame from its explicit start and rejects earlier checkpoints', () => {
  const m=normalizeManifest({ ...manifest({timesMs:[1500,2000],clips:[{startMs:1500,durationMs:250}]}),settings:{mode:'continuous',fps:4,startMs:1500} });
  assert.deepEqual(captureSchedule(m.songs[0],4000,m.settings).map(p=>p.timeMs),[1500,1750,2000]);
  assert.throws(()=>captureSchedule({...m.songs[0],timesMs:[1000]},4000,m.settings),/start/);
});

test('diagnostic renders are pinned settings with validated developer switches', () => {
  const debug = { rangeDebug: 'roughness', forestDebug: 1, rangeMsaa: 0 };
  const m = normalizeManifest({ ...manifest(), settings: { debug } });
  assert.deepEqual(m.settings.debug, debug);
  for (const bad of [{ rangeDebug: 'nope' }, { forestDebug: 2 }, { rangeMsaa: 3 }, { other: 1 }]) {
    assert.throws(() => normalizeManifest({ ...manifest(), settings: { debug: bad } }));
  }
  assert.equal(normalizeManifest(manifest()).settings.debug, undefined, 'ordinary captures render normally');
});

// --- E2: every quality rung and accessibility preference, with provenance --
import { normalizeMatrix, manifestForCase, accessibilityProvenance } from '../tools/lib/visual-evaluation.mjs';
import fs from 'node:fs';

test('manifests accept every governor rung q0-q6 and boolean preferences; reject q7, fractions and non-booleans', () => {
  for (let q = 0; q <= 6; q++) assert.equal(normalizeManifest({ ...manifest(), settings: { quality: q } }).settings.quality, q);
  const m = normalizeManifest(manifest());
  assert.deepEqual([m.settings.reducedFlash, m.settings.reducedMotion], [false, false], 'explicit defaults');
  assert.equal(normalizeManifest({ ...manifest(), settings: { reducedFlash: true, reducedMotion: true } }).settings.reducedMotion, true);
  for (const settings of [{ quality: 7 }, { quality: 2.5 }, { quality: -1 }, { reducedFlash: 1 }, { reducedMotion: 'true' }, { reducedFlash: null }]) {
    assert.throws(() => normalizeManifest({ ...manifest(), settings }), JSON.stringify(settings));
  }
});

const withAccessibility = (r, a = { reducedFlash: false, reducedMotion: false }) => { r.songs[0].frames.forEach(f => { f.accessibility = { ...a }; }); return r; };
const historical = () => { const r = report(); delete r.settings.reducedFlash; delete r.settings.reducedMotion; return r; };

test('historical reports without preference fields still validate and compare with each other', () => {
  const diff = compareReports(historical(), historical());
  assert.deepEqual(diff.accessibility, { provenance: 'unknown', freshBaselineRequired: false });
  assert.equal(accessibilityProvenance(historical()), 'unknown');
});

test('a historical baseline against a verified candidate cannot claim matched accessibility provenance', () => {
  const diff = compareReports(historical(), withAccessibility(report()));
  assert.deepEqual(diff.accessibility, { provenance: 'unmatched', freshBaselineRequired: true });
  const verified = compareReports(withAccessibility(report()), withAccessibility(report()));
  assert.deepEqual(verified.accessibility, { provenance: 'verified', freshBaselineRequired: false });
});

test('comparison rejects differing requested or verified effective preferences', () => {
  const flash = withAccessibility(report(), { reducedFlash: true, reducedMotion: false });
  flash.settings.reducedFlash = true;
  assert.throws(() => compareReports(withAccessibility(report()), flash), /incompatible settings/);
  const drift = withAccessibility(report()); drift.songs[0].frames[0].accessibility.reducedMotion = true;
  assert.throws(() => compareReports(withAccessibility(report()), drift), /differs from the requested/);
  const partial = withAccessibility(report()); partial.songs[0].frames.push({ ...partial.songs[0].frames[0], accessibility: undefined });
  assert.throws(() => accessibilityProvenance(partial), /provenance/);
  const changedQuality = report(); changedQuality.settings.quality = 5;
  assert.throws(() => compareReports(report(), changedQuality), /incompatible settings/);
});

test('the VFX matrix covers every shedding boundary, preference combination, look and both views', () => {
  const matrix = JSON.parse(fs.readFileSync(new URL('./fixtures/visual-evaluation-vfx.json', import.meta.url), 'utf8'));
  const cases = normalizeMatrix(matrix).cases.map(c => c.manifest.settings);
  assert.deepEqual([...new Set(cases.map(s => s.quality))].sort(), [0, 2, 3, 4, 5, 6]);
  assert.deepEqual(new Set(cases.map(s => `${s.reducedFlash}/${s.reducedMotion}`)).size, 4);
  assert.deepEqual([...new Set(cases.map(s => s.presentation?.look ?? 'natural'))].sort(), ['natural', 'palette', 'pixel']);
  assert.deepEqual([...new Set(cases.map(s => s.view))].sort(), ['panamint-dantes-view', 'teton-jackson-lake']);
  assert.ok(cases.some(s => s.mode === 'continuous'), 'a continuous history case');
  assert.ok(cases.length < 6 * 4 * 3 * 2, 'bounded, not a Cartesian product');
  assert.equal(manifestForCase(matrix, 'q5-natural-lake-both').settings.quality, 5);
  assert.throws(() => manifestForCase(matrix, 'missing'), /unknown case/);
  assert.throws(() => normalizeMatrix({ ...matrix, cases: [...matrix.cases, matrix.cases[0]] }), /duplicate/);
  assert.throws(() => normalizeMatrix({ ...matrix, cases: [{ id: 'bad', settings: { quality: 7 } }] }));
});

test('a uniform thumbnail is a blank frame; any real picture is not', async () => {
  const { blankFrame } = await import('../tools/lib/visual-evaluation.mjs');
  assert.equal(blankFrame([0, 0, 0, 255, 1, 1, 1, 255]), true);
  assert.equal(blankFrame([]), true);
  assert.equal(blankFrame([0, 0, 0, 255, 40, 60, 90, 255]), false);
});
