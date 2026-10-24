// Scenic shot tours, render stage (docs/scenic-tours.md): actual-renderer
// evaluation of shortlisted camera poses, used offline to re-rank shots.
// src/dev/shot-review.html draws a pose with the production terrain
// material and forest, reads the frame back from the GPU and measures it
// with the pure functions below; openShotReview drives that page from Node
// (Playwright, headless) and contactSheet tiles the frames into one PNG.
//
// The page imports this file (the driver serves it beside the source
// snapshot), so nothing Node-only is imported at the top: the driver and
// the sheet writer load their modules when called.
//
// Pixel arrays are row-major with the top row first (RGBA: 4 bytes per
// pixel). Depth arrays hold view-space z in metres, Infinity where nothing
// was drawn. Poses are { eyeM, targetM, fovYDeg } in the view's local frame.

/** RangeScene's camera planes. */
export const SHOT_NEAR_M = 20;
export const SHOT_FAR_M = 150000;
/** Distance histogram bin edges (metres, roughly logarithmic). */
export const DEPTH_EDGES_M = Object.freeze([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 150000]);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const round4 = (v) => Math.round(v * 1e4) / 1e4;

/** Camera frame of a pose at a frame size: forward, right and up unit
 *  vectors (three.js lookAt with +Y up) and the half-angle tangents. */
export function poseFrame({ eyeM, targetM, fovYDeg }, width, height) {
  const f = unit(sub(targetM, eyeM)), r = unit([-f[2], 0, f[0]]);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const tanY = Math.tan((fovYDeg * Math.PI) / 360);
  return { eye: eyeM, f, r, u, tanY, tanX: (tanY * width) / height, width, height };
}

/** Pixel position (x right, y down; pixel i covers [i, i + 1)) and view
 *  depth z of a world point. z <= 0 is behind the camera. */
export function projectPoint(frame, p) {
  const d = sub(p, frame.eye), z = dot(d, frame.f);
  return { x: ((1 + dot(d, frame.r) / (z * frame.tanX)) * frame.width) / 2, y: ((1 - dot(d, frame.u) / (z * frame.tanY)) * frame.height) / 2, z };
}

/** Ray through the centre of pixel (i, j), scaled so its forward component
 *  is 1 (eye + z * ray is the point at view depth z). */
function pixelRay(frame, i, j) {
  const sx = (((i + 0.5) / frame.width) * 2 - 1) * frame.tanX, sy = (1 - ((j + 0.5) / frame.height) * 2) * frame.tanY;
  return [0, 1, 2].map((k) => frame.f[k] + sx * frame.r[k] + sy * frame.u[k]);
}

/** Pixels whose ray meets the plane y = floorY inside the grid's XZ extent
 *  [x0, z0, x1, z1] within the far plane. Every DEM sample of the grid lies
 *  above floorY (the package's quantization offset), so with the eye inside
 *  the grid such a ray must cross the ground: if nothing was drawn there,
 *  the package is missing that ground. */
export function floorMask(frame, { floorY, extent, far = SHOT_FAR_M }) {
  const { width, height, eye } = frame, out = new Uint8Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const d = pixelRay(frame, i, j);
      if (!(d[1] < 0)) continue;
      const z = (floorY - eye[1]) / d[1], x = eye[0] + z * d[0], w = eye[2] + z * d[2];
      if (z > 0 && z <= far && x >= extent[0] && x <= extent[2] && w >= extent[1] && w <= extent[3]) out[j * width + i] = 1;
    }
  }
  return out;
}

/** GL readback rows run bottom-up; flip them to the top row first. */
export function flipRows(bytes, width, height, channels = 4) {
  const out = new Uint8Array(width * height * channels), row = width * channels;
  for (let j = 0; j < height; j++) out.set(bytes.subarray((height - 1 - j) * row, (height - j) * row), j * row);
  return out;
}

/** Terrain mask from an RGBA frame cleared to transparent. */
export function alphaMask(rgba) {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
  return out;
}

/** View-space z from a GL readback of window depth (0..1) whose Float32
 *  bits were packed into RGBA8 (the page's decode pass), rows bottom-up.
 *  Exact inverse of the perspective projection; depth 1 is nothing drawn. */
export function decodeDepth(bytes, width, height, near = SHOT_NEAR_M, far = SHOT_FAR_M) {
  const d = new Float32Array(bytes.buffer, bytes.byteOffset, width * height), out = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const v = d[(height - 1 - j) * width + i];
      out[j * width + i] = v >= 1 ? Infinity : (near * far) / (far - v * (far - near));
    }
  }
  return out;
}

/**
 * Coverage, skyline and holes from a terrain mask (as review-range-views'
 * silhouette metrics). A hole is a background pixel below its column's
 * topmost terrain pixel (an interior gap: a missing tile), or one whose ray
 * must have met the ground (`floor`, from floorMask); interiorHoles counts
 * the first kind only. `skyline[x]` is the column's topmost terrain row
 * over the frame height (1: none).
 */
export function silhouetteMetrics(mask, width, height, { floor = null } = {}) {
  const skyline = new Float32Array(width);
  let terrain = 0, holes = 0, interior = 0;
  for (let x = 0; x < width; x++) {
    let top = height;
    for (let y = 0; y < height; y++) {
      const i = y * width + x;
      if (mask[i]) { if (top === height) top = y; terrain++; }
      else if (top < height) { holes++; interior++; }
      else if (floor?.[i]) holes++;
    }
    skyline[x] = top / height;
  }
  // Longest run of columns whose skyline stays within 1.5% of the frame
  // height of the run's start in the upper half: a "flat wall".
  let wall = 0, lo = 1, hi = 0, travel = 0;
  for (let x = 0; x < width;) {
    let e = x + 1;
    while (e < width && Math.abs(skyline[e] - skyline[x]) < 0.015) e++;
    if (skyline[x] < 0.5) wall = Math.max(wall, (e - x) / width);
    x = e;
  }
  for (let x = 0; x < width; x++) {
    lo = Math.min(lo, skyline[x]); hi = Math.max(hi, skyline[x]);
    if (x) travel += Math.abs(skyline[x] - skyline[x - 1]);
  }
  return { terrainFrac: terrain / (width * height), holes: holes / (width * height), interiorHoles: interior / (width * height), skylineTop: lo, skylineBottom: hi,
    skylineRange: hi - lo, skylineTravel: travel, flatWallRun: wall, skyline: Array.from(skyline, round4) };
}

/** Distance (along each pixel's ray) histogram over DEPTH_EDGES_M as
 *  fractions of the frame, the sky fraction and distance quantiles. */
export function depthMetrics(frame, depth, { edgesM = DEPTH_EDGES_M } = {}) {
  const { width, height } = frame, hist = new Array(edgesM.length - 1).fill(0), dist = [];
  for (let j = 0; j < height; j++) {
    const sy = (1 - ((j + 0.5) / height) * 2) * frame.tanY;
    for (let i = 0; i < width; i++) {
      const z = depth[j * width + i];
      if (z === Infinity) continue;
      const sx = (((i + 0.5) / width) * 2 - 1) * frame.tanX, m = z * Math.sqrt(1 + sx * sx + sy * sy);
      let b = 0;
      while (b < hist.length - 1 && m >= edgesM[b + 1]) b++;
      hist[b]++;
      dist.push(m);
    }
  }
  const n = width * height, sorted = Float64Array.from(dist).sort();
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
  return { depth: { edgesM: [...edgesM], frac: hist.map((c) => round4(c / n)), sky: round4(1 - sorted.length / n),
    nearestM: sorted.length ? sorted[0] : null, p10M: q(0.1), p50M: q(0.5), p90M: q(0.9) } };
}

/** Luma (Rec. 709 weights on the encoded values, 0..1) statistics of the
 *  terrain in a material frame: mean, standard deviation, local contrast
 *  (mean |L - mean of its terrain 4-neighbours|) and edge density (share of
 *  pixels differing from the left neighbour by more than 10/255). */
export function luminanceMetrics(rgba, mask, width, height) {
  const L = new Float32Array(width * height);
  let frame = 0;
  for (let i = 0; i < L.length; i++) { L[i] = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255; frame += L[i]; }
  let n = 0, sum = 0, sum2 = 0, contrast = 0, edges = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      n++; sum += L[i]; sum2 += L[i] * L[i];
      let s = 0, k = 0;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
        if (j >= 0 && mask[j]) { s += L[j]; k++; }
      }
      if (k) contrast += Math.abs(L[i] - s / k);
      if (x > 0 && mask[i - 1] && Math.abs(L[i] - L[i - 1]) > 10 / 255) edges++;
    }
  }
  const mean = n ? sum / n : 0;
  return { mean: round4(mean), std: round4(n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0),
    localContrast: round4(n ? contrast / n : 0), edgeDensity: round4(n ? edges / n : 0), frameMean: round4(frame / L.length) };
}

/** Subject kinds whose posM is a floor (water level, valley floor) and
 *  whose heightM is relief above it; scenic-score samples them with relief
 *  0 (kept here: that module imports Node-only code). */
const FLAT_KINDS = new Set(['lake', 'valley', 'shore']);

/**
 * Sample points of a subject { kind, posM, radiusM, heightM } on the drawn
 * ground: its centre and rings out to radiusM, at the package's heights
 * (`heightAt(x, z)`, NaN where the package has no ground). The anchor is
 * posM, lowered onto the ground when it floats above it (a rail target is
 * an aim point in the air). For a raised subject (no kind, or any kind but
 * lake/valley/shore) heightM is its extent below the anchor, and ground
 * lower than that is surroundings, not subject; flat kinds keep every
 * sample (their heightM is the walls' relief above the floor).
 */
export function subjectSamples({ kind, posM, radiusM, heightM = 0 }, heightAt, { rings = 3, spokes = 16 } = {}) {
  const ground = heightAt(posM[0], posM[2]), top = Number.isFinite(ground) ? Math.min(posM[1], ground) : posM[1];
  const floor = !FLAT_KINDS.has(kind) && heightM > 0 ? top - heightM : -Infinity, points = [];
  let unmapped = 0;
  for (let k = 0; k <= rings; k++) {
    const r = (radiusM * k) / rings, n = k ? Math.max(4, Math.round((spokes * k) / rings)) : 1;
    for (let a = 0; a < n; a++) {
      const x = posM[0] + r * Math.cos((2 * Math.PI * a) / n), z = posM[2] + r * Math.sin((2 * Math.PI * a) / n), y = heightAt(x, z);
      if (!Number.isFinite(y)) unmapped++;
      else if (y >= floor) points.push([x, y, z]);
    }
  }
  return { points, unmapped, anchorM: [posM[0], top, posM[2]] };
}

/**
 * Visibility of a subject (subjectSamples' points) in a rendered depth
 * frame, with tol = max(tolM, tolFrac * z) for mesh LOD and trees. A
 * sample in frame is visible when its own pixel is drawn within tol plus
 * the local depth step per pixel of its view depth z (on grazing ground
 * one pixel spans hundreds of metres), or some pixel of its 3x3
 * neighbourhood within tol (a crest narrower than a pixel). Otherwise its
 * own pixel decides: occluded when drawn nearer, missing when drawn
 * farther or not at all (no tile there). Depths across an edge never
 * vouch for a sample, so ground just behind a ridge is occluded. The
 * shares are null when no sample is in frame.
 * screenHeight is the projected vertical spread of the anchor and every
 * sample in front of the camera (in frame or not), as a fraction of the
 * frame height, as scenic-score measures it; centre is the anchor's
 * position in the frame.
 */
export function subjectMetrics(frame, depth, subject, { tolM = 60, tolFrac = 0.015 } = {}) {
  const { width, height } = frame, { points = [], unmapped = 0 } = subject, anchor = subject.anchorM || subject.posM, a = projectPoint(frame, anchor);
  const at = (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? depth[y * width + x] : Infinity);
  let inFrame = 0, visible = 0, occluded = 0, y0 = Infinity, y1 = -Infinity;
  const projected = points.map((p) => projectPoint(frame, p));
  for (const q of [a, ...projected]) if (q.z > SHOT_NEAR_M) { y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  for (const q of projected) {
    if (!(q.z > SHOT_NEAR_M) || !(q.x >= 0 && q.x < width && q.y >= 0 && q.y < height)) continue;
    inFrame++;
    const i = Math.floor(q.x), j = Math.floor(q.y), tol = Math.max(tolM, tolFrac * q.z), own = at(i, j);
    // The drawn surface's depth step per pixel here: per axis the gentler
    // side (a depth edge is on one side only), capped so an isolated pixel
    // (a tree against far ground) is not taken for a slope.
    const step = (a, b) => Math.min(Math.abs(a - own), Math.abs(b - own));
    const slope = Math.min(0.25 * own, Math.max(step(at(i - 1, j), at(i + 1, j)), step(at(i, j - 1), at(i, j + 1))));
    let seen = own < Infinity && Math.abs(own - q.z) <= tol + slope;
    for (let dj = -1; dj <= 1 && !seen; dj++) for (let di = -1; di <= 1 && !seen; di++) seen = Math.abs(at(i + di, j + dj) - q.z) <= tol;
    if (seen) visible++;
    else if (own < q.z) occluded++;
  }
  const total = points.length + unmapped, share = (n) => (inFrame ? round4(n / inFrame) : null);
  return { samples: total, unmapped: total ? round4(unmapped / total) : null, inFrame: total ? round4(inFrame / total) : null,
    visible: share(visible), occluded: share(occluded), missing: share(inFrame - visible - occluded),
    screenHeight: y1 >= y0 ? round4((y1 - y0) / height) : 0,
    centre: a.z > SHOT_NEAR_M ? [round4(a.x / width), round4(a.y / height)] : null, distanceM: Math.hypot(...sub(anchor, frame.eye)) };
}

/**
 * All metrics of one rendered pose.
 *   frame    poseFrame(pose, width, height)
 *   mask     terrain-only silhouette mask (1 drawn): coverage, skyline and
 *            holes (sky seen between trees is not missing ground)
 *   drawn    mask of everything drawn (terrain and trees) for the
 *            luminance statistics; defaults to mask
 *   depth    view-space z per pixel (with trees), or null (silhouette
 *            without a subject)
 *   rgba     material colour, or null
 *   floor    { floorY, extent } for floorMask, or null
 *   subject  { kind, posM, radiusM, heightM, points, unmapped, anchorM }
 *            (subjectSamples)
 */
export function shotMetrics({ frame, mask, drawn = mask, depth = null, rgba = null, floor = null, subject = null }) {
  const { width, height } = frame;
  const out = silhouetteMetrics(mask, width, height, { floor: floor ? floorMask(frame, floor) : null });
  if (depth) Object.assign(out, depthMetrics(frame, depth));
  if (rgba) out.luminance = luminanceMetrics(rgba, drawn, width, height);
  if (subject && depth) out.subject = subjectMetrics(frame, depth, subject);
  return out;
}

const ARGS = (angle) => [`--use-angle=${angle}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/**
 * Open src/dev/shot-review.html for one view in headless Chromium.
 *   cameraPaths  eye polylines ([[x, y, z], ...]) the forest is placed for
 *                besides the rail (ForestCover forestRail); placement cost
 *                grows with segment count, so pass shot eyes decimated to
 *                ~50-100 m rather than every 25 m sample
 *   width/height frame size of every render
 * Resolves a session { viewId, renderer, stats, trees, pageErrors,
 * renderPoses(poses, { mode, subject }) -> [{ png, metrics, ms }],
 * setPaths(cameraPaths), close() }. A pose may carry its own `subject`.
 * The GL backend comes from VISUAL_ANGLE (default 'gl'; 'swiftshader').
 */
export async function openShotReview(viewId, { cameraPaths = null, width = 480, height = 270, budget = 'desktop', timeoutMs = 600000, terrain = null } = {}) {
  const [{ chromium }, fs, { fileURLToPath }, { snapshotSource, serveSnapshot }] = await Promise.all([
    import('playwright'), import('node:fs/promises'), import('node:url'), import('./visual-evaluation-server.mjs')]);
  const self = fileURLToPath(import.meta.url);
  const snapshot = await snapshotSource(fileURLToPath(new URL('../../', import.meta.url)));
  snapshot.files.set('/tools/lib/scenic-render.mjs', await fs.readFile(self));
  const q = new URLSearchParams({ view: viewId, budget, preview: '0' });
  if (cameraPaths) {
    snapshot.files.set('/shot-review/paths.json', Buffer.from(JSON.stringify(cameraPaths)));
    q.set('paths', '/shot-review/paths.json');
  }
  // A candidate terrain package (a re-cull not yet published): served at the
  // published paths and verified against its own hash.
  if (terrain) {
    const { createHash } = await import('node:crypto');
    const base = `/src/assets/range/v2/terrain/${viewId}`;
    snapshot.files.set(`${base}.terrain.json`, Buffer.from(terrain.manifestText));
    snapshot.files.set(`${base}.terrain.bin.gz`, Buffer.from(terrain.payload));
    q.set('terrainSha', createHash('sha256').update(terrain.manifestText).digest('hex'));
  }
  const server = await serveSnapshot(snapshot);
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, args: ARGS(process.env.VISUAL_ANGLE || 'gl'),
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${server.url}/src/dev/shot-review.html?${q}`);
    await page.waitForFunction(() => window.__shotReview?.ready || window.__shotReview?.error, null, { timeout: timeoutMs });
    const info = await page.evaluate(() => { const s = window.__shotReview; return { error: s.error, renderer: s.renderer, stats: s.stats, trees: s.trees }; });
    if (info.error) throw new Error(`shot review ${viewId}: ${info.error}`);
    return {
      viewId, renderer: info.renderer, stats: info.stats, trees: info.trees, pageErrors,
      async renderPoses(poses, { mode = 'material', subject = null } = {}) {
        const results = [];
        for (const pose of poses) {
          const options = { width, height, mode, subject: pose.subject ?? subject };
          results.push(await page.evaluate(([p, o]) => window.__shotReview.renderPose(p, o), [{ eyeM: pose.eyeM, targetM: pose.targetM, fovYDeg: pose.fovYDeg }, options]));
        }
        return results;
      },
      async setPaths(paths) { this.trees = await page.evaluate((p) => window.__shotReview.setPaths(p), paths); return this.trees; },
      async close() { await browser.close(); await server.close(); },
    };
  } catch (error) {
    await browser?.close();
    await server.close();
    throw error;
  }
}

// 3x5 bitmap font: five octal digits per glyph, one per row (4 left, 1 right).
const GLYPHS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:-_/=+()%#?';
const FONT = ('00000 25755 65656 34443 65556 74647 74644 34553 55755 72227 11152 55655 44447 57755 65555 25552 65644 25563 65655 '
  + '34216 72222 55557 55552 55775 55255 55222 71247 75557 26227 61247 61216 55711 74616 34757 71222 75757 75716 00002 00024 '
  + '02020 00700 00007 11244 07070 02720 24442 21112 51245 57575 61202').split(' ');

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG to { width, height, rgb }. */
export function decodePng(buf, zlib) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let at = 8, width = 0, height = 0, type = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), kind = buf.toString('latin1', at + 4, at + 8), body = buf.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); type = body[9];
      if (body[8] !== 8 || ![2, 6].includes(type) || body[12]) throw new Error('only 8-bit non-interlaced RGB/RGBA PNGs');
    } else if (kind === 'IDAT') idat.push(body);
    at += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = width * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[row + i - bpp] : 0, b = y ? px[row - stride + i] : 0, c = y && i >= bpp ? px[row - stride + i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      px[row + i] = (src[i] + pred) & 255;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(px.subarray(i * bpp, i * bpp + 3), i * 3);
  return { width, height, rgb };
}

function encodePng(width, height, rgb, zlib) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const chunk = (kind, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0); head.write(kind, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Tile PNG frames into one labelled PNG sheet (pure Node; no ffmpeg or
 * image libraries). `pngs`: Buffers, base64 strings (renderPoses' png) or
 * file paths. Tiles are box-filtered to `tileWidth` (default: the first
 * frame's width, at most 480) and keep their aspect. Labels are drawn in
 * a 3x5 capitals font. Writes `out` when given; resolves the PNG bytes.
 */
export async function contactSheet(pngs, { columns = 4, labels = [], out = null, tileWidth = null } = {}) {
  const [zlib, fs] = await Promise.all([import('node:zlib'), import('node:fs/promises')]);
  const frames = [];
  for (const p of pngs) {
    const buf = Buffer.isBuffer(p) || p instanceof Uint8Array ? Buffer.from(p) : p.startsWith('iVBOR') ? Buffer.from(p, 'base64') : await fs.readFile(p);
    frames.push(decodePng(buf, zlib));
  }
  if (!frames.length) throw new Error('contact sheet needs frames');
  const tw = tileWidth || Math.min(480, frames[0].width), th = Math.round((tw * frames[0].height) / frames[0].width), bar = 14;
  const cols = Math.min(columns, frames.length), rows = Math.ceil(frames.length / cols), W = cols * tw, H = rows * (th + bar);
  const sheet = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) sheet.set([24, 26, 30], i * 3);
  frames.forEach((f, k) => {
    const ox = (k % cols) * tw, oy = Math.floor(k / cols) * (th + bar) + bar;
    for (let y = 0; y < th; y++) {
      const y0 = Math.floor((y * f.height) / th), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * f.height) / th));
      for (let x = 0; x < tw; x++) {
        const x0 = Math.floor((x * f.width) / tw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * f.width) / tw));
        const acc = [0, 0, 0];
        for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) for (let c = 0; c < 3; c++) acc[c] += f.rgb[(sy * f.width + sx) * 3 + c];
        const n = (y1 - y0) * (x1 - x0);
        sheet.set(acc.map((v) => Math.round(v / n)), ((oy + y) * W + ox + x) * 3);
      }
    }
    // Label: 2x-scaled glyphs, 8 px advance, clipped to the tile.
    const text = String(labels[k] ?? '').toUpperCase();
    for (let c = 0; c < text.length && 4 + c * 8 + 6 <= tw; c++) {
      const g = FONT[GLYPHS.indexOf(text[c])] || FONT[GLYPHS.length - 1];
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) {
          if (!((Number(g[row]) >> (2 - col)) & 1)) continue;
          for (let s = 0; s < 4; s++) sheet.set([230, 230, 230], ((oy - bar + 2 + row * 2 + (s >> 1)) * W + ox + 4 + c * 8 + col * 2 + (s & 1)) * 3);
        }
      }
    }
  });
  const png = encodePng(W, H, sheet, zlib);
  if (out) await fs.writeFile(out, png);
  return png;
}
