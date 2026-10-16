// The world chosen on the title screen, before any song is loaded.
//
// Worlds used to be choosable only after analysis, in the picker that opens
// once a song is ready. The title screen now offers the same choice up
// front: pick a world there and the song starts in it directly, skipping
// the picker; "Choose for me" starts in the recommended fit; "Show me the
// worlds" (the default) keeps today's post-analysis picker. Remembered
// across visits.

export const TITLE_WORLD_KEY = 'smw:titleWorld';
export const ASK = 'ask';
export const AUTO = 'auto';

/** What a stored/selected value means, given the worlds that exist now.
 *  A remembered world that has since been removed falls back to ASK rather
 *  than silently starting somewhere the player never picked. */
export function resolveTitleWorldChoice(value, worldIds) {
  if (value === AUTO) return { mode: AUTO };
  if (value && value !== ASK && worldIds.includes(value)) return { mode: 'world', id: value };
  return { mode: ASK };
}

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function readTitleWorld(storage = defaultStorage()) {
  try { return storage?.getItem(TITLE_WORLD_KEY) || ASK; } catch { return ASK; }
}

export function writeTitleWorld(value, storage = defaultStorage()) {
  try { storage?.setItem(TITLE_WORLD_KEY, value || ASK); } catch { /* no storage */ }
}
