import { createHash } from "node:crypto";
export class PlexError extends Error {
  constructor(code, message, status = 502, retryable = false) {
    super(message);
    this.name = "PlexError";
    Object.assign(this, { code, status, retryable });
  }
}
export const invalidUpstream = () =>
  new PlexError("UPSTREAM_INVALID", "Invalid library response", 502);
export function resolvePlexKey(
  key,
  baseUrl,
  families = [
    "/media/providers",
    "/library/sections",
    "/library/metadata",
    "/library/parts",
    "/hubs/search",
  ],
) {
  if (
    typeof key !== "string" ||
    !key ||
    [...key].some(
      (x) => x.charCodeAt(0) <= 32 || x.charCodeAt(0) === 127 || x === "\\",
    )
  )
    throw new PlexError("UPSTREAM_INVALID", "Invalid Plex key");
  let decoded = key;
  try {
    for (let i = 0; i < 5; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new PlexError("UPSTREAM_INVALID", "Invalid Plex key");
  }
  if (
    [...decoded].some(
      (x) => x.charCodeAt(0) <= 32 || x.charCodeAt(0) === 127 || x === "\\",
    ) ||
    decoded.split("/").some((x) => x === "." || x === "..")
  )
    throw new PlexError("UPSTREAM_INVALID", "Invalid Plex key");
  let url;
  try {
    url = new URL(key, baseUrl);
  } catch {
    throw new PlexError("UPSTREAM_INVALID", "Invalid Plex key");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== new URL(baseUrl).origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !families.some(
      (x) => url.pathname === x || url.pathname.startsWith(x + "/"),
    )
  )
    throw new PlexError("UPSTREAM_INVALID", "Invalid Plex key");
  return url;
}
export function createPlexClient(
  config,
  { fetchImpl = fetch, now = Date.now } = {},
) {
  let active = 0,
    discovery;
  function reserveMetadata() {
    if (active >= config.maxMetadataRequests)
      throw new PlexError("CAPACITY", "Library busy; retry shortly", 429, true);
    active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        active--;
      }
    };
  }
  async function openBody(key, { query, signal } = {}) {
    const url = resolvePlexKey(key, config.baseUrl);
    for (const [name, value] of Object.entries(query || {})) {
      if (
        ![
          "type",
          "X-Plex-Container-Start",
          "X-Plex-Container-Size",
          "sort",
          "query",
          "sectionId",
          "limit",
          "download",
        ].includes(name)
      )
        throw new PlexError(
          "INVALID_INPUT",
          "Invalid private request parameter",
          400,
        );
      url.searchParams.set(name, String(value));
    }
    try {
      const response = await fetchImpl(url, {
        signal,
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "X-Plex-Token": config.token,
          "X-Plex-Client-Identifier": config.clientIdentifier,
          "X-Plex-Product": "Midio Plex adapter",
          "X-Plex-Version": "1",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new PlexError("UPSTREAM_INVALID", "Plex redirect refused");
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404)
          throw new PlexError("NOT_FOUND", "Item not found", 404);
        if ([401, 403].includes(response.status))
          throw new PlexError(
            "LIBRARY_UNAVAILABLE",
            "Plex library unavailable",
            503,
            true,
          );
        throw new PlexError(
          "LIBRARY_UNAVAILABLE",
          "Plex library unavailable",
          503,
          true,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof PlexError || signal?.aborted) throw error;
      throw new PlexError(
        "LIBRARY_UNAVAILABLE",
        "Plex library unavailable",
        503,
        true,
      );
    }
  }
  async function getJson(key, { query, signal } = {}) {
    const release = reserveMetadata();
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new PlexError(
            "UPSTREAM_TIMEOUT",
            "Library request timed out",
            504,
            true,
          ),
        ),
      config.metadataTimeoutMs,
    );
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const response = await openBody(key, { query, signal: combined });
      if (
        Number(response.headers.get("content-length")) > config.metadataMaxBytes
      ) {
        await response.body?.cancel();
        throw invalidUpstream();
      }
      let size = 0;
      const chunks = [];
      const reader = response.body?.getReader();
      if (!reader) throw invalidUpstream();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > config.metadataMaxBytes) {
            await reader.cancel();
            throw invalidUpstream();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw invalidUpstream();
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw invalidUpstream();
      return body;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (signal?.aborted) throw signal.reason;
      if (error instanceof PlexError) throw error;
      throw invalidUpstream();
    } finally {
      clearTimeout(timeout);
      release();
    }
  }
  async function discover({ signal } = {}) {
    if (!config.enabled)
      return { namespace: null, sections: [], capabilities: {} };
    const body = await getJson("/media/providers", { signal });
    const mc = body.MediaContainer;
    const provider = mc?.MediaProvider?.find(
      (p) => p.identifier === "com.plexapp.plugins.library",
    );
    if (!provider || !mc.machineIdentifier) throw invalidUpstream();
    const features = provider.Feature || [];
    const metadata = features.find((x) => x.type === "metadata")?.key,
      search = features.find((x) => x.type === "search")?.key;
    if (!metadata || !search) throw invalidUpstream();
    resolvePlexKey(metadata, config.baseUrl, ["/library/metadata"]);
    resolvePlexKey(search, config.baseUrl, ["/hubs/search"]);
    const content = features.filter((x) => x.type === "content");
    for (const feature of content)
      if (feature.key)
        resolvePlexKey(feature.key, config.baseUrl, ["/library/sections"]);
    const directories = content.flatMap((x) => x.Directory || []);
    const sections = config.sectionIds.map((id) => {
      const dir = directories.find((x) => String(x.id) === id);
      if (!dir || dir.type !== "artist")
        throw new PlexError(
          "LIBRARY_UNAVAILABLE",
          "Configured section is not a music section",
          503,
        );
      resolvePlexKey(dir.key, config.baseUrl, ["/library/sections"]);
      return {
        id,
        title: typeof dir.title === "string" ? dir.title : "Unknown library",
        key: new URL(dir.key, config.baseUrl).pathname,
      };
    });
    discovery = {
      namespace: createHash("sha256")
        .update(String(mc.machineIdentifier))
        .digest("hex")
        .slice(0, 20),
      sections,
      capabilities: {
        metadata: new URL(metadata, config.baseUrl).pathname,
        search: new URL(search, config.baseUrl).pathname,
      },
      discoveredAt: now(),
    };
    return discovery;
  }
  return {
    getJson,
    openBody,
    discover,
    reserveMetadata,
    get discovery() {
      return discovery;
    },
  };
}
