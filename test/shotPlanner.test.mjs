import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShotTour, restoreShotLibrary, shotPaceLimits, shotPlanningTables } from '../src/world/terrain/ShotPlanner.js';
import { cloneableShotLibrary, plannableShotLibrary } from '../src/world/terrain/ShotRuntime.js';
import { handleShotMessage } from '../src/world/terrain/shot-worker.js';
import { pathPoseAt } from '../src/world/terrain/ShotPath.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShotTimeline, restoreShotTimeline, shotTimelineData, SHOT_MOTION } from '../src/world/terrain/ShotTimeline.js';
import { readLibrary, motionAudit, partTimes, payoffBound, longestPayoffGap, JOIN_SPIKE_MS } from '../tools/plan-scenic-tour.mjs';
import { shotLibraryFixture, anthemSong, dropSong, shortSong, rangeShotLibraryFixture } from './fixtures/shot-library-fixture.mjs';

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

test('payoffs land on their moments; most strong impacts and the climax get one, on a hero subject (mostly its top shots)', () => {
  let hits = 0, heroClimax = 0, topHeroClimax = 0, plans = 0;
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
      if (subject.hero) heroClimax++;
      if (subject.hero && rank <= 1) topHeroClimax++;
    }
  }
  assert.ok(hits / plans >= 3.25, `strong impacts hit on average ${hits / plans}`);
  assert.ok(heroClimax >= .75 * plans, `climax on a hero subject in ${heroClimax} of ${plans}`);
  // A missed strong impact (missStrong) outweighs the hero's best shot: the
  // climax may take the hero's third-best shot to keep a chorus.
  assert.ok(topHeroClimax >= .5 * plans, `climax on a top hero shot in ${topHeroClimax} of ${plans}`);
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
    // The worker plans each request on a fresh copy of what the runtime
    // posts: no cached index, the library's planning tables.
    const copy = restoreShotLibrary(structuredClone(plannableShotLibrary(library)));
    t = performance.now(); plan({ seed }, copy); cold.push(performance.now() - t);
  }
  const stat = (x) => { x.sort((a, b) => a - b); return `min ${x[0].toFixed(1)} median ${x[2].toFixed(1)} max ${x[4].toFixed(1)} ms`; };
  console.log(`planShotTour over ${library.shots.length} shots, ${library.links.length} links, ${song.durationMs / 1000} s: warm ${stat(warm)}; fresh library ${stat(cold)}`);
  // The minimum holds up when other work loads the machine.
  assert.ok(warm[0] < 50 && cold[0] < 50);
});

test('planning tables change no plan, and tables for other links are ignored', () => {
  const plain = () => restoreShotLibrary(structuredClone(cloneableShotLibrary(library)));
  const posted = () => restoreShotLibrary(structuredClone(plannableShotLibrary(library)));
  const items = (p) => JSON.stringify(p.items), seeds = [3, 21, 40];
  for (const seed of seeds) assert.equal(items(plan({ seed }, posted())), items(plan({ seed }, plain())), `seed ${seed}`);
  const real = rangeShotLibraryFixture({ seed: 2 }), realPlain = restoreShotLibrary(structuredClone(cloneableShotLibrary(real)));
  const realPosted = restoreShotLibrary(structuredClone(plannableShotLibrary(real)));
  assert.equal(items(planShotTour(realPosted, anthemSong())), items(planShotTour(realPlain, anthemSong())));
  // Tables measured on other paths (here: a link's samples changed) are not used.
  const tables = shotPlanningTables(library), stale = { ...tables, samples: Int32Array.from(tables.samples, (n, j) => (j === 0 ? n + 1 : n)) };
  const misled = restoreShotLibrary({ ...cloneableShotLibrary(library), planningTables: { ...stale, linkBend: new Float64Array(tables.linkBend.length) } });
  assert.equal(items(plan({ seed: 3 }, misled)), items(plan({ seed: 3 }, plain())), 'zeroed bends behind a mismatched table are ignored');
});

// ---------------------------------------------------------------------------
// Libraries shaped like the real ones (rangeShotLibraryFixture: 11 shots of
// 0.7-1.7 km sampled every ~29 m, 2-4 links of 0.9-2 km per shot, an isolated
// rail, a hero subject, region motion limits) and the three probe songs. The
// bounds and the drawn-camera audit are the replay tool's
// (tools/plan-scenic-tour.mjs), the arbiter for motion.
const ranges = [1, 2, 3].map((seed) => rangeShotLibraryFixture({ seed }));
const songs = { anthem: anthemSong(), drop: dropSong(), short: shortSong() };
const rangePlans = new Map();
const rangePlan = (lib, name, options = {}) => {
  const key = `${lib.provenance.seed}/${lib.provenance.kinkDeg}/${name}/${JSON.stringify(options)}`;
  if (!rangePlans.has(key)) rangePlans.set(key, planShotTour(lib, { ...songs[name], seed: 0, ...options }));
  return rangePlans.get(key);
};
const subjectOf = (lib, it) => lib.shotById.get(it.id).subjectId;

test('the range fixture is shaped like the real libraries', () => {
  for (const lib of ranges) {
    assert.ok(lib.shots.length >= 5 && lib.shots.length <= 12 && lib.motion?.maxAccelMps2 > 0);
    assert.ok(lib.shots.every((s) => s.lengthM >= 500 && s.lengthM <= 2000), 'shots 0.5-2 km');
    assert.ok(lib.links.every((l) => l.lengthM <= 2000), 'links up to 2 km');
    const out = lib.shots.map((s) => lib.linksFrom.get(s.id).length);
    assert.equal(out.filter((n) => n === 0).length, 1, 'only the rail is isolated');
    assert.ok(out.every((n) => n === 0 || (n >= 2 && n <= 4)), `2-4 links per shot: ${out}`);
    assert.ok(lib.subjects.some((s) => s.hero));
  }
});

test('real-shaped libraries: the climax gets a hero shot, the drops their payoffs, nothing repeats', () => {
  for (const lib of ranges) {
    for (const name of Object.keys(songs)) {
      const p = rangePlan(lib, name), shown = shownOf(p), climax = p.moments.find((m) => m.climax);
      assert.equal(p.fallback, null);
      assertTiles(p, 0, lib);
      const onClimax = shown.find((it) => Math.abs(it.payoffMs - climax.timeMs) <= 150);
      assert.ok(onClimax && lib.subjectById.get(subjectOf(lib, onClimax)).hero, `fixture ${lib.provenance.seed} ${name}: climax on a hero shot`);
      // The drop song's two drops are reachable together: both get their payoff.
      if (name === 'drop') for (const t of songs.drop.downbeatsMs) assert.ok(shown.some((it) => Math.abs(it.payoffMs - t) <= 150), `fixture ${lib.provenance.seed}: drop at ${t}`);
      const shots = p.items.filter((it) => it.kind === 'shot'), moveOf = (it) => lib.shotById.get(it.id).move;
      for (let i = 1; i < shots.length; i++) {
        assert.notEqual(subjectOf(lib, shots[i]), subjectOf(lib, shots[i - 1]), `fixture ${lib.provenance.seed} ${name}: a subject twice in a row`);
        assert.ok(i < 2 || !(moveOf(shots[i]) === moveOf(shots[i - 1]) && moveOf(shots[i]) === moveOf(shots[i - 2])), `fixture ${lib.provenance.seed} ${name}: a move three times in a row`);
      }
    }
  }
});

test('real-shaped libraries: the pace keeps at least half of what the motion limits allow', () => {
  for (const lib of ranges) {
    for (const name of Object.keys(songs)) {
      const p = rangePlan(lib, name), shown = shownOf(p), D = songs[name].durationMs;
      const bound = payoffBound(lib, partTimes(lib, 'motion'), D, { noRepeat: true }).count, library = payoffBound(lib, partTimes(lib, 'library'), D).count;
      assert.ok(bound <= library, 'the motion limits only lower the library bound');
      assert.ok(shown.length >= Math.ceil(bound / 2), `fixture ${lib.provenance.seed} ${name}: ${shown.length} payoffs, motion bound ${bound}`);
      const times = [0, ...shown.map((it) => it.payoffMs), D];
      assert.ok(times.every((t, i) => !i || t - times[i - 1] <= 75000), `fixture ${lib.provenance.seed} ${name}: an on-screen stretch over 75 s without a payoff`);
    }
  }
});

test('real-shaped libraries: the drawn camera keeps speed changes and yaw in the limits, the song end included', () => {
  for (const lib of ranges) {
    const m = { ...SHOT_MOTION, ...lib.motion };
    // Song ends off the 100 ms lattice, as real songs have them.
    for (const [name, options] of [['anthem', { durationMs: 167985 }], ['drop', {}], ['short', { durationMs: 59977 }]]) {
      const audit = motionAudit(buildShotTimeline(lib, rangePlan(lib, name, options)));
      assert.ok(audit.tangentialMps2.max <= m.maxAccelMps2 * 1.05, `fixture ${lib.provenance.seed} ${name}: tangential ${audit.tangentialMps2.max.toFixed(2)} m/s2`);
      assert.ok(audit.yawDegPerSec.max <= m.maxYawDegPerSec, `fixture ${lib.provenance.seed} ${name}: yaw`);
      assert.ok(audit.lastAccel.tangential <= m.maxAccelMps2, `fixture ${lib.provenance.seed} ${name}: last 100 ms ${audit.lastAccel.tangential.toFixed(2)} m/s2`);
    }
  }
});

// A regression guard (these fast fixtures pass it without the closed-window
// gap rule too; the slow-library window test below is the one that needs it).
test('real-shaped libraries under partial visibility: payoffs only on screen, one in every window of 15 s', () => {
  for (const lib of ranges) {
    for (const w of [[[30, 85], [120, 168]], [[0, 40], [90, 120]], [[60, 170]]]) {
      const visible = w.map(([a, b]) => ({ startMs: a * 1000, endMs: b * 1000 })), p = rangePlan(lib, 'anthem', { visible });
      assert.equal(p.fallback, null);
      assertTiles(p, 0, lib);
      for (const it of shotsOf(p)) if (Number.isFinite(it.payoffMs)) assert.equal(it.hidden, !visible.some((v) => it.payoffMs >= v.startMs && it.payoffMs <= v.endMs));
      for (const v of visible) if (v.endMs - v.startMs >= 15000) assert.ok(shownOf(p).some((it) => it.payoffMs >= v.startMs && it.payoffMs <= v.endMs), `${JSON.stringify(w)}: ${v.startMs}-${v.endMs}`);
    }
  }
});

test('a real-shaped library plans in under 50 ms and builds its timeline in under 20 ms', () => {
  const lib = ranges[0], plans = [], builds = [];
  planShotTour(lib, songs.anthem);
  for (let seed = 0; seed < 5; seed++) {
    // The worker plans each request on a fresh copy of what the runtime
    // posts: no cached index, the library's planning tables.
    const copy = restoreShotLibrary(structuredClone(plannableShotLibrary(lib)));
    let t = performance.now();
    const p = planShotTour(copy, { ...songs.anthem, seed });
    plans.push(performance.now() - t);
    t = performance.now(); buildShotTimeline(copy, p); builds.push(performance.now() - t);
  }
  plans.sort((a, b) => a - b); builds.sort((a, b) => a - b);
  console.log(`range fixture, ${songs.anthem.durationMs / 1000} s, fresh library: plan min ${plans[0].toFixed(1)} median ${plans[2].toFixed(1)} ms; timeline min ${builds[0].toFixed(1)} median ${builds[2].toFixed(1)} ms`);
  assert.ok(plans[0] < 50 && builds[0] < 20);
});

// The published library, when this checkout has one (src/assets is written by
// the authoring tools): it plans without a fallback and is drawn in the limits.
const published = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/assets/range/v2/tour/monument-valley-163.shots.json');
test('the published Monument Valley library plans and draws within the motion limits', { skip: !fs.existsSync(published) && 'library not published in this checkout' }, async () => {
  const lib = await readLibrary(published), m = { ...SHOT_MOTION, ...lib.motion };
  for (const name of Object.keys(songs)) {
    const p = planShotTour(lib, songs[name]);
    assert.equal(p.fallback, null);
    assertTiles(p, 0, lib);
    assert.ok(shownOf(p).length >= 1);
    const audit = motionAudit(buildShotTimeline(lib, p));
    assert.ok(audit.tangentialMps2.max <= m.maxAccelMps2 * 1.05, `${name}: tangential ${audit.tangentialMps2.max.toFixed(2)} m/s2`);
    assert.ok(audit.yawDegPerSec.max <= m.maxYawDegPerSec && audit.lastAccel.tangential <= m.maxAccelMps2, `${name}: yaw and song end`);
  }
});

// ---------------------------------------------------------------------------
// Round 2 review: what the planner's limits and choices must hold to.

// The eye as ShotTimeline draws it (smoothPoseAt: pathPoseAt's spline at a
// Hermite-smoothed pace).
function drawnEye(p, x) {
  const s = p.s, n = s.length;
  if (n < 3 || !(x > s[0] && x < s[n - 1])) return pathPoseAt(p, x).eyeM;
  let lo = 0;
  while (lo + 2 < n && s[lo + 1] <= x) lo++;
  const ds = s[lo + 1] - s[lo], before = lo > 0 ? s[lo] - s[lo - 1] : ds, after = lo + 2 < n ? s[lo + 2] - s[lo + 1] : ds;
  const k0 = 2 * ds / (before + ds), k1 = 2 * ds / (ds + after), t = (x - s[lo]) / ds, t2 = t * t, t3 = t2 * t;
  return pathPoseAt(p, s[lo] + ds * ((t3 - 2 * t2 + t) * k0 + 3 * t2 - 2 * t3 + (t3 - t2) * k1)).eyeM;
}

test('the speed cap holds the drawn bend at its largest inside a segment, not at t = 0, 1/2 and 1', () => {
  // Teton's reveal-jackson-lake-107 (manifest 89b3ba94c7ea), samples 12-19
  // relative to sample 12: its segment 15 (here 3) bends 2.9x more at t = 0.77
  // than at its midpoint, so a cap from t = 0, 1/2, 1 let the drawn eye
  // accelerate at 4.8 m/s2 against 3.5.
  const s = [0, 30.3, 60.6, 90.8, 121.1, 151.4, 181.6, 211.9];
  const eye = [0, 0, 0, 25.5, 10.3, -12.5, 52.5, 13.6, -25.6, 79.4, 8.8, -38.7, 104.5, -3.1, -51, 131.6, -2.6, -64.2, 158.7, 0.5, -77.4, 185.8, 0.7, -90.7];
  const n = s.length, p = { s: Float64Array.from(s), eye: Float64Array.from(eye), aim: Float64Array.from(eye, (v, i) => v + [3000, -300, -3000][i % 3]),
    fov: new Float64Array(n).fill(16), flow: new Float64Array(n).fill(1e-4) };
  const L = s.at(-1), lib = restoreShotLibrary({ viewId: 'bend-probe', subjects: [{ id: 'lake', hero: true }], links: [], motion: { maxSpeedMps: 200, flowEnergetic: 1, maxAccelMps2: 3.5 },
    shots: [{ id: 'reveal', subjectId: 'lake', move: 'reveal', lengthM: L, payoffS: L, score: { total: .7 }, traits: {}, tags: [], path: p }] });
  // The drawn bend, |d|E'|/dx|, by finite differences over the whole path.
  const h = .05, g = (x) => { const a = drawnEye(p, x - h), b = drawnEye(p, x + h); return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (2 * h); };
  let bend = 0, at = 0;
  for (let x = 2 * h; x <= L - 2 * h; x += .25) { const d = Math.abs(g(x + h) - g(x - h)) / (2 * h); if (d > bend) { bend = d; at = x; } }
  assert.ok(bend > 3.9e-3 && at > 90.8 + .6 * 30.3 && at < 121.1, `the drawn bend peaks inside segment 3 (${bend.toExponential(3)} at ${at.toFixed(1)} m)`);
  const cap = shotPaceLimits(lib).head[0].capMps;
  assert.ok(cap <= Math.sqrt(3.5 / bend) * 1.01, `cap ${cap.toFixed(1)} m/s against ${Math.sqrt(3.5 / bend).toFixed(1)} from the drawn bend`);
});

test('kinked link joins: the drawn camera keeps speed changes in the limit across them', () => {
  // Links that leave and arrive 15 degrees off the shots' headings (many
  // real links kink harder): the join's bend caps the link.
  for (const seed of [1, 2, 3]) {
    const lib = rangeShotLibraryFixture({ seed, kinkDeg: 15 }), m = { ...SHOT_MOTION, ...lib.motion };
    for (const name of ['anthem', 'drop']) {
      const p = rangePlan(lib, name);
      assert.equal(p.fallback, null);
      assert.ok(p.items.some((it) => it.kind === 'link'), `fixture ${seed} ${name}: the plan flies a kinked link`);
      const audit = motionAudit(buildShotTimeline(lib, p));
      assert.ok(audit.tangentialMps2.max <= m.maxAccelMps2 * 1.05, `fixture ${seed} ${name}: tangential ${audit.tangentialMps2.max.toFixed(2)} m/s2 at ${(audit.tangentialMps2.atMs / 1000).toFixed(1)} s`);
    }
  }
});

test('sideways acceleration is reported and unlimited by default; vectorAccelRatio holds the whole acceleration', () => {
  let over = 0;
  for (const lib of ranges) {
    const m = { ...SHOT_MOTION, ...lib.motion };
    assert.ok(shotPaceLimits(lib).link.every((x) => x.turnPerM > 0), 'every link reports its turn');
    for (const name of ['anthem', 'drop']) {
      if (motionAudit(buildShotTimeline(lib, rangePlan(lib, name))).accelMps2.max > 2 * m.maxAccelMps2 * 1.05) over++;
      const tunables = { vectorAccelRatio: 2 }, p = rangePlan(lib, name, { tunables });
      assert.equal(p.fallback, null);
      const audit = motionAudit(buildShotTimeline(lib, p, { tunables }));
      assert.ok(audit.accelMps2.max <= 2 * m.maxAccelMps2 * 1.05, `fixture ${lib.provenance.seed} ${name}: vector ${audit.accelMps2.max.toFixed(2)} m/s2`);
      assert.ok(audit.tangentialMps2.max <= m.maxAccelMps2 * 1.05);
    }
  }
  assert.ok(over > 0, 'without the ratio the turns do go past 2x (it is a real limit when set)');
});

test('a window that closes without a payoff costs its gap: a slow library still shows a payoff in it', () => {
  // At 18 m/s the first payoff in these windows comes late (more than 30 s
  // in); a window passing with none used to cost nothing, so the plan showed
  // none. A window opening at the song start earns its first-payoff bonus too.
  const lib = rangeShotLibraryFixture({ seed: 5 }), tunables = { maxSpeedMps: 18 };
  for (const w of [[0, 60], [10, 55], [10, 70]]) {
    const visible = [{ startMs: w[0] * 1000, endMs: w[1] * 1000 }], p = planShotTour(lib, { ...songs.anthem, visible, tunables });
    assert.equal(p.fallback, null);
    assert.ok(shownOf(p).some((it) => it.payoffMs >= visible[0].startMs && it.payoffMs <= visible[0].endMs), `window ${w}: a payoff on screen`);
  }
});

test('every kind of slot is tried as far as a leg reaches: a climax only a 128 s leg reaches gets its payoff', () => {
  // At 14 m/s every route to the climax is one leg of more than 90 s; impact
  // slots used to stop at 90 s while fillers did not, so the plan paid off a
  // filler at 86 s and passed the climax.
  for (const seed of [1, 2]) {
    const lib = rangeShotLibraryFixture({ seed }), p = planShotTour(lib, { ...songs.anthem, tunables: { maxSpeedMps: 14 } });
    const climax = shownOf(p).find((it) => it.payoffMs === 128000);
    assert.ok(climax, `fixture ${seed}: the climax gets a payoff (${shownOf(p).map((it) => it.payoffMs)})`);
    assert.ok(lib.subjectById.get(lib.shotById.get(climax.id).subjectId).hero, 'on a hero shot');
    const before = shownOf(p).filter((it) => it.payoffMs < 128000).at(-1)?.payoffMs ?? 0;
    assert.ok(128000 - before > 90000, 'over a leg of more than 90 s');
  }
});

test('the song ends through one more link into a last shot, or inside that link, and is drawn in the limits there', () => {
  const lib = ranges[0], m = { ...SHOT_MOTION, ...lib.motion };
  // 170 s: the last payoff's shot runs out, a link, and the song ends in the next shot before its payoff.
  const via = rangePlan(lib, 'anthem');
  const [a, b, c] = via.items.slice(-3);
  assert.deepEqual([a.kind, b.kind, c.kind], ['shot', 'link', 'shot']);
  assert.ok(Number.isFinite(a.payoffMs) && c.payoffMs === null && c.sTo < lib.shotById.get(c.id).payoffS, 'the last shot ends before its payoff');
  // 150 s: too soon for the next shot, too long to stay in the last one: the song ends inside the link.
  const inLink = rangePlan(lib, 'anthem', { durationMs: 150000 });
  assert.equal(inLink.items.at(-1).kind, 'link');
  assert.ok(inLink.items.at(-1).sTo < lib.linkById.get(inLink.items.at(-1).id).path.s.at(-1), 'the link is cut at the song end');
  for (const p of [via, inLink]) {
    assertTiles(p, 0, lib);
    const t = buildShotTimeline(lib, p), audit = motionAudit(t);
    assert.ok(audit.tangentialMps2.max <= m.maxAccelMps2 * 1.05 && audit.lastAccel.tangential <= m.maxAccelMps2, `tangential ${audit.tangentialMps2.max.toFixed(2)}, last 100 ms ${audit.lastAccel.tangential.toFixed(2)} m/s2`);
    assert.ok(audit.yawDegPerSec.max <= m.maxYawDegPerSec);
    for (const x of t.payoffs) assert.ok(Math.abs(x.actualMs - x.plannedMs) < 1);
  }
});

test('a replan from a committed link into the same subject still lands payoffs', () => {
  // The committed link's own repetition is not the replan's choice: charging
  // it (the full subject-repeat weight when fully on screen) made riding that
  // link to the song end without a payoff the cheapest option.
  const lib = library, same = lib.links.filter((l) => lib.shotById.get(l.from).subjectId === lib.shotById.get(l.to).subjectId && l.path.s.at(-1) > 400 && l.path.s.at(-1) < 1500);
  assert.ok(same.length >= 10);
  for (const link of same) {
    for (const timeMs of [20000, 60000, 100000]) {
      const p = plan({ start: { timeMs, itemKind: 'link', id: link.id, s: 50, speedMps: 20, accelMps2: 0 } });
      assert.equal(p.fallback, null);
      assert.ok(shownOf(p).length >= 1, `${link.id} from ${timeMs}: ${p.notes.join(' | ')}`);
    }
  }
});

test('same-input replans keep the committed payoffs, also where the plan ends inside a link', () => {
  // Payoffs at the shots' very end; the plan ends on a link after its last
  // payoff. A replan on the same inputs from any commit time must not lose a
  // committed payoff: neither to a ride-on of the committed element without
  // its payoff, nor to an ending the replan costs differently.
  const base0 = rangeShotLibraryFixture({ seed: 3 });
  const lib = restoreShotLibrary({ ...cloneableShotLibrary(base0), shots: base0.shots.map((s) => (s.move === 'rail' ? s : { ...s, payoffS: s.path.s.at(-1) })) });
  const song = songs.drop, request = { library: cloneableShotLibrary(lib), sections: song.sections, roles: song.roles, energy: song.energy, energyStepMs: 100, durationMs: song.durationMs, seed: 0 };
  const first = restoreShotTimeline(structuredClone(handleShotMessage(structuredClone(request)).message.timeline));
  assert.equal(first.items.at(-1).kind, 'link');
  let replans = 0;
  for (let c = 47000; c <= 97000; c += 5000) {
    const next = handleShotMessage(structuredClone({ ...request, previous: shotTimelineData(first), committedThroughMs: c })).message.timeline;
    const t0 = Math.ceil((c + 3000) / 100) * 100, later = (t) => t.payoffs.filter((x) => x.plannedMs > t0).map((x) => x.plannedMs);
    if (/deferred/.test(next.notes.at(-1))) continue;
    replans++;
    assert.deepEqual(later(next), later(first), `commit ${c}: the committed later payoffs`);
  }
  assert.ok(replans >= 8);
});

test('the replay measures payoff gaps inside each visible interval, never across time off screen', () => {
  const payoffs = [50000, 140000], D = 168000;
  // On screen 30-85 s and 120-168 s: 50 -> 85 is the longest stretch, not 50 -> 140.
  assert.equal(longestPayoffGap([{ startMs: 30000, endMs: 85000 }, { startMs: 120000, endMs: 168000 }], payoffs, { durationMs: D }), 35000);
  assert.equal(longestPayoffGap([{ startMs: 0, endMs: D }], payoffs, { durationMs: D }), 90000);
  // A replan from 100 s measures from there.
  assert.equal(longestPayoffGap([{ startMs: 0, endMs: D }], payoffs, { startMs: 100000, durationMs: D }), 40000);
});

test('a motion spike belongs to a join only within JOIN_SPIKE_MS of it', () => {
  // A straight flight that turns 90 deg at 10 s: the second difference spikes there.
  const kinkMs = 10000, poseAt = (t) => {
    const s = t / 1000, eyeM = s < 10 ? [40 * s, 300, 0] : [400, 300, 40 * (s - 10)];
    return { eyeM, targetM: [eyeM[0] + 1000, 300, eyeM[2] + 1000], fovYDeg: 30 };
  };
  const audit = (joinMs) => motionAudit({ durationMs: 20000, startMs: 0, poseAt, stateAt: () => ({ id: 'flight' }), items: [{ startMs: 0 }, { startMs: joinMs }] });
  const at = (a) => a.spikes.worst.find((x) => Math.abs(x.atMs - kinkMs) < 50);
  assert.ok(at(audit(kinkMs)), 'the kink is a spike');
  assert.equal(at(audit(kinkMs)).join, true);
  assert.equal(at(audit(kinkMs + JOIN_SPIKE_MS + 100)).join, false, 'a join 150 ms away is not its source');
});
