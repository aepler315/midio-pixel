import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_SECTION_CUT_GAP_MS, MIN_SECTION_GAP_BARS, sectionPacing,
} from '../src/audio/sectionBudget.js';

test('sectionPacing keeps phrase spacing in bars when a bar grid is trustworthy', () => {
  const slow = sectionPacing({ durationMs: 180000, pointCount: 54, barSynchronous: true });
  const fast = sectionPacing({ durationMs: 180000, pointCount: 162, barSynchronous: true });
  assert.equal(slow.source, 'bars');
  assert.equal(slow.minGapPoints, MIN_SECTION_GAP_BARS);
  assert.equal(fast.minGapPoints, MIN_SECTION_GAP_BARS);
  assert.ok(fast.maxCuts > slow.maxCuts,
    'the same three minutes should admit more phrase candidates when it contains more bars');
});

test('sectionPacing preserves the seconds contract for free-time audio', () => {
  const pacing = sectionPacing({ durationMs: 180000, pointCount: 90, barSynchronous: false });
  assert.equal(pacing.source, 'time');
  assert.equal(pacing.minGapMs, MIN_SECTION_CUT_GAP_MS);
  assert.equal(pacing.minGapPoints, null);
});
