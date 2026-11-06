import { sortTracks } from './TrackIndex.js';

/** A library sequence keyed by durable track identity, independent of UI order. */
export class PlaybackSequence {
  constructor({ random = Math.random } = {}) {
    this.random = typeof random === 'function' ? random : Math.random;
    this.reset();
  }

  reset() {
    this.mode = null;
    this.known = new Set();
    this.remaining = new Set();
    this.lastId = null;
  }

  next(tracks, { shuffle = true, previousId = null, excludedIds = new Set() } = {}) {
    const mode = !!shuffle;
    if (this.mode !== mode) { this.reset(); this.mode = mode; }
    const byId = new Map();
    for (const track of tracks || []) {
      if (track?.key != null && !byId.has(track.key)) byId.set(track.key, track);
    }
    const previous = previousId ?? this.lastId;
    const allowed = [...byId.values()].filter(track => !excludedIds.has(track.key));
    if (!mode) {
      const ordered = sortTracks([...byId.values()], 'title');
      const start = ordered.findIndex(track => track.key === previous);
      for (let offset = 1; offset <= ordered.length; offset++) {
        const track = ordered[(start + offset) % ordered.length];
        if (!excludedIds.has(track.key)) { this.lastId = track.key; return track; }
      }
      return null;
    }

    // Scans may add or remove tracks between selections. Preserve consumption
    // for surviving identities and let newly discovered tracks join this cycle.
    for (const id of this.remaining) if (!byId.has(id)) this.remaining.delete(id);
    for (const id of byId.keys()) if (!this.known.has(id)) this.remaining.add(id);
    this.known = new Set(byId.keys());
    // A manual selection is consumed too, so the next song cannot repeat it.
    this.remaining.delete(previous);
    if (!allowed.length) return null;
    let pool = allowed.filter(track => this.remaining.has(track.key));
    if (!pool.length) {
      this.remaining = new Set(byId.keys());
      pool = allowed;
    }
    // Keep the last song in a fresh cycle, but do not draw it first when
    // another eligible identity exists. A singleton can loop continuously.
    const alternatives = pool.filter(track => track.key !== previous);
    if (alternatives.length) pool = alternatives;
    const draw = this.random();
    const index = Math.min(pool.length - 1, Math.max(0, Math.floor((Number.isFinite(draw) ? draw : 0) * pool.length)));
    const selected = pool[index];
    this.remaining.delete(selected.key);
    this.lastId = selected.key;
    return selected;
  }
}
