// Evidence contracts. Pixel change is a diagnostic, never a quality score.
import assert from 'node:assert/strict';
import { REAL_BIOMES } from './landscape-fixtures.mjs';
import { resolveDisplayPrefs } from '../../src/render/DisplayProfile.js';

/** ?rangeDebug values (RangeScene TERRAIN_DEBUG_MODES). */
export const DEBUG_VIEWS = Object.freeze(['masks', 'slope', 'albedo', 'fill', 'key', 'roughness', 'specular', 'sun']);
export const DEFAULT_SETTINGS = Object.freeze({ width: 640, height: 360, seed: 315, quality: 0,
  view: 'teton-jackson-lake', biome: 'CONIFER', fps: 12, mode: 'sparse', intervalMs: 10000,
  reducedFlash: false, reducedMotion: false });
/** Accessibility preferences a capture requests (and verifies per frame). */
export const ACCESSIBILITY_KEYS = Object.freeze(['reducedFlash', 'reducedMotion']);
/** Reports written before the preferences existed requested the defaults. */
const HISTORICAL_DEFAULTS = Object.freeze({ reducedFlash: false, reducedMotion: false });
export function normalizeHistoricalSettings(settings) {
  return settings && typeof settings === 'object' ? { ...HISTORICAL_DEFAULTS, ...settings } : settings;
}
const integer = (n, min, max, label) => assert.ok(Number.isInteger(n) && n >= min && n <= max, `invalid ${label}`);
const keys = (obj, allowed, label) => {
  assert.ok(obj && typeof obj === 'object' && !Array.isArray(obj), `invalid ${label}`);
  for (const k of Object.keys(obj)) assert.ok(allowed.includes(k), `unknown ${label}.${k}`);
};

export function normalizeManifest(value) {
  keys(value, ['version', 'settings', 'songs'], 'manifest');
  assert.equal(value.version, 1, 'manifest version must be 1');
  keys(value.settings || {}, [...Object.keys(DEFAULT_SETTINGS), 'presentation', 'startMs', 'debug'], 'settings');
  const settings = { ...DEFAULT_SETTINGS, ...value.settings };
  if (settings.presentation != null) {
    const p = settings.presentation;
    const old = p.version === 1;
    keys(p, ['version', 'look', 'quality', 'palette', 'dither', 'scaling', ...(old ? [] : ['ditherMode', 'pixelGrid', 'pixelScale'])], 'presentation');
    assert.ok([1, 2].includes(p.version), 'invalid presentation version');
    assert.ok(['pixel', 'palette'].includes(p.look), 'invalid pixel-only look');
    assert.ok(['auto', 'economy'].includes(p.quality), 'invalid quality');
    assert.ok((old ? ['range32', 'rgb332'] : ['world', 'range32', 'chroma32', 'rgb332']).includes(p.palette), 'invalid palette');
    assert.ok([0, .35, 1].includes(p.dither), 'invalid dither');
    assert.ok(['fit', 'integer'].includes(p.scaling), 'invalid scaling');
    if (!old) {
      assert.ok(['ordered', 'selective'].includes(p.ditherMode), 'invalid ditherMode');
      assert.ok(['classic', 'detailed'].includes(p.pixelGrid), 'invalid pixelGrid');
      if (p.pixelScale != null) assert.ok(['original', 'depth'].includes(p.pixelScale), 'invalid pixelScale');
    }
    settings.presentation = resolveDisplayPrefs({ saved: p });
  }
  if (settings.debug != null) {
    // Diagnostic renders (Natural-rendering Task 0): existing developer URL
    // switches, recorded in the settings so a comparison must match them.
    const d = settings.debug;
    keys(d, ['rangeDebug', 'forestDebug', 'rangeMsaa'], 'debug');
    if (d.rangeDebug != null) assert.ok(DEBUG_VIEWS.includes(d.rangeDebug), 'invalid debug.rangeDebug');
    if (d.forestDebug != null) assert.ok([0, 1].includes(d.forestDebug), 'invalid debug.forestDebug');
    if (d.rangeMsaa != null) assert.ok([0, 2, 4].includes(d.rangeMsaa), 'invalid debug.rangeMsaa');
  }
  for (const key of ['width', 'height']) { integer(settings[key], 64, 3840, key); assert.equal(settings[key] % 2, 0, `${key} must be even`); }
  // Every governor rung, so shedding boundaries (q2..q6) can be captured.
  integer(settings.seed, 0, 0xffffffff, 'seed'); integer(settings.quality, 0, 6, 'quality');
  for (const key of ACCESSIBILITY_KEYS) assert.equal(typeof settings[key], 'boolean', `invalid ${key}`);
  integer(settings.fps, 1, 60, 'fps'); integer(settings.intervalMs, 100, 3600000, 'intervalMs');
  if (settings.startMs != null) integer(settings.startMs, 0, 86400000, 'startMs');
  assert.ok(['sparse', 'continuous'].includes(settings.mode), 'invalid mode');
  assert.ok(settings.view === null || /^[a-z0-9-]+$/.test(settings.view), 'invalid view');
  assert.ok(settings.biome === null || REAL_BIOMES.includes(settings.biome), 'invalid biome');
  assert.ok(Array.isArray(value.songs) && value.songs.length > 0, 'songs cannot be empty');
  const ids = new Set();
  const songs = value.songs.map(song => {
    keys(song, ['id', 'file', 'fixture', 'seconds', 'timesMs', 'clips'], 'song');
    assert.ok(typeof song.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(song.id), 'invalid song id');
    assert.ok(!ids.has(song.id), 'duplicate song id'); ids.add(song.id);
    assert.equal(Number(!!song.file) + Number(!!song.fixture), 1, 'choose exactly one file or fixture');
    if (song.file) assert.ok(typeof song.file === 'string' && /\.(wav|mp3|flac|ogg|m4a|aac)$/i.test(song.file), 'unsupported audio file');
    if (song.fixture) assert.ok(['silence', 'kicks', 'contrast'].includes(song.fixture), 'unknown fixture');
    if (song.seconds != null) { assert.ok(song.fixture, 'seconds applies only to fixtures'); integer(song.seconds, 4, 600, 'seconds'); }
    if (song.timesMs != null) {
      assert.ok(Array.isArray(song.timesMs) && song.timesMs.length, 'timesMs cannot be empty');
      for (const t of song.timesMs) integer(t, 0, 86400000, 'timeMs');
    }
    if (song.clips != null) {
      assert.ok(Array.isArray(song.clips), 'invalid clips');
      for (const clip of song.clips) {
        keys(clip, ['startMs', 'durationMs'], 'clip');
        integer(clip.startMs, 0, 86400000, 'clip.startMs'); integer(clip.durationMs, 100, 30000, 'clip.durationMs');
      }
    }
    return { ...song, ...(song.fixture ? { seconds: song.seconds ?? 24 } : {}) };
  });
  return { version: 1, settings, songs };
}

export function captureSchedule(song, durationMs, settings) {
  assert.ok(Number.isFinite(durationMs) && durationMs > 0, 'invalid song duration');
  const start = settings.startMs ?? 0;
  assert.ok(start < durationMs, 'start exceeds duration');
  const times = song.timesMs ?? Array.from({ length: Math.ceil((durationMs - start) / settings.intervalMs) }, (_, i) => start + i * settings.intervalMs);
  const clips = song.clips ?? [{ startMs: Math.floor(durationMs * 0.5), durationMs: Math.min(2000, Math.floor(durationMs * 0.25)) }];
  for (const t of times) assert.ok(t < durationMs, `checkpoint ${t} exceeds duration ${durationMs}`);
  for (const t of times) assert.ok(t >= start, `checkpoint ${t} precedes start ${start}`);
  for (const c of clips) assert.ok(c.startMs >= start, `clip precedes start ${start}`);
  for (const c of clips) assert.ok(c.startMs + c.durationMs <= durationMs, `clip exceeds duration ${durationMs}`);
  const points = new Map();
  const add = (timeMs, checkpoint = false, clip = null) => {
    const t = Math.round(timeMs * 1000) / 1000;
    const p = points.get(t) || { timeMs: t, checkpoint: false, clips: [], save: false };
    p.checkpoint ||= checkpoint;
    if (clip != null && !p.clips.includes(clip)) p.clips.push(clip);
    p.save = p.checkpoint || !!p.clips.length; points.set(t, p);
  };
  times.forEach(t => add(t, true));
  const dt = 1000 / settings.fps;
  clips.forEach((c, i) => {
    for (let n = Math.ceil(Math.min(1000, c.startMs - start) / dt); n > 0; n--) add(Math.max(start, c.startMs - n * dt));
    for (let n = 0; n * dt < c.durationMs - 0.001; n++) add(c.startMs + n * dt, false, i);
  });
  assert.ok(points.size, 'empty capture schedule');
  const end = Math.max(...points.keys());
  if (settings.mode === 'continuous') for (let n = 0; start + n * dt <= end; n++) add(start + n * dt);
  // The opening assembly needs an early actual paint, even in sparse mode.
  if (start <= 250 && end >= 250) add(250);
  // In continuous mode the regular frame grid already paints the opening.
  if (settings.mode === 'continuous' && !times.includes(250) && !points.get(250)?.save && 250 % dt > 0.001) points.delete(250);
  return [...points.values()].sort((a, b) => a.timeMs - b.timeMs);
}

/** True for a frame with no picture: every thumbnail pixel within a couple
 *  of levels of one colour (a cleared canvas, a dead backend). */
export function blankFrame(thumbnail) {
  if (!Array.isArray(thumbnail) || thumbnail.length < 4) return true;
  for (let c = 0; c < 3; c++) {
    let lo = 255, hi = 0;
    for (let i = c; i < thumbnail.length; i += 4) { lo = Math.min(lo, thumbnail[i]); hi = Math.max(hi, thumbnail[i]); }
    if (hi - lo > 2) return false;
  }
  return true;
}

export function imageDifference(a, b) {
  assert.ok(Array.isArray(a) && a.length > 0 && a.length === b?.length && a.length % 4 === 0, 'incompatible thumbnails');
  let changed = 0, total = 0;
  for (let i = 0; i < a.length; i += 4) {
    let max = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); total += d; max = Math.max(max, d); }
    if (max > 2) changed++;
  }
  return { changedFraction: changed / (a.length / 4), meanAbsoluteError: total / (a.length / 4 * 3 * 255) };
}

function validateReport(report) {
  assert.ok(report && typeof report === 'object', 'missing report');
  assert.ok(typeof report.browser === 'string' && report.browser.length, 'missing browser');
  const source = report.source;
  assert.ok(source && /^[a-f0-9]{40}$/.test(source.commit) && /^[a-f0-9]{64}$/.test(source.digest)
    && source.changedDuringRun === false && source.hashes && /^[a-f0-9]{64}$/.test(source.hashes['index.html'])
    && /^[a-f0-9]{64}$/.test(source.hashes['src/main.js'])
    && Object.values(source.hashes).every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h)), 'missing or invalid source provenance');
  const settings = normalizeHistoricalSettings(report.settings);
  for (const key of Object.keys(DEFAULT_SETTINGS)) assert.ok(settings && Object.hasOwn(settings, key), `missing setting ${key}`);
  normalizeManifest({ version: 1, settings, songs: [{ id: 'validation', fixture: 'silence' }] });
  const env = report.environment;
  assert.ok(env && typeof env.gl === 'string' && env.gl.length && typeof env.vendor === 'string'
    && env.vendor.length && env.dpr === 1 && Object.hasOwn(env, 'deviceMemory')
    && (env.deviceMemory === null || (Number.isFinite(env.deviceMemory) && env.deviceMemory > 0)), 'missing or invalid render environment');
  assert.ok(Array.isArray(report.songs) && report.songs.length, 'missing songs');
  const ids = new Set();
  for (const song of report.songs) {
    assert.ok(typeof song.id === 'string' && song.id.length && !ids.has(song.id), 'invalid song id'); ids.add(song.id);
    assert.ok(Number.isFinite(song.durationMs) && song.durationMs > 0, 'missing or invalid duration');
    assert.ok(typeof song.audioSha256 === 'string' && /^[a-f0-9]{64}$/.test(song.audioSha256), 'missing or invalid audio hash');
    assert.ok(Array.isArray(song.schedule) && song.schedule.length && Array.isArray(song.frames) && song.frames.length, 'missing captures');
    let prior = -1;
    for (const point of song.schedule) {
      assert.ok(Number.isFinite(point.timeMs) && point.timeMs >= 0 && point.timeMs < song.durationMs
        && point.timeMs > prior && typeof point.save === 'boolean', 'invalid capture schedule'); prior = point.timeMs;
    }
    for (const frame of song.frames) {
      assert.ok(Number.isFinite(frame.timeMs) && Number.isFinite(frame.actualTimeMs) && frame.actualTimeMs >= 0
        && frame.actualTimeMs < song.durationMs && Math.abs(frame.actualTimeMs - frame.timeMs) <= 1000 / 60 + .01, 'missing or invalid actual time');
      assert.ok(typeof frame.sha256 === 'string' && /^[a-f0-9]{64}$/.test(frame.sha256), 'missing or invalid image hash');
      assert.ok(typeof frame.png === 'string' && frame.png.length, 'missing image path');
      assert.ok(Array.isArray(frame.thumbnail) && frame.thumbnail.length > 0 && frame.thumbnail.length % 4 === 0
        && frame.thumbnail.every(v => Number.isInteger(v) && v >= 0 && v <= 255), 'missing or invalid thumbnail');
      if (frame.accessibility !== undefined) {
        // Verified effective state must be what the settings requested.
        for (const key of ACCESSIBILITY_KEYS) {
          assert.equal(typeof frame.accessibility?.[key], 'boolean', `invalid effective ${key}`);
          assert.equal(frame.accessibility[key], settings[key], `effective ${key} differs from the requested setting`);
        }
      }
    }
  }
  accessibilityProvenance(report);
}

/** 'verified' when every frame records its effective preferences, 'unknown'
 *  for a historical report that recorded none. A partial record is invalid. */
export function accessibilityProvenance(report) {
  const frames = report.songs.flatMap(s => s.frames);
  const verified = frames.filter(f => f.accessibility !== undefined).length;
  assert.ok(verified === 0 || verified === frames.length, 'invalid accessibility provenance: some frames lack effective preferences');
  return verified ? 'verified' : 'unknown';
}

export function compareReports(before, after) {
  validateReport(before); validateReport(after);
  const same = (a, b, label) => assert.deepEqual(a, b, `incompatible ${label}`);
  same(before.version, 1, 'report version'); same(after.version, 1, 'report version');
  same(before.status, 'passed', 'baseline status'); same(after.status, 'passed', 'candidate status');
  const requested = settings => normalizeManifest({ version: 1, settings: normalizeHistoricalSettings(settings), songs: [{ id: 'validation', fixture: 'silence' }] }).settings;
  same(requested(before.settings), requested(after.settings), 'settings'); same(before.browser, after.browser, 'browser');
  same(before.environment, after.environment, 'render environment');
  same(before.songs.map(s => s.id), after.songs.map(s => s.id), 'song set');
  assert.ok(before.songs.length, 'missing songs');
  // Accessibility provenance: both verified must match frame by frame; two
  // historical reports compare as before (unknown); a historical baseline
  // against a verified candidate cannot establish matched provenance, so
  // that gate needs a fresh baseline.
  const sides = [accessibilityProvenance(before), accessibilityProvenance(after)];
  const provenance = sides[0] === sides[1] ? sides[0] : 'unmatched';
  const frames = [];
  for (let i = 0; i < before.songs.length; i++) {
    const a = before.songs[i], b = after.songs[i];
    same(a.audioSha256, b.audioSha256, `${a.id} audio`); same(a.durationMs, b.durationMs, `${a.id} duration`);
    same(a.schedule, b.schedule, `${a.id} schedule`);
    same(a.clips, b.clips, `${a.id} clips`);
    const expected = a.schedule.filter(f => f.save).map(f => f.timeMs);
    assert.ok(expected.length, 'missing captures');
    same(a.frames.map(f => f.timeMs), expected, 'missing baseline captures');
    same(b.frames.map(f => f.timeMs), expected, 'missing candidate captures');
    same(a.frames.map(f => f.actualTimeMs), b.frames.map(f => f.actualTimeMs), `${a.id} actual time`);
    same(a.frames.map(f => f.seed), b.frames.map(f => f.seed), `${a.id} actual song seed`);
    if (provenance === 'verified') same(a.frames.map(f => f.accessibility), b.frames.map(f => f.accessibility), `${a.id} effective accessibility`);
    a.frames.forEach((f, n) => frames.push({ songId: a.id, timeMs: f.timeMs, before: f.png, after: b.frames[n].png,
      identical: f.sha256 === b.frames[n].sha256, difference: imageDifference(f.thumbnail, b.frames[n].thumbnail) }));
  }
  return { version: 1, verdict: 'unreviewed', accessibility: { provenance, freshBaselineRequired: provenance === 'unmatched' }, frames };
}

/** `song@timeMs` for every compared frame whose PNG bytes differ. */
export function differingFrames(diff) {
  return diff.frames.filter(f => !f.identical).map(f => `${f.songId}@${f.timeMs}`);
}

/**
 * A VFX matrix: shared settings and songs plus named cases that override
 * settings (quality rung, preferences, look, view). One case is one ordinary
 * manifest, so each runs, repeats and compares exactly like the corpus.
 */
export function normalizeMatrix(value) {
  keys(value, ['version', 'kind', 'note', 'settings', 'songs', 'cases'], 'matrix');
  assert.equal(value.version, 1, 'matrix version must be 1');
  assert.equal(value.kind, 'matrix', 'not a matrix');
  assert.ok(Array.isArray(value.cases) && value.cases.length, 'cases cannot be empty');
  const ids = new Set();
  const cases = value.cases.map(c => {
    keys(c, ['id', 'covers', 'settings', 'songs'], 'case');
    assert.ok(typeof c.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(c.id), 'invalid case id');
    assert.ok(!ids.has(c.id), 'duplicate case id'); ids.add(c.id);
    const songs = c.songs ? value.songs.filter(s => c.songs.includes(s.id)) : value.songs;
    assert.equal(songs.length, c.songs ? c.songs.length : value.songs.length, `${c.id}: unknown song`);
    return { id: c.id, covers: c.covers ?? null, manifest: normalizeManifest({ version: 1, settings: { ...value.settings, ...c.settings }, songs }) };
  });
  return { version: 1, kind: 'matrix', cases };
}

/** The ordinary manifest for one matrix case. */
export function manifestForCase(matrix, id) {
  const found = normalizeMatrix(matrix).cases.find(c => c.id === id);
  assert.ok(found, `unknown case ${id}`);
  return found.manifest;
}
