// The screen "biting down" on a transition.
//
// The shutter closes 14 columns in from the top and bottom edges over a full
// bar. It only ever fired on a section boundary -- but with no cooldown, no
// probability and no intensity term, so every qualifying boundary fired one,
// and boundaries are allowed to sit MIN_SECTION_CUT_GAP_MS (11s) apart. It
// also ignored reduced-flash entirely while being the largest, highest
// contrast event in the game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { classifyTransition } from '../src/world/Dramaturgy.js';
import { FlourishGate } from '../src/sim/FlourishGate.js';
import { MIN_SECTION_CUT_GAP_MS } from '../src/audio/sectionBudget.js';

const SHUTTER_MIN_GAP_MS = 45000; // mirrors BiomeManager's own constant

/** A bare BiomeManager carrying just the state the boundary handler touches
 *  (the real constructor needs a canvas, which Node has no business owning).
 *  Same bare-prototype approach as test/sectionDetection.test.js. */
function fakeManager(sections) {
  const bm = Object.create(BiomeManager.prototype);
  bm.sections = sections;
  bm._lastSectionIdx = null;
  bm._cutFlash = 0;
  bm._shutterStartMs = -Infinity;
  bm._shutterBarMs = 500;
  bm.shutterDebug = null;
  bm.vibeEpic = 0.5;
  bm._shutterGate = new FlourishGate({ minGapMs: SHUTTER_MIN_GAP_MS, chance: 1 });
  return bm;
}

/** Drive the section-boundary branch of update() at `nowMs`. */
function crossBoundary(bm, idx, nowMs) {
  const sec = bm.sections[idx];
  if (sec.transition === 'shutter') {
    const fired = bm._shutterGate.tryFire(nowMs, { intensity: bm.vibeEpic, transition: true });
    bm.shutterDebug = { fired, reason: bm._shutterGate.lastReason, atMs: nowMs };
    if (fired) { bm._shutterStartMs = nowMs; bm._shutterBarMs = sec.barMs; }
  }
  bm._lastSectionIdx = idx;
  return bm.shutterDebug;
}

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

test('two boundaries at the legal 11s minimum cannot both bite', () => {
  const bm = fakeManager([
    { transition: 'fade', barMs: 2000 },
    { transition: 'shutter', barMs: 2000 },
    { transition: 'shutter', barMs: 2000 },
  ]);
  assert.equal(crossBoundary(bm, 1, 30000).fired, true, 'the first one should land');
  const second = crossBoundary(bm, 2, 30000 + MIN_SECTION_CUT_GAP_MS);
  assert.equal(second.fired, false, 'two bites 11s apart read as a malfunction');
  assert.equal(second.reason, 'floor', 'and the floor is what refused it');
});

test('the floor holds even though the shutter passes transition:true', () => {
  // transition:true skips the probability roll only -- never the hard floor.
  // That distinction is the whole reason this gate is the right tool here.
  const g = new FlourishGate({ minGapMs: SHUTTER_MIN_GAP_MS, chance: 1 });
  assert.equal(g.tryFire(0, { transition: true }), true);
  assert.equal(g.tryFire(SHUTTER_MIN_GAP_MS - 1, { transition: true }), false);
  assert.equal(g.lastReason, 'floor');
  assert.equal(g.tryFire(SHUTTER_MIN_GAP_MS, { transition: true }), true);
});

test('a long song gets a handful of bites, not one per section', () => {
  const bm = fakeManager([]);
  // Twelve boundaries (MAX_SECTION_CUTS) across five minutes, every one of
  // them sharp enough to want a shutter.
  let fired = 0;
  for (let i = 0; i < 12; i++) {
    const at = (i + 1) * (300000 / 13);
    if (bm._shutterGate.tryFire(at, { transition: true })) fired++;
  }
  assert.ok(fired <= 7, `expected a handful over five minutes, got ${fired}`);
  assert.ok(fired >= 2, 'but it must still punctuate the song');
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
