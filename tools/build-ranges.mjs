// Build the range basket from data/terrain/ranges.json (hand-curated) and
// data/terrain/discovered.json (found by tools/discover-ranges.mjs).
//
//   node tools/build-ranges.mjs            # every range
//   node tools/build-ranges.mjs fuji rainier
//   node tools/build-ranges.mjs --missing  # only ranges not built yet
//
// For each range: fetch real elevation (fetch-terrain-grid.mjs), build the
// skyline profile (build-terrain-profile.mjs, which traces the crest and
// picks the camera side), score it (RangeCharacter.js), and write it to
// src/world/terrain/ranges/<id>.js. Then regenerate
// src/world/terrain/ranges/index.js: metadata and scores for EVERY range,
// small enough to load up front, with each range's profile behind its own
// dynamic import so only the chosen one is ever downloaded. That split is
// what lets the basket hold hundreds of ranges.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTerrainGrid } from './fetch-terrain-grid.mjs';
import { rangeAxisDeg, rangeElongation, rotateGrid, valleyCameraElevM } from './lib/terrarium.mjs';
import { MAX_FLOOR_SHARE, rangeCharacter, skylineQuality } from '../src/world/terrain/RangeCharacter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'data/terrain/ranges.json'), 'utf8'));
const discoveredPath = path.join(root, 'data/terrain/discovered.json');
const discovered = existsSync(discoveredPath) ? JSON.parse(readFileSync(discoveredPath, 'utf8')).ranges : [];
// A hand-curated entry wins over a discovered one with the same id.
const allRanges = [...manifest.ranges, ...discovered.filter((d) => !manifest.ranges.some((r) => r.id === d.id))];
const outDir = path.join(root, 'src/world/terrain/ranges');
const gridDir = path.join(root, '.terrain-cache/grids');
mkdirSync(outDir, { recursive: true });
mkdirSync(gridDir, { recursive: true });

const args = process.argv.slice(2);
const only = new Set(args.filter((a) => !a.startsWith('--')));
const missingOnly = args.includes('--missing');
const rejected = [];
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

// The skyline builder assumes a north-south crest. A range on any other
// bearing (the Cordillera Blanca runs ~30 deg off north; the Alps and the
// Himalaya run east-west) is rotated so its own axis runs up the grid. The
// extent is recomputed around the same centre to match the rotated grid's
// metric size, because the builder reads cell geometry from it; the result
// is range-aligned rather than north-up, and its meta says so.
// Resolution. Terrarium z12 is ~25-35m per pixel across North America,
// the finest the AWS tiles carry everywhere without the tile count
// exploding, so the grid is resampled at 30m and a skyline station is taken
// every 30m: ~1,500-2,500 samples a range, one every 4-5px of the 8192px
// strip the game draws it on, which is as fine as that strip's crest line
// goes. (It was z11, 200m cells and a station every 400m: ~180 samples,
// drawn as long straight segments.) Scoring pools back to 400m
// (RangeCharacter.SCORE_SPACING_M).
const ZOOM = 12;
const CELL_M = 30;
const SPACING_M = 30;

const ALIGN_MIN_DEG = 12;
const ALIGN_MIN_ELONGATION = 1.8;
function alignToRange(grid, range) {
  const buf = Buffer.from(grid.elevB64, 'base64');
  const elev = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const shape = { width: grid.width, height: grid.height, elev };
  // Camera height from THIS range's valley floor, not a fixed 2,200m.
  const cameraElevM = range.cameraElevM ?? valleyCameraElevM(shape);
  const axisDeg = range.axisDeg ?? rangeAxisDeg(shape);
  const elongation = rangeElongation(shape);
  // Only a genuinely elongated range has an axis to align. A cone or a round
  // massif reads a bearing from noise, and rotating on noise helps nothing.
  const aligned = range.axisDeg != null || (elongation >= ALIGN_MIN_ELONGATION && Math.abs(axisDeg) >= ALIGN_MIN_DEG);
  if (!aligned) return { ...grid, cameraElevM, axisDeg: Math.round(axisDeg), elongation: round(elongation, 2) };
  const rot = rotateGrid({ width: grid.width, height: grid.height, elev }, axisDeg);
  const lat0 = ((grid.south + grid.north) / 2) * Math.PI / 180;
  const cLon = (grid.west + grid.east) / 2, cLat = (grid.south + grid.north) / 2;
  const halfLon = (rot.width * grid.cellM) / (111320 * Math.cos(lat0)) / 2;
  const halfLat = (rot.height * grid.cellM) / 110540 / 2;
  return {
    ...grid,
    west: cLon - halfLon, east: cLon + halfLon, south: cLat - halfLat, north: cLat + halfLat,
    width: rot.width, height: rot.height,
    elevB64: Buffer.from(rot.elev.buffer).toString('base64'),
    cameraElevM,
    axisDeg: Math.round(axisDeg),
    rotatedDeg: Math.round(axisDeg),
    elongation: round(elongation, 2),
    horizontalReference: `${grid.horizontalReference}; rotated ${Math.round(axisDeg)} deg so the range axis runs up the grid (not north-up)`,
  };
}

for (const range of allRanges) {
  if (only.size && !only.has(range.id)) continue;
  if (missingOnly && existsSync(path.join(outDir, `${range.id}.meta.json`))) continue;
  // A rejected build leaves nothing behind: an old good build of the same
  // id is removed too, so the index can never serve a range that no longer
  // passes.
  const reject = (why) => {
    rejected.push(`${range.id}: ${why}`);
    for (const ext of ['.js', '.meta.json']) rmSync(path.join(outDir, `${range.id}${ext}`), { force: true });
  };
  // One range failing (a tile that will not download, a grid the builder
  // chokes on) must not stop a run over a hundred others.
  try {
    await buildRange(range, reject);
  } catch (err) {
    reject(`build failed: ${err.message.split('\n')[0]}`);
  }
}

async function buildRange(range, reject) {
  let profilePath = range.profile ? path.join(root, range.profile) : null;
  if (!profilePath) {
    const [west, south, east, north] = range.bbox;
    const gridPath = path.join(gridDir, `${range.id}.json`);
    // Far north a tile covers less ground, so the same box needs more of
    // them; there z11 is already as fine as z12 is further south.
    const bbox = { west, south, east, north };
    let fetched;
    try {
      fetched = await fetchTerrainGrid({ bbox, zoom: ZOOM, cellM: CELL_M });
    } catch (err) {
      if (!/too many/.test(err.message)) throw err;
      fetched = await fetchTerrainGrid({ bbox, zoom: ZOOM - 1, cellM: CELL_M });
    }
    const grid = alignToRange(fetched, range);
    grid.spacingM = range.spacingM ?? SPACING_M;
    if (range.side) grid.side = range.side;
    writeFileSync(gridPath, JSON.stringify(grid));
    profilePath = path.join(gridDir, `${range.id}-profile.json`);
    execFileSync(process.execPath, [path.join(root, 'tools/build-terrain-profile.mjs'), gridPath, profilePath],
      { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  // Seven significant figures: elevations to 0.1mm, angles to a millionth
  // of a degree. The raw values are single-precision elevations printed at
  // full double length, which eslint's no-loss-of-precision rejects in the
  // generated modules -- and the extra digits are only noise. Rounded
  // BEFORE scoring, so the scores describe exactly the profile that ships.
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'),
    (_, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(7)) : v));
  const character = rangeCharacter(profile);
  const quality = skylineQuality(profile);
  if (!character) { reject('no usable skyline'); return; }
  if (quality.floorShare > MAX_FLOOR_SHARE) {
    reject(`skyline sits on its own floor for ${Math.round(quality.floorShare * 100)}% of its length`);
    return;
  }
  if (!quality.usable) {
    reject(`a needle or wall the ground does not back up (artifact ${round(quality.artifact, 2)})`);
    return;
  }
  writeFileSync(path.join(outDir, `${range.id}.js`),
    `// Generated by tools/build-ranges.mjs from data/terrain/ranges.json. Do not edit.\n`
    + `export default ${JSON.stringify(profile)};\n`);
  const entry = {
    id: range.id, name: range.name, landmark: range.landmark || null, region: range.region, bbox: range.bbox,
    source: range.summit ? 'discovered' : 'curated',
    archetype: character.archetype, mood: character.mood,
    quality: { floorShare: round(quality.floorShare, 2), artifact: round(quality.artifact, 2) },
    scores: Object.fromEntries(Object.entries(character.scores).map(([k, v]) => [k, round(v)])),
    features: Object.fromEntries(Object.entries(character.features).map(([k, v]) => [k, round(v, 1)])),
  };
  writeFileSync(path.join(outDir, `${range.id}.meta.json`), JSON.stringify(entry, null, 2) + '\n');
  console.log(`${range.id.padEnd(18)} ${entry.archetype.padEnd(9)} ${JSON.stringify(entry.scores)}`);
}

// A range dropped from both lists (or renamed) leaves no build behind.
for (const f of readdirSync(outDir)) {
  const id = f.replace(/\.meta\.json$|\.js$/, '');
  if (f !== 'index.js' && !allRanges.some((r) => r.id === id)) rmSync(path.join(outDir, f), { force: true });
}

// The index covers every built range, not just the ones rebuilt this run.
const metas = readdirSync(outDir).filter((f) => f.endsWith('.meta.json')).sort()
  .map((f) => JSON.parse(readFileSync(path.join(outDir, f), 'utf8')))
  .filter((m) => allRanges.some((r) => r.id === m.id) && existsSync(path.join(outDir, `${m.id}.js`)));
// The index carries only what matching and the caption need; bbox, raw
// features and quality stay in each range's .meta.json. With a hundred
// ranges the full metadata would add ~50KB to every page load.
const indexEntries = metas.map(({ id, name, landmark, region, source, archetype, mood, scores, features }) => ({
  id, name, landmark, region, source, archetype, mood, scores,
  // For the caption's stats: how much real skyline was sampled.
  lengthKm: features?.lengthKm ?? null,
  // Which ridge the range can stand on: high, mid or low relief
  // (RangeMatcher.RIDGE_BANDS).
  reliefM: features?.reliefM ?? null,
}));
const loaders = metas.map((m) => `  ${JSON.stringify(m.id)}: () => import('./${m.id}.js'),`).join('\n');
writeFileSync(path.join(outDir, 'index.js'),
  `// Generated by tools/build-ranges.mjs from data/terrain/ranges.json. Do not edit.\n`
  + `// Every range's scores up front; each profile behind its own import.\n`
  + `export const RANGES = ${JSON.stringify(indexEntries, null, 1)};\n\n`
  + `export const LOADERS = {\n${loaders}\n};\n`);
console.log(`index: ${metas.length} ranges`);
if (rejected.length) console.log(`rejected (not in the index):\n  ${rejected.join('\n  ')}`);
// Refresh the small foreground-selection table whenever scans change.
await import('./build-range-shapes.mjs');
