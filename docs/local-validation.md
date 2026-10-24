# Local validation and publishing

Routine validation runs locally, without GitHub Actions minutes. All test and
visual workflows are manual (`workflow_dispatch`) only; they have no push,
pull-request, schedule, or reusable-workflow trigger. Do not dispatch hosted
validation unless explicitly requested.

Use Node 24 (`.nvmrc`; `.npmrc` sets `engine-strict`, so `npm ci` refuses
other versions) and the locked dependencies. `npm run validate` runs the whole
sequence below, including both browser checks against their own servers on
free ports, and prints a summary to paste into the pull request (the PR
template asks for it). `npm ci` also installs a pre-push hook
(`.githooks/pre-push`, via the `prepare` script) that runs `npm run lint` and
`npm test`; skip it once with `git push --no-verify`.

The individual steps:

```sh
npm ci --no-fund
npm audit --audit-level=high
npm run lint
npm test
npm --prefix ridgeview test
npm run stage:site
```

`npm run test:bootstrap` with no URL serves the source tree, not `_site`, so
point both browser checks at explicit servers. For the source, start `npm start`
(port 8080) in another terminal, then run
`npm run test:smoke -- http://127.0.0.1:8080`. For the staged application, start
a second server on its own port in a third terminal:

```sh
SITE_ROOT=_site PORT=8090 node tools/serve.js
npm run test:bootstrap -- http://127.0.0.1:8090
npm run test:smoke -- http://127.0.0.1:8090
npm run test:routes -- --site-root _site --out .smoke/current-routes
```

`test:smoke` retains gallery/legacy coverage. `test:routes` starts its own
isolated frozen server from staged `index.html` and `src/`; it needs no running
server and exercises ordinary Landscape v2, selected and persisted Tetons, and
Trio upload/play. Its report preserves source/audio identities, actual route,
decoded audio and completed-frame evidence, and browser diagnostics with
severity and phase. Every route must pass. Optional soundfont discovery is
empty. Pass `--audio PATH` for a recording; the default is generated audio.
Use a new output directory for each run. Browser checks are headless. Retain
logs and captures outside Git.

The current-route suite covers startup and observed live playback. It does
not replace the legacy suite's pause/resume/replace/stop coverage or the
specialized seek, export and context-recovery suites. Those transition and
device matrices remain separate completion gates.

`test/tourPlannerRegression.test.mjs` separately characterizes audit C01 using
the published tour package and a minimized role schedule. The 60- and
120-second controls complete; the 90-second desired success is an explicit
TODO until WP03 repairs the planner. It is not a passing playback assertion.

## Publishing

GitHub Pages serves the `gh-pages` branch (repository settings: Pages source
`gh-pages`, `/`). That branch holds only the staged site, never the
repository: until 2026-10-24 Pages built `main` itself, which published every
tracked file (internal docs, tools, data) at supermaudio.com. Publish with:

```sh
npm run validate             # the gate above, on the commit you will publish
npm run publish:site         # stage main, verify, boot headless, push gh-pages
npm run publish:site -- --ref <commit> --dry-run   # build and check only
```

`publish:site` exports the ref with `git archive` (no line-ending conversion,
so pinned bytes are exact), stages it with `tools/stage-site.mjs` (which
verifies the Range runtime, terrain, tour and material pins and writes
`version.json` with the commit), runs the bootstrap smoke against it, and
commits it onto `gh-pages` through a private index; no checkout is touched.
After Pages rebuilds, `https://supermaudio.com/version.json` names the commit.
The Pages build itself runs on GitHub Actions, so it needs a working billing
account; a blocked account leaves the previous deployment live.

The optional manual `static.yml` workflow (artifact-based Pages deployment)
is not the active publisher. Changing workflow triggers does not clear
historical billing-blocked runs.

Visual comparisons retain both commit labels, public digests and working-tree
states. Identical public digests are repeatability checks, even when commits
differ. A changed digest at the same commit is a working-tree comparison.
Only distinct commits with explicit clean states identify a committed source
comparison; missing cleanliness is labeled unverified. All visual verdicts
remain unreviewed until the matching frames and audio have been assessed.

## RTX 3060 rendering checks

```sh
npm run test:gpu
npm run test:gpu -- --audio path/to/song.wav --start-ms 0 --live-seconds 30
```

This local command requires the actual WebGL renderer to contain `RTX 3060` and
rejects software rendering. It captures both Classic and Detailed Landscape
output with a fresh, headless, muted browser and saves a new `.smoke/gpu-*`
report. It never opens a window or report or dispatches a hosted workflow.
Pass `--out DIR` to save elsewhere. The optional live trace is separate from
fixed-clock visual captures; short runs are not a five-minute performance gate.

From WSL it freezes the source and runs native Windows Node/Chrome so WebGL
reaches the desktop GPU. Node and Chrome are found in their standard Program
Files locations; `MIDIO_WINDOWS_NODE` and `MIDIO_WINDOWS_CHROME` can override
these with WSL filesystem paths. On native Windows/Linux, Playwright uses its
local browser or the explicit `--browser` executable. A different renderer
fails the test rather than silently producing software-rendering evidence.

The ordinary Node tests continue to cover logic locally; the GPU command adds
actual hardware rendering, camera, readiness, graphics residency and optional
live-playback diagnostics. Inspect the report's recorded renderer as well as
its pass/fail status. These captures do not imply subjective visual acceptance.
