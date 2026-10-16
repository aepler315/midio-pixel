// Earth geometry shared by the renderer and the offline viewpoint tool.
// Pure functions, no DOM. The globe is the Web Mercator sphere (radius
// 6378137 m), which is what the elevation tiles are indexed on. Angles in
// the public API are degrees unless a name says Rad; ECEF axes are the usual
// ones (X through lon 0 at the equator, Z through the north pole).

export const EARTH_RADIUS = 6378137;
export const DEG = Math.PI / 180;
export const MAX_MERCATOR_LAT = 85.05112878;
/** Atmospheric refraction coefficient for long sight lines (k ~ 0.13). */
export const REFRACTION_K = 0.13;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** lon/lat (deg) + height above the sphere (m) -> ECEF [x, y, z] (m). */
export function lonLatToEcef(lon, lat, h = 0, out = [0, 0, 0]) {
  const r = EARTH_RADIUS + h;
  const cl = Math.cos(lat * DEG);
  out[0] = r * cl * Math.cos(lon * DEG);
  out[1] = r * cl * Math.sin(lon * DEG);
  out[2] = r * Math.sin(lat * DEG);
  return out;
}

/** ECEF -> { lon, lat, h }. */
export function ecefToLonLat(x, y, z) {
  const r = Math.hypot(x, y, z);
  return { lon: Math.atan2(y, x) / DEG, lat: Math.asin(clamp(z / r, -1, 1)) / DEG, h: r - EARTH_RADIUS };
}

/** Local east/north/up unit vectors at a lon/lat. */
export function enuBasis(lon, lat) {
  const sl = Math.sin(lon * DEG), cl = Math.cos(lon * DEG);
  const sp = Math.sin(lat * DEG), cp = Math.cos(lat * DEG);
  return {
    east: [-sl, cl, 0],
    north: [-sp * cl, -sp * sl, cp],
    up: [cp * cl, cp * sl, sp],
  };
}

// --- Web Mercator, normalized: x, y in [0, 1], y grows southward. ---------

export const lonToMx = (lon) => (lon + 180) / 360;
export function latToMy(lat) {
  const s = Math.sin(clamp(lat, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT) * DEG);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
export const mxToLon = (mx) => mx * 360 - 180;
export const myToLat = (my) => Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) / DEG;

/** Ground metres per normalized-mercator unit at a latitude. */
export const mercatorScale = (lat) => 2 * Math.PI * EARTH_RADIUS * Math.cos(lat * DEG);

/** Tile bounds in lon/lat for an XYZ tile. */
export function tileBounds(z, x, y) {
  const n = 2 ** z;
  return { west: mxToLon(x / n), east: mxToLon((x + 1) / n), north: myToLat(y / n), south: myToLat((y + 1) / n) };
}

/** XYZ tile containing a lon/lat at zoom z. */
export function tileAt(lon, lat, z) {
  const n = 2 ** z;
  return {
    x: clamp(Math.floor(lonToMx(lon) * n), 0, n - 1),
    y: clamp(Math.floor(latToMy(lat) * n), 0, n - 1),
  };
}

/** Ground size of one pixel of a 256-px tile at zoom z and latitude lat. */
export const metersPerPixel = (z, lat) => mercatorScale(lat) / (256 * 2 ** z);

// --- Great circles ---------------------------------------------------------

/** Haversine distance (m) between two lon/lat points. */
export function distance(lon1, lat1, lon2, lat2) {
  const dp = (lat2 - lat1) * DEG, dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing (deg, clockwise from north) from point 1 to point 2. */
export function bearing(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/** Point reached from lon/lat after `dist` metres on bearing `brg` (deg). */
export function destination(lon, lat, brg, dist) {
  const d = dist / EARTH_RADIUS, b = brg * DEG, p1 = lat * DEG, l1 = lon * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [((l2 / DEG + 540) % 360) - 180, p2 / DEG];
}

/** Spherical interpolation between two lon/lat points, t in [0, 1]. */
export function slerpLonLat(lon1, lat1, lon2, lat2, t) {
  const a = lonLatToEcef(lon1, lat1, 0), b = lonLatToEcef(lon2, lat2, 0);
  const ua = a.map((v) => v / EARTH_RADIUS), ub = b.map((v) => v / EARTH_RADIUS);
  const dot = clamp(ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2], -1, 1);
  const w = Math.acos(dot);
  if (w < 1e-9) return [lon1, lat1];
  const s = Math.sin(w), k1 = Math.sin((1 - t) * w) / s, k2 = Math.sin(t * w) / s;
  const p = [ua[0] * k1 + ub[0] * k2, ua[1] * k1 + ub[1] * k2, ua[2] * k1 + ub[2] * k2];
  const ll = ecefToLonLat(p[0], p[1], p[2]);
  return [ll.lon, ll.lat];
}

/** Drop of a distant point below the eye's tangent plane, with refraction. */
export const curvatureDrop = (d) => (d * d * (1 - REFRACTION_K)) / (2 * EARTH_RADIUS);

// --- Small vector helpers (arrays of 3) -------------------------------------

export const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

/** Heading (deg from north, clockwise) and pitch (deg, up positive) of an
 *  ECEF direction as seen from a lon/lat. */
export function directionToHeadingPitch(dir, lon, lat) {
  const { east, north, up } = enuBasis(lon, lat);
  const e = v3.dot(dir, east), n = v3.dot(dir, north), u = v3.dot(dir, up);
  return { heading: ((Math.atan2(e, n) / DEG) + 360) % 360, pitch: Math.atan2(u, Math.hypot(e, n)) / DEG };
}

/** ECEF unit direction for a heading/pitch (deg) at a lon/lat. */
export function headingPitchToDirection(heading, pitch, lon, lat) {
  const { east, north, up } = enuBasis(lon, lat);
  const ch = Math.cos(pitch * DEG), sh = Math.sin(pitch * DEG);
  const se = Math.sin(heading * DEG) * ch, sn = Math.cos(heading * DEG) * ch;
  return [
    east[0] * se + north[0] * sn + up[0] * sh,
    east[1] * se + north[1] * sn + up[1] * sh,
    east[2] * se + north[2] * sn + up[2] * sh,
  ];
}
