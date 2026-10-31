# Camera scouting fixes — 2026-10-22

> Historical record. The scope, preservation rules, approval/hold decisions and validation steps below describe this past task, not current development prerequisites. Experiments and local commits follow the [current development policy](experimental-development.md). Recorded results and runtime eligibility remain evidence of the version reviewed.

Implementation follow-up to the [camera scouting audit](camera-scouting-audit-2026-10-22.md),
on base `8a5a1e362e4da2dda21a4cc523909b1eeb0bfda1`. This report describes the
source changes at `f51c27f7855ca6a3f163f77afaee4827438e2973`. Verification results
are recorded below and in [PR #29](https://github.com/aepler315/midio-pixel/pull/29),
which the owner merged into main at `6feed187f7cfe82ff11ec734e784208aabb78f78`
on 2026-10-22. Deployment was not verified. That implementation added no terrain
or shot-library assets and approved no cameras. Its production inventory is
17 entries, including the same
13 approved geographic rails; all 13 regional tour configurations remain
candidates, with no committed shot libraries.

The subsequent [fresh rebuild and app review](scenic-rebuild-review-2026-10-22.md)
adds three sourced geographic candidates and documents additional connectivity,
terrain-presence and status corrections. Those follow-up changes have their own
source, capture and publication identities.

## Discovery and delivery

`generateShots` keeps the existing default forward budget of 48 candidates per
subject. Thinning now shares that budget across move families and viewing
azimuths, includes generated preferred angles first, fills the largest angular
gaps, and favors elevation, distance and direction classes not yet sampled.
Reversible moves still add their reverse candidates later. This corrects early
generation-order bias without raising the candidate cap or proving that the
retained cameras are aesthetically good.

Configured subject `weight` reaches candidates as `subjectWeight` and affects
connected-component choice, shot selection and comparison of winning libraries.
Finite positive weights are clamped to 0.25–4; missing, nonfinite or nonpositive
values use 1. Render, clearance and coverage quality gates remain independent.
`avoid[]` remains unsupported.

The global 60,000,000-byte Range asset ceiling is removed from the Teton builder
and scenic fitter. The Teton builder prints delivery bytes; fitted scenic reports
retain `budget.deliveryBytes` and added bytes. `assetBudgetErrors(root)` has no
default limit; callers can explicitly supply a finite nonnegative `limit`.
Per-region byte, desktop/mobile triangle and forest-build caps remain. Runtime
residency, decoded memory and download/storage cost retain their separate roles.
Catalog tests permit an expanded selection pool rather than fixing a maximum of
18 entries; the current inventory is unchanged. The [expansion proposal](scenic-view-expansion.md)
still requires real sources, fresh builds and review for each added location.

## Separate base and tour approval

Base rail approval stays in `data/terrain/scenic-views.json`. Its reviewed identity
covers terrain, materials, camera and applicable composition, glacier or highway
tour fields. An optional scenic shot library no longer participates in that base
approval. A valid approved base remains available if its optional tour is missing,
stale, malformed or still a candidate. An actual terrain rebake changes the base
identity and still requires base review and re-approval.

A region in `data/terrain/scenic-tours.json` records its own tour metadata:

```text
status: candidate | approved
library: { shotsManifestSha256, terrainManifestSha256, baseViewSha256 }
approval: { date, evidence[], shotsManifestSha256, terrainManifestSha256, baseViewSha256 }
```

`baseViewSha256` hashes the current base approval identities. Publishing a library
verifies its payload and terrain identities, records `library`, marks its tour
candidate and clears any earlier tour approval. `--approve` approves the base
alone; `--approve-tour` requires an already current approved base, verifies the
published library and records its separate evidence and matching hashes. Both
commands require existing evidence files. File existence and explicit promotion
remain distinct from the human judgment of the rendered work.

The generated catalog adds `baseViewSha256` and `shotTour{status, identity,
approval}` beside the existing shot manifest fields. Normal tour playback needs
an approved base and approved tour with matching identities and evidence.
`?rangeShots=all` permits diagnostic candidate playback while retaining identity
checks. The runtime also checks that the loaded library's terrain identity matches
the view. No-library catalog generation preserves the existing 17/13 inventory.

## Review identity

The collector derives expected identity from the actual files under review with
`readReviewLibraryIdentity`. It verifies declared compressed and decoded payload
lengths/hashes, and the actual terrain manifest hash. Each reviewer result must
contain the following shape; the digest placeholders below stand for 64 lowercase
hexadecimal characters:

```text
{
  region: "<viewId>",
  verdict: "good" | "acceptable" | "weak",
  identity: {
    schema: "midio.scenic-review-identity", version: 1,
    manifestSha256: "<digest>", payloadSha256: "<digest>",
    decodedPayloadSha256: "<digest>", terrainManifestSha256: "<digest>"
  },
  provenance: { sourceDigest: "<digest>", capturePath: "<capture path or link>" },
  shots: [{ id: "<shotId>", verdict: "good" | "acceptable" | "weak" | "broken", issue: "<text>" }]
}
```

A current collection needs matching identities and exactly the expected shot set.
Malformed, missing, unknown, duplicate-shot and conflicting results stay visible;
unchanged shot IDs cannot conceal changed camera metadata or payload bytes.
Source digest and capture path are reviewer assertions. The collector records
them but does not authenticate the referenced capture or prove it was rendered
by that source.

`tools/shot-reel.mjs` emits `identity` and `source` in `reel.json`. A reviewer
copies that `identity`, maps `source` to `provenance.sourceDigest`, and records
the reviewed capture path or link in `provenance.capturePath`. The camera and
frame labels use the same timeline factory. At and after the exact final
endpoint, both hold the last shot's end pose.

```sh
node tools/scenic-review-collect.mjs --journal <run>/journal.jsonl --views <viewId> \
  --libraries <tour-directory> --terrain <terrain-directory> --out <run>/review.json
```

`--terrain` defaults to the sibling `terrain` directory of `--libraries`. Pass it
explicitly for staged libraries and terrain kept in different directories. Known
catalog aliases resolve the terrain filename from the catalog's
`terrainManifestUrl`. A custom single-view review can select a file explicitly:

```sh
node tools/scenic-review-collect.mjs --journal <run>/journal.jsonl --views <viewId> \
  --libraries <tour-directory> --terrain-manifest <package.terrain.json>
```

`--terrain-manifest` is rejected for multiple `--views`. The collector reads the
expected hashes itself rather than trusting reviewer hashes as the expected
identity.

## Planning and visible evidence

Cold bend and join measurements run in `shot-worker.js`. The worker returns its
planning tables for reuse by later requests for the same decoded library;
`ShotRuntime` no longer computes those geometry tables while preparing a cold
request on the rendering thread. This removes that synchronous scan, while real
cold-start latency and device frame pacing still require measurement.

Ending search considers every retained outgoing link alternative. A longer or
lower-scored link can be feasible when the shortest or highest-scored link fails
bend, flow or join constraints. Ground-truth payoff hits now require their target
time to lie inside a visible interval, and the reach denominator uses only visible
ground-truth targets. These corrections do not establish a whole-song pacing or
aesthetic verdict.

## Verification

The final Node 24.10.0 suite ran on a byte-verified copy in a path without
spaces: **4,960 tests, 4,943 pass, one failure, 16 skipped**. An unchanged copy
of base `8a5a1e362e4da2dda21a4cc523909b1eeb0bfda1` produced **4,916 tests,
4,899 pass, the same one failure, 16 skipped**. Both fail the sky-pan assertion
at `test/rangeAtmosphere.test.js:213` (“the scene pose drives the pan”). The
candidate adds 44 passing tests; this is not a green full-suite claim. The
skipped cases remain unexecuted. Separate paths avoid the literal `%20` asset
read failures recorded in the original audit; no test-path fix is included here.

Lint, Markdown local-link checks and `git diff --check` pass. Regression logs
record the intended failures before their fixes. Independent code review found
two shared-terrain alias defects, both corrected and independently re-reviewed;
the six targeted alias/explicit-terrain regressions passed in that re-review.

A real headless Chromium 156 module-worker check exercised a 594-link library:
cold requests had no tables, the worker returned cached tables, warm and cold
camera timelines matched exactly, and cancellation returned `AbortError`.
Main-thread timers continued during planning. This verifies the worker boundary,
not physical-device frame pacing or artistic quality.

A separate temporary delivery probe added a sparse 64 MiB file. The resulting
**116,014,590-byte** Range asset tree staged intact, and the default delivery
budget helper returned no errors. The probe file is outside Git; no terrain,
library, approval, regional config or generated catalog was changed by this
implementation. Existing per-region and graphics-budget rejection tests pass.

## Migration and review

1. Run fresh discovery into a new output directory to exercise stratified angles
   and subject weights. `--reselect` reads `graph-cache.json` without generating
   alternatives again; an old graph lacks newly retained cameras and weights.
   Fresh discovery also changes enumeration-based shot IDs: re-check
   `excludeShots` against the new IDs and collect fresh verdicts. Old broken-shot
   exclusions and reviews are not automatically migrated.
2. Review the fitted bytes, including rail parity when terrain changes, before
   publishing with `--publish-from`. Publishing with `--publish` rebuilds and
   does not preserve the exact reviewed artifact by itself.
3. If terrain or another base identity changed, review and approve that base.
   Review the tour separately and promote it only against the current base:

   ```sh
   node tools/build-range-scene.mjs --approve <viewId> --evidence <base-review.md>
   node tools/build-range-scene.mjs --approve-tour <viewId> --evidence <tour-review.md>
   ```

4. Collect fresh results with exact identities and capture provenance. Older
   ID-only journals are intentionally incomplete under this contract. Do not add
   new hashes to old captures without reviewing the matching artifacts again.
   Keep captures outside Git and link retained evidence in the review record.

Tombstone's source-drift gate remains unresolved and its authored rail stays in
place. Long transit, payoff frequency, visible-window pacing, continuous motion
with the matching song, physical-device performance and aesthetic acceptance
remain review gates. The existing historical reels and reported 12-region builds
are not new captures or acceptance of these source changes. Approximately 30
approved geographic locations remains a proposal, not delivered work.
