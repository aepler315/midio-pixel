// Explicit, downstream mapped reaches. DEM drainage accumulation is never
// interpreted as discharge or proof of a wet channel. No DOM or GPU objects.
const BANDS = ['far', 'mid', 'near'];
const MAX_VERTICES = 120000;
const FLOW_KINDS = new Set(['observed', 'estimated', 'modeled-mean-annual']);
const finite = Number.isFinite;
const present = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const lonLat = p => Array.isArray(p) && p.length === 2 && p.every(finite)
  && Math.abs(p[0]) <= 180 && Math.abs(p[1]) < 85;

/** Structural errors in one optional reach. Null dimensions mean
 * unobserved, never a measured zero. Units are explicit in field names. */
export function riverChannelErrors(river) {
  if (!river || typeof river !== 'object') return ['river missing'];
  const errors = [];
  if (typeof river.id !== 'string' || !river.id) errors.push('river id');
  if (!['flowing', 'dry', 'unknown'].includes(river.state)) errors.push('river state');
  if (!['perennial', 'intermittent', 'ephemeral', 'unknown'].includes(river.permanence)) errors.push('river permanence');
  const path = river.pathLonLat;
  if (!Array.isArray(path) || path.length < 2 || path.length > 8192 || !path.every(lonLat)
    || !path.some(p => p[0] !== path[0][0] || p[1] !== path[0][1])) errors.push('river pathLonLat');
  for (const [key, positive] of [['widthM', true], ['depthM', true], ['dischargeM3s', false], ['velocityMps', false]]) {
    if (!present(river, key)) continue;
    if (river[key] === null) continue;
    if (!finite(river[key]) || (positive ? river[key] <= 0 : river[key] < 0)) errors.push(`river ${key}`);
  }
  if (river.state === 'flowing' && !(river.widthM > 0)) errors.push('flowing river widthM');
  if (river.widthM > 1000) errors.push('river widthM exceeds canyon channel bound');
  const source = river.source;
  if (!source || typeof source.provider !== 'string' || !source.provider
    || typeof source.url !== 'string' || !/^https:\/\//.test(source.url)
    || !/^\d{4}-\d{2}-\d{2}/.test(source.retrievedAt || '')
    || typeof source.estimateKind !== 'string' || !source.estimateKind) errors.push('river source');
  if (river.state === 'flowing' && (!FLOW_KINDS.has(source?.estimateKind) || source?.flowDirection !== 'with-digitized')) errors.push('river flow provenance');
  return errors;
}

/** Unknown and ordinary dry conditions stay dry even when a mean annual
 * model is positive. An explicit zero discharge takes precedence over VEMA. */
export function resolveRiverFlow(river) {
  const dischargeM3s = finite(river?.dischargeM3s) ? river.dischargeM3s : null;
  const source = river?.source || null;
  const inactive = reason => ({ active: false, speedMps: 0, dischargeM3s, source, reason });
  if (riverChannelErrors(river).length) return inactive('invalid');
  if (river.state !== 'flowing') return inactive(river.state);
  if (dischargeM3s === 0) return inactive('zero-discharge');
  const speedMps = finite(river.velocityMps) ? river.velocityMps
    : dischargeM3s !== null && river.widthM > 0 && river.depthM > 0 ? dischargeM3s / (river.widthM * river.depthM) : null;
  if (!(speedMps > 0) || !finite(speedMps) || speedMps > 30) return inactive('velocity-unavailable');
  return { active: true, speedMps, dischargeM3s, source, reason: null };
}

/** Limited to the static canyon packages whose geographic projection is
 * explicit. Future moving terrain windows need their own lifecycle support. */
function activeReaches(view) {
  return view?.biome === 'CANYON' && !view.tourManifestUrl && Array.isArray(view.rivers)
    ? view.rivers.map(river => ({ river, flow: resolveRiverFlow(river) })).filter(r => r.flow.active) : [];
}

function vertexLimit(maxVertices) {
  if (!Number.isInteger(maxVertices) || maxVertices < 3 || maxVertices > MAX_VERTICES) throw new RangeError('Invalid river vertex bound');
  return maxVertices;
}

/** Conservative GPU bound: 17 floats per vertex, and fewer than 3 uint32
 * indices per emitted polygon vertex. Build enforces the same limit. */
export function riverGeometryBound(view, { maxVertices = MAX_VERTICES } = {}) {
  vertexLimit(maxVertices);
  return activeReaches(view).length ? maxVertices * 80 : 0;
}

// Snyder's local forward Transverse Mercator series, to A^6. The supported
// NAD83/GRS80 packages span tens of kilometres around their central meridian;
// the series error there is far below a DEM sample or the .1 m bake metadata.
function localProjector(manifest) {
  const crs = manifest?.source?.horizontalCrs;
  const p = Object.fromEntries(Array.from((crs || '').matchAll(/\+([\w]+)=([^\s]+)/g), m => [m[1], m[2]]));
  const lat0 = Number(p.lat_0), lon0 = Number(p.lon_0), k = Number(p.k ?? p.k_0 ?? 1);
  if (p.proj !== 'tmerc' || p.units !== 'm' || !(p.datum === 'NAD83' || p.ellps === 'GRS80')
    || !finite(lat0) || !finite(lon0) || !(k > 0)) throw new RangeError('River projection requires the package local NAD83 tmerc CRS');
  const rad = Math.PI / 180, a = 6378137, f = 1 / 298.257222101;
  const e2 = f * (2 - f), e4 = e2 * e2, e6 = e4 * e2, ep2 = e2 / (1 - e2);
  const meridian = phi => a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
    - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - 35 * e6 / 3072 * Math.sin(6 * phi));
  const m0 = meridian(lat0 * rad), x0 = Number(p.x_0 || 0), y0 = Number(p.y_0 || 0);
  return point => {
    if (!lonLat(point) || Math.abs(point[0] - lon0) > 2 || Math.abs(point[1] - lat0) > 2) throw new RangeError('River point outside local projection');
    const phi = point[1] * rad, s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
    const N = a / Math.sqrt(1 - e2 * s * s), T = t * t, C = ep2 * c * c, A = (point[0] - lon0) * rad * c;
    const x = x0 + k * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
    const north = y0 + k * (meridian(phi) - m0 + N * t * (A * A / 2
      + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    return [x, -north];
  };
}

/** Local X east / Z south metres from an explicit geographic path point. */
export function projectRiverPoint(manifest, point) { return localProjector(manifest)(point); }

const cross = (ax, az, bx, bz) => ax * bz - az * bx;

function terrainIndex(terrainGeometry, binM, requestedBins) {
  const bins = new Map();
  for (const name of BANDS) {
    const band = terrainGeometry?.bands?.[name] || terrainGeometry?.geometries?.[name];
    const p = band?.positions || band?.attributes?.position?.array;
    const indices = band?.indices || band?.index?.array;
    if (!p || !indices) continue;
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      const box = [Math.min(p[a], p[b], p[c]), Math.min(p[a + 2], p[b + 2], p[c + 2]),
        Math.max(p[a], p[b], p[c]), Math.max(p[a + 2], p[b + 2], p[c + 2])];
      let tri;
      for (let z = Math.floor(box[1] / binM); z <= Math.floor(box[3] / binM); z++) {
        for (let x = Math.floor(box[0] / binM); x <= Math.floor(box[2] / binM); x++) {
          const key = `${x},${z}`;
          if (!requestedBins.has(key)) continue;
          if (!tri) {
            const points = [p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]];
            const area = cross(points[3] - points[0], points[5] - points[2], points[6] - points[0], points[8] - points[2]);
            if (!points.every(finite) || Math.abs(area) < 1e-8) continue;
            tri = { name, points, box, area };
          }
          if (!bins.has(key)) bins.set(key, []);
          bins.get(key).push(tri);
        }
      }
    }
  }
  return bins;
}

function clipToTriangle(polygon, tri) {
  const p = tri.points, sign = Math.sign(tri.area);
  for (let edge = 0; edge < 3 && polygon.length; edge++) {
    const a = edge * 3, b = ((edge + 1) % 3) * 3;
    const distance = point => sign * cross(p[b] - p[a], p[b + 2] - p[a + 2], point[0] - p[a], point[1] - p[a + 2]);
    const out = [];
    let prev = polygon[polygon.length - 1], dp = distance(prev);
    for (const curr of polygon) {
      const dc = distance(curr);
      if ((dp >= 0) !== (dc >= 0)) {
        const t = dp / (dp - dc);
        out.push(prev.map((v, i) => v + (curr[i] - v) * t));
      }
      if (dc >= 0) out.push(curr);
      prev = curr; dp = dc;
    }
    polygon = out;
  }
  return polygon.filter((p, i) => {
    const prev = polygon[(i + polygon.length - 1) % polygon.length];
    return Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-7;
  });
}

function heightOnTriangle(tri, x, z) {
  const p = tri.points;
  const u = ((p[5] - p[8]) * (x - p[6]) + (p[6] - p[3]) * (z - p[8])) / tri.area;
  const v = ((p[8] - p[2]) * (x - p[6]) + (p[0] - p[6]) * (z - p[8])) / tri.area;
  return u * p[1] + v * p[4] + (1 - u - v) * p[7];
}

function ribbonSegments(path, halfWidth, maxSegmentM) {
  const points = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1], q = path[i], length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length <= 1e-5) continue;
    const count = Math.max(1, Math.ceil(length / maxSegmentM));
    for (let j = 1; j <= count; j++) points.push([p[0] + (q[0] - p[0]) * j / count, p[1] + (q[1] - p[1]) * j / count]);
  }
  const direction = points.slice(1).map((p, i) => {
    const dx = p[0] - points[i][0], dz = p[1] - points[i][1], length = Math.hypot(dx, dz);
    return [dx / length, dz / length, length];
  });
  const offsets = points.map((p, i) => {
    const before = direction[Math.max(0, i - 1)], after = direction[Math.min(i, direction.length - 1)];
    const nx = -before[1] - after[1], nz = before[0] + after[0], norm = Math.hypot(nx, nz);
    if (norm < 1e-5) return [-after[1] * halfWidth, after[0] * halfWidth];
    const scale = Math.min(2, 1 / Math.max(.5, (nx * -after[1] + nz * after[0]) / norm)) * halfWidth / norm;
    return [nx * scale, nz * scale];
  });
  let along = 0;
  return direction.map((d, i) => {
    const p = points[i], q = points[i + 1], a = offsets[i], b = offsets[i + 1], end = along + d[2];
    const polygon = [[p[0] - a[0], p[1] - a[1], along, -1], [p[0] + a[0], p[1] + a[1], along, 1],
      [q[0] + b[0], q[1] + b[1], end, 1], [q[0] - b[0], q[1] - b[1], end, -1]];
    along = end;
    return { polygon, direction: d };
  });
}

/** Clip a metre-width river ribbon to the ACTUAL selected terrain triangles.
 * Heights therefore match runtime coarsening, snapped seams and no-data;
 * each clipped polygon belongs to its source triangle's depth band. */
export function buildRiverGeometry(data, view, terrainGeometry, { liftM = .15, maxVertices = MAX_VERTICES } = {}) {
  vertexLimit(maxVertices);
  if (!finite(liftM) || liftM < 0 || liftM > 2) throw new RangeError('Invalid river surface lift');
  const active = activeReaches(view);
  const out = Object.fromEntries(BANDS.map(name => [name, { positions: [], river: [], riverDirection: [],
    terrainA: [], terrainB: [], terrainC: [], indices: [] }]));
  let vertices = 0, triangles = 0;
  if (active.length) {
    const project = localProjector(data.manifest), binM = Math.max(64, (data.grid?.cellSizeM || 22) * 8);
    const segments = [], requestedBins = new Set();
    for (const { river, flow } of active) {
      for (const segment of ribbonSegments(river.pathLonLat.map(project), river.widthM * .5, binM)) {
        const { polygon } = segment;
        const box = [Math.min(...polygon.map(p => p[0])), Math.min(...polygon.map(p => p[1])),
          Math.max(...polygon.map(p => p[0])), Math.max(...polygon.map(p => p[1]))];
        segments.push({ ...segment, box, flow });
        for (let z = Math.floor(box[1] / binM); z <= Math.floor(box[3] / binM); z++) {
          for (let x = Math.floor(box[0] / binM); x <= Math.floor(box[2] / binM); x++) requestedBins.add(`${x},${z}`);
        }
      }
    }
    const bins = terrainIndex(terrainGeometry, binM, requestedBins);
    for (const { polygon, direction, box, flow } of segments) {
      const candidates = new Set();
      for (let z = Math.floor(box[1] / binM); z <= Math.floor(box[3] / binM); z++) {
        for (let x = Math.floor(box[0] / binM); x <= Math.floor(box[2] / binM); x++) {
          for (const tri of bins.get(`${x},${z}`) || []) candidates.add(tri);
        }
      }
      for (const tri of candidates) {
        const t = tri.box;
        if (t[0] > box[2] || t[2] < box[0] || t[1] > box[3] || t[3] < box[1]) continue;
        const clipped = clipToTriangle(polygon, tri);
        if (clipped.length < 3) continue;
        const faces = [];
        for (let j = 1; j < clipped.length - 1; j++) {
          const [a, b, c] = [clipped[0], clipped[j], clipped[j + 1]];
          const area = cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
          if (Math.abs(area) > 1e-8) faces.push(area < 0 ? [0, j, j + 1] : [0, j + 1, j]);
        }
        if (!faces.length) continue;
        if (vertices + clipped.length > maxVertices) throw new RangeError('River geometry exceeded admitted vertex bound');
        const band = out[tri.name], base = band.positions.length / 3;
        for (const p of clipped) {
          band.positions.push(p[0], heightOnTriangle(tri, p[0], p[1]) + liftM, p[1]);
          band.river.push(p[2], Math.max(-1, Math.min(1, p[3])), flow.speedMps);
          band.riverDirection.push(direction[0], direction[1]);
          // A nonlinear field at a new interior point is not the drawn
          // triangle's interpolation of that field at its original vertices.
          // The shader derives barycentrics from XZ and follows that plane.
          band.terrainA.push(...tri.points.slice(0, 3));
          band.terrainB.push(...tri.points.slice(3, 6));
          band.terrainC.push(...tri.points.slice(6, 9));
        }
        for (const face of faces) band.indices.push(...face.map(i => base + i));
        vertices += clipped.length; triangles += faces.length;
      }
    }
  }
  const bands = {};
  let bytes = 0;
  for (const name of BANDS) {
    const b = out[name];
    bands[name] = { positions: new Float32Array(b.positions), river: new Float32Array(b.river),
      riverDirection: new Float32Array(b.riverDirection), terrainA: new Float32Array(b.terrainA),
      terrainB: new Float32Array(b.terrainB), terrainC: new Float32Array(b.terrainC), indices: new Uint32Array(b.indices) };
    bytes += Object.values(bands[name]).reduce((sum, array) => sum + array.byteLength, 0);
  }
  return { bands, stats: { vertices, triangles, bytes } };
}
