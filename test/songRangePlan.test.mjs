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

test('songs without a family range keep no plan; candidate order cannot change a plan', () => {
  // Every family in the shipped catalog now has pieces, so the "no plan" case
  // comes from a catalog with some families' pieces removed.
  const families = [...new Set(MASSIF_CATALOG.pieces.map((p) => p.family))].sort();
  const dropped = new Set(families.filter((_, i) => i % 2 === 0));
  const restricted = { ...MASSIF_CATALOG, pieces: MASSIF_CATALOG.pieces.filter((p) => !dropped.has(p.family)) };
  let none = 0, some = 0;
  for (const { seed, profile } of songs(400)) {
    const family = BIOME_FAMILY[chooseSongBiomes(profile, seed)[0]];
    const plan = planSongRange(profile, seed, { catalog: restricted });
    if (!plan) {
      none++;
      assert.ok(!restricted.pieces.some((p) => p.family === family), `${family} has pieces but no plan`);
    } else {
      some++;
      assert.ok(!dropped.has(plan.family), `${plan.family} was removed but still planned`);
      // Removing other families' pieces cannot change this song's layout.
      assert.equal(songRangeKey(plan), songRangeKey(planSongRange(profile, seed)));
    }
  }
  assert.ok(none > 0 && some > 0, `${none} songs without a plan, ${some} with one`);
  const shuffled = { ...MASSIF_CATALOG, pieces: [...MASSIF_CATALOG.pieces].reverse(), templates: [...MASSIF_CATALOG.templates].reverse() };
  for (const { seed, profile, plan } of planned(50)) assert.equal(songRangeKey(planSongRange(profile, seed, { catalog: shuffled })), songRangeKey(plan));
});

// Hand-built catalog for the planner's constrained paths: one template, two
// slots, pieces that fit by size and relief.
const tinyCatalog = (pieces, { principalSlot = 'p', slots } = {}) => ({
  templates: [{ id: 't', families: ['dry-conifer'], principalSlot, lakeLevelM: 100,
    slots: slots ?? [{ id: 'p', row: 'front', tiles: [0, 0, 4, 4], reliefM: [0, null] }, { id: 'q', row: 'back', tiles: [0, 0, 2, 2], reliefM: [0, null] }] }],
  pieces: pieces.map((p) => ({ family: 'dry-conifer', sourceView: p.id, peakReliefM: 500, name: p.id, ...p })),
});
const dryConiferSong = () => {
  for (const s of songs(5000, 3)) if (BIOME_FAMILY[chooseSongBiomes(s.profile, s.seed)[0]] === 'dry-conifer') return s;
  throw new Error('no dry-conifer song');
};

test('the principal is never a piece the other slots need', () => {
  // "small" is the only piece that fits slot q; it also fits the principal
  // slot. The principal pool must leave it for q, whatever the ticket.
  const catalog = tinyCatalog([{ id: 'big', tiles: [4, 4] }, { id: 'small', tiles: [2, 2] }]);
  for (const { seed, profile } of songs(60, 5)) {
    const plan = planSongRange(profile, seed, { catalog, forced: true });
    assert.ok(plan, 'the layout is fillable');
    assert.equal(plan.principal.pieceId, 'big');
    assert.deepEqual(plan.slots.map((s) => s.pieceId), ['big', 'small']);
  }
  const { seed, profile } = dryConiferSong();
  assert.equal(planSongRange(profile, seed, { catalog: tinyCatalog([{ id: 'big', tiles: [4, 4] }]) }), null, 'one piece cannot fill two slots');
});

test('a slot order that strands a slot is retried most constrained first', () => {
  // Principal p takes "big". Slot a fits "mid" and "small"; slot b fits only
  // "small". Template order (a before b) strands b whenever a picks "small";
  // the retry fills b first and every layout completes.
  const slots = [{ id: 'p', row: 'front', tiles: [0, 0, 6, 6], reliefM: [600, null] }, { id: 'a', row: 'back', tiles: [0, 0, 3, 3], reliefM: [0, null] },
    { id: 'b', row: 'horizon', tiles: [0, 0, 2, 2], reliefM: [0, null] }];
  const catalog = tinyCatalog([{ id: 'big', tiles: [6, 6], peakReliefM: 900 }, { id: 'mid', tiles: [3, 3] }, { id: 'small', tiles: [2, 2] }], { slots });
  let plans = 0;
  for (const { seed, profile } of songs(80, 9)) {
    const plan = planSongRange(profile, seed, { catalog, forced: true });
    assert.ok(plan);
    assert.deepEqual(plan.slots.map((s) => s.pieceId), ['big', 'mid', 'small']);
    plans++;
  }
  assert.equal(plans, 80);
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
  const authored = JSON.parse(fs.readFileSync(new URL('../data/terrain/stage-templates.json', import.meta.url), 'utf8')).templates;
  const { plannableFamilies } = await import('../tools/build-song-range-pilot.mjs');
  const plannable = plannableFamilies(authored, MASSIF_CATALOG.pieces);
  for (const t of MASSIF_CATALOG.templates) {
    const a = authored.find((x) => x.id === t.id);
    assert.ok(a, `${t.id} missing from stage-templates.json`);
    assert.equal(t.principalSlot, a.principalSlot);
    assert.equal(t.lakeLevelM, a.lake.levelM);
    // The builder keeps the authored families whose pieces can fill the template.
    assert.deepEqual(t.families, plannable[t.id]);
    assert.ok(t.families.every((f) => a.families.includes(f)), `${t.id} lists a family it was not authored with`);
    assert.deepEqual(t.slots, a.slots.map((s) => ({ id: s.id, row: s.row, tiles: s.tiles, reliefM: s.reliefM ?? [0, null] })));
  }
});
