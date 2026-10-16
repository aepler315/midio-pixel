// Warm arithmetic only; excludes Canvas readback/writeback and source copying.
import { performance } from 'node:perf_hooks';
import { compilePalette, quantizePalette, quantizeImageData } from '../src/render/PaletteQuantize.js';
import { PALETTES } from '../src/render/PaletteCatalog.js';
import { buildDitherWeights } from '../src/render/PixelDither.js';
import { pixelGrid } from '../src/render/PixelRenderPolicy.js';
const count = 120, results = [];
for (const gridId of ['classic', 'detailed']) {
const { width, height, pixels } = pixelGrid(gridId);
const input = Uint8ClampedArray.from({ length: pixels * 4 }, (_, i) => i % 4 === 3 ? 255 : (Math.imul(i, 1664525) >>> 16) & 255);
for (const name of ['range32', 'chroma32', 'rgb332']) for (const ditherMode of name === 'rgb332' ? ['ordered'] : ['ordered', 'selective']) {
  const frame = { width, height, data: new Uint8ClampedArray(input) };
  const compiled = PALETTES[name] ? compilePalette(PALETTES[name].colors) : null;
  const weights = ditherMode === 'selective' ? new Uint8Array(pixels) : null;
  const transform = () => compiled ? quantizePalette(frame, compiled, { dither: .35, weights }) : quantizeImageData(frame);
  for (let i = 0; i < 10; i++) { frame.data.set(input); if (weights) buildDitherWeights(frame, weights); transform(); }
  let maskMs = 0, transformMs = 0;
  for (let i = 0; i < count; i++) {
    frame.data.set(input);
    const start = performance.now();
    if (weights) buildDitherWeights(frame, weights);
    const transformed = performance.now(); transform();
    maskMs += transformed - start; transformMs += performance.now() - transformed;
  }
  results.push({ grid: gridId, palette: name, ditherMode, frames: count, pixelsPerFrame: pixels,
    meanMaskMs: maskMs / count, meanTransformMs: transformMs / count, meanTotalMs: (maskMs + transformMs) / count });
}
}
console.log(JSON.stringify({ runtime: process.version, scope: 'warm mask/transform arithmetic; excludes Canvas readback/writeback, copying and GPU work', results }, null, 2));
