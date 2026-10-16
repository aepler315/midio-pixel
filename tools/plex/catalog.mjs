import { createHash } from "node:crypto";
import { PlexError, invalidUpstream } from "./client.mjs";
const missing = () => new PlexError("NOT_FOUND", "Item not found", 404);
const decimal = (value) => typeof value === "string" && /^\d+$/.test(value);
const number = (value) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;
const label = (value) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, 2000)
    : null;
export const AUDIO_MIME = {
  wav: "audio/wav",
  wave: "audio/wav",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  wma: "audio/x-ms-wma",
};
export function chooseMedia(item, config) {
  if (
    item.Media !== undefined &&
    (!Array.isArray(item.Media) ||
      item.Media.some(
        (value) => !value || typeof value !== "object" || Array.isArray(value),
      ))
  )
    throw invalidUpstream();
  const eligible = (Array.isArray(item.Media) ? item.Media : [])
    .flatMap((media) => {
      if (
        media.Part !== undefined &&
        (!Array.isArray(media.Part) ||
          media.Part.some(
            (value) =>
              !value || typeof value !== "object" || Array.isArray(value),
          ))
      )
        throw invalidUpstream();
      if (!Array.isArray(media.Part) || media.Part.length !== 1) return [];
      const part = media.Part[0];
      if (
        !decimal(String(media.id)) ||
        !decimal(String(part.id)) ||
        typeof part.key !== "string" ||
        [false, 0, "0"].includes(part.exists) ||
        [false, 0, "0"].includes(part.accessible)
      )
        return [];
      return [{ media, part }];
    })
    .sort(
      (a, b) =>
        String(a.media.id).localeCompare(String(b.media.id), "en", {
          numeric: true,
        }) ||
        String(a.part.id).localeCompare(String(b.part.id), "en", {
          numeric: true,
        }),
    );
  if (!eligible.length)
    return {
      allowed: false,
      reason: "No available complete single-part recording",
      status: 415,
    };
  const { media, part } = eligible[0],
    container = label(media.container)?.toLowerCase();
  const sizeBytes = number(part.size),
    durationMs = number(item.duration ?? media.duration),
    channels = number(media.audioChannels);
  if (!AUDIO_MIME[container])
    return {
      allowed: false,
      reason: "Unsupported original audio container",
      status: 415,
      media,
      part,
      container,
      sizeBytes,
    };
  if (
    (sizeBytes !== null && sizeBytes > config.maxFileBytes) ||
    (durationMs !== null && durationMs > config.maxDurationMs)
  )
    return {
      allowed: false,
      reason: "Recording exceeds the audio load limits",
      status: 413,
      media,
      part,
      container,
      sizeBytes,
    };
  if (channels !== null && (channels < 1 || channels > config.maxChannels))
    return {
      allowed: false,
      reason: "Unsupported audio channel count",
      status: 415,
      media,
      part,
      container,
      sizeBytes,
    };
  const revision = createHash("sha256")
    .update(
      JSON.stringify([
        String(media.id),
        String(part.id),
        part.key,
        item.updatedAt ?? null,
        media.updatedAt ?? null,
        part.updatedAt ?? null,
        sizeBytes,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return {
    allowed: true,
    media,
    part,
    container,
    sizeBytes,
    revision,
    mime: AUDIO_MIME[container],
  };
}
export function createPlexCatalog(client, config) {
  const cache = new Map(),
    pending = new Map();
  let cacheBytes = 0;
  function expire() {
    const now = Date.now();
    for (const [key, value] of cache)
      if (value.until <= now) {
        cache.delete(key);
        cacheBytes -= value.size;
      }
  }
  function remember(key, value) {
    expire();
    const size = Buffer.byteLength(JSON.stringify(value));
    if (size > config.cacheMaxBytes) return;
    while (
      cache.size >= config.cacheMaxEntries ||
      cacheBytes + size > config.cacheMaxBytes
    ) {
      const old = cache.keys().next().value;
      if (old === undefined) return;
      cacheBytes -= cache.get(old).size;
      cache.delete(old);
    }
    cache.set(key, { value, size, until: Date.now() + config.cacheTtlMs });
    cacheBytes += size;
  }
  async function read(key, { query, signal, fresh = false } = {}) {
    signal?.throwIfAborted();
    const cacheKey = JSON.stringify([key, query || {}]);
    expire();
    if (!fresh && cache.has(cacheKey)) return cache.get(cacheKey).value;
    // Fresh security checks are deliberately not coalesced with cached catalog reads.
    if (fresh) return client.getJson(key, { query, signal });
    let entry = pending.get(cacheKey);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, subscribers: 0 };
      entry.promise = client
        .getJson(key, { query, signal: controller.signal })
        .then((value) => {
          remember(cacheKey, value);
          return value;
        })
        .finally(() => pending.delete(cacheKey));
      pending.set(cacheKey, entry);
    }
    entry.subscribers++;
    let abort;
    try {
      return await (signal
        ? Promise.race([
            entry.promise,
            new Promise((_resolve, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
            }),
          ])
        : entry.promise);
    } finally {
      signal?.removeEventListener("abort", abort);
      if (--entry.subscribers === 0 && pending.has(cacheKey))
        entry.controller.abort();
    }
  }
  function discovery() {
    if (!client.discovery)
      throw new PlexError(
        "LIBRARY_UNAVAILABLE",
        "Plex library unavailable",
        503,
        true,
      );
    return client.discovery;
  }
  function section(id) {
    if (!decimal(id))
      throw new PlexError("INVALID_INPUT", "Invalid library identifier", 400);
    const found = discovery().sections.find((x) => x.id === id);
    if (!found) throw missing();
    return found;
  }
  async function authorizedItem(ratingKey, { signal, fresh = false } = {}) {
    if (!decimal(ratingKey))
      throw new PlexError("INVALID_INPUT", "Invalid item identifier", 400);
    const body = await read(
      discovery().capabilities.metadata + "/" + ratingKey,
      { signal, fresh },
    );
    const list = body.MediaContainer?.Metadata;
    if (
      !Array.isArray(list) ||
      list.some(
        (value) => !value || typeof value !== "object" || Array.isArray(value),
      )
    )
      throw invalidUpstream();
    const item = list.find((x) => String(x.ratingKey) === ratingKey);
    if (
      !item ||
      !["artist", "album", "track"].includes(item.type) ||
      !config.sectionIds.includes(String(item.librarySectionID))
    )
      throw missing();
    return item;
  }
  function normalize(item) {
    const ratingKey = String(item.ratingKey);
    if (!decimal(ratingKey)) throw invalidUpstream();
    const id = `plex:${discovery().namespace}:${ratingKey}`;
    const artworkPath =
      item.thumb || item.parentThumb || item.grandparentThumb
        ? "/api/plex/v1/artwork/" + ratingKey
        : null;
    if (item.type !== "track")
      return {
        id,
        ratingKey,
        libraryId: String(item.librarySectionID),
        kind: item.type,
        title: label(item.title),
        artist: label(item.parentTitle),
        artworkPath,
      };
    const media = chooseMedia(item, config);
    return {
      id,
      ratingKey,
      libraryId: String(item.librarySectionID),
      title: label(item.title),
      artist: label(item.originalTitle) || label(item.grandparentTitle),
      album: label(item.parentTitle),
      albumArtist: label(item.grandparentTitle),
      durationMs: number(item.duration),
      discNumber: number(item.parentIndex),
      trackNumber: number(item.index),
      revision: media.revision || null,
      fileName: `plex-${ratingKey}.${media.container && AUDIO_MIME[media.container] ? media.container : "bin"}`,
      container: media.container || null,
      audioCodec: label(media.media?.audioCodec),
      sizeBytes: media.sizeBytes ?? null,
      artworkPath,
      loadability: media.allowed
        ? { allowed: true }
        : { allowed: false, reason: media.reason },
    };
  }
  async function libraries() {
    return {
      items: discovery().sections.map(({ id, title }) => ({ id, title })),
    };
  }
  async function items({
    libraryId,
    kind,
    parentId = null,
    offset = 0,
    limit = 50,
    signal,
  }) {
    const lib = section(libraryId);
    let key = lib.key.replace(/\/all$/, "") + "/all";
    if (parentId) {
      const parent = await authorizedItem(parentId, { signal });
      if (
        String(parent.librarySectionID) !== libraryId ||
        !(
          (parent.type === "artist" && kind === "album") ||
          (parent.type === "album" && kind === "track")
        )
      )
        throw missing();
      key = discovery().capabilities.metadata + "/" + parentId + "/children";
    }
    const body = await read(key, {
      query: {
        type: { artist: 8, album: 9, track: 10 }[kind],
        "X-Plex-Container-Start": offset,
        "X-Plex-Container-Size": limit,
        // PMS sorts by database id; ratingKey and parentIndex are response fields.
        // absoluteIndex preserves disc/track order before server-side pagination.
        sort:
          kind === "track" && parentId
            ? "absoluteIndex:asc,id:asc"
            : "titleSort:asc,id:asc",
      },
      signal,
    });
    const mc = body.MediaContainer;
    if (
      !mc ||
      !Array.isArray(mc.Metadata || []) ||
      (mc.Metadata || []).some(
        (value) => !value || typeof value !== "object" || Array.isArray(value),
      ) ||
      (mc.Metadata || []).length > limit
    )
      throw invalidUpstream();
    const seen = new Set();
    const list = [];
    for (const value of mc.Metadata || []) {
      if (value.type !== kind) continue;
      let item = value;
      if (item.librarySectionID === undefined) {
        try {
          item = await authorizedItem(String(item.ratingKey), { signal });
        } catch (e) {
          if (e.status === 404) continue;
          throw e;
        }
      }
      if (
        String(item.librarySectionID) !== libraryId ||
        !decimal(String(item.ratingKey)) ||
        seen.has(String(item.ratingKey))
      )
        continue;
      seen.add(String(item.ratingKey));
      list.push(normalize(item));
    }
    if (parentId && kind === "track")
      list.sort(
        (a, b) =>
          (a.discNumber ?? Infinity) - (b.discNumber ?? Infinity) ||
          (a.trackNumber ?? Infinity) - (b.trackNumber ?? Infinity) ||
          a.ratingKey.localeCompare(b.ratingKey, "en", { numeric: true }),
      );
    const total = number(mc.totalSize),
      rawCount = (mc.Metadata || []).length;
    return {
      items: list,
      offset,
      nextOffset:
        rawCount &&
        (total === null ? rawCount >= limit : offset + rawCount < total)
          ? offset + rawCount
          : null,
      total,
    };
  }
  async function search({ libraryId, q, limit = 20, signal }) {
    section(libraryId);
    const body = await read(discovery().capabilities.search, {
      query: { query: q, sectionId: libraryId, limit },
      signal,
    });
    const hubs = body.MediaContainer?.Hub;
    if (
      !Array.isArray(hubs) ||
      hubs.some(
        (value) => !value || typeof value !== "object" || Array.isArray(value),
      )
    )
      throw invalidUpstream();
    const groups = { artists: [], albums: [], tracks: [], truncated: false },
      seen = new Set(),
      examined = { artists: 0, albums: 0, tracks: 0 };
    for (const hub of hubs) {
      const group = { artist: "artists", album: "albums", track: "tracks" }[
        hub.type
      ];
      if (!group) continue;
      if (
        !Array.isArray(hub.Metadata || []) ||
        (hub.Metadata || []).some(
          (value) =>
            !value || typeof value !== "object" || Array.isArray(value),
        )
      )
        throw invalidUpstream();
      if (number(hub.size) > limit || hub.more || hub.moreKey)
        groups.truncated = true;
      for (let item of hub.Metadata || []) {
        if (examined[group]++ >= limit) {
          groups.truncated = true;
          break;
        }
        if (
          !["artist", "album", "track"].includes(item.type) ||
          !decimal(String(item.ratingKey))
        )
          continue;
        if (item.librarySectionID === undefined) {
          try {
            item = await authorizedItem(String(item.ratingKey), { signal });
          } catch (e) {
            if (e.status === 404) continue;
            throw e;
          }
        }
        if (
          String(item.librarySectionID) !== libraryId ||
          item.type !== hub.type ||
          seen.has(String(item.ratingKey))
        )
          continue;
        seen.add(String(item.ratingKey));
        if (groups[group].length >= limit) {
          groups.truncated = true;
          continue;
        }
        groups[group].push(normalize(item));
      }
    }
    return groups;
  }
  async function track(ratingKey, options) {
    const item = await authorizedItem(ratingKey, options);
    if (item.type !== "track") throw missing();
    return normalize(item);
  }
  return { libraries, items, search, track, authorizedItem };
}
