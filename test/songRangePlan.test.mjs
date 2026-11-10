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
  let none = 0;
  for (const { seed, profile } of songs(400)) {
    const plan = planSongRange(profile, seed);
    if (!plan) {
      none++;
      const family = BIOME_FAMILY[chooseSongBiomes(profile, seed)[0]];
      assert.ok(!MASSIF_CATALOG.pieces.some((p) => p.family === family), `${family} has pieces but no plan`);
    }
  }
  assert.ok(none > 0, 'some synthetic songs live in families with no pieces yet');
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
  const authored = JSON.parse(fs.readFileSync(new URL('../data/terrain/stage-templates.json', import.meta.url), 'utf8')).templates;
  for (const t of MASSIF_CATALOG.templates) {
    const a = authored.find((x) => x.id === t.id);
    assert.ok(a, `${t.id} missing from stage-templates.json`);
    assert.equal(t.principalSlot, a.principalSlot);
    assert.equal(t.lakeLevelM, a.lake.levelM);
    assert.deepEqual(t.families, a.families);
    assert.deepEqual(t.slots, a.slots.map((s) => ({ id: s.id, row: s.row, tiles: s.tiles, reliefM: s.reliefM ?? [0, null] })));
  }
});
