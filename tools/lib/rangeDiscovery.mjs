// Finding mountain ranges automatically, from a list of named summits.
//
// The pure half of tools/discover-ranges.mjs: nothing here touches the
// network or the disk, so every rule can be tested with made-up peaks.
//
// The idea: a summit list (GeoNames) says where the named mountains are, but
// not which ones make a skyline worth looking at. So the list is thinned to
// the highest summit in each grid cell, each survivor's local relief (how far
// the ground falls away around it) is measured from real elevation, and the
// basket is filled from those, spread out so no two ranges sit on top of
// each other and so gentle ranges get a share alongside the giants.

const KM_PER_DEG_LAT = 110.54;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle-ish distance in km; accurate enough under a few hundred km. */
export function distanceKm(a, b) {
  const dLat = (a.lat - b.lat) * KM_PER_DEG_LAT;
  const dLon = (a.lon - b.lon) * 111.32 * Math.cos(toRad((a.lat + b.lat) / 2));
  return Math.hypot(dLat, dLon);
}

// GeoNames feature codes kept: MT mountain (every US summit is coded MT),
// PK peak, PKS peaks, VLC volcano.
const SUMMIT_CODES = new Set(['MT', 'PK', 'PKS', 'VLC']);

/** One row of a GeoNames country dump, or null if it is not a summit.
 *  Elevation prefers the surveyed value over the SRTM one. */
export function parseGeonamesRow(line) {
  const f = line.split('\t');
  if (f.length < 17 || f[6] !== 'T') return null;
  const code = f[7];
  if (!SUMMIT_CODES.has(code)) return null;
  const lat = Number(f[4]), lon = Number(f[5]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const surveyed = Number(f[15]), dem = Number(f[16]);
  const elevM = f[15] !== '' && surveyed > 0 ? surveyed : (f[16] !== '' && dem > -9999 ? dem : NaN);
  return {
    geonameId: Number(f[0]), name: f[1], lat, lon, code,
    country: f[8], admin1: f[10], elevM,
  };
}

/** The highest summit in each `cellDeg` square, ignoring any below
 *  `minElevM`. Cuts ~100k summits to a few thousand worth measuring. */
export function highestPerCell(summits, cellDeg = 0.5, minElevM = 500) {
  const best = new Map();
  for (const s of summits) {
    if (!(s.elevM >= minElevM)) continue;
    const key = `${Math.floor(s.lat / cellDeg)},${Math.floor(s.lon / cellDeg)}`;
    const cur = best.get(key);
    if (!cur || s.elevM > cur.elevM) best.set(key, s);
  }
  return [...best.values()];
}

/** Local relief around a summit: from the 10th percentile of the ground
 *  around it up to its top. The low percentile rather than the minimum, so
 *  one pit or a missing tile edge does not count as a valley. Water counts
 *  as sea level: the tiles carry the sea floor, and a coastal summit is not
 *  4,000m taller for standing over a deep fjord. The top is the grid's
 *  highest point, capped at `summitM` (the summit's surveyed height): low-zoom
 *  tiles carry lone spikes -- a 5,918m pixel beside the 1,971m Olsen Peak. */
export function localRelief(elev, summitM = Infinity) {
  const v = [];
  for (const x of elev) if (Number.isFinite(x)) v.push(Math.max(0, x));
  if (v.length < 16) return NaN;
  v.sort((a, b) => a - b);
  return Math.max(0, Math.min(v[v.length - 1], summitM) - v[Math.floor(v.length * 0.1)]);
}

/** A lon/lat box `halfKm` either side of a point, square on the ground. */
export function boxAround(lat, lon, halfKm) {
  const dLat = halfKm / KM_PER_DEG_LAT;
  const dLon = halfKm / (111.32 * Math.cos(toRad(lat)));
  const r = (v) => Math.round(v * 1000) / 1000;
  return [r(lon - dLon), r(lat - dLat), r(lon + dLon), r(lat + dLat)];
}

export function insideBbox(p, [west, south, east, north]) {
  return p.lon >= west && p.lon <= east && p.lat >= south && p.lat <= north;
}

/**
 * Relief bands and each band's share of the basket. Taking the most relief
 * first would fill the basket with Alaska and the Cascades, and every quiet
 * song would land on a giant. Each band is filled on its own, so the basket
 * has gentle ranges as well as savage ones.
 */
export const RELIEF_BANDS = Object.freeze([
  { minM: 2000, maxM: Infinity, share: 0.4 },
  { minM: 1200, maxM: 2000, share: 0.35 },
  { minM: 600, maxM: 1200, share: 0.25 },
]);

/**
 * Choose which measured summits become ranges. `measured` items carry
 * {lat, lon, reliefM}. Every pick is at least `spacingKm` from every other
 * pick and from every point in `avoid` (existing ranges' centres), and
 * outside every box in `avoidBoxes`. With `uniqueBy`, no two picks (nor any
 * name in `takenNames`) share its value -- one pick per named range, so the
 * basket is eighty ranges rather than five Saint Elias summits. Returns at
 * most `count` picks.
 *
 * Within a band, picks are spread evenly across its relief rather than
 * taken from the top down: top-down, a 1,200-2,000m band came back as
 * twenty-eight ranges between 1,925 and 1,996m.
 */
export function selectRanges(measured, {
  count, spacingKm = 80, avoid = [], avoidBoxes = [], bands = RELIEF_BANDS, uniqueBy = null, takenNames = [],
}) {
  const taken = [...avoid];
  const names = new Set(takenNames);
  const picks = [];
  const clear = (s) => !avoidBoxes.some((b) => insideBbox(s, b))
    && !(uniqueBy && names.has(s[uniqueBy]))
    && taken.every((t) => distanceKm(s, t) >= spacingKm);
  // Every band's unfilled quota rolls into the next, so a thin band still
  // fills the basket.
  let carry = 0;
  bands.forEach((band, i) => {
    const quota = i === bands.length - 1 ? count - picks.length : Math.round(count * band.share) + carry;
    const pool = measured
      .filter((s) => s.reliefM >= band.minM && s.reliefM < band.maxM)
      .sort((a, b) => b.reliefM - a.reliefM || a.geonameId - b.geonameId);
    let got = 0;
    if (quota > 0 && pool.length) {
      const hi = pool[0].reliefM, lo = pool[pool.length - 1].reliefM;
      const used = new Set();
      // Evenly spaced relief targets, top down; each takes the clear summit
      // nearest it. A target with nothing clear is skipped, and a second
      // top-down pass fills whatever quota the targets left.
      const targets = Array.from({ length: quota }, (_, k) => hi - ((k + 0.5) / quota) * (hi - lo));
      const take = (s) => {
        picks.push(s); taken.push(s); used.add(s); got++;
        if (uniqueBy) names.add(s[uniqueBy]);
      };
      for (const t of targets) {
        let best = null;
        for (const s of pool) {
          if (used.has(s) || !clear(s)) continue;
          if (!best || Math.abs(s.reliefM - t) < Math.abs(best.reliefM - t)) best = s;
        }
        if (best) take(best);
      }
      for (const s of pool) {
        if (got >= quota) break;
        if (!used.has(s) && clear(s)) take(s);
      }
    }
    carry = quota - got;
  });
  return picks;
}

/**
 * The mountain range a summit belongs to, from Wikidata summits whose range
 * is recorded ("mountain range", P4552). `named` is [{lat, lon, range}].
 * The summit's own record would be best, but fewer than half of the picked
 * summits have one; so the neighbours vote: every recorded summit within
 * `voteKm` votes for its range, nearer ones louder. Null unless one of them
 * is within `nearKm` -- a range named from 20km away is a guess.
 */
export function rangeNameFor(summit, named, { nearKm = 12, voteKm = 25 } = {}) {
  const votes = new Map();
  let nearest = Infinity;
  for (const n of named) {
    if (Math.abs(n.lat - summit.lat) > voteKm / 100) continue;
    const d = distanceKm(summit, n);
    if (d > voteKm) continue;
    nearest = Math.min(nearest, d);
    votes.set(n.range, (votes.get(n.range) || 0) + 1 / (1 + d));
  }
  if (!(nearest <= nearKm)) return null;
  let best = null, bestVotes = -1;
  for (const [range, v] of votes) {
    if (v > bestVotes || (v === bestVotes && range < best)) { best = range; bestVotes = v; }
  }
  return best;
}

export function slugify(text) {
  return String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** A unique id: the summit's slug, then its region's, then a number. */
export function uniqueId(base, region, used) {
  const tries = [slugify(base), `${slugify(base)}-${slugify(region)}`];
  for (const id of tries) if (id && !used.has(id)) { used.add(id); return id; }
  for (let n = 2; ; n++) {
    const id = `${tries[1]}-${n}`;
    if (!used.has(id)) { used.add(id); return id; }
  }
}
