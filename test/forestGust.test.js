import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VisualMusicHistory } from '../src/world/VisualMusicHistory.js';
import { Role } from '../src/core/NoteEvent.js';
import { rangeMusicState, rangeSectionMotif, gustFrontsAt } from '../src/world/alpine/RangeFrame.js';
import { GUST_FRONTS, GUST_FRONT_SPACING_MS, GUST_SWEEP_SEC, GUST_IDLE_SEC } from '../src/world/alpine/Gust.js';
import { TREE_COMMON } from '../src/world/alpine/ForestGL.js';

test('a kick starts a front only once the last front is far enough away', () => {
  const kick = (tMs, vel = 1) => ({ role: Role.RHYTHM, tMs, kick: true, vel });
  const h = new VisualMusicHistory([kick(1000), { role: Role.RHYTHM, tMs: 1100, kick: false, vel: 1 },
    kick(1100), kick(1200), kick(1400, 0), kick(1800), kick(2100)]);
  assert.deepEqual(h.kickFronts(900, 6, 300), []);
  // 1100 and 1200 ride the 1000 front; 1400 starts one; so do 1800 and 2100.
  assert.deepEqual(h.kickFronts(2200, 6, 300).map(f => f.tMs), [2100, 1800, 1400, 1000]);
  assert.deepEqual(h.kickFronts(2200, 2, 300).map(f => f.tMs), [2100, 1800], 'newest first, up to the slots');
  assert.equal(h.kickFronts(1500, 6, 300)[0].amp, .4);
  assert.deepEqual(h.kickFronts(1500, 6, 300).map(f => f.tMs), h.kickFronts(1500, 6, 300).map(f => f.tMs),
    'the same instant reconstructs the same fronts');
});

test('a fast run of kicks never drops a front still crossing the frame', () => {
  const kicks = Array.from({ length: 40 }, (_, i) => ({ role: Role.RHYTHM, tMs: 1000 + i * 120, kick: true, vel: 1 }));
  const h = new VisualMusicHistory(kicks);
  for (let t = 1000; t < 6000; t += 37) {
    const fronts = h.kickFronts(t, GUST_FRONTS, GUST_FRONT_SPACING_MS);
    const oldest = fronts[fronts.length - 1];
    const all = h.kickFronts(t, 1e9, GUST_FRONT_SPACING_MS);
    const dropped = all[fronts.length];
    if (dropped) assert.ok(t - dropped.tMs > (GUST_SWEEP_SEC + 1) * 1000, `a front ${t - dropped.tMs} ms old was let go mid-flight`);
    assert.ok(!oldest || t - oldest.tMs >= 0);
  }
});

test('each front carries its age and strength in heard time', () => {
  const m = rangeMusicState({ env: { kickMul: 1 }, activity01: 1,
    gustFronts: [{ ageMs: 250, amp: 1, dir: -1 }, { ageMs: 750, amp: .5, dir: 1 }] });
  assert.equal(m.gusts.length, GUST_FRONTS);
  assert.deepEqual(m.gusts.slice(0, 2), [{ ageSec: .25, amp01: 1, dir: -1 }, { ageSec: .75, amp01: .5, dir: 1 }]);
  assert.ok(m.gusts.slice(2).every(g => g.ageSec === GUST_IDLE_SEC && g.amp01 === 0), 'empty slots are idle');
  assert.ok(rangeMusicState({}).gusts.every(g => g.amp01 === 0), 'no kick, no front in flight');
});

test('reduced motion stills the gusts', () => {
  const m = rangeMusicState({ env: { kickMul: 1 }, activity01: 1, gustFronts: [{ ageMs: 250, amp: 1, dir: 1 }], reducedMotion: true });
  assert.ok(m.gusts.every(g => g.amp01 === 0));
});

test('a front keeps the way its section leaned when its kick landed', () => {
  // For song seed 0, a verse leans one way and a drop the other.
  const lean = (label) => rangeSectionMotif({ label, startMs: 0 }, null, 10000, 0).angle;
  const right = 'verse', left = 'drop';
  assert.ok(lean(right) > 0 && lean(left) < 0);
  const mgr = { sections: [{ label: right, startMs: 0 }, { label: left, startMs: 10000 }],
    _gustFronts: [{ tMs: 14200, amp: 1 }, { tMs: 9800, amp: 1 }] };
  const fronts = gustFrontsAt(mgr, 14300, 0);
  assert.deepEqual(fronts.map(f => f.ageMs), [100, 4500]);
  assert.deepEqual(fronts.map(f => f.dir), [-1, 1], 'each front crosses the way the motif leaned at its kick');
  mgr._gustFronts = [{ tMs: 10200, amp: 1 }];
  assert.deepEqual([10300, 12000, 14500].map(t => gustFrontsAt(mgr, t, 0)[0].dir), [1, 1, 1],
    'and keeps it while the next section\'s motif eases in');
});

test('the shader\'s gust envelope bends gently, settles slowly, and is silent before the front', () => {
  const body = TREE_COMMON.match(/float gustEnv\(float age, float decay\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(body, 'the forest shader exposes its gust envelope');
  const env = new Function('age', 'decay', body[1].replace(/\bexp\(/g, 'Math.exp('));
  assert.equal(env(-0.01, 2.4), 0);
  assert.equal(env(0, 2.4), 0);
  assert.ok(env(.16, 2.4) < .3, 'a tree takes the gust over most of a second, not one frame');
  assert.equal(env(.7, 2.4), 1);
  assert.ok(Math.abs(env(3.1, 2.4) - Math.exp(-1)) < 1e-9);
  assert.ok(env(3.1, 1) < env(3.1, 2.4), 'the sheen passes faster than the lean');
});

test('a gust rolls across the forest over seconds, one at a time', () => {
  assert.ok(GUST_SWEEP_SEC >= 5, `a front crosses the frame in ${GUST_SWEEP_SEC} s`);
  assert.ok(GUST_FRONT_SPACING_MS >= 2000, 'kicks closer than two seconds ride the same gust');
});
