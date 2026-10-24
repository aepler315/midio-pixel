# Plex library integration

Midio can anonymously browse an operator-approved Plex music library and play a complete original recording through the usual audio analysis and Range playback. It reads the library used by Plexamp; it does not control Plexamp or send listening history, ratings, queues, or playback state to Plex.

The committed frontend configuration is disabled. Implementation and automated fixture verification do not establish a working public deployment. A live PMS, private credentials, approved section IDs, and an HTTPS endpoint still need to be supplied by the operator.

## Deployment inputs

| Input | Where it belongs | Purpose |
| --- | --- | --- |
| `PLEX_BASE_URL` | Private adapter environment | PMS HTTP origin, normally `http://127.0.0.1:32400` on the same computer |
| `PLEX_TOKEN` | Private adapter environment only | Token valid for the selected PMS |
| `PLEX_CLIENT_IDENTIFIER` | Private adapter environment | Stable identifier for this adapter installation; generate once and retain |
| `PLEX_MUSIC_SECTION_IDS` | Private adapter environment | Comma-separated decimal music section IDs to publish |
| `PLEX_ALLOWED_ORIGINS` | Private adapter environment | Exact browser origins, for example `https://supermaudio.com`; no paths or trailing slash |
| `PLEX_HOST`, `PLEX_PORT` | Private adapter environment | Defaults `127.0.0.1`, `8787` |
| `PLEX_PUBLIC_HOST` | Private adapter environment | Comma-separated bare hostnames the adapter also answers to, for example the host of `MIDIO_PLEX_PUBLIC_API_BASE` when the ingress forwards it. Default: loopback names and IP addresses only; any other `Host` gets `403 HOST_DENIED` |
| `MIDIO_PLEX_ENABLED` | Private adapter environment | Explicit `true` to serve the approved library; default `false` |
| `MIDIO_PLEX_PUBLIC_API_BASE` | Local staging environment or GitHub Actions repository **variable** | Public HTTPS endpoint ending exactly in `/api/plex/v1`, without query, fragment, credentials, trailing slash, or extra path prefix |

The public API intentionally permits anonymous downloads of approved original recordings. Exact CORS origins govern browser access; they do not authenticate a downloader. An owner token may have broader PMS privileges. The adapter's fixed routes and section checks provide the public read-only boundary.

## Private adapter setup

Use Node 24 and install the repository dependencies with `npm ci`. Copy `.env.plex.example` to `.env.plex` and edit it privately. Git ignores this filename. Restrict file access to the service account; keep it outside a public server's document root. Do not put tokens in issue bodies, chat, command arguments, screenshots, browser URLs, or public config.

Provision authentication using Plex's [documented authentication flow](https://developer.plex.tv/pms/#section/API-Info/Authenticating-with-Plex): keep one client identifier, authenticate the operator through the PIN/Auth App flow, then obtain the selected server's token from the resources response. Store the PMS token privately in `PLEX_TOKEN`. Plex also documents [temporary token inspection](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/), which is useful for diagnosis but should not be assumed permanent. This adapter consumes the supplied token; it does not implement interactive sign-in or automatic renewal. Use the authentication method supported by your PMS and renew or rotate credentials privately when needed.

Inspect your music library's section ID in Plex Web's library URL or with an authenticated private library inspection. Supply only the music sections intended for public access. Startup discovers `/media/providers`, validates the selected sections as music, and fails before listening if verification fails. It never falls back to every section.

From the repository directory:

```sh
npm run plex:probe
npm run plex:server
```

The probe prints a redacted compatibility summary: discovery, one artist/album/track, artwork availability, format, and whether original download sampling worked. It reads only the first body chunk and cancels the transfer. A positive sample does not prove complete-file delivery or browser decoding. Run the complete browser acceptance checks below before enabling the public entry.

The dedicated server binds loopback port 8787 by default. It imports no development server, arbitrary file server, or Soulseek bridge. A custom private env path is supported through Node directly:

```sh
node --env-file=/private/path/plex.env tools/plex-probe.mjs
node --env-file=/private/path/plex.env tools/plex-server.mjs
```

On Windows, use Task Scheduler with an absolute `node.exe` program path, arguments `--env-file="D:\private\plex.env" tools/plex-server.mjs`, and **Start in** set to the repository directory. Run under the account that can read the private file. Configure startup/logon as appropriate, restart on failure, and prevent overlapping instances. Keep PMS running under its own supported startup setup. Use bounded/rotated private logs rather than unbounded redirected output. The CLI handles SIGINT/SIGTERM by cancelling requests and closing connections.

## HTTPS ingress and frontend staging

Point a TLS reverse proxy or tunnel solely at `http://127.0.0.1:8787`. Preserve `/api/plex/v1/...` and forward only this adapter. The adapter refuses `Host` names that are not loopback, an IP address or listed in `PLEX_PUBLIC_HOST` (a guard against DNS rebinding), so either have the ingress send `Host: 127.0.0.1:8787` or add its public hostname, e.g. `PLEX_PUBLIC_HOST=plex.example.com`. Do not publish port 32400, the Midio development server, or a directory tree. Check the chosen ingress supports the full encoded-file size, the transfer duration, cancellation, and streaming without buffering the entire recording. The home computer, PMS, adapter, and ingress must all remain available for new downloads.

The adapter sends tokens only in private upstream request headers. It rejects upstream redirects and unapproved key families, rechecks section membership and the selected media revision before audio delivery, strips upstream headers, and caps all streams. Public JSON never contains PMS paths, connection URLs, tokens, or server identity.

For local development, write only the public endpoint:

```sh
MIDIO_PLEX_PUBLIC_API_BASE=http://127.0.0.1:8787/api/plex/v1 npm run plex:config
npm start
```

PowerShell equivalent: set `$env:MIDIO_PLEX_PUBLIC_API_BASE` to the loopback endpoint, then run `npm run plex:config`. Include the app's exact local origin in `PLEX_ALLOWED_ORIGINS`. Restore the committed disabled `src/config/plex.json` before committing a local setup.

For the published site, set `MIDIO_PLEX_PUBLIC_API_BASE` to your public HTTPS adapter endpoint in the environment of the publishing shell, then run `npm run publish:site` (see [Local validation and publishing](local-validation.md)); staging writes `_site/src/config/plex.json` after copying source, and the source default stays disabled. The published `gh-pages` tree includes only `index.html`, `src/`, `soundfonts/`, `CNAME`, `LICENSE`, `NOTICE`, `version.json` and `.nojekyll`. Adapter tools, `.env.plex`, tests, and Soulseek files are excluded. (A repository Actions variable reaches only the optional manual `static.yml` workflow, which is not the active publisher.)

The exact public schema is `{"version":1,"apiBase":"https://music.example/api/plex/v1"}`. An empty base disables all Plex entries. Invalid or unreachable optional config never prevents ordinary local/URL loading. Once configured, use **Plex library** on the title screen, **Music** during playback, or **Choose different music from Plex** during audio analysis.

## Transfer behavior and limits

Browse artists, albums, or tracks; search results are grouped and may ask you to refine a truncated query. Browsing pages contain 50 rows, and the UI retains at most 500 appended tracks. Tracks remain separate by Plex ID even when their titles match.

An eligible original uses one complete, accessible Part from a deterministic Media choice. Multipart, unavailable, oversized, unknown-container, or excess-channel recordings are disabled or rejected with an explanation. Supported container names include WAV, FLAC, MP3, M4A/MP4, AAC, OGG/Opus, AIFF, and WMA; actual decoding depends on the browser. V1 does not transcode or switch to a lower-quality alternative. The client refreshes a changed revision once; repeated changes require a fresh selection.

| Resource | Limit |
| --- | --- |
| Encoded recording | 256 MiB |
| Duration / channels | 20 minutes / 1–2 channels |
| Browser decoded buffer | 512 MiB per buffer; 768 MiB combined loader budget |
| Metadata / artwork response | 4 MiB each in adapter; 1 MiB JSON in browser |
| Metadata / artwork deadline | 15 seconds |
| Audio inactivity / absolute adapter deadline | 45 seconds / 15 minutes |
| Concurrent metadata/artwork / audio | 8 / 4 |
| Metadata cache | 100 entries, 16 MiB, 30 seconds |

Transfers enforce declared and actual byte counts, including the fresh Part size when present. Unknown sizes stay bounded. Client cancellation and shutdown abort upstream work; the adapter uses stream backpressure and stores no media on disk. Browser decode and analysis enforce the existing audio budgets independently.

Source title, artist, album, and ID remain distinct from the analysis cache and visual identity, which continue to derive from decoded audio. Missing metadata remains provisional. The newest selection owns pending fetch/decode/analysis work across local files, folders, URLs, and Plex. Selecting a pending replacement leaves the active recording's full analysis intact until an actual handoff. Once downloaded and prepared, playback, pause, seek, replay, and export use the existing recording path and no longer require the adapter.

## Troubleshooting and rollback

- Startup/probe failures deliberately omit raw upstream details. Check the private token, PMS origin, service availability, and music section allowlist locally. Restart after changing these inputs or rotating the token.
- `/status.available` reports successful startup discovery, not a continuously polled PMS health check. A subsequent outage produces sanitized browse/download errors and the UI's Retry control.
- `400` means invalid parameters; `404` means missing or unauthorized item; `409` means media revision changed; `413` means a size/duration limit; `415` means an unsupported recording; `429` means capacity is busy and includes `Retry-After`; `502` means invalid upstream content; `503` means disabled/unavailable; `504` means a timed-out transfer. Details stay sanitized.
- A browser decode failure keeps the Plex dialog's recovery controls available. Cancel during download or preparation, choose another track, or use local/URL audio.
- To stop public access immediately, stop the adapter or set `MIDIO_PLEX_ENABLED=false` and restart it. Then clear the Actions public endpoint variable and redeploy the disabled static config. Old downloaded recordings can continue playing. Restore local config with `npm run plex:config` with the public variable unset.

## Verification and live acceptance

Run `npm test`, `npm run lint`, and `npm run test:plex`. The Plex smoke launches a synthetic PMS, dedicated adapter, and Chromium on temporary loopback ports. It exercises anonymous navigation/search/paging, hostile labels, focus/keyboard use, 800×480 layout, selection races, cancellation in fetch/decode/analysis, expected PCM fingerprints, blocked IndexedDB, actual generated staged config, adapter loss after download, pause/seek/replay/export, and local-file cache equivalence. It leaves diagnostics under `.smoke/plex/`; all services close afterward. `--case ui`, `--case selection`, and `--case playback` isolate those portions. CI retains diagnostics as artifacts.

Before calling a deployment live, record a redacted probe summary and independently verify:

1. Approved real artists/albums/tracks and artwork, with foreign section IDs rejected.
2. Complete downloads and browser decoding of representative real library formats within budgets.
3. Logged-out public HTTPS browsing and loading from the configured browser origin; no tokens in DevTools requests or published artifacts.
4. Cancel, retry, local/URL replacement, playback clock, pause, seek, replay, export, and playback after adapter disconnection.
5. An 800×480 browser and the actual head unit, including autoplay/audio unlock and chooser behavior.
6. Autostart/restart, token renewal, ingress transfer limits, and rollback.

These live PMS, external HTTPS, real-format, and physical-device checks remain pending until the deployment inputs are supplied. Automated fixture and software-renderer results do not establish those outcomes.
