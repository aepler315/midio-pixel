// The screen "biting down" on a transition.
//
// The shutter closes 14 columns in from the top and bottom edges over a full
// bar. It only ever fired on a section boundary -- but with no cooldown, no
// probability and no intensity term, so every qualifying boundary fired one,
// and boundaries are allowed to sit MIN_SECTION_CUT_GAP_MS (11s) apart. It
// is also the largest, highest contrast event in the game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { classifyTransition } from '../src/world/Dramaturgy.js';

test('a boundary no longer paints the column shutter', () => {
  const fills = [];
  const ctx = {
    save() {}, restore() {},
    fillRect() { fills.push('bar'); },
  };
  const bm = Object.create(BiomeManager.prototype);
  bm._cutFlash = 0;
  bm.tSec = 2;
  bm._drawTransitionOverlays(ctx, { width: 200, height: 100 }, { silhouette: '#000' });
  assert.equal(fills.length, 0);
});

test('the shutter is the strongest effect, so only the sharpest boundary earns it', () => {
  assert.equal(classifyTransition(1.0, 1), 'shutter');
  assert.equal(classifyTransition(0.5, 1), 'cut', 'a moderate boundary flashes instead');
  assert.equal(classifyTransition(0.2, 1), 'fade');
});

test('an unmeasured boundary fades rather than inheriting a meaningless sharpness', () => {
  // Cuts placed by the minimum-sections floor (even time-splits) or by the
  // SSM have no energy-novelty peak behind them. Classifying from whatever
  // the novelty array happened to read at that index is how a boundary with
  // no drama in it was handed the most violent transition in the game.
  const fake = Object.create(BiomeManager.prototype);
  // Flat energy: nothing to find, so the minimum-sections floor inserts even
  // time-splits -- boundaries with no measured sharpness at all.
  const flat = { sampleAll: () => new Array(7).fill(0.4) };
  fake._buildSchedule([], flat, 120000, 1, null);
  assert.ok(fake.sections.length >= 3, 'the floor should have inserted sections');
  for (const s of fake.sections) {
    // 'cut' is allowed here: a recurring section label is deliberately
    // snapped to a cut of recognition, and a cut is a brief flash. What must
    // never happen is the *bite* landing on a boundary we cannot measure.
    assert.notEqual(s.transition, 'shutter', 'an unmeasured boundary must not bite');
  }
});
