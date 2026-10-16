// Session identity and admitted lyric evidence. The load in main.js owns
// cancellation, timing and teardown; these operations create no resources.
import { resolveIdentity } from '../lyrics/SongIdentity.js';
import { mergeSourceIdentity } from './SourceMetadata.js';
import { adoptFullAnalysis } from './OpeningAnalysis.js';

/** Local identity resolves independently of optional network work. Embedded
 * tags and filename fallback are merged below the authoritative source. */
export async function resolveAudioIdentity(file, durationSec, { signal = null, sourceMetadata = null } = {}) {
  let identity = { title: null, artist: null, album: null, durationSec, source: 'none', confidence: 0 };
  try {
    const tagBuffer = await file.arrayBuffer();
    if (signal?.aborted) return identity;
    identity = resolveIdentity(sourceMetadata ? '' : (file.name || ''), tagBuffer, durationSec);
  } catch (err) {
    console.warn('[lyrics] identity resolution failed, continuing without it', err);
  }
  return mergeSourceIdentity({ sourceMetadata, tagIdentity: identity, durationSec });
}

/** One title precedence for load, Complete and capture. Capture callers take
 * this string before awaiting recorder finalization, never after it. */
export function sessionSongName(data, fallback = 'song') {
  return data?.sourceTrack?.title || data?.lyricIdentity?.title || data?.sourceFileName || fallback || 'song';
}

/** Preserve the owning session's metadata/history when final analysis comes
 * from a cache produced under another source. This mutates the same data. */
export function adoptAudioSessionAnalysis(data, full) {
  const sourceTrack = data.sourceTrack;
  const lyricIdentity = data.lyricIdentity;
  const { lyricSession, lyricSections, syncedLyrics, sourceFileName } = data;
  adoptFullAnalysis(data, full);
  Object.assign(data, { sourceTrack, lyricIdentity, lyricSession, lyricSections, syncedLyrics, sourceFileName });
}

/** Publish a resolved result only while the load still owns its data. The
 * supplied gate includes active A while a replacement B is only downloading;
 * selection-ticket equality alone is insufficient. The caller keeps cache
 * publication behind this same gate. No clock is read or advanced here. */
export function adoptAudioSessionLyrics(data, { identity: lyricIdentity, lyricSections, syncedLyrics }, {
  canUpdatePrepared, generation, lyricsDisabled, sim, activeData,
}) {
  if (!canUpdatePrepared()) return false;
  data.lyricIdentity = lyricIdentity;
  // Preference can change while a provider request is in flight.
  if (!lyricsDisabled && (lyricSections?.length || syncedLyrics?.length)) {
    data.lyricSections = lyricSections;
    data.syncedLyrics = syncedLyrics;
    const live = sim && activeData === data;
    const admission = Object.freeze({ generation,
      revision: data.lyricSession.admissions.length + 1,
      heardTimeMs: live ? Math.max(0, sim.heardTimeMs || 0) : 0,
      lyricSections, syncedLyrics });
    data.lyricSession.admissions.push(admission);
    if (live) sim.biomes.adoptLyrics(admission);
  }
  return true;
}
