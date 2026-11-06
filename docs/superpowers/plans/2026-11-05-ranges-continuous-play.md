# More ranges and continuous playback implementation plan

**Goal:** Add three different mountain regions, bounded density shortcuts, and an optional continuous library listening flow.

**Architecture:** Retain the single-stage renderer and flat-ground growth. Expose three shipped regional candidates through explicit experimental eligibility. Use a pure library sequence plus a cancellable completion controller; page wiring retains audio-selection ownership and render-ready startup.

**Tech stack:** Existing browser JavaScript, WebGL, local library/File System Access, Node tests and isolated muted Chrome on the RTX 3060.

The current request and `AGENTS.md` authorize routine implementation choices without another design approval. Defaults below are implementation choices, not additional user requirements.

## Behavior

- Enable Sawtooth/Redfish Lake, Shenandoah/Stony Man and Superstition west front in normal selection. Keep candidate/review metadata honest. Relax brief mixed-band seam appearance restrictions, retaining terrain integrity, coverage, resource admission and sustained-frame-rate protection.
- `-` lowers and `=` raises pixel detail through Classic, Classic+, Medium, Medium+, Detailed. Clamp at both ends. Share the HUD button path; preserve text entry, modal controls and browser modifier shortcuts. Consume these keys without beat recalibration, including at endpoints.
- Adjacent title checkboxes: Shuffle (default on) and Continuous play (default off), persisted. Continuous uses the current local music library and retains the world/experience and presentation settings. Unshuffled order uses stable title ordering; shuffle visits all eligible tracks before repeating. A singleton may repeat.
- At natural completion, after recording finalization, show a five-second cancellable next-song countdown. Cancel stops this pending advance. A manual selection, Stop/Title, replay, new-seed interaction, highlight inspection or export cancels pending automatic work.
- Add Random song beside the end-screen replay controls. It shares title Random behavior; an empty library opens folder selection only on this explicit click.
- Automatic playback never opens a permission picker. Empty/unavailable libraries stop visibly. Skip at most three distinct missing or undecodable tracks, then stop. Keep stale asynchronous work from replacing a newer manual selection.

## Tasks and verification

- [ ] Range eligibility: update catalog/selection and candidate shot eligibility; prove only the three selected regions become eligible and existing integrity failures remain failures. Inspect each on the RTX 3060, including transitions.
- [ ] Playback policy: implement `PlaybackSequence` and `PlaybackPreferences` with tests for stable ordering, wrapping, full shuffle cycles, singleton/empty inputs and persistence.
- [ ] Completion controller/page integration: implement countdown, cancellation, bounded failure handling and current-world continuation through the existing selection ticket. Test cancellation during asynchronous preparation and recording/export exclusion.
- [ ] Controls: add title/end UI and bounded density shortcuts; test actual keyboard behavior, native editing/modifiers and endpoint handling in the browser.
- [ ] Integration: lint and focused tests, isolated browser flow with multiple local tracks, new-range visual captures and representative RTX 3060 timing. Run the required pre-push gate, publish a reviewable PR and record exact evidence/limits.

## Review focus

- No automatic permission prompts or infinite retries when a folder disappears.
- No duplicate completion callback or stale preparation that steals a newer selection.
- No automatic advance during highlight/recording work or after Stop/Title.
- No density wrap or accidental beat calibration/browser-zoom interception.
- No fabricated artistic approval, missing source pins or newly exposed terrain gaps.
