import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BabyStars, BABY_COUNT, NEST_RADIUS } from '../src/sim/BabyStars.js';

const BASE = { x: 400, y: 200 };
const DT = 1 / 120;

function run(babies, seconds, calm, base = BASE, interest = null) {
  for (let i = 0; i < Math.round(seconds * 120); i++) {
    babies.update(i * DT * 1000, DT, base, calm, interest);
  }
}

test('three babies materialize on the nest orbit and stay near the base when calm is moderate', () => {
  const babies = new BabyStars(1);
  run(babies, 1.0, 0.2); // below the explore threshold: everyone nests
  assert.equal(babies.stars.length, BABY_COUNT);
  for (const s of babies.stars) {
    assert.equal(s.state, 'nest');
    const d = Math.hypot(s.x - BASE.x, s.y - BASE.y);
    assert.ok(d < NEST_RADIUS * 2.5, `nesting baby drifted to ${d}px`);
  }
});

test('a calm stretch sends exactly one explorer out at a time', () => {
  const babies = new BabyStars(2);
  run(babies, 6, 0.9);
  let sawExplorer = false;
  const babies2 = new BabyStars(2);
  for (let i = 0; i < 6 * 120; i++) {
    babies2.update(i * DT * 1000, DT, BASE, 0.9);
    const out = babies2.stars.filter((s) => s.state !== 'nest').length;
    assert.ok(out <= 1, `secure base means one venture at a time, saw ${out}`);
    if (out === 1) sawExplorer = true;
  }
  assert.ok(sawExplorer, 'somebody must eventually explore in a calm stretch');
});

test('the explorer actually leaves the nest radius', () => {
  const babies = new BabyStars(3);
  let maxD = 0;
  for (let i = 0; i < 8 * 120; i++) {
    babies.update(i * DT * 1000, DT, BASE, 1);
    for (const s of babies.stars) {
      maxD = Math.max(maxD, Math.hypot(s.x - BASE.x, s.y - BASE.y));
    }
  }
  assert.ok(maxD > NEST_RADIUS * 2, `exploration should range out, max was ${maxD}px`);
});

test('a loud song recalls the explorer to the base', () => {
  const babies = new BabyStars(4);
  // Let one get out...
  let out = null;
  for (let i = 0; i < 10 * 120 && !out; i++) {
    babies.update(i * DT * 1000, DT, BASE, 1);
    out = babies.stars.find((s) => s.state === 'explore') || null;
  }
  assert.ok(out, 'need an explorer for this test');
  // ...then the song gets loud: calm crashes to 0.
  run(babies, 3, 0, BASE);
  for (const s of babies.stars) {
    const d = Math.hypot(s.x - BASE.x, s.y - BASE.y);
    assert.ok(s.state === 'nest' || s.state === 'return');
    assert.ok(d < NEST_RADIUS * 3, `should be home or nearly home, was ${d}px out`);
  }
});

test('the new context (epic/pulse/interests/pointer) is accepted and the secure base stays one-at-a-time', () => {
  const babies = new BabyStars(6);
  const pointer = { x: BASE.x + 120, y: BASE.y - 40, active: true };
  const interests = [{ x: BASE.x + 200, y: BASE.y }, { x: BASE.x - 150, y: BASE.y + 60 }];
  for (let i = 0; i < 12 * 120; i++) {
    babies.update(i * DT * 1000, DT, BASE, 0.9, { epic: 0.6, pulse: 1.4, interests, pointer });
    const out = babies.stars.filter((s) => s.state !== 'nest').length;
    assert.ok(out <= 1, `secure base is still one venture at a time with POIs, saw ${out}`);
  }
  assert.ok(babies.trail.active.length > 0, 'movement leaves a stardust trail (mains-level intensity)');
});

test('the nest follows a moving base', () => {
  const babies = new BabyStars(5);
  run(babies, 1, 0.2);
  const moved = { x: BASE.x + 300, y: BASE.y - 80 };
  run(babies, 2, 0.2, moved);
  for (const s of babies.stars) {
    const d = Math.hypot(s.x - moved.x, s.y - moved.y);
    assert.ok(d < NEST_RADIUS * 2.5, `baby left behind at ${d}px from the new base`);
  }
});
