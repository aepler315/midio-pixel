import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameCadence } from '../src/render/FrameCadence.js';

for (const target of [30, 60]) for (const hz of [60, 90, 120, 144, 165, 240, 20]) {
  test(`${target} FPS at ${hz} Hz preserves phase for ten seconds`, () => {
    const cadence = new FrameCadence();
    let count = 0;
    for (let i = 0; i < hz * 10; i++) {
      const now = i * 1000 / hz;
      if (cadence.shouldDraw(now, target)) count++;
      assert.equal(cadence.shouldDraw(now, target), false, 'never draw twice in a callback');
    }
    assert.ok(Math.abs(count - Math.min(hz, target) * 10) <= 1, `${count} delivered frames`);
  });
}
test('deterministic callback jitter retains remainder without exceeding one draw per callback', () => {
  const cadence = new FrameCadence();
  let count = 0;
  for (let i = 0; i < 1440; i++) {
    const now = i * 1000 / 144 + [0, 1.1, -.8, .3][i % 4];
    count += Number(cadence.shouldDraw(now, 60));
  }
  assert.ok(Math.abs(count - 600) <= 1, `${count} frames`);
});
test('gaps and stalls skip missed deadlines without catch-up bursts', () => {
  const cadence = new FrameCadence();
  assert.equal(cadence.shouldDraw(0, 60), true);
  assert.equal(cadence.shouldDraw(10000, 60), true);
  assert.equal(cadence.shouldDraw(10001, 60), false);
  assert.equal(cadence.shouldDraw(10016.667, 60), true);
  assert.equal(cadence.shouldDraw(10200, 60), true);
  assert.equal(cadence.shouldDraw(10201, 60), false);
});
test('pause/resume resets and cap changes start a new phase; title and playback remain independent', () => {
  const title = new FrameCadence(), playback = new FrameCadence();
  assert.equal(title.shouldDraw(1000, 30), true);
  assert.equal(playback.shouldDraw(1001, 60), true);
  assert.equal(title.shouldDraw(1001, 30), false);
  playback.reset();
  assert.equal(playback.shouldDraw(1002, 60), true);
  assert.equal(playback.shouldDraw(1003, 30), true);
  assert.equal(playback.shouldDraw(1004, 30), false);
  assert.equal(playback.shouldDraw(1036.334, 30), true);
  assert.equal(playback.shouldDraw(1037, 60), true);
  assert.equal(playback.shouldDraw(1038, 60), false);
  title.reset();
  assert.equal(title.shouldDraw(1038, 60), true);
});
