# WP02 implementation: preserve library metadata and folder identity

> Historical record. The scope, preservation rules, approval/hold decisions and validation steps below describe this past task, not current development prerequisites. Experiments and local commits follow the [current development policy](../experimental-development.md). Recorded results and runtime eligibility remain evidence of the version reviewed.

Date: 2026-10-20. Base: `cace36893003e4161b243f22a69204be17181df6` (`main`). Branch: `impl/wp02-library-integrity`.

This change implements the requested WP02 scope: incomplete-scan metadata preservation (C02), stale-prune protection (C03), and concurrent folder identity reservation. It includes defensive selection, initialization and permission ownership checks related to C05. The [consolidated audit](2026-10-20-astra-sol-consolidated-audit.md) remains the historical account of the original evidence; its findings are not silently rewritten as implementation claims.

## Result and verification map

| Problem | Result | Verification |
| --- | --- | --- |
| A listed file cannot be opened, a directory cannot be enumerated, or a depth limit is reached | Mark traversal incomplete; retain old rows and their history; commit readable siblings; suppress pruning | Scanner and service regressions; native OPFS `getFile()` and iterator failures; synchronous enumeration failure |
| Reading tags fails and returns empty guesses | Report `tag-read` and omit that fresh record; retain the prior metadata | Scanner and service regressions |
| A healthy traversal proves a file is gone | Prune only after complete traversal and committed batches, under current durable ownership | Service regression and native healthy-deletion control |
| Old read / new write / old delete transaction schedule | Direct prune reads and deletes under one write lock; service prune additionally checks the durable scan revision | Deterministic unit schedule and native transaction queue regression |
| A scan is superseded in another instance, canceled while queued, or finishes after forget | Reject/abort stale batches and pruning; a removed root cannot acquire orphan scan rows | Unit and native instance, queue, removal and late-abort regressions |
| A stale instance starts scanning after another folder reuses its old root ID | Compare the captured root identity before issuing any new scan token | Unit and native late-start-after-ID-reuse regressions; unchanged legacy identity control |
| Concurrent unrelated folders have the same display name | Reserve distinct root IDs atomically; no row collision or history overwrite | Unit races and actual two-page browser import tests, followed by page reload |
| Concurrent handles identify the same physical directory | Recompare identity after conflicting reservations and converge on one root | Unit identity tests and native OPFS handle structured-clone/reload control |
| An older picker or permission result resolves after selection/forget | Check local operation generation before publishing; abort pending identity writes | Service regressions, including forgotten-root permission completion |
| IndexedDB opens but root writes fail | Keep actual files/handle playable under an explicit session root; mark session edits unsaved; write no orphan rows | Unit regression and native transaction-abort tests for both import paths |

Source audio is never rewritten by these changes. This fixes library records and scan ownership.

## Ownership and completion contract

[LibraryScanner](../../src/library/LibraryScanner.js) retains its existing return shapes: `scanDirectory` returns an array and `scanFileList` returns `{ tracks, handles }`. Both accept `onIssue({ kind, path, message })`. Directory failures, file failures, tag-read failures, depth limits and cancellation make the traversal incomplete. Intentional hidden/excluded-directory and non-audio skips are still normal exclusions. Readable sibling directories continue after one child fails. Caller callback errors continue to propagate rather than being reclassified as filesystem failures.

[MusicLibrary](../../src/library/MusicLibrary.js) shares one scan orchestration path for handle and FileList imports. Its `scanResult` records `{ complete, stored, stale, issues }`: `complete` describes readable traversal; `stored` describes successful durable scan writes/prune; `stale` records rejected ownership. A readable session-only scan can be complete with `stored: false`. The view retains prior rows during an incomplete or failed save and publishes committed merged rows as new batches arrive. A readable complete scan still removes genuinely absent paths.

[LibraryDB](../../src/library/LibraryDB.js) adds three guarded operations:

1. `beginRootScan(rootId, scope, { signal, expectedRoot })` checks the remembered root identity and writes a fresh opaque revision atomically. It reports `committed` with a token, or `missing`, `stale`, or `unavailable`.
2. `putScanTracks(token, tracks, scope, { signal })` reads the root revision and existing metadata, merges and writes the batch inside one transaction covering roots and tracks. It returns committed merged rows only after transaction completion.
3. `pruneScanTracks(token, keepPaths, scope, { signal })` checks the same root/revision and reads/deletes candidates inside one transaction. The service only invokes it after an issue-free traversal with every batch committed.

Abort signals apply to queued and active transactions. Request success is provisional: a later transaction abort returns failure, rolls back queued writes, and cannot authorize pruning. Unique scan revisions protect already-issued tokens across removal and legacy ID reuse. The captured identity comparison also protects a stale caller that had not yet obtained a token when removal/replacement occurred. An unchanged legacy root without an identity revision is accepted; a newly adopted/reselected identity has a fresh revision.

`addRoot` performs asynchronous `isSameEntry` comparisons outside transactions. It then checks that the complete identity snapshot still matches under a write lock and reserves the ID in that same transaction. A competing reservation causes a retry. Root reselection preserves existing scan revisions and unknown root fields. Track carry-forward preserves unknown earned fields as well as play history and decoded duration. Filesystem fields and successfully read file tags retain their existing authority.

The older low-level `putTracks` / `pruneTracks` APIs remain for compatibility and controlled imports/tests. They do not provide scan ownership by themselves. Application scan paths use the guarded protocol. Direct pruning no longer separates its read and delete transactions.

## Database compatibility and remaining scope

The database version changes from 1 to 2 as an additive compatibility fence. No store, key, root ID or track row is rewritten or deleted during upgrade. Native tests seed a real v1 database, upgrade it, and verify the original roots and earned metadata. Once upgraded, an older client requesting version 1 receives `VersionError`, preventing it from reopening and applying the old unguarded prune path.

An already-open legacy connection can block the upgrade until that tab closes or reloads. During an unavailable/blocked open, a new selection can still be used for the session. A late successful open after the caller has already received the unavailable result is closed; a subsequent native version-3 upgrade verifies that it does not leak a blocking connection. Rolling back to v1 application code does not downgrade the database: that older library path becomes unavailable rather than deleting or rewriting v2 data. The version fence is therefore a compatibility tradeoff, not a claim of reversible database version numbers.

This work does not implement C04's separate explicit reconnect flow for `webkitdirectory` history. A FileList has no durable proof that a new pick is the same physical folder. Repeated FileList imports continue to receive distinct roots; matching only a display name would merge unrelated libraries. Existing fragmented roots are retained. A future reconnect UI must explicitly choose an existing root and validate its files before reusing its history.

There is no live cross-tab listing broadcast. Durable ownership and reload convergence are covered; a superseded tab can retain a stale/empty view until refresh. The C05 initialization guard is defensive hardening, not a claim that the original unconfirmed native startup race was reproduced.

## Regressions and reproducibility

Use Node 24 and install the existing development dependencies. The maintained native test is available as:

```sh
npm run test:library-integrity -- --out .smoke/wp02/report.json
```

Set `PLAYWRIGHT_CHROMIUM_PATH` when Chromium is outside Playwright's default location. For comparison against an earlier checkout:

```sh
node tools/library-scan-integrity-smoke.mjs --source /path/to/earlier/checkout --out .smoke/wp02-before/report.json
```

The tool freezes all six source modules in its import graph before serving them and records SHA-256 hashes. It uses actual browser IndexedDB transactions and legal keepalive request chains; it does not postpone or replace request callbacks to invent an impossible queue ordering. Every case uses an isolated context and loopback origin. Two-tab tests use independent pages and perform an actual coordinator page reload before durable readback. Synthetic files and disposable OPFS directories avoid user folders and user audio.

The native directory-handle control uses a fresh temporary persistent profile because Chromium 153 crashes while storing an OPFS handle in IndexedDB in an incognito context. The temporary profile is removed after the case. Other cases use fresh incognito contexts. Tests run headlessly and with audio muted.

The original-source native comparison reproduced eight failures: unreadable-file metadata deletion, synchronous enumeration deletion, native iterator failure clearing the service view, stale pruning, queued-prune cancellation, a superseded instance replacing newer rows, post-forget orphan rows, and concurrent same-name FileList collisions. Three passing controls covered sequential same-name imports, different-name concurrent imports, and the same native physical directory. Review then added three failing candidate regressions: session fallback after failed root writes for both import paths, and a fresh stale scan after root-ID reuse. Those cases pass with the final guards. A focused service test also reproduced the old permission-completion null dereference before its guard was added.

The unit IndexedDB double now serializes transactions, stages private snapshots and publishes only on commit; abort discards writes. Native checks separately validate behavior that a double cannot establish.

Final verification results are recorded below. Captured logs and browser reports remain outside Git under ignored `.smoke/` and the task evidence archive; this branch commits reproducible tests and the implementation record, not captured runtime artifacts.

| Check | Final result |
| --- | --- |
| Focused library unit tests (`libraryDb`, `libraryScanner`, `musicLibrary`) | 104 passed, 0 failed |
| Native scan-integrity suite, Chromium 153.0.8010.12 / Node v24.10.0 | 22 passed, 0 failed, 0 page errors; source digests matched final files |
| Existing native transaction/rollback smoke | 16 passed, 0 failed; all opened connections closed |
| Independent review | Both reproduced candidate findings closed; five targeted regressions independently passed; no remaining blocker in reviewed scope |
| Repository test suite | 4,840 total: 4,832 passed, 0 failed, 8 skipped (6 GDAL; 2 browser checks covered separately below) |
| Supplemental rendered-star and shader browser tests | 2 passed, 0 failed, 0 skipped with explicitly selected Chromium |
| Repository ESLint | Passed, 0 errors |
| `git diff --check` | Passed |

The browser evidence covers Chromium with native IndexedDB and OPFS fixtures. It does not establish Firefox/WebKit behavior, real folder-picker permission UX, physical-device performance, or application visual acceptance. The six GDAL-dependent tests require Python GDAL bindings unavailable in this environment. This branch is an implementation candidate; publication is separate from merge and deployment.
