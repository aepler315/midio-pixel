# Terrain Studio Implementation Plan

**Goal:** Discover terrain and author, save, randomize and play personal geographic cameras inside Midio Pixel.

**Architecture:** Lazy in-app dialog; pure camera engine, source-bound project store, bounded worker terrain preview, and existing stage compositor integration.

**Tech Stack:** Browser ESM, Canvas 2D, module worker, existing Landscape material inputs, native Node tests and Playwright.

**Spec:** docs/superpowers/specs/2026-11-07-terrain-studio-design.md

## Global constraints

- Existing review data and source provenance remain intact.
- No production terrain approval is created by a user edit.
- Load external elevation only on an explicit live-preview request; bound tiles, grid, cache and render resolution.
- Geographic edits use real coarse terrain; failures retain an honestly labelled original still.
- No payment enforcement until an actual account/backend product is selected.

## Review focus

Malformed imports, source updates, storage denial, rapid terrain changes, modal keyboard leakage, worker failure, and loading cancellation must not lose drafts or overwrite the current picture.

## Tasks

- [x] Camera engine: tests for numeric bounds, deterministic variants, locks, terrain clearance and subject targeting; implement settings/presets/analysis/motion.
- [x] Project store: tests for source binding, bounded history, atomic validation and storage failure; implement drafts/locks/presets/portable files.
- [x] Terrain preview: tests for bounded geographic grid planning, rendering and cancellation; implement public DEM acquisition and worker with fallback.
- [x] Studio interface: connect discovery/review workflow and camera controls, presets, motion, original comparison and portable files; verify in browser.
- [x] App integration: tests for compositor/capture switching; add title/playback entry, personal view playback and automatic-view restore.
- [x] Review and verify: focused tests, lint, module graph, broader suite, browser desktop/narrow workflows; fix actual regressions and open reviewable PR.
