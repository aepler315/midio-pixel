import { TerrainPreview } from './TerrainPreview.js';
import { normalizeCamera } from './CameraEditor.js';

/** Camera motion follows heard song time, making pause/seek/replay stable. */
export function studioSongProgress(timeMs, durationMs, durationSec = 30) {
  const time = Number.isFinite(timeMs) ? Math.max(0, timeMs) : 0;
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : Math.max(1, Number(durationSec) || 30) * 1000;
  return Math.max(0, Math.min(1, time / duration));
}

/** Bounded coarse terrain is explicitly personal exploration scenery. The
 * normal compositor owns the stage and captures; no second full scene draws. */
export class StudioPlayback {
  constructor({ candidate, settings, grid, document = globalThis.document, onError = () => {} }) {
    this.candidate = candidate;
    this.caption = { rows: [{ label: 'Personal view', name: candidate.name, region: candidate.region }],
      stats: 'Exploration terrain · coarse regional elevation · personal camera',
      credit: 'Elevation: Mapzen / AWS Terrain Tiles. Place data: GeoNames (CC BY 4.0).' };
    this.settings = normalizeCamera(settings, candidate);
    this.canvas = document.createElement('canvas');
    this.canvas.width = 320; this.canvas.height = 180;
    this.preview = new TerrainPreview({ canvas: this.canvas, onStatus: message => {
      if (message === 'Live terrain ready') this.lastError = null;
      else if (!/^(Preparing|Loading)/i.test(message) && message !== this.lastError) {
        this.lastError = message;
        onError(`${message} Automatic scenery is available through Exit personal view.`);
      }
    } });
    this.lastRequested = -Infinity;
    this.lastTime = null;
    this.disposed = false;
    this.prepared = this.preview.useGrid(candidate, grid).then(() => {
      if (this.disposed) return;
      this.preview.setCamera(this.settings);
    });
    this.preview.setCamera(this.settings);
  }
  get ready() { return !this.disposed && this.preview.ready; }
  update(sim, { synchronous = false } = {}) {
    if (this.disposed) return;
    const timeMs = sim?.heardTimeMs ?? sim?.timeMs ?? 0;
    // A backward seek always requests the exact new position; normal updates
    // are capped independently of the stage's output refresh.
    const now = performance.now();
    const jump = this.lastTime !== null && Math.abs(timeMs - this.lastTime) > 400;
    if (synchronous || jump) {
      this.lastTime = timeMs; this.lastRequested = now;
      this.preview.renderExact(studioSongProgress(timeMs, sim?.conductor?.durationMs, this.settings.durationSec));
      return;
    }
    if (timeMs === this.lastTime || (timeMs >= this.lastTime && now - this.lastRequested < 80)) return;
    this.lastTime = timeMs; this.lastRequested = now;
    this.preview.setProgress(studioSongProgress(timeMs, sim?.conductor?.durationMs, this.settings.durationSec));
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.preview.dispose(); this.canvas.width = this.canvas.height = 0; }
}
