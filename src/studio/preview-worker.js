import { renderScoutPreview } from './ScoutRender.js';

let grid = null, gridEpoch = -1;
self.onmessage = ({ data }) => {
  if (data.type === 'grid') { grid = data.grid; gridEpoch = data.epoch; return; }
  if (data.type !== 'render') return;
  const { epoch, id } = data;
  try {
    if (!grid || epoch !== gridEpoch) throw new Error('Terrain selection changed before rendering');
    const start = performance.now();
    const result = renderScoutPreview(grid, data.camera, data.options);
    self.postMessage({ epoch, id, result, renderMs: performance.now() - start }, [result.rgba.buffer, result.skylineY.buffer]);
  } catch (error) { self.postMessage({ epoch, id, error: error.message }); }
};
