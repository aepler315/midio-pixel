// LRCLIB client: a free, keyless, CORS-open lyrics API queried by exactly
// {artist, title, album, duration} -- the tuple the whole identity flow
// exists to produce. Prefers /api/get (single best match, LRCLIB's own
// duration-tolerant lookup) and falls back to /api/search (ranked list) when
// the exact lookup misses. `fetchFn` is injected so this is fully testable
// without a real network. Every failure path resolves to null -- lyrics are
// always optional.
import { clamp01 } from '../utils/math.js';

const BASE = 'https://lrclib.net/api';
const FETCH_TIMEOUT_MS = 4000;
const SEARCH_MAX_DURATION_DELTA_SEC = 3;

/** Parses one .lrc-format synced-lyrics blob into an ascending
 *  [{tMs, text}] list. Handles multiple timestamps stacked on one line
 *  (`[00:01.00][00:15.00]La la la`) and a leading `[offset:+/-ms]` tag
 *  (applied to every line, LRC convention: POSITIVE offset means the
 *  written stamps are late and should be shifted EARLIER). Blank/metadata
 *  lines with no timestamp are dropped; duplicate exact-tMs+text pairs
 *  are deduped. Negative onsets are omitted: moving pre-song lines to zero
 *  would invent their alignment. Never throws on malformed input. */
export function parseLrc(text) {
  if (typeof text !== 'string' || !text) return [];
  let offsetMs = 0;
  const offsetMatch = text.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
  if (offsetMatch) offsetMs = parseInt(offsetMatch[1], 10);
  if (!Number.isFinite(offsetMs)) return [];

  const out = [];
  const lineRe = /^((?:\[\d{1,3}:\d{2}(?:\.\d{1,3})?\])+)(.*)$/;
  const stampRe = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const m = rawLine.match(lineRe);
    if (!m) continue;
    const stampsPart = m[1];
    const lineText = m[2].trim();
    let stampMatch;
    stampRe.lastIndex = 0;
    while ((stampMatch = stampRe.exec(stampsPart))) {
      const minutes = parseInt(stampMatch[1], 10);
      const seconds = parseFloat(stampMatch[2]);
      const tMs = Math.round((minutes * 60 + seconds) * 1000) - offsetMs;
      if (Number.isFinite(tMs) && tMs >= 0) out.push({ tMs, text: lineText });
    }
  }
  out.sort((a, b) => a.tMs - b.tMs);
  const deduped = [];
  const seen = new Set();
  for (const line of out) {
    const key = JSON.stringify([line.tMs, line.text]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  return deduped;
}

/** Jaccard similarity over lowercased word sets -- good enough to rank
 *  search results, not meant to be a general string-distance algorithm. */
function nameSimilarity(a, b) {
  const wordsOf = (s) => new Set(String(s || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  const sa = wordsOf(a), sb = wordsOf(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

async function fetchJson(fetchFn, url, externalSignal = null) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
  const onExternalAbort = () => controller?.abort();
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener?.('abort', onExternalAbort, { once: true });
  }
  try {
    const requestSignal = controller?.signal || externalSignal || null;
    const res = await fetchFn(url, requestSignal ? { signal: requestSignal } : {});
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', onExternalAbort);
  }
}

function toResult(record) {
  if (!record) return null;
  if (record.instrumental) return { instrumental: true, synced: null, plain: null, meta: recordMeta(record) };
  const synced = record.syncedLyrics ? parseLrc(record.syncedLyrics) : null;
  const plain = record.plainLyrics ? record.plainLyrics.split(/\r\n|\r|\n/) : null;
  if (!synced?.length && !plain?.length) return null;
  return { instrumental: false, synced: synced?.length ? synced : null, plain, meta: recordMeta(record) };
}

function recordMeta(record) {
  return { name: record.trackName || record.name || null, artist: record.artistName || null, album: record.albumName || null, duration: record.duration ?? null };
}

/** Looks up lyrics for {artist, title, album, durationSec}. Tries the exact
 *  /api/get lookup first (LRCLIB does its own duration-tolerant match),
 *  then falls back to /api/search picking the closest-duration, then
 *  most-similar-named candidate. Returns null on any failure/no match --
 *  callers should treat that as "no lyrics available," never an error. */
export async function fetchLyrics({ artist, title, album, durationSec, signal = null } = {}, fetchFn = (typeof fetch !== 'undefined' ? fetch : null)) {
  if (!fetchFn || !title) return null;

  const getParams = new URLSearchParams({ track_name: title });
  if (artist) getParams.set('artist_name', artist);
  if (album) getParams.set('album_name', album);
  if (Number.isFinite(durationSec)) getParams.set('duration', String(Math.round(durationSec)));
  const direct = await fetchJson(fetchFn, `${BASE}/get?${getParams.toString()}`, signal);
  const direct2 = toResult(direct);
  if (direct2) return direct2;

  const searchParams = new URLSearchParams({ q: [artist, title].filter(Boolean).join(' ') || title });
  const candidates = await fetchJson(fetchFn, `${BASE}/search?${searchParams.toString()}`, signal);
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  let best = null, bestScore = -Infinity;
  for (const c of candidates) {
    if (!Number.isFinite(c.duration)) continue;
    const durDelta = Number.isFinite(durationSec) ? Math.abs(c.duration - durationSec) : 0;
    if (Number.isFinite(durationSec) && durDelta > SEARCH_MAX_DURATION_DELTA_SEC) continue;
    const titleScore = nameSimilarity(c.trackName, title);
    const artistScore = artist ? nameSimilarity(c.artistName, artist) : 1;
    // Duration can rank plausible matches, but cannot establish song identity.
    if (titleScore < 0.6 || artistScore < 0.5) continue;
    const nameScore = 0.6 * titleScore + 0.4 * artistScore;
    const durScore = Number.isFinite(durationSec) ? clamp01(1 - durDelta / (SEARCH_MAX_DURATION_DELTA_SEC + 1)) : 0.5;
    const score = 0.7 * nameScore + 0.3 * durScore;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return toResult(best);
}

function cacheKey(artist, title, durationSec) {
  const roundedDur = Number.isFinite(durationSec) ? Math.round(durationSec / 2) * 2 : 'na';
  return `smw:lyrics:v2:${(artist || '').toLowerCase()}|${(title || '').toLowerCase()}|${roundedDur}`;
}

/** localStorage-cached wrapper around fetchLyrics -- same try/catch-guarded
 *  pattern as Accessibility.js so a private-mode browser (or Node, for
 *  tests) degrades to "just fetch every time" instead of throwing. Only
 *  successful (non-null) results are cached. */
export async function fetchLyricsCached(identity, fetchFn, signal = null) {
  const key = cacheKey(identity?.artist, identity?.title, identity?.durationSec);
  try {
    const cached = localStorage.getItem(key);
    if (cached) return JSON.parse(cached);
  } catch { /* unavailable or corrupt -- fall through to a live fetch */ }

  const result = await fetchLyrics({ ...identity, signal }, fetchFn);
  if (result) {
    try { localStorage.setItem(key, JSON.stringify(result)); } catch { /* storage full/unavailable -- fine, just not cached */ }
  }
  return result;
}
