import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TITLE_CARD_HOLD_MS, TITLE_CARD_END_MS, RISE_SURGE_START_MS, RISE_SURGE_MS, RISE_SURGE_RELIEF,
  titleCardAlpha, riseSurge01,
} from '../src/core/OpeningTimeline.js';
import { compileLandRise } from '../src/world/alpine/LandRise.js';
import { FINALE_MS } from '../src/world/alpine/RangeCamera.js';
import { BUILD_CAMERA } from '../src/world/alpine/LandRiseCamera.js';

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

test('the surge starts under the card and completes about two seconds after it fades', () => {
  assert.equal(riseSurge01(0), 0);
  assert.equal(riseSurge01(RISE_SURGE_START_MS), 0);
  assert.ok(RISE_SURGE_START_MS < TITLE_CARD_HOLD_MS, 'the reveal shows land already rising');
  assert.equal(riseSurge01(RISE_SURGE_START_MS + RISE_SURGE_MS), 1);
  assert.ok(RISE_SURGE_START_MS + RISE_SURGE_MS - TITLE_CARD_END_MS <= 2000, 'at most two seconds of surge after the card');
  assert.equal(RISE_SURGE_RELIEF, BUILD_CAMERA.settleRise, 'the opening lens has widened when the surge lands');
});

test('the visible opening is a mountain range within seconds, and the climb still completes on the music', () => {
  for (const durationMs of [90000, 210000, 360000]) {
    for (const level of [0, .4, 1]) {
      const rise = compileLandRise({ read: () => level, durationMs, cadenceMs: durationMs, finaleMs: FINALE_MS });
      assert.ok(Math.abs(rise.at(0) - 1 / 3) < 1e-12, 'one-third built under the title card');
      assert.ok(rise.at(RISE_SURGE_START_MS) >= 1 / 3 && rise.at(RISE_SURGE_START_MS) < .4,
        'the musical climb continues from the skipped opening');
      assert.ok(rise.at(TITLE_CARD_END_MS) >= .5, `past half relief as the card clears (${durationMs}/${level}: ${rise.at(TITLE_CARD_END_MS)})`);
      assert.ok(rise.at(RISE_SURGE_START_MS + RISE_SURGE_MS) >= RISE_SURGE_RELIEF, 'most of the range stands when the surge lands');
      assert.equal(rise.at(rise.endMs), 1);
      let prev = -Infinity;
      for (let t = 0; t <= durationMs; t += 100) {
        const s = rise.at(t);
        assert.ok(s >= prev - 1e-12 && s <= 1, `monotone and bounded at ${t}`);
        prev = s;
      }
    }
  }
});

test('an analysis handoff after the surge keeps the surge and never jumps', () => {
  const opening = compileLandRise({ read: () => .3, durationMs: 200000, cadenceMs: 200000, finaleMs: FINALE_MS });
  const freezeThroughMs = 10000;
  const whole = compileLandRise({ read: () => .6, durationMs: 200000, cadenceMs: 190000, finaleMs: FINALE_MS,
    previous: opening.progressAt, freezeThroughMs });
  for (let t = 0; t <= freezeThroughMs; t += 250) assert.equal(whole.at(t), opening.at(t));
  assert.ok(Math.abs(whole.at(freezeThroughMs + 1) - opening.at(freezeThroughMs)) < 1e-3);
});
