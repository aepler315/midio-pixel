// The globe's terrain as a quadtree of Web Mercator tiles. Each frame it
// picks the tiles whose mesh spacing projects to about `errorPx` pixels
// (more detail near the camera, less toward the horizon), culls by the view
// frustum and by the Earth's horizon, streams elevation for what is missing
// and builds tiles in workers. A tile is drawn until all four of its
// children are ready, so there are never holes. Positions are relative to
// the camera, which keeps centimetre precision anywhere on the planet.
import * as THREE from 'three';
import { prepareTile, gridIndex, tileHeightAt, tileWaterAt, RENDER_MIN_Z, demLevelFor } from './TileBuilder.js';
import { createTerrainMaterial } from './TerrainMaterial.js';
import { EARTH_RADIUS, DEG, mxToLon, myToLat, lonToMx, latToMy, ecefToLonLat } from '../core/geo.js';

const CIRC = 2 * Math.PI * EARTH_RADIUS;
const OCCLUDER_R = EARTH_RADIUS - 120;

export const QUALITY = {
  low: { errorPx: 9, M: 32, S: 128, maxZ: 16, maxTiles: 320, detail: false, micro: 0, shadowSize: 1024, treeFar: 0 },
  medium: { errorPx: 6, M: 64, S: 128, maxZ: 17, maxTiles: 450, detail: true, micro: 1, shadowSize: 2048, treeFar: 800 },
  high: { errorPx: 4, M: 64, S: 128, maxZ: 18, maxTiles: 650, detail: true, micro: 1, shadowSize: 2048, treeFar: 1400 },
  ultra: { errorPx: 2.6, M: 64, S: 128, maxZ: 19, maxTiles: 950, detail: true, micro: 1, shadowSize: 4096, treeFar: 2200 },
};

/** Public preset names are case-insensitive; unsupported inputs use high. */
export function resolveQuality(value) {
  const name = typeof value === 'string' ? value.toLowerCase() : '';
  return Object.hasOwn(QUALITY, name) ? name : 'high';
}

/** Dispose a tile geometry without freeing the index buffer all tiles share
 *  (three.js deletes a disposed geometry's index buffer on the GPU, which
 *  would silently break every other tile's vertex array). */
function disposeGeometry(g) {
  g.index = null;
  g.dispose();
}

class Tile {
  constructor(z, x, y, parent) {
    this.z = z; this.x = x; this.y = y; this.parent = parent;
    this.key = `${z}/${x}/${y}`;
    this.state = 'new'; // new | building | built
    this.children = null;
    this.data = null; this.mesh = null;
    this.seen = -1; this.wantFrame = -1;
    this._bounds = null; this._boundsFrom = null;
    this.rebuilding = false; this.rebuildCheck = 0;
    const n = 2 ** z;
    this.north = myToLat(y / n); this.south = myToLat((y + 1) / n);
    this.west = mxToLon(x / n); this.east = mxToLon((x + 1) / n);
    const nearEq = this.north > 0 && this.south < 0 ? 0 : Math.min(Math.abs(this.north), Math.abs(this.south));
    this.widthM = (CIRC * Math.cos(nearEq * DEG)) / n;
  }
}

export class TerrainTiles {
  constructor({ dem, globals, quality = 'high', workers = null }) {
    this.dem = dem;
    this.globals = globals;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.roots = [];
    this.setQuality(quality);
    this.indexAttrs = new Map();
    this.frame = 0;
    this.built = new Set();
    this.queue = [];
    this.stats = { drawn: 0, built: 0, building: 0, maxZ: 0 };
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) this.roots.push(new Tile(RENDER_MIN_Z, x, y, null));
    const n = workers ?? Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    this.workers = [];
    this.jobs = new Map();
    this.nextJob = 1;
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this._onBuilt(e.data);
      w.busy = 0;
      this.workers.push(w);
    }
    this.mainList = [];
    this.shadowList = [];
  }

  setQuality(name) {
    this.qualityName = resolveQuality(name);
    this.q = QUALITY[this.qualityName];
    this.globals.uMicro.value = this.q.micro;
  }

  _index(M) {
    if (!this.indexAttrs.has(M)) this.indexAttrs.set(M, new THREE.BufferAttribute(gridIndex(M), 1));
    return this.indexAttrs.get(M);
  }

  _children(t) {
    if (!t.children) {
      const z = t.z + 1, x = t.x * 2, y = t.y * 2;
      t.children = [new Tile(z, x, y, t), new Tile(z, x + 1, y, t), new Tile(z, x, y + 1, t), new Tile(z, x + 1, y + 1, t)];
    }
    return t.children;
  }

  /** Bounding sphere and corner points (ECEF, metres). Exact once built,
   *  otherwise from the best known height range. */
  _bounds(t) {
    if (t.data) {
      if (t._boundsFrom !== t.data) {
        t._bounds = this._sphere(t, t.data.minH, t.data.maxH);
        t._bounds.center = t.data.center;
        t._bounds.radius = Math.max(t.data.radius, t._bounds.radius * 0.5);
        t._boundsFrom = t.data;
      }
      return t._bounds;
    }
    let lo = -200, hi = 8900;
    const [d, dx, dy] = this._demTile(t);
    const dem = this.dem.get(d, dx, dy);
    if (dem) { lo = dem.min; hi = dem.max; } else {
      for (let p = t.parent; p; p = p.parent) if (p.data) { lo = p.data.minH; hi = p.data.maxH; break; }
    }
    lo = Math.max(lo, -50); // the sea surface is drawn at 0
    const key = `${lo}|${hi}`;
    if (t._boundsFrom !== key) { t._bounds = this._sphere(t, lo, hi); t._boundsFrom = key; }
    return t._bounds;
  }

  _sphere(t, lo, hi) {
    const pts = [];
    const lats = [t.north, (t.north + t.south) / 2, t.south], lons = [t.west, (t.west + t.east) / 2, t.east];
    const corners = [];
    for (const lat of lats) for (const lon of lons) for (const h of [lo, hi]) {
      const r = EARTH_RADIUS + h, cl = Math.cos(lat * DEG);
      const p = [r * cl * Math.cos(lon * DEG), r * cl * Math.sin(lon * DEG), r * Math.sin(lat * DEG)];
      pts.push(p);
      if (h === hi && lat !== lats[1] && lon !== lons[1]) corners.push(p);
    }
    const c = [0, 0, 0];
    for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c[0] /= pts.length; c[1] /= pts.length; c[2] /= pts.length;
    let r = 0;
    for (const p of pts) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
    // Low tiles bulge with the Earth's curvature between sample points.
    if (t.z < 6) r *= 1.15;
    const mid = pts[(1 * 3 + 1) * 2 + 1];
    return { center: c, radius: r, corners, top: mid };
  }

  _horizonHidden(t, b, cam) {
    if (t.z < 5) return false;
    const pts = [...b.corners, b.top];
    for (const p of pts) {
      const vx = p[0] - cam[0], vy = p[1] - cam[1], vz = p[2] - cam[2];
      const vv = vx * vx + vy * vy + vz * vz;
      const tt = -(cam[0] * vx + cam[1] * vy + cam[2] * vz) / vv;
      if (tt <= 0 || tt >= 1) return false;
      const qx = cam[0] + tt * vx, qy = cam[1] + tt * vy, qz = cam[2] + tt * vz;
      if (qx * qx + qy * qy + qz * qz >= OCCLUDER_R * OCCLUDER_R) return false;
    }
    return true;
  }

  /**
   * Choose and position the tiles for this frame.
   *   view { cam: [x,y,z] ECEF, frustum: THREE.Frustum (camera-relative),
   *          K: pixels per radian-ish (height / (2 tan(vfov/2))), casters: [THREE.Frustum] }
   */
  update(view) {
    this.frame++;
    this.now = performance.now();
    this.view = view;
    this.mainList = [];
    this.shadowList = [];
    this.queue = [];
    this.wanted = 0;
    this._sphereTmp ??= new THREE.Sphere();
    for (const r of this.roots) this._visit(r);
    for (const t of [...this.mainList, ...this.shadowList]) {
      const c = t.data.center;
      t.mesh.position.set(c[0] - view.cam[0], c[1] - view.cam[1], c[2] - view.cam[2]);
      t.mesh.updateMatrix();
      t.mesh.matrixWorld.copy(t.mesh.matrix);
    }
    this._schedule();
    this._evict();
    this.stats.drawn = this.mainList.length;
    this.stats.built = this.built.size;
    this.stats.maxZ = this.mainList.reduce((m, t) => Math.max(m, t.z), 0);
    this.stats.wanted = this.wanted;
  }

  /** Request (but do not draw) what another view will need, e.g. the end of a flight. */
  prefetch(view) {
    const keep = [this.view, this.mainList, this.shadowList];
    this.view = view; this.mainList = []; this.shadowList = [];
    for (const r of this.roots) this._visit(r);
    [this.view, this.mainList, this.shadowList] = keep;
    this._schedule();
  }

  _cull(t) {
    const v = this.view, b = this._bounds(t), s = this._sphereTmp;
    s.center.set(b.center[0] - v.cam[0], b.center[1] - v.cam[1], b.center[2] - v.cam[2]);
    s.radius = b.radius;
    let main = v.frustum.intersectsSphere(s);
    let caster = false;
    if (v.casters) for (const f of v.casters) if (f.intersectsSphere(s)) { caster = true; break; }
    if (main && this._horizonHidden(t, b, v.cam)) main = false;
    return { main, caster, dist: Math.max(1, s.center.length() - b.radius) };
  }

  _visit(t) {
    const c = this._cull(t);
    if (!c.main && !c.caster) return;
    t.seen = this.frame; t.seenAt = this.now;
    if (t.state !== 'built') { this._want(t, 0); return; }
    const sse = (t.widthM / this.q.M) * this.view.K / c.dist;
    // Off-screen shadow casters only need coarse shapes.
    const threshold = c.main ? this.q.errorPx : this.q.errorPx * 6;
    if (sse > threshold && t.z < this.q.maxZ) {
      const kids = this._children(t);
      let ready = true;
      for (const k of kids) {
        k.seen = this.frame; k.seenAt = this.now; // needed while the parent refines, even if off screen
        if (k.state === 'built') continue;
        const kc = this._cull(k);
        if (!kc.main && !kc.caster) continue;
        ready = false;
        this._want(k, k.z + 1 / (1 + sse));
      }
      if (ready) { for (const k of kids) this._visit(k); return; }
    }
    if (c.main) this.mainList.push(t);
    if (c.caster || c.main) this.shadowList.push(t);
    if (!t.data.exact && !t.rebuilding && this.frame - t.rebuildCheck > 20) {
      t.rebuildCheck = this.frame;
      this.wanted++;
      if (this._neighboursSettled(t)) { t.rebuilding = true; this.queue.push({ t, p: t.z + 5 }); }
      else this._requestNeighbours(t, t.z + 2);
    }
  }

  _demTile(t) {
    const d = demLevelFor(t.z), s = t.z - d;
    return [d, t.x >> s, t.y >> s];
  }

  _neighboursSettled(t) {
    const [d, x, y] = this._demTile(t);
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const n = 1 << d, xx = ((x + i) % n + n) % n, yy = y + j;
      if (yy < 0 || yy >= n) continue;
      const st = this.dem.state(d, xx, yy);
      if (st !== 'ready' && st !== 'failed') return false;
    }
    return true;
  }

  _requestNeighbours(t, p) {
    const [d, x, y] = this._demTile(t);
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const n = 1 << d, xx = ((x + i) % n + n) % n, yy = y + j;
      if (yy >= 0 && yy < n) this.dem.request(d, xx, yy, p);
    }
  }

  _want(t, p) {
    if (t.state !== 'new') return;
    this.wanted++;
    t.wantFrame = this.frame;
    const [d, x, y] = this._demTile(t);
    const st = this.dem.request(d, x, y, p);
    if (t.z > 3) this._requestNeighbours(t, p + 0.6);
    if (st === 'ready' || st === 'failed') this.queue.push({ t, p });
  }

  _schedule() {
    if (!this.queue.length) return;
    this.queue.sort((a, b) => a.p - b.p);
    const cap = this.workers.length * 3;
    let busy = this.jobs.size;
    for (const { t } of this.queue) {
      if (busy >= cap) break;
      if (t.state === 'building' || (t.state === 'built' && !t.rebuilding) || t.job) continue;
      const prep = prepareTile(this.dem, t.z, t.x, t.y, { S: this.q.S });
      if (!prep) continue;
      const id = this.nextJob++;
      const w = this.workers.reduce((a, b) => (a.busy <= b.busy ? a : b));
      w.busy++;
      this.jobs.set(id, { t, w });
      t.job = id;
      if (t.state === 'new') t.state = 'building';
      w.postMessage({ id, prep, M: this.q.M, detail: this.q.detail }, [prep.data.buffer]);
      busy++;
    }
    this.stats.building = this.jobs.size;
  }

  _onBuilt({ id, tile, error }) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    job.w.busy--;
    const t = job.t;
    t.job = null;
    if (t.state === 'new') { this._schedule(); return; } // evicted while building
    if (error) { console.error(error); t.state = t.data ? 'built' : 'new'; t.rebuilding = false; return; }
    this._upload(t, tile);
    t.state = 'built';
    t.rebuilding = false;
    this.built.add(t);
    // Keep the workers fed without waiting for the next frame.
    this._schedule();
  }

  _upload(t, data) {
    const P = data.texSize;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    geom.setAttribute('aH', new THREE.BufferAttribute(data.heights, 1));
    geom.setIndex(this._index(data.M));
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), data.radius);
    const tex = new THREE.DataTexture(data.tex, P, P, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false; tex.needsUpdate = true;
    const n = 2 ** t.z;
    const origin = new THREE.Vector2(((t.x / n) * CIRC) % 2048, ((t.y / n) * CIRC) % 2048);
    if (t.mesh) {
      disposeGeometry(t.mesh.geometry);
      t.mesh.material.uniforms.uTex.value.dispose();
      t.mesh.geometry = geom;
      const u = t.mesh.material.uniforms;
      u.uTex.value = tex;
      u.uTileCenter.value.set(...data.center);
    } else {
      const mat = createTerrainMaterial(this.globals, {
        uTex: { value: tex }, uTexSize: { value: P }, uS: { value: data.S },
        uTileOrigin: { value: origin }, uTileSizeM: { value: CIRC / n },
        uCosLat: { value: Math.cos(((t.north + t.south) / 2) * DEG) },
        uTileCenter: { value: new THREE.Vector3(...data.center) },
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.userData.tile = t;
      t.mesh = mesh;
    }
    t.data = data;
  }

  _dispose(t) {
    this.onDispose?.(t);
    if (t.mesh) {
      disposeGeometry(t.mesh.geometry);
      t.mesh.material.uniforms.uTex.value.dispose();
      t.mesh.material.dispose();
    }
    t.mesh = null; t.data = null; t.state = 'new'; t.rebuilding = false; t._boundsFrom = null;
    this.built.delete(t);
    if (t.children && t.children.every((k) => k.state === 'new' && !k.children)) t.children = null;
  }

  _evict() {
    const max = this.q.maxTiles;
    if (this.built.size <= max) return;
    // Old means unused for a while in both frames and wall-clock time.
    const old = [...this.built].filter((t) => t.z > RENDER_MIN_Z && this.frame - t.seen > 8 && this.now - (t.seenAt ?? 0) > 1500).sort((a, b) => a.seen - b.seen);
    for (const t of old) {
      if (this.built.size <= max * 0.9) break;
      this._dispose(t);
    }
  }

  /** Put the chosen meshes into the group for a pass ('main' | 'shadow'). */
  usePass(pass) {
    const list = pass === 'shadow' ? this.shadowList : this.mainList;
    this.group.children.length = 0;
    for (const t of list) { this.group.children.push(t.mesh); t.mesh.parent = this.group; }
  }

  /** Deepest built tile containing a lon/lat. */
  tileAt(lon, lat) {
    const mx = lonToMx(lon), my = Math.min(0.999999, Math.max(0, latToMy(lat)));
    let t = this.roots[Math.floor(my * 4) * 4 + Math.floor(mx * 4)];
    let best = t.state === 'built' ? t : null;
    while (t.children) {
      const n = 2 ** (t.z + 1), cx = Math.floor(mx * n), cy = Math.floor(my * n);
      t = t.children[(cy - 2 * t.y) * 2 + (cx - 2 * t.x)];
      if (!t) break;
      if (t.state === 'built') best = t;
    }
    return best;
  }

  /** Rendered terrain height (m) at a lon/lat, or NaN if nothing is loaded. */
  heightAt(lon, lat) {
    const t = this.tileAt(lon, lat);
    if (!t) return NaN;
    const n = 2 ** t.z;
    return tileHeightAt(t.data, lonToMx(lon) * n - t.x, Math.min(0.999999, latToMy(lat)) * n - t.y);
  }

  /** Water class under a lon/lat: 0 land, 1 lake, 2 sea (from the deepest built tile). */
  waterAt(lon, lat) {
    const t = this.tileAt(lon, lat);
    if (!t) return 0;
    const n = 2 ** t.z;
    return tileWaterAt(t.data, lonToMx(lon) * n - t.x, Math.min(0.999999, latToMy(lat)) * n - t.y);
  }

  /** First terrain hit along a ray (ECEF origin, unit dir). Returns the
   *  distance in metres or null. Sphere-traces against rendered heights. */
  raycast(o, d, maxDist = 3e7) {
    // Quick reject against a sphere enclosing all terrain.
    const R = EARTH_RADIUS + 9000;
    const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
    const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - R * R;
    const disc = b * b - c;
    if (disc < 0) return null;
    let t = Math.max(0, -b - Math.sqrt(disc));
    const tEnd = Math.min(maxDist, -b + Math.sqrt(disc));
    let prevT = t, prevAlt = Infinity;
    for (let i = 0; i < 600 && t < tEnd; i++) {
      const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      const ll = ecefToLonLat(p[0], p[1], p[2]);
      let g = this.heightAt(ll.lon, ll.lat);
      if (Number.isNaN(g)) g = 0;
      const alt = ll.h - g;
      if (alt <= 0.05) {
        // Refine between the last point above ground and this one.
        let a = prevT, z = t;
        for (let k = 0; k < 24; k++) {
          const m = (a + z) / 2, q = [o[0] + d[0] * m, o[1] + d[1] * m, o[2] + d[2] * m];
          const l2 = ecefToLonLat(q[0], q[1], q[2]);
          let g2 = this.heightAt(l2.lon, l2.lat);
          if (Number.isNaN(g2)) g2 = 0;
          if (l2.h - g2 > 0) a = m; else z = m;
        }
        return (a + z) / 2;
      }
      prevT = t; prevAlt = alt;
      t += Math.max(0.3, alt * 0.45);
    }
    void prevAlt;
    return null;
  }

  /** Summit candidates from tiles currently drawn. */
  peaks() {
    const out = [];
    for (const t of this.mainList) for (const p of t.data.peaks) out.push(p);
    return out;
  }

  /** Is everything needed for the current view built? */
  get settled() {
    return this.jobs.size === 0 && this.queue.length === 0 && this.stats.wanted === 0;
  }
}
