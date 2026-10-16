// Jamendo (jamendo.com): a free, Creative-Commons-licensed music catalog
// with a real search API and directly downloadable audio files. This is
// what Spotify/YT Music/Apple Music deliberately do NOT offer third
// parties -- their APIs expose metadata and, at best, a DRM'd playback SDK
// with no access to the actual audio signal, which this game needs (it
// analyzes the real waveform for beats/energy/key). Jamendo hands back an
// `audiodownload` URL per track that decodes and analyzes exactly like a
// locally dropped file.
//
// Licensing: every track is released under a Creative Commons license by
// its own artist (see each result's `licenseCcUrl`) -- free for
// non-commercial use under Jamendo's API terms; commercial use needs a
// paid Jamendo license (devportal.jamendo.com). This module only ever
// fetches what Jamendo's own API already serves publicly; it doesn't work
// around any access control.
//
// A client_id is required (free, from devportal.jamendo.com) and is never
// bundled here -- each player brings their own, stored locally.
const API_BASE = 'https://api.jamendo.com/v3.0';
const CLIENT_ID_KEY = 'smw:jamendoClientId';
const TIMEOUT_MS = 15000; // a stalled request must not leave the UI reading "Searching..." forever
const DOWNLOAD_TIMEOUT_MS = 45000; // a full track takes longer than a search reply

export class JamendoError extends Error {}

/** fetch() with a hard timeout -- a request to an unreachable host can hang
 *  indefinitely rather than rejecting, which without this leaves the search
 *  UI stuck showing "Searching..." with no way out but a reload. */
async function fetchWithTimeout(url, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new JamendoError('Timed out reaching Jamendo -- check your connection and try again.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function getJamendoClientId() {
  try { return localStorage.getItem(CLIENT_ID_KEY) || ''; } catch { return ''; }
}

export function setJamendoClientId(id) {
  try { localStorage.setItem(CLIENT_ID_KEY, id || ''); } catch { /* no persistent storage available */ }
}

/**
 * @param {string} query free-text search (title/artist/tag)
 * @param {{clientId?: string, limit?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<Array<{id:string, name:string, artist:string, duration:number,
 *   image:string, audiodownload:string, licenseCcUrl:string}>>}
 */
export async function searchTracks(query, { clientId, limit = 20, timeoutMs = TIMEOUT_MS } = {}) {
  const id = clientId || getJamendoClientId();
  if (!id) {
    throw new JamendoError('No Jamendo client_id set -- get a free one at devportal.jamendo.com and paste it in above.');
  }
  const q = (query || '').trim();
  if (!q) return [];

  const url = new URL(`${API_BASE}/tracks/`);
  url.searchParams.set('client_id', id);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(Math.min(50, Math.max(1, limit))));
  url.searchParams.set('search', q);
  url.searchParams.set('audioformat', 'mp32');
  url.searchParams.set('audiodlformat', 'mp32');

  let res;
  try {
    res = await fetchWithTimeout(url.toString(), timeoutMs);
  } catch (err) {
    if (err instanceof JamendoError) throw err;
    throw new JamendoError(`Could not reach Jamendo: ${err.message}`);
  }
  if (!res.ok) throw new JamendoError(`Jamendo search failed (HTTP ${res.status}).`);
  const data = await res.json();
  if (data?.headers?.status === 'failed') {
    throw new JamendoError(data.headers.error_message || 'Jamendo search failed.');
  }

  return (data.results || [])
    .filter((t) => t.audiodownload_allowed !== false && t.audiodownload)
    .map((t) => ({
      id: t.id,
      name: t.name || 'Untitled',
      artist: t.artist_name || 'Unknown artist',
      duration: Number(t.duration) || 0,
      image: t.image || '',
      audiodownload: t.audiodownload,
      licenseCcUrl: t.license_ccurl || '',
    }));
}

/** Downloads a track's audio and wraps it as a File -- the existing drop/
 *  import pipeline (main.js's handleFiles) already knows how to play a
 *  File exactly like a local drop, so this is the entire integration. */
export async function fetchTrackAsFile(track) {
  let res;
  try {
    // A full audio file takes longer than a search reply; give it more room.
    res = await fetchWithTimeout(track.audiodownload, DOWNLOAD_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof JamendoError) throw err;
    throw new JamendoError(`Could not download "${track.name}": ${err.message}`);
  }
  if (!res.ok) throw new JamendoError(`Could not download "${track.name}" (HTTP ${res.status}).`);
  const blob = await res.blob();
  const safeName = String(track.name || 'jamendo-track').replace(/[\\/:*?"<>|]/g, '_');
  return new File([blob], `${safeName}.mp3`, { type: blob.type || 'audio/mpeg' });
}
