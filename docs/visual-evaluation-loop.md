# Run, inspect, change, compare

Use actual audio and actual rendered output to guide changes. Unit tests establish correctness; they do not establish that the scene looks good or follows the music clearly.

For a bounded Landscape review that always stays in the background, use
[`npm run review:landscape`](landscape-review.md). It saves exact PNG/audio
clips, contact sheets, control checks and an optional separate live trace; it
never opens a foreground browser or report.

## First run

```sh
npm ci
npx playwright install chromium
npm run visual:eval -- --out .smoke/baseline
```

On Linux CI, install browser system dependencies with `npx playwright install --with-deps chromium`. An existing Chromium can be selected with `PLAYWRIGHT_CHROMIUM_PATH`. The command starts and stops its own loopback server and browser. It does not depend on `npm start`, an occupied port, the deployed site, or the version picker.

Open `.smoke/baseline/index.html`. The report contains time-stamped checkpoints, every saved motion frame, diagnostic state, and source audio. Press a clip button to play the matching audio while the actual captured frames advance. Expand the consecutive-frame section to inspect an attack or transition frame by frame. Download and extract the entire evidence folder before opening an HTML report from CI.

The full two-pass corpus can exceed 30 minutes on software WebGL. CI runs
each complete recording in a separate job (one per song in
`test/fixtures/visual-evaluation.json`), retaining every checkpoint and
motion sample in both passes and comparing identical inputs with
`--require-identical`: any PNG that differs between the two passes fails
the job, since software WebGL renders identical inputs byte-for-byte. For tight
iterations, use a focused manifest with one recording and a few windows;
use the full corpus for acceptance.

The default versioned corpus contains three generated 24-second recordings: silence, isolated kicks, and quiet/loud/quiet instrumental contrast. The contrast track uses the existing pilot generator. These are controlled diagnostic inputs, not coverage of real genres or proof of instrument recognition. Run your representative recordings before accepting an artistic change.

## The coding-model loop

1. Capture a baseline before editing. Read the JSON status and errors; open the PNGs and inspect consecutive frames; listen to the matching passage. A failed capture is a harness/runtime problem to diagnose, not an acceptable baseline.
2. Write one falsifiable observation with a song ID and timestamp: for example, “The ridge response vanishes at the storm maximum at 12.0 seconds.” Distinguish an audio-derived control from an ambient clock. State what visible evidence would show improvement.
3. Change the smallest relevant component. Preserve the original baseline. Run the relevant behavior tests.
4. Run **the same manifest** into a new directory:

   ```sh
   npm run visual:eval -- --out .smoke/candidate
   npm run visual:eval -- --compare .smoke/baseline .smoke/candidate --out .smoke/comparison
   ```

5. Open the comparison and both audio-backed motion reports. Check quiet, attack, climax and return passages. A large pixel difference does not mean better; identical pixels can reveal that the code change never reached the image.
6. Record a retain/revert decision, the observation it addresses, regressions checked, and remaining uncertainty. If an iteration does not improve the stated observation, revert only that iteration's changes. Keep unrelated user work intact. Stop when the selected acceptance criteria are met; do not keep adding spectacle to increase a score.

Suggested task prompt:

> Read AGENTS.md and docs/visual-evaluation-loop.md. Capture the specified manifest as a baseline. Inspect actual screenshots and listen to the corresponding clips. Choose the most consequential visible musical mismatch, explain its cause, and make one scoped improvement. Capture the identical manifest again, compare the results, and retain the change only if the target visibly improves without regressions in quiet passages, transitions, or framing. Report the evidence paths and exact song/time references. Do not infer visual success from unit tests or numeric controls alone.

## Quality rungs and the VFX matrix

`settings.quality` accepts every governor rung, 0–6.

Older reports that recorded flash and motion preferences, in their settings
or per frame, still validate and compare: those retired fields are ignored,
except that a capture which turned either one on is incompatible with one
that did not.

`test/fixtures/visual-evaluation-vfx.json` is a matrix of short cases that
together cover q0 and every shedding boundary (q2–q6), Natural/Pixel/Palette,
and a lake (`teton-jackson-lake`) and an inland (`panamint-dantes-view`)
view, plus two continuous history cases. It spreads those values across
cases rather than running the Cartesian product. Run one case at a time:

```sh
npm run visual:eval -- --manifest test/fixtures/visual-evaluation-vfx.json --case q4-palette-inland --out .smoke/q4-base
```

CI runs each case in its own job: a capture, an identical repeat compared
with `--require-identical`, and, when the manually dispatched workflow is
given a `baseline_ref`, a capture of that ref's source for the same case
compared with the candidate for review. The gates are page
and shader errors, an inactive or wrong backend, a wrong quality rung and
blank frames. There is no pixel-difference beauty threshold; the
base/candidate comparison is review material. Trio stays in
`npm run test:trio` and `npm run test:worlds`, and the legacy Range path in
`npm run test:retro`.

## Your own recordings

Create a manifest in an ignored directory, for example `.smoke/music-corpus.json`. File paths are relative to the manifest, not to the shell's working directory. Absolute paths work too. The runner copies audio into its output so the report remains playable offline. Keep private/copyrighted recordings and reports out of public commits and public CI artifacts.

```json
{
  "version": 1,
  "settings": {
    "width": 1280,
    "height": 720,
    "seed": 315,
    "quality": 0,
    "view": "teton-jackson-lake",
    "biome": "CONIFER",
    "fps": 24,
    "mode": "sparse",
    "intervalMs": 10000
  },
  "songs": [
    {
      "id": "my-song",
      "file": "../music/my-song.flac",
      "clips": [
        { "startMs": 30000, "durationMs": 3000 },
        { "startMs": 90000, "durationMs": 3000 }
      ]
    }
  ]
}
```

```sh
npm run visual:eval -- --manifest .smoke/music-corpus.json --out .smoke/real-baseline
```

Without `timesMs`, checkpoints occur at zero and every `intervalMs` (10 seconds by default), up to the decoded duration. Without `clips`, the runner captures two seconds around the midpoint (shorter for very short inputs). To sample chosen musical moments, supply `timesMs` and `clips` explicitly. An empty `clips` array disables motion samples; an empty `timesMs` array is rejected. Out-of-range times or clips fail instead of silently truncating. WAV, MP3, FLAC, OGG, M4A and AAC are accepted when Chromium can decode them; MIDI requires rendered audio first.

Choose at least a quiet/sparse recording, a rhythmically clear recording, and a dense recording; include a strong section contrast and a returning motif. Save the chosen windows once. Do not pick new favorable moments after seeing the candidate. Keep an additional holdout song for final acceptance.

## What is held fixed

- SHA-256 of each copied audio file, requested and actual timestamps.
- Browser-construction seed, actual song seed, quality level, viewport, DPR 1, frame cadence, capture mode, view and biome pin. The construction seed is recorded independently: production derives song identity from the uploaded song, so those two seeds need not be equal. Matched reports require equal actual song seeds.
- Chromium version and reported GL renderer/vendor/device memory.
- An immutable in-memory snapshot of `index.html` and the entire public `src/` tree, including terrain assets and runtime code. Its hashes and git commit/dirty state are recorded. A source edit during the capture makes the run fail and preserves its evidence.
- External page requests are blocked; lyrics lookup is disabled; service workers are blocked. Real upload, decode, analysis and rendering still run.

`view: null` and `biome: null` exercise natural song casting. Use a separate manifest for this check; it is intentionally incompatible with a forced-view A/B run. Current assertions require Range v2 to stay active. A natural-casting case with legitimate legacy fallback is reported as a failed v2 case, not mislabeled high-fidelity evidence. A focused manifest can capture Trio instead with `settings.experience: "trio"`; the capture then requires Trio to be active and Range v2 terrain to stay inactive. `npm run test:worlds` drives both worlds through the chooser.

## Timing and interpretation

**Sparse** mode advances fixed simulation steps over gaps, draws an early opening frame, then draws every selected checkpoint and clip frame plus one second of clip pre-roll. Skipped draws can matter to render history. This is useful for fast composition and localized response comparisons, but does not prove uninterrupted playback behavior.

**Continuous** mode draws every frame from zero through the last requested checkpoint/clip at the chosen FPS. Use it when changing temporal accumulation, opening transitions, camera continuity, weather history, or any render-dependent state. It is slower, particularly in software WebGL. Choose short focused recordings to keep it practical. The existing live playback/seek/export tests remain relevant; fixed export evidence does not certify live audio latency, seeking equivalence, context recovery, or hardware performance.

The export clock can be up to one fixed simulation step behind a requested time. Every frame records its actual time; playback of the captured sequence uses that time. The report's audio energy and camera/weather diagnostics help trace causes but are not proof that their visible effect is strong enough.

The default 640×360 capture is fast triage. Use 1280×720 or higher and your intended quality level for final fine-detail review. Pin the same settings in both runs. Software WebGL timings are not desktop/phone FPS measurements.

## Failures and outputs

The output directory must be new. This protects baselines from accidental overwrite. Each capture exits nonzero on errors and retains `report.json`, `index.html`, and any completed frames. A browser-launch failure therefore produces an honest failed report, not an empty green result.

Each completed run has:

- `manifest.json`: normalized requested inputs/settings.
- `report.json`: provenance, actual state, warnings/errors and saved frame metadata.
- `index.html`: offline review page, audio and motion controls.
- `<song>/audio.*`, `<song>/frame-*.png`: copied audio and actual images.

Comparison checks identical input hashes, settings, browser/environment, duration, schedule and complete frame sets. It verifies copied audio and PNG hashes before writing a self-contained side-by-side report. Changed-pixel measurements use 64×36 thumbnails and ignore changes of at most two RGB levels; they are diagnostics, never a pass/fail aesthetic criterion. The quality verdict always starts `unreviewed`.

The `Visual evaluation` CI workflow captures the committed default fixtures and uploads the report even when the command fails. It also repeats one identical capture to expose nondeterminism. Any drift is recorded as a finding, not automatically accepted or hidden by a loose screenshot tolerance.

## Pixel presentation evidence

A focused manifest may set `settings.presentation` to a complete version-1
display profile (`look`, `quality`, `palette`, `dither`, `scaling`) or a complete
version-2 profile, adding `pixelGrid` (`classic`/`classicPlus`/`medium`/`detailed`) and `ditherMode`
(`ordered`/`selective`). v2 palette choices are `world`, `range32`, `chroma32`
and `rgb332`. The manifest validator rejects unknown fields and values;
valid v1 normalizes to Classic/Ordered while preserving its choices. This
is stricter than the forgiving stored-preference reader.

The runner applies the profile through the production bulk-export entry
point. Each saved frame records requested/effective presentation, actual
palette/grid/style, backend, output size, DPR and pixel policy version.
Diagnostics separate readback, mask, transform, writeback and presentation
CPU; the last excludes scene drawing. Native source size and delivered-frame
behavior must be interpreted separately from requested output resolution.

Use identical unchanged v1 requests to compare revisions that both support
them. New palette/grid/style options need separately labeled reference and
candidate runs: an older revision cannot honor them. Do not change baseline
metadata or relax comparison to manufacture a match. Candidate deterministic
repeats use the exact same settings in both runs.

`test/fixtures/visual-evaluation-pixel.json` provides a focused opening,
quiet/attack/return, lake/inland, continuous and Natural control matrix. Run
one case into a new directory, bounded by the existing watchdog or a stated
external limit:

```sh
npm run visual:eval -- --manifest test/fixtures/visual-evaluation-pixel.json --case classic-pixel-opening --out .smoke/pixel-base
# Capture the identical request after a change:
npm run visual:eval -- --manifest test/fixtures/visual-evaluation-pixel.json --case classic-pixel-opening --out .smoke/pixel-candidate
npm run visual:eval -- --compare .smoke/pixel-base .smoke/pixel-candidate --out .smoke/pixel-comparison
```

Inspect native glyphs, credit pages, gradients and moving silhouettes at
the recorded song times, with corresponding audio when available. A
Selective mask is only an edge heuristic; a still alone cannot establish
moving-boundary quality. Label a bounded partial run as partial, retain its
completed evidence and explain which checks remain unavailable. Do not keep
relaunching an equivalent stalled software-GPU matrix.

`settings.startMs` optionally bounds continuous drawing to a later start.
Checkpoints and clips before that start are rejected. Such a run does not
verify opening history; retain an opening check separately. Sparse captures
still draw consecutive frames within each selected clip and its pre-roll.
`VISUAL_ANGLE=gl` requests Chromium's GL backend (it may fall back); the default remains SwiftShader.
The selected driver and actual GL environment are recorded. Driver changes
must not be mixed in a matched comparison.

`npm run test:retro` uses real Canvas/CSS checkerboards at both native grids,
four DPRs and eight resized viewports, then checks the default Range v2 and explicit legacy path.
It rejects silent v2 fallback, blank/frozen controlled sequences, missing
capture, nonpalette raw pixels, incorrect scene bars and failed exports.
`tools/export-smoke.mjs` records and decodes live Pixel and Palette transitions,
including Classic-to-Detailed, through SongRecorder, preserving encoded dimensions.
Start a local app server separately and pass its URL and a fresh output
directory; an optional third script argument `v2` requires the actual v2
backend (see [display presentation](pixel-presentation.md)). Opaque raw palette
membership is exact; decoded H.264 bars permit peak RGB sum <=96 and <=20%
weakly lit pixels away from the boundary (<=35% at the adjacent boundary).
These codec tolerances do not establish exact palette membership after loss.
The browser CI jobs have time bounds and retain failed diagnostics.

## Diagnostic renders and render provenance

A focused manifest may set `settings.debug` to render one of the existing
developer views instead of the normal image: `rangeDebug` (`masks`, `slope`,
`albedo`, `fill`, `key`, `roughness`, `specular`, `sun`), `forestDebug: 1`
(near meshes red, silhouettes blue, far canopy green) or `rangeMsaa`
(`0`, `2` or `4`, overriding the scenic edge policy). The switches are part
of the settings, so a comparison only matches identically configured runs.
Keep diagnostic manifests separate from the appearance baseline.

Every saved frame records `render`: the scenic target size and its
multisample count with the reason (`natural`, `pixel-look`, `quality`,
`budget`, `unsupported`, `override`), the drawing buffer, scenic viewport
(backing, logical, overscan), exposure, kept-forest fraction, mirror amount,
whether sun shafts drew, and tree counts by representation. A capture fails
when the scene's effective quality rung differs from `settings.quality`, in
addition to the existing governor and Range v2 checks.


For an available desktop OpenGL GPU, `VISUAL_HEADFUL=1 VISUAL_ANGLE=gl`
runs Chromium with a visible window. Keep the same window mode and driver
for both sides of a comparison, and check the recorded GL renderer: requesting
OpenGL does not prove that a hardware backend was selected. Headless
SwiftShader remains the default for CI.
