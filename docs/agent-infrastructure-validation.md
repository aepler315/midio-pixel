# Infrastructure implementation validation — 2026-11-13

Base: `58454dd93e6919c591835f6ccc0edefa02888f49` (main, after #132).
Feature branch: `feat/agent-engineering-infrastructure`. Current Git/PR is the
source of truth. No application `src/` files changed. No merge or deploy performed.

## Executed checks

- Installation: `npm ci --no-fund`, Node 24.22.1, Linux x64.
- `npm run lint`: passed, including the new harness and tests.
- `npm run check:modules`: passed, 457 source modules parse/link.
- `npm run stage:site`: passed, public application staged and pinned assets checked.
- `npm --prefix ridgeview test`: 26 passed, no failures/skips.
- New `node --test test/engineeringVerification.test.mjs`: 10 passed. Tests cover
  threshold/SSIM/edge change, malformed or absent identities, unsafe IDs,
  real PNG corruption/diffs, refused overwrites, handoff state drift,
  current scenario contracts, all evaluation paths, explicit CI pipefail and
  complete geometry/culling/seam signatures.
- Initial unmodified-source `npm test`: **5,585 tests, 5,571 passed, 13 skipped,
  1 failed**, duration 435.3 s. Failure: `test/shotPlanner.test.mjs:190`,
  “an 18-shot library and a 3-minute song plan in under 50 ms” (865 ms test
  duration on this run). Its existing 50 ms assertion was not weakened.
- Final full-suite results are recorded below after completion.
- `npm run eval:agents -- --task safe-modification --out .smoke/engineering/evaluation-rehearsal`:
  all three selected test files passed. This rehearsed the evaluation runner;
  no model assignment was performed or scored (`score: null`).
- YAML parse, new-doc relative link audit and `git diff --check`: passed.

## CPU surrogate results

Two sequential runs of the candidate harness: clean main worktree, then candidate
working tree, same Node/host/fixture and verified Teton asset. All eight output
checksums matched; the same-runner comparison passed its explicit +100% plus 5 ms
noise allowance. This infrastructure change makes no performance-improvement claim.
The full application suite was also active on the host, so timings include shared
host noise. The memory snapshots do not establish a leak or device residency.

Environment: AMD EPYC 9V74, 9 reported logical CPUs, Node 24.22.1, Linux x64.
Seven measured iterations after two warmups per scenario. Geometry signatures
include every returned band field, including seam/culling/rail/tour metadata.

| Scenario | Base median ms | Candidate median ms | Candidate p95 ms |
|---|---:|---:|---:|
| terrain-mobile-bias1 | 56.317 | 44.530 | 55.842 |
| terrain-mobile-bias2 | 16.909 | 12.912 | 27.159 |
| terrain-desktop-bias1 | 109.713 | 75.042 | 100.499 |
| terrain-desktop-bias2 | 21.625 | 21.775 | 33.007 |
| score-compile-and-sample | 0.453 | 0.367 | 0.744 |
| camera-growth-updates | 0.896 | 2.575 | 6.510 |
| quality-grid-transitions | 0.027 | 0.026 | 0.178 |
| geographic-height-sampling | 0.092 | 0.092 | 0.158 |

Raw compact results, checksums, memory snapshots, source states and deltas:
[2026-11-13-engineering-cpu.json](verification-records/2026-11-13-engineering-cpu.json).
Initialization was 178.63 / 94.37 ms
(base/candidate), including local I/O/decode/verification; this is one cold-load
sample, not a distribution or scene GPU initialization measurement. No GPU time,
physical-display FPS or JOYING hardware was measured.

## Visual execution and exact blocker

`PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium npm run verify:visual:capture -- --out .smoke/engineering/candidate`
was attempted with Chromium 156.0.8078.79. Chromium exited before app rendering:
`process_singleton_posix.cc`, `socket() failed: Operation not permitted (1)`.
The command sandbox denies the required local socket. The request to run the
isolated capture outside that sandbox was rejected automatically because sandbox
approvals are disabled. `npx playwright install chromium` also failed with an
invalid/truncated ZIP; the default Playwright executable therefore remains absent.
These are environment failures, not rendered application regressions.

Failed `report.json` and launch logs remain under `.smoke/engineering/`. A comparison
against the failed/unapproved capture failed nonzero and retained its error summary.
A standalone synthetic PNG tooling rehearsal exercised explicit approval, changed
image comparison and generated before/after/difference reports; the difference
image was opened and inspected. Those pixels test the tool only and are **not**
Midio output. No application image was approved, inspected or claimed to pass.

The PR workflow implements a matching clean-base/candidate capture and comparison
on hosted Chromium. Its reference is explicitly an approved-source comparison,
not owner-approved pictures. Hosted results must be checked on the PR; adding a
workflow is not evidence it ran. Once a browser-capable environment is available,
run both captures, inspect actual pictures/consecutive motion and explicitly approve
any image baseline. JOYING performance and listening/artistic review remain open.

## Independent review and fixes

A separate read-only reviewer examined the complete infrastructure. Four findings
were fixed, each with a reproducing failing test followed by a passing regression:
CI `tee` masking failures, incomplete geometry signatures, incomplete benchmark
identities/duplicate IDs, and unsafe frame IDs. Lint and the 10-test verification
suite passed after fixes. No outstanding reviewer findings were deferred.

The user's current assignment explicitly authorizes PR delivery despite unavailable
hardware/services. Existing baseline timing failure is reported rather than hidden;
no default-branch merge or production deployment is part of this change.
