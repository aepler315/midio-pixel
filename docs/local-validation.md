# Local validation and publishing

Routine validation runs locally, without GitHub Actions minutes. All test and
visual workflows are manual (`workflow_dispatch`) only; they have no push,
pull-request, schedule, or reusable-workflow trigger. Do not dispatch hosted
validation unless explicitly requested.

Use Node 24 and the locked dependencies:

```sh
npm ci --no-fund
npm audit --audit-level=high
npm run lint
npm test
npm --prefix ridgeview test
npm run stage:site
npm run test:bootstrap
```

For upload and playback, start `npm start` in another terminal, then run
`npm run test:smoke -- http://127.0.0.1:8080`. Repeat against a server with
`SITE_ROOT=_site` to check the staged application. Browser checks are headless.
Retain logs and captures outside Git.

The active publisher is GitHub's branch-based Pages build and deployment,
confirmed on main at commit 9a500dfbb07b3f389c4efae47f8a30e3b9cce4ac. It is
independent of the Test workflow. Keep repository Pages settings unchanged.
The optional manual `static.yml` workflow stages and publishes without calling
test workflows or installing Chromium; run the checks above locally first.
Changing workflow triggers does not clear historical billing-blocked runs.

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
