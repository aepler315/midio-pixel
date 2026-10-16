import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scatterSlot, visibleScatter, scatterPath,
  scatterBiomeLayers,
  SCATTER_RATIO, SCATTER_SPACING_PX, SCATTER_KINDS,
} from '../src/world/GroundScatter.js';
import { NEARFIELD_RATIO } from '../src/world/NearField.js';

const BASE = {
  worldX: 0, canvasW: 1280, baselineY: 600, bandH: 70, songSeed: 'seed',
};

test('the scatter layer outruns every other layer -- that is the speed cue', () => {
  // Characters scroll at 1.0, NearField's occluders at NEARFIELD_RATIO. This
  // band is nearer than both, so it must be faster than both or the depth
  // ordering reads backwards.
  assert.ok(SCATTER_RATIO > NEARFIELD_RATIO,
    `scatter (${SCATTER_RATIO}) must outrun near-field (${NEARFIELD_RATIO})`);
  assert.ok(NEARFIELD_RATIO > 1, 'near-field already outruns the characters');
});

test('biome vocabulary blends through midpoint without replacing props in place', () => {
  assert.deepEqual(scatterBiomeLayers('RAINFOREST', 'DESERT', .49).map(x => x.alpha), [.51, .49]);
  assert.deepEqual(scatterBiomeLayers('RAINFOREST', 'DESERT', .51).map(x => x.alpha), [.49, .51]);
});

test('slots are deterministic per seed, and different seeds lay different ground', () => {
  for (let i = -3; i < 12; i++) {
    assert.deepEqual(scatterSlot('seed', i), scatterSlot('seed', i));
  }
  const a = [];
  const b = [];
  for (let i = 0; i < 40; i++) { a.push(scatterSlot('seed-a', i)); b.push(scatterSlot('seed-b', i)); }
  assert.notDeepEqual(a, b, 'a different song should scatter different ground');
});

test('a slot is either a well-formed prop or empty -- never malformed', () => {
  let filled = 0;
  for (let i = 0; i < 400; i++) {
    const s = scatterSlot('seed', i);
    if (!s) continue;
    filled++;
    assert.ok(SCATTER_KINDS.includes(s.kind), `unknown kind ${s.kind}`);
    assert.ok(s.sizePx > 0 && s.sizePx < 40, `grit stays small, got ${s.sizePx}`);
    assert.ok(s.depth01 >= 0 && s.depth01 <= 1);
    assert.ok(Math.abs(s.xOff) <= SCATTER_SPACING_PX, 'jitter stays inside its own slot');
  }
  // Dense enough to read as texture rather than as scattered objects.
  assert.ok(filled > 250, `expected a dense band, only ${filled}/400 slots filled`);
});

test('the band is populated across the whole screen, not clumped', () => {
  const props = visibleScatter(BASE);
  assert.ok(props.length > 8, `expected a populated band, got ${props.length}`);
  // Every sixth of the screen should carry something.
  for (let k = 0; k < 6; k++) {
    const lo = (BASE.canvasW / 6) * k, hi = (BASE.canvasW / 6) * (k + 1);
    assert.ok(props.some((p) => p.x >= lo && p.x < hi),
      `no scatter in screen sixth ${k} -- the band should be continuous`);
  }
});

test('props stay inside the band, below the terrain surface', () => {
  for (const worldX of [0, 137, 4021, -880]) {
    for (const p of visibleScatter({ ...BASE, worldX })) {
      // Never above the band's top edge...
      assert.ok(p.y > BASE.baselineY - BASE.bandH - 12,
        `prop rode up out of the band at y=${p.y}`);
      // ...and never below its floor. Scenery under Midio's feet, never in
      // front of him on the play line.
      assert.ok(p.y <= BASE.baselineY + 1, `prop sank past the baseline at y=${p.y}`);
    }
  }
});

test('nearer props sit lower and are drawn last, so overlap reads correctly', () => {
  const props = visibleScatter(BASE);
  for (let i = 1; i < props.length; i++) {
    assert.ok(props[i].depth01 >= props[i - 1].depth01,
      'props must be ordered far-to-near so near ones paint on top');
  }
  const near = props.filter((p) => p.depth01 > 0.75);
  const far = props.filter((p) => p.depth01 < 0.25);
  if (near.length && far.length) {
    const avg = (l) => l.reduce((s, p) => s + p.y, 0) / l.length;
    assert.ok(avg(near) > avg(far),
      'ground closer to the camera must project lower in frame');
  }
});

test('the band actually scrolls, and faster than the world does', () => {
  const at = (worldX) => visibleScatter({ ...BASE, worldX });
  const a = at(0);
  const b = at(100);
  assert.ok(a.length && b.length);
  // Track one identifiable slot across the two frames by matching its spec.
  const key = (p) => `${p.kind}:${p.sizePx.toFixed(4)}:${p.depth01.toFixed(4)}`;
  const bByKey = new Map(b.map((p) => [key(p), p]));
  let moved = 0, checked = 0;
  for (const p of a) {
    const q = bByKey.get(key(p));
    if (!q) continue;
    checked++;
    moved += (p.x - q.x);
  }
  assert.ok(checked > 0, 'expected to track props across frames');
  const avgShift = moved / checked;
  assert.ok(avgShift > 100, `scatter must outrun the world's 100px, moved ${avgShift.toFixed(1)}`);
});

test('a kick lifts the band, and lifts the front row hardest', () => {
  const rest = visibleScatter({ ...BASE, kick: 0 });
  const hit = visibleScatter({ ...BASE, kick: 1 });
  const key = (p) => `${p.kind}:${p.sizePx.toFixed(4)}:${p.depth01.toFixed(4)}`;
  const hitByKey = new Map(hit.map((p) => [key(p), p]));
  let sawNear = false, sawFar = false, nearLift = 0, farLift = 0;
  for (const p of rest) {
    const q = hitByKey.get(key(p));
    if (!q) continue;
    const lift = p.y - q.y; // smaller y == lifted
    assert.ok(lift >= 0, 'a kick must never push the ground down');
    if (p.depth01 > 0.8) { sawNear = true; nearLift = Math.max(nearLift, lift); }
    if (p.depth01 < 0.2) { sawFar = true; farLift = Math.max(farLift, lift); }
  }
  if (sawNear && sawFar) {
    assert.ok(nearLift > farLift, 'the nearest row should answer the beat hardest');
  }
});

test('degenerate geometry yields nothing rather than throwing', () => {
  assert.deepEqual(visibleScatter({ ...BASE, canvasW: 0 }), []);
  assert.deepEqual(visibleScatter({ ...BASE, bandH: 0 }), []);
});

test('deep long-travel parallax retains both near and far slots in view', () => {
  for (const worldX of [10_000, 100_000, 1_000_000]) {
    const props = visibleScatter({ ...BASE, worldX, biomeKey: 'RAINFOREST' });
    assert.ok(props.length > 20, `lost ground cover at ${worldX}`);
    assert.ok(props.some(p => p.depth01 < .25));
    assert.ok(props.some(p => p.depth01 > .75));
    assert.ok(props.every(p => p.kind !== 'splinter'), 'wet forest should not scatter bare sticks');
  }
});

test('every kind produces a closed, non-degenerate silhouette', () => {
  for (const kind of SCATTER_KINDS) {
    const pts = scatterPath(kind, 12);
    assert.ok(pts.length >= 3, `${kind} needs a real polygon`);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    assert.ok(Math.max(...xs) - Math.min(...xs) > 1, `${kind} has no width`);
    assert.ok(Math.max(...ys) - Math.min(...ys) > 1, `${kind} has no height`);
    // Props sit ON the baseline: nothing pokes below its own root.
    assert.ok(Math.max(...ys) <= 0.001, `${kind} should grow upward from its root`);
  }
  // An unknown kind still returns a usable shape rather than undefined.
  assert.ok(scatterPath('nonsense', 10).length >= 3);
});
