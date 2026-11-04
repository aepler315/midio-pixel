// Range v2: a view on its authored rail draws only the rail's own ground.
//
// A tour package also ships ground only its shot tour sees (`rail: false`,
// TerrainPackage railTile). TerrainMesh lays each band out so that the rail
// and the tour each draw one contiguous index range of the same buffers
// (`terrainRanges`, { rail: [start, count], tour: [start, count] }), and
// ForestCover puts the rail's trees first in every batch (`instanceCounts`,
// { rail, tour }). Switching a song's camera moves draw ranges and instance
// counts only: no rebuild, no upload.
//
// A geometry with ranges must always draw one mode: its whole buffer holds
// both the rail's and the tour's copy of the rail tiles that border coarser
// tour ground (TerrainMesh planBands).
//
//   tourGround(data)                    whether a package has tour ground
//   railGroundData(data)                the package as if it had none
//   setTerrainDrawMode(geometry, mode)  'rail' | 'tour'; no-op without ranges
//   drawnIndexCount(geometry)           indices its draw range covers

export const TERRAIN_MODES = Object.freeze(['rail', 'tour']);

/** Whether a decoded package ships ground only its shot tour sees. */
export function tourGround(data) {
  for (const t of data?.tiles?.values?.() || []) if (t.rail === false && t.visible !== false) return true;
  return false;
}

/** The decoded package without the ground only its tour sees: what a CPU
 *  bake (sun horizon, land hierarchy) reads for the rail. Tiles are shared,
 *  not copied. */
export function railGroundData(data) {
  const tiles = new Map([...data.tiles].filter(([, t]) => t.rail !== false));
  return { ...data, tiles, byIndex: new Map([...tiles.values()].map((t) => [`${t.ix},${t.iz}`, t])) };
}

/** Draw one mode of a geometry that carries `terrainRanges` (indexed or
 *  not) or `instanceCounts` (an instanced tree batch). */
export function setTerrainDrawMode(geometry, mode) {
  if (!TERRAIN_MODES.includes(mode)) throw new Error(`terrain draw mode ${mode}`);
  const { terrainRanges: r, instanceCounts: c } = geometry?.userData || {};
  if (r) geometry.setDrawRange(r[mode][0], r[mode][1]);
  if (c) geometry.instanceCount = c[mode];
}

/** How many indices (or vertices, unindexed) a geometry's draw range draws. */
export function drawnIndexCount(geometry) {
  const n = geometry?.index?.count ?? geometry?.attributes?.position?.count ?? 0;
  const { start, count } = geometry.drawRange;
  return Math.max(0, Math.min(n, start + count) - Math.max(0, start));
}
