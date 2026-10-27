/** Opt into the experimental terrain-only pixel pipeline for visual review. */
export function directTerrainExperiment(search = '') {
  return new URLSearchParams(search).get('directTerrain') === '1';
}
