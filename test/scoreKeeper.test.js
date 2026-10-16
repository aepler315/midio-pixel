import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScoreKeeper } from '../src/sim/ScoreKeeper.js';

const hit = (basePts, tier) => ({ kind: 'hit', basePts, tier, tMs: 0 });

test('score multiplies, accuracy does not', () => {
  const sk = new ScoreKeeper(200);
  sk.applyEvent(hit(100, 'perfect'), 3.0);
  sk.applyEvent(hit(100, 'perfect'), 1.5);
  assert.equal(sk.score, 450);
  assert.equal(sk.timingEarned, 200);
  assert.equal(sk.accuracyPct, 100, 'a full multiplier run still caps at 100%');
});

test('tier counts, misses, and hold outcomes tally by kind', () => {
  const sk = new ScoreKeeper(1000);
  sk.applyEvent(hit(100, 'perfect'));
  sk.applyEvent(hit(70, 'great'));
  sk.applyEvent(hit(20, 'good'));
  sk.applyEvent({ kind: 'sour', basePts: 0, tier: 'sour' });
  sk.applyEvent({ kind: 'miss', basePts: 0 });
  sk.applyEvent({ kind: 'holdStart', basePts: 90, tier: 'perfect' });
  sk.applyEvent({ kind: 'holdStart', basePts: 0, tier: null }); // late-armed
  sk.applyEvent({ kind: 'holdTick', basePts: 25 });
  sk.applyEvent({ kind: 'holdComplete', basePts: 150 });
  sk.applyEvent({ kind: 'holdChoke', basePts: 0, remainingTicks: 3 });
  assert.deepEqual(sk.counts, { perfect: 2, great: 1, good: 1, sour: 1 });
  assert.equal(sk.misses, 1);
  assert.equal(sk.holdsCompleted, 1);
  assert.equal(sk.holdsChoked, 1);
  assert.equal(sk.timingEarned, 100 + 70 + 20 + 90 + 25 + 150);
});

test('peak streak survives resets', () => {
  const sk = new ScoreKeeper(100);
  sk.noteStreak(3);
  sk.noteStreak(7);
  sk.noteStreak(0); // stumble reset
  sk.noteStreak(4);
  assert.equal(sk.peakStreak, 7);
});

test('grade boundaries are inclusive at 95/85/70/50', () => {
  const gradeFor = (earned) => {
    const sk = new ScoreKeeper(100);
    sk.applyEvent(hit(earned, 'good'));
    return sk.grade;
  };
  assert.equal(gradeFor(95), 'S');
  assert.equal(gradeFor(94), 'A');
  assert.equal(gradeFor(85), 'A');
  assert.equal(gradeFor(84), 'B');
  assert.equal(gradeFor(70), 'B');
  assert.equal(gradeFor(69), 'C');
  assert.equal(gradeFor(50), 'C');
  assert.equal(gradeFor(49), 'D');
  assert.equal(gradeFor(0), 'D');
});

test('a song with nothing to judge reports null accuracy and grade', () => {
  const sk = new ScoreKeeper(0);
  assert.equal(sk.accuracyPct, null);
  assert.equal(sk.grade, null);
});

test('fractional multipliers round the displayed score per event', () => {
  const sk = new ScoreKeeper(100);
  sk.applyEvent(hit(25, 'good'), 1.3); // 32.5 -> 33
  assert.equal(sk.score, 33);
});
