// Planets + astral artifacts: seeded determinism and sane bounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planetsFor, buildArtifactSchedule, SkyEnsemble } from '../src/world/SkyEnsemble.js';

test('planetsFor is deterministic per (song, biome) and bounded to the free sky', () => {
  const a = planetsFor(1234, 'DUSK');
  const b = planetsFor(1234, 'DUSK');
  assert.deepEqual(a, b, 'same song + biome -> the same sky');
  const other = planetsFor(1234, 'ARCTIC');
  assert.notDeepEqual(a, other, 'a different biome hangs different planets');

  for (const seed of [1, 99, 421337]) {
    for (const biome of ['DUSK', 'ARCTIC', 'EMBER', 'CUSTOM:X']) {
      const planets = planetsFor(seed, biome);
      assert.ok(planets.length >= 1 && planets.length <= 3);
      for (const p of planets) {
        assert.ok(p.xFrac >= 0.05 && p.xFrac <= 0.61, `clear of the celestial's corner, got ${p.xFrac}`);
        assert.ok(p.yFrac >= 0.05 && p.yFrac <= 0.29, 'upper sky only');
        assert.ok(p.r >= 9 && p.r <= 26);
      }
    }
  }
});

test('the artifact schedule is deterministic, non-overlapping, and paced like a rarity', () => {
  const durationMs = 4 * 60 * 1000;
  const a = buildArtifactSchedule(777, durationMs);
  const b = buildArtifactSchedule(777, durationMs);
  assert.deepEqual(a, b);
  assert.ok(a.length >= 4 && a.length <= 12, `a handful across 4 minutes, got ${a.length}`);
  for (let i = 0; i < a.length; i++) {
    assert.ok(a[i].durMs >= 4000 && a[i].durMs <= 9000);
    if (i > 0) {
      const gap = a[i].startMs - (a[i - 1].startMs + a[i - 1].durMs);
      assert.ok(gap > 10000, `artifacts stay rare -- gap ${gap} between ${i - 1} and ${i}`);
    }
  }
  assert.ok(a[0].startMs >= 14000, 'the world introduces itself before the first artifact');
});

test('activeArtifact tracks the schedule with a monotonic cursor', () => {
  const se = new SkyEnsemble(42, 3 * 60 * 1000);
  const first = se.schedule[0];
  assert.equal(se.activeArtifact(first.startMs - 1), null);
  const live = se.activeArtifact(first.startMs + 10);
  assert.equal(live, first);
  assert.equal(se.activeArtifact(first.startMs + first.durMs + 1), null, 'in the gap: nothing plays');
  // After it passes, the cursor has moved on and the next window works.
  const second = se.schedule[1];
  if (second) {
    assert.equal(se.activeArtifact(second.startMs + 10), second);
  }
});

test('a backward clock jump rewinds the artifact cursor instead of killing the schedule', () => {
  const se = new SkyEnsemble(42, 3 * 60 * 1000);
  const [first, second] = se.schedule;
  assert.ok(first && second, 'need at least two scheduled artifacts');
  assert.equal(se.activeArtifact(second.startMs + 10), second, 'advance to the second window');
  assert.equal(se.activeArtifact(first.startMs + 10), first, 'a seek back replays the first window');
});
