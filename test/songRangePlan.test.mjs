import test from 'node:test';
import assert from 'node:assert/strict';
import { planSongRange, songRangeKey, songRangeEnabled, SONG_RANGE_VERSION, BIOME_FAMILY } from '../src/world/terrain/SongRangePlan.js';
import MASSIF_CATALOG from '../src/world/terrain/massifCatalogData.js';
import { chooseSongBiomes } from '../src/world/terrain/BiomeSet.js';
import { DEFAULT_PACKS } from '../tools/build-range-scene.mjs';
import { describeSongWorld, createSongWorldRecord } from '../src/library/SongWorld.js';
import { PROFILE_VERSION } from '../src/audio/SongProfile.js';

// Deterministic synthetic songs: a seeded generator, not Math.random.
function* songs(n, salt = 1) {
  let s = (0x9e3779b9 * salt) >>> 0;
  const r = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0; return s / 4294967296; };
  for (let i = 0; i < n; i++) {
    yield { seed: Math.floor(r() * 0xffffffff), profile: { version: PROFILE_VERSION,
      watch: { drive: r(), onset: r(), texture: r(), arc: r(), contrast: r() } } };
  }
}
// The first song whose home family has a composed range.
const planned = (count = 1) => {
  const out = [];
  for (const s of songs(5000)) { const plan = planSongRange(s.profile, s.seed); if (plan) out.push({ ...s, plan }); if (out.length >= count) break; }
  return out;
};

test('the biome-to-family table matches the catalog builder', () => {
  assert.deepEqual({ ...BIOME_FAMILY }, { ...DEFAULT_PACKS });
});

test('a plan is deterministic, versioned, and fills every slot with a distinct fitting piece', () => {
  const byId = new Map(MASSIF_CATALOG.pieces.map((p) => [p.id, p]));
  for (const { seed, profile, plan } of planned(200)) {
    assert.deepEqual(planSongRange(profile, seed), plan);
    assert.equal(plan.version, SONG_RANGE_VERSION);
    assert.equal(plan.family, BIOME_FAMILY[chooseSongBiomes(profile, seed)[0]]);
    const template = MASSIF_CATALOG.templates.find((t) => t.id === plan.templateId);
    assert.ok(template.families.includes(plan.family), `${template.id} does not list ${plan.family}`);
    assert.equal(plan.slots.length, template.slots.length);
    assert.equal(new Set(plan.slots.map((s) => s.pieceId)).size, plan.slots.length, 'a piece repeated within a layout');
    for (const s of plan.slots) {
      const slot = template.slots.find((t) => t.id === s.slotId), piece = byId.get(s.pieceId);
      assert.equal(piece.family, plan.family);
      assert.ok(piece.tiles[0] <= slot.tiles[2] && piece.tiles[1] <= slot.tiles[3], `${piece.id} does not fit ${slot.id}`);
      assert.ok(piece.peakReliefM >= slot.reliefM[0] && (slot.reliefM[1] == null || piece.peakReliefM <= slot.reliefM[1]), `${piece.id} relief outside ${slot.id}`);
      assert.equal(typeof s.mirrored, 'boolean');
    }
    assert.equal(plan.principal.pieceId, plan.slots.find((s) => s.slotId === template.principalSlot).pieceId);
    assert.equal(plan.label, `World: ${plan.principal.name} range`);
    assert.equal(plan.baseM, template.lakeLevelM);
  }
});

test('every family plans; songs whose family has no pieces keep no plan; candidate order cannot change a plan', () => {
  // Phase 5 gave every family pieces, so the shipped catalog plans every song.
  // A catalog restricted to one family stands in for families with no pieces.
  const only = 'dry-conifer';
  const restricted = { ...MASSIF_CATALOG, pieces: MASSIF_CATALOG.pieces.filter((p) => p.family === only) };
  let none = 0, kept = 0;
  for (const { seed, profile } of songs(400)) {
    const plan = planSongRange(profile, seed);
    assert.ok(plan, `seed ${seed} has no plan with the shipped catalog`);
    const family = BIOME_FAMILY[chooseSongBiomes(profile, seed)[0]];
    const thin = planSongRange(profile, seed, { catalog: restricted });
    if (family === only) {
      kept++;
      // Other families' pieces never enter a plan, so removing them changes nothing.
      assert.deepEqual(thin, plan);
    } else {
      none++;
      assert.equal(thin, null, `${family} has no pieces but a plan`);
      // The diagnostic falls back to the first family that has pieces.
      const forced = planSongRange(profile, seed, { catalog: restricted, forced: true });
      assert.equal(forced.family, only);
      assert.equal(forced.forced, true);
      assert.equal(forced.biome, plan.biome);
    }
  }
  assert.ok(none > 0 && kept > 0, `${none} songs without pieces, ${kept} with`);
  const shuffled = { ...MASSIF_CATALOG, pieces: [...MASSIF_CATALOG.pieces].reverse(), templates: [...MASSIF_CATALOG.templates].reverse() };
  for (const { seed, profile, plan } of planned(50)) assert.equal(songRangeKey(planSongRange(profile, seed, { catalog: shuffled })), songRangeKey(plan));
});

test('a family with too few fitting pieces falls back to no plan', () => {
  const [{ seed, profile }] = planned(1);
  const thin = { ...MASSIF_CATALOG, pieces: MASSIF_CATALOG.pieces.slice(0, 3) };
  assert.equal(planSongRange(profile, seed, { catalog: thin }), null);
});

test('?songRange=1 is the switch; it defaults off', () => {
  assert.equal(songRangeEnabled(''), false);
  assert.equal(songRangeEnabled('?songRange=1'), true);
  assert.equal(songRangeEnabled('?songRange=on'), true);
  assert.equal(songRangeEnabled('?songRange=0'), false);
});

test('library labels: off by default, the principal massif with the flag, identical from compact records and full profiles', () => {
  let compared = 0, ranged = 0;
  for (const { seed, profile } of songs(10000, 7)) {
    // A full profile carries more than the five watch values; the plan must not depend on it.
    const full = { ...profile, tonal: { mode: 'minor', confidence: 0.9 }, durationMs: 200000, sections: [{ startMs: 0, endMs: 1 }] };
    const record = createSongWorldRecord(profile, seed);
    const off = describeSongWorld(record, { songRange: false });
    assert.ok(!off.songRange);
    const on = describeSongWorld(record, { songRange: true });
    const direct = planSongRange(full, seed);
    assert.equal(on.songRange?.key ?? null, songRangeKey(direct));
    if (direct) { ranged++; assert.equal(on.label, direct.label); assert.equal(on.experimental, true); }
    else assert.equal(on.label, off.label);
    compared++;
  }
  assert.equal(compared, 10000);
  assert.ok(ranged > 100, `${ranged} songs with a composed range`);
});

test('uniqueness statistics: unbiased shared-layout odds, a rule-of-three bound when nothing repeats', async () => {
  const { collisionStats, layoutBounds } = await import('../tools/song-range-uniqueness.mjs');
  const s = collisionStats(['a', 'a', 'b', 'b', null]);
  assert.equal(s.songs, 4);
  assert.equal(s.distinct, 2);
  assert.equal(s.pSharedLayout, (2 + 2) / (4 * 3));
  assert.equal(s.pSharedUpper95, null);
  const u = collisionStats(['a', 'b', 'c']);
  assert.equal(u.pSharedLayout, 0);
  assert.equal(u.pSharedUpper95, 3 / 3);
  const b = layoutBounds(MASSIF_CATALOG, 'dry-conifer');
  assert.ok(b.fitLowerBound <= b.fitUpperBound && b.fitUpperBound <= b.planFormulaCeiling);
});

test('the generated massif catalog matches the stage templates it was built from', async () => {
  const fs = await import('node:fs');
  const { plannableFamilies } = await import('../tools/build-song-range-pilot.mjs');
  const authored = JSON.parse(fs.readFileSync(new URL('../data/terrain/stage-templates.json', import.meta.url), 'utf8')).templates;
  // The builder publishes, per template, only the listed families whose pieces can fill it.
  const plannable = plannableFamilies(authored, MASSIF_CATALOG.pieces);
  const covered = new Set();
  for (const t of MASSIF_CATALOG.templates) {
    const a = authored.find((x) => x.id === t.id);
    assert.ok(a, `${t.id} missing from stage-templates.json`);
    assert.equal(t.principalSlot, a.principalSlot);
    assert.equal(t.lakeLevelM, a.lake.levelM);
    assert.deepEqual(t.families, plannable[t.id]);
    assert.deepEqual(t.families, a.families.filter((f) => t.families.includes(f)), `${t.id} families out of authored order`);
    assert.deepEqual(t.slots, a.slots.map((s) => ({ id: s.id, row: s.row, tiles: s.tiles, reliefM: s.reliefM ?? [0, null] })));
    for (const f of t.families) covered.add(f);
  }
  // Every home family has at least one template it can fill.
  assert.deepEqual([...covered].sort(), [...new Set(Object.values(BIOME_FAMILY))].sort());
});

// Synthetic one-family catalogs for the planner's fill paths. Fit is decided
// by relief range and footprint exactly as in the shipped catalog.
const SCORES = Object.freeze({ energy: 0.5, rawness: 0.5, grandeur: 0.5, dominance: 0.5 });
const HOME = 'dry-conifer';
const piece = (id, peakReliefM, { tiles = [4, 4], sourceView = `src-${id}` } = {}) =>
  ({ id, name: id.toUpperCase(), family: HOME, sourceView, tiles, peakReliefM, characterScores: SCORES });
const slot = (id, reliefM, width = 8) => ({ id, row: 'back', tiles: [0, 0, width, width], reliefM });
const stage = (slots, pieces) => ({ templates: [{ id: 'synthetic', families: [HOME], principalSlot: slots[0].id, lakeLevelM: 0, slots }], pieces });
const homeSongs = (() => {
  const out = [];
  for (const s of songs(4000, 3)) if (BIOME_FAMILY[chooseSongBiomes(s.profile, s.seed)[0]] === HOME) out.push(s);
  return out.slice(0, 120);
})();
const slotsOf = (plan) => Object.fromEntries(plan.slots.map((s) => [s.slotId, s.pieceId]));

test('the principal is never a piece the other slots need', () => {
  // x is the only piece that fits S; y and z fit only the principal slot.
  const catalog = stage([slot('P', [800, null]), slot('S', [800, 900])], [piece('x', 850), piece('y', 1500), piece('z', 1600)]);
  const principals = new Set();
  assert.ok(homeSongs.length >= 100);
  for (const { seed, profile } of homeSongs) {
    const plan = planSongRange(profile, seed, { catalog });
    assert.ok(plan, `seed ${seed} lost its range to a principal that strands S`);
    assert.notEqual(plan.principal.pieceId, 'x');
    assert.equal(slotsOf(plan).S, 'x');
    principals.add(plan.principal.pieceId);
  }
  assert.deepEqual([...principals].sort(), ['y', 'z']);
});

test('the principal pool counts fills that need a reassignment; a stranded slot is retried', () => {
  // a fits S1 and S2, b fits only S1, c only the principal slot. Taken in
  // template order S1 then S2, drawing a for S1 strands S2.
  const pieces = [piece('a', 1100), piece('b', 900), piece('c', 2500)];
  const strict = stage([slot('P', [2000, null]), slot('S1', [800, 1200]), slot('S2', [1000, 1200])], pieces);
  // The same draw with S2 relaxed to take b: S1's candidates, ticket and
  // region counts are unchanged, so its S1 pick is the strict first pass's.
  const relaxed = stage([slot('P', [2000, null]), slot('S1', [800, 1200]), slot('S2', [800, 1200])], pieces);
  let retried = 0, direct = 0;
  for (const { seed, profile } of homeSongs) {
    // Matching {a, b} to {S1, S2} needs a reassignment; a greedy check would empty the pool.
    const plan = planSongRange(profile, seed, { catalog: strict });
    assert.ok(plan, `seed ${seed} has no plan`);
    assert.equal(plan.principal.pieceId, 'c');
    assert.deepEqual(slotsOf(plan), { P: 'c', S1: 'b', S2: 'a' });
    const free = planSongRange(profile, seed, { catalog: relaxed });
    if (slotsOf(free).S1 === 'a') {
      retried++;
      // Each slot keeps its own mirror coin whichever order fills it.
      assert.deepEqual(plan.slots.map((s) => s.mirrored), free.slots.map((s) => s.mirrored));
    } else {
      direct++;
      // A layout the template order completes is unchanged by the retry.
      assert.equal(songRangeKey(plan), songRangeKey(free));
    }
  }
  assert.ok(retried > 0 && direct > 0, `${retried} retried, ${direct} direct`);
});

test('other slots prefer source regions used least', () => {
  // a shares the principal's source region; b comes from another.
  const catalog = stage([slot('P', [2000, null]), slot('S', [800, 1200])],
    [piece('a', 1000, { sourceView: 'one' }), piece('b', 1100, { sourceView: 'two' }), piece('c', 2500, { sourceView: 'one' })]);
  for (const { seed, profile } of homeSongs) assert.equal(slotsOf(planSongRange(profile, seed, { catalog })).S, 'b');
});

test('the retry takes the most constrained slot first, not just another order', () => {
  // a fits S1, S2 and S3; b only S1; d only S3. S2 (the middle slot) has one
  // candidate, so a must go there. Template order strands S2 when S1 draws a;
  // reversed template order strands it when S3 draws a. Only S2 first fills both.
  const pieces = [piece('a', 500), piece('b', 150), piece('d', 900), piece('p', 2500)];
  const strict = stage([slot('P', [2000, null]), slot('S1', [100, 600]), slot('S2', [400, 600]), slot('S3', [450, 1000])], pieces);
  // Probes for the draws each order makes first, with the same candidates,
  // tickets and region counts: S1 from {a, b} (S2 and S3 take anything left),
  // and S3 from {a, d} (S1 and S2 take only b and e).
  const probeS1 = stage([slot('P', [2000, null]), slot('S1', [100, 600]), slot('S2', [100, 1000]), slot('S3', [100, 1000])], pieces);
  const probeS3 = stage([slot('P', [2000, null]), slot('S1', [100, 200]), slot('S2', [40, 60]), slot('S3', [450, 1000])],
    [...pieces, piece('e', 50)]);
  let bothStrand = 0;
  for (const { seed, profile } of homeSongs) {
    const plan = planSongRange(profile, seed, { catalog: strict });
    assert.ok(plan, `seed ${seed} has no plan`);
    assert.deepEqual(slotsOf(plan), { P: 'p', S1: 'b', S2: 'a', S3: 'd' });
    if (slotsOf(planSongRange(profile, seed, { catalog: probeS1 })).S1 === 'a'
      && slotsOf(planSongRange(profile, seed, { catalog: probeS3 })).S3 === 'a') bothStrand++;
  }
  assert.ok(bothStrand > 0, 'no song where template order and reversed order both strand S2');
});

test('a plan is never a partial layout, even where the retry misses the fill', () => {
  // a fits S1 and S2, b fits S1 and S3, c fits S2 and S3. Every slot has two
  // candidates, so the retry keeps template order: b in S1 then c in S2 strands S3,
  // and that song keeps no plan although a -> S2, b -> S1, c -> S3 fills it.
  const big = { tiles: [8, 8] };
  const pieces = [piece('a', 120), piece('b', 220, big), piece('c', 320), piece('p', 2500)];
  const catalog = stage([slot('P', [2000, null]), slot('S1', [100, 250]), slot('S2', [100, 400], 6), slot('S3', [200, 400])], pieces);
  let none = 0, full = 0;
  for (const { seed, profile } of homeSongs) {
    const plan = planSongRange(profile, seed, { catalog });
    if (!plan) { none++; continue; }
    full++;
    const got = slotsOf(plan);
    assert.equal(got.P, 'p');
    assert.equal(new Set(Object.values(got)).size, 4);
    assert.ok(['a', 'b'].includes(got.S1) && ['a', 'c'].includes(got.S2) && ['b', 'c'].includes(got.S3), JSON.stringify(got));
  }
  // Some songs do lose their plan here today (a planner gap, not a rule), so
  // only the complete layouts are required.
  assert.ok(full > 0, `${none} without a plan, ${full} complete`);
});

test.todo('the planner fills a three-way cycle of slots for every song (the room-sorted retry can strand one)');
