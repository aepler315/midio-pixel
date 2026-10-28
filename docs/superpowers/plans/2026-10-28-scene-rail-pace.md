# Scene rail pace implementation plan

Approved conversation spec: per-scene rails requested 3x, coordinated automatic scenic punch Off, persistence and review controls in aepler315/midio-pixel. Inspected baseline 6b47a080dc1d6d23ed049cdfa3cd877eb4883bcf. Routes and restrained zoom are deferred.

## Global constraints
- Work only in /workspace/midio-pixel; never edit /workspace/Midio-5.
- Landscape-only punch removal; preserve Trio, slow structural moves and current wheel/pinch eligibility.
- Pace choices 1,2,3,4; default3. Never change audio/weather/celestial/glacier clocks.
- Ordinary approved rails only; tours retain heard-time planners; preview midpoint .5; glacier coupled journey unchanged.
- No loops, reversals or path/terrain extensions. Report caps honestly.
- Per-occurrence selection AND progress must survive seeks/adoption/export; retain both transition sides.
- Existing actual travelMs 3–7s; fitting allowance fixed7000+1200ms clipped to duration.
- Keep captures in .smoke and headless/muted/isolated; no captured evidence in git.
- Relevant tests and npm test/npm run lint before completion; use meaningful test-first changes.

## Tasks
1. Landscape punch Off: neutral source before Simulation camera and viewport; shared Range lens neutral, preserve Trio consumers; update pulse smoke/docs and test complete magnification behavior.
2. Pure SceneRailPlan: immutable versioned schedule+20ms base tables; compile real-view runs from all sections, merge adjacent view runs, gaps break. Formula d=p(b)-p(a),D=min(m*d,1),g=D/d (zero=>1),s=clamp(p(a),0,1-D),u=s+g*(p(clamp(t,a,b))-p(a)). Stable occurrence IDs; selectionAt and railStateAt; snapshot restore; future-only pace and analysis adoption splice.
3. Runtime: schedule drives RangePresentation selection/preparation/transitions; immutable per-render-side RangeFrame progress; occurrence IDs retained through late fade; coherent terrain, sky, reflections/calibration and metrics. Clock policies preserved.
4. Lifecycle and UI: run-owned schedule outside simulation; seek/export/highlights preserve; replay/new seed fresh; adoption retains committed runs+old bases and refines tail. URL rangePace > localStorage range-pace >3; invalid3; select1-4; pending next unplayed occurrence/replay. High-water heard-time commitment survives rewind and forward seek commits skipped prefix. Snapshot in highlights and export override; group by schedule ID; legacy camera approximation; restore player state after temporary renders.
5. Review tools and docs: --pace and explicit tours off; capture snapshot diagnostics and optional continuous <=180s clips retaining short defaults. Tests for options/manifest; matched ordinary-rail capture and visual inspection when available.

## Decisions
- Separate new clone on feat/scene-rail-pace is isolated from the supplied wrong checkout; no extra worktree is needed.
- Run high-water time never decreases; rendering export/reel snapshots must not commit or alter live run history.
- Adoption splice at S=nominalEnd of latest begun run. Retain all begun occurrences verbatim and each full padded window. Keep previously scheduled next view/start and actual entering travel at S as anchor; let new-analysis later different-view boundaries define unstarted tail. Never merge/refit a committed run across seam. If no future run, retain through duration. Music sections remain independent.
- No new automatic zoom On option in first delivery; Off is behavior policy.
