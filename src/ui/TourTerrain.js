/** The Teton highway tour casts a single biome; every other policy uses
 * the song's ordinary assignment, including after a temporary tour render. */
export function applyTerrainTourPolicy(terrain, cameraTourMode, worldKind) {
  if (!terrain) return;
  if (cameraTourMode === 'tetons' && worldKind === 'alpine') {
    terrain._rangeTourOriginalBiomes ||= [...(terrain.biomes || [])];
    terrain.biomes = ['CONIFER'];
  } else if (terrain._rangeTourOriginalBiomes) {
    terrain.biomes = terrain._rangeTourOriginalBiomes;
    delete terrain._rangeTourOriginalBiomes;
  }
}

/** Policy changes replace these values; retaining their original references
 * and own-property presence also preserves legacy/absent marker states. */
export function captureTourTerrainState(terrain) {
  if (!terrain) return null;
  return { terrain, fields: ['biomes', '_rangeTourOriginalBiomes'].map(key => ({
    key, present: Object.hasOwn(terrain, key), value: terrain[key],
  })) };
}

export function restoreTourTerrainState(saved) {
  if (!saved) return;
  for (const { key, present, value } of saved.fields) {
    if (present) saved.terrain[key] = value;
    else delete saved.terrain[key];
  }
}
