import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrioWander, TrioGaze, Look, MIDIO_MIN, MIDIO_MAX } from '../src/sim/TrioWander.js';

const W = 1280, H = 720;
const snap = (p) => JSON.stringify({ m: p.midio, b: p.broshi, f: p.midasus });

test('the plan is a pure function of seed and time, whatever order it is asked in', () => {
  const a = new TrioWander(315, { stageW: W, stageH: H });
  const b = new TrioWander(315, { stageW: W, stageH: H });
  const times = [0, 1234.5, 98765, 40000, 40000.25, 7, 250000, 3333];
  const forward = times.map(t => snap(a.update(t)));
  const backward = [...times].reverse().map(t => snap(b.update(t))).reverse();
  assert.deepEqual(forward, backward);
  const other = new TrioWander(316, { stageW: W, stageH: H });
  assert.notEqual(snap(other.update(40000)), forward[3], 'another song wanders its own way');
});

test('update writes the same plan objects in place', () => {
  const p = new TrioWander(9, { stageW: W, stageH: H });
  const { midio, broshi, midasus } = p.update(0);
  for (let t = 0; t < 30000; t += 1000 / 120) {
    const r = p.update(t);
    assert.ok(r.midio === midio && r.broshi === broshi && r.midasus === midasus);
  }
});

test('every curious intent turns up, with idle stretches between strolls', () => {
  const p = new TrioWander(42, { stageW: W, stageH: H });
  const seen = [new Set(), new Set(), new Set()];
  let still = 0, longestStill = 0, prev = null, facings = new Set();
  for (let t = 0; t < 10 * 60000; t += 50) {
    p.update(t);
    seen[0].add(p.midio.intent); seen[1].add(p.broshi.intent); seen[2].add(p.midasus.intent);
    facings.add(p.broshi.facing);
    if (prev != null && Math.abs(p.midio.x - prev) < .05) { still += 50; longestStill = Math.max(longestStill, still); } else still = 0;
    prev = p.midio.x;
  }
  assert.deepEqual([...seen[0]].sort(), ['investigate', 'pause', 'skyGaze', 'wander', 'watchBroshi', 'watchMidasus']);
  assert.deepEqual([...seen[1]].sort(), ['investigate', 'skyGaze', 'sniff', 'wander', 'watchMidasus', 'watchMidio']);
  assert.deepEqual([...seen[2]].sort(), ['drift', 'hover', 'stargaze', 'visitBroshi', 'visitMidio', 'watchMidio']);
  assert.ok(longestStill >= 2000, `Midio pauses to idle (${longestStill} ms)`);
  assert.deepEqual([...facings].sort(), [-1, 1], 'Broshi turns both ways');
});

test('they turn toward what they are watching', () => {
  const p = new TrioWander(7, { stageW: W, stageH: H });
  const gaze = new TrioGaze();
  let broshiChecks = 0, midioChecks = 0, skyChecks = 0;
  for (let t = 0; t < 5 * 60000; t += 50) {
    p.update(t);
    const m = p.midio, b = p.broshi;
    if (b.lookAt === Look.MIDIO && b.intent === 'watchMidio' && b.lookW > .5 && Math.abs(m.x - b.x) > 20) {
      assert.equal(b.facing, Math.sign(m.x - b.x), `Broshi faces Midio at ${t}`);
      broshiChecks++;
    }
    if (b.lookAt === Look.SKY && b.lookW > .9) assert.ok(b.look > .8, 'head up at the sky');
    gaze.aim(p, t, m.x, 560, { x: b.x, y: 600 }, { x: p.midasus.x, y: p.midasus.y });
    if (m.look === Look.BROSHI && m.lookW > .9 && Math.abs(b.x - m.x) > 60) {
      assert.equal(Math.sign(gaze.dirX), Math.sign(b.x - m.x), `Midio's eye goes to Broshi at ${t}`);
      assert.equal(Math.sign(m.leanDeg), Math.sign(b.x - m.x), 'and he tilts toward him');
      midioChecks++;
    }
    if (m.look === Look.SKY && m.lookW > .9) { assert.ok(gaze.dirY < -.8 && gaze.openness > 1.1, 'wide eyes up at the sky'); skyChecks++; }
    const iris = gaze.irisOffset(10);
    assert.ok(Math.hypot(iris.x, iris.y) <= 8 + 1e-9);
  }
  assert.ok(broshiChecks > 20 && midioChecks > 20 && skyChecks > 20, JSON.stringify({ broshiChecks, midioChecks, skyChecks }));
});

test('plans stay on stage for any seed, and survive a broken energy curve', () => {
  const curves = [null, { globalEnergyNorm: () => NaN }, { globalEnergyNorm: () => { throw new Error('x'); } },
    { globalEnergyNorm: t => (Math.sin(t / 3000) + 1) / 2 }];
  for (let seed = 1; seed <= 12; seed++) {
    const p = new TrioWander(seed * 7919, { stageW: W, stageH: H, energyCurves: curves[seed % curves.length] });
    let prevM = null;
    for (let t = 0; t < 4 * 60000; t += 100) {
      p.update(t);
      const { midio: m, broshi: b, midasus: f } = p;
      assert.ok([m.x, m.vx, m.leanDeg, b.x, b.look, f.x, f.y, f.tilt].every(Number.isFinite), `finite at ${t}`);
      assert.ok(m.x >= W * MIDIO_MIN && m.x <= W * MIDIO_MAX, `Midio window ${m.x}`);
      assert.ok(b.x >= W * .08 - 20 && b.x <= W * .92 + 20, `Broshi ${b.x}`);
      assert.ok(f.y >= H * .08 && f.y <= H * .52 && f.x >= W * .06 && f.x <= W * .94, `Midasus ${f.x},${f.y}`);
      assert.ok(Math.abs(m.leanDeg) <= 12);
      if (prevM != null) assert.ok(Math.abs(m.x - prevM) < 40, 'no teleports between 100 ms samples');
      prevM = m.x;
    }
  }
});

test('quiet passages idle more: stays chain, and Midio spends real time watching his friends and the sky', () => {
  const share = (energy) => {
    const stay = [0, 0, 0], looking = [0, 0, 0];
    let n = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const p = new TrioWander(seed * 131, { stageW: W, stageH: H, energyCurves: { globalEnergyNorm: () => energy } });
      for (let t = 0; t < 4 * 60000; t += 100) {
        p.update(t); n++;
        p._segs.forEach((seg, c) => {
          if (!seg.row.move) stay[c]++;
          if ([Look.BROSHI, Look.MIDASUS, Look.SKY, Look.MIDIO].includes(seg.row.look)) looking[c]++;
        });
      }
    }
    return { stay: stay.map(s => s / n), looking: looking.map(s => s / n) };
  };
  const quiet = share(0), loud = share(1);
  for (let c = 0; c < 3; c++) {
    assert.ok(quiet.stay[c] > loud.stay[c] + .15, `character ${c} idles more in quiet (${JSON.stringify({ quiet, loud })})`);
  }
  assert.ok(quiet.stay[0] > .5, `Midio mostly idles in a quiet passage (${quiet.stay[0]})`);
  for (const s of [quiet, loud]) assert.ok(s.looking[0] >= .3, `Midio watches Broshi, Midasus or the sky (${s.looking[0]})`);
});

test('Broshi\'s side of Midio is part of the plan: his own side when clear of Midio, never zero', () => {
  for (const seed of [1, 7, 99, 315, 1234]) {
    const p = new TrioWander(seed, { stageW: W, stageH: H });
    const sides = new Set();
    let flips = 0, prev = null;
    for (let t = 0; t < 3 * 60000; t += 50) {
      const { midio: m, broshi: b } = p.update(t);
      assert.ok(b.side === 1 || b.side === -1, `side ${b.side}`);
      if (Math.abs(b.x - m.x) >= 165) assert.equal(b.side, Math.sign(b.x - m.x));
      if (prev != null && prev !== b.side) flips++;
      prev = b.side; sides.add(b.side);
    }
    assert.equal(sides.size, 2, 'he spends time on both sides of Midio');
    assert.ok(flips < 3 * 60 / 2, `the side changes as he crosses, not every beat (${flips})`);
  }
});

test('Midasus\'s plan does not linger over Midio, whatever the seed', () => {
  for (const seed of [1, 42, 315, 1234, 4242, 77777]) {
    const p = new TrioWander(seed, { stageW: W, stageH: H });
    let run = 0, longest = 0;
    for (let t = 0; t < 3 * 60000; t += 50) {
      const { midio: m, midasus: f } = p.update(t);
      if (Math.abs(f.x - m.x) < 90) { run += 50; longest = Math.max(longest, run); } else run = 0;
    }
    assert.ok(longest < 1500, `seed ${seed}: over Midio for ${longest} ms`);
  }
});
