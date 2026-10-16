// Sorting, filtering, and the folder tree: everything the library view does
// to a list of tracks, with none of the DOM it does it for.
//
// This is the part worth testing, so it is the part kept pure. The panel
// holds no opinion about what "sorted by artist" means or which tracks match
// "beatles live" -- it asks here and paints the answer.

/** Numeric-aware and case-insensitive, so "Track 2" precedes "Track 10" and
 *  "abba" sorts with "ABBA" rather than after every capitalised name. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** What to call a track that was never tagged: its filename, minus the
 *  extension, which is what the player already calls it. Never an empty
 *  row -- a track the eye cannot find is worse than a clumsy name. */
export function displayTitle(track) {
  const tagged = (track?.title || '').trim();
  if (tagged) return tagged;
  const name = String(track?.name || '').replace(/\.[a-z0-9]+$/i, '').trim();
  return name || 'Untitled';
}

export function displayArtist(track) {
  return (track?.artist || '').trim() || 'Unknown artist';
}

export function displayAlbum(track) {
  return (track?.album || '').trim() || 'Unknown album';
}

/** Sort a missing value last in BOTH directions.
 *
 *  Reversing a sort should reverse the tracks that have the field, not
 *  promote every untagged file to the top -- "sort by artist, descending"
 *  is a request to see Z first, not to see the blanks first. */
function withUntaggedLast(compare, hasValue) {
  return (a, b, desc) => {
    const ha = hasValue(a), hb = hasValue(b);
    if (ha !== hb) return ha ? -1 : 1;
    const r = compare(a, b);
    return desc ? -r : r;
  };
}

function text(get) {
  return withUntaggedLast(
    (a, b) => collator.compare(get(a) || '', get(b) || ''),
    (t) => !!(get(t) || '').trim(),
  );
}

function numeric(get) {
  return withUntaggedLast(
    (a, b) => (get(a) || 0) - (get(b) || 0),
    (t) => !!get(t),
  );
}

/** The sorts offered in the UI, in the order they are offered. `defaultDesc`
 *  is which direction the player means when they pick it: newest-first for a
 *  date, A-Z for a name. */
export const SORTS = [
  { key: 'title', label: 'Title', defaultDesc: false, compare: text(displayTitle) },
  { key: 'artist', label: 'Artist', defaultDesc: false, compare: text((t) => t.artist) },
  { key: 'album', label: 'Album', defaultDesc: false, compare: text((t) => t.album) },
  { key: 'folder', label: 'Folder', defaultDesc: false, compare: text((t) => `${t.folder}/${t.name}`) },
  { key: 'added', label: 'Date added', defaultDesc: true, compare: numeric((t) => t.addedMs) },
  { key: 'played', label: 'Last played', defaultDesc: true, compare: numeric((t) => t.lastPlayedMs) },
  { key: 'plays', label: 'Most played', defaultDesc: true, compare: numeric((t) => t.playCount) },
  { key: 'duration', label: 'Length', defaultDesc: false, compare: numeric((t) => t.durationSec) },
];

export function sortByKey(key) {
  return SORTS.find((s) => s.key === key) || SORTS[0];
}

/** Sorted copy. Ties break on path so the order is total -- two tracks with
 *  the same title must not swap places between two renders of the same
 *  library. */
export function sortTracks(tracks, key = 'title', desc = false) {
  const sort = sortByKey(key);
  return [...(tracks || [])].sort((a, b) => sort.compare(a, b, desc) || collator.compare(a.path || '', b.path || ''));
}

const FIELD_ALIASES = {
  artist: (t) => t.artist,
  album: (t) => t.album,
  title: displayTitle,
  folder: (t) => t.folder,
  ext: (t) => t.ext,
  type: (t) => t.ext,
};

/**
 * Split a query into terms. `artist:radiohead ok computer` is two terms: a
 * field-scoped one and a free one. A quoted phrase stays whole, so
 * `artist:"nine inch nails"` is one term and not three.
 */
export function parseQuery(query) {
  const terms = [];
  const re = /(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(String(query || '')))) {
    const raw = (m[2] ?? m[3] ?? '').trim().toLowerCase();
    if (!raw) continue;
    const prefix = m[1] ? m[1].toLowerCase() : null;
    const field = prefix && FIELD_ALIASES[prefix] ? prefix : null;
    // An unrecognised prefix is not a field, so it is part of what they
    // typed: `bpm:120` searches for "bpm:120", it does not silently become
    // a free-text search for "120" against every column.
    terms.push({ field, value: field || !prefix ? raw : `${prefix}:${raw}` });
  }
  return terms;
}

/** Everything a free term is allowed to match. The path is in here on
 *  purpose: an untagged library is navigated by where the files are, and
 *  typing a folder name is the fastest way most people have to find them. */
function haystack(track) {
  return [displayTitle(track), track.artist, track.album, track.path, track.ext]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Every term must match (AND), which is what makes typing more words
 *  narrow the list rather than widen it. */
export function matchesQuery(track, terms) {
  if (!terms?.length) return true;
  for (const term of terms) {
    const value = term.field
      ? String(FIELD_ALIASES[term.field](track) || '').toLowerCase()
      : haystack(track);
    if (!value.includes(term.value)) return false;
  }
  return true;
}

export function filterTracks(tracks, query) {
  const terms = parseQuery(query);
  if (!terms.length) return [...(tracks || [])];
  return (tracks || []).filter((t) => matchesQuery(t, terms));
}

/**
 * One level of the folder tree: the subfolders directly inside `folder`,
 * and the tracks sitting directly in it.
 *
 * `count` on a subfolder is everything beneath it, not just its own files --
 * a folder showing "0 tracks" because its music is one level further down
 * would be a lie about a library that is entirely Artist/Album shaped.
 */
export function folderContents(tracks, folder = '') {
  const prefix = folder ? `${folder}/` : '';
  const subfolders = new Map();
  const here = [];
  for (const track of tracks || []) {
    const path = track.folder || '';
    if (path === folder) { here.push(track); continue; }
    if (folder && !path.startsWith(prefix)) continue;
    const rest = folder ? path.slice(prefix.length) : path;
    if (!rest) continue;
    const name = rest.split('/')[0];
    const childPath = prefix + name;
    const entry = subfolders.get(childPath) || { name, path: childPath, count: 0 };
    entry.count++;
    subfolders.set(childPath, entry);
  }
  return {
    folders: [...subfolders.values()].sort((a, b) => collator.compare(a.name, b.name)),
    tracks: here,
  };
}

/** Trail back to the library root. The first crumb is always the root
 *  itself, so there is always a way out of a folder. */
export function breadcrumbs(folder = '', rootLabel = 'Library') {
  const crumbs = [{ name: rootLabel, path: '' }];
  let acc = '';
  for (const part of String(folder || '').split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

/** mm:ss, or an em dash while the duration is still unknown -- durations
 *  arrive only when a track is played, so most of a fresh library has none
 *  and must not render as "0:00". */
export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, '0')}`;
}

/** The tracks a returning player is most likely to want: what they played
 *  last, newest first, never the same track twice. */
export function recentlyPlayed(tracks, limit = 6) {
  return (tracks || [])
    .filter((t) => t.lastPlayedMs > 0)
    .sort((a, b) => b.lastPlayedMs - a.lastPlayedMs)
    .slice(0, Math.max(0, limit));
}

/** Tracks with nothing but a filename to go on -- the queue auto-tagging
 *  works through. A filename guess counts as untagged: it is a guess, and
 *  replacing it is the entire point. */
export function untaggedTracks(tracks) {
  return (tracks || []).filter((t) => t.tagSource !== 'tags' && t.tagSource !== 'auto');
}
