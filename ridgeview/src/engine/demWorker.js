// Worker: fetch one terrarium PNG, decode it exactly, return Float32 heights.
import { decodePng, terrariumToHeights, inflateBrowser } from '../core/png.js';

self.onmessage = async (e) => {
  const { id, url } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const img = await decodePng(new Uint8Array(await res.arrayBuffer()), inflateBrowser);
    const heights = terrariumToHeights(img);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < heights.length; i++) { const v = heights[i]; if (v < min) min = v; if (v > max) max = v; }
    self.postMessage({ id, heights, min, max }, [heights.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
