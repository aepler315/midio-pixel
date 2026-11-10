import { pixelGrid } from './PixelRenderPolicy.js';
// Independent preferences; legacy records are read for migration and never written.
export const DISPLAY_PREFS_KEY = 'midio-pixel:display:v1';
export const LEGACY_V2_DISPLAY_PREFS_KEY = 'smw:display:v2';
export const LEGACY_DISPLAY_PREFS_KEY = 'smw:display:v1';
/** Cinematic's detail level, from the grid-harmony sweep
 *  (docs/cinematic-grid-harmony.md): 640x360 scales by a whole number at
 *  720p, 1080p, 1440p and 2160p, keeps pixel units exact, and lands the cell
 *  reconstruction on its validated residual, at a desktop cost within noise
 *  of Classic. */
export const CINEMATIC_PIXEL_GRID = 'detailed';
/** Cinematic is the only look: the Pixel and Palette looks (and with them
 *  palettes and dither) were removed. `look` stays in the record so older
 *  builds and saved records keep reading it. */
export const DEFAULT_DISPLAY_PREFS = Object.freeze({ version: 2, look: 'cinematic', quality: 'auto', pixelGrid: CINEMATIC_PIXEL_GRID, scaling: 'fit', pixelScale: 'original', buildPixelDetail: true });
/** The detail level used when none was chosen. */
export const defaultGridFor = () => CINEMATIC_PIXEL_GRID;
const PIXEL_GRIDS = ['classic', 'classicPlus', 'medium', 'mediumPlus', 'detailed'];
function parseRecord(saved) {
  try { return typeof saved === 'string' ? JSON.parse(saved) : saved; } catch { return null; }
}
/** Records from every earlier look still migrate. */
function validRecord(prefs) { return prefs && [1, 2].includes(prefs.version) && ['natural', 'pixel', 'palette', 'cinematic'].includes(prefs.look); }

export function resolveDisplayPrefs({ saved, legacyStagePreset } = {}) {
  const prefs = parseRecord(saved);
  const defaults = { ...DEFAULT_DISPLAY_PREFS };
  if (validRecord(prefs)) {
    const old = prefs.version === 1;
    const choices = { quality: ['auto', 'economy'], pixelGrid: PIXEL_GRIDS, scaling: ['fit', 'integer'] };
    for (const [key, values] of Object.entries(choices)) if (values.includes(prefs[key]) && !(old && key === 'pixelGrid')) defaults[key] = prefs[key];
    // A detail level saved under the removed Pixel and Palette looks was
    // nearly always their Classic default, so those records start at
    // Cinematic's own level; a Cinematic record keeps its chosen one.
    if (prefs.look !== 'cinematic') defaults.pixelGrid = CINEMATIC_PIXEL_GRID;
    if (typeof prefs.buildPixelDetail === 'boolean') defaults.buildPixelDetail = prefs.buildPixelDetail;
    return defaults;
  }
  // The retired 8-bit stage presets keep their economy quality.
  if (legacyStagePreset === '8bit' || legacyStagePreset === '8bit-intensive') return { ...defaults, quality: 'economy' };
  return defaults;
}

export function readDisplayPrefs(storage) {
  const read = key => { try { return storage?.getItem(key); } catch { return null; } };
  const current = parseRecord(read(DISPLAY_PREFS_KEY));
  if (current?.version === 2 && validRecord(current)) return resolveDisplayPrefs({ saved: current });
  const previous = parseRecord(read(LEGACY_V2_DISPLAY_PREFS_KEY));
  if (previous?.version === 2 && validRecord(previous)) return resolveDisplayPrefs({ saved: previous });
  return resolveDisplayPrefs({ saved: read(LEGACY_DISPLAY_PREFS_KEY), legacyStagePreset: read('smw:stageRes') });
}
export function writeDisplayPrefs(storage, prefs) {
  try { storage?.setItem(DISPLAY_PREFS_KEY, JSON.stringify(resolveDisplayPrefs({ saved: prefs }))); return !!storage; }
  catch { return false; }
}
export function resolvePresentation(prefs) {
  const p = resolveDisplayPrefs({ saved: prefs });
  return { pixelated: true, cinematicPixel: true, buildPixelDetail: p.buildPixelDetail, grid: pixelGrid(p.pixelGrid),
    quality: p.quality, scaling: p.scaling, pixelScale: p.pixelScale };
}
