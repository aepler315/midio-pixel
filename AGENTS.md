# Midio Pixel engineering

Music constructs cinematic pixel landscapes from geographic terrain. Current
source and the current task govern implementation; [experimental development](docs/experimental-development.md)
authorizes deliberate evolution. Older plans and review holds describe their own
revisions. Start with [architecture](docs/architecture.md), [visual contract](docs/visual-contract.md)
and [performance budget](docs/performance-budget.md). Reconnaissance anchor:
`58454dd` (2026-11-13); recheck Git before relying on it.

## Navigate

- `src/main.js`: boot, upload/analysis adoption, live/export frame loops and UI.
- `src/audio/`, `src/core/`, `src/sim/`: analysis, transport, song timing, simulation.
- `src/world/BiomeManager.js`, `src/world/alpine/`: Landscape score, growth,
  cameras, RangePresentation, RangeScene, terrain/forest/water/sky/mist.
- `src/world/terrain/`, `src/assets/range/v2/`, `tools/terrain/`: source profiles,
  scene/massif catalogs, offline terrain packages and provenance.
- `src/render/`: presentation, native pixel grids, governor and graphics ledger.
- `test/`, `tools/`, `.github/workflows/`: Node contracts, real browser probes,
  profiling and CI. `ridgeview/` is a separately tested viewer.

## Commands (Node 24.x, see .nvmrc)

```sh
npm ci --no-fund
npx playwright install chromium             # once, for isolated browser tools
npm run dev                                # http://localhost:8080
npm run lint
npm test                                   # full application Node suite
npm --prefix ridgeview test
npm run check:modules
npm run stage:site                         # production build: _site, verifies pins
npm run validate                           # comprehensive existing local sequence
npm run verify:visual:capture -- --out .smoke/candidate
npm run verify:visual -- --baseline REFERENCE --candidate .smoke/candidate --out .smoke/diff
npm run bench:engineering -- --out .smoke/bench
npm run bench:engineering -- --out .smoke/bench-after --baseline .smoke/bench/report.json
npm run review:landscape -- --out .smoke/motion --grid both --no-mp4
```

Output directories must be new. Set `PLAYWRIGHT_CHROMIUM_PATH` for an installed
Chromium. Existing hardware probes: `npm run test:gpu`, `tools/range-device-probe.js`;
expensive cost tools: `tools/range-frame-cost.mjs`, `tools/range-prepare-cost.mjs`.
See [verification usage](docs/verification.md) for approvals, CI tiers and failures.

## Preserve and verify

- Keep geographic provenance, source lattice, ridge/spur structure, coherent
  metres and shared CPU/GPU deformation. Catalog geography differs from composed
  artworks; label placement/relief changes honestly.
- Current Look is Cinematic, terrain grids are pixelated, sky is deliberately
  smooth, pixel scaling is Uniform. Depth, Pixel/Palette looks, video recording
  and old cast/performer features are retired. Do not resurrect them from old docs.
- Heard song time controls construction, camera and weather. Seek/replay and late
  analysis must reconstruct consistent states. Preserve fallback on denied assets,
  shader failure, cancelled generations or memory admission; no blank active scene.
- Admit allocations before construction. JOYING JY-UTS18N12 is the minimum intended
  target; mobile residency is 320 MiB or 192 MiB under low/unknown mobile memory.
  Never substitute Node/SwiftShader timings for physical-device evidence.
- Inspect existing implementations first. Define observable acceptance criteria,
  make focused changes, test behavior, render visual changes, benchmark relevant
  costs, investigate failures, and review the final diff. Required evidence depends
  on the change; an unavailable device does not block independent implementation.
- Independent verification means observable tests/renders/measurements beyond the
  author's assertion. Use a fresh reviewer when available; report a self-review as
  such. Failed, skipped and unrun checks must remain distinct.

## Work and deliver

Use a feature branch; preserve unrelated work. Commit focused changes with useful
messages. PRs state behavior, checks actually run, references/artifacts, performance
scope, limitations and next steps ([template](.github/pull_request_template.md)).
Never merge, deploy, expose credentials or alter unrelated repositories without
explicit authorization. Routine implementation, experiments, tests, bounded local
captures and reversible fixes are autonomous. Escalate missing consequential
product decisions, destructive operations and genuinely unavailable credentials.

Definition of done: the requested behavior is implemented; relevant tests, lint,
production staging, render review and benchmark comparisons are executed or
precisely marked blocked; failures are investigated; the diff is reviewed; the PR
contains evidence and remaining gaps. A changed image never auto-approves itself.
Keep captures under `.smoke/` or CI artifacts; small deliberately approved visual
references may live in `test/fixtures/verification/baseline/`. Respect pins,
licenses, attribution and `.gitattributes`.

Full lifecycle: [agent workflow](docs/agent-workflow.md). Interrupted work:
[handoffs](docs/handoffs.md). Model-independent exercises: [evaluations](docs/agent-evaluations.md).
Consequential choices: [decisions](docs/decisions/README.md).
