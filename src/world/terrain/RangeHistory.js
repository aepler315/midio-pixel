// The ranges this player has been shown lately, newest first, so the next
// song can pass them over (RangeMatcher's `recent`). Per device, in
// localStorage; a private window or blocked storage just means no history.

export const RANGE_HISTORY_KEY = 'smw:recentRanges';
// Three ranges per song (one per ridge), so this is about the last ten
// songs' worth.
export const RANGE_HISTORY_MAX = 30;

function storage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function readRecentRanges(store = storage()) {
  try {
    const list = JSON.parse(store?.getItem(RANGE_HISTORY_KEY) || '[]');
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string').slice(0, RANGE_HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

/** Record that `id` was shown. Moving it to the front if already listed. */
export function noteRangeShown(id, store = storage()) {
  if (typeof id !== 'string' || !id) return;
  const next = [id, ...readRecentRanges(store).filter((x) => x !== id)].slice(0, RANGE_HISTORY_MAX);
  try { store?.setItem(RANGE_HISTORY_KEY, JSON.stringify(next)); } catch { /* storage full or blocked */ }
}

// Range v2 scenic views and their regions, kept apart from the range list
// above so the musical skyline pool's history is unchanged.
export const VIEW_HISTORY_KEY = 'smw:recentViews';
export const REGION_HISTORY_KEY = 'smw:recentRegions';
export const VIEW_HISTORY_MAX = 12;

function readList(key, max, store) {
  try {
    const list = JSON.parse(store?.getItem(key) || '[]');
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string').slice(0, max) : [];
  } catch {
    return [];
  }
}

export function readRecentViews(store = storage()) { return readList(VIEW_HISTORY_KEY, VIEW_HISTORY_MAX, store); }
export function readRecentRegions(store = storage()) { return readList(REGION_HISTORY_KEY, VIEW_HISTORY_MAX, store); }

/** Record that a scenic view (and its region) was actually shown. */
export function noteViewShown(view, store = storage()) {
  if (!view?.id) return;
  for (const [key, id] of [[VIEW_HISTORY_KEY, view.id], [REGION_HISTORY_KEY, view.regionId]]) {
    if (typeof id !== 'string' || !id) continue;
    const next = [id, ...readList(key, VIEW_HISTORY_MAX, store).filter((x) => x !== id)].slice(0, VIEW_HISTORY_MAX);
    try { store?.setItem(key, JSON.stringify(next)); } catch { /* storage full or blocked */ }
  }
}
