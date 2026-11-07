# Adaptive Quality Implementation Plan

**Goal:** Seek maximal stable detail while preserving the Landscape across devices.
**Architecture:** Extend the existing governor with optional measured CPU work and preserve recognizable Landscape content through cheaper rendering. Keep period-only compatibility and manual/export policies.
**Tech Stack:** JavaScript, node:test, Canvas/WebGL, Playwright.
**Spec:** docs/superpowers/specs/2026-11-07-adaptive-quality-design.md

## Constraints and review focus
- CPU submission timing cannot prove GPU headroom; callback pressure remains authoritative.
- Skipped 24/30 FPS draw callbacks must never provide cheap-work evidence.
- Warmup, hidden/resume, quality pins and manual ceilings remain effective.
- Failed probes must roll back and back off, without one hitch causing lasting degradation.
- Weather, music timing, mountain construction, camera and pixel-grid selection remain independent of device tier.

## Tasks
- [x] Extend PerfGovernor.sample(deltaMs, nowMs, {capFps, workMs}) with measured-work headroom, anticipatory pressure, bounded recovery and diagnostics; write behavioral simulations before implementing; run governor/consumer tests.
- [x] Wire prior rendered-frame CPU work into the main loop with explicit nulls for skipped/hidden frames; test timing/cadence semantics.
- [x] Preserve Landscape sky and lighting features across quality rungs while retaining representation/sampling savings; test all rung endpoints and affected consumers.
- [x] Record ranked resource/visual-value audit with source evidence and estimates clearly labeled.
- [ ] Run focused integration tests, lint, module checks, browser smoke; obtain an independent review, address regressions, then publish a reviewable branch/PR.

Implementation, review and local verification are complete. External push and pull-request creation are pending publishing authorization after automatic approval review rejected the push.
