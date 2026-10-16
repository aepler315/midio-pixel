import { pathToFileURL } from "node:url";
import { readPlexConfig } from "./plex/config.mjs";
import { createPlexClient } from "./plex/client.mjs";
import { createPlexCatalog, chooseMedia } from "./plex/catalog.mjs";
export async function runPlexProbe(config) {
  if (!config.enabled) return { enabled: false, liveVerification: "disabled" };
  const client = createPlexClient(config),
    discovery = await client.discover(),
    catalog = createPlexCatalog(client, config);
  const libraryId = discovery.sections[0].id;
  const artists = await catalog.items({ libraryId, kind: "artist", limit: 1 });
  const albums = await catalog.items({
    libraryId,
    kind: "album",
    parentId: artists.items[0]?.ratingKey,
    limit: 1,
  });
  const tracks = await catalog.items({
    libraryId,
    kind: "track",
    parentId: albums.items[0]?.ratingKey,
    limit: 1,
  });
  const report = {
    enabled: true,
    discovery: true,
    approvedMusicSections: discovery.sections.length,
    catalog: {
      artist: artists.items.length > 0,
      album: albums.items.length > 0,
      track: tracks.items.length > 0,
    },
    artwork: { available: false },
    originalDownload: { eligible: false },
    liveVerification: "operator-private-probe",
  };
  const row = tracks.items[0];
  if (!row) return report;
  report.recording = {
    container: row.container,
    audioCodec: row.audioCodec,
    sizeBytes: row.sizeBytes,
    durationMs: row.durationMs,
    loadable: row.loadability.allowed,
  };
  const item = await catalog.authorizedItem(row.ratingKey, { fresh: true });
  async function sample(key, query, maxBytes) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      config.metadataTimeoutMs,
    );
    let reader;
    try {
      const response = await client.openBody(key, {
        query,
        signal: controller.signal,
      });
      if (response.status !== 200) return { available: false };
      reader = response.body?.getReader();
      const first = await reader?.read();
      if (!first || first.done || first.value.byteLength > maxBytes)
        return { available: false };
      return {
        available: true,
        mime: response.headers.get("content-type")?.split(";")[0] || null,
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
  const thumb = item.thumb || item.parentThumb || item.grandparentThumb;
  if (thumb) {
    try {
      const result = await sample(thumb, undefined, config.artworkMaxBytes);
      report.artwork.available =
        result.available &&
        /^image\/(png|jpeg|webp|gif)$/.test(result.mime || "");
    } catch {
      report.artwork.available = false;
    }
  }
  const media = chooseMedia(item, config);
  if (media.allowed) {
    try {
      const result = await sample(
        media.part.key,
        { download: 1 },
        config.maxFileBytes,
      );
      report.originalDownload = {
        eligible:
          result.available &&
          (/^audio\//.test(result.mime || "") ||
            result.mime === "application/octet-stream"),
        sampled: true,
      };
    } catch {
      report.originalDownload = { eligible: false, sampled: true };
    }
  }
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(await runPlexProbe(readPlexConfig()), null, 2));
  } catch {
    console.error(
      "Plex compatibility probe failed: verify private configuration, server availability and music section allowlist",
    );
    process.exitCode = 1;
  }
}
