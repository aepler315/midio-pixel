// The Range. Far is the Teton crest, near is the range east of Jackson
// Hole. Built by tools/build-terrain-profile.mjs. They are stacked, not
// one photograph. There is no middle ridge in this tile.
import raw from './tetonsFrontData.js';
import { profilesFromJSON } from './TerrainProfile.js';

let cached = null;

export function alpineTerrainProfiles() {
  if (!cached) {
    try { cached = profilesFromJSON(raw); }
    catch (error) {
      console.warn('[terrain] bundled profile rejected; using procedural fallback', error);
      cached = {};
    }
  }
  return cached;
}
