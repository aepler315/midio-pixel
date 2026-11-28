import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TITLE_CARD_HOLD_MS, TITLE_CARD_END_MS, OPENING_ZOOM_START_MS, OPENING_ZOOM_MS,
  titleCardAlpha, openingZoomRelease01,
} from '../src/core/OpeningTimeline.js';
import { compileLandRise, LAND_RISE_START } from '../src/world/alpine/LandRise.js';
import { FINALE_MS } from '../src/world/alpine/RangeCamera.js';

test('the title card holds, then fades out completely by its end', () => {
  assert.equal(titleCardAlpha(0), 1);
  assert.equal(titleCardAlpha(TITLE_CARD_HOLD_MS), 1);
  const mid = titleCardAlpha((TITLE_CARD_HOLD_MS + TITLE_CARD_END_MS) / 2);
  assert.ok(mid > 0 && mid < 1, `fading at the midpoint (${mid})`);
  assert.equal(titleCardAlpha(TITLE_CARD_END_MS), 0);
  assert.equal(titleCardAlpha(60000), 0);
  let prev = 1;
  for (let t = 0; t <= TITLE_CARD_END_MS + 500; t += 20) {
    const a = titleCardAlpha(t);
    assert.ok(a <= prev + 1e-12, `never brightens again (${t})`);
    prev = a;
  }
});

test('the opening close-up releases under the card and is wide by five seconds in', () => {
  assert.ok(OPENING_ZOOM_START_MS > 0 && OPENING_ZOOM_START_MS <= TITLE_CARD_HOLD_MS, 'it starts widening under the held card');
  assert.ok(OPENING_ZOOM_MS >= 4000, 'the pull back is spread over four seconds or more');
  assert.equal(openingZoomRelease01(0), 0);
  assert.equal(openingZoomRelease01(OPENING_ZOOM_START_MS), 0);
  assert.equal(openingZoomRelease01(OPENING_ZOOM_START_MS + OPENING_ZOOM_MS), 1);
  assert.ok(OPENING_ZOOM_START_MS + OPENING_ZOOM_MS <= 5000, 'the authored lens is back within five seconds');
  assert.equal(openingZoomRelease01(NaN), 0, 'no clock releases nothing');
  let prev = 0;
  for (let t = 0; t <= OPENING_ZOOM_START_MS + OPENING_ZOOM_MS + 500; t += 50) {
    const r = openingZoomRelease01(t);
    assert.ok(r >= prev - 1e-12 && r <= 1, `monotone at ${t}`);
    prev = r;
  }
});

test('the land builds across the whole song from a low start, with no early jump', () => {
  for (const durationMs of [90000, 210000, 360000]) {
    for (const level of [0, .4, 1]) {
      const rise = compileLandRise({ read: () => level, durationMs, cadenceMs: durationMs, finaleMs: FINALE_MS });
      assert.ok(Math.abs(rise.at(0) - LAND_RISE_START) < 1e-12, 'low-built under the title card');
      assert.ok(rise.at(OPENING_ZOOM_START_MS + OPENING_ZOOM_MS) < .45,
        `no surge: still mostly to build when the opening ends (${durationMs}/${level}: ${rise.at(5000)})`);
      assert.ok(rise.at(rise.endMs / 2) > rise.at(5000) + .1, 'the music builds the range through the song');
      assert.equal(rise.at(rise.endMs), 1);
      let prev = -Infinity;
      for (let t = 0; t <= durationMs; t += 100) {
        const h = rise.at(t);
        assert.ok(h >= prev - 1e-12 && h <= 1, `monotone and bounded at ${t}`);
        prev = h;
      }
    }
  }
});

test('an analysis handoff keeps the opening build and never jumps', () => {
  const opening = compileLandRise({ read: () => .3, durationMs: 200000, cadenceMs: 200000, finaleMs: FINALE_MS });
  const freezeThroughMs = 10000;
  const whole = compileLandRise({ read: () => .6, durationMs: 200000, cadenceMs: 190000, finaleMs: FINALE_MS,
    previous: opening.progressAt, freezeThroughMs });
  for (let t = 0; t <= freezeThroughMs; t += 250) assert.equal(whole.at(t), opening.at(t));
  assert.ok(Math.abs(whole.at(freezeThroughMs + 1) - opening.at(freezeThroughMs)) < 1e-3);
});
