import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../src/world/WorldRegistry.js';

function render(kind, reducedFlash, level, worldX = 400) {
  const operations = [];
  const gradient = () => ({ addColorStop() {} });
  const ctx = { createLinearGradient: gradient, createRadialGradient: gradient };
  for (const method of ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'ellipse', 'rect', 'fillRect', 'strokeRect', 'fill', 'stroke', 'clip', 'translate', 'scale', 'rotate']) {
    ctx[method] = (...args) => operations.push({ method, args });
  }
  const mgr = { world: { kind }, reducedFlash, _perf: { level, heavyPostFx: level < 5 }, tSec: 18,
    sections: [{ label: 'A', provenance: 'detected' }], _lastSectionIdx: 0, orogenyGrowth: 0.4,
    energyCurves: null, groundY: 570 };
  const frame = { ctx, canvas: { width: 1280, height: 720 }, worldX,
    A: { silhouette: '#18302b', edgeLight: '#dd8844', celestial: { color: '#80c8ef' } }, B: {}, t: 0 };
  registry.WORLD_SIGNATURES?.get(kind)?.(mgr, frame, { energy: 0.6, bass: 0.5, accent: 0.4, reveal: 0.3, group: 1, current: reducedFlash ? 0 : 0.2 });
  return operations;
}

for (const kind of ['overgrowth', 'nave', 'strip', 'foundry']) {
  for (const level of [0, 6]) {
    test(`${kind} retains connected signature geometry at quality ${level} and reduced motion`, () => {
      const ops = render(kind, true, level);
      assert.ok(ops.some(o => o.method === 'fill'), 'signature must actually fill a structure');
      assert.ok(ops.filter(o => o.method === 'lineTo' || o.method === 'bezierCurveTo').length >= 4, 'connected structure must have geometry');
      assert.equal(ops.filter(o => o.method === 'save').length, ops.filter(o => o.method === 'restore').length);
      for (const op of ops) assert.ok(op.args.every(v => typeof v !== 'number' || Number.isFinite(v)));
      if (kind === 'nave') assert.ok(ops.filter(o => o.method === 'arc').length >= 9, 'radial glass panes and central window');
      if (kind === 'strip') assert.ok(ops.filter(o => o.method === 'moveTo').length >= 8, 'lane marks and converging road edges');
    });
  }
}

test('canopy crowns remain continuous across a sector wrap', () => {
  const crowns = x => render('overgrowth', true, 0, x).filter(o => o.method === 'ellipse').map(o => o.args).filter(a => a[0] > 100 && a[0] < 1100).sort((a,b) => a[0]-b[0]);
  const before = crowns(3999.999), after = crowns(4000.001);
  assert.equal(before.length, after.length);
  before.forEach((a,i) => { assert.ok(Math.abs(a[0]-after[i][0]) < 0.01); assert.equal(a[1], after[i][1]); });
});

for (const kind of ['overgrowth', 'nave', 'strip', 'foundry']) {
  test(`${kind} essential geometry does not pop across quality transitions`, () => {
    assert.deepEqual(render(kind, true, 0), render(kind, true, 6));
    assert.deepEqual(render(kind, false, 0), render(kind, false, 6));
  });
}

test('Redline corridor covers the cast travel line', () => {
  const ops = render('strip', true, 0);
  const face = ops.slice(0, ops.findIndex(o => o.method === 'fill'));
  const apex = face.find(o => o.method === 'moveTo').args;
  const edges = face.filter(o => o.method === 'lineTo' && o.args[1] === 720).map(o => o.args[0]);
  const depth = (570 - apex[1]) / (720 - apex[1]);
  const atTravel = edges.map(x => apex[0] + (x - apex[0]) * depth);
  assert.ok(Math.min(...atTravel) < 128, 'left cast position lies on pavement');
  assert.ok(Math.max(...atTravel) > 1152, 'travel line remains on pavement across the scene');
});
