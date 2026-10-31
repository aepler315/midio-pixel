import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DETAIL_LEVELS, stepDetail, snapshotFileName, captureDetailSnapshots } from '../src/ui/DetailSnapshots.js';
import { PIXEL_GRIDS } from '../src/render/PixelRenderPolicy.js';

test('the five detail levels are the Display menu grids, coarse to fine', () => {
  assert.deepEqual(DETAIL_LEVELS, ['classic', 'classicPlus', 'medium', 'mediumPlus', 'detailed']);
  assert.deepEqual([...DETAIL_LEVELS].sort(), Object.keys(PIXEL_GRIDS).sort());
  const widths = DETAIL_LEVELS.map((id) => PIXEL_GRIDS[id].width);
  assert.deepEqual(widths, [...widths].sort((a, b) => a - b));
});

test('detail steps one level at a time and holds at either end', () => {
  assert.equal(stepDetail('classic', 1), 'classicPlus');
  assert.equal(stepDetail('medium', -1), 'classicPlus');
  assert.equal(stepDetail('classic', -1), 'classic');
  assert.equal(stepDetail('detailed', 1), 'detailed');
  assert.equal(stepDetail('unknown', 1), 'classicPlus');
});

test('snapshot files are midio_YYYYMMDD_<level>.png in local time', () => {
  const day = new Date(2026, 9, 4, 23, 59);
  assert.equal(snapshotFileName(day, 'classic'), 'midio_20261004_classic.png');
  const names = DETAIL_LEVELS.map((level) => snapshotFileName(day, level));
  assert.equal(new Set(names).size, 5, 'one distinct file per level');
});

test('a snapshot renders and saves every level in order, stopping at a failure', async () => {
  const log = [];
  const saved = await captureDetailSnapshots({
    render: async (level) => { log.push(`render ${level}`); return { level }; },
    save: async (level, canvas) => { log.push(`save ${canvas.level}`); },
  });
  assert.deepEqual(saved, DETAIL_LEVELS);
  assert.deepEqual(log, DETAIL_LEVELS.flatMap((l) => [`render ${l}`, `save ${l}`]));
  await assert.rejects(captureDetailSnapshots({
    render: async (level) => { if (level === 'medium') throw new Error('frame did not finish'); return {}; },
    save: async () => {},
  }), /frame did not finish/);
});

test('Android captures only the current detail at the existing output size', async () => {
  const { snapshotCapturePlan } = await import('../src/ui/DetailSnapshots.js');
  assert.deepEqual(snapshotCapturePlan('Mozilla/5.0 (Linux; Android 13)', 'mediumPlus'), {
    levels: ['mediumPlus'], size: null,
  });
  assert.deepEqual(snapshotCapturePlan('Mozilla/5.0 (X11; Linux x86_64)', 'mediumPlus'), {
    levels: DETAIL_LEVELS, size: { w: 1920, h: 1080 },
  });
});
