/**
 * Zero-key free music search for Midio.
 * Sources: curated SoundHelix demos + Internet Archive open audio.
 * No API keys. Legal / freely redistributable material only.
 */
import {
  parsePathMetadata,
  formatLength,
  dedupeResults,
} from './song-meta.mjs';

const UA = 'Midio-FreeMusic/1.0 (+https://github.com/aepler315/Midio-5)';
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

/** @type {Array<object>} */
export const DEMO_CATALOG = [
  track('demo-helix-1', 'Neon Skyline', 'SoundHelix', 'SoundHelix Demos', 372, 8_945_229, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'),
  track('demo-helix-2', 'Midnight Express', 'SoundHelix', 'SoundHelix Demos', 426, 10_222_911, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3'),
  track('demo-helix-3', 'Crystal Garden', 'SoundHelix', 'SoundHelix Demos', 360, 7_500_000, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3'),
  track('demo-helix-4', 'Pulse City', 'SoundHelix', 'SoundHelix Demos', 340, 8_000_000, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3'),
  track('demo-helix-5', 'Aurora Drive', 'SoundHelix', 'SoundHelix Demos', 350, 8_200_000, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3'),
  track('demo-helix-6', 'Deep Orbit', 'SoundHelix', 'SoundHelix Demos', 330, 7_800_000, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3'),
  track('demo-helix-7', 'Velvet Static', 'SoundHelix', 'SoundHelix Demos', 345, 8_100_000, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3'),
  track('demo-helix-8', 'Glass Horizon', 'SoundHelix', 'SoundHelix Demos', 335, 7_900_000, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3'),
  track('demo-helix-9', 'Chrome Ballet', 'SoundHelix', 'SoundHelix Demos', 355, 8_400_000, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3'),
  track('demo-helix-10', 'Solar Flare', 'SoundHelix', 'SoundHelix Demos', 360, 8_600_000, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3'),
  track('demo-helix-16', 'Night Market', 'SoundHelix', 'SoundHelix Demos', 480, 11_602_841, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-16.mp3'),
  track('demo-helix-17', 'Paper Planets', 'SoundHelix', 'SoundHelix Demos', 390, 9_000_000, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-17.mp3'),
];

function track(id, title, artist, album, lengthSec, size, url) {
  return {
    id,
    title,
    artist,
    album,
    lengthSec,
    filename: `${artist}/${album}/${artist} - ${title}.mp3`,
    size,
    bitrate: 128,
    speed: 5_000_000,
    slots: true,
    user: 'midio-free',
    source: 'free',
    ext: 'mp3',
    url,
  };
}

function formatBytes(n) {
  if (!n || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function toResult(raw, source = 'free') {
  const filename = raw.filename || `${raw.artist || 'Unknown'}/${raw.album || 'Open'}/${raw.title || 'Track'}.mp3`;
  const meta = parsePathMetadata(filename, {
    size: raw.size || 0,
    bitrate: raw.bitrate || 128,
    length: raw.lengthSec,
    artist: raw.artist,
    album: raw.album,
    title: raw.title,
  });
  return {
    id: raw.id || `${source}:${filename}`,
    title: raw.title || meta.title,
    baseTitle: meta.baseTitle,
    versionKey: meta.versionKey,
    versionLabel: meta.versionLabel,
    artist: raw.artist || meta.artist || 'Unknown artist',
    album: raw.album || meta.album || '—',
    lengthSec: raw.lengthSec ?? meta.lengthSec,
    lengthLabel: formatLength(raw.lengthSec ?? meta.lengthSec),
    filename,
    size: raw.size || 0,
    sizeLabel: formatBytes(raw.size || 0),
    bitrate: raw.bitrate || 128,
    speed: raw.speed || 5_000_000,
    slots: true,
    user: raw.user || 'midio-free',
    source,
    ext: 'mp3',
    url: raw.url || null,
    _file: filename,
  };
}

export function searchDemoCatalog(query) {
  const q = String(query || '').trim().toLowerCase();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  let hits = DEMO_CATALOG;
  if (terms.length) {
    hits = DEMO_CATALOG.filter((t) => {
      const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  }
  // Soft fallback so empty queries still show something playable
  if (!hits.length && !terms.length) hits = DEMO_CATALOG.slice(0, 8);
  return hits.map((t) => toResult(t, 'free'));
}

/**
 * Internet Archive advanced search — no API key.
 * Prefers open / public-domain / netlabel style collections with MP3s.
 */
export async function searchInternetArchive(query, { rows = 24 } = {}) {
  const q = String(query || '').trim();
  if (!q || q.length < 2) return [];

  const escaped = q.replace(/"/g, '');
  // Prefer items that list MP3; stick to audio mediatype
  const iaQuery = [
    'mediatype:audio',
    `(title:("${escaped}") OR creator:("${escaped}") OR description:("${escaped}"))`,
    '(format:MP3 OR format:"VBR MP3" OR format:"128Kbps MP3")',
  ].join(' AND ');

  const url =
    'https://archive.org/advancedsearch.php?' +
    new URLSearchParams({
      q: iaQuery,
      'fl[]': 'identifier',
      output: 'json',
      rows: String(rows),
      page: '1',
      sort: 'downloads desc',
    }).toString() +
    // fl[] repeated — URLSearchParams collapses; append manually
    '&fl[]=title&fl[]=creator&fl[]=year&fl[]=runtime&fl[]=downloads&fl[]=collection';

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const docs = data?.response?.docs || [];
  const out = [];

  for (const doc of docs) {
    const identifier = doc.identifier;
    if (!identifier) continue;
    const title = Array.isArray(doc.title) ? doc.title[0] : doc.title || identifier;
    const titleStr = String(title);
    // Skip obvious non-track dumps (full blogs, huge compilations without a track name)
    if (/full archive|complete dump|entire blog/i.test(titleStr)) continue;
    const artist = Array.isArray(doc.creator) ? doc.creator[0] : doc.creator || 'Internet Archive';
    const album =
      (Array.isArray(doc.collection) ? doc.collection.find((c) => c !== 'opensource_audio') : doc.collection) ||
      'Internet Archive';
    const lengthSec = parseRuntime(doc.runtime);
    // Prefer single tracks / short sets under ~20 min when runtime is known
    if (lengthSec != null && lengthSec > 60 * 25) continue;
    out.push(
      toResult(
        {
          id: `ia:${identifier}`,
          title: titleStr.slice(0, 160),
          artist: String(artist).slice(0, 120),
          album: String(album).slice(0, 120),
          lengthSec,
          filename: `${artist}/${album}/${titleStr}.mp3`,
          size: 0,
          url: null,
          iaId: identifier,
        },
        'archive',
      ),
    );
  }
  return out.map((r, i) => {
    // iaId already on toResult via id; keep explicit
    const iaId = String(r.id || '').startsWith('ia:') ? String(r.id).slice(3) : r.iaId;
    return { ...r, iaId, source: 'archive' };
  });
}

function parseRuntime(runtime) {
  if (runtime == null) return null;
  if (typeof runtime === 'number' && Number.isFinite(runtime)) return Math.round(runtime);
  const s = String(Array.isArray(runtime) ? runtime[0] : runtime).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

/** Read a remote audio response without allocating an unbounded buffer. */
export async function readBoundedDownload(res, label = 'audio download') {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
  }
  if (!res.body?.getReader) {
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
    }
    return buffer;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** Resolve a playable MP3 URL for an Archive.org item. */
export async function resolveArchiveDownload(item) {
  const id = item.iaId || (item.id && String(item.id).startsWith('ia:') ? String(item.id).slice(3) : null);
  if (!id) throw new Error('Missing Internet Archive identifier');

  const metaRes = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!metaRes.ok) throw new Error(`Archive metadata failed (${metaRes.status})`);
  const meta = await metaRes.json();
  const files = meta.files || [];
  // Prefer medium-bitrate mp3s; skip derivative trash when possible
  const mp3s = files
    .filter((f) => /\.mp3$/i.test(f.name || '') && !/sample|preview|\_64kb/i.test(f.name || ''))
    .sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
  const pick = mp3s[0] || files.find((f) => /\.mp3$/i.test(f.name || ''));
  if (!pick) throw new Error(`No MP3 on archive.org item ${id}`);

  const fileUrl = `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(pick.name)}`;
  const res = await fetch(fileUrl, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Archive download failed (${res.status})`);
  const buffer = await readBoundedDownload(res, 'Archive download');
  if (buffer.length < 1000) throw new Error('Archive download too small');
  return {
    buffer,
    filename: pick.name.replace(/[^\w.\- ()[\]]+/g, '_'),
    contentType: 'audio/mpeg',
  };
}

export async function downloadFreeTrack(item, demoCatalog = DEMO_CATALOG) {
  if (item.source === 'archive' || (item.id && String(item.id).startsWith('ia:'))) {
    return resolveArchiveDownload(item);
  }
  const track =
    demoCatalog.find((t) => t.id === item.id) ||
    demoCatalog.find((t) => t.title === item.title && t.artist === item.artist);
  if (track?.url) {
    const res = await fetch(track.url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Free track download failed (${res.status})`);
    const buffer = await readBoundedDownload(res, 'Free track download');
    if (buffer.length < 1000) throw new Error('Free track too small');
    const name = (track.filename || item.filename || 'track.mp3').split('/').pop();
    return { buffer, filename: name, contentType: 'audio/mpeg' };
  }
  throw new Error('No free download URL for this track');
}

/** Combined free search: demos first (instant), then Archive.org. */
export async function searchFreeMusic(query) {
  const demos = searchDemoCatalog(query);
  let archive = [];
  try {
    archive = await searchInternetArchive(query, { rows: 20 });
  } catch {
    archive = [];
  }
  // Prefer exact demo hits; always surface archive when query is real
  const q = String(query || '').trim();
  let combined = q ? [...demos, ...archive] : demos.slice(0, 10);
  if (!combined.length) combined = demos.slice(0, 6);
  return dedupeResults(combined).slice(0, 40);
}
