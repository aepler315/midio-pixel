/** Explicit catalog identity, kept separate from Midio's visual song identity. */
function label(value) {
  return typeof value === 'string' ? value.trim().slice(0, 512) || null : null;
}

function publicArtwork(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
      || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash
      || !/^\/api\/plex\/v1\/artwork\/\d+$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

export function normalizeSourceMetadata(value) {
  if (!value || typeof value !== 'object' || value.provider !== 'plex') return null;
  const id = label(value.id);
  const revision = label(value.revision);
  if (!id || !/^[a-zA-Z0-9._:-]+$/.test(id) || !revision || !/^[a-zA-Z0-9._:-]+$/.test(revision)) return null;
  return {
    provider: 'plex', id, revision,
    title: label(value.title), artist: label(value.artist), album: label(value.album), albumArtist: label(value.albumArtist),
    durationMs: typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : null,
    artworkUrl: publicArtwork(value.artworkUrl),
  };
}

/** Decoded duration wins; catalog labels win over tag/filename guesses. */
export function mergeSourceIdentity({ sourceMetadata, tagIdentity, durationSec } = {}) {
  const identity = tagIdentity && typeof tagIdentity === 'object' ? { ...tagIdentity } : { source: 'none', confidence: 0 };
  for (const key of ['title', 'artist', 'album', 'albumArtist']) identity[key] = label(identity[key]);
  identity.durationSec = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec >= 0 ? durationSec : null;
  const source = normalizeSourceMetadata(sourceMetadata);
  if (!source) return identity;
  // Adapter basenames identify a file, not a song. Keep actual embedded titles.
  if (identity.source === 'filename' && /^(?:plex|track)-\d+(?:\.[a-z0-9]+)?$/i.test(identity.title || '')) {
    identity.title = null;
    if (!identity.artist) {
      identity.source = 'none';
      identity.confidence = 0;
    }
  }
  for (const key of ['title', 'artist', 'album', 'albumArtist']) if (source[key]) identity[key] = source[key];
  identity.provider = source.provider;
  identity.id = source.id;
  identity.revision = source.revision;
  identity.artworkUrl = source.artworkUrl;
  if (source.title || source.artist) {
    identity.source = 'plex';
    identity.confidence = 1;
  }
  return identity;
}
