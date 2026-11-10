// How unique are composed song ranges? (Song range composition, Phase 2.)
//
//   node tools/song-range-uniqueness.mjs [--samples N] [--out FILE]
//
// Plans N synthetic songs (seeded watch values and seeds) and the 16-track
// evaluation corpus (each track's watch values with N/16 seeds), and reports
// for the current massif catalog: the share of songs that get a composed
// range, distinct layouts, the chance two given songs share a layout, the
// expected number of colliding pairs in libraries of 500 and 5,000, and the
// share of the most common principal massif. For context it reports the same
// collision figures for today's home catalog views. Pure planning: no
// terrain is read.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSongRange, songRangeKey, SONG_RANGE_VERSION } from '../src/world/terrain/SongRangePlan.js';
import { planSongScenes } from '../src/world/terrain/SongScenePlan.js';
import MASSIF_CATALOG from '../src/world/terrain/massifCatalogData.js';
import { PROFILE_VERSION } from '../src/audio/SongProfile.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function* syntheticSongs(n, salt = 1) {
  let s = (0x9e3779b9 * salt) >>> 0;
  const r = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0; return s / 4294967296; };
  for (let i = 0; i < n; i++) {
    yield { seed: Math.floor(r() * 0xffffffff), profile: { version: PROFILE_VERSION,
      watch: { drive: r(), onset: r(), texture: r(), arc: r(), contrast: r() } } };
  }
}

export async function* corpusSongs(n) {
  const corpus = JSON.parse(await fs.readFile(path.join(root, 'test/fixtures/world-evaluation.json'), 'utf8'));
  const per = Math.max(1, Math.round(n / corpus.tracks.length));
  for (const t of corpus.tracks) {
    const f = t.features;
    const profile = { version: PROFILE_VERSION, watch: { drive: f.drive, onset: f.onset, texture: f.texture, arc: f.arc, contrast: f.contrast } };
    for (let k = 0; k < per; k++) yield { seed: (Math.imul(k + 1, 0x9e3779b1) ^ hash(t.id)) >>> 0, profile, track: t.id };
  }
}
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; }

/** Collision statistics of a list of keys (null = no key, excluded). */
export function collisionStats(keys) {
  const counts = new Map();
  let n = 0;
  for (const k of keys) if (k != null) { n++; counts.set(k, (counts.get(k) || 0) + 1); }
  // Unbiased estimate of sum p_k^2 from the sample.
  let pairs = 0;
  for (const c of counts.values()) pairs += c * (c - 1);
  const pShare = n > 1 ? pairs / (n * (n - 1)) : 0;
  // With no repeat observed the point estimate is 0; report the 95% upper
  // bound on a uniform pair probability (rule of three) instead of claiming 0.
  const pairCount = n * (n - 1) / 2;
  const pUpper95 = pairs === 0 && pairCount > 0 ? 3 / pairCount : null;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0] || [null, 0];
  return { songs: n, distinct: counts.size, pSharedLayout: pShare, pSharedUpper95: pUpper95, top: { key: top[0], share: n ? top[1] / n : 0 } };
}

const expectedPairs = (songsWithKey, p) => songsWithKey * (songsWithKey - 1) / 2 * p;

/** Counting bounds for one template, with the planner's fit rules. */
export function layoutBounds(catalog, family) {
  const t = catalog.templates.find((x) => x.families.includes(family));
  if (!t) return null;
  const pieces = catalog.pieces.filter((p) => p.family === family);
  const fits = (slot, p) => p.tiles[0] <= slot.tiles[2] && p.tiles[1] <= slot.tiles[3]
    && p.peakReliefM >= (slot.reliefM?.[0] ?? 0) && (slot.reliefM?.[1] == null || p.peakReliefM <= slot.reliefM[1]);
  const sizes = t.slots.map((s) => pieces.filter((p) => fits(s, p)).length);
  const K = t.slots.length, P = pieces.length;
  const mirror = 2 ** K;
  // The plan's formula ignores fit: p!/(p-K)! * 2^K.
  let ceiling = 1; for (let i = 0; i < K; i++) ceiling *= Math.max(0, P - i);
  const upper = sizes.reduce((a, b) => a * b, 1);
  // Filling the smallest slots first and removing every earlier pick is a lower bound.
  const lower = [...sizes].sort((a, b) => a - b).reduce((a, s, i) => a * Math.max(0, s - i), 1);
  return { template: t.id, family, pieces: P, slots: K, fitPerSlot: Object.fromEntries(t.slots.map((s, i) => [s.id, sizes[i]])),
    planFormulaCeiling: ceiling * mirror, fitUpperBound: upper * mirror, fitLowerBound: lower * mirror };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const N = Number(opt('--samples', 10000));
  const out = path.resolve(opt('--out', path.join(root, '.smoke', 'song-range-uniqueness.json')));
  const families = [...new Set(MASSIF_CATALOG.pieces.map((p) => p.family))];
  const report = { songRangeVersion: SONG_RANGE_VERSION, samples: N,
    catalog: { pieces: MASSIF_CATALOG.pieces.length, families: Object.fromEntries(families.map((f) => [f, MASSIF_CATALOG.pieces.filter((p) => p.family === f).length])),
      templates: MASSIF_CATALOG.templates.map((t) => t.id) },
    bounds: families.map((f) => layoutBounds(MASSIF_CATALOG, f)), sets: {} };
  for (const [name, gen] of [['synthetic', syntheticSongs(N)], ['corpus', corpusSongs(N)]]) {
    const ranges = [], principals = [], views = [];
    let total = 0;
    for await (const s of gen) {
      total++;
      const plan = planSongRange(s.profile, s.seed);
      ranges.push(songRangeKey(plan));
      principals.push(plan?.principal.pieceId ?? null);
      const scenes = planSongScenes(s.profile, s.seed);
      views.push(scenes.sceneByBiome.get(scenes.home)?.view?.id ?? null);
    }
    const r = collisionStats(ranges), p = collisionStats(principals), v = collisionStats(views);
    const share = r.songs / total;
    report.sets[name] = {
      songs: total, shareWithRange: share,
      ranges: { ...r, top: undefined,
        expectedCollidingPairs: Object.fromEntries([500, 5000].map((L) => [L, expectedPairs(L * share, r.pSharedLayout)])),
        ...(r.pSharedUpper95 != null ? { expectedCollidingPairsUpper95: Object.fromEntries([500, 5000].map((L) => [L, expectedPairs(L * share, r.pSharedUpper95)])) } : {}) },
      principal: { distinct: p.distinct, mostCommon: p.top.key, mostCommonShare: p.top.share },
      catalogViewsForContext: { distinct: v.distinct, pSharedView: v.pSharedLayout,
        expectedCollidingPairs: Object.fromEntries([500, 5000].map((L) => [L, expectedPairs(L, v.pSharedLayout)])),
        mostCommon: v.top.key, mostCommonShare: v.top.share },
    };
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  const fmt = (x) => (x >= 1e6 ? x.toExponential(2) : Number.isInteger(x) ? String(x) : x.toPrecision(3));
  for (const b of report.bounds) {
    console.log(`${b.family} on ${b.template}: ${b.pieces} pieces, ${b.slots} slots; fit per slot ${JSON.stringify(b.fitPerSlot)}`);
    console.log(`  plan formula p!/(p-K)!*2^K ${fmt(b.planFormulaCeiling)}; with fit rules between ${fmt(b.fitLowerBound)} and ${fmt(b.fitUpperBound)}`);
  }
  for (const [name, s] of Object.entries(report.sets)) {
    console.log(`${name}: ${s.songs} songs, ${(100 * s.shareWithRange).toFixed(1)}% get a composed range; ${s.ranges.distinct} distinct layouts among ${s.ranges.songs}`);
    if (s.ranges.pSharedUpper95 != null) console.log(`  no two ranged songs shared a layout; 95% upper bound P(shared) ${fmt(s.ranges.pSharedUpper95)}, so at most ${fmt(s.ranges.expectedCollidingPairsUpper95[500])} colliding pairs in a 500-song library and ${fmt(s.ranges.expectedCollidingPairsUpper95[5000])} in 5,000`);
    else console.log(`  P(two ranged songs share a layout) ${fmt(s.ranges.pSharedLayout)}; expected colliding pairs: 500-song library ${fmt(s.ranges.expectedCollidingPairs[500])}, 5,000 ${fmt(s.ranges.expectedCollidingPairs[5000])}`);
    console.log(`  principal massifs: ${s.principal.distinct} distinct; most common ${s.principal.mostCommon} at ${(100 * s.principal.mostCommonShare).toFixed(1)}%`);
    console.log(`  context, catalog home views: ${s.catalogViewsForContext.distinct} distinct; P(shared) ${fmt(s.catalogViewsForContext.pSharedView)}; colliding pairs in 500 songs ${fmt(s.catalogViewsForContext.expectedCollidingPairs[500])}`);
  }
  console.log(`report: ${path.relative(root, out)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
