export const DEFAULT_PLAYBACK_PREFS = Object.freeze({ shuffle: true, continuous: false });
const STORAGE_KEY = 'midio.playback.v1';

function validPrefs(prefs) {
  return {
    shuffle: typeof prefs?.shuffle === 'boolean' ? prefs.shuffle : DEFAULT_PLAYBACK_PREFS.shuffle,
    continuous: typeof prefs?.continuous === 'boolean' ? prefs.continuous : DEFAULT_PLAYBACK_PREFS.continuous,
  };
}

/** Storage may be missing or denied; preferences still work for this session. */
export function readPlaybackPrefs(storage) {
  try {
    return validPrefs(JSON.parse(storage?.getItem?.(STORAGE_KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_PLAYBACK_PREFS };
  }
}

/** Return whether the validated preferences were persisted. */
export function writePlaybackPrefs(storage, prefs) {
  try {
    if (typeof storage?.setItem !== 'function') return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(validPrefs(prefs)));
    return true;
  } catch {
    return false;
  }
}
