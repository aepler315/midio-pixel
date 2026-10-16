/**
 * Parse Artist / Album / Title / Length from Soulseek file paths and
 * dedupe results so each distinct version (original, remix, instrumental…)
 * appears only once.
 */

const AUDIO_EXT = /\.(mp3|flac|wav|ogg|m4a|aac|opus|mid|midi)$/i;

const GENERIC_FOLDERS = new Set(
  [
    'music',
    'audio',
    'songs',
    'tracks',
    'mp3',
    'flac',
    'downloads',
    'complete',
    'incomplete',
    'shared',
    'share',
    'incoming',
    'media',
    'library',
    'collection',
    'various artists',
    'va',
    'compilations',
    'ost',
    'soundtrack',
    'singles',
    'eps',
    'albums',
    'discography',
    'lossless',
    'lossy',
    '320',
    'v0',
    'cd',
    'cds',
    'vinyl',
  ].map((s) => s.toLowerCase()),
);

// Version tags that make a *distinct* recording (shown once each).
// Remasters / "original mix" collapse into the base (original) version.
const VERSION_PATTERNS = [
  { key: 'instrumental', re: /\b(instrumental(?:\s+version)?|inst\.?)\b/i, label: 'Instrumental' },
  { key: 'karaoke', re: /\b(karaoke|minus\s*one)\b/i, label: 'Karaoke' },
  { key: 'acapella', re: /\b(a\s*capp?ella|acapella)\b/i, label: 'Acapella' },
  { key: 'remix', re: /\b([\w.]+(?:\s+[\w.]+){0,3}\s+)?(remix|rmx|bootleg|refix|edit by)\b/i, label: null },
  { key: 'live', re: /\b(live(?:\s+(?:at|from|in|version))?|unplugged)\b/i, label: 'Live' },
  { key: 'acoustic', re: /\b(acoustic(?:\s+version)?)\b/i, label: 'Acoustic' },
  { key: 'radio', re: /\b(radio\s+edit|radio\s+mix|radio\s+version)\b/i, label: 'Radio Edit' },
  { key: 'extended', re: /\b(extended(?:\s+(?:mix|version))?|club\s+mix|12["'′]\s*mix|long\s+version)\b/i, label: 'Extended' },
  { key: 'slowed', re: /\b(slowed(?:\s*\+?\s*reverb)?|sped\s*up|nightcore)\b/i, label: null },
  { key: 'cover', re: /\b(cover(?:\s+version)?|tribute)\b/i, label: 'Cover' },
  { key: 'demo', re: /\b(demo(?:\s+version)?)\b/i, label: 'Demo' },
  { key: 'clean', re: /\b(clean(?:\s+version)?)\b/i, label: 'Clean' },
  { key: 'explicit', re: /\b(explicit(?:\s+version)?)\b/i, label: 'Explicit' },
  { key: 'stripped', re: /\b(stripped|piano\s+version|strings\s+version)\b/i, label: null },
];

// Stripped for "same song" base identity (not a distinct version).
const COLLAPSE_RE =
  /\s*[\(\[\{]?\s*(remaster(?:ed)?(?:\s+\d{2,4})?|re-?master(?:ed)?|original\s+mix|original\s+version|album\s+version|single\s+version|deluxe(?:\s+edition)?|anniversary(?:\s+edition)?|\d{2,4}\s+remaster(?:ed)?)\s*[\)\]\}]?\s*/gi;

export function basename(p) {
  if (!p) return 'unknown';
  const parts = String(p).replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

function cleanFolder(name) {
  return String(name || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\(\d{4}\)/g, '')
    .replace(/\[\d{4}\]/g, '')
    .replace(/\b(FLAC|MP3|320|V0|V2|CD|WEB|VINYL|24bit|16bit|44\.1|48|96|192)\b/gi, '')
    .replace(/\s*[-–—]\s*$/, '')
    .replace(/^\s*[-–—]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGeneric(name) {
  const n = cleanFolder(name).toLowerCase();
  if (!n) return true;
  if (GENERIC_FOLDERS.has(n)) return true;
  if (/^\d{4}$/.test(n)) return true;
  if (/^(disc|cd|disk)\s*\d+$/i.test(n)) return true;
  return false;
}

function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a title into base + version descriptor.
 * e.g. "Midnight City (Instrumental)" → base "Midnight City", version "Instrumental"
 */
export function splitVersion(rawTitle) {
  let title = String(rawTitle || '').trim();
  // Drop collapsed tags first (remaster etc.)
  title = title.replace(COLLAPSE_RE, ' ').replace(/\s+/g, ' ').trim();
  title = title.replace(/\s*[\(\[\{]\s*[\)\]\}]\s*/g, ' ').trim();

  let versionKey = 'original';
  let versionLabel = '';
  let remixer = '';

  for (const pat of VERSION_PATTERNS) {
    const m = title.match(pat.re);
    if (!m) continue;
    versionKey = pat.key;
    if (pat.key === 'remix') {
      // Capture "Deadmau5 Remix" style
      const full = m[0].trim();
      remixer = (m[1] || '').trim();
      versionLabel = remixer ? `${remixer} Remix` : full.replace(/\b(rmx)\b/i, 'Remix');
      versionKey = `remix:${normalizeKey(versionLabel) || 'remix'}`;
    } else if (pat.key === 'slowed' || pat.key === 'stripped') {
      versionLabel = m[0].trim().replace(/\b\w/g, (c) => c.toUpperCase());
      versionKey = `${pat.key}:${normalizeKey(versionLabel)}`;
    } else {
      versionLabel = pat.label || m[0].trim();
    }
    // Remove the version phrase from the base title
    title = title
      .replace(pat.re, ' ')
      .replace(/\s*[\(\[\{]\s*[\)\]\}]\s*/g, ' ')
      .replace(/\s*[-–—]\s*$/, '')
      .replace(/^\s*[-–—]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    break; // first (most specific listed) match wins
  }

  // Trailing " - Something" that looks like a version
  const dashVer = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (versionKey === 'original' && dashVer) {
    const right = dashVer[2].trim();
    if (/^(instrumental|remix|live|acoustic|radio|extended|demo|cover)/i.test(right)) {
      title = dashVer[1].trim();
      return splitVersion(`${title} (${right})`);
    }
  }

  const displayTitle = versionLabel ? `${title} (${versionLabel})` : title;
  return {
    baseTitle: title || rawTitle || 'Unknown',
    displayTitle: displayTitle || rawTitle || 'Unknown',
    versionKey,
    versionLabel,
  };
}

/**
 * Derive artist / album / title from a full Soulseek path.
 * Typical trees: Artist/Album/01 - Title.ext
 *               Artist - Album/Title.ext
 *               flat: Artist - Title.ext
 */
export function parsePathMetadata(filepath, attrs = {}) {
  const full = String(filepath || attrs.filename || attrs.file || '');
  // Drop Soulseek "@@user" virtual roots
  const cleaned = full.replace(/^@@[^/\\]+[/\\]/, '');
  const parts = cleaned.replace(/\\/g, '/').split('/').filter(Boolean);
  const file = parts.pop() || 'unknown';
  const ext = (file.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  let base = file.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  // Track number prefixes: "01 - ", "1.", "01_"
  base = base.replace(/^\d{1,3}(\s*[-.)]\s*|\s+)/, '').trim();

  let artist = '';
  let album = '';
  let titleFromFile = base;

  // Filename "Artist - Title"
  const fileArtistTitle = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (fileArtistTitle) {
    artist = fileArtistTitle[1].trim();
    titleFromFile = fileArtistTitle[2].trim();
  }

  // Walk folders from nearest parent up
  const folders = parts.map(cleanFolder).filter(Boolean);
  // Skip trailing disc folders
  while (folders.length && /^(disc|cd|disk)\s*\d+$/i.test(folders[folders.length - 1])) {
    folders.pop();
  }

  if (folders.length >= 2) {
    const maybeAlbum = folders[folders.length - 1];
    const maybeArtist = folders[folders.length - 2];
    if (!isGeneric(maybeAlbum)) album = maybeAlbum;
    if (!isGeneric(maybeArtist)) {
      // "Artist - Album" packed into one folder name used as artist slot
      const packed = maybeArtist.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (packed && isGeneric(maybeAlbum)) {
        artist = artist || packed[1].trim();
        album = album || packed[2].trim();
      } else {
        artist = artist || maybeArtist;
      }
    }
    // Parent of artist sometimes is "Artist - Album (Year)"
    if (!album && folders.length >= 3) {
      const higher = folders[folders.length - 3];
      const packed = higher.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (packed && !isGeneric(packed[2])) {
        artist = artist || packed[1].trim();
        album = packed[2].trim();
      }
    }
  } else if (folders.length === 1) {
    const folder = folders[0];
    if (!isGeneric(folder)) {
      const packed = folder.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (packed) {
        artist = artist || packed[1].trim();
        album = packed[2].trim();
      } else if (!artist) {
        // Single folder could be artist or album; prefer as album if file already has artist
        if (artist) album = folder;
        else artist = folder;
      } else {
        album = folder;
      }
    }
  }

  // Prefer explicit attrs if present
  if (attrs.artist) artist = String(attrs.artist);
  if (attrs.album) album = String(attrs.album);
  if (attrs.title) titleFromFile = String(attrs.title);

  const { baseTitle, displayTitle, versionKey, versionLabel } = splitVersion(titleFromFile);

  // Length: explicit seconds, ms, or estimate from size + bitrate
  let lengthSec =
    Number(attrs.length || attrs.duration || attrs.lengthSeconds || 0) || 0;
  if (lengthSec > 10_000) lengthSec = Math.round(lengthSec / 1000); // ms → s
  const size = Number(attrs.size || 0);
  const bitrate = Number(attrs.bitRate || attrs.bitrate || 0);
  if (!lengthSec && size > 0 && bitrate > 0) {
    lengthSec = Math.round((size * 8) / (bitrate * 1000));
  }
  // FLAC rough estimate ~1000 kbps if no bitrate
  if (!lengthSec && size > 0 && /\.flac$/i.test(file)) {
    lengthSec = Math.round((size * 8) / (1000 * 1000));
  }

  return {
    artist: artist || '',
    album: album || '',
    title: displayTitle,
    baseTitle,
    versionKey,
    versionLabel,
    lengthSec: lengthSec > 5 && lengthSec < 60 * 60 * 3 ? lengthSec : 0,
    ext,
    filename: full || file,
  };
}

export function formatLength(sec) {
  const s = Math.round(Number(sec) || 0);
  if (s <= 0) return '';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function qualityScore(item) {
  let score = 0;
  if (item.slots) score += 50_000;
  const br = item.bitrate || 0;
  if (item.ext === 'flac' || item.ext === 'wav') score += 10_000 + br;
  else score += br * 10;
  score += Math.min(item.speed || 0, 5_000_000) / 1000;
  // Prefer known album + length
  if (item.album) score += 200;
  if (item.lengthSec) score += 100;
  return score;
}

/**
 * Keep one row per (artist, baseTitle, versionKey). Distinct versions
 * (remix / instrumental / live…) survive; duplicates of the same version
 * collapse to the highest-quality peer.
 */
export function dedupeResults(items) {
  const best = new Map();
  for (const item of items || []) {
    const a = normalizeKey(item.artist) || 'unknown';
    const t = normalizeKey(item.baseTitle || item.title) || normalizeKey(item.filename);
    const v = item.versionKey || 'original';
    const key = `${a}|${t}|${v}`;
    const prev = best.get(key);
    if (!prev || qualityScore(item) > qualityScore(prev)) {
      best.set(key, item);
    }
  }
  const out = [...best.values()];
  out.sort((a, b) => {
    if (a.slots !== b.slots) return a.slots ? -1 : 1;
    // Group same song's versions together
    const ak = `${normalizeKey(a.artist)}|${normalizeKey(a.baseTitle || a.title)}`;
    const bk = `${normalizeKey(b.artist)}|${normalizeKey(b.baseTitle || b.title)}`;
    if (ak !== bk) {
      return (
        qualityScore(b) - qualityScore(a) ||
        String(a.artist).localeCompare(String(b.artist)) ||
        String(a.title).localeCompare(String(b.title))
      );
    }
    // original first, then alpha by version
    if ((a.versionKey === 'original') !== (b.versionKey === 'original')) {
      return a.versionKey === 'original' ? -1 : 1;
    }
    return String(a.versionLabel || a.title).localeCompare(String(b.versionLabel || b.title));
  });
  return out;
}

// ── MusicBrainz enrichment (free, no key; 1 req/s) ─────────────────────────
const mbQueue = [];
let mbBusy = false;
let mbLastAt = 0;
const mbCache = new Map(); // "artist|title" → { album, lengthSec }

async function mbWorker() {
  if (mbBusy) return;
  mbBusy = true;
  while (mbQueue.length) {
    const job = mbQueue.shift();
    const wait = Math.max(0, 1100 - (Date.now() - mbLastAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const data = await job.run();
      job.resolve(data);
    } catch (err) {
      job.resolve(null);
    }
    mbLastAt = Date.now();
  }
  mbBusy = false;
}

function enqueueMb(run) {
  return new Promise((resolve) => {
    mbQueue.push({ run, resolve });
    mbWorker();
  });
}

async function musicBrainzLookup(artist, title) {
  const key = `${normalizeKey(artist)}|${normalizeKey(title)}`;
  if (mbCache.has(key)) return mbCache.get(key);
  if (!artist || !title) {
    mbCache.set(key, null);
    return null;
  }
  const result = await enqueueMb(async () => {
    const q = `recording:"${title.replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}"`;
    const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Midio-Soulseek/1.0 (https://github.com/mysecretomolove/Midio-5)',
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const recs = json.recordings || [];
    if (!recs.length) return null;
    // Prefer one with length + a release title
    let best = null;
    for (const r of recs) {
      const lengthSec = r.length ? Math.round(r.length / 1000) : 0;
      const release = (r.releases && r.releases[0]) || null;
      const album = release?.title || '';
      const score = (lengthSec ? 2 : 0) + (album ? 1 : 0);
      if (!best || score > best.score) best = { album, lengthSec, score };
    }
    return best ? { album: best.album, lengthSec: best.lengthSec } : null;
  });
  mbCache.set(key, result);
  return result;
}

/**
 * Fill missing album/length for up to `limit` items via MusicBrainz.
 * Mutates items in place; safe to call without awaiting fully for UI polls.
 */
export async function enrichWithMusicBrainz(items, { limit = 12 } = {}) {
  const targets = (items || [])
    .filter((it) => it.artist && (it.baseTitle || it.title) && (!it.album || !it.lengthSec))
    .slice(0, limit);
  await Promise.all(
    targets.map(async (it) => {
      const hit = await musicBrainzLookup(it.artist, it.baseTitle || it.title);
      if (!hit) return;
      if (!it.album && hit.album) it.album = hit.album;
      if (!it.lengthSec && hit.lengthSec) {
        it.lengthSec = hit.lengthSec;
        it.lengthLabel = formatLength(hit.lengthSec);
      }
      it.enriched = true;
    }),
  );
  return items;
}

export { AUDIO_EXT, normalizeKey };
