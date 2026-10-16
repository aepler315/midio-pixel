// A north-up lat/lon elevation raster into the square meter grid the
// skyline scan samples. Local equirectangular meters are enough for one
// range: this is not a national projection. Row 0 of the source is north.

const M_PER_DEG_LAT = 110540;

export function metersPerDegree(south, north) {
  const lat0 = ((south + north) / 2) * Math.PI / 180;
  return { mPerDegLon: 111320 * Math.cos(lat0), mPerDegLat: M_PER_DEG_LAT };
}

/** Lat/lon points into the same meter space as demFromLatLon. */
export function projectLatLon(points, { west, south, north }) {
  const { mPerDegLon, mPerDegLat } = metersPerDegree(south, north);
  return points.map((p) => ({
    x: (p.lon - west) * mPerDegLon,
    y: (p.lat - south) * mPerDegLat,
  }));
}

function bilinear(elev, width, height, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const at = (ix, iy) => {
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return NaN;
    const v = elev[iy * width + ix];
    return Number.isFinite(v) ? v : NaN;
  };
  let acc = 0;
  let wsum = 0;
  const take = (v, w) => {
    if (!Number.isFinite(v) || w <= 0) return;
    acc += v * w;
    wsum += w;
  };
  take(at(x0, y0), (1 - tx) * (1 - ty));
  take(at(x0 + 1, y0), tx * (1 - ty));
  take(at(x0, y0 + 1), (1 - tx) * ty);
  take(at(x0 + 1, y0 + 1), tx * ty);
  return wsum > 0 ? acc / wsum : NaN;
}

/** @param {object} src north-up grid, row 0 at `north` */
export function demFromLatLon(src, cellM = 150) {
  const { elev, width, height, west, south, east, north } = src;
  if (!(east > west) || !(north > south) || !(cellM > 0)) {
    throw new Error('demFromLatLon needs a non-empty lat/lon extent');
  }
  const { mPerDegLon, mPerDegLat } = metersPerDegree(south, north);
  const widthM = (east - west) * mPerDegLon;
  const heightM = (north - south) * mPerDegLat;
  const gw = Math.max(2, Math.ceil(widthM / cellM));
  const gh = Math.max(2, Math.ceil(heightM / cellM));
  const out = new Float64Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    const yM = (j + 0.5) * cellM;
    const lat = south + yM / M_PER_DEG_LAT;
    const sy = ((north - lat) / (north - south)) * (height - 1);
    for (let i = 0; i < gw; i++) {
      const xM = (i + 0.5) * cellM;
      const lon = west + xM / mPerDegLon;
      const sx = ((lon - west) / (east - west)) * (width - 1);
      out[j * gw + i] = bilinear(elev, width, height, sx, sy);
    }
  }
  return {
    elev: out,
    width: gw,
    height: gh,
    cellM,
    originX: cellM / 2,
    originY: cellM / 2,
    west, south, east, north,
    widthM, heightM,
  };
}

/** One point per row: the highest cell. This is a crest trace, not a
 *  skyline. Rows are thinned so the polyline is about one point per
 *  `stepM` of northing. */
/**
 * A crest guide that follows ONE ridge. crestGuideFromDem takes the highest
 * cell in each row independently, and in any box holding parallel ridges
 * that hops between them: on the Teton box it jumped 3km or more between
 * consecutive rows eleven times in 74, so the scan corridor zig-zagged and
 * the skyline came out as flat ground cut by square spikes. That is why the
 * Tetons needed hand-authored guides, and why no other range was built.
 *
 * This is a best path instead (seam carving / Viterbi): each row picks the
 * column that maximises elevation minus `jumpCostM` per cell of sideways
 * move from the previous row, with moves capped at `maxShiftM` per row.
 * A jump to another ridge now happens only when that ridge is higher by
 * more than the jump costs.
 */
export function crestGuideTraced(dem, stepM = 500, { jumpCostM = 45, maxShiftM = 1500 } = {}) {
  const stride = Math.max(1, Math.round(stepM / dem.cellM));
  const W = dem.width;
  const maxShift = Math.max(1, Math.round(maxShiftM / dem.cellM));
  const rows = [];
  for (let y = 0; y < dem.height; y += stride) rows.push(y);
  const at = (x, y) => {
    const v = dem.elev[y * W + x];
    return Number.isFinite(v) ? v : -1e6;
  };
  let score = new Float64Array(W);
  for (let x = 0; x < W; x++) score[x] = at(x, rows[0]);
  const back = [];
  for (let r = 1; r < rows.length; r++) {
    const next = new Float64Array(W);
    const from = new Int32Array(W);
    for (let x = 0; x < W; x++) {
      let best = -Infinity, bx = x;
      const lo = Math.max(0, x - maxShift), hi = Math.min(W - 1, x + maxShift);
      for (let px = lo; px <= hi; px++) {
        const v = score[px] - jumpCostM * Math.abs(x - px);
        if (v > best) { best = v; bx = px; }
      }
      next[x] = best + at(x, rows[r]);
      from[x] = bx;
    }
    back.push(from);
    score = next;
  }
  let x = 0;
  for (let i = 1; i < W; i++) if (score[i] > score[x]) x = i;
  const cols = new Array(rows.length);
  cols[rows.length - 1] = x;
  for (let r = rows.length - 1; r > 0; r--) { x = back[r - 1][x]; cols[r - 1] = x; }
  const pts = [];
  rows.forEach((y, r) => {
    const elev = dem.elev[y * W + cols[r]];
    if (!Number.isFinite(elev)) return;
    pts.push({ x: dem.originX + cols[r] * dem.cellM, y: dem.originY + y * dem.cellM, elev });
  });
  if (pts.length < 2) throw new Error('crest guide needs two rows of elevation');
  return pts;
}

export function crestGuideFromDem(dem, stepM = 400) {
  const stride = Math.max(1, Math.round(stepM / dem.cellM));
  const pts = [];
  for (let y = 0; y < dem.height; y += stride) {
    let best = -Infinity;
    let bx = 0;
    for (let x = 0; x < dem.width; x++) {
      const v = dem.elev[y * dem.width + x];
      if (Number.isFinite(v) && v > best) {
        best = v;
        bx = x;
      }
    }
    if (!Number.isFinite(best)) continue;
    pts.push({
      x: dem.originX + bx * dem.cellM,
      y: dem.originY + y * dem.cellM,
      elev: best,
    });
  }
  if (pts.length < 2) throw new Error('crest guide needs two rows of elevation');
  return pts;
}
