# Validation matrix

What CI actually runs, what those jobs prove, and what they do not.
This is the QA-001 contract: a workflow-to-test map with explicit
thresholds, supported environments, and unverified cases. It is not a
claim that product assurance is complete.

Workflow map updated for midio-pixel. Historical audit counts below are not live gates.

## Supported environments (measured)

| Surface | Environment | Evidence |
| --- | --- | --- |
| Root unit tests | Node 24 on `ubuntu-latest` | `.github/workflows/test.yml` job `test` (`npm test`) |
| Root lint + high-severity audit | Node 24 on `ubuntu-latest` | same job (`npm run lint`, `npm audit --audit-level=high`) |
| Browser smoke | Playwright Chromium on `ubuntu-latest` | job `browser-smoke` |
| Local audio-only app | Chromium-family browsers | README + `npm start` on loopback |

Since 2026-10-14 the repository is private, and GitHub-hosted runners for
private repositories have 2 CPUs instead of 4. Chromium renders through
SwiftShader on the CPU, so every browser smoke and the parallel unit-test
run take roughly twice as long as on the earlier 4-CPU runners (for
example `plex-smoke` 7.5-8.7 min before, 13-16 min after). Job budgets
assume 2 CPUs; the shared setup action logs each job's CPU and memory
count as its first step.

The core gate (`test.yml`) runs only when manually dispatched; it has no PR,
push or reusable-workflow trigger, and routine validation runs locally (see
[local validation](./local-validation.md)). A PR or main push therefore has no
hosted green gate. Extended
playback/lighting/shading/seek/world/export/car/URL/Plex/pixel checks run through
the manually dispatched `Extended browser validation` workflow. Forest close-ups,
terrain shading, landscape comparisons, full visual evaluation and depth rendering
remain separately dispatched jobs; a green core gate does not claim those passed.

## Workflow jobs

| Job | Command / check | Pass bar | Proves | Does not prove |
| --- | --- | --- | --- | --- |
| `test` | `npm ci`, `npm audit --audit-level=high`, `npm run lint`, `npm test` | zero failing Node tests under `test/*.js`, `test/*.mjs`, `test/helpers/*.js`; lint clean; no high+ npm advisories | Unit contracts for analysis, library fakes, export estimates, UI helpers | Real IndexedDB in a browser; Firefox/Safari; long recordings; physical devices |
| `browser-smoke` | `test:smoke`, `stage:site`, `test:bootstrap`, `test:routes` | zero failures within a twenty-minute job; all four current routes must pass | Gallery/legacy coverage plus frozen staged default Landscape v2, selected/persisted Tetons and Trio; real decoded audio and completed composed frames | Long visual comparisons, real-song pacing, hardware performance |
| `pixel-presentation` (manual extended job) | `npm run test:retro` (24-minute harness bound; 30-minute job) | real DPR raster grid/boundaries, completed-capture palette membership, meaningful/changing Range content, scene bars, explicit export rejection | Chromium default v2 versus explicit legacy, eight representative export profiles/sizes, persisted settings, context recovery where available | Device performance, non-Chromium engines, every profile combination; failed driver runs remain failed evidence |
| `plex-smoke` (manual extended job) | `npm run test:plex` against its synthetic PMS, dedicated adapter, and generated staged artifact | zero failed catalog, ownership, cancellation, PCM, playback, or export assertions; no uncaught browser errors | Anonymous Chromium catalog, paging, actual loader races/cancellation, no token-bearing browser calls, blocked-storage recovery, offline playback, source/cache identity | Live PMS, external HTTPS ingress, real library format compatibility, non-Chromium or head-unit hardware; see [deployment guide](./plex-integration.md) |
| `audio-smoke` (manual extended job) | Playback/lighting/shading/seek/world/export/car/URL-loader smokes against source, then `stage:site` + `test:bootstrap` against that artifact | each script exits 0; staged Browse opens a real chooser; artifacts under `.smoke/` | Chromium can boot the actual public file set, upload a short synthetic fixture, pick a world, draw, seek, and start an export | Watchability, identity, other engines, songs longer than the fixture |

The intended `Deploy static content to Pages` workflow stages one artifact with
`stage:site`, boots and plays that artifact (`test:bootstrap`, `test:smoke` and `test:routes`),
and uploads only the public allowlist. It does not call the Test workflow, so lint
and unit tests are not part of it. **This is not the currently observed publishing path.** On 2026-10-18,
run 39099645162 built main 0a82fba through GitHub's dynamic Jekyll Pages workflow
and deployed successfully. Root CNAME still names `supermaudio.com`, inherited
from Midio-5. Confirm the intended independent domain and select GitHub Actions
as the Pages source in repository Settings > Pages before treating the staged
workflow as the release gate. No Pages settings were changed during this work.

Pixel validation run 39099645278 failed in two seconds with empty step lists and
no assigned runner. The pinned checkout SHA resolves to actions/checkout v7.0.1.
The connector cannot read check annotations or Pages settings, and the desktop
browser connection is unavailable in this host session. The runner-allocation
failure remains unresolved externally; local green tests cannot establish CI health.

## Thresholds that are measured today

- Root CI: the `test` job must be green. The 20432ab audit recorded 2,735
  passing root tests on that commit; later main may differ. Do not treat
  the audit count as a live gate.
- Browser smoke: generated ~24 s PCM fixture, 720p, lyrics off, timeline
  synth muted. Failure exits nonzero. The legacy/gallery suite remains separate
  from the ordinary staged route suite, which uses a 120-second generated
  fixture to leave room for software-GPU startup. Current-route acceptance requires
  advancing decoded audio, matching final capture/presentation generation and
  frame IDs, the requested active backend and all four complete cases.
- WebGL invalid-value/operation, shader/program errors and unexpected native
  context loss fail current-route and visual-evaluation acceptance even when
  Chromium emits a warning. Original severity, message and phase remain in
  diagnostic events. A missing/failed route cannot become a partial pass.
- C01's minimized 90-second tour schedule remains an explicit Node TODO until
  WP03. Its 60/120-second controls and browser route checks are separate evidence.
- World quality: the 80% holdout appeal/timing target in
  [world-quality-evaluation.md](./world-quality-evaluation.md) stays a
  target. `claimed: false` until a revision-tagged holdout sheet exists.
- Section metrics: [analysis-evaluation.md](./analysis-evaluation.md)
  scores a supplied annotated corpus. No revision-tagged held-out music
  result is published in this tree.

## Explicitly unverified

- Real-browser IndexedDB persistence, permission restore, and transaction
  rollback (unit tests use `test/helpers/fakeLibraryIdb.js`).
- Firefox and Safari library/folder restore (README already notes they
  cannot reopen a folder handle alone).
- Maximum-duration export memory on a physical machine. Unit tests can
  cap encoded bytes; they do not measure peak RSS of a 4K take.
- WebGL2 overlay (`?renderer=webgl`) across GPUs.
- Non-Chromium smoke, mobile browsers, and car head-unit hardware
  (`npm run test:car` is local).
- Human world-identity ratings on holdout music. See
  `docs/visual-review-20432ab.md` (removed; see [removed docs](removed-docs.md)).
- Branch-protection settings (the 20432ab audit could not read legacy
  rules; do not infer the default branch is unprotected).

## Adding a gate

1. Give the job a stable `name:` / job id in `.github/workflows/test.yml`.
2. Add a row here with the command, pass bar, and the unverified remainder.
3. Keep `test/validationMatrix.test.js` green — it checks that every job
   id in the workflow is named in this file.
