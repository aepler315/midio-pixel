// GPU column probe for the Landscape crest line (docs/pixel-presentation.md,
// "Crest line"). After each scenic band renders, one fragment per column
// walks that column of the band's own target (where alpha marks the band as
// frontmost terrain) and records its first covered row, the world elevation
// there (depth unprojected through the camera, mapped by uHeightRange) and
// the land colour just below it. After the water pass it records the first
// four water/land transitions per column, whether each is a real shore
// (continuous depth across it) and how near it is. Everything lands in one
// small target (width x PROBE_ROWS, RGBA8) that is read back once a frame:
// no grid-sized readback is needed for the line itself.
//
// Readback. Live frames read asynchronously (WebGL2: readPixels into a
// PIXEL_PACK_BUFFER, a fence polled without waiting, then getBufferSubData),
// triple buffered: results are collected before current-frame GPU work, and a
// frame uses the newest completed result, normally one or two frames old.
// A live miss omits this optional layer instead of forcing a read. The frame freezes whatever it
// used (RangeCrest snapshot), so display and capture stay identical. Export
// draws (bulk export, highlight re-renders, visual evaluation: `sync`) and
// contexts without WebGL2 fences read synchronously, so exported frames are
// reproducible. A result from another view, song or target size, from
// before a seek is discarded with everything still in flight. A lag-expired
// result is dropped without invalidating newer pending copies. Seeks are found from the clocks (timelineJump: song time
// running backwards, or ahead of the wall clock), so a slow device that
// renders a few frames a second still reads asynchronously.
//
// Row layout: far 0-1, mid 2-3, near 4-5 (crest, colour), water 6-9 (edge
// info), 10-13 (water colour at each edge), fine crest 14-15 far, 16-17 mid,
// 18-19 near.
//
// Fine crest. The band targets are the pixel grid, so their first covered
// row is a whole grid row: a line through those rows can only step by a
// pixel at a time. The fine rows are read from a band-ownership render of
// the same frame at the physical output sampling scale (RangeScene).
// Every physical column is retained, two 16-bit rows per texel, packed
// after the legacy fixed rows and before the edge blocks. The native
// four-sample metadata is derived from these same bytes on the CPU.
//
// Edge cells. The same fine render carries each pixel's distance (log2,
// 16 bits). Where one ridge stands in front of another (any terrain over
// terrain, in one band or across two), a grid cell holds the nearer ridge
// in some of its PROBE_FINE_K² output pixels and the farther one in the
// rest, yet the grid paints it all one colour, so the border steps a whole
// grid pixel at a time. From PROBE_EDGE_ROW up, one texel per grid cell
// (rows bottom-up, like the target) says which of its output pixels show a
// neighbour cell's surface instead of its own: a 16-bit mask and the
// neighbour (edgeCell()). RangeCrest paints those pixels in that
// neighbour's colour, so terrain over terrain meets at output resolution
// while every cell keeps its own colour.
//
// Water edge cells. The water layer is drawn at output resolution over the
// grid, so wherever it is wet it already shows its own edge; but a grid
// cell whose centre is wet shows water in all its pixels, also those the
// output-resolution water render finds dry. The block after the edge cells
// (same layout) marks those dry pixels with a dry neighbour, from that
// render (RangeScene.renderWater), so the shore steps by output pixels too.

export const PROBE_BAND_ROWS = Object.freeze({ far: 0, mid: 2, near: 4 });
export const PROBE_WATER_ROW = 6;
export const PROBE_WATER_SLOTS = 4;
export const PROBE_FINE_ROWS = Object.freeze({ far: 14, mid: 16, near: 18 });
export const PROBE_FINE_K = 4;
export const PROBE_ROWS = 20;
/** Two 16-bit silhouette samples per texel, packed after the legacy rows.
 * Ownership keeps its separate 4x4 mask; silhouette width follows output. */
export function fineLineLayout(width, fineWidth = 0, fineHeight = 0) {
  const rowsPerBand = fineWidth > 0 && fineHeight > 0 ? Math.ceil(fineWidth / (2 * width)) : 0;
  return { width: rowsPerBand ? fineWidth : 0, height: rowsPerBand ? fineHeight : 0,
    row: PROBE_ROWS, rowsPerBand, edgeRow: PROBE_ROWS + 3 * rowsPerBand };
}

export function fineLineRow(probe, band, column) {
  const fine = probe.fine, index = CREST_INDEX[band];
  if (!fine || index === undefined || column < 0 || column >= fine.width) return NaN;
  const pixel = Math.floor(column / 2), row = fine.row + index * fine.rowsPerBand + Math.floor(pixel / probe.width);
  const at = (row * probe.width + pixel % probe.width) * 4 + column % 2 * 2;
  const value = probe.data[at] + probe.data[at + 1] * 256 - 1;
  return value > 0 ? value : NaN;
}
const CREST_INDEX = Object.freeze({ far: 0, mid: 1, near: 2 });
/** First row of the edge-cell block (one row per target row above it). */
export const PROBE_EDGE_ROW = PROBE_ROWS;
/** The fine render's distance code: log2(metres) / PROBE_LOG_RANGE, 16 bits. */
export const PROBE_LOG_RANGE = 24;
/** A neighbour cell is another surface when its distance differs from the
 *  cell's own by more than this factor; an output pixel belongs to it when
 *  its distance lies within PROBE_EDGE_MATCH of that gap from the
 *  neighbour's (a smooth slope never comes that close: its pixels lie
 *  between the two cells' distances, nearer their own). */
export const PROBE_EDGE_JUMP = 1.04;
export const PROBE_EDGE_MATCH = 0.25;
const FINE_CHANNEL = Object.freeze({ far: 0, mid: 1, near: 2 });
/** Neighbour order of edgeCell()'s index: [dx, dy] with y down (grid rows). */
export const EDGE_NEIGHBOURS = Object.freeze([[0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]);

/** The fine render's fragment: distance code in red/green, band in blue
 *  ((index + 1) / 3: far, mid, near). */
export const FINE_FRAG = /* glsl */`
  precision highp float;
  uniform float uClipBelow;
  in vec3 vRenderedWorld;
  out vec4 outColor;
  void main() {
    if (vRenderedWorld.y < uClipBelow) discard;
    float e = clamp(log2(max(length(vRenderedWorld - cameraPosition), 1.0)) / ${PROBE_LOG_RANGE}.0, 0.0, 1.0);
    float v = floor(e * 65535.0 + 0.5), hi = floor(v / 256.0);
    outColor = vec4((v - hi * 256.0) / 255.0, hi / 255.0, FINE_BAND / 3.0, 1.0);
  }
`;

/** Decode an edge texel at byte `offset`: null when the cell shows only its
 *  own surface, else { mask (bit sy·K + sx: the output pixel shows the
 *  neighbour), neighbour (index into EDGE_NEIGHBOURS) }. */
export function edgeCell(data, offset) {
  if (data[offset + 3] < 128) return null;
  const mask = data[offset] | data[offset + 1] << 8;
  const neighbour = data[offset + 2];
  return mask && neighbour < EDGE_NEIGHBOURS.length ? { mask, neighbour } : null;
}
/** Readback buffers in flight at once, and the oldest result (in frames) a
 *  live frame still uses; past it the frame reads synchronously. */
export const PROBE_READBACK_SLOTS = 3;
export const PROBE_MAX_LAG_FRAMES = 3;
/** Song time may advance by up to this many times the wall time between
 *  two probe reads, plus PROBE_SEEK_SLACK_MS, before it counts as a seek. */
export const PROBE_SEEK_RATE = 1.5;
export const PROBE_SEEK_SLACK_MS = 50;

const PROBE_VERT = /* glsl */`
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const PROBE_FRAG = /* glsl */`
  precision highp float;
  precision highp int;
  uniform sampler2D uColor;
  uniform highp sampler2D uDepth;
  uniform int uHeight;
  uniform int uMode;   // 0 crest, 1 crest colour, 2 water edge, 3 water colour
  uniform int uSlot;
  uniform int uUseDepth;
  uniform mat4 uInvViewProj;
  uniform vec2 uHeightRange;
  uniform vec3 uCameraPos;
  uniform sampler2D uFine;
  uniform int uFineK;
  uniform int uFineChannel;
  uniform int uEdgeRow;
  uniform int uWidth;
  uniform int uLineRow;
  out vec4 outColor;
  const float EDGE_JUMP = log2(${PROBE_EDGE_JUMP}) / ${PROBE_LOG_RANGE}.0;
  // Distance code of fine pixel (fx, fy), fy top-down; −1 where no terrain
  // (sky, or a tree that hid it: the fine render is terrain only).
  float fineDist(int fx, int fy) {
    ivec2 size = textureSize(uFine, 0);
    // Ownership always samples a 4x4 cell mask, independently of the true
    // output-sized silhouette render (including noninteger display scales).
    fx = int(floor((float(fx) + 0.5) * float(size.x) / float(uWidth * 4)));
    fy = int(floor((float(fy) + 0.5) * float(size.y) / float(uHeight * 4)));
    if (fx < 0 || fy < 0 || fx >= size.x || fy >= size.y) return -1.0;
    vec4 c = texelFetch(uFine, ivec2(fx, size.y - 1 - fy), 0);
    if (c.a < 0.5) return -1.0;
    return (c.r * 255.0 + c.g * 255.0 * 256.0) / 65535.0;
  }
  // A cell's own distance: the mean of its central fine pixels (the grid
  // samples the cell's centre); −1 unless all of them are terrain.
  float cellDist(int x, int y) {
    int h = uFineK / 2, n = 0;
    float sum = 0.0;
    for (int sy = h - 1; sy <= h; sy++) for (int sx = h - 1; sx <= h; sx++) {
      float d = fineDist(x * uFineK + sx, y * uFineK + sy);
      if (d < 0.0) return -1.0;
      sum += d;
    }
    return sum / 4.0;
  }
  const ivec2 NB[8] = ivec2[8](ivec2(0, -1), ivec2(-1, 0), ivec2(1, 0), ivec2(0, 1), ivec2(-1, -1), ivec2(1, -1), ivec2(-1, 1), ivec2(1, 1));
  vec4 edgeCell(int x, int y) {
    float own = cellDist(x, y);
    if (own < 0.0) return vec4(0.0);
    float nd[8];
    bool any = false;
    for (int n = 0; n < 8; n++) {
      float d = cellDist(x + NB[n].x, y + NB[n].y);
      nd[n] = d >= 0.0 && abs(d - own) > EDGE_JUMP ? d : -1.0;
      any = any || nd[n] >= 0.0;
    }
    // Without a competing surface every vote stays zero. Avoid the sixteen
    // fine samples and their neighbour searches in ordinary interior cells.
    if (!any) return vec4(0.0);
    int masks[8] = int[8](0, 0, 0, 0, 0, 0, 0, 0);
    int votes[8] = int[8](0, 0, 0, 0, 0, 0, 0, 0);
    for (int sy = 0; sy < 4; sy++) for (int sx = 0; sx < 4; sx++) {
      if (sx >= uFineK || sy >= uFineK) continue;
      float d = fineDist(x * uFineK + sx, y * uFineK + sy);
      if (d < 0.0) continue;
      float best = abs(d - own);
      int pick = -1;
      // Equal matches go to the neighbour nearest the pixel.
      vec2 at = (vec2(sx, sy) + 0.5) / float(uFineK) - 0.5;
      for (int n = 0; n < 8; n++) {
        if (nd[n] < 0.0) continue;
        float e = abs(d - nd[n]);
        if (e >= ${PROBE_EDGE_MATCH} * abs(nd[n] - own)) continue;
        e += 1e-6 * dot(at - vec2(NB[n]), at - vec2(NB[n]));
        if (e < best) { best = e; pick = n; }
      }
      if (pick >= 0) { masks[pick] |= 1 << (sy * 4 + sx); votes[pick]++; }
    }
    int pick = -1, most = 0;
    for (int n = 0; n < 8; n++) {
      if (votes[n] > most) { most = votes[n]; pick = n; }
    }
    if (pick < 0) return vec4(0.0);
    int m = masks[pick];
    return vec4(float(m & 255) / 255.0, float(m >> 8) / 255.0, float(pick) / 255.0, 1.0);
  }
  // First row (top down) of fine sub-column fx owned by uFineChannel's band.
  int fineRow(int fx) {
    ivec2 size = textureSize(uFine, 0);
    if (fx < 0 || fx >= size.x) return -1;
    for (int y = 0; y < 16384; y++) {
      if (y >= size.y) break;
      vec4 c = texelFetch(uFine, ivec2(fx, size.y - 1 - y), 0);
      if (c.a >= 0.5 && int(c.b * 3.0 + 0.5) == uFineChannel + 1) return y;
    }
    return -1;
  }
  vec2 encode16(int row) {
    float v = float(row + 1);
    float hi = floor(v / 256.0);
    return vec2((v - hi * 256.0) / 255.0, hi / 255.0);
  }
  ivec2 texel(int x, int y) { return ivec2(x, uHeight - 1 - y); }
  bool covered(int x, int y) { return texelFetch(uColor, texel(x, y), 0).a >= 0.5; }
  vec3 worldAt(int x, int y) {
    vec2 size = vec2(textureSize(uColor, 0));
    ivec2 t = texel(x, y);
    vec2 ndc = (vec2(t) + 0.5) / size * 2.0 - 1.0;
    float d = texelFetch(uDepth, t, 0).r;
    vec4 p = uInvViewProj * vec4(ndc, d * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
  }
  float depthAt(int x, int y) { return texelFetch(uDepth, texel(x, y), 0).r; }
  vec4 encodeRow(int row, float flags, float b, float a) {
    float v = float(row + 1);
    float hi = floor(v / 256.0);
    return vec4((v - hi * 256.0) / 255.0, (hi + flags) / 255.0, b, a);
  }
  // Water render coverage at a target point (in target pixels, top-down).
  bool wetAt(vec2 at) {
    ivec2 size = textureSize(uFine, 0);
    vec2 f = at / vec2(float(uWidth), float(uHeight)) * vec2(size);
    ivec2 t = clamp(ivec2(floor(f)), ivec2(0), size - 1);
    return texelFetch(uFine, ivec2(t.x, size.y - 1 - t.y), 0).a >= 0.5;
  }
  vec4 waterCell(int x, int y) {
    vec2 cell = vec2(float(x), float(y));
    if (!wetAt(cell + 0.5)) return vec4(0.0);
    bool dry[8];
    bool any = false;
    for (int n = 0; n < 8; n++) {
      ivec2 q = ivec2(x, y) + NB[n];
      dry[n] = q.x >= 0 && q.y >= 0 && q.x < uWidth && q.y < uHeight && !wetAt(vec2(q) + 0.5);
      any = any || dry[n];
    }
    if (!any) return vec4(0.0);
    int mask = 0;
    int votes[8] = int[8](0, 0, 0, 0, 0, 0, 0, 0);
    for (int sy = 0; sy < 4; sy++) for (int sx = 0; sx < 4; sx++) {
      if (sx >= uFineK || sy >= uFineK) continue;
      vec2 at = (vec2(sx, sy) + 0.5) / float(uFineK);
      if (wetAt(cell + at)) continue;
      mask |= 1 << (sy * 4 + sx);
      float best = 1e9;
      int pick = 0;
      for (int n = 0; n < 8; n++) {
        if (!dry[n]) continue;
        vec2 dv = at - 0.5 - vec2(NB[n]);
        float d = dot(dv, dv);
        if (d < best) { best = d; pick = n; }
      }
      votes[pick]++;
    }
    if (mask == 0) return vec4(0.0);
    int pick = -1, most = 0;
    for (int n = 0; n < 8; n++) if (votes[n] > most) { most = votes[n]; pick = n; }
    return vec4(float(mask & 255) / 255.0, float(mask >> 8) / 255.0, float(pick) / 255.0, 1.0);
  }
  void main() {
    int x = int(gl_FragCoord.x);
    if (uMode == 8) {
      int fx = ((int(gl_FragCoord.y) - uLineRow) * uWidth + x) * 2;
      outColor = vec4(encode16(fineRow(fx)), encode16(fineRow(fx + 1)));
      return;
    }
    if (uMode == 5) {
      outColor = edgeCell(x, uHeight - 1 - (int(gl_FragCoord.y) - uEdgeRow));
      return;
    }
    if (uMode == 7) {
      outColor = waterCell(x, uHeight - 1 - (int(gl_FragCoord.y) - uEdgeRow));
      return;
    }
    if (uMode == 4) {
      float scale = float(textureSize(uFine, 0).x) / float(uWidth);
      int a = int(floor((float(x) + (float(uSlot * 2) + 0.5) / 4.0) * scale));
      int b = int(floor((float(x) + (float(uSlot * 2) + 1.5) / 4.0) * scale));
      outColor = vec4(encode16(fineRow(a)), encode16(fineRow(b)));
      return;
    }
    int found = -1, kind = 0, count = 0;
    bool prev = false;
    for (int y = 0; y < 4096; y++) {
      if (y >= uHeight) break;
      bool c = covered(x, y);
      if (c != prev) {
        if (uMode < 2) { if (c) { found = y; kind = 1; break; } }
        else { if (count == uSlot) { found = y; kind = c ? 1 : 2; break; } count++; }
      }
      prev = c;
    }
    if (found < 0) { outColor = vec4(0.0); return; }
    if (uMode == 0) {
      float elev = 0.0, flag = 0.5;
      if (uUseDepth == 1 && depthAt(x, found) < 1.0) {
        vec3 w = worldAt(x, found);
        elev = clamp((w.y - uHeightRange.x) / max(1.0, uHeightRange.y - uHeightRange.x), 0.0, 1.0);
        flag = 1.0;
      }
      outColor = encodeRow(found, 0.0, elev, flag);
    } else if (uMode == 1) {
      vec4 c = texelFetch(uColor, texel(x, min(found + 1, uHeight - 1)), 0);
      outColor = vec4(c.rgb / max(c.a, 1.0 / 255.0), 1.0);
    } else {
      int waterRow = kind == 1 ? found : found - 1;
      int landRow = kind == 1 ? found - 1 : found;
      if (uMode == 3) {
        vec4 c = texelFetch(uColor, texel(x, waterRow), 0);
        outColor = vec4(c.rgb / max(c.a, 1.0 / 255.0), 1.0);
        return;
      }
      float shore = 0.0, nearness = 0.0;
      if (uUseDepth == 1 && landRow >= 0 && landRow < uHeight && depthAt(x, landRow) < 1.0 && depthAt(x, waterRow) < 1.0) {
        float dw = length(worldAt(x, waterRow) - uCameraPos), dl = length(worldAt(x, landRow) - uCameraPos);
        shore = abs(dw - dl) / max(1.0, min(dw, dl)) < 0.35 ? 1.0 : 0.0;
        nearness = clamp(1.0 - log(max(dw, 600.0) / 600.0) / log(20000.0 / 600.0), 0.0, 1.0);
      }
      outColor = encodeRow(found, float(kind - 1) * 32.0 + shore * 64.0, nearness, 1.0);
    }
  }
`;

/** Decode one probe texel: its row (−1 when the column had none), whether
 *  the depth-derived value in blue is valid, and for water edges the kind
 *  (1: water below the edge, 2: water above) and whether it is a shore. */
export function probeRow(data, offset) {
  if (!data[offset + 3]) return { row: -1, kind: 0, shore: false, depth: false, value: 0 };
  const hi = data[offset + 1];
  return { row: data[offset] + (hi & 31) * 256 - 1, kind: hi & 32 ? 2 : 1, shore: !!(hi & 64),
    depth: data[offset + 3] > 200, value: data[offset + 2] / 255 };
}

/** True when `gl` can read back asynchronously (WebGL2 fences and pixel pack buffers). */
export function asyncReadbackSupported(gl) {
  return !!gl && typeof gl.fenceSync === 'function' && typeof gl.clientWaitSync === 'function'
    && typeof gl.getBufferSubData === 'function' && typeof gl.createBuffer === 'function' && gl.PIXEL_PACK_BUFFER !== undefined;
}

/**
 * Ring of asynchronous readbacks (plain WebGL2 calls, testable with a fake
 * context). submit() copies the bound read framebuffer into a free pixel
 * pack buffer and fences it; poll() collects every finished copy without
 * waiting and keeps the newest as `latest`; reset() drops `latest` and makes
 * everything in flight stale (its copies are thrown away when they finish).
 */
export class ProbeReadback {
  constructor(gl, slots = PROBE_READBACK_SLOTS) {
    this.gl = gl;
    this.slots = Array.from({ length: slots }, () => ({ buffer: null, bytes: 0, data: null, sync: null, meta: null }));
    this.latest = null;
    this.epoch = 0;
    this.seq = 0;
    this.skipped = 0; // frames not queued because every slot was in flight
    this.failure = null; // a failed fence is distinct from a bounded busy ring
  }

  get inFlight() { return this.slots.filter(s => s.sync).length; }

  /** Queue a copy of rows 0..rows−1 (width × rows RGBA8) of the bound read
   *  framebuffer, tagged with `meta`. False when every slot is in flight. */
  submit(meta, width, rows) {
    const gl = this.gl, slot = this.slots.find(s => !s.sync);
    if (!slot) { this.skipped++; return false; }
    const bytes = width * rows * 4;
    if (!slot.buffer || slot.bytes !== bytes) {
      if (slot.buffer) gl.deleteBuffer(slot.buffer);
      slot.buffer = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      slot.bytes = bytes;
      if (slot.data?.length !== bytes) slot.data = new Uint8Array(bytes);
    } else gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
    try { gl.readPixels(0, 0, width, rows, gl.RGBA, gl.UNSIGNED_BYTE, 0); }
    finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) { this.failure = 'fence'; this._retireBuffer(slot); return false; }
    gl.flush();
    slot.sync = sync;
    slot.meta = { ...meta, width, epoch: this.epoch, seq: this.seq++ };
    return true;
  }

  /** Collect finished copies, never waiting. Returns how many were kept. */
  poll() {
    const gl = this.gl;
    let kept = 0;
    for (const slot of this.slots) {
      if (!slot.sync) continue;
      const status = gl.clientWaitSync(slot.sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) continue;
      gl.deleteSync(slot.sync);
      slot.sync = null;
      if (status === gl.WAIT_FAILED) this.failure = 'wait';
      if (status === gl.WAIT_FAILED || slot.meta.epoch !== this.epoch || (this.latest && this.latest.seq > slot.meta.seq)) {
        this._retireBuffer(slot);
        continue;
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
      try { gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, slot.data); }
      finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); }
      this.latest = { ...slot.meta, data: slot.data };
      kept++;
    }
    return kept;
  }

  /** An unread copy cannot rejoin the reusable pool: rewriting STREAM_READ
   *  storage discards the driver's readback shadow copy. Delete its GPU
   *  storage without a dummy read; retain same-sized CPU scratch for reuse. */
  _retireBuffer(slot) {
    if (slot.buffer) this.gl.deleteBuffer(slot.buffer);
    slot.buffer = slot.meta = null;
    slot.bytes = 0;
  }

  reset() { this.epoch++; this.latest = null; }

  dispose() {
    const gl = this.gl;
    for (const slot of this.slots) {
      if (slot.sync) gl.deleteSync(slot.sync);
      if (slot.buffer) gl.deleteBuffer(slot.buffer);
      slot.sync = slot.buffer = slot.data = slot.meta = null; slot.bytes = 0;
    }
    this.latest = null;
  }
}

/** Whether the timeline jumped between two probe reads `prev` and `cur`
 *  ({ timeMs: song time, wallMs: wall clock }): song time ran backwards, or
 *  ahead of the wall clock (a forward seek). A pause, a slow frame or a
 *  hidden tab is continuous at any frame rate. */
export function timelineJump(prev, cur) {
  if (!prev || !Number.isFinite(prev.timeMs) || !Number.isFinite(cur.timeMs)) return false;
  const dt = cur.timeMs - prev.timeMs, wall = Number.isFinite(prev.wallMs) && Number.isFinite(cur.wallMs) ? Math.max(0, cur.wallMs - prev.wallMs) : Infinity;
  return dt < -1 || dt > PROBE_SEEK_RATE * wall + PROBE_SEEK_SLACK_MS;
}

/** Whether an asynchronous result `r` may stand in for frame `frameId` of
 *  view `viewId` and `timeline` at `timeMs` (probe target `width` ×
 *  `height`). Seeks are discarded by reset() before this runs; song time
 *  running backwards is still refused here. */
export function acceptProbeResult(r, { frameId, viewId = null, timeline = null, timeMs = NaN, width, height }) {
  if (!r || r.width !== width || r.viewId !== viewId || (r.timeline ?? null) !== timeline) return false;
  if (height !== undefined && r.height !== height) return false;
  const lag = frameId - r.frameId;
  if (!(lag >= 1 && lag <= PROBE_MAX_LAG_FRAMES)) return false;
  if (Number.isFinite(timeMs) && Number.isFinite(r.timeMs) && timeMs - r.timeMs < -1) return false;
  return true;
}

export class CrestProbe {
  constructor(THREE, renderer) {
    this.THREE = THREE;
    this.renderer = renderer;
    this.target = null;
    this.width = 0;
    this.height = 0;
    this.data = null;
    this.frameId = -1;
    this.rows = 0; // bitmask of probe rows written this frame
    this.edges = 0; // edge blocks written this frame: 1 terrain, 2 water
    this.edgeRows = 0; // target rows in the edge block (the target's height)
    this.useDepth = true;
    this.readMs = 0;
    this.collectMs = 0;
    this.clock = null; // { viewId, timeline, timeMs, wallMs } of the last read
    let gl;
    try { gl = renderer.getContext?.() || null; } catch { gl = null; }
    this.async = asyncReadbackSupported(gl) ? new ProbeReadback(gl) : null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: PROBE_VERT, fragmentShader: PROBE_FRAG,
      uniforms: { uColor: { value: null }, uDepth: { value: null }, uHeight: { value: 1 }, uMode: { value: 0 }, uSlot: { value: 0 },
        uUseDepth: { value: 0 }, uInvViewProj: { value: new THREE.Matrix4() }, uHeightRange: { value: new THREE.Vector2(0, 1) },
        uCameraPos: { value: new THREE.Vector3() }, uFine: { value: null }, uFineK: { value: PROBE_FINE_K },
        uFineChannel: { value: 0 }, uEdgeRow: { value: PROBE_EDGE_ROW }, uWidth: { value: 1 }, uLineRow: { value: PROBE_ROWS } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** Start a frame: rows written by an earlier frame are no longer valid. */
  begin(frameId, width, height, fineSize = null) {
    this.height = height;
    const layout = fineLineLayout(width, fineSize?.width, fineSize?.height);
    const changed = this.fineLayout?.width !== layout.width || this.fineLayout?.height !== layout.height;
    if (this.frameId === frameId && this.width === width && this.edgeRows === height && !changed) return true;
    this.frameId = frameId;
    this.rows = 0;
    this.edges = 0;
    this.fineData = null;
    this.fineLayout = layout;
    this.edgeRow = layout.edgeRow;
    if (!this.target || this.width !== width || this.edgeRows !== height || changed) {
      this.reset();
      this.width = width; this.edgeRows = height;
      this._allocate(this.edgeRow + 2 * height);
    }
    return true;
  }

  /** Rows to read back: the edge blocks only once written this frame. */
  get totalRows() { return (this.edgeRow ?? PROBE_EDGE_ROW) + (this.edges & 2 ? 2 : this.edges & 1 ? 1 : 0) * (this.edgeRows || 0); }

  _allocate(rows) {
    const THREE = this.THREE;
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(this.width, rows, { depthBuffer: false, stencilBuffer: false,
      type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.data = new Uint8Array(this.width * rows * 4);
  }

  _pass(source, camera, heightRange, row, mode, slot = 0) {
    const r = this.renderer, u = this.material.uniforms;
    const depth = mode < 4 && this.useDepth && source.depthTexture ? source.depthTexture : null;
    u.uColor.value = source.texture; u.uDepth.value = depth; u.uUseDepth.value = depth ? 1 : 0;
    u.uHeight.value = source.height; u.uMode.value = mode; u.uSlot.value = slot;
    u.uWidth.value = this.width;
    if (depth) {
      u.uInvViewProj.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
      u.uCameraPos.value.setFromMatrixPosition(camera.matrixWorld);
      if (heightRange) u.uHeightRange.value.copy(heightRange);
    }
    this.target.viewport.set(0, row, this.width, 1);
    this.target.scissor.set(0, row, this.width, 1);
    this.target.scissorTest = true;
    r.setRenderTarget(this.target);
    r.render(this.scene, this.camera);
    this.rows |= 1 << row;
  }

  /** Probe a band's crest from the band target just rendered. */
  band(source, camera, heightRange, pass) {
    const row = PROBE_BAND_ROWS[pass];
    if (row === undefined || !this.target || source.width !== this.width) return false;
    this._pass(source, camera, heightRange, row, 0);
    this._pass(source, camera, heightRange, row + 1, 1);
    return true;
  }

  /** Probe every physical silhouette column from `fine`; the separate
   * ownership edge mask keeps four samples per native cell. */
  fine(fine) {
    if (!this.target || fine.width !== (this.fineLayout.width || this.width * PROBE_FINE_K)) return false;
    const u = this.material.uniforms;
    u.uFine.value = fine.texture; u.uFineK.value = PROBE_FINE_K;
    if (!this.fineLayout.width) for (const [band, row] of Object.entries(PROBE_FINE_ROWS)) {
      u.uFineChannel.value = FINE_CHANNEL[band];
      for (let half = 0; half < PROBE_FINE_K / 2; half++) this._pass(fine, null, null, row + half, 4, half);
    }
    if (this.fineLayout.width) {
      const r = this.renderer, layout = this.fineLayout;
      for (const index of Object.values(CREST_INDEX)) {
        const row = layout.row + index * layout.rowsPerBand;
        u.uFineChannel.value = index; u.uLineRow.value = row; u.uMode.value = 8;
        this.target.viewport.set(0, row, this.width, layout.rowsPerBand);
        this.target.scissor.set(0, row, this.width, layout.rowsPerBand);
        r.setRenderTarget(this.target); r.render(this.scene, this.camera);
      }
      this.fineData = { ...layout };
    }
    this._edges(this.height);
    u.uFine.value = null;
    return true;
  }

  /** Edge cells (mode 5) of every target row, from the fine render bound as uFine. */
  _edges(rows) {
    if (!(rows > 0) || rows !== this.edgeRows) return false;
    const r = this.renderer, u = this.material.uniforms;
    u.uColor.value = null; u.uDepth.value = null; u.uUseDepth.value = 0;
    u.uHeight.value = rows; u.uMode.value = 5; u.uEdgeRow.value = this.edgeRow;
    this.target.viewport.set(0, this.edgeRow, this.width, rows);
    this.target.scissor.set(0, this.edgeRow, this.width, rows);
    this.target.scissorTest = true;
    r.setRenderTarget(this.target);
    r.render(this.scene, this.camera);
    this.edges |= 1;
    return true;
  }

  /** Water edge cells (mode 7) from `water`, this frame's water render at
   *  output resolution (any size larger than the target). */
  waterEdges(water) {
    const rows = this.edgeRows;
    if (!this.target || !(rows > 0) || !(water.width > this.width)) return false;
    const r = this.renderer, u = this.material.uniforms, row = this.edgeRow + rows;
    // The terrain block in between is read back too: empty unless written.
    if (!(this.edges & 1)) this._clearRows(this.edgeRow, rows);
    u.uFine.value = water.texture; u.uFineK.value = PROBE_FINE_K;
    u.uColor.value = null; u.uDepth.value = null; u.uUseDepth.value = 0;
    u.uHeight.value = rows; u.uWidth.value = this.width; u.uMode.value = 7; u.uEdgeRow.value = row;
    this.target.viewport.set(0, row, this.width, rows);
    this.target.scissor.set(0, row, this.width, rows);
    this.target.scissorTest = true;
    r.setRenderTarget(this.target);
    r.render(this.scene, this.camera);
    u.uFine.value = null;
    this.edges |= 2;
    return true;
  }

  _clearRows(row, rows) {
    const r = this.renderer, THREE = this.THREE, color = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    this.target.scissor.set(0, row, this.width, rows);
    this.target.scissorTest = true;
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.setClearColor(color, alpha);
  }

  /** Probe the water/land transitions of the native water pass. */
  water(source, camera) {
    if (!this.target || source.width !== this.width) return false;
    for (let s = 0; s < PROBE_WATER_SLOTS; s++) {
      this._pass(source, camera, null, PROBE_WATER_ROW + s, 2, s);
      this._pass(source, camera, null, PROBE_WATER_ROW + PROBE_WATER_SLOTS + s, 3, s);
    }
    return true;
  }

  /**
   * Collect previous frames before any current-frame GPU work. Even a
   * signaled getBufferSubData can round-trip the command stream in browsers;
   * collecting at read() after rendering would serialize the whole frame.
   */
  collect() {
    this.collectMs = 0;
    if (!this.async) return;
    const t0 = performance.now();
    try {
      this.async.poll();
      if (this.async.failure) throw Error('Asynchronous crest readback failed');
    } catch {
      try { this.async.dispose(); } catch { /* context lost */ }
      this.async = null;
    }
    this.collectMs = performance.now() - t0;
  }

  /**
   * This frame's crest data. `sync` (export draws) reads this frame's rows
   * synchronously. Otherwise this frame's rows are queued for an
   * asynchronous readback and the newest result collected before rendering
   * is returned when it qualifies (`lag` frames old). A normal live miss is
   * null; only unsupported or failed async readback uses the sync fallback.
   */
  read(frameId, { sync = false, viewId = null, timeline = null, timeMs = NaN, wallMs = performance.now() } = {}) {
    const collectMs = sync ? 0 : this.collectMs || 0;
    this.collectMs = 0;
    if (!this.target || this.frameId !== frameId || !this.rows) return null;
    const t0 = performance.now(), prev = this.clock;
    this.clock = { viewId, timeline, timeMs, wallMs };
    // A new view or song, or a seek: everything older (in flight too) goes.
    if (prev && (prev.viewId !== viewId || prev.timeline !== timeline || timelineJump(prev, this.clock))) this.reset();
    if (this.async && !sync) {
      try {
        const r = this.async.latest, ok = acceptProbeResult(r, { frameId, viewId, timeline, timeMs, width: this.width, height: this.height });
        // Identity/seek/layout changes reset separately. An expired latest
        // result must not poison newer copies already in flight.
        if (r && !ok) this.async.latest = null;
        this.renderer.setRenderTarget(this.target);
        const total = this.totalRows;
        this.async.submit({ frameId, viewId, timeline, timeMs, height: this.height, rows: this.rows, edges: this.edges,
          edgeRow: this.edgeRow, fine: this.fineData }, this.width, total);
        if (this.async.failure) throw Error('Asynchronous crest readback failed');
        if (ok) {
          this.readMs = performance.now() - t0 + collectMs;
          return { width: r.width, height: r.height, data: r.data, rows: r.rows, edges: r.edges || 0, edgeRow: r.edgeRow, fine: r.fine, readMs: this.readMs, frameId: r.frameId,
            lag: frameId - r.frameId, mode: 'async' };
        }
        this.readMs = performance.now() - t0 + collectMs;
        return null;
      } catch {
        try { this.async.dispose(); } catch { /* context lost */ }
        this.async = null;
      }
    } else if (this.async) this.async.reset(); // an export frame: live results restart after it
    const total = this.totalRows;
    try { this.renderer.readRenderTargetPixels(this.target, 0, 0, this.width, total, this.data); }
    catch { return null; }
    this.readMs = performance.now() - t0 + collectMs;
    return { width: this.width, height: this.height, data: this.data, rows: this.rows, edges: this.edges,
      edgeRow: this.edgeRow, fine: this.fineData, readMs: this.readMs, frameId, lag: 0, mode: 'sync' };
  }

  /** Discard every asynchronous result (a seek, a new song or view). */
  reset() { this.async?.reset(); }

  dispose() {
    try { this.async?.dispose(); } catch { /* context lost */ }
    this.async = null;
    this.target?.dispose(); this.target = null;
    this.mesh.geometry.dispose(); this.material.dispose();
    this.data = null; this.width = 0;
  }
}
