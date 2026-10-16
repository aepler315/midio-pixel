import { once } from "node:events";
import { chooseMedia } from "./catalog.mjs";
import { PlexError, invalidUpstream, resolvePlexKey } from "./client.mjs";
export function createPlexMedia({ client, catalog, config }) {
  let activeAudio = 0,
    activeArtwork = 0;
  async function transfer(
    req,
    res,
    {
      key,
      query,
      mime,
      maxBytes,
      expectedBytes = null,
      artwork = false,
      signal,
    },
  ) {
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let timer, reader;
    const timeout = () =>
      controller.abort(
        new PlexError(
          "UPSTREAM_TIMEOUT",
          "Media transfer timed out",
          504,
          true,
        ),
      );
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        timeout,
        artwork ? config.metadataTimeoutMs : config.mediaInactivityMs,
      );
    };
    const absolute = setTimeout(
      timeout,
      artwork ? config.metadataTimeoutMs : config.mediaAbsoluteMs,
    );
    arm();
    try {
      let upstream;
      try {
        upstream = await client.openBody(key, { query, signal: combined });
      } catch (error) {
        if (error.code === "LIBRARY_UNAVAILABLE" || error.code === "NOT_FOUND")
          throw new PlexError(
            "MEDIA_UNAVAILABLE",
            "Recording unavailable",
            503,
            true,
          );
        throw error;
      }
      if (upstream.status !== 200) {
        await upstream.body?.cancel();
        throw invalidUpstream();
      }
      const contentType = (upstream.headers.get("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const validType = artwork
        ? ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
            contentType,
          )
        : (contentType.startsWith("audio/") &&
            !/mpegurl|m3u|playlist/.test(contentType)) ||
          contentType === "application/octet-stream";
      if (!validType) {
        await upstream.body?.cancel();
        throw new PlexError(
          "UNSUPPORTED_MEDIA",
          "Unsupported media response",
          415,
        );
      }
      const rawLength = upstream.headers.get("content-length");
      const declared = rawLength === null ? null : Number(rawLength);
      if (
        declared !== null &&
        (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(declared))
      ) {
        await upstream.body?.cancel();
        throw invalidUpstream();
      }
      if (declared !== null && declared > maxBytes) {
        await upstream.body?.cancel();
        throw new PlexError(
          "MEDIA_TOO_LARGE",
          "Media exceeds the byte limit",
          413,
        );
      }
      if (
        expectedBytes !== null &&
        declared !== null &&
        declared !== expectedBytes
      ) {
        await upstream.body?.cancel();
        throw invalidUpstream();
      }
      reader = upstream.body?.getReader();
      if (!reader) throw invalidUpstream();
      let received = 0,
        started = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        if (!value.byteLength) continue;
        received += value.byteLength;
        if (received > maxBytes)
          throw new PlexError(
            "MEDIA_TOO_LARGE",
            "Media exceeds the byte limit",
            413,
          );
        if (
          (declared !== null && received > declared) ||
          (expectedBytes !== null && received > expectedBytes)
        )
          throw invalidUpstream();
        if (!started) {
          const sniff = Buffer.from(value.subarray(0, 256))
            .toString("utf8")
            .trimStart()
            .toLowerCase();
          if (sniff.startsWith("<") || sniff.startsWith("{"))
            throw new PlexError(
              "UNSUPPORTED_MEDIA",
              "Unsupported media response",
              415,
            );
          res.setHeader("Content-Type", artwork ? contentType : mime);
          res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
          res.setHeader("Accept-Ranges", "none");
          res.setHeader(
            "Cache-Control",
            artwork ? "public, max-age=30" : "no-store",
          );
          // Audio is chunked so an incorrect upstream length cannot hide a truncated file.
          res.writeHead(200);
          started = true;
        }
        if (!res.write(value)) await once(res, "drain", { signal: combined });
      }
      if (
        !received ||
        (declared !== null && received !== declared) ||
        (expectedBytes !== null && received !== expectedBytes)
      )
        throw invalidUpstream();
      res.end();
      await Promise.race([
        once(res, "finish", { signal: combined }),
        once(res, "close", { signal: combined }),
      ]);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (signal?.aborted) throw signal.reason;
      if (error instanceof PlexError) throw error;
      throw invalidUpstream();
    } finally {
      clearTimeout(timer);
      clearTimeout(absolute);
      controller.abort();
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
  async function sendAudio(req, res, { ratingKey, revision, signal }) {
    if (activeAudio >= config.maxAudioTransfers)
      throw new PlexError("CAPACITY", "Library busy; retry shortly", 429, true);
    activeAudio++;
    try {
      const item = await catalog.authorizedItem(ratingKey, {
        signal,
        fresh: true,
      });
      if (item.type !== "track")
        throw new PlexError("NOT_FOUND", "Item not found", 404);
      const media = chooseMedia(item, config);
      if (!media.allowed)
        throw new PlexError(
          media.status === 413 ? "MEDIA_TOO_LARGE" : "UNSUPPORTED_MEDIA",
          media.reason,
          media.status,
        );
      if (!revision || revision !== media.revision)
        throw new PlexError(
          "STALE_REVISION",
          "Recording changed; refresh selection",
          409,
          true,
        );
      resolvePlexKey(media.part.key, config.baseUrl, ["/library/parts"]);
      if (req.method === "HEAD") {
        res.setHeader("Content-Type", media.mime);
        res.setHeader("Accept-Ranges", "none");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        if (media.sizeBytes !== null)
          res.setHeader("Content-Length", String(media.sizeBytes));
        res.writeHead(200);
        res.end();
        return;
      }
      await transfer(req, res, {
        key: media.part.key,
        query: { download: 1 },
        mime: media.mime,
        maxBytes: config.maxFileBytes,
        expectedBytes: media.sizeBytes,
        signal,
      });
    } finally {
      activeAudio--;
    }
  }
  async function sendArtwork(req, res, { ratingKey, signal }) {
    if (activeArtwork >= config.maxMetadataRequests)
      throw new PlexError("CAPACITY", "Library busy; retry shortly", 429, true);
    activeArtwork++;
    try {
      const item = await catalog.authorizedItem(ratingKey, { signal });
      const key = item.thumb || item.parentThumb || item.grandparentThumb;
      if (!key) throw new PlexError("NOT_FOUND", "Artwork not found", 404);
      resolvePlexKey(key, config.baseUrl, ["/library/metadata"]);
      const match = new URL(key, config.baseUrl).pathname.match(
        /^\/library\/metadata\/(\d+)\/(thumb|art)\/\d+$/,
      );
      if (!match) throw invalidUpstream();
      if (match[1] !== ratingKey)
        await catalog.authorizedItem(match[1], { signal });
      const release = client.reserveMetadata();
      try {
        await transfer(req, res, {
          key,
          maxBytes: config.artworkMaxBytes,
          artwork: true,
          signal,
        });
      } finally {
        release();
      }
    } finally {
      activeArtwork--;
    }
  }
  return { sendAudio, sendArtwork };
}
