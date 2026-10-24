import { AUDIO_LOAD_LIMITS } from "../../src/audio/loadLimits.js";
import { hostList, requestHostname } from "../lib/request-host.mjs";
export function readPlexConfig(env = process.env) {
  const enabled = env.MIDIO_PLEX_ENABLED === "true";
  if (
    env.MIDIO_PLEX_ENABLED &&
    !["true", "false"].includes(env.MIDIO_PLEX_ENABLED)
  )
    throw new Error("MIDIO_PLEX_ENABLED must be true or false");
  const sectionIds = (env.PLEX_MUSIC_SECTION_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (sectionIds.some((x) => !/^\d+$/.test(x)))
    throw new Error("Invalid Plex section allowlist");
  const token = env.PLEX_TOKEN || "",
    clientIdentifier = env.PLEX_CLIENT_IDENTIFIER || "";
  if (enabled && (!token || !clientIdentifier || !sectionIds.length))
    throw new Error(
      "Enabled Plex requires token, client identifier and section allowlist",
    );
  if (
    [...(token + clientIdentifier)].some(
      (x) => x.charCodeAt(0) < 32 || x.charCodeAt(0) === 127,
    )
  )
    throw new Error("Invalid private Plex credentials");
  let base;
  try {
    base = new URL(env.PLEX_BASE_URL || "http://127.0.0.1:32400");
  } catch {
    throw new Error("Invalid private Plex base URL");
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error("Plex base URL must be an HTTP origin");
  const allowedOrigins = (env.PLEX_ALLOWED_ORIGINS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const value of allowedOrigins) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Invalid allowed browser origin");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value)
      throw new Error("Allowed origins must be exact HTTP origins");
  }
  // Names (beyond loopback and IP literals) the adapter answers to, e.g. the
  // hostname of MIDIO_PLEX_PUBLIC_API_BASE when a reverse proxy forwards it.
  const publicHosts = hostList(env.PLEX_PUBLIC_HOST);
  if (publicHosts.some((x) => requestHostname(x) !== x))
    throw new Error("PLEX_PUBLIC_HOST must list bare hostnames");
  const port = Number(env.PLEX_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid adapter port");
  return {
    enabled,
    baseUrl: base.origin,
    token,
    clientIdentifier,
    sectionIds: [...new Set(sectionIds)],
    host: env.PLEX_HOST || "127.0.0.1",
    port,
    allowedOrigins,
    publicHosts,
    metadataMaxBytes: 4 * 1024 * 1024,
    artworkMaxBytes: 4 * 1024 * 1024,
    metadataTimeoutMs: 15000,
    mediaInactivityMs: 45000,
    mediaAbsoluteMs: 15 * 60 * 1000,
    maxMetadataRequests: 8,
    maxAudioTransfers: 4,
    cacheMaxEntries: 100,
    cacheMaxBytes: 16 * 1024 * 1024,
    cacheTtlMs: 30000,
    maxFileBytes: AUDIO_LOAD_LIMITS.maxFileBytes,
    maxDurationMs: AUDIO_LOAD_LIMITS.maxDurationSeconds * 1000,
    maxChannels: AUDIO_LOAD_LIMITS.maxChannels,
  };
}
