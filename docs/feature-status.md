# Feature status

Candidate branch: `codex/finish-midio5-plan`
Functional candidate: this document's containing commit
Checked: 2026-09-22

| Area | State | Evidence | Remaining limitation |
| --- | --- | --- | --- |
| Bootstrap | Implemented, mechanically validated | Missing `BulkExport.js` import removed; `test:bootstrap` added; module resolution reaches browser globals; lint and unit suite pass | Playwright browser binary was unavailable locally; CI must execute the chooser probe |
| Production artifact | Implemented, mechanically validated | `stage:site` has an allowlisted output and destructive-overlap tests; Pages validates and uploads the same staged directory | Repository Pages settings must still be checked to ensure no separate branch publication path exists |
| URL ingestion | Wired into CI | Existing `test:urlload` now runs in browser CI | Fermata/head-unit behavior still requires the actual device |
| Music library | Implemented, mechanically validated | Session records survive unavailable storage; writes wait for transaction commit; same-name roots use `isSameEntry`; most-recent selection is restored | Real-browser quota exhaustion and permission reauthorization remain browser acceptance work |
| Terrain data contract | Implemented, mechanically validated | Missing samples survive JSON; flat profiles draw at 0.5; malformed layers/lengths rejected; disconnected guides rejected; generic build cannot overwrite bundled module | Existing bundled asset provenance cannot be upgraded without its original DEM/source record |
| Terrain runtime | Implemented, mechanically validated | Palette rasters are lazy and held under a 64 MiB accounted cache; current/incoming palettes are pinned; preview freezes travel and deformation | Bundled Teton data still has two sourced ridges (`L2`, `L4`); `L3` remains procedural until a third real guide is built |
| Video capture clock | Clock implemented; encoded acceptance harness pending | Full-song capture starts with zero display lead; mid-song capture pays lead debt monotonically; recorder defers its first frame until alignment; automatic recorder limits release clock ownership | No decoded click/cue offset assertion exists yet; it must be implemented and run for full- and mid-song captures before encoded A/V sync is certified |
| World/analysis acceptance | Protocol exists; not certified | Existing evaluation tools and historical graphics comparison evidence remain in-tree | Held-out section corpus, blinded human ratings, Android/Fermata checks, and physical-device performance measurements are not present |

The local full unit suite passed 2,964/2,964 with lint clean. “Mechanically validated” does not mean human-reviewed or device-certified.
