# Route gate: opt-in hardware-GPU configuration

> Historical record. The scope, preservation rules, approval/hold decisions and validation steps below describe this past task, not current development prerequisites. Experiments and local commits follow the [current development policy](../experimental-development.md). Recorded results and runtime eligibility remain evidence of the version reviewed.

The WP03 follow-up ([report](2026-10-21-wp03-followup-tour-verification.md)) diagnosed the persisted-Tetons `page.screenshot` timeout in the staged four-route gate as a software-rasterizer limit. Under SwiftShader, single tour frames cost 20–50 s of GPU-process time, so the default gate fails intermittently. On the local RTX 3060 the same routes passed. This change adds an explicit, opt-in hardware-GPU configuration to [current-routes-smoke.mjs](../../tools/current-routes-smoke.mjs). The hardware configuration is reported separately, verifies that it really ran on hardware, and leaves the default SwiftShader gate as it was.

Branch: `impl/route-gate-hardware-gpu`. Sole parent: `impl/wp03-followup-tour-verification` at `7b59de6362617154d151f3b3efb6f6ed2336857b`. No application source (`index.html`, `src/`) changed. This branch's staged digest is therefore the follow-up's `99e7db4296f6afefbfb834d3d1fef56e3823e331cf6829652565134941cd10be`. Not merged and not deployed.

## Outcomes

| Item | Result |
| --- | --- |
| Opt-in `--hardware-gpu` configuration | Added. It uses separate flags, labelling and output, records the actual renderer and fails on software, unverifiable or (with `--gpu-match`) different renderers. From WSL it relaunches under native Windows Node and Chromium. |
| Hardware gate, RTX 3060 (one run, commit `46eb4eb`) | **Passed 4/4.** Every Landscape and tour sample, and both browser probes, reported `ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)`. All rows had 0 browser errors and 0 warnings. The staged digest was unchanged and matched the WSL launcher's. The machine was shared with another task's workload and the user's Chrome during the run (section 3). |
| Default SwiftShader gate (one run, commit `46eb4eb`, quiet machine) | **Passed 4/4 in this run.** Both tour rows again showed the diagnosed stall: the first sample came 53.5 s (persisted) and 62.2 s (selected) into the audio, with simulation at 0.12 s. Their screenshots still landed within the 30 s deadline. One pass does not make this gate reliable: the follow-up's final run failed 3/4, and WP01's three runs passed once. It was not rerun. |
| Negative control (WSL Linux Chromium with the hardware flags) | **Failed, as required,** before any route: WebGL2 was unavailable and the renderer was `null`. |
| Tests and lint | Six new tests. `npm test`: 4,872 total, 4,866 passed, 0 failed, 6 GDAL skips. `npm run lint` clean. |
| Default gate | Flags, assertions, fixture and deadlines unchanged. Section 2 lists every change that reaches the default path. |

## 1. The hardware configuration

`--hardware-gpu` selects it. Without the flag the gate keeps its flags, assertions, fixture and deadlines; section 2 lists every change on the default path.

| | Default (`swiftshader`) | Opt-in (`hardware-gpu`) |
| --- | --- | --- |
| Chromium flags | `--mute-audio --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` (unchanged) | `--mute-audio --enable-gpu --ignore-gpu-blocklist`: exactly `route-stall-probe.mjs --hardware-gpu`, and the GPU flags of `landscape-review.mjs --hardware-gpu` (which adds `--autoplay-policy=no-user-gesture-required` and omits `--mute-audio`) |
| Routes, assertions, fixture, 30 s screenshot deadline, 180 s route deadline | unchanged | the same code path |
| Renderer | recorded, not judged | recorded and must be hardware |
| Default output | `.smoke/current-routes-<time>` | `.smoke/current-routes-hardware-gpu-<time>` |
| Report label | `configuration.id: "swiftshader"` | `configuration.id: "hardware-gpu"` |

**Renderer verification.** Every playback sample already reads the unmasked WebGL renderer of the range presentation's own context. In the hardware configuration each Landscape and tour sample must carry a renderer, and it must pass `requireRouteHardwareRenderer`. That check reuses `landscape-review.mjs`'s `requireHardwareRenderer` (which rejects SwiftShader, llvmpipe, softpipe and the word "software") and also rejects Windows WARP (`Microsoft Basic Render Driver`, Chromium's D3D11 software fallback) and the masked `WebKit WebGL` string, which cannot show what rendered. `--gpu-match TEXT` additionally requires that substring, case-insensitively, and is rejected without `--hardware-gpu`. The check runs right after each sample, before the screenshot, so a software renderer fails its row with its own reason instead of a timeout.

**Trio.** Trio draws through Canvas 2D and has no WebGL context, so its samples carry `gpu: null`. That was true in both of the follow-up's reports. Null is accepted only for Trio. Its renderer comes from a browser probe instead: a throwaway WebGL2 context in its own browser context, read once before the routes and once after them. Both probes must pass the same check. A software probe before the routes ends the run without starting any route. The probe after the routes catches a GPU-process fallback during the run. Trio's own Canvas 2D raster path is not inspected directly.

**Run status.** `summarizeConfiguredRun` returns the unchanged `summarizeRouteRun` result for the default configuration. For the hardware configuration it can only turn a pass into a failure: a route-level pass with a software, missing or mismatched renderer anywhere (either probe or any non-Trio sample) is `failed`. Neither configuration can turn a failed route into a pass.

**Native Windows from WSL.** WSL's Linux Chromium cannot reach the desktop GPU (see the control in section 3). Under WSL, `--hardware-gpu` therefore relaunches the gate the way [gpu-review.mjs](../../tools/gpu-review.mjs) does, through the new [windows-node.mjs](../../tools/lib/windows-node.mjs):

- native Windows Node (`MIDIO_WINDOWS_NODE`, default `/mnt/c/Program Files/nodejs/node.exe`);
- a `--import` loader hook that resolves the WSL-installed `playwright` package (dependencies are symlinked to a Linux checkout);
- a Windows Chromium given by `--browser` or `MIDIO_WINDOWS_CHROME`. There is no built-in default, so the build is always explicit;
- path options translated with `wslpath -w`, and SIGINT/SIGTERM forwarded.

The Windows child writes `report.json` and its exit code becomes the launcher's. The default configuration never relaunches.

**Checkout identity.** `checkoutIdentity()` no longer throws. Windows Git cannot follow a worktree created from WSL (its `.git` file names a `/mnt/c/...` gitdir). In that case the report records `commit: null, dirty: null, identity: "unavailable", authoritative: "staged digest"` and Git's own reason. The WSL launcher then writes `launcher.json` next to the report. It holds the WSL checkout identity, the staged digest before and after the run, the Windows arguments and the child's exit code. It requires the child's reported digest to equal both, and otherwise fails the launch.

## 2. What did not change in the default gate

Unchanged between `7b59de6` and the code commit `46eb4eb`:

- `playbackSample` (byte-identical; SHA-256 of the function text `518b33e3…` in both), which `route-stall-probe.mjs` also imports.
- `tools/lib/current-route-evidence.mjs`, so `validateRoutePlayback` and `summarizeRouteRun`; `index.html` and `src/`.
- The SwiftShader flag list (now the frozen `SWIFTSHADER_ARGS`; a test pins it with `deepEqual`), the 30 s page default timeout that bounds `page.screenshot`, the 180 s route deadline and its blocked-renderer handling, the fixture arguments (`gen-test-wav.mjs … 120 120`) and every route step.
- Every hardware check is guarded by `configuration.hardwareRequired`, and `summarizeConfiguredRun` returns `summarizeRouteRun` unchanged for the default configuration.

Changes that do reach the default path:

| Change | Effect on a default run |
| --- | --- |
| `checkoutIdentity()` no longer throws | Under WSL, Git works and the report records `commit` and `dirty` as before. Where Git cannot read the checkout, the run now continues with `identity: "unavailable"` and the reason, instead of ending with `report.failure`. This is provenance, not acceptance; the staged digest is still required and still checked for change during the run. |
| Argument parser | Options are parsed one at a time so that `--hardware-gpu` can stand alone. A value starting with `--` is now rejected (previously `--out --x` wrote to `--x`). `--browser FILE` is accepted in both configurations and overrides `PLAYWRIGHT_CHROMIUM_PATH`. |
| Additive report and console output | `report.configuration` (id, label, launch args, executable, platform, Node, renderers), `row.renderer`, a `Configuration:` console line, and `(swiftshader)` in the final assertion message. |
| Imports | `landscape-review.mjs` (for `requireHardwareRenderer`) and `lib/windows-node.mjs` now load on the default path. Both are main-guarded and have no import-time side effects. |

## 3. Gate runs

Both runs used commit `46eb4eba2ced4e1121e5bea99d2a84eb005f6362` with a clean worktree, the staged artifact `99e7db42…` (unchanged during each run), the generated 120 s fixture (SHA-256 `0bbee2957cc72a3e4214a84c3bb67dac20871f9796be0e43014fc2da7224be85` in both reports, the same fixture as the follow-up), Chromium 153.0.8010.12 (revision 1243 on both sides), headless and muted, and the unchanged 30 s screenshot and 180 s route deadlines. Each configuration ran once. This document's commits, and the comment-only commit `ea8ef16` before it, change no code that ran.

### Hardware configuration, RTX 3060

Command: `node tools/current-routes-smoke.mjs --hardware-gpu --gpu-match "RTX 3060" --browser /mnt/c/Users/aeple/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe --site-root _site --out .smoke/route-gate-hw-rtx3060`, from WSL (Node v24.10.0). It relaunched under Windows Node v25.9.0, Windows Chromium 1243 and NVIDIA driver 610.88. It ran 02:55–02:57 local time.

| Row | Status | Renderer | First sample (audio / sim / frame) | Second sample |
| --- | --- | --- | --- | --- |
| landscape | passed | RTX 3060, D3D11 | 0.51 s / 0.06 s / 7 | 1.85 s / 1.69 s / 25 |
| tour-selected | passed | RTX 3060, D3D11 | 8.99 s / 0.07 s / 5 | 21.35 s / 12.65 s / 12 |
| tour-persisted | passed | RTX 3060, D3D11 | 7.94 s / 0.12 s / 5 | 21.03 s / 9.50 s / 11 |
| trio | passed | none of its own (Canvas 2D); probes RTX 3060 | 0.07 s / 0.08 s / 2 | 1.17 s / 1.13 s / 32 |

- **Browser probes.** Before and after the routes: `ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)`. `configuration.renderers` lists only that string.
- **Diagnostics.** 0 browser errors and 0 warnings in every row.
- **Identity.** The Windows child recorded `identity: "unavailable"` (`fatal: not a git repository: (NULL)`). `launcher.json` records the WSL checkout `46eb4eb` with an empty `dirty`, the staged digest `99e7db42…` before and after, the child's matching digest (`sameStagedSource: true`) and exit code 0.
- **Contention.** Another, unrelated Codex task (`2026-10-21/make-these-changes-to-after-hours`) was running a full `node --test` suite and a SwiftShader `visual-evaluate.mjs` in WSL, both started at 02:52–02:53. They overlapped this whole run, with WSL load about 10 at 02:58. Just after the run (02:58:43), the user's own Google Chrome GPU process, running since 23:22 the previous evening, was observed at 98% of the GPU's SM time. The tour rows' pacing reflects this. Their first samples came 8–9 s into the audio, and only 6–7 frames were presented over the next 12–13 s. In the follow-up's hardware probe, which ran with no other workload, the first tour sample came 0.1 s into the audio and 45 frames followed within 1.2 s. The two are not a like-for-like comparison. Acceptance does not depend on pacing, and the snapshot is retained (`.smoke/route-gate-hw-rtx3060-contention.txt`).

### Default configuration, SwiftShader

Command: `PLAYWRIGHT_CHROMIUM_PATH=…/chromium-1243/chrome-linux64/chrome node tools/current-routes-smoke.mjs --site-root _site --out .smoke/route-gate-swiftshader`, in WSL with Node v24.10.0. It started at 03:14:08 after waiting for the other task's suite and evaluation to finish (load 0.32 at start). A 15 s sampler saw no other GPU process, test suite or evaluation during the run; load rose to 6–7 from the run itself. Two earlier launch attempts of the wrapper script failed on Git Bash/WSL path handling before the gate started. Neither created an output directory or started a browser.

| Row | Status | Renderer | First sample (audio / sim / frame) | Second sample |
| --- | --- | --- | --- | --- |
| landscape | passed | SwiftShader (Vulkan, Subzero) | 2.51 s / 0 s / 6 | 7.52 s / 5.02 s / 11 |
| tour-selected | passed | SwiftShader | **62.21 s / 0.12 s / 5** | 64.39 s / 63.28 s / 10 |
| tour-persisted | passed | SwiftShader | **53.48 s / 0.12 s / 5** | 55.73 s / 54.57 s / 10 |
| trio | passed | none of its own | 0.33 s / 0.30 s / 3 | 1.42 s / 1.39 s / 34 |

All rows had 0 browser errors and 0 warnings. `report.configuration.id` is `swiftshader`, and the recorded launch arguments are the unchanged SwiftShader list. The identity is the WSL checkout `46eb4eb`, clean. The bold first samples are the follow-up's stall signature: the simulation stands at its first frames while the audio runs a minute ahead. In this run the screenshot came after the queued GPU work had drained. In the follow-up's final run it did not. Whether the gate passes still depends on where the screenshot lands in that cycle, so this pass is one sample of an intermittent gate, not a fix.

### Negative control: hardware flags without a hardware GPU

`runCurrentRoutesSmoke({ hardwareGpu: true, gpuMatch: 'RTX 3060' })` ran in-process in WSL with Linux Chromium 1243, where no GPU is reachable and the hardware flags do not enable SwiftShader. The browser probe found no WebGL2 (`null`). The run stopped before any route with `Hardware GPU unavailable: null`, status `failed` and exit code 1 (`.smoke/hw-control-wsl-linux`). It ran before the code commit, on `7b59de6` with the then-uncommitted files listed in its `dirty` field. The tool files did not change between that run and `46eb4eb`. This shows end to end that a missing renderer is rejected. Rejection of a SwiftShader or WARP renderer string is covered by the unit tests (section 4), not by a browser run.

## 4. Tests

[currentRoutesHardwareGpu.test.mjs](../../test/currentRoutesHardwareGpu.test.mjs) adds six tests:

- **Argument parsing.** The existing options map as before. `--hardware-gpu` is a standalone flag. `--gpu-match` without `--hardware-gpu`, a missing value, a value that is another option, and unknown options all throw.
- **Flag selection.** The default list is pinned verbatim with `deepEqual`, and so is the hardware list. Mutating a returned configuration cannot change `SWIFTSHADER_ARGS`. `--gpu-match` without hardware is rejected, and executable selection follows `--browser`, then `PLAYWRIGHT_CHROMIUM_PATH`, then Playwright's default.
- **Software-renderer rejection.** The check uses the verbatim SwiftShader and RTX 3060 renderer strings from the follow-up's reports. It accepts the RTX 3060 string and rejects SwiftShader (both spellings), WARP, llvmpipe, the masked `WebKit WebGL`, empty, `null` and `undefined`, plus a `--gpu-match` mismatch.
- **Run status.** A hardware run whose four rows all passed playback is `failed` in each of these cases: software app contexts, a software probe, a fallback between the two probes, a missing probe, a mismatched GPU, or a non-Trio row with a null renderer. Trio with a null renderer passes, and Trio with SwiftShader fails. The default configuration still returns `passed` for SwiftShader rows. Neither configuration passes a failed route.
- **Identity.** A directory outside Git yields `identity: "unavailable"` with a reason, instead of throwing.
- **WSL paths.** Windows and UNC paths are kept, and Linux paths are translated.

The existing blocked-renderer deadline test (`currentRoutesSmoke.test.mjs`) still drives the default CLI end to end. It ran, rather than skipped, because `PLAYWRIGHT_CHROMIUM_PATH` pointed at the installed Chromium 1243. Playwright 1.64 otherwise expects revision 1248, which is not installed in WSL.

| Check (WSL, Node v24.10.0, GIT_* cleared) | Result |
| --- | --- |
| Focused: the new file plus `currentRoutesSmoke`, `currentRouteEvidence`, `gpuReview`, `landscapeReview` | 23 passed, 0 failed, 0 skipped |
| `npm test` | 4,872 total: 4,866 passed, 0 failed, 6 skipped (GDAL), 0 TODO. The follow-up's 4,866 total plus the six new tests. |
| `npm run lint` | clean; `git diff --cached --check` clean |

The tests and lint ran on the working tree just before `46eb4eb` was committed. The tool and test files did not change between that run and the commit; only `docs/local-validation.md` was edited in between.

## 5. Limitations

- **The default gate is not fixed.** The hardware configuration is an additional, separately labelled result. Making the SwiftShader gate reliable still needs a cheaper tour workload under software rendering (WP08) or a decision to rely on hardware evidence. Neither is made here.
- **One machine.** The hardware evidence comes from one RTX 3060 with driver 610.88 and D3D11 ANGLE on Windows. It is integration evidence for a few seconds of playback per row, not a performance benchmark, and it says nothing about integrated or mobile GPUs.
- **Node version.** The Windows child ran on Windows Node v25.9.0, outside the pinned 24.x. The WSL launcher, the tests and the SwiftShader gate used v24.10.0.
- **Contention.** The hardware run shared the machine with another task's workload and the user's Chrome (section 3). Its pacing figures are not a clean measurement. Acceptance does not depend on pacing.
- **Trio.** Trio's renderer is attributed through the browser probes, not through its own context. Its Canvas 2D raster path is not inspected.
- **Pattern-based detection.** Software detection matches renderer strings. It covers SwiftShader, llvmpipe, softpipe, "software", WARP and the masked string. A software rasterizer reporting an unknown name would not be caught; `--gpu-match` narrows that risk.
- **Screenshot latency.** The gate does not record it, so no screenshot timings are quoted for these runs. The follow-up's probe measured them.

## Follow-ups (not done here)

- `landscape-review.mjs`'s `requireHardwareRenderer`, and therefore `npm run test:gpu`, does not reject WARP or the masked renderer string. The route gate adds both; the review could adopt the same check.
- `gpu-review.mjs` still carries its own copy of the loader and child-process code now in `lib/windows-node.mjs`.

## Reproduction

```sh
npm run stage:site
# Default SwiftShader gate (WSL; Chromium 1243 as in prior suites)
PLAYWRIGHT_CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
  node tools/current-routes-smoke.mjs --site-root _site --out .smoke/route-gate-swiftshader
# Opt-in hardware gate (from WSL: relaunches under native Windows Node and Chromium)
node tools/current-routes-smoke.mjs --hardware-gpu --gpu-match "RTX 3060" \
  --browser /mnt/c/Users/<user>/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe \
  --site-root _site --out .smoke/route-gate-hw-rtx3060
node --test test/currentRoutesHardwareGpu.test.mjs test/currentRoutesSmoke.test.mjs
```

Reports, PNGs, logs, launcher records and contention snapshots stay outside Git under ignored `.smoke/`. Publication is a branch candidate, separate from merge and deployment.
