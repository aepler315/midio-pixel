# Head-unit fixes completion plan

> Historical record. The scope, preservation rules, approval/hold decisions and validation steps below describe this past task, not current development prerequisites. Experiments and local commits follow the [current development policy](../../experimental-development.md). Recorded results and runtime eligibility remain evidence of the version reviewed.

**Goal:** Finish the previously requested Android head-unit fixes from local commit `42dff0a` on current main.

**Scope:** Bottom scroll clearance, fullscreen at physical viewport dimensions, one live-sized Android screenshot, a working multiple-file music fallback, and removal of video export controls and flowing river geometry. Keep lakes, oceans, reflections, existing camera work and the opt-in compiled terrain experiment.

**Approach:** Reapply the existing implementation rather than redesign it. Preserve the newer adaptive output sizing outside fullscreen. Fullscreen explicitly uses physical viewport dimensions, including at reduced quality rungs. Keep offline capture tooling.

- [x] Integrate `42dff0a` on `1ddedee` and resolve the output-sizing conflict without losing adaptive windowed sizing.
- [x] Review the picker, screenshot and fullscreen paths; reproduce and fix any concrete regressions with focused behavior checks.
- [x] Run relevant behavior tests, lint and the full Node suite; run bounded headless Android browser checks where available.
- [ ] Commit the reviewed result and open a pull request. Report device checks and any baseline test failures precisely; do not merge or deploy.

**Review focus:** Fullscreen entry/exit while paused; output dimensions across quality changes; Android multi-select and cancel/reselection; one PNG download without detail or playback changes; all final controls reachable on short screens.

**Review results:** Fixed flat-file filename collisions, stale shared picker verdicts, direct-terrain fullscreen coverage and fullscreen pointer inversion. Each regression was observed failing before its fix. The final focused group passes 203 tests; lint, 26 Ridgeview tests and site staging pass on Node 24. The full suite reports 5,707 tests: 5,687 pass, 19 skip and one unchanged planner timing failure, also reproduced on unmodified main. Chromium is absent, so the new head-unit smoke reports unavailable and makes no browser/device claim. The PR records the remaining checks.
