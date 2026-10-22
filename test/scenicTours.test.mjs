import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refinePayoff, durationRange, selectShots, selectLinks, regionConfig, focusArea, inFocus, steadyLook, linkLibrary, costliestShot, forestDrop, estimatedBytes, trimWindow, trimShot, renderedTotal, bestComponent, selectConnected, nearCopy, pathBend, renderedGate } from '../tools/build-scenic-tours.mjs';
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

test('positive subject weights change selection priority after quality and terrain gates', () => {
  const shot = (id, total, subjectWeight, holes = 0, missing = []) => ({ id, subjectId: id, move: 'traverse',
    subjectWeight, score: { total, holes }, traits: { azimuthDeg: 0, elevation: 'mid', lens: 'normal' }, missing });
  const select = (a, b) => selectShots([a, b], { ...config, discovery: { ...config.discovery, maxShots: 1 } });
  const ordinary = shot('ordinary', 0.7), emphasized = shot('emphasized', 0.6, 1.6);
  assert.deepEqual(select(ordinary, emphasized), [emphasized], 'existing configured weights can outweigh a modest quality difference');
  assert.deepEqual(select(ordinary, { ...emphasized, subjectWeight: 1 }), [ordinary], 'weight one retains score priority');
  for (const invalid of [0, -1, NaN, Infinity, '2']) {
    assert.deepEqual(select(ordinary, { ...emphasized, subjectWeight: invalid }), [ordinary], 'invalid weights default to one');
  }
  assert.equal(select(shot('bounded', 0.1, 100), shot('better', 0.5, 1))[0].id, 'better', 'weights are capped at four');
  assert.equal(select(shot('gentle', 0.8, 0.01), shot('lower', 0.15, 1))[0].id, 'gentle', 'positive weights have a quarter floor');
  assert.deepEqual(select(ordinary, { ...emphasized, score: { total: 1, holes: 0.1 } }), [ordinary], 'weight cannot admit a shot with holes');
  assert.deepEqual(select(ordinary, { ...emphasized, score: { total: 0, holes: 0 } }), [ordinary], 'weight cannot restore a failed quality score');
  assert.deepEqual(select(ordinary, { ...emphasized, missing: Array.from({ length: 200 }, (_, i) => i) }), [ordinary], 'weight cannot restore terrain-adjusted worth below zero');
});

test('connected library selection compares subject-weighted quality across disconnected cycles', () => {
  const shot = (id, total, subjectWeight = 1) => ({ id, subjectId: id, move: 'traverse', subjectWeight,
    score: { total, holes: 0 }, traits: { azimuthDeg: 0, elevation: 'mid', lens: 'normal' }, missing: [] });
  const [a, b, c, d] = [shot('a', 0.7), shot('b', 0.7), shot('c', 0.6, 1.6), shot('d', 0.6, 1.6)];
  const link = (from, to) => ({ from, to });
  const links = [link(a, b), link(b, a), link(c, d), link(d, c)];
  const cfg = { ...config, discovery: { ...config.discovery, maxShots: 2 } };
  assert.deepEqual(selectConnected([a, b, c, d], links, cfg).map((s) => s.id).sort(), ['c', 'd']);
  c.subjectWeight = 1; d.subjectWeight = 1;
  assert.deepEqual(selectConnected([a, b, c, d], links, cfg).map((s) => s.id).sort(), ['a', 'b']);
});

test('the graph component retained for selection respects configured subject emphasis', () => {
  const shot = (id, total, subjectWeight = 1) => ({ id, score: { total }, subjectWeight });
  const [a, b, c, d] = [shot('a', 0.7), shot('b', 0.7), shot('c', 0.6, 1.6), shot('d', 0.6, 1.6)];
  const link = (from, to) => ({ from, to });
  const links = [link(a, b), link(b, a), link(c, d), link(d, c)];
  assert.deepEqual([...bestComponent([a, b, c, d], links)].map((s) => s.id).sort(), ['c', 'd']);
  c.subjectWeight = 1; d.subjectWeight = 1;
  assert.deepEqual([...bestComponent([a, b, c, d], links)].map((s) => s.id).sort(), ['a', 'b']);
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

function assertMutuallyReachable(shots, links) {
  for (const start of shots) {
    const seen = new Set([start]), queue = [start];
    for (const from of queue) for (const link of links) if (link.from === from && !seen.has(link.to)) {
      seen.add(link.to); queue.push(link.to);
    }
    for (const to of shots) assert.ok(seen.has(to), `${start.id} cannot reach ${to.id}`);
  }
}

test('the outgoing link cap preserves low-score bridges between two scenic clusters', () => {
  const shots = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, move: 'traverse', score: { total: 1 }, missing: [] }));
  const link = (from, to, total = 1) => ({ from, to, kind: 'direct', lengthM: 1000,
    score: { total, holes: 0 }, durationMs: { ideal: 15000 }, missing: [], footprint: new Map([[3, 4]]) });
  const pairs = [];
  for (const group of [shots.slice(0, 5), shots.slice(5)]) {
    for (const from of group) for (const to of group) if (from !== to) pairs.push(link(from, to));
  }
  const there = link(shots[0], shots[5], 0.1), back = link(shots[5], shots[0], 0.1);
  there.footprint = new Map([[1, 4]]); back.footprint = new Map([[2, 4]]);
  pairs.push(there, back);
  const cfg = { ...config, discovery: { ...config.discovery, maxLinksPerShot: 4 } };
  const kept = selectLinks(pairs, shots, cfg);
  assert.ok(kept.includes(there) && kept.includes(back), 'both bridges are needed to travel between the two clusters');
  assertMutuallyReachable(shots, kept);
  for (const shot of shots) assert.ok(kept.filter((l) => l.from === shot).length <= 4, 'a redundant interior link can make room');
  assert.equal(estimatedBytes(kept, stubCost), 3 * TILE_BYTES[4], 'bridge footprints remain charged');
});

test('relinking after a connector drop retains one mutually reachable tour and the fallback rail', () => {
  const shot = (id, total = 1) => ({ id, move: 'traverse', score: { total }, missing: [] });
  const [a, b, bridge, c, d] = [shot('a'), shot('b'), shot('bridge'), shot('c', 0.5), shot('d', 0.5)];
  const rail = { ...shot('rail', 0.1), move: 'rail' };
  const link = (from, to) => ({ from, to, kind: 'direct', lengthM: 1000, score: { total: 1, holes: 0 }, durationMs: { ideal: 15000 }, missing: [] });
  const pairs = [[a, b], [b, a], [b, bridge], [bridge, b], [bridge, c], [c, bridge], [c, d], [d, c]].map(([from, to]) => link(from, to));
  const full = linkLibrary([rail, a, b, bridge, c, d], pairs, config);
  assertMutuallyReachable([a, b, bridge, c, d], full.links);
  const dropped = linkLibrary(full.shots.filter((s) => s !== bridge), pairs, config);
  assert.deepEqual(dropped.shots.map((s) => s.id), ['rail', 'a', 'b'], 'the other closed cycle is no longer part of the same tour');
  assertMutuallyReachable([a, b], dropped.links);
  assert.ok(dropped.links.every((l) => dropped.shots.includes(l.from) && dropped.shots.includes(l.to)));
});

test('a cycle through the fallback rail can retain one useful shot, but a lone self-loop cannot', () => {
  const rail = { id: 'rail', move: 'rail', score: { total: 0.2 }, missing: [] };
  const shot = { id: 'a', move: 'orbit', score: { total: 0.8 }, missing: [] };
  const link = (from, to) => ({ from, to, kind: 'direct', lengthM: 1000, score: { total: 1, holes: 0 }, durationMs: { ideal: 15000 }, missing: [] });
  const cycle = linkLibrary([rail, shot], [link(rail, shot), link(shot, rail)], config);
  assert.deepEqual(cycle.shots, [rail, shot]);
  const alone = linkLibrary([rail, shot], [link(shot, shot)], config);
  assert.deepEqual(alone.shots, [rail]);
  assert.deepEqual(alone.links, []);
});

test('a graph requiring more outgoing links than the preferred cap reports the excess explicitly', () => {
  const [hub, a, b] = ['hub', 'a', 'b'].map((id) => ({ id, move: 'traverse', score: { total: 1 }, missing: [] }));
  const link = (from, to) => ({ from, to, kind: 'direct', lengthM: 1000, score: { total: 1, holes: 0 }, durationMs: { ideal: 15000 }, missing: [] });
  // Every route between the leaves needs the hub's two exits. A strict
  // degree-one cap cannot retain all three; the existing incoming-link
  // restoration already treats this cap as a preference.
  const library = linkLibrary([hub, a, b], [link(hub, a), link(a, hub), link(hub, b), link(b, hub)],
    { ...config, discovery: { ...config.discovery, maxLinksPerShot: 1 } });
  assertMutuallyReachable([hub, a, b], library.links);
  assert.ok(library.connectivity, 'the library reports a cap/connectivity trade-off');
  assert.deepEqual(library.connectivity.overCap, [{ id: 'hub', links: 2, preferredCap: 1 }]);
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

test('a connected shortlist grows only by shots the set links into and back out of', () => {
  const shot = (id, total, subjectId = id) => ({ id, subjectId, move: 'traverse', score: { total, holes: 0 }, traits: { azimuthDeg: 0, elevation: 'low', lens: 'normal' }, missing: [] });
  const [rail, a, b, c, d, e, f] = [{ ...shot('rail', 0.3), move: 'rail' }, shot('a', 0.6), shot('b', 0.6), shot('c', 0.5), shot('d', 0.95), shot('e', 0.9), shot('f', 0.4)];
  const l = (from, to) => ({ from, to });
  // a<->b; b->c->a; c->d but d leads nowhere back; e is unreachable; b->f->a is another ear.
  const links = [l(a, b), l(b, a), l(b, c), l(c, a), l(c, d), l(e, a), l(b, f), l(f, a)];
  const out = selectConnected([rail, a, b, c, d, e, f], links, { ...config, discovery: { ...config.discovery, maxShots: 8 } }, null);
  assert.equal(out[0], rail, 'the rail always joins');
  assert.deepEqual(out.slice(1).map((x) => x.id).sort(), ['a', 'b', 'c', 'f'], 'the cycle grows by its ears; d and e cannot be both entered and left');
  for (const x of out.slice(1)) {
    assert.ok(links.some((k) => k.to === x && out.includes(k.from)), `${x.id} has a way in`);
    assert.ok(links.some((k) => k.from === x && out.includes(k.to)), `${x.id} has a way out`);
  }
  assert.deepEqual(selectConnected([rail, d, e], [l(d, e)], config, null), [rail], 'no cycle, no tour shots');
});

test('a connected shortlist seeds with a longer cycle when no short one exists, and adds longer ears', () => {
  const shot = (id, total) => ({ id, subjectId: id, move: 'traverse', score: { total, holes: 0 }, traits: { azimuthDeg: 0, elevation: 'low', lens: 'normal' }, missing: [] });
  const [a, b, c, d, e, f, g] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => shot(id, 0.5));
  const l = (from, to) => ({ from, to });
  // Only a four-shot cycle a->b->c->d->a, and a three-shot ear b->e->f->g->d.
  const links = [l(a, b), l(b, c), l(c, d), l(d, a), l(b, e), l(e, f), l(f, g), l(g, d)];
  const out = selectConnected([a, b, c, d, e, f, g], links, { ...config, discovery: { ...config.discovery, maxShots: 8 } }, null);
  assert.deepEqual(out.map((x) => x.id).sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const capped = selectConnected([a, b, c, d, e, f, g], links, { ...config, discovery: { ...config.discovery, maxShots: 8, earShots: 2 } }, null);
  assert.deepEqual(capped.map((x) => x.id).sort(), ['a', 'b', 'c', 'd'], 'an ear longer than earShots is not taken');
});

test('a near copy of a chosen shot is no new shot: the same payoff frame', () => {
  const shot = (id, move, x0, x1, payoffX) => {
    const path = samplePath({ eyes: [[x0, 500, 0], [x1, 500, 0]], aims: [[x0, 400, -5000], [x1, 400, -5000]], fovs: 30 });
    return { id, move, path, lengthM: path.s.at(-1), payoffS: path.s.at(-1) * ((payoffX - x0) / (x1 - x0)) };
  };
  const a = shot('a', 'traverse', 0, 3000, 1500), cut = shot('cut', 'traverse', 1000, 2000, 1500);
  assert.equal(nearCopy(a, cut), true, 'a cut of the same traverse is a copy');
  const other = shot('approach', 'approach', 1000, 2000, 1500);
  assert.equal(nearCopy(a, other), true, 'another move paying off on the same frame reads as the same shot');
  assert.equal(nearCopy(a, shot('far', 'traverse', 5000, 8000, 6500)), false);
});

test('a tight curve caps the comfortable pace the way the timeline will', () => {
  // A quarter circle of radius 200 m looking at one far point (the aim
  // barely turns, so progress is the eye's arc): bend 1/200 per metre.
  const eyes = Array.from({ length: 13 }, (_, i) => { const a = (i / 12) * Math.PI / 2; return [200 * Math.cos(a), 500, 200 * Math.sin(a)]; });
  const p = samplePath({ eyes, aims: eyes.map(() => [0, 400, -80000]), fovs: 30, spacingM: 10 });
  const bend = pathBend(p);
  assert.ok(Math.abs(bend[Math.floor(bend.length / 2)] - 1 / 200) < 1e-3, 'the bend of a 200 m circle');
  const flow = Float32Array.from(p.s, () => 1e-5);
  const capMps = Math.sqrt(3.5 / (1 / 200));
  const r = durationRange(p, flow, { ...config.motion, maxLateralMps2: 3.5 });
  assert.ok(r.min >= (p.s.at(-1) / capMps) * 1000 * 0.9, 'no faster than v^2 * bend <= 3.5 allows');
  const loose = durationRange(p, flow, { ...config.motion, maxAccelMps2: 3.5 });
  assert.ok(loose.min < r.min, 'turns may pull twice the speed-change limit by default');
});

test('the renderer drops a shot whose subject is off frame or fills it, or whose payoff is all soft close terrain', () => {
  const depth = (near) => ({ edgesM: [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 150000], frac: [0, 0, 0, 0, near, 0, 0, 0, 1 - near, 0, 0, 0], sky: 0 });
  const frame = (subject, near = 0) => ({ metrics: { subject, depth: depth(near) } });
  const good = { inFrame: 1, visible: 0.8, screenHeight: 0.4 };
  assert.equal(renderedGate([frame(good), frame(good), frame(good), frame(good)]).pass, true);
  assert.deepEqual(renderedGate([frame(good), frame({ ...good, inFrame: 0.2 }), frame(good), frame(good)]).reasons, ['subject out of frame at the payoff']);
  assert.deepEqual(renderedGate([frame(good), frame({ ...good, screenHeight: 0.95 }), frame(good), frame(good)]).reasons, ['subject fills the frame']);
  const soft = renderedGate([frame(good, 1), frame(good, 1), frame(good, 1), frame(good, 1)], { fovYDeg: 16, detailM: 30 });
  assert.ok(!soft.pass && soft.reasons.includes('payoff all soft close terrain'));
  const crisp = renderedGate([frame(good, 1), frame(good), frame(good), frame(good, 1)], { fovYDeg: 36, detailM: 30 });
  assert.ok(crisp.pass && crisp.factor < 1 && crisp.factor >= 0.75, 'soft entry and exit frames cost worth, not the shot');
});

test('a forest drop narrows the forest most per shot lost, trying each subject\'s overlapping shots together', () => {
  // The forest covers the distinct places the shots stand: 1 MiB each.
  const shot = (id, subjectId, at) => ({ id, subjectId, move: 'orbit', at });
  const bound = (lib) => new Set(lib.shots.map((s) => s.at)).size * 2 ** 20, relink = (shots) => ({ shots, links: [] });
  const rail = { id: 'rail', subjectId: 'rail-target', move: 'rail', at: 'r' };
  // Three overlapping shots of A and one shot of B elsewhere: B alone narrows the forest.
  const a = ['a1', 'a2', 'a3'].map((id) => shot(id, 'A', 'x')), b = shot('b1', 'B', 'y');
  const one = forestDrop({ shots: [rail, ...a, b, shot('c1', 'C', 'z')], links: [] }, relink, bound);
  assert.ok(['b1', 'c1'].includes(one.group[0].id) && one.group.length === 1 && one.gain === 2 ** 20);
  // Only overlapping groups: no single shot narrows anything, A's three together do.
  const b3 = ['b1', 'b2', 'b3'].map((id) => shot(id, 'B', 'y')), d3 = ['d1', 'd2'].map((id) => shot(id, 'D', 'w'));
  const group = forestDrop({ shots: [rail, ...a, ...b3, ...d3], links: [] }, relink, bound);
  assert.deepEqual(group.group.map((s) => s.id), ['d1', 'd2'], 'the smallest group that narrows the forest: most per shot lost');
  assert.equal(group.lost, 2);
  // Never below the minimum.
  assert.equal(forestDrop({ shots: [rail, ...a], links: [] }, relink, bound), null);
});
