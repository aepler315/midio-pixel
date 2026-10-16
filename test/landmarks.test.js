import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandLSystem, turtleSegments, LANDMARKS } from '../src/world/Landmarks.js';
import { BIOMES } from '../src/world/BiomeProfiles.js';

test('expandLSystem reproduces Lindenmayer\'s original algae sequence', () => {
  const rules = { A: 'AB', B: 'A' };
  assert.equal(expandLSystem('A', rules, 1), 'AB');
  assert.equal(expandLSystem('A', rules, 2), 'ABA');
  assert.equal(expandLSystem('A', rules, 3), 'ABAAB');
  assert.equal(expandLSystem('A', rules, 4), 'ABAABABA');
});

test('expandLSystem passes constants through untouched', () => {
  assert.equal(expandLSystem('F+[X]', { X: 'FX' }, 2), 'F+[FFX]');
});

test('turtleSegments: F+F at 90 degrees produces two perpendicular segments', () => {
  const segs = turtleSegments('F+F', { stepLen: 10, angleDeg: 90, startAngleDeg: 0 });
  assert.equal(segs.length, 2);
  const d1 = { x: segs[0].x2 - segs[0].x1, y: segs[0].y2 - segs[0].y1 };
  const d2 = { x: segs[1].x2 - segs[1].x1, y: segs[1].y2 - segs[1].y1 };
  assert.ok(Math.abs(d1.x * d2.x + d1.y * d2.y) < 1e-9, 'dot product must vanish');
});

test('turtleSegments: brackets save and restore position, heading, and depth', () => {
  const segs = turtleSegments('F[+F]F', { stepLen: 10, angleDeg: 45, startAngleDeg: -90 });
  assert.equal(segs.length, 3);
  // Segment 3 must continue from segment 1's endpoint with the original heading.
  assert.ok(Math.abs(segs[2].x1 - segs[0].x2) < 1e-9);
  assert.ok(Math.abs(segs[2].y1 - segs[0].y2) < 1e-9);
  assert.ok(Math.abs((segs[2].y2 - segs[2].y1) - (segs[0].y2 - segs[0].y1)) < 1e-9);
  assert.equal(segs[0].depth, 0);
  assert.equal(segs[1].depth, 1);
  assert.equal(segs[2].depth, 0);
});

test('the bracketed tree grammar produces a finite, sane segment cloud', () => {
  const program = expandLSystem('X', { X: 'F-[[X]+X]+F[+FX]-X', F: 'FF' }, 4);
  const segs = turtleSegments(program, { stepLen: 2.4, angleDeg: 22.5, startX: 0, startY: 0 });
  assert.ok(segs.length > 200, `expected a rich tree, got ${segs.length} segments`);
  for (const s of segs) {
    assert.ok(Number.isFinite(s.x1 + s.y1 + s.x2 + s.y2));
    assert.ok(Math.abs(s.x2) < 500 && Math.abs(s.y2) < 500, 'tree must stay in a sane extent');
  }
});

test('every biome has a landmark painter set', () => {
  for (const b of BIOMES) {
    assert.ok(Array.isArray(LANDMARKS[b.name]) && LANDMARKS[b.name].length > 0, `missing landmarks for ${b.name}`);
  }
});

test('real rainforest and broadleaf stands paint filled crowns, never bare branching lines', () => {
  for (const biome of ['RAINFOREST', 'BROADLEAF']) {
    for (const painter of LANDMARKS[biome]) {
      const calls = { fill: 0, stroke: 0, ellipse: 0 };
      const ctx = { beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
        fillRect() { calls.fill++; }, fill() { calls.fill++; },
        stroke() { calls.stroke++; }, ellipse() { calls.ellipse++; } };
      painter(ctx, 100, 100, 1, () => .45, '#234');
      assert.ok(calls.fill > 0, `${biome} should contain filled canopy`);
      assert.equal(calls.stroke, 0, `${biome} should not select the bare tree painter`);
      if (biome === 'BROADLEAF') assert.ok(calls.ellipse > 0);
    }
  }
});
