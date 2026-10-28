import { PALETTES } from './PaletteCatalog.js';
import { buildDitherWeights } from './PixelDither.js';
import { PIXEL_GRIDS, MAX_PIXEL_PIXELS, pixelGrid } from './PixelRenderPolicy.js';
// Palette quantization for "8-bit intensive" (StagePresets.PALETTE_PRESET).
//
// Plain 8-bit mode gets its look from pixel SIZE alone -- a 320x180 buffer
// scaled up with nearest-neighbour. This adds the other half of what made
// 8-bit hardware look the way it did: a framebuffer that could not store
// more than 256 colors. "8-bit color" means exactly that, and the historical
// split is R3 G3 B2 -- eight red levels, eight green, four blue, blue last
// because the eye resolves it worst.
//
// This is the pass deliberately left out of plain 8-bit mode, and the reason
// is worth restating rather than rediscovering: real hardware got the banded
// look FREE from its framebuffer format, while Canvas 2D has to read the
// frame back, rewrite every pixel, and upload it again -- every frame. That
// readback is the expensive part (a GPU->CPU sync), not the arithmetic. It
// is only affordable at all because the buffer this runs on is 320x180, i.e.
// 57,600 pixels rather than a 1080p frame's two million. Hence the mode's
// own name: it buys the authentic look and is honest about costing for it.
//
// Ordered (Bayer) dithering is not a flourish here, it is what makes the
// mode usable. This game's frames are mostly large smooth gradients -- skies,
// haze, depth washes -- and those are precisely what naive quantization
// wrecks, turning a sunset into a half-dozen hard stripes. A 4x4 ordered
// dither trades that banding for a fine stipple, which is both closer to how
// period hardware and artists actually coped with small palettes, and much
// less objectionable in motion.

// Classic 4x4 Bayer matrix, values 0..15 in the recursive threshold order.
const BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

/** Build a [16 x 256] lookup: for each Bayer cell and each input byte, the
 *  quantized output byte. Doing the dither offset, the quantization and the
 *  expansion back to full range up front means the per-pixel cost at draw
 *  time is one array index per channel -- no arithmetic, no branches.
 *
 *  `levels` is how many distinct values the channel keeps (8 for a 3-bit
 *  channel, 4 for a 2-bit one). The output is expanded back across the full
 *  0..255 range rather than left truncated, so the brightest level is a true
 *  255 -- truncation alone would darken the whole frame by up to 31/255 and
 *  read as a wash rather than as a palette. */
function buildDitherLut(levels, strength = 1) {
  const lut = new Uint8Array(16 * 256);
  const step = 255 / (levels - 1); // distance between adjacent output levels
  const top = levels - 1;
  for (let cell = 0; cell < 16; cell++) {
    // floor(v/step + frac), with frac in [0,1) -- the classic ordered-dither
    // formulation, and floor rather than round for a specific reason: a value
    // that already sits exactly on a palette level has an integer v/step, so
    // adding any frac below 1 and flooring returns that same level. Pure
    // black and pure white therefore never dither, where a round()-based
    // offset would straddle their boundary and stipple them (white came out
    // as a mix of 219 and 255). For values BETWEEN levels the fraction of
    // cells that step up equals the distance to the upper level, which is
    // what makes the dither unbiased -- hence the +0.5, centering the 16
    // cells on 0.5 rather than leaving their mean at 15/32.
    const frac = .5 + (((BAYER_4X4[cell] + 0.5) / 16) - .5) * strength;
    for (let v = 0; v < 256; v++) {
      const level = Math.floor(v / step + frac);
      const clamped = level < 0 ? 0 : level > top ? top : level;
      lut[cell * 256 + v] = Math.round(clamped * step);
    }
  }
  return lut;
}

// Built once at module load: ~8KB total, shared by every frame.
const LUT_3BIT = buildDitherLut(8); // red, green
const LUT_2BIT = buildDitherLut(4); // blue

/** Quantize an ImageData's pixels in place to the 256-color R3G3B2 palette
 *  with 4x4 ordered dithering. Exported for its own sake so the palette
 *  itself is testable without a canvas.
 *
 *  Alpha is left untouched, and that has a measurable consequence worth
 *  knowing rather than rediscovering. A canvas stores premultiplied color
 *  but hands getImageData/putImageData unpremultiplied bytes, so on pixels
 *  whose alpha is neither 0 nor 255 the round trip re-rounds what we wrote
 *  and nudges it off the palette. Where a frame is opaque -- which is the
 *  case that matters, since a song's frame opens with a sky gradient over
 *  every pixel -- the palette is exact. The title backdrop is the exception:
 *  it draws over a cleared canvas and is mostly partial alpha (measured: 251
 *  distinct alpha values, ~2% of pixels fully opaque), so there the palette
 *  reads as approximate -- still a heavy quantization, just not exactly 256
 *  colors. Forcing alpha to 255 would make it exact everywhere at the cost
 *  of painting the title's transparent background black instead of letting
 *  the page's own color show through, which is not a trade this mode should
 *  make on its own. */
const RGB_LUTS = new Map([[1, [LUT_3BIT, LUT_2BIT]], [0, [buildDitherLut(8, 0), buildDitherLut(4, 0)]], [.35, [buildDitherLut(8, .35), buildDitherLut(4, .35)]]]);
export function quantizeImageData(imageData, { dither = 1 } = {}) {
  const [redGreen, blue] = RGB_LUTS.get(dither) || RGB_LUTS.get(1);
  const { data, width, height } = imageData;
  for (let y = 0; y < height; y++) {
    // The dither cell's row offset is constant across a scanline.
    const rowCell = (y & 3) * 4;
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      const cell = (rowCell + (x & 3)) * 256;
      data[i] = redGreen[cell + data[i]];
      data[i + 1] = redGreen[cell + data[i + 1]];
      data[i + 2] = blue[cell + data[i + 2]];
    }
  }
  return imageData;
}

/** Read the composed frame back, quantize it, and write it out again.
 *  Never throws: a tainted or zero-sized canvas must degrade to "the frame
 *  simply is not quantized", never to a dead render loop. */
export function quantizeCanvas(ctx, canvas) {
  const w = canvas.width | 0, h = canvas.height | 0;
  if (w <= 0 || h <= 0 || w * h > pixelGrid().pixels) return false;
  try {
    const frame = ctx.getImageData(0, 0, w, h);
    quantizeImageData(frame);
    ctx.putImageData(frame, 0, 0);
    return true;
  } catch {
    return false; // e.g. a tainted canvas -- drop the effect, keep the frame
  }
}

/** `prepare({ frame })`, when given, edits the read-back frame before it is
 *  quantized (the Landscape crest re-owns its cells there), so the palette
 *  pass stays the only grid readback. */
export function applyPalette(ctx, canvas, { paletteId = 'rgb332', dither = 1, ditherMode = 'ordered', weights = null, grid = null, compiled = null, prepare = null } = {}) {
  const pixels = (canvas?.width || 0) * (canvas?.height || 0);
  if (!pixels) return { applied: false, reason: 'empty', pixels };
  if (pixels > MAX_PIXEL_PIXELS) return { applied: false, reason: 'oversize', pixels };
  const allowed = grid ? PIXEL_GRIDS[grid.id] : Object.values(PIXEL_GRIDS).find(g => g.width === canvas.width && g.height === canvas.height);
  if (!allowed || grid && (grid.width !== allowed.width || grid.height !== allowed.height)
    || canvas.width !== allowed.width || canvas.height !== allowed.height) return { applied: false, reason: 'grid-mismatch', pixels };
  if (!ctx) return { applied: false, reason: 'unavailable', pixels };
  try {
    const start = performance.now();
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (prepare && (PALETTES[paletteId] || paletteId === 'rgb332')) prepare({ frame });
    const transformStart = performance.now();
    const selective = !!PALETTES[paletteId] && ditherMode === 'selective' && dither > 0 && !!weights;
    if (selective) buildDitherWeights(frame, weights);
    const maskEnd = performance.now();
    if (PALETTES[paletteId]) quantizePalette(frame, compiled || compilePalette(PALETTES[paletteId].colors), { dither, weights: selective ? weights : null });
    else if (paletteId === 'rgb332') quantizeImageData(frame, { dither });
    else return { applied: false, reason: 'unavailable', pixels };
    const transformEnd = performance.now();
    ctx.putImageData(frame, 0, 0);
    const end = performance.now();
    return { applied: true, reason: null, pixels, ditherMode: selective ? 'selective' : 'ordered',
      cpuMs: transformEnd - transformStart, maskMs: maskEnd - transformStart, transformMs: transformEnd - maskEnd,
      readbackMs: transformStart - start, writebackMs: end - transformEnd, totalMs: end - start };
  } catch (err) {
    return { applied: false, reason: err?.name === 'SecurityError' ? 'security' : 'unavailable', pixels };
  }
}

const COMPILED = new WeakMap();
const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
});
/** Compile a 5-bit/channel nearest pair once; frame work never scans colors. */
export function compilePalette(colors) {
  const signature = colors.join(',');
  const cached = COMPILED.get(colors);
  if (cached?.signature === signature) return cached;
  if (!colors.length || colors.length > 256 || !colors.every(c => /^#[0-9a-f]{6}$/i.test(c))) throw new TypeError('Palette needs 1–256 hex colors');
  const rgb = colors.map(c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)));
  const linear = rgb.map(c => c.map(v => LINEAR[v]));
  const exact = new Map(rgb.map((c, i) => [(c[0] << 16) | (c[1] << 8) | c[2], i]));
  const first = new Uint8Array(32768), second = new Uint8Array(32768), mix = new Float32Array(32768);
  for (let key = 0; key < 32768; key++) {
    const p = [key >> 10, (key >> 5) & 31, key & 31].map(v => LINEAR[Math.round(v * 255 / 31)]);
    let a = 0, b = 0, d1 = Infinity, d2 = Infinity;
    for (let i = 0; i < linear.length; i++) {
      const c = linear[i];
      const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
      if (d < d1) { b = a; d2 = d1; a = i; d1 = d; }
      else if (d < d2) { b = i; d2 = d; }
    }
    const ca = linear[a], cb = linear[b];
    const direction = cb.map((v, i) => v - ca[i]);
    const denominator = direction.reduce((sum, v) => sum + v * v, 0);
    const projection = direction.reduce((sum, v, i) => sum + (p[i] - ca[i]) * v, 0);
    first[key] = a; second[key] = b;
    mix[key] = denominator > 0 ? Math.max(0, Math.min(.5, projection / denominator)) : 0;
  }
  const compiled = { signature, rgb, exact, first, second, mix };
  COMPILED.set(colors, compiled);
  return compiled;
}
export function quantizePalette(imageData, compiled, { dither = .35, weights = null } = {}) {
  const { data, width, height } = imageData;
  const strength = [0, .35, 1].includes(dither) ? dither : .35;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const packed = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let index = compiled.exact.get(packed);
    if (index === undefined) {
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      const threshold = (BAYER_4X4[(y & 3) * 4 + (x & 3)] + .5) / 16;
      const weight = weights ? weights[y * width + x] / 255 : 1;
      index = threshold < compiled.mix[key] * strength * weight ? compiled.second[key] : compiled.first[key];
    }
    const color = compiled.rgb[index];
    data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2];
  }
  return imageData;
}
