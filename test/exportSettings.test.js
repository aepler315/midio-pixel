import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as video from '../src/render/VideoExport.js';

test('export settings derive even landscape, portrait, square and car dimensions', () => {
  assert.equal(typeof video.resolveExportSettings, 'function');
  for (const [aspect, resolution, width, height] of [
    ['16:9', '1080', 1920, 1080], ['9:16', '1080', 1080, 1920],
    ['1:1', '720', 720, 720], ['4:3', '1440', 1920, 1440],
    ['16:9', '2160', 3840, 2160], ['16:9', '480', 854, 480], ['5:3', '2160', 800, 480],
  ]) {
    const result = video.resolveExportSettings({ aspect, resolution });
    assert.equal(result.width, width); assert.equal(result.height, height);
  }
});

test('corrupt stored export settings recover to usable defaults and storage failures are harmless', () => {
  assert.equal(typeof video.readExportSettings, 'function');
  const prefs = video.readExportSettings({ getItem: () => '{broken' });
  assert.equal(prefs.width, 1280); assert.equal(prefs.height, 720); assert.equal(prefs.fps, 30);
  const normalized = video.resolveExportSettings({ resolution: 'huge', fps: 240, aspect: 'no', encoding: 'no', framing: 'no' });
  assert.equal(normalized.fps, 30); assert.equal(normalized.encoding, 'balanced'); assert.equal(normalized.framing, 'fit');
  assert.doesNotThrow(() => video.writeExportSettings({ setItem() { throw new Error('private'); } }, prefs));
});

test('encoding and fps change requested bitrate and estimated file size independently of dimensions', () => {
  assert.equal(typeof video.exportVideoBitsPerSecond, 'function');
  const base = { resolution: '1080', aspect: '16:9', fps: 30 };
  const low = video.resolveExportSettings({ ...base, encoding: 'compact' });
  const high = video.resolveExportSettings({ ...base, encoding: 'best' });
  assert.equal(video.exportVideoBitsPerSecond(low), 3421440);
  assert.equal(video.exportVideoBitsPerSecond(high), 11197440);
  assert.equal(video.estimateExportBytes(low, 60000), 26860800);
  assert.equal(video.exportVideoBitsPerSecond({ ...low, fps: 60 }), 6842880);
  assert.equal(low.width, high.width); assert.equal(low.height, high.height);
});

test('fill crops centrally while fit preserves the entire frame without distortion', () => {
  assert.equal(typeof video.exportFrameRect, 'function');
  assert.deepEqual(video.exportFrameRect(1280, 720, 720, 1280, 'fit'), { x: 0, y: 438, width: 720, height: 405 });
  assert.deepEqual(video.exportFrameRect(1280, 720, 720, 1280, 'fill'), { x: -778, y: 0, width: 2276, height: 1280 });
});
