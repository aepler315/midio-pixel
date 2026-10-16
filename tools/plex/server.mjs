import http from "node:http";
import { AUDIO_LOAD_LIMITS } from "../../src/audio/loadLimits.js";
import { createPlexCatalog } from "./catalog.mjs";
import { PlexError } from "./client.mjs";
import { createPlexMedia } from "./media.mjs";
const invalid = () =>
  new PlexError("INVALID_INPUT", "Invalid request parameters", 400);
function queries(url, allowed) {
  const output = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(output, key)) throw invalid();
    output[key] = value;
  }
  return output;
}
function integer(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw invalid();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw invalid();
  return n;
}
export function createPlexServer({ config, client }) {
  const catalog = createPlexCatalog(client, config),
    controllers = new Set();
  const media = createPlexMedia({ client, catalog, config });
  const ready = config.enabled ? client.discover() : Promise.resolve();
  ready.catch(() => {});
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    const signal = controller.signal;
    const abort = () => {
      if (!res.writableFinished) controller.abort();
    };
    req.on("aborted", abort);
    res.on("close", abort);
    const origin = req.headers.origin;
    res.setHeader("Vary", "Origin");
    if (config.allowedOrigins.includes(origin))
      res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(body));
    };
    try {
      let url;
      try {
        url = new URL(req.url, "http://adapter");
      } catch {
        throw invalid();
      }
      const path = url.pathname;
      const prefix = "/api/plex/v1";
      if (!path.startsWith(prefix + "/"))
        throw new PlexError("NOT_FOUND", "Route not found", 404);
      const route = path.slice(prefix.length),
        match = route.match(/^\/(tracks|artwork)\/(\d+)(\/audio)?$/);
      const known =
        ["/status", "/libraries", "/items", "/search"].includes(route) ||
        (match && !(match[1] === "artwork" && match[3]));
      if (!known) throw new PlexError("NOT_FOUND", "Route not found", 404);
      const audio = match?.[1] === "tracks" && !!match[3];
      if (req.method === "OPTIONS") {
        if (!config.allowedOrigins.includes(origin))
          throw new PlexError(
            "ORIGIN_DENIED",
            "Browser origin not allowed",
            403,
          );
        if (
          !["GET", "HEAD"].includes(
            req.headers["access-control-request-method"] || "GET",
          )
        )
          throw new PlexError("METHOD_DENIED", "Method not allowed", 405);
        const requested = (req.headers["access-control-request-headers"] || "")
          .toLowerCase()
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        if (requested.some((x) => !["range"].includes(x))) throw invalid();
        res.setHeader(
          "Access-Control-Allow-Methods",
          audio ? "GET, HEAD, OPTIONS" : "GET, OPTIONS",
        );
        if (requested.length)
          res.setHeader("Access-Control-Allow-Headers", "Range");
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "GET" && !(audio && req.method === "HEAD")) {
        res.setHeader("Allow", audio ? "GET, HEAD, OPTIONS" : "GET, OPTIONS");
        throw new PlexError("METHOD_DENIED", "Method not allowed", 405);
      }
      const q = queries(
        url,
        route === "/items"
          ? ["libraryId", "kind", "parentId", "offset", "limit"]
          : route === "/search"
            ? ["libraryId", "q", "limit"]
            : audio
              ? ["revision"]
              : [],
      );
      if (route === "/status") {
        let available = false;
        if (config.enabled) {
          try {
            await ready;
            available = true;
          } catch {
            /* sanitized availability only */
          }
        }
        send(200, {
          enabled: config.enabled,
          available,
          access: "public-read-only",
          capabilities: {
            browse: true,
            search: true,
            originalAudio: true,
            artwork: true,
          },
          limits: AUDIO_LOAD_LIMITS,
        });
        return;
      }
      if (!config.enabled)
        throw new PlexError("DISABLED", "Plex library disabled", 503);
      await ready;
      if (route === "/libraries") {
        send(200, await catalog.libraries({ signal }));
        return;
      }
      if (route === "/items") {
        if (
          !/^\d+$/.test(q.libraryId || "") ||
          !["artist", "album", "track"].includes(q.kind) ||
          (q.parentId !== undefined && !/^\d+$/.test(q.parentId))
        )
          throw invalid();
        send(
          200,
          await catalog.items({
            ...q,
            offset: integer(q.offset, 0, 0, Number.MAX_SAFE_INTEGER),
            limit: integer(q.limit, 50, 1, 100),
            signal,
          }),
        );
        return;
      }
      if (route === "/search") {
        const query = (q.q || "").trim();
        if (
          !/^\d+$/.test(q.libraryId || "") ||
          query.length < 2 ||
          query.length > 200
        )
          throw invalid();
        send(
          200,
          await catalog.search({
            ...q,
            q: query,
            limit: integer(q.limit, 20, 1, 50),
            signal,
          }),
        );
        return;
      }
      if (match[1] === "artwork") {
        await media.sendArtwork(req, res, { ratingKey: match[2], signal });
        return;
      }
      if (audio) {
        await media.sendAudio(req, res, {
          ratingKey: match[2],
          revision: q.revision,
          signal,
        });
        return;
      }
      send(200, await catalog.track(match[2], { signal, fresh: true }));
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (signal.aborted || res.destroyed) {
        res.destroy();
        return;
      }
      const safe =
        error instanceof PlexError
          ? error
          : new PlexError(
              "LIBRARY_UNAVAILABLE",
              "Plex library unavailable",
              503,
              true,
            );
      if (safe.status === 429) res.setHeader("Retry-After", "5");
      send(safe.status, {
        error: {
          code: safe.code,
          message: safe.message,
          retryable: safe.retryable,
        },
      });
    } finally {
      controllers.delete(controller);
      req.off("aborted", abort);
      res.off("close", abort);
    }
  });
  server.ready = ready;
  const close = server.close.bind(server);
  server.close = (...args) => {
    for (const controller of controllers) controller.abort();
    return close(...args);
  };
  return server;
}
