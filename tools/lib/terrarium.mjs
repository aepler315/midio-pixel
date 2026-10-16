// Real elevation for the range pipeline: AWS Terrain Tiles ("terrarium"
// encoding), resampled into the north-up lat/lon grid that
// tools/build-terrain-profile.mjs takes.
//
// Terrarium tiles are 256x256 8-bit RGB PNGs on the Web Mercator tile grid,
// elevation = (R * 256 + G + B / 256) - 32768 metres. Public and keyless:
// https://registry.opendata.aws/terrain-tiles/ (sources include USGS 3DEP,
// SRTM, GMTED and ETOPO, mixed by zoom and region).
import zlib from 'node:zlib';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE = 256;

/** Decode a non-interlaced 8-bit RGB or RGBA PNG. Returns {width, height,
 *  channels, data: Uint8Array of width*height*channels}. Enough PNG for
 *  terrain tiles; anything else throws rather than decoding wrongly. */
export function decodePng(buf) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, channels = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8], colorType = body[9], interlace = body[12];
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG (bitDepth ${bitDepth}, colorType ${colorType}, interlace ${interlace})`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      row[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Metres above sea level for one terrarium pixel. */
export function terrariumElevation(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/** Fractional global Web Mercator pixel coordinates at `zoom`. */
export function lonLatToPixel(lon, lat, zoom) {
  const n = TILE * 2 ** zoom;
  const x = ((lon + 180) / 360) * n;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return { x, y };
}

/** Tile x/y ranges covering a lon/lat box at `zoom`. */
export function tilesForBbox({ west, south, east, north }, zoom) {
  const nw = lonLatToPixel(west, north, zoom);
  const se = lonLatToPixel(east, south, zoom);
  return {
    x0: Math.floor(nw.x / TILE), x1: Math.floor(se.x / TILE),
    y0: Math.floor(nw.y / TILE), y1: Math.floor(se.y / TILE),
  };
}

/**
 * Resample decoded tiles into a north-up grid of `cellM` cells covering the
 * box. `tiles` maps "x/y" to decoded PNGs; `bilinear` samples between pixel
 * centres. Returns a Float32Array, row 0 = north, NaN where no tile covers.
 */
export function resampleGrid(bbox, zoom, tiles, cellM) {
  const { west, south, east, north } = bbox;
  const lat0 = ((south + north) / 2) * Math.PI / 180;
  const width = Math.max(2, Math.round(((east - west) * 111320 * Math.cos(lat0)) / cellM));
  const height = Math.max(2, Math.round(((north - south) * 110540) / cellM));
  const elev = new Float32Array(width * height);
  const pixel = (px, py) => {
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    const t = tiles.get(`${tx}/${ty}`);
    if (!t) return NaN;
    const ix = Math.min(TILE - 1, Math.max(0, Math.floor(px - tx * TILE)));
    const iy = Math.min(TILE - 1, Math.max(0, Math.floor(py - ty * TILE)));
    const k = (iy * t.width + ix) * t.channels;
    return terrariumElevation(t.data[k], t.data[k + 1], t.data[k + 2]);
  };
  for (let row = 0; row < height; row++) {
    const lat = north - ((row + 0.5) / height) * (north - south);
    for (let col = 0; col < width; col++) {
      const lon = west + ((col + 0.5) / width) * (east - west);
      const { x, y } = lonLatToPixel(lon, lat, zoom);
      const fx = x - 0.5, fy = y - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const ax = fx - x0, ay = fy - y0;
      const v = (1 - ax) * (1 - ay) * pixel(x0, y0) + ax * (1 - ay) * pixel(x0 + 1, y0)
        + (1 - ax) * ay * pixel(x0, y0 + 1) + ax * ay * pixel(x0 + 1, y0 + 1);
      elev[row * width + col] = v;
    }
  }
  return { width, height, elev };
}

/**
 * The compass bearing of a range's own axis, from the principal direction
 * of its highest ground (cells at or above the `quantile` elevation).
 * 0 = the range runs north-south, 90 = east-west. The skyline builder
 * assumes a north-south crest seen from the east or west; a diagonal range
 * like the Cordillera Blanca (~30 deg) recedes from that camera path along
 * its length and its far end shrinks toward the horizon.
 */
export function rangeAxisDeg(grid, quantile = 0.9) {
  const { width, height, elev } = grid;
  const vals = [];
  for (const v of elev) if (Number.isFinite(v)) vals.push(v);
  if (vals.length < 10) return 0;
  vals.sort((a, b) => a - b);
  const cut = vals[Math.floor(quantile * (vals.length - 1))];
  let n = 0, mx = 0, my = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (elev[y * width + x] >= cut) { n++; mx += x; my += y; }
  }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (elev[y * width + x] < cut) continue;
    const dx = x - mx, dy = y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  // Principal eigenvector angle, measured from the grid's vertical (north).
  const theta = 0.5 * Math.atan2(2 * sxy, syy - sxx);
  // Rows run north->south (y down), so a positive x-per-y slope leans the
  // axis toward the south-east; report it as a bearing east of north.
  return -(theta * 180) / Math.PI;
}

/** How elongated the high ground is: sqrt of the covariance eigenvalue
 *  ratio, 1 for a round massif or a lone cone, large for a long crest. An
 *  axis measured from ground that is not elongated is noise -- Fuji has no
 *  axis -- and must not be used to rotate anything. */
export function rangeElongation(grid, quantile = 0.9) {
  const { width, height, elev } = grid;
  const vals = [];
  for (const v of elev) if (Number.isFinite(v)) vals.push(v);
  if (vals.length < 10) return 1;
  vals.sort((a, b) => a - b);
  const cut = vals[Math.floor(quantile * (vals.length - 1))];
  let n = 0, mx = 0, my = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (elev[y * width + x] >= cut) { n++; mx += x; my += y; }
  }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (elev[y * width + x] < cut) continue;
    const dx = x - mx, dy = y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-9, tr / 2 - disc);
  return Math.sqrt(l1 / l2);
}

/** A camera height that is above the valley it stands in: the grid's low
 *  ground (the `quantile` elevation) plus `aboveM`. A fixed 2,200m suits
 *  Jackson Hole, but Peru's Santa valley floor is ~3,000m -- a camera
 *  there is underground, and terrain right in front fills the whole view. */
export function valleyCameraElevM(grid, { quantile = 0.2, aboveM = 300 } = {}) {
  const vals = [];
  for (const v of grid.elev) if (Number.isFinite(v)) vals.push(v);
  if (!vals.length) return 2200;
  vals.sort((a, b) => a - b);
  return Math.round(vals[Math.floor(quantile * (vals.length - 1))] + aboveM);
}

/**
 * Rotate a north-up grid by `deg` about its centre so a range whose axis
 * bears `deg` runs straight up the grid. The output is sized to hold the
 * whole rotated box; cells that fall outside the original are NaN, which
 * the profile builder already skips.
 */
export function rotateGrid(grid, deg) {
  const { width, height, elev } = grid;
  // Rotate the opposite way to the bearing, so the axis comes to vertical.
  const r = (-deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const outW = Math.ceil(Math.abs(width * c) + Math.abs(height * s));
  const outH = Math.ceil(Math.abs(width * s) + Math.abs(height * c));
  const out = new Float32Array(outW * outH).fill(NaN);
  const cx = (width - 1) / 2, cy = (height - 1) / 2, ox = (outW - 1) / 2, oy = (outH - 1) / 2;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const dx = x - ox, dy = y - oy;
      // Inverse rotation: where in the source does this output cell come from.
      const sx = cx + dx * c + dy * s;
      const sy = cy - dx * s + dy * c;
      const ix = Math.round(sx), iy = Math.round(sy);
      if (ix >= 0 && iy >= 0 && ix < width && iy < height) out[y * outW + x] = elev[iy * width + ix];
    }
  }
  return { width: outW, height: outH, elev: out };
}
