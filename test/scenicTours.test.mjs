import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refinePayoff, durationRange, selectShots, selectLinks, regionConfig, focusArea, inFocus, steadyLook, linkLibrary, costliestShot, estimatedBytes, trimWindow, trimShot, renderedTotal, bestComponent } from '../tools/build-scenic-tours.mjs';
import { TILE_BYTES } from '../tools/lib/scenic-cost.mjs';
import { samplePath } from '../src/world/terrain/ShotPath.js';

const config = regionConfig({
  defaults: { motion: { maxSpeedMps: 120, minSpeedMps: 4, flowCalm: 0.07, flowEnergetic: 0.24 },
    discovery: { maxShots: 4, shotsPerSubject: 2, maxLinksPerShot: 2, tileWeight: 0.6, focusRadiusM: 5000 } },
  regions: { v: { landform: 'butte', hero: ['Hero'] } } }, 'v');

test('a reveal pays off where its subject first stands clear; other moves at their best framing near the intent', () => {
  const samples = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((s, i) => ({ s, composition: 0.5 + 0.04 * i, subject: 0.6, visible: i < 4 ? 0.1 : i < 6 ? 0.6 : 0.95 }));
  assert.equal(refinePayoff({ move: 'reveal', lengthM: 1000, payoffFrac: 0.8 }, { samples }).payoffS, 600);
  const { payoffS, holdS } = refinePayoff({ move: 'traverse', lengthM: 1000, payoffFrac: 0.5 }, { samples });
  assert.ok(payoffS >= 250 && payoffS <= 1000);
  assert.ok(holdS[0] <= payoffS && payoffS <= holdS[1]);
});

test('the comfortable duration range follows the flow lane and the drift floor', () => {
  const p = samplePath({ eyes: [[0, 500, 0], [1000, 500, 0]], aims: [[0, 400, -5000], [1000, 400, -5000]], fovs: 30 });
  const near = durationRange(p, Float32Array.from(p.s, () => 0.004), config.motion), far = durationRange(p, Float32Array.from(p.s, () => 0.0004), config.motion);
  assert.ok(near.min > far.min, 'nearer terrain (more image flow) allows less speed');
  assert.ok(near.min <= near.ideal && near.ideal <= near.max);
  assert.equal(far.min, Math.round(1000 / 120 * 1000), 'far terrain is capped by the speed limit');
  assert.equal(near.max, Math.round(Math.max(1000 / (0.07 / 0.004), 1000 / 4) * 1000));
});

test('selection keeps the rail, spreads subjects and charges new terrain', () => {
  const shot = (id, subjectId, total, missing = [], move = 'traverse', elevation = 'low') => ({ id, subjectId, move, score: { total, holes: 0 },
    traits: { azimuthDeg: Number(id.at(-1)) * 50, elevation, lens: 'normal' }, missing });
  const scored = [shot('rail', 'r', 0.3, [], 'rail', 'mid'), shot('a1', 'a', 0.9), shot('a2', 'a', 0.85), shot('a3', 'a', 0.84), shot('b1', 'b', 0.6),
    shot('c1', 'c', 0.8, Array.from({ length: 200 }, (_, i) => i))];
  const out = selectShots(scored, config).map((s) => s.id);
  assert.equal(out[0], 'rail');
  assert.ok(out.includes('b1'), 'a second subject beats a third shot of the first');
  assert.ok(!out.includes('c1'), '200 new tiles cost more than the shot is worth');
  assert.ok(out.filter((id) => id.startsWith('a')).length <= 2);
});

test('link selection keeps a way into every shot and prefers short, scenic, cheap links', () => {
  const s = ['a', 'b', 'c'].map((id) => ({ id, missing: [] }));
  const link = (from, to, total, lengthM, kind = 'direct', missing = []) => ({ from, to, kind, lengthM, score: { total, holes: 0 }, durationMs: { ideal: lengthM * 20 }, missing });
  const pairs = [link(s[0], s[1], 0.8, 1000), link(s[0], s[1], 0.85, 4000, 'arc'), link(s[0], s[2], 0.5, 1500), link(s[1], s[0], 0.6, 1200),
    link(s[2], s[0], 0.4, 900, 'direct', Array.from({ length: 300 }, (_, i) => i))];
  const kept = selectLinks(pairs, s, config);
  assert.ok(kept.some((l) => l.to === s[2]), 'c stays reachable');
  assert.ok(kept.some((l) => l.from === s[2]), 'c keeps its only way out even when costly');
  assert.ok(kept.filter((l) => l.from === s[0]).length <= 2);
});

test('the focus area centres between the rail target and the heroes', () => {
  const f = focusArea([{ kind: 'rail-target', posM: [0, 0, 0] }, { name: 'Hero', posM: [2000, 0, 0] }, { name: 'Other', posM: [9000, 0, 0] }], config);
  assert.deepEqual(f.center, [1000, 0, 0]);
  assert.equal(f.radiusM, 6000, 'the butte landform keeps a compact area');
  const p = samplePath({ eyes: [[0, 500, 0], [20000, 500, 0]], aims: [[0, 400, -5000], [20000, 400, -5000]], fovs: 30 });
  assert.equal(inFocus(p, f), false);
});

test('a path that looks straight down anywhere is unusable', () => {
  const level = samplePath({ eyes: [[0, 500, 0], [1000, 500, 0]], aims: [[0, 400, -5000], [1000, 400, -5000]], fovs: 30 });
  assert.equal(steadyLook(level), true);
  const over = samplePath({ eyes: [[-600, 2000, 0], [0, 2000, 0], [600, 2000, 0]], aims: [[-300, 0, 0], [0, 0, 1], [300, 0, 0]], fovs: 30 });
  assert.equal(steadyLook(over), false);
});

// Stub cost model: a footprint maps tile -> stride directly.
const stubCost = { own(fp, owned) { for (const [t, s] of fp) if (!(owned.get(t) <= s)) owned.set(t, s); return owned; }, shipped: () => null,
  marginal(fp, owned = new Map()) { let b = 0; for (const [t, s] of fp) if (!(owned.get(t) <= s)) b += TILE_BYTES[s] - (owned.has(t) ? TILE_BYTES[owned.get(t)] : 0); return b; },
  total(fps) { return this.marginal(fps.reduce((m, fp) => this.own(fp, m), new Map())); } };

test('dropping a shot re-links the rest from every scored pair instead of stranding them', () => {
  const cfg = { ...config, discovery: { ...config.discovery, maxLinksPerShot: 1 } };
  const shot = (id) => ({ id, move: 'traverse', missing: [], footprint: new Map(), score: { total: 0.5 }, traits: { elevation: 'low' } });
  const [a, b, c] = ['a', 'b', 'c'].map(shot);
  const link = (from, to, total) => ({ from, to, kind: 'direct', lengthM: 1000, score: { total, holes: 0 }, durationMs: { ideal: 20000 }, missing: [], footprint: new Map() });
  const pairs = [link(a, b, 0.9), link(b, a, 0.9), link(a, c, 0.3), link(c, a, 0.3), link(b, c, 0.8), link(c, b, 0.8)];
  const full = linkLibrary([a, b, c], pairs, cfg, stubCost);
  assert.equal(full.shots.length, 3);
  assert.ok(!full.links.some((l) => l.from === a && l.to === c), 'a leaves for b while b is there');
  const without = linkLibrary([a, c], pairs, cfg, stubCost);
  assert.deepEqual(without.shots.map((s) => s.id), ['a', 'c'], 'a and c stay, joined by the links they were not using');
  assert.ok(without.links.some((l) => l.from === a && l.to === c) && without.links.some((l) => l.from === c && l.to === a));
});

test('the shot dropped first is the one whose terrain is most its own per unit of score and rarity', () => {
  const shot = (id, total, footprint, move = 'traverse') => ({ id, move, score: { total }, traits: { elevation: 'low' }, subjectId: 's', footprint: new Map(footprint) });
  const cheap = shot('cheap', 0.5, [[1, 4], [2, 4]]), dear = shot('dear', 0.5, [[3, 1], [4, 1]]), shared = shot('shared', 0.5, [[1, 4]]);
  const library = { shots: [cheap, dear, shared], links: [] };
  assert.equal(estimatedBytes(library.shots, stubCost), 2 * TILE_BYTES[4] + 2 * TILE_BYTES[1]);
  assert.equal(costliestShot(library, stubCost).shot, dear);
  const rare = shot('dear', 0.5, [[3, 1], [4, 1]], 'reveal');
  assert.equal(costliestShot({ shots: [cheap, rare, shared], links: [] }, stubCost).shot.id, 'dear', 'rarity softens but does not hide a 14 KB cost');
});

test('a long shot keeps its best window around the payoff; a reveal keeps the stretch before it', () => {
  const p = samplePath({ eyes: [[0, 500, 0], [6000, 500, 0]], aims: [[0, 400, -5000], [6000, 400, -5000]], fovs: 30, spacingM: 60 });
  p.flow = Float32Array.from(p.s, () => 0.0005);
  const L = p.s.at(-1), shot = { move: 'traverse', path: p, lengthM: L, payoffS: 0.7 * L, holdS: [0.6 * L, 0.9 * L], durationMs: { ideal: 60000 } };
  assert.equal(trimWindow({ ...shot, durationMs: { ideal: 15000 } }, 16000), null, 'a shot that fits is kept whole');
  const [a, b] = trimWindow(shot, 16000);
  assert.ok(Math.abs(b - a - L * 16 / 60) < 1e-6 && a < shot.payoffS && shot.payoffS < b);
  const cut = trimShot(shot, [a, b], config.motion);
  assert.ok(Math.abs(cut.lengthM - (b - a)) < 1e-6 && Math.abs(cut.payoffS - (shot.payoffS - a)) < 1e-6);
  assert.ok(cut.holdS[0] <= cut.payoffS && cut.payoffS <= cut.holdS[1] && cut.holdS[1] <= cut.lengthM);
  assert.ok(cut.durationMs.ideal < shot.durationMs.ideal && cut.path.flow.length === cut.path.s.length);
  const reveal = { ...shot, move: 'reveal', scored: { samples: [{ s: 0.2 * L, visible: 0.1 }, { s: 0.4 * L, visible: 0.2 }, { s: 0.6 * L, visible: 0.9 }] } };
  assert.ok(trimWindow(reveal, 16000)[0] < 0.4 * L, 'the reveal starts while its subject is still hidden');
});

test('a later round keeps what earlier rounds connected and prefers shots a short link can reach', () => {
  const at = (x) => samplePath({ eyes: [[x, 500, 0], [x + 200, 500, 0]], aims: [[x, 400, -5000], [x + 200, 400, -5000]], fovs: 30 });
  const shot = (id, subjectId, total, x, move = 'traverse') => ({ id, subjectId, move, path: at(x), score: { total, holes: 0 }, traits: { azimuthDeg: 0, elevation: 'low', lens: 'normal' }, missing: [] });
  const rail = shot('rail', 'r', 0.3, 0, 'rail'), kept = shot('k1', 'k', 0.7, 300);
  const far = shot('far', 'f', 0.8, 30000), close = shot('close', 'c', 0.7, 900);
  const out = selectShots([rail, kept, far, close], { ...config, discovery: { ...config.discovery, maxShots: 3 } }, null, [rail, kept]);
  assert.deepEqual(out.slice(0, 2), [rail, kept]);
  assert.equal(out[2], close, 'a slightly better shot 30 km away loses to one within reach');
});

test('the renderer keeps a shot whose subject it shows and discounts one it renders flat or empty', () => {
  assert.equal(renderedTotal(0.8, 0.5), 0.8);
  assert.ok(Math.abs(renderedTotal(0.8, 0.225) - 0.8 * 0.775) < 1e-9);
  assert.equal(renderedTotal(0.8, 0.05), 0, 'an empty render drops the shot');
  assert.ok(renderedTotal(0.6, 0.45) > renderedTotal(0.7, 0.15), 'a shot that renders well beats a slightly better DEM score that does not');
});

test('tours stay inside the strongly connected part of the link graph worth most', () => {
  const s = (id, total) => ({ id, score: { total } });
  const [a, b, c, d, e] = [s('a', 0.5), s('b', 0.5), s('c', 0.6), s('d', 0.9), s('e', 0.99)];
  const l = (from, to) => ({ from, to });
  // a<->b<->c form a cycle; d<->e another; e is reachable from c but leads nowhere back.
  const links = [l(a, b), l(b, c), l(c, a), l(d, e), l(e, d), l(c, d)];
  assert.deepEqual([...bestComponent([a, b, c, d, e], links)].map((x) => x.id).sort(), ['d', 'e'], 'two strong shots outweigh three weaker ones');
  assert.deepEqual([...bestComponent([a, b, c, d, e], links, 1)].map((x) => x.id).sort(), ['d', 'e']);
  assert.equal(bestComponent([a, b], [l(a, b)]).size, 0, 'a one-way pair is no tour');
});
