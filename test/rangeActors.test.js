// The cast as lights in the Range (RangeActors.js): the per-song score
// from each lane, each view's job state, and the wandering routes tours
// keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTOR_IDS, ROUTE_UNITS, ACTOR_STEP_MS, ACTOR_SPREAD, compileActorScore, rangeActorsAt, actorRoutes, routePosition,
} from '../src/world/alpine/RangeActors.js';
import { ActorsGL, ACTOR_GLSL, actorUniforms } from '../src/world/alpine/ActorsGL.js';
import { compileLandscapeSources } from '../src/world/alpine/RangeNarrative.js';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { cameraPoseAt, projectPoint } from '../src/world/terrain/SceneTravel.js';

/** A narrative whose lanes play `fn(id, tMs)` (0..1). */
const narrative = (durationMs, fn) => ({
  durationMs,
  sample: (t) => ({ sources: Object.fromEntries(ACTOR_IDS.map((id) => [id, { activity: fn(id, t) }])) }),
});
// Midio plays a steady bass with two loud stretches; Broshi is silent.
const song = narrative(120000, (id, t) => {
  if (id === 'broshi') return 0;
  if (id === 'midio') return (t > 30000 && t < 34000) || (t > 40000 && t < 44000) || (t > 80000 && t < 85000) ? 0.95 : 0.3;
  return 0.2 + 0.1 * Math.sin(t / 900);
});

test('the score has no peaks: only glow, travel, the note pulse and the pitch spread', () => {
  const score = compileActorScore(song);
  assert.equal(score.peaks, undefined);
  assert.deepEqual(Object.keys(score.at(31000).midio).sort(), ['glow', 'pulse01', 'spread', 'travel']);
  // A silent lane only drifts.
  assert.equal(score.at(60000).broshi.glow, 0);
  // No onsets and no pitch: no pulse, and the swarm keeps its shape.
  for (const t of [0, 31000, 60000, 119000]) for (const id of ACTOR_IDS) {
    assert.equal(score.at(t)[id].pulse01, 0);
    assert.equal(score.at(t)[id].spread, 1);
  }
});

// --- The lane's notes: a pulse on each onset, a spread from its pitch ---

/** A narrative with lane `onsets` and `pitch(id, t)` (pitch01, or null
 *  where the lane rests: there, as in RangeNarrative, pitch01 reads .5). */
const scored = (durationMs, onsets, pitch = () => null) => ({
  durationMs, onsets,
  sample: (t) => ({ sources: Object.fromEntries(ACTOR_IDS.map((id) => {
    const p = pitch(id, t);
    return [id, p == null ? { activity: 0, pitchActivity: 0, pitch01: 0.5 } : { activity: 0.6, pitchActivity: 0.8, pitch01: p }];
  })) }),
});
const range = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
// Midio plays quarter notes at 120 bpm; Broshi 16ths over the same bars.
const QUARTERS = range(10000, 20000, 500), SIXTEENTHS = range(10000, 20000, 125);
const notes = { midio: QUARTERS, broshi: SIXTEENTHS, midasus: [] };

test('a lane pulses on its onsets: nothing before the first, 1 at each, then only decay', () => {
  const score = compileActorScore(scored(30000, notes));
  for (const t of [0, 5000, 9999]) for (const id of ACTOR_IDS) assert.equal(score.at(t)[id].pulse01, 0, `${id} at ${t}`);
  for (const t of [0, 15000, 25000]) assert.equal(score.at(t).midasus.pulse01, 0, 'a lane with no notes never pulses');
  for (const on of QUARTERS) assert.equal(score.at(on).midio.pulse01, 1, `onset ${on}`);
  assert.ok(score.at(10000 - 1e-3).midio.pulse01 === 0, 'not a moment early');
  // Between one onset and the next (and after the last), it only falls.
  const between = (lane, a, b) => {
    let prev = Infinity;
    for (let t = a; t < b; t += 5) {
      const v = score.at(t)[lane].pulse01;
      assert.ok(v < prev || (v === 0 && prev === 0), `${lane} at ${t}: ${v} after ${prev}`);
      prev = v;
    }
  };
  for (let i = 0; i < QUARTERS.length; i++) between('midio', QUARTERS[i], QUARTERS[i + 1] ?? 30000);
  // A busy lane too: its damping never lets the pulse rise between notes.
  for (let i = 0; i < SIXTEENTHS.length; i++) between('broshi', SIXTEENTHS[i], SIXTEENTHS[i + 1] ?? 30000);
  assert.ok(score.at(20180).midio.pulse01 > 0.3 && score.at(20180).midio.pulse01 < 0.4, 'decays over 180 ms');
  assert.ok(score.at(22000).midio.pulse01 < 1e-4, 'and is gone in the rest');
});

test('a pulse never hears an onset before it is played', () => {
  const base = compileActorScore(scored(30000, notes));
  for (const t of [9000, 10250, 12340, 15000.5, 19999, 25000]) {
    for (const id of ['midio', 'broshi', 'midasus']) {
      const early = { ...notes, [id]: [...notes[id], t + 1].sort((a, b) => a - b) };
      assert.deepEqual(compileActorScore(scored(30000, early)).at(t), base.at(t), `${id}: an onset at ${t + 1} ms changes ${t}`);
    }
  }
});

test('the score reads the same forward, in reverse and after a seek', () => {
  const song2 = scored(30000, notes, (id, t) => (t > 8000 && t < 22000 ? 0.3 + 0.2 * Math.sin(t / 700) : null));
  const score = compileActorScore(song2);
  const times = range(0, 30000, 37);
  const forward = times.map((t) => score.at(t));
  const reverse = [...times].reverse().map((t) => score.at(t)).reverse();
  assert.deepEqual(reverse, forward);
  // A fresh compile (another seek target, another session) agrees.
  const again = compileActorScore(song2);
  for (const t of [9876, 15000, 21234]) assert.deepEqual(again.at(t), score.at(t));
});

test('the spread follows the lane\'s own pitch range, holds through rests and never steps', () => {
  // Midio's line climbs, rests, and comes back low; Broshi's bass stays
  // in its two low octaves (pitch01 .05..0.2) and still uses the full range.
  const pitch = (id, t) => {
    if (id === 'midio') return t >= 2000 && t < 14000 ? 0.9 : t >= 18000 && t < 30000 ? 0.2 : null;
    if (id === 'broshi') return t >= 2000 && t < 14000 ? 0.05 : t >= 18000 && t < 30000 ? 0.2 : null;
    return null;
  };
  const score = compileActorScore(scored(40000, notes, pitch));
  const [lo, hi] = ACTOR_SPREAD;
  for (const t of range(0, 40000, 25)) for (const id of ACTOR_IDS) {
    const s = score.at(t)[id].spread;
    assert.ok(s >= lo && s <= hi, `${id} at ${t}: ${s}`);
    // The raw pitch snaps to .5 at a rest's edges; the spread glides on.
    const step = Math.abs(score.at(t + ACTOR_STEP_MS)[id].spread - s);
    assert.ok(step < 0.02, `${id} steps ${step} at ${t}`);
  }
  assert.equal(score.at(1000).midio.spread, 1, 'neutral before the lane first sings');
  assert.ok(score.at(13900).midio.spread > 1.2, `high: ${score.at(13900).midio.spread}`);
  assert.ok(score.at(29900).midio.spread < 0.8, `low: ${score.at(29900).midio.spread}`);
  // Through the rest it holds where the line left it.
  assert.ok(Math.abs(score.at(17950).midio.spread - score.at(14000).midio.spread) < 1e-6, 'held through the rest');
  assert.ok(Math.abs(score.at(39000).midio.spread - score.at(30000).midio.spread) < 1e-6, 'held after the last note');
  // Low in its own range, then high in it: the bass spreads too.
  assert.ok(score.at(13900).broshi.spread < 0.8 && score.at(29900).broshi.spread > 1.2,
    `${score.at(13900).broshi.spread}..${score.at(29900).broshi.spread}`);
  assert.equal(score.at(20000).midasus.spread, 1, 'a lane with no pitch keeps its shape');
});

test('a lane that only ever sings one pitch keeps the swarm\'s shape', () => {
  const score = compileActorScore(scored(20000, notes, (id, t) => (t > 5000 && t < 15000 ? 0.4 : null)));
  for (const t of [0, 6000, 14000, 19000]) for (const id of ACTOR_IDS) assert.equal(score.at(t)[id].spread, 1);
});

test('a 16th-note lane shimmers: its pulses peak below a sparse lane\'s', () => {
  const score = compileActorScore(scored(30000, notes));
  const peak = (id, list) => Math.max(...list.map((t) => score.at(t)[id].pulse01));
  // From the second beat of the run (the first three notes flare in full).
  const dense = peak('broshi', SIXTEENTHS.filter((t) => t >= 10500));
  const sparse = peak('midio', QUARTERS.filter((t) => t >= 10500));
  assert.equal(sparse, 1);
  assert.ok(dense < sparse && dense <= 0.8 + 1e-9, `dense ${dense} vs sparse ${sparse}`);
  for (const t of SIXTEENTHS.filter((x) => x >= 10500)) assert.ok(score.at(t).broshi.pulse01 > 0.5, 'still marks each note');
});

test('an empty narrative has no pulse and a neutral spread', () => {
  for (const n of [null, {}, { durationMs: 0, sample: () => ({}) }, { durationMs: 1000 }]) {
    const at = compileActorScore(n).at(500);
    for (const id of ACTOR_IDS) assert.deepEqual(at[id], { glow: 0, travel: 0, pulse01: 0, spread: 1 });
  }
  // A zero-length song still gives the cast a state (and Midio a wake).
  const sim = { rangeNarrative: { durationMs: 0, sample: () => ({}) }, biomes: {} };
  assert.equal(rangeActorsAt(sim, 9000).midio.trail, 0);
  assert.equal(rangeActorsAt(sim, 9000).broshi.spread, 1);
});

test('the pulse and spread come from the song\'s own notes and pitch', () => {
  // Midio is cast to the bass role: a low phrase, then a high one.
  const timeline = [];
  for (let i = 0; i < 16; i++) timeline.push({ tMs: 4000 + i * 500, durMs: 400, vel: 0.8, role: 'BASS', pitch: 36, src: 'midi' });
  for (let i = 0; i < 16; i++) timeline.push({ tMs: 14000 + i * 500, durMs: 400, vel: 0.8, role: 'BASS', pitch: 52, src: 'midi' });
  const sim = { rangeNarrative: compileLandscapeSources({ durationMs: 30000, timeline }), biomes: {} };
  const at = (t) => rangeActorsAt(sim, t);
  assert.equal(at(3999).midio.pulse01, 0);
  assert.equal(at(4000).midio.pulse01, 1);
  assert.equal(at(14500).midio.pulse01, 1);
  assert.ok(at(11900).midio.spread < 0.8 && at(21900).midio.spread > 1.2, `${at(11900).midio.spread}..${at(21900).midio.spread}`);
  assert.ok(at(10000).midio.glow > 0.3, 'glow is as it was');
  assert.equal(at(10000).broshi.pulse01, 0, 'no melody, no pulse');
});

test('the motes read the pulse and spread, from defaults that leave them as they were', () => {
  const actors = new ActorsGL(THREE, actorUniforms(THREE));
  for (const id of ACTOR_IDS) {
    const u = actors.uniforms[id];
    assert.equal(u.uPulse.value, 0);
    assert.equal(u.uSpread.value, 1);
    const motes = actors.groups[id].children.find((m) => m.geometry.isInstancedBufferGeometry);
    // RangeScene sets actors.uniforms[id]; the swarm's material reads the same objects.
    assert.equal(motes.material.uniforms.uPulse, u.uPulse);
    assert.equal(motes.material.uniforms.uSpread, u.uSpread);
    const src = motes.material.vertexShader.replace(/\/\/[^\n]*/g, '');
    for (const decl of [/uniform\s+float\s+uPulse;/, /uniform\s+float\s+uSpread;/]) assert.match(src, decl);
    // The twinkle steadies on a note, the swarm brightens a quarter, and
    // only its rise and fall stretches with pitch.
    assert.ok(src.includes('mix(0.75 + 0.25 * sin(uTime * 3.0 + aSeed.z * 40.0), 1.0, uPulse)'));
    assert.ok(src.includes('(1.0 + 0.25 * uPulse)'));
    assert.ok(src.includes('* vec2(1.0, uSpread)'));
  }
  // The lights the lanterns cast are not pulsed: the land does not strobe.
  assert.doesNotMatch(ACTOR_GLSL, /uPulse|uSpread/);
  actors.dispose();
});

test('the score is a function of heard time: travel grows faster while the lane plays', () => {
  const score = compileActorScore(song);
  const a = score.at(31000).midio, b = score.at(31000).midio;
  assert.deepEqual(a, b);
  const quiet = score.at(28000).midio.travel - score.at(26000).midio.travel;
  const loud = score.at(33000).midio.travel - score.at(31000).midio.travel;
  assert.ok(loud > quiet * 1.5, `${loud} vs ${quiet}`);
  assert.ok(score.at(33000).midio.glow > score.at(28000).midio.glow);
});

test('the cast arrives with the scene', () => {
  const sim = { rangeNarrative: song, biomes: {} };
  assert.equal(rangeActorsAt(sim, 1000).presence, 0);
  assert.equal(rangeActorsAt(sim, 9000).presence, 1);
  assert.ok(Number.isFinite(rangeActorsAt(sim, 9000).midio.trail));
  assert.equal(rangeActorsAt(sim, 9000).jobs, null, 'no views cast, no jobs');
  assert.equal(rangeActorsAt({}, 9000), null);
});

test('each view the song visits has a job, and a review can hold its progress', () => {
  const sections = [0, 1, 2, 3].map((i) => ({ startMs: i * 30000, endMs: (i + 1) * 30000, barMs: 2000, profile: i % 2 ? 'B' : 'A',
    provenance: 'detected', confidence: 1 }));
  const sim = { rangeNarrative: { ...song, onsets: { midio: [], broshi: [], midasus: [] } },
    biomes: { sections, durationMs: 120000, energyCurves: { globalEnergyNorm: (t) => (t > 60000 && t < 90000 ? 0.9 : 0.3) } } };
  const sceneAssignments = new Map([['A', { view: { id: 'va' } }], ['B', { view: { id: 'vb' } }]]);
  const at = (t) => rangeActorsAt(sim, t, { sceneAssignments });
  assert.deepEqual(Object.keys(at(10000).jobs).sort(), ['va', 'vb']);
  assert.equal(at(10000).schedule, at(50000).schedule, 'compiled once');
  assert.ok(at(29000).jobs.va.p > at(10000).jobs.va.p);
  assert.equal(at(45000).jobs.va.p, at(30000).jobs.va.p, 'held while away');
  // The loud third section is the climax: A finishes on it.
  assert.equal(at(70000).jobs.va.p, 1);
  sim.biomes.castProgressOverride = { vb: 0.5 };
  assert.equal(at(10000).jobs.vb.p, 0.5);
  assert.equal(at(10000).jobs.vb.override, true);
  assert.notEqual(at(10000).jobs.va.p, 0.5);
  sim.biomes.castProgressOverride = 1;
  assert.equal(at(10000).jobs.va.payoff01, 1);
});

// A bowl with a round lake in it, seen from its south rim.
function bowl() {
  const cells = 32, cellSizeM = 50, tilesX = 8, tilesZ = 8, n = cells + 1, level = 1000;
  const tiles = new Map(), byIndex = new Map();
  for (let iz = 0; iz < tilesZ; iz++) for (let ix = 0; ix < tilesX; ix++) {
    const heightsM = new Float32Array(n * n), flowBytes = new Uint8Array(n * n);
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
      const x = (ix * cells + u) * cellSizeM, z = (iz * cells + v) * cellSizeM;
      const r = Math.hypot(x - 6400, z - 6400);
      const wet = r < 2000;
      heightsM[v * n + u] = wet ? level : level + (r - 2000) * 0.2;
      flowBytes[v * n + u] = wet ? 255 : 10;
    }
    const t = { id: `${ix}_${iz}`, ix, iz, samples: n, stride: 1, visible: true, band: 'mid', heightsM, flowBytes };
    tiles.set(t.id, t);
    byIndex.set(`${ix},${iz}`, t);
  }
  const data = { tiles, byIndex, cells, grid: { originM: [0, 0], cellSizeM }, manifest: { tilesX, tilesZ } };
  const view = { id: 'bowl', camera: { eyeStartM: [6400, 1900, -1500], eyeEndM: [6600, 1900, -1400], targetStartM: [6400, 1000, 6400], targetEndM: [6500, 1000, 6400], fovYDeg: 40 } };
  return { data, view, level };
}

test('routes: Midio on the lake, Broshi on its shore, Midasus over low ground, all in frame', () => {
  const { data, view, level } = bowl();
  const r = actorRoutes(data, view, { waterLevelM: level, seed: 7 });
  assert.equal(r.midio.kind, 'water');
  assert.equal(r.broshi.kind, 'ground');
  assert.equal(r.midasus.kind, 'ground');
  for (const p of r.midio.points) assert.equal(p[1], level);
  for (const p of r.broshi.points) assert.ok(p[1] > level && p[1] < level + 40, `${p}`);
  const pose = cameraPoseAt(view, 0.5);
  for (const id of ACTOR_IDS) {
    const xs = r[id].points.map((p) => projectPoint(pose, 16 / 9, p).x);
    assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1]), `${id} anchors run left to right`);
    for (const p of r[id].points) {
      const q = projectPoint(pose, 16 / 9, p);
      assert.ok(Math.abs(q.x) < 0.75 && Math.abs(q.y) < 0.75, `${id} ${q.x},${q.y}`);
    }
  }
  for (const p of r.midasus.points) assert.ok(p[1] > level, 'on land, not in the sky');
  // Same view, same seed: the same routes.
  assert.deepEqual(actorRoutes(data, view, { waterLevelM: level, seed: 7 }).midio.points, r.midio.points);
});

test('a route is walked back and forth at its hover height', () => {
  const { data, level } = bowl();
  const route = { kind: 'water', points: [[5000, level, 6000], [6000, level, 6400], [7000, level, 6000]], lengths: [], total: 0 };
  for (let i = 1; i < 3; i++) route.lengths.push(Math.hypot(route.points[i][0] - route.points[i - 1][0], route.points[i][2] - route.points[i - 1][2]));
  route.total = route.lengths[0] + route.lengths[1];
  const at = (t) => routePosition(route, t, { data, waterLevelM: level, hoverM: 7 });
  assert.deepEqual(at(0).map(Math.round), [5000, level + 7, 6000]);
  assert.deepEqual(at(ROUTE_UNITS).map(Math.round), [7000, level + 7, 6000]);
  // There and back again.
  assert.deepEqual(at(2 * ROUTE_UNITS).map(Math.round), at(0).map(Math.round));
  assert.deepEqual(at(0.5 * ROUTE_UNITS).map(Math.round), at(1.5 * ROUTE_UNITS).map(Math.round));
});
