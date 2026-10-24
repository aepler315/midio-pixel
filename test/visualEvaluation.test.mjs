import test from 'node:test';
import assert from 'node:assert/strict';
import * as evaluationBrowser from '../tools/lib/visual-evaluation-browser.mjs';
import { normalizeManifest, captureSchedule, compareReports, imageDifference, differingFrames } from '../tools/lib/visual-evaluation.mjs';
import { renderComparisonReport, renderRunReport } from '../tools/lib/visual-evaluation-report.mjs';

const manifest = (song = {}) => ({ version: 1, songs: [{ id: 'song', fixture: 'contrast', ...song }] });
test('tour evidence pins the tour mode and rejects unknown tours', () => {
  const input = { ...manifest(), settings: { tour: 'tetons', view: 'teton-range-tour' } };
  assert.equal(normalizeManifest(input).settings.tour, 'tetons');
  assert.throws(() => normalizeManifest({ ...input, settings: { tour: 'unknown' } }), /invalid tour/);
});
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
test('identical public bytes remain a repeatability comparison across commit and working tree labels', () => {
  const a = report(), b = report();
  a.source.dirty = '';
  b.source.commit = 'b'.repeat(40);
  b.source.dirty = ' M tools/visual-evaluate.mjs';
  const diff = compareReports(a, b);
  assert.deepEqual(diff.source, { kind: 'repeatability',
    before: { commit: 'a'.repeat(40), digest: 'a'.repeat(64), dirty: '' },
    after: { commit: 'b'.repeat(40), digest: 'a'.repeat(64), dirty: ' M tools/visual-evaluate.mjs' } });
  assert.equal(diff.verdict, 'unreviewed');
  const html = renderComparisonReport(diff, a, b);
  assert.match(html, /Repeatability comparison/);
  assert.match(html, /Public runtime bytes are identical/);
  assert.doesNotMatch(html, /Source changes:/);
  assert.ok(html.includes('b'.repeat(40)) && html.includes('a'.repeat(64)));
});
test('different public bytes distinguish committed candidates, working trees and missing cleanliness', () => {
  const cases = [
    { beforeDirty: '', afterDirty: '', commit: 'b'.repeat(40), kind: 'committed-source' },
    { beforeDirty: false, afterDirty: false, commit: 'b'.repeat(40), kind: 'committed-source' },
    { beforeDirty: '', afterDirty: '', commit: 'a'.repeat(40), kind: 'working-tree' },
    { beforeDirty: ' M src/main.js', afterDirty: '', commit: 'b'.repeat(40), kind: 'working-tree' },
    { beforeDirty: false, afterDirty: true, commit: 'b'.repeat(40), kind: 'working-tree' },
    { beforeDirty: undefined, afterDirty: '', commit: 'b'.repeat(40), kind: 'unverified' },
  ];
  for (const c of cases) {
    const a = report(), b = report();
    a.source.dirty = c.beforeDirty;
    b.source.dirty = c.afterDirty;
    b.source.commit = c.commit;
    b.source.digest = 'c'.repeat(64);
    const diff = compareReports(a, b);
    assert.equal(diff.source.kind, c.kind, JSON.stringify(c));
    assert.equal(diff.source.before.dirty, c.beforeDirty ?? null);
    assert.equal(diff.source.after.dirty, c.afterDirty ?? null);
    assert.equal(diff.source.after.digest, 'c'.repeat(64));
    assert.equal(diff.verdict, 'unreviewed');
    const html = renderComparisonReport(diff, a, b);
    assert.ok(html.includes('c'.repeat(64)), 'comparison publishes both public source digests');
    assert.match(html, /Pixel differences show change, not improvement/);
  }
});
test('comparison rejects malformed working tree provenance while accepting historical absence', () => {
  assert.equal(compareReports(report(), report()).source.before.dirty, null);
  for (const dirty of [0, [], {}]) {
    const b = report(); b.source.dirty = dirty;
    assert.throws(() => compareReports(report(), b), /invalid.*source provenance/);
  }
});
test('run reports retain browser diagnostic severity, phase and fatal disposition', () => {
  const r = report();
  r.songs[0].frames[0].clips = [];
  r.songs[0].events = [{ source: 'console', message: 'GL_INVALID_VALUE <probe>', severity: 'warning', phase: 'playback', fatal: true }];
  const html = renderRunReport(r);
  assert.match(html, /GL_INVALID_VALUE &lt;probe&gt;/);
  assert.match(html, /&quot;severity&quot;: &quot;warning&quot;/);
  assert.match(html, /&quot;phase&quot;: &quot;playback&quot;/);
  assert.match(html, /&quot;fatal&quot;: true/);
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
  assert.deepEqual(m.settings.presentation, { ...presentation, version: 2, pixelGrid: 'classic', ditherMode: 'ordered', pixelScale: 'original' });
  for (const change of [{ look: 'cathode' }, { quality: 'low' }, { scaling: 'stretch' }, { dither: 9 }, { palette: 'missing' }]) {
    assert.throws(() => normalizeManifest({ ...manifest(), settings: { presentation: { ...presentation, ...change } } }));
  }
});
test('visual v2 profiles accept Chroma/world and strictly reject unknown fields', () => {
  const presentation = { version: 2, look: 'palette', quality: 'auto', palette: 'world', dither: .35, ditherMode: 'ordered', pixelGrid: 'classic', scaling: 'fit' };
  assert.deepEqual(normalizeManifest({ ...manifest(), settings: { presentation } }).settings.presentation, { ...presentation, pixelScale: 'original' });
  for (const change of [{ palette: 'chroma32' }, { palette: 'rgb332' }]) assert.equal(normalizeManifest({ ...manifest(), settings: { presentation: { ...presentation, ...change } } }).settings.presentation.palette, change.palette);
  assert.equal(normalizeManifest({ ...manifest(), settings: { presentation: { ...presentation, ditherMode: 'selective' } } }).settings.presentation.ditherMode, 'selective');
  assert.equal(normalizeManifest({ ...manifest(), settings: { presentation: { ...presentation, pixelGrid: 'detailed' } } }).settings.presentation.pixelGrid, 'detailed');
  for (const change of [{ arbitrary: true }, { pixelGrid: 'arbitrary' }, { ditherMode: 'animated' }]) assert.throws(() => normalizeManifest({ ...manifest(), settings: { presentation: { ...presentation, ...change } } }));
});
test('historical visual manifests retain recorded Depth metadata and reject unsupported scale modes', () => {
  const presentation = { version: 2, look: 'pixel', quality: 'auto', palette: 'world', dither: .35, ditherMode: 'selective', pixelGrid: 'classic', pixelScale: 'depth', scaling: 'fit' };
  assert.equal(normalizeManifest({ ...manifest(), settings: { presentation } }, { historical: true }).settings.presentation.pixelScale, 'depth');
  // A new capture cannot request the retired mode the product no longer draws.
  assert.throws(() => normalizeManifest({ ...manifest(), settings: { presentation } }), /retired/);
  assert.throws(() => normalizeManifest({ ...manifest(), settings: { presentation: { ...presentation, pixelScale: 'random' } } }), /pixelScale/);
  assert.throws(() => normalizeManifest({ ...manifest(), settings: { presentation: { ...presentation, pixelScale: 'random' } } }, { historical: true }), /pixelScale/);
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

// --- E2: every quality rung; historical reports ------------------------------
import { normalizeMatrix, manifestForCase } from '../tools/lib/visual-evaluation.mjs';
import fs from 'node:fs';

test('manifests accept every governor rung q0-q6; reject q7 and fractions', () => {
  for (let q = 0; q <= 6; q++) assert.equal(normalizeManifest({ ...manifest(), settings: { quality: q } }).settings.quality, q);
  for (const settings of [{ quality: 7 }, { quality: 2.5 }, { quality: -1 }]) {
    assert.throws(() => normalizeManifest({ ...manifest(), settings }), JSON.stringify(settings));
  }
});

// Reports captured before the flash/motion preferences were removed still
// carry them, in the settings and per frame.
const legacy = () => {
  const r = report();
  Object.assign(r.settings, { reducedFlash: false, reducedMotion: false });
  r.songs[0].frames.forEach(f => { f.accessibility = { reducedFlash: false, reducedMotion: false }; });
  return r;
};

test('historical reports carrying retired preference fields still validate and compare with current reports', () => {
  const diff = compareReports(legacy(), report());
  assert.equal(diff.frames.length, 1);
  assert.equal(diff.frames[0].identical, true);
  assert.equal('accessibility' in diff, false);
  assert.equal(compareReports(report(), legacy()).frames.length, 1);
  assert.equal(compareReports(legacy(), legacy()).frames.length, 1);
  // A capture that had a retired preference on rendered differently.
  const reducedOn = legacy(); reducedOn.settings.reducedFlash = true;
  assert.throws(() => compareReports(reducedOn, report()), /incompatible settings/);
  assert.throws(() => compareReports(report(), reducedOn), /incompatible settings/);
  assert.equal(compareReports(reducedOn, reducedOn).frames.length, 1);
});

test('comparison rejects a differing requested quality', () => {
  const changedQuality = report(); changedQuality.settings.quality = 5;
  assert.throws(() => compareReports(report(), changedQuality), /incompatible settings/);
});

test('the VFX matrix covers every shedding boundary, look and both views', () => {
  const matrix = JSON.parse(fs.readFileSync(new URL('./fixtures/visual-evaluation-vfx.json', import.meta.url), 'utf8'));
  const cases = normalizeMatrix(matrix).cases.map(c => c.manifest.settings);
  assert.deepEqual([...new Set(cases.map(s => s.quality))].sort(), [0, 2, 3, 4, 5, 6]);
  assert.deepEqual([...new Set(cases.map(s => s.presentation?.look ?? 'pixel'))].sort(), ['palette', 'pixel']);
  assert.deepEqual([...new Set(cases.map(s => s.view))].sort(), ['panamint-dantes-view', 'teton-jackson-lake']);
  assert.ok(cases.some(s => s.mode === 'continuous'), 'a continuous history case');
  assert.ok(cases.length < 6 * 3 * 2, 'bounded, not a Cartesian product');
  assert.equal(manifestForCase(matrix, 'q5-depth-lake').settings.quality, 5);
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
