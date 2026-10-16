// The export's job is to produce a file that plays where the player thinks
// it will. Most of these tests are about the ways that promise can quietly
// break: an MP4 container holding a codec no hardware decodes, a 16:9 show
// stretched onto a 5:3 dashboard, a filename two songs collapse into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RENDER_PRESETS, DEFAULT_PRESET_ID, presetById, MIME_CANDIDATES, pickMimeType,
  reachSummary, fitLetterbox, needsLetterbox, videoBitsPerSecond, estimateBytes,
  formatBytes, formatElapsed, exportFileName, sniffVideoCodec, describeResult,
  STAGE_W, STAGE_H,
} from '../src/render/VideoExport.js';

/** A browser that supports exactly the listed types. */
const supporting = (...types) => (type) => types.includes(type);

test('H.264 in MP4 wins when it is on offer', () => {
  const chrome = supporting(
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4', 'video/webm;codecs="vp9,opus"',
  );
  const picked = pickMimeType(chrome);
  assert.equal(picked.video, 'H.264');
  assert.equal(picked.ext, 'mp4');
  assert.equal(picked.reach, 'anywhere');
});

test('an MP4 container with no codec promise is never sold as one', () => {
  // This is the real trap: a Chromium build without proprietary codecs
  // answers true to 'video/mp4' and then writes VP9 into it. The file has
  // the right extension and a head unit still refuses it.
  const openSourceChromium = supporting('video/mp4', 'video/mp4;codecs=vp9', 'video/webm;codecs="vp9,opus"');
  const picked = pickMimeType(openSourceChromium);
  assert.equal(picked.ext, 'mp4');
  assert.notEqual(picked.reach, 'anywhere');
  assert.equal(picked.reach, 'unknown');
  assert.match(reachSummary(picked), /may not be H\.264/);
});

test('a browser with only WebM says so instead of failing', () => {
  const firefox = supporting('video/webm;codecs="vp9,opus"', 'video/webm');
  const picked = pickMimeType(firefox);
  assert.equal(picked.ext, 'webm');
  assert.equal(picked.reach, 'browsers');
  assert.match(reachSummary(picked), /not on most car head units/);
});

test('a browser that records nothing is reported, not crashed into', () => {
  assert.equal(pickMimeType(supporting()), null);
  assert.equal(pickMimeType(null), null);
  assert.equal(pickMimeType(() => { throw new Error('nope'); }), null);
  assert.match(reachSummary(null), /cannot record/);
});

test('every candidate in the ladder is internally consistent', () => {
  for (const c of MIME_CANDIDATES) {
    assert.ok(c.mimeType.startsWith(`video/${c.ext}`), c.mimeType);
    // Only an explicitly-requested H.264 may claim to play anywhere.
    if (c.reach === 'anywhere') assert.equal(c.video, 'H.264');
    if (c.video === null) assert.notEqual(c.reach, 'anywhere');
  }
  // Best first: the ladder must never offer a weaker reach before a
  // stronger one, or a browser that supports both would get the weaker.
  const rank = { anywhere: 0, unknown: 1, browsers: 2 };
  const reaches = MIME_CANDIDATES.map((c) => rank[c.reach]);
  assert.deepEqual(reaches, [...reaches].sort((a, b) => a - b));
});

test('a 16:9 show fits a 5:3 dashboard without being stretched', () => {
  const car = presetById('car');
  const fit = fitLetterbox(STAGE_W, STAGE_H, car.width, car.height);
  assert.deepEqual(fit, { x: 0, y: 15, width: 800, height: 450 });
  // The aspect that went in is the aspect that comes out.
  assert.ok(Math.abs(fit.width / fit.height - STAGE_W / STAGE_H) < 0.005);
  assert.equal(needsLetterbox(STAGE_W, STAGE_H, car.width, car.height), true);
});

test('a 16:9 target gets the whole frame and no bars at all', () => {
  for (const id of ['720p', '1080p']) {
    const p = presetById(id);
    const fit = fitLetterbox(STAGE_W, STAGE_H, p.width, p.height);
    assert.deepEqual(fit, { x: 0, y: 0, width: p.width, height: p.height }, id);
    assert.equal(needsLetterbox(STAGE_W, STAGE_H, p.width, p.height), false, id);
  }
});

test('letterboxing a taller-than-wide target bars the sides instead', () => {
  const fit = fitLetterbox(1280, 720, 480, 800);
  assert.equal(fit.width, 480);
  assert.equal(fit.height, 270);
  assert.equal(fit.x, 0);
  assert.equal(fit.y, 265);
});

test('degenerate sizes produce nothing rather than NaN', () => {
  assert.deepEqual(fitLetterbox(0, 720, 800, 480), { x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(fitLetterbox(1280, 720, 800, 0), { x: 0, y: 0, width: 0, height: 0 });
});

test('every preset is even-dimensioned, which H.264 requires', () => {
  for (const p of RENDER_PRESETS) {
    assert.equal(p.width % 2, 0, `${p.id} width`);
    assert.equal(p.height % 2, 0, `${p.id} height`);
    assert.ok(p.label && p.id);
  }
  assert.ok(RENDER_PRESETS.some((p) => p.id === DEFAULT_PRESET_ID));
  // An unknown id falls back rather than returning undefined into the
  // canvas sizing, where it would become a 0x0 recording.
  assert.equal(presetById('nonsense').id, DEFAULT_PRESET_ID);
  assert.equal(presetById(undefined).id, DEFAULT_PRESET_ID);
});

test('bitrate follows pixel count and stays inside its clamps', () => {
  const car = videoBitsPerSecond(800, 480);
  const hd = videoBitsPerSecond(1280, 720);
  const fullHd = videoBitsPerSecond(1920, 1080);
  assert.ok(car < hd && hd < fullHd);
  assert.ok(fullHd <= 12_000_000, 'a long song has to fit in memory');
  // A tiny target still gets enough bitrate to not look like a fax.
  assert.ok(videoBitsPerSecond(64, 36) >= 800_000);
  assert.ok(videoBitsPerSecond(0, 0) > 0);
  assert.ok(videoBitsPerSecond(1920, 1080, 30) < videoBitsPerSecond(1920, 1080, 60));
});

test('the size estimate is close enough to make a decision on', () => {
  const fourMinutes = 4 * 60 * 1000;
  const car = estimateBytes({ ...presetById('car'), durationMs: fourMinutes });
  const hd = estimateBytes({ ...presetById('1080p'), durationMs: fourMinutes });
  assert.ok(car > 10e6 && car < 120e6, formatBytes(car));
  assert.ok(hd > car);
  assert.equal(estimateBytes({ width: 800, height: 480, durationMs: 0 }), 0);
  assert.equal(estimateBytes(), 0);
});

test('sizes and clocks read the way a person would say them', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(52 * 1024 * 1024), '52 MB');
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(NaN), '—');
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(65_000), '1:05');
  assert.equal(formatElapsed(null), '0:00');
});

test('a filename survives a hostile song title and stays unique', () => {
  const date = new Date(2026, 8, 19);
  assert.equal(
    exportFileName({ songName: 'Weird Fishes.flac', presetId: 'car', ext: 'mp4', date }),
    'Weird Fishes - car - 2026-09-19.mp4',
  );
  // Reserved characters are replaced, not dropped: two titles differing
  // only in punctuation must not become the same file.
  const a = exportFileName({ songName: 'AC/DC', date });
  const b = exportFileName({ songName: 'AC:DC', date });
  assert.ok(!a.includes('/') && !a.includes(':'));
  assert.equal(a, b.replace('-', '-')); // both become "AC-DC"
  assert.ok(exportFileName({ songName: '', date }).startsWith('song'));
  assert.ok(exportFileName({ songName: 'x'.repeat(200), date }).length < 100);
});

test('the codec is read from the bytes, not from the extension', () => {
  const withFourcc = (code) => {
    const bytes = new Uint8Array(64);
    for (let i = 0; i < 4; i++) bytes[20 + i] = code.charCodeAt(i);
    return bytes;
  };
  assert.equal(sniffVideoCodec(withFourcc('avc1')), 'H.264');
  assert.equal(sniffVideoCodec(withFourcc('avc3')), 'H.264');
  assert.equal(sniffVideoCodec(withFourcc('vp09')), 'VP9');
  assert.equal(sniffVideoCodec(withFourcc('av01')), 'AV1');
  assert.equal(sniffVideoCodec(withFourcc('hvc1')), 'HEVC');
  // A miss is a vaguer sentence, never a rejected file.
  assert.equal(sniffVideoCodec(new Uint8Array(64)), null);
  assert.equal(sniffVideoCodec(new Uint8Array(0)), null);
  assert.equal(sniffVideoCodec(null), null);
});

test('what the file turned out to be beats what was asked for', () => {
  const mp4 = MIME_CANDIDATES[0];
  const good = describeResult({ candidate: mp4, codec: 'H.264', bytes: 52428800, durationMs: 195000 });
  assert.match(good, /H\.264/);
  assert.match(good, /plays anywhere/);
  assert.match(good, /3:15/);

  // The container says MP4 and the extension says MP4 -- and the bytes say
  // this will not play in a car. That sentence is the whole point.
  const trap = describeResult({ candidate: { ext: 'mp4' }, codec: 'VP9', bytes: 1000, durationMs: 1000 });
  assert.match(trap, /MP4/);
  assert.match(trap, /VP9/);
  assert.ok(!/plays anywhere/.test(trap));
  assert.match(trap, /will not decode/);

  // Unknown codec: state the facts, claim nothing.
  const vague = describeResult({ candidate: { ext: 'webm' }, codec: null, bytes: 1000, durationMs: 1000 });
  assert.ok(!/plays anywhere/.test(vague));
  assert.match(vague, /WEBM/);
});
