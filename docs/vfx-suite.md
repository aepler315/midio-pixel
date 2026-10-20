# Visual Effects Suite — implementation and verification

Checked against the implementation on October 13, 2026. This document
separates what the default Range draws today from Canvas modules that are
present but dormant, and from the optional WebGL overlay. Audio analysis
lives elsewhere; the renderers consume its output rather than analyzing
audio themselves.

## Active on the default Range (v2)

Every registered world currently resolves `performers: false`
(`src/world/LandscapePresentation.js`): listening owns the landscape from
frame zero. What the listener sees on the default Range comes from the GPU
scene (`src/world/alpine/RangeScene.js`) composited into the Canvas frame,
plus a few Canvas passes around it.

| Effect | Owner | Notes |
| --- | --- | --- |
| Terrain (far / mid / near partitions) | `RangeScene`, `TerrainMaterial`, `TerrainMesh` | One shared depth pre-pass; multisampled in Natural at q0–q2 (`RangeRenderPolicy`), never in Pixel/Palette |
| Forest | `ForestCover`, `ForestGL` | Near instanced conifers, mid silhouettes, canopy texture beyond; wind and gust fronts at heard time |
| Water | `WaterMirror`, `WetReflection` | Lake mirror (dropped at q4; the water keeps its sky reflection) |
| Fog, mist, cloud sea | `RangeAtmosphere`, `ValleyAtmosphere`, `CloudSea` | Fog samples per pixel fall at q3, q5 and q6 |
| Clouds, storm, rain, lightning | `RangeSkyComposition`, `RangeStorm` | One squall per song, evaluated at heard time; cloud lightning flickers inside the banks |
| Sun shafts | `SunShaftGL` | Optional; dropped at q3 |
| Lane lanterns and motes | `RangeActors`, `ActorsGL` | Drawn inside the band passes, so nearer land hides them and the mirror reflects them |
| Finishing | `Renderer._drawBloom`, `_drawHeatDistortion`, `_drawFilmFinish` | Heat warp is skipped under reduced motion; fire colour and light remain |
| Final presentation | `PresentingRenderer`, `PixelPresentation` | Natural, Pixel or Palette; display and capture read the same finished source |

The Range quality ladder (`RangeQuality.rangeQuality`): q2 lighter near-tree
assets and 2x MSAA, q3 fewer fog samples, no shafts and no MSAA, q4 no lake
mirror or landscape giants. Rock-stage pools are dormant on catalog v2 views. Landform structure,
ground contact and the musical signatures are never shed.

### Current composition order

Pinned by `test/rendererComposition.test.js`, which runs the production
`Renderer.draw` over a real `BiomeManager`:

1. The Range receives this frame's viewports (`setFrameInputs`).
2. Sky, then scenic partitions far → mid → near, with the Canvas passes
   that belong between them (`test/rangePresentation.test.js` pins those).
3. Ground response and legacy foreground hooks (dormant after catalog-view arrival).
4. Finishing on the physical backing store: bloom → heat distortion → film
   finish. HUD (when shown) and the range caption follow.
5. `PresentingRenderer` finishes the frame (Natural/Pixel/Palette) from the
   same source the capture reads. A failed scene draw never publishes.

## Dormant on v2 views (legacy and arrival only)

Every catalog view resolves `foreground: 'none'` in `RangeComposition`.
It builds no rock stage or wet receivers. Once arrival completes, legacy
NearField, veil and section swells have zero presence.

| Effect | Owner | Notes |
| --- | --- | --- |
| Ground response | `GroundResponse` | Dormant without wet receivers; retained for legacy or ledge compositions. Uses heard time. |
| Rock-pool reflections | `WetReflection`, `Renderer` | No rock stage on catalog v2 views; q6 gates only a dormant capability. |
| Section swells, veil and NearField | `BiomeManager` | Legacy fallback and arrival only; fade to zero when the v2 view arrives. |

## Dormant Canvas modules

The painterly performer effects below are implemented and unit-tested, but
`Renderer.draw` gates them on `presentation.performers`, which is `false`
in every world today, so the default Range does not draw them. They are
kept, not deleted, and are not part of the active look.

## Optional overlay

`?renderer=webgl` adds an optional energy-driven WebGL wash
(`src/render/WebGLRenderer.js`). It is off by default and separate from the
Range GPU scene. The wash renders offscreen and is composited once into the
composed source before `PixelPresentation.finishFrame()`, so the display,
recordings and exports show the same frame; Pixel/Palette get no wash. Its
energy is a pure function of heard time. A lost context skips the wash
(never a stale image) and restoration rebuilds its program and buffers
(`test/webglRenderer.test.js`; `EXPORT_RENDERER=webgl npm run test:export`).

### Impact and trail inventory (dormant)

`ImpactFX` stores positions in world space and projects them with
`wx - worldX + originX`. `Simulation` seeds it with the song seed.

| Effect | Capacity | Lifetime / behavior |
| --- | --- | --- |
| Crater flash | 16 | 0.12 s; biome-tinted landing light |
| Landing dust ring | 16 | 0.42 s; 24 jittered segments |
| Judgment ring | 16, separate pool | Dedicated capacity keeps landing decoration from starving verdicts |
| Dust motes | 400 | 0.26–0.42 s for landings; also judgment/sputter particles |
| Star-polygon shockwave | 8 | 0.5 s; hard landings (`I > 0.5`) |
| Paint splat | 20 | 2.8 s; rhythm-clean landings and authored events |
| Gold ignition ring | 8 | 0.5 s; Apotheosis |
| Ground scar | 60, manual list | 4 s |

Landing intensity is `clamp(vLand / vRef, 0, 1)^0.7`; camera shake is
`5.5 * I`. Pool allocation returns `null` at capacity; ring initialization
is guarded. Pools recycle objects, while some effect payloads (for example
splat blob arrays) still allocate. This is not an allocation-free engine.

`RippleFX` adds expanding perspective rings, ground pulses and biome-tinted
landing puffs. Its radius, lifetime, opacity and puff trajectories have pure
helpers and tests. Ring count and puff count consume the particle multiplier,
with minimum feedback counts; zero multiplier does not disable every effect.

`ImpactFX` trigger, judgment, sputter and splat accept particle multipliers.
Some simulation events multiply the governor budget by fever headroom;
other authored events intentionally use the default. These are effect budgets,
not a promise that every draw count scales identically.

`RainbowBrush` deposits world-locked square dabs while airborne: at most 320,
3.2 s lifetime, 8 px nominal spacing, 16° hue steps. Spacing widens under
particle shedding. Draw skips expired, future-dated and off-screen dabs;
the entire brush is gated at governor level 5. Reduced flash uses normal
compositing instead of additive blending.

Murmuration and OrbitalDebris render a bounded subset of their fixed simulated
collections. The draw multiplier affects emitted wing segments/triangles,
not the size of the simulation arrays. Zero or negative multipliers emit no
geometry; values above one cannot read beyond the collection.

## Lighting and world boundaries

`LightField` resolves a shared celestial light and local ground/character
lights. Celestial intensity is
`budget * (1 - unravel) * (1 - 0.5 * dayArcAlpha)`; reduced flash compresses
it toward a steady 0.6 baseline rather than applying a flash cap.

Song adaptation preserves each stock palette's `edgeLight`, so Nave's
stained-glass spill, Foundry's furnace glow and Redline's neon band remain
available. Intentionally unlit stock palettes stay unlit. Seven specialized
worlds shade the exact fitted vertices and placement of their static strips;
Range retains its dancing terrain. Ceiling strips have their own geometry.

Fathom and Nave pass `{ astronomical: false }` to the shared sky renderer.
They retain the base gradient, atmospheric plate and local palette effects
such as light shafts, bioluminescence and motes. Stars, galactic layers,
space dust, aurora and nebula bloom are excluded. Their celestial objects
remain the underwater sun and rose window. The default open-sky behavior is
unchanged. The final film grade remains a separate, shared color treatment.

Redline travel integrate smoothed song energy into cumulative
distance. They no longer multiply the current rate by elapsed song age.
Direct and backward seeks therefore agree with the integrated timeline.

Protected hues remain Midio (`178°`), hazard (`#ff4d4d`) and reward
(`#ffd75e`). `VisualStyle.styleDials()` is authoritative for shared style:
current bloom multiplier 0.9, film grade 1.45, vignette 1.08, glow halo 0.95
and rim amount 0.95. World identity still needs visual review across songs;
those numbers alone do not establish balanced compositions.

## Reduced flash and reduced motion

Two independent, persisted preferences, each with its own Settings chip
(`#reducedFlashBtn`, also the `R` key; `#reducedMotionBtn`). With no stored
choice both follow `prefers-reduced-motion`, including when storage is
blocked. Reduced motion skips the animated heat warp, holds musical terrain
deformation, damps NearField and the camera, and replans the uncommitted
part of a Teton tour with the reduced climb/yaw limits. The per-effect flash
helper caps alpha at `FLASH_CAP = 0.4`.

- Returning-section cut flashes are removed under reduced flashing; cut
  blends take one bar rather than 0.3 bars.
- Impact flashes/rings, RippleFX and other flash-aware effects cap their
  transient opacity. Landing additive effects switch to `source-over`.
- The hype echo and drop motion blur are disabled. The hype border caps its
  final opacity (including focus weighting) and switches to `source-over`.
- Drop shockwave rings, shock blits and speed lines cap opacity and switch to `source-over`;
  the chromatic displacement is also halved.
- Film grading is a slow color treatment, not a beat flash. Celestial light
  compression and bloom's steady base have separate rules.

A per-draw alpha limit is not a frame-wide luminance guarantee. Normal
compositing avoids additive summation, but overlapping layers and remaining
post-processing can still alter contrast. These implementation checks do
not constitute a photosensitivity certification or exhaustive flash audit.

## Performance governor

`PerfGovernor.sample()` receives the **rAF frame period**, including vsync
wait, not JavaScript draw cost. Its threshold is **18.5 ms at 60 FPS**, or the selected 30 FPS period plus
the same 1.83 ms jitter allowance (about **35.17 ms**).

- Song/world construction starts **2,500 ms warmup grace**; those frames do
  not vote on shedding.
- Each period above budget adds `min(6, deltaMs / budgetMs)` load units. At 60
  units it sheds one level and clears the accumulator.
- A clean period removes 0.5 load units, bounded at zero. Intermittent judder
  can accumulate evidence; one clean frame no longer erases it.
- Ten uninterrupted clean seconds recover one level. An over-budget period
  restarts that recovery window.
- `?perf=high` starts at 0; `?perf=lite` starts at 2. Coarse-pointer or small
  viewport otherwise starts at 1. These choose the initial level only.

| Level | Additional degradation |
| --- | --- |
| 1 | Disable vision self-tuning; widen dancing-strip columns 16→32 px |
| 2 | Particle multiplier 0.6; disable rim lighting |
| 3 | Disable contact shadows, crack-glow capability and bloom; columns 64 px |
| 4 | Disable L7 veil |
| 5 | Disable optional phenomena and RainbowBrush |
| 6 | Haze 3→1 layers; disable heavy finishing/echo/blur; reduce terrain shading to its retained catchlight |

Above 2560 backing-store pixels, column width doubles (maximum 128). Every
preset is capped to the pixels its contained 16:9 stage can actually present;
manual presets otherwise remain fixed. Auto alone reduces its fitted backing
store to 85%, 75% and 62.5% at levels 2, 3 and 4. Retro mode pins level 6,
particle multiplier 0.35 and 128 px columns; optional retro palette
quantization only runs with that mode.

Some capabilities are historical: the painterly renderer no longer draws
fracture cracks, although the timing engine and governor accessor remain.
Profile-crossfade memoization and per-pixel crack refraction are not
implemented features and are not claimed as savings.

## Painterly draw order (with performers)

With `performers` enabled, the boundaries in `Renderer.draw()` are:

1. Sky/parallax/phenomena use the zoomed view. The world renderer then switches
   to the fixed ground view for ground, footing and flood.
2. Burrow/desaturation/telegraph, obstacles, ImpactFX and RippleFX precede
   battle enemies, brush and characters. Shadows precede their characters;
   Midio's afterimages precede his core.
3. Epicycles/drop shockwave, Midasus, character reflections, battle FX and
   gnat precede the foreground veil and transposition wave. Fracture drawing
   has been removed; its simulation timing still exists.
4. After restoring the camera transform, the opening assembly captures the
   clean world composite **before post-processing and HUD**.
5. Fever aura → hype frame → drop impact → drop motion blur → bloom → heat
   distortion → film finish. Pixel-sampling passes use the physical backing
   store at identity transform; logical overlays use the stage transform.
6. HUD/seek strip follows post-processing. Assembly shards follow the HUD.
   Optional retro palette quantization follows assembly. Freeze and highlight
   capture use the completed frame.

Ambient heat distortion grows toward the ground in backing-store coordinates;
it is no longer strongest at the top. Radial drop distortion remains a
separate contribution.

## Seeking and lifecycle

Seeking rebuilds playback simulation/renderer state at the destination,
clearing future transformations, cooldowns, disasters, trails and frame
history. Song, seed, world, presentation preferences, recording and paused
state are retained. Skipped events are advanced silently, destination scene
state and interpolation are initialized, and future anticipation is primed.
Score/holds and spatial origin restart as a new performance segment. This
is a fresh destination state, not replay of every earlier random particle.

## Verification and remaining acceptance work

| Area | Evidence in the repository |
| --- | --- |
| Impact saturation, separate feedback pool, flash handling, spawn scaling | `test/impactFX.test.js` |
| Ripple curves and scaled feedback | `test/rippleFX.test.js` |
| Brush lifetime, scaling, culling and future timestamps | `test/rainbowBrush.test.js` |
| Hype border, both shockwave rings, shock blits and speed-line opacity/compositing | `test/rendererFlash.test.js` |
| Backing-store sampling and blur | `test/rendererDrawables.test.js` |
| Governor shedding, grace and recovery | `test/perf-governor.test.js` |
| Observed particle draw counts | `test/perfGovernorConsumers.test.js` |
| Interior sky exclusions and retained shafts | `test/interiorSky.test.js` |
| Specialized-world blit/shading argument alignment and material mode | `test/worldKindShading.test.js` |
| Heat displacement envelope; skipped under reduced motion | `test/heatDistortionComposite.test.js` |
| Production composition order and presentation/capture boundary | `test/rendererComposition.test.js` |
| Composed cut flash, normal and reduced flashing | `node tools/vfx-accessibility-smoke.mjs <out> <source-root> <captured-audio.wav>` (injects a returning cut over a real v2 frame) |
| Range capture across q0–q6, both preferences, Natural/Pixel/Palette, lake and inland | `npm run visual:eval -- --manifest test/fixtures/visual-evaluation-vfx.json --case <id>` |
| World material light pixels | `npm run test:lighting` |
| Static shading containment | `npm run test:shading` |
| Whole-system effect lifecycle across seeks | `npm run test:seek` |
| Upload/playback/replacement/stop | `npm run test:smoke` |
| Eight-world selection/playback/seek, preference chips, paint checks and two-frame City/Redline/Understory geometry | `npm run test:worlds` |
| Legacy Range fallback and Pixel/Palette worlds | `npm run test:retro` (kept out of the strict Range v2 capture) |

These commands run locally (see `docs/local-validation.md`). The manually
dispatched `.github/workflows/test.yml` covers lint, unit tests and the core
upload/playback smoke; Pages deployment does not depend on it and checks only
the staged artifact's bootstrap and playback.
The world smoke explicitly rejects astronomical painting in Fathom/Nave.
Browser liveness, isolated pixel checks and unit tests do not establish
subjective appeal, exhaustive accessibility or real-device sustained FPS.

Still required:

- Human holdout reviews for appeal and musical timing. The checked-in holdout
  has eight tracks and zero reviews: `met: null`, `calibration: empty-holdout`.
  Do not claim the acceptance target has been met. See
  `docs/world-quality-evaluation.md` and `npm run eval:worlds -- --split holdout`.
- A device/scene matrix covering 1080p/4K, long tracks, sustained overload and
  recovery, plus complete simulation/audio/compositor costs. Repeated draws
  of one state measure JS submission only, not FPS or GPU completion.
- Per-world review of shared character outlines, trails, rings and bloom
  after the material-lighting fixes. Overlay dominance is an art-direction
  observation, not a demonstrated defect for every song.
- Manual screen-reader and broader assistive-technology review of the chooser
  and the preference chips, and a final-frame flash assessment. Automated tests
  cover keyboard behavior at 1280×800 and 390×844, not every browser/device or
  screen-reader combination. The composition test pins the top-level order;
  it does not cover every per-pass ordering invariant.
