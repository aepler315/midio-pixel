import { regionDesign } from './InlandRegion.js';
import { TILE_CELLS } from '../alpine/TerrainTiles.js';
import { inlandCharacter } from './InlandTerrain.js';
import { rankScores } from './RangeMatcher.js';
import { outlineDistance } from './SongprintTerrain.js';
import { massifSkylines } from './songprintSkylines.js';

// The inland stage extends the catalog grid by 35 tiles on both axes.
export const INLAND_PAD_LOW = 17, INLAND_PAD_HIGH = 18;

// These ranks come from the elevation survey on each piece: rawness is
// topographic roughness, grandeur is relief. Equal readings share a rank.
export function surveyedSummitRanks(pieces) {
  const surveys = pieces.map(piece => ({ piece, scores: piece.characterScores }));
  return new Map([...rankScores(surveys)].map(([survey, ranks]) => [survey.piece, ranks]));
}

export function summitCharacterError(rank, character, loudness = character.relief, tension = character.ruggedness) {
  const relief = .65 * character.relief + .35 * loudness;
  const rough = .70 * character.ruggedness + .30 * tension;
  return .55 * (rank.grandeur - relief) ** 2 + .45 * (rank.rawness - rough) ** 2;
}

function summitEvents(song, sections) {
  const events = [];
  for (const s of sections ?? []) {
    if (!(s.confidence >= .5 && Number.isFinite(s.startMs) && s.endMs > s.startMs)) continue;
    events.push({ timeMs: (s.startMs + s.endMs) / 2, priority: s.kind === 'chorus' ? 4 : 3,
      family: Number.isInteger(s.familyId) ? 'lyric-' + s.familyId : null, kind: s.kind });
  }
  for (const [i, family] of song.families.entries()) {
    for (const timeMs of family.times) events.push({ timeMs, priority: 2, family: 'phrase-' + i });
  }
  for (let i = 0; i < song.loudness.length; i++)
    events.push({ timeMs: (i + .5) * song.stepMs, priority: 1, family: null });
  const count = Math.min(5, Math.max(2, Math.round(song.durationMs / 45000)));
  const selected = [];
  for (let i = 0; i < count; i++) {
    const start = i * song.durationMs / count, end = (i + 1) * song.durationMs / count;
    const strength = e => {
      const k = Math.min(song.loudness.length - 1, Math.floor(e.timeMs / song.stepMs));
      return .55 * song.loudness[k] + .45 * song.tension[k];
    };
    const candidates = events.filter(e => e.timeMs >= start && e.timeMs < end);
    candidates.sort((a, b) => b.priority - a.priority || strength(b) - strength(a)
      || Math.abs(a.timeMs - (start + end) / 2) - Math.abs(b.timeMs - (start + end) / 2));
    if (candidates.length) selected.push(candidates[0]);
  }
  return selected;
}

// Place intact tile blocks, including their zero-relief borders. Select the
// nearest available footprint on either bank with clearance along the flight.
export function measuredRange(template, catalog, inland, sections, biome, family) {
  if (!inland?.song?.measured) return null;
  const character = inlandCharacter(inland), { song } = inland;
  const ranks = surveyedSummitRanks(catalog.pieces.filter(p => p.peakReliefM >= 700 && massifSkylines[p.manifestSha256]));
  const pieces = [...ranks.keys()].sort((a, b) => a.id.localeCompare(b.id));
  if (pieces.length < 2) return null;
  const shapeErrors = new Map(pieces.map(p => [p, outlineDistance(inland.skyline, massifSkylines[p.manifestSha256].outline)]));
  const tileM = TILE_CELLS * template.grid.cellSizeM;
  const width = (template.grid.width - 1) / TILE_CELLS + INLAND_PAD_LOW + INLAND_PAD_HIGH;
  const height = (template.grid.height - 1) / TILE_CELLS + INLAND_PAD_LOW + INLAND_PAD_HIGH;
  const spine = regionDesign(inland, [], width * tileM / 2).spine;
  const route = spine.points.map(p => [p.x / tileM + width / 2, p.z / tileM + height / 2]);
  const byId = new Map(pieces.map(p => [p.id, p]));
  const families = new Map(), selectedIds = new Set(), slots = [];
  for (const e of summitEvents(song, sections)) {
    let piece = families.get(e.family);
    if (!piece) {
      const k = Math.min(song.loudness.length - 1, Math.floor(e.timeMs / song.stepMs));
      let best = Infinity;
      for (const candidate of pieces) {
        if (selectedIds.size < pieces.length && selectedIds.has(candidate.id)) continue;
        const error = summitCharacterError(ranks.get(candidate), character, song.loudness[k], song.tension[k])
          + .75 * shapeErrors.get(candidate);
        if (error < best) { best = error; piece = candidate; }
      }
    }
    const [w, h] = piece.tiles;
    const p = spine.pointAtArc(spine.arcAtTime(e.timeMs));
    const side = slots.length % 2 ? 1 : -1, offset = 1 + Math.max(w, h) / 2;
    const x0 = p.x / tileM + width / 2 - side * p.tz * offset - w / 2;
    const z0 = p.z / tileM + height / 2 + side * p.tx * offset - h / 2;
    let best = Infinity, tiles;
    for (let z = 0; z <= height - h; z++) for (let x = 0; x <= width - w; x++) {
      const cost = (x - x0) ** 2 + (z - z0) ** 2;
      if (cost >= best || slots.some(({ tiles: [a,b,c,d] }) => x < a+c && x+w > a && z < b+d && z+h > b)) continue;
      if (route.some(([a,b]) => a > x-.4 && a < x+w+.4 && b > z-.4 && b < z+h+.4)) continue;
      best = cost; tiles = [x,z,w,h];
    }
    if (!tiles) continue;
    selectedIds.add(piece.id);
    if (e.family) families.set(e.family, piece);
    slots.push({ slotId: template.slots[slots.length].id, pieceId: piece.id, tiles,
      timeMs: Math.round(e.timeMs), kind: e.kind ?? 'passage', family: e.family, mirrored: false });
    if (slots.length === template.slots.length) break;
  }
  if (slots.length < 2) return null;
  const hero = slots.reduce((a, b) => byId.get(b.pieceId).peakReliefM > byId.get(a.pieceId).peakReliefM ? b : a);
  const principal = { slotId: hero.slotId, pieceId: hero.pieceId, name: byId.get(hero.pieceId).name };
  return { version: 11, songprintVersion: 1, templateId: template.id, baseM: template.lakeLevelM, biome, family,
    inland, slots, principal, companionSlot: slots.find(s => s !== hero).slotId, label: principal.name + ' range' };
}
