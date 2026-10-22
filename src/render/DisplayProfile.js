import { pixelGrid } from './PixelRenderPolicy.js';
// Independent preferences; legacy records are read for migration and never written.
export const DISPLAY_PREFS_KEY = 'midio-pixel:display:v1';
export const LEGACY_V2_DISPLAY_PREFS_KEY = 'smw:display:v2';
export const LEGACY_DISPLAY_PREFS_KEY = 'smw:display:v1';
export const DEFAULT_DISPLAY_PREFS = Object.freeze({ version: 2, look: 'pixel', quality: 'auto', palette: 'world', dither: .35, ditherMode: 'selective', pixelGrid: 'classic', scaling: 'fit', pixelScale: 'original' });
function parseRecord(saved) {
  try { return typeof saved === 'string' ? JSON.parse(saved) : saved; } catch { return null; }
}
function validRecord(prefs) { return prefs && [1, 2].includes(prefs.version) && ['natural', 'pixel', 'palette'].includes(prefs.look); }

export function resolveDisplayPrefs({ saved, legacyStagePreset } = {}) {
  const prefs = parseRecord(saved);
  if (validRecord(prefs)) {
    const old = prefs.version === 1;
    // Keep the canonical field for saved records and diagnostics. Depth was
    // removed; old selections migrate to the same uniform raster as new ones.
    const defaults = { ...DEFAULT_DISPLAY_PREFS, ...(old ? { palette: 'range32', ditherMode: 'ordered' } : {}) };
    const choices = { look: ['pixel', 'palette'], quality: ['auto', 'economy'],
      palette: old ? ['range32', 'rgb332'] : ['world', 'range32', 'chroma32', 'rgb332'],
      dither: [0, .35, 1], ditherMode: ['ordered', 'selective'], pixelGrid: ['classic', 'medium', 'detailed'], scaling: ['fit', 'integer'] };
    for (const [key, values] of Object.entries(choices)) if (values.includes(prefs[key]) && !(old && ['ditherMode', 'pixelGrid'].includes(key))) defaults[key] = prefs[key];
    return defaults;
  }
  const defaults = { ...DEFAULT_DISPLAY_PREFS };
  if (legacyStagePreset === '8bit') return { ...defaults, look: 'pixel', quality: 'economy', palette: 'range32', ditherMode: 'ordered', pixelScale: 'original' };
  if (legacyStagePreset === '8bit-intensive') return { ...defaults, look: 'palette', quality: 'economy', palette: 'rgb332', dither: 1, ditherMode: 'ordered', pixelScale: 'original' };
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
  return { pixelated: true, grid: pixelGrid(p.pixelGrid),
    paletteId: p.look === 'palette' ? p.palette : 'none', dither: p.dither, ditherMode: p.ditherMode, quality: p.quality, scaling: p.scaling, pixelScale: p.pixelScale };
}
