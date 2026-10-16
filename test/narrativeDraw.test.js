import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withNarrativeAlpha, narrativeMarks, composedNarrativeEdge } from '../src/render/NarrativeDraw.js';

test('cast alpha survives absolute assignments, nested saves and applies once', () => {
  const stack = [], pixels = [];
  const ctx = { globalAlpha: 1,
    save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
    fill() { pixels.push(this.globalAlpha); } };
  withNarrativeAlpha(ctx, .5, c => {
    c.globalAlpha = .8; c.fill(); c.save(); c.globalAlpha *= .5; c.fill(); c.restore(); c.fill();
  });
  assert.deepEqual(pixels, [.4, .2, .4]);
  assert.equal(ctx.globalAlpha, 1);
  withNarrativeAlpha(ctx, 0, c => c.fill());
  assert.equal(pixels.length, 3, 'absent characters never execute a draw');
});

test('indexed marks are source linked, bounded and disappear entirely at arrival', () => {
  const n = { revelation: .5, traceResolution: .2, shortClip: false,
    handoff: { midio: .5, broshi: .3, midasus: .6 },
    sources: { midio: { activity: .8 }, broshi: { activity: .6 }, midasus: { activity: .7 } } };
  const marks = narrativeMarks(n, 12345, 1280, 720, 42);
  assert.deepEqual(narrativeMarks(n, 12345, 1280, 720, 42), marks);
  assert.ok(marks.length <= 15);
  assert.ok(marks.some(m => m.owner === 'midio' && m.alpha > 0));
  assert.deepEqual(narrativeMarks({ ...n, revelation: 1, traceResolution: 1 }, 12345, 1280, 720, 42), []);
  assert.deepEqual(narrativeMarks({ ...n, shortClip: true }, 12345, 1280, 720, 42), []);
});

test('narrative pressure and film vignette combine below .40 without cancelling darkening', () => {
  assert.equal(composedNarrativeEdge(.32, .3), .4);
  assert.equal(composedNarrativeEdge(.24, 0), .24);
  assert.ok(Math.abs(composedNarrativeEdge(0, .2) - .2) < 1e-12);
});
