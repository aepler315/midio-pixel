// A stitched elevation raster in Web Mercator pixel space at one zoom.
// Used by the viewpoint calculator (offline in Node, or in the browser).
// Pixel (0, 0) is the north-west corner of tile (tx0, ty0); pixel centres
// sit at integer coordinates.
import { lonToMx, latToMy, mxToLon, myToLat, metersPerPixel, tileAt, clamp } from './geo.js';

export class DemGrid {
  constructor({ z, tx0, ty0, tilesX, tilesY, data }) {
    this.z = z; this.tx0 = tx0; this.ty0 = ty0;
    this.width = tilesX * 256; this.height = tilesY * 256;
    this.data = data ?? new Float32Array(this.width * this.height);
    this.scale = 256 * 2 ** z; // pixels per normalized-mercator unit
  }

  /** Tiles needed to cover a lon/lat box at zoom z. */
  static tilesFor(bbox, z) {
    const [w, s, e, n] = bbox;
    const a = tileAt(w, n, z), b = tileAt(e, s, z);
    return { tx0: a.x, ty0: a.y, tilesX: b.x - a.x + 1, tilesY: b.y - a.y + 1 };
  }

  /** Copy a decoded 256x256 tile into place. */
  setTile(tx, ty, heights) {
    const ox = (tx - this.tx0) * 256, oy = (ty - this.ty0) * 256;
    for (let y = 0; y < 256; y++) this.data.set(heights.subarray(y * 256, y * 256 + 256), (oy + y) * this.width + ox);
  }

  toPixel(lon, lat) {
    return [lonToMx(lon) * this.scale - this.tx0 * 256 - 0.5, latToMy(lat) * this.scale - this.ty0 * 256 - 0.5];
  }

  toLonLat(px, py) {
    return [mxToLon((px + 0.5 + this.tx0 * 256) / this.scale), myToLat((py + 0.5 + this.ty0 * 256) / this.scale)];
  }

  /** Ground metres per pixel at a latitude. */
  mpp(lat) { return metersPerPixel(this.z, lat); }

  inside(px, py) { return px >= 0 && py >= 0 && px <= this.width - 1 && py <= this.height - 1; }

  /** Bilinear height at fractional pixel coordinates (clamped to the grid). */
  sample(px, py) {
    const w = this.width, h = this.height;
    px = clamp(px, 0, w - 1.001); py = clamp(py, 0, h - 1.001);
    const x0 = px | 0, y0 = py | 0, fx = px - x0, fy = py - y0, i = y0 * w + x0, d = this.data;
    const a = d[i] + (d[i + 1] - d[i]) * fx;
    const b = d[i + w] + (d[i + w + 1] - d[i + w]) * fx;
    return a + (b - a) * fy;
  }

  heightAt(lon, lat) { const [x, y] = this.toPixel(lon, lat); return this.sample(x, y); }

  /** Water mask: cells whose 3x3 neighbourhood is perfectly flat (DEMs are
   *  hydro-flattened) or at/below sea level. 1 = water. */
  waterMask() {
    if (this._water) return this._water;
    const w = this.width, h = this.height, d = this.data, m = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x, v = d[i];
        if (v <= 0.5) { m[i] = 1; continue; }
        let flat = true;
        for (let dy = -1; dy <= 1 && flat; dy++) for (let dx = -1; dx <= 1; dx++) if (Math.abs(d[i + dy * w + dx] - v) > 0.01) { flat = false; break; }
        if (flat) m[i] = 1;
      }
    }
    // Drop isolated specks: water needs at least 6 water cells in its 5x5.
    const out = new Uint8Array(w * h);
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        if (!m[i]) continue;
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) n += m[i + dy * w + dx];
        if (n >= 6) out[i] = 1;
      }
    }
    this._water = out;
    return out;
  }
}
