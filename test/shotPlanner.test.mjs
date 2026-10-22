import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShotTour, restoreShotLibrary } from '../src/world/terrain/ShotPlanner.js';
import { cloneableShotLibrary } from '../src/world/terrain/ShotRuntime.js';
import { shotLibraryFixture, anthemSong } from './fixtures/shot-library-fixture.mjs';

const library = shotLibraryFixture(), song = anthemSong();
const libraries = [1, 2, 3, 4].map((seed) => (seed === 1 ? library : shotLibraryFixture({ seed })));
const plan = (options = {}, lib = library) => planShotTour(lib, { ...song, ...options });
const shotsOf = (p) => p.items.filter((it) => it.kind === 'shot');
const shownOf = (p) => shotsOf(p).filter((it) => Number.isFinite(it.payoffMs) && !it.hidden && it.payoffMs > (p.start?.timeMs ?? 0));
const lengthOf = (lib, it) => (it.kind === 'link' ? lib.linkById : lib.shotById).get(it.id).path.s.at(-1);
const STRONG = [16000, 48000, 96000, 128000];
const strongHits = (p) => shownOf(p).filter((it) => it.moment >= 0 && STRONG.includes(Math.round(p.moments[it.moment].timeMs / 100) * 100)).length;

function assertTiles(p, fromMs = 0, lib = library) {
  const { items } = p;
  assert.ok(items.length >= 1);
  assert.equal(items[0].startMs, fromMs);
  assert.equal(items.at(-1).endMs, p.durationMs);
  items.forEach((it, i) => {
    assert.ok(it.sTo > it.sFrom && it.sFrom >= 0 && it.sTo <= lengthOf(lib, it) + 1e-6, `item ${i} progress range`);
    assert.ok(it.endMs >= it.startMs, `item ${i} time order`);
    if (i) assert.equal(it.startMs, items[i - 1].endMs, `no gap before item ${i}`);
    if (it.kind !== 'link') return;
    const link = lib.linkById.get(it.id), before = items[i - 1], after = items[i + 1];
    if (before) { assert.equal(before.kind, 'shot'); assert.equal(link.from, before.id); assert.ok(Math.abs(before.sTo - lengthOf(lib, before)) < 1e-6, 'shot runs to its end'); }
    if (after) { assert.equal(after.kind, 'shot'); assert.equal(link.to, after.id); assert.equal(after.sFrom, 0); }
    if (before && after) assert.ok(it.sFrom === 0 && Math.abs(it.sTo - lengthOf(lib, it)) < 1e-6, 'a whole link between two shots');
  });
}

test('the plan tiles the song: shot, link, shot, ... with links joining their neighbours', () => {
  for (const lib of libraries) {
    const p = plan({}, lib);
    assert.equal(p.fallback, null);
    assertTiles(p, 0, lib);
    assert.equal(p.items[0].kind, 'shot');
    assert.equal(p.items[0].sFrom, 0, 'the song starts at the opening shot\'s entry');
    assert.equal(p.items.at(-1).kind, 'shot');
    assert.ok(shotsOf(p).length >= 3);
  }
});

test('payoffs land on their moments; most strong impacts and the climax get one, mostly on a top hero shot', () => {
  let hits = 0, heroClimax = 0, plans = 0;
  for (const lib of libraries) {
    for (const seed of [0, 1]) {
      const p = plan({ seed }, lib);
      for (const it of shownOf(p)) {
        assert.ok(it.payoffMs >= it.startMs && it.payoffMs <= it.endMs, `${it.id} payoff inside its item`);
        if (it.moment >= 0) assert.ok(Math.abs(it.payoffMs - p.moments[it.moment].timeMs) <= 150, `${it.id} payoff within 150 ms of its moment`);
      }
      const climax = shownOf(p).find((it) => it.moment >= 0 && p.moments[it.moment].climax);
      assert.ok(climax, 'the climax gets a payoff');
      assert.equal(climax.payoffMs, 128000);
      assert.ok(strongHits(p) >= 3, `fixture ${lib.provenance.seed} seed ${seed}: ${strongHits(p)} of 4 strong impacts`);
      const shot = lib.shotById.get(climax.id), subject = lib.subjectById.get(shot.subjectId);
      const rank = lib.shots.filter((s) => s.subjectId === subject.id).sort((a, b) => b.score.total - a.score.total).indexOf(shot);
      hits += strongHits(p); plans++;
      if (subject.hero && rank <= 1) heroClimax++;
    }
  }
  assert.ok(hits / plans >= 3.25, `strong impacts hit on average ${hits / plans}`);
  assert.ok(heroClimax >= .75 * plans, `climax on a top hero shot in ${heroClimax} of ${plans}`);
});

test('the song opens on a calm establishing shot, no subject repeats back to back, headings vary', () => {
  let turns = 0, transitions = 0;
  for (const lib of libraries) {
    const headings = lib.shots.map((s) => s.traits.headingDeg);
    assert.ok(Math.max(...headings) - Math.min(...headings) >= 50, 'the fixture looks in many directions');
    for (const seed of [0, 1, 2, 3]) {
      const shots = shotsOf(plan({ seed }, lib)).map((it) => lib.shotById.get(it.id));
      const first = shots[0];
      assert.ok(['rail', 'traverse', 'orbit', 'pullback'].includes(first.move) || first.traits.aglM >= 750 || first.traits.lens === 'wide', `seed ${seed}: calm opening`);
      for (let i = 1; i < shots.length; i++) {
        assert.notEqual(shots[i].subjectId, shots[i - 1].subjectId, `seed ${seed}: subject repeated`);
        transitions++;
        if (Math.abs(((shots[i].traits.headingDeg - shots[i - 1].traits.headingDeg + 540) % 360) - 180) >= 30) turns++;
      }
    }
  }
  assert.ok(turns > 0 && turns < transitions, `the 30-degree heading rule both passes and fires (${turns} of ${transitions} turn)`);
});

test('the outro bonus goes only to a song ending on a pullback or high shot after a hero climax', () => {
  // The bonus is applied at the song end only, so both searches see the
  // same states: the costs differ exactly by the bonus the winner earned.
  for (const lib of libraries) {
    const p = plan({}, lib), without = plan({ tunables: { weights: { outro: 0 } } }, lib);
    const last = lib.shotById.get(p.items.at(-1).id), climax = shownOf(p).find((it) => it.moment >= 0 && p.moments[it.moment].climax);
    const heroClimax = /climax on a hero shot/.test(p.notes.join());
    const eligible = heroClimax && !!climax && (last.move === 'pullback' || last.traits.aglM >= 750 || last.tags.includes('high'));
    if (eligible) assert.ok(p.cost < without.cost - 1, 'bonus earned');
    else assert.equal(p.cost, without.cost, `no bonus for a ${last.move} ending`);
  }
});

test('planning is deterministic, and different seeds can differ', () => {
  assert.deepEqual(plan({ seed: 5 }), plan({ seed: 5 }));
  const sequences = new Set();
  for (const lib of libraries) for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) sequences.add(plan({ seed }, lib).items.map((it) => it.id).join());
  assert.ok(sequences.size > libraries.length, 'seeds vary the tour');
});

test('payoffs stay inside the visible intervals; off screen the camera only passes through', () => {
  const windows = [
    [[0, 60], [110, 170]], [[0, 20], [60, 80], [140, 170]], [[30, 70]], [[80, 170]], [[40, 52], [90, 100], [125, 131]],
  ];
  for (const lib of libraries.slice(0, 3)) {
    for (const w of windows) {
      const visible = w.map(([a, b]) => ({ startMs: a * 1000, endMs: b * 1000 })), inside = (t) => visible.some((v) => t >= v.startMs && t <= v.endMs);
      const p = plan({ visible }, lib);
      assert.equal(p.fallback, null);
      assertTiles(p, 0, lib);
      for (const it of shotsOf(p)) {
        if (!Number.isFinite(it.payoffMs)) continue;
        assert.equal(it.hidden, !inside(it.payoffMs), `${it.id} at ${it.payoffMs}: hidden exactly when off screen`);
        if (it.hidden) assert.equal(it.moment, -1, 'an off-screen pass is no payoff');
      }
      // Every window of 15 s or more shows a payoff; a late window shows several.
      for (const v of visible) if (v.endMs - v.startMs >= 15000) assert.ok(shownOf(p).some((it) => it.payoffMs >= v.startMs && it.payoffMs <= v.endMs), `${JSON.stringify(w)}: a payoff in ${v.startMs}-${v.endMs}`);
      if (w.length === 1 && w[0][0] === 80) assert.ok(shownOf(p).length >= 2, 'a late window gets several payoffs');
      // A minute or more on screen is never one shot stretched over the song
      // (a short window may be: the rail through it is a legal, cheap tour).
      if (visible.reduce((n, v) => n + v.endMs - v.startMs, 0) >= 60000) assert.ok(shownOf(p).length >= 2, 'not one shot stretched over the song');
    }
  }
  const p = plan({ visible: [{ startMs: 0, endMs: 60000 }, { startMs: 110000, endMs: song.durationMs }] });
  assert.ok(!shownOf(p).some((it) => it.moment >= 0 && Math.abs(p.moments[it.moment].timeMs - 96000) < 1000), 'the off-screen chorus gets no payoff');
  assert.ok(shownOf(p).some((it) => it.payoffMs === 128000), 'the on-screen climax keeps its payoff');
  const dark = plan({ visible: [] });
  assert.equal(dark.fallback, null);
  assertTiles(dark);
  assert.equal(shownOf(dark).length, 0, 'nothing on screen: no payoffs');
});

test('a continuation keeps the committed element and only changes what follows', () => {
  const link = library.links.find((l) => l.path.s.at(-1) > 300 && l.path.s.at(-1) < 1200);
  const start = { timeMs: 30000, itemKind: 'link', id: link.id, s: 120, speedMps: 22, accelMps2: .2 };
  const p = plan({ start });
  assertTiles(p, 30000);
  assert.deepEqual([p.items[0].kind, p.items[0].id, p.items[0].sFrom], ['link', link.id, 120]);
  assert.deepEqual([p.items[1].kind, p.items[1].id, p.items[1].sFrom], ['shot', link.to, 0]);
  assert.ok(p.items.every((it) => it.startMs >= 30000));
  assert.equal(p.start, start);
});

test('with nothing feasible the plan falls back to the rail over the whole song', () => {
  const p = plan({ tunables: { maxSpeedMps: .3, minSpeedMps: .1 } });
  const rail = library.shots.find((s) => s.move === 'rail');
  assert.match(p.fallback, /no feasible/);
  assert.equal(p.items.length, 1);
  assert.deepEqual([p.items[0].id, p.items[0].startMs, p.items[0].endMs, p.items[0].sFrom], [rail.id, 0, song.durationMs, 0]);
  assert.ok(Math.abs(p.items[0].sTo - rail.path.s.at(-1)) < 1e-6);
  assert.equal(plan({ durationMs: 0 }).fallback, 'no duration');
});

test('the library\'s region motion applies unless tunables override it', () => {
  const slow = { ...library, motion: { maxSpeedMps: .3, minSpeedMps: .1 } };
  assert.match(planShotTour(slow, song).fallback, /no feasible/);
  assert.equal(planShotTour(slow, { ...song, tunables: { maxSpeedMps: 120, minSpeedMps: 4 } }).fallback, null);
});

test('an 18-shot library and a 3-minute song plan in under 50 ms', () => {
  plan({ seed: 9 });
  const warm = [], cold = [];
  for (let seed = 10; seed < 15; seed++) {
    let t = performance.now(); plan({ seed }); warm.push(performance.now() - t);
    // The worker plans each request on a fresh copy (no cached index).
    const copy = restoreShotLibrary(structuredClone(cloneableShotLibrary(library)));
    t = performance.now(); plan({ seed }, copy); cold.push(performance.now() - t);
  }
  const stat = (x) => { x.sort((a, b) => a - b); return `min ${x[0].toFixed(1)} median ${x[2].toFixed(1)} max ${x[4].toFixed(1)} ms`; };
  console.log(`planShotTour over ${library.shots.length} shots, ${library.links.length} links, ${song.durationMs / 1000} s: warm ${stat(warm)}; fresh library ${stat(cold)}`);
  // The minimum holds up when other work loads the machine.
  assert.ok(warm[0] < 50 && cold[0] < 50);
});
