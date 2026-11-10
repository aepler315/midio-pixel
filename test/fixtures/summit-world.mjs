// A synthetic prepared view for the opening's summit search (BuildFocus.js)
// and the line-of-sight test under it (LineOfSight.js): a 12.8 km square of
// terrain, 8 x 8 tiles of 32 cells at 50 m, with its heights from
// `height(x, z)` and its water (flow byte 255, at LEVEL) where `wet(x, z)`.
// The rail stands 1.5 km outside the z = 0 edge, looking along +z.
export const LEVEL = 1000;

export function summitWorld(height, wet = () => false) {
  const cells = 32, cellSizeM = 50, tilesX = 8, tilesZ = 8, n = cells + 1;
  const tiles = new Map(), byIndex = new Map();
  for (let iz = 0; iz < tilesZ; iz++) for (let ix = 0; ix < tilesX; ix++) {
    const heightsM = new Float32Array(n * n), flowBytes = new Uint8Array(n * n);
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
      const x = (ix * cells + u) * cellSizeM, z = (iz * cells + v) * cellSizeM;
      const w = wet(x, z);
      heightsM[v * n + u] = w ? LEVEL : height(x, z);
      flowBytes[v * n + u] = w ? 255 : 10;
    }
    const t = { id: `${ix}_${iz}`, ix, iz, samples: n, stride: 1, visible: true, band: 'mid', heightsM, flowBytes };
    tiles.set(t.id, t);
    byIndex.set(`${ix},${iz}`, t);
  }
  const data = { tiles, byIndex, cells, grid: { originM: [0, 0], cellSizeM }, manifest: { tilesX, tilesZ } };
  const view = { id: 'test', camera: { eyeStartM: [6300, 1900, -1500], eyeEndM: [6500, 1900, -1400],
    targetStartM: [6400, 1100, 6400], targetEndM: [6450, 1100, 6400], fovYDeg: 40 } };
  return { data, view };
}

/** A cone 1.5 km tall, 2.5 km round, at the back of the valley; its top is
 *  (6400, LEVEL + 1505, 8000). */
export const cone = (x, z) => LEVEL + 5 + Math.max(0, 1500 * (1 - Math.hypot(x - 6400, z - 8000) / 2500));
/** A lake in front of the cone. */
export const lake = (x, z) => Math.hypot((x - 6400) / 2, z - 4300) < 900;
