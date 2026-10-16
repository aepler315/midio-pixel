// Worker: build render tiles from prepared DEM windows.
import { buildPrepared } from './TileBuilder.js';

self.onmessage = (e) => {
  const { id, prep, M, detail } = e.data;
  try {
    const t = buildPrepared(prep, { M, detail });
    const { index, ...rest } = t; // the index buffer is shared on the main thread
    void index;
    self.postMessage({ id, tile: rest }, [rest.positions.buffer, rest.uvs.buffer, rest.heights.buffer, rest.tex.buffer, rest.heightfield.buffer, rest.water.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack || err) });
  }
};
