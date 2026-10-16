// Moving side-on scan of a terrain grid. The ridge guide picks the chain
// and the side we look from. The camera baseline follows that chain's broad
// direction. Each column of the profile is the skyline seen from one
// station — the greatest apparent elevation angle along the sightline, not
// the elevation of the traced crest. Coordinates are projected meters.
// A finite camera distance keeps vertical perspective; the horizontal axis
// is distance traveled, which is what makes this a pushbroom strip rather
// than a view from one standing point.

const EARTH_R_M = 6_371_000;
const REFRACTION_K = 0.13;

/** Apparent elevation angle (radians) of a terrain point, seen from a
 *  camera at a fixed elevation. Curvature uses an effective Earth radius
 *  that folds in a standard refraction coefficient, so distant crests sink
 *  the way a long view actually does. Distance must be horizontal meters. */
export function apparentAngle(terrainElevM, cameraElevM, distM, curvature = false) {
  const dist = Math.max(distM, 1);
  let rise = terrainElevM - cameraElevM;
  if (curvature) {
    const rEff = EARTH_R_M / (1 - REFRACTION_K);
    rise -= (dist * dist) / (2 * rEff);
  }
  return Math.atan2(rise, dist);
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function length(v) {
  return Math.hypot(v.x, v.y);
}

function polylineLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += length(sub(pts[i], pts[i - 1]));
  return s;
}

/** Point at arc length `dist` along a polyline. Clamps to the ends. */
export function pointAlong(pts, dist) {
  if (dist <= 0) return { x: pts[0].x, y: pts[0].y };
  let left = dist;
  for (let i = 1; i < pts.length; i++) {
    const seg = sub(pts[i], pts[i - 1]);
    const len = length(seg);
    if (len < 1e-9) continue;
    if (left <= len) {
      const t = left / len;
      return { x: pts[i - 1].x + seg.x * t, y: pts[i - 1].y + seg.y * t };
    }
    left -= len;
  }
  const last = pts[pts.length - 1];
  return { x: last.x, y: last.y };
}

/** Average the polyline over `windowM` of arc length, then re-space it.
 *  This is the camera baseline: small bends in the crest must not swing a
 *  camera that is tens of kilometers away. A window of 0 keeps the guide. */
export function smoothBaseline(pts, windowM) {
  const total = polylineLength(pts);
  if (!(windowM > 0) || pts.length < 3 || total < 1) {
    return pts.map((p) => ({ x: p.x, y: p.y }));
  }
  const half = windowM / 2;
  const step = Math.max(windowM / 4, total / Math.max(8, pts.length * 2));
  const out = [];
  for (let d = 0; d <= total; d += step) {
    let sx = 0, sy = 0, n = 0;
    const a = Math.max(0, d - half);
    const b = Math.min(total, d + half);
    const nSample = 8;
    for (let k = 0; k <= nSample; k++) {
      const p = pointAlong(pts, a + ((b - a) * k) / nSample);
      sx += p.x;
      sy += p.y;
      n++;
    }
    out.push({ x: sx / n, y: sy / n });
  }
  const end = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (!tail || Math.hypot(tail.x - end.x, tail.y - end.y) > step) out.push({ x: end.x, y: end.y });
  return out;
}

function heading(pts, dist) {
  const total = polylineLength(pts);
  const eps = Math.max(1, total * 0.002);
  const a = pointAlong(pts, Math.max(0, dist - eps));
  const b = pointAlong(pts, Math.min(total, dist + eps));
  const v = sub(b, a);
  const len = length(v) || 1;
  return { x: v.x / len, y: v.y / len };
}

/** Bilinear sample. `originX/Y` is the center of cell (0, 0). Returns
 *  NaN off the grid or on a no-data cell. */
export function sampleDem(dem, x, y) {
  const gx = (x - dem.originX) / dem.cellM;
  const gy = (y - dem.originY) / dem.cellM;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = gx - x0;
  const ty = gy - y0;
  const no = dem.noData;
  const at = (ix, iy) => {
    if (ix < 0 || iy < 0 || ix >= dem.width || iy >= dem.height) return NaN;
    const v = dem.elev[iy * dem.width + ix];
    if (!Number.isFinite(v) || (no != null && v === no)) return NaN;
    return v;
  };
  const v00 = at(x0, y0);
  const v10 = at(x0 + 1, y0);
  const v01 = at(x0, y0 + 1);
  const v11 = at(x0 + 1, y0 + 1);
  // A missing corner drops out of the blend. All missing → NaN.
  let wsum = 0;
  let acc = 0;
  const take = (v, w) => {
    if (!Number.isFinite(v) || w <= 0) return;
    acc += v * w;
    wsum += w;
  };
  take(v00, (1 - tx) * (1 - ty));
  take(v10, tx * (1 - ty));
  take(v01, (1 - tx) * ty);
  take(v11, tx * ty);
  return wsum > 0 ? acc / wsum : NaN;
}

function closestOnGuide(guide, p) {
  let best = guide[0];
  let bestD = Infinity;
  for (let i = 1; i < guide.length; i++) {
    const a = guide[i - 1];
    const b = guide[i];
    const ab = sub(b, a);
    const len2 = ab.x * ab.x + ab.y * ab.y;
    let t = 0;
    if (len2 > 1e-12) {
      t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    const q = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/**
 * Scan one corridor.
 * `side` +1 puts the camera to the left of the guide's travel direction
 * (a northbound guide looks from the west). The camera elevation is a
 * single number — it does not climb with the summits.
 * `isolateBandM`, when set, keeps only terrain within that many meters of
 * the guide, so a chosen subrange can be pulled out of the real view.
 * Leave it unset to keep every ridge between the camera and the far side.
 */
export function scanCorridor(dem, guide, {
  distanceM,
  cameraElevM,
  side = 1,
  spacingM,
  corridorMinM = dem.cellM,
  pastM = distanceM * 0.35,
  curvature = false,
  smoothWindowM = 0,
  isolateBandM = null,
} = {}) {
  if (!guide || guide.length < 2) throw new Error('scanCorridor needs a guide of at least two points');
  if (!(distanceM > 0) || !(spacingM > 0) || !(dem.cellM > 0)) {
    throw new Error('scanCorridor needs positive distanceM, spacingM, and cellM');
  }
  const baseline = smoothBaseline(guide, smoothWindowM);
  const total = polylineLength(baseline);
  const corridorMax = distanceM + pastM;
  const n = Math.max(1, Math.floor(total / spacingM) + 1);
  const skylineAngle = new Float64Array(n);
  const skylineElevM = new Float64Array(n);
  const skylineDistM = new Float64Array(n);
  const crestElevM = new Float64Array(n);
  const alongM = new Float64Array(n);
  const peaks = new Array(n);

  for (let i = 0; i < n; i++) {
    const d = Math.min(total, i * spacingM);
    alongM[i] = d;
    const base = pointAlong(baseline, d);
    const fwd = heading(baseline, d);
    // Left perpendicular of the travel direction.
    const perp = { x: -fwd.y * side, y: fwd.x * side };
    const cam = { x: base.x + perp.x * distanceM, y: base.y + perp.y * distanceM };
    const look = { x: -perp.x, y: -perp.y };

    const crestPt = closestOnGuide(guide, base);
    crestElevM[i] = sampleDem(dem, crestPt.x, crestPt.y);

    let best = -Infinity;
    let bestElev = NaN;
    let bestDist = NaN;
    const step = dem.cellM;
    const peaksHere = [];
    let prevPrev = null;
    let prev = null;
    let first = null;
    let second = null;
    for (let ray = corridorMinM; ray <= corridorMax; ray += step) {
      if (isolateBandM != null && Math.abs(ray - distanceM) > isolateBandM) continue;
      const x = cam.x + look.x * ray;
      const y = cam.y + look.y * ray;
      const elev = sampleDem(dem, x, y);
      if (!Number.isFinite(elev)) continue;
      const ang = apparentAngle(elev, cameraElevM, ray, curvature);
      const sample = { dist: ray, elev, angle: ang };
      if (!first) first = sample;
      else if (!second) second = sample;
      // A ridge is a local maximum of apparent angle, not of elevation.
      if (prevPrev && prev && prev.angle >= prevPrev.angle && prev.angle > ang) peaksHere.push(prev);
      prevPrev = prev;
      prev = sample;
      if (ang > best) {
        best = ang;
        bestElev = elev;
        bestDist = ray;
      }
    }
    if (first && second && first.angle > second.angle) peaksHere.unshift(first);
    if (prev && prevPrev && prev.angle > prevPrev.angle && peaksHere[peaksHere.length - 1] !== prev) {
      peaksHere.push(prev);
    }
    peaks[i] = peaksHere;
    skylineAngle[i] = Number.isFinite(best) ? best : NaN;
    skylineElevM[i] = bestElev;
    skylineDistM[i] = bestDist;
  }

  return {
    spacingM,
    alongM,
    skylineAngle,
    skylineElevM,
    skylineDistM,
    crestElevM,
    peaks,
    baselineLengthM: total,
    guideLengthM: polylineLength(guide),
  };
}

/** Split sorted distances into at most `maxLayers` groups. A split is the
 *  midpoint of a gap at least `minGapM` wide, largest gaps first. Equal-width
 *  bands are intentionally not used: a boundary in the middle of one ridge
 *  would make that ridge draw into two layers. */
export function clusterBounds(distances, minGapM, maxLayers = 3) {
  const s = distances.filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  if (s.length === 0) return [];
  const gaps = [];
  for (let i = 1; i < s.length; i++) gaps.push({ i, gap: s[i] - s[i - 1] });
  gaps.sort((a, b) => b.gap - a.gap);
  const cuts = gaps.filter((g) => g.gap >= minGapM).slice(0, maxLayers - 1);
  cuts.sort((a, b) => a.i - b.i);
  const edges = [s[0]];
  for (const c of cuts) edges.push((s[c.i - 1] + s[c.i]) / 2);
  edges.push(s[s.length - 1]);
  const bounds = [];
  for (let k = 0; k < edges.length - 1; k++) bounds.push({ lo: edges[k], hi: edges[k + 1] });
  return bounds;
}

/** One corridor scan → up to three skylines, near to far, each the max
 *  apparent angle inside its own distance cluster. A station with no ridge
 *  in a cluster is NaN there, not a copy of another layer. */
export function splitScanLayers(scan, { minGapM = 8000, maxLayers = 3 } = {}) {
  const dists = [];
  for (const ps of scan.peaks || []) for (const p of ps) dists.push(p.dist);
  const bounds = clusterBounds(dists, minGapM, maxLayers);
  const names = bounds.length === 3 ? ['near', 'mid', 'far']
    : bounds.length === 2 ? ['near', 'far']
    : ['far'];
  const out = { near: null, mid: null, far: null };
  const n = scan.skylineAngle.length;
  bounds.forEach((b, bi) => {
    const skylineAngle = new Float64Array(n);
    const skylineElevM = new Float64Array(n);
    const skylineDistM = new Float64Array(n);
    let any = false;
    for (let s = 0; s < n; s++) {
      let best = -Infinity;
      let elev = NaN;
      let dist = NaN;
      for (const p of scan.peaks[s]) {
        if (p.dist + 1e-6 < b.lo || p.dist - 1e-6 > b.hi) continue;
        if (p.angle > best) {
          best = p.angle;
          elev = p.elev;
          dist = p.dist;
        }
      }
      if (Number.isFinite(best) && best > -Infinity) {
        skylineAngle[s] = best;
        skylineElevM[s] = elev;
        skylineDistM[s] = dist;
        any = true;
      } else {
        skylineAngle[s] = NaN;
        skylineElevM[s] = NaN;
        skylineDistM[s] = NaN;
      }
    }
    if (!any) return;
    out[names[bi]] = {
      spacingM: scan.spacingM,
      alongM: scan.alongM,
      skylineAngle,
      skylineElevM,
      skylineDistM,
      crestElevM: scan.crestElevM,
      baselineLengthM: scan.baselineLengthM,
      guideLengthM: scan.guideLengthM,
    };
  });
  return out;
}
