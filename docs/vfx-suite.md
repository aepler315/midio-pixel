# Visual Effects Suite — implementation and verification

Checked against the implementation on October 13, 2026, and updated for the
two worlds (Landscape and Trio) on October 21, 2026, and for the VFX audit
packages merged on October 28, 2026. This document separates
what the default Range draws today from what Trio adds, from Canvas modules
that are present but dormant, and from the optional WebGL overlay. Audio
analysis lives elsewhere; the renderers consume its output rather than
analyzing audio themselves.

## Active on the default Range (v2)

Landscape resolves `performers: false` (`src/world/LandscapePresentation.js`):
listening owns the landscape from frame zero. Trio resolves
`performers: true`; see [Trio's draw order](#trio-draw-order-performers-on).
What the listener sees on the default Range comes from the GPU scene
(`src/world/alpine/RangeScene.js`) composited into the Canvas frame, plus a
few Canvas passes around it.

| Effect | Owner | Notes |
| --- | --- | --- |
| Terrain (far / mid / near partitions) | `RangeScene`, `TerrainMaterial`, `TerrainMesh` | One shared depth pre-pass; current Pixel/Palette do not enable the historical Natural/MSAA path (`RangeRenderPolicy`) |
| Forest | `ForestCover`, `ForestGL`, `ForestWind` | Near instanced conifers, mid silhouettes, canopy texture beyond; wind and gust fronts at heard time. The score and the storm set the sway's gain, and storms lean the crowns downwind along the clouds' wind (`forestWindAt`) |
| Water | `WaterMirror`, `WetReflection`, `TerrainMaterial` | Lake mirror (q0–q3; eases in on recovery, drops at once on a shed). Water and rivers reflect a height-graded sky (`skyReflectAt`) and, through q4, the captured sky backdrop, independent of the mirror; lightning lifts the reflected sky |
| Fog, mist, cloud sea | `RangeAtmosphere`, `ValleyAtmosphere`, `CloudSea` | Fog samples per pixel fall at q3, q5 and q6. The score's slow energy thins and lights the mist, section lifts add only a small share (`atmosphereMusic`), and mist glows toward the key light (`mistPhase`) |
| Sky | `RangeSkyRenderer`, `SkyPerformance` | Twilight glow at the azimuth of the sun's real position, also below the horizon (not where the body parks overnight), plus a full-width Belt of Venus that fades as the heading turns from the antisolar point. Sun glare follows only the slow radiance (at most +15% alpha, +8% extent); the note pulse lifts only the sun's tight bloom and the moon's night aureole. One daylight sweep from q2; night melody streaks (one hairline at a time) shed from q3; the Milky Way fades over 1.5 s across q3 |
| Clouds, storm, rain, lightning | `RangeSkyComposition`, `RangeStorm`, `CloudOcclusion` | Each weather episode is a shower, downpour or thunderstorm (`STORM_KINDS`), evaluated at heard time; showers stay at or under 0.6 and never flash. Rain curtains are world-anchored (`rainCurtainAz`, compass azimuth and song seed) and turn with the deck; sky glow, land key and stage key share `flashScreenPoint`, and the flash repaint uses its own 8-sprite tint pool. Fair-weather banks cast soft world-plane shadows on the land (at most 0.4, q0–q3, fading over 1.5 s on a rung change) |
| Sun shafts | `SunShaftGL` | Optional; fade out at q3 over heard time (`easeRungAmount`), surviving same-size target reallocations. The score lifts their gain (at most 1.4) |
| Lane lanterns and motes | `RangeActors`, `ActorsGL` | Drawn inside the band passes, so nearer land hides them and the mirror reflects them. Each lane's note onsets pulse its halo and motes (180 ms decay, damped on busy runs); its smoothed pitch, scaled to its own range, sets the swarm's vertical spread (0.75–1.25). Their light on the land never pulses |
| Lens accent and reframe | `CameraLens`, `LandscapeScore`, `CameraDirector` | Automatic scenic punch is Off in Landscape: neutral lens in Simulation, RangeFrame and frame performance, with no pulse FOV, compositor dip or pulse-driven tilt, including loading/fallback. Trio retains trusted chorus/drop and rising-boundary accents, held across analysis handoffs, half strength for inferred boundaries and neutral in previews. Impact roll, base framing, slow scenic moves and manual zoom remain available |
| Finishing | `Renderer._drawBloom`, `_drawHeatDistortion`, `_drawFilmFinish` | On the physical backing store, in the order listed below. Bloom skips alpine worlds, so it is off in both. Landscape's vignette is `landscapeFinish` over the frame's shared score |
| Crest line and shorelines | `RangeCrest`, `CrestProbe`, `CrestLine` | Steadied dark crest per band and pale shorelines at output resolution, split cells before palette (Pixel sheds them from q2); the skyline line is 1.5–1.75 px at 1080 lines, the most opaque but thinner than the near band's; probe off and palette-frame skyline scan from q4 ([pixel-presentation.md](pixel-presentation.md#crest-line-landscape)) |
| Final presentation | `PresentingRenderer`, `PixelPresentation` | Natural, Pixel or Palette; display and capture read the same finished source. The opt-in World palette follows the experience (Landscape32 in Landscape, Chroma32 in Trio). Cinematic display and capture share one union-sized cell buffer, so recording at another size does not reallocate it each frame |

The Range quality ladder (`RangeQuality.rangeQuality`): q2 lighter near-tree
assets and 2x MSAA, q3 fewer fog samples, no shafts and no MSAA, q4 no lake
mirror or cloud shadows, and 12 of the cast's 32 fixed-line lights
([landscape-cast.md](landscape-cast.md)), q5 no water sky backdrop.
Shafts, cloud shadows and the dropped fixed-line lights fade over 1.5 s of
heard time (`easeRungAmount`); the mirror fades only on recovery.
Rock-stage pools are dormant on catalog v2 views. Landform structure,
ground contact and the musical signatures are never shed. With no trusted
phrases the cast keeps its section stays, so views camp and resume; only the
climax moves to the energy climax, and a climax view borrowed from a
neighbouring section finishes in the stay it was borrowed from.

### Current composition order

Pinned by `test/rendererComposition.test.js`, which runs the production
`Renderer.draw` over a real `BiomeManager`:

1. The Range receives this frame's viewports (`setFrameInputs`).
2. Sky, then scenic partitions far → mid → near, with the Canvas passes
   that belong between them (`test/rangePresentation.test.js` pins those).
3. Ground response and legacy foreground hooks (dormant after catalog-view arrival).
4. Finishing on the physical backing store: bloom (skipped in alpine
   worlds) → heat distortion → film finish. Landscape's vignette is
   `landscapeFinish` over the frame's shared score (energy, lift, kick,
   storm amount), snapshotted with the deferred post frame so a capture
   replay matches the display: the edge stays within .10–.36, deepens in
   quiet passages, opens on a section lift, and a kick widens only the
   onset. HUD (when shown) and the range caption follow.
5. `PresentingRenderer` finishes the frame (Natural/Pixel/Palette) from the
   same source the capture reads: crest split cells before palette, then
   sky → terrain → crest line → water → shorelines → mid effects → cast.
   A failed scene draw never publishes.

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

The impact, ripple and brush effects below are implemented and unit-tested,
but neither world constructs or draws them: Landscape has no performers, and
Trio's cast (`Renderer._drawTrioCast`) draws Broshi, Midio and Midasus with
their contact shadows rather than these pools. Murmuration has no draw
consumer either. They are kept, not deleted, and are not part of the active
look. OrbitalDebris is the exception: Midasus carries it, so it draws in Trio.

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
`wx - worldX + originX`. Its constructor takes a seed for its random stream.

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
the entire brush is gated at governor level 5.

Murmuration and OrbitalDebris (Midasus's shards, live in Trio) render a
bounded subset of their fixed simulated collections. The draw multiplier
affects emitted wing segments/triangles, not the size of the simulation
arrays. Zero or negative multipliers emit no geometry; values above one
cannot read beyond the collection.

## Lighting and world boundaries

`LightField` resolves a shared celestial light and local ground/character
lights. Celestial intensity is
`budget * (1 - unravel) * (1 - 0.5 * dayArcAlpha)`. `unravel`
(`CodaDirector`, heard time) eases 0→1 over 14 s, ending 1.5 s after the
song's cadence: its last audible frame by the shared EffectsMusic silence
gate (`lastAudibleMs`), and never later than 4 s before the file's end.
Without usable curves, or on an opening analysis, it keeps the file-clock arc
[duration − 18 s, duration − 4 s]. The Landscape camera finale starts 20 s
before the same cadence and arrives on it.

Song adaptation preserves each stock palette's `edgeLight` (the ridge wire
some palettes carry); intentionally unlit stock palettes stay unlit. Both
worlds are the alpine kind and draw the dancing ridges. `npm run test:shading`
still checks that ridge-volume shading on a static strip stays inside that
strip's bitmap, although no world draws static strips any more. The alpine
identity allows astronomy, so the shared sky renderer keeps its astronomical
layers: stars, galactic layers, and the aurora and nebula bloom of palettes
that carry them (`test/interiorSky.test.js` pins that the open sky paints
them). The final film grade remains a separate, shared color treatment.

Protected hues remain Midio (`178°`), hazard (`#ff4d4d`) and reward
(`#ffd75e`). `VisualStyle.styleDials()` is authoritative for shared style:
current bloom multiplier 0.9, film grade 1.45, vignette 1.08, glow halo 0.95
and rim amount 0.95. World identity still needs visual review across songs;
those numbers alone do not establish balanced compositions.

## Flashing

The show contains flashing lights, camera shake and sudden cuts. These
implementation notes do not constitute a photosensitivity certification or
exhaustive flash audit.

Lantern note pulses are local to the motes and halos. On a note a mote's
twinkle steadies to full and lifts 25%, reaching about 1.7x its average
brightness (up to 2.5x at a twinkle trough), and the halo grows up to 18%.
Dense lanes are damped to 0.8 of a single note's pulse, so a 16th-note line
peaks near 1.5x and swings about 1.25–1.5x at the note rate. The lanterns'
ground light, terrain and hues do not pulse. Showers never flash; lightning
belongs to downpours and thunderstorms.

## Performance governor

`PerfGovernor.sample()` receives the **rAF frame period**, including vsync
wait, not JavaScript draw cost. Its threshold is **18.5 ms at 60 FPS**, or the selected 30 FPS period plus
the same 1.83 ms jitter allowance (about **35.17 ms**).

- Song/world construction, returning from a hidden tab, playback
  preparation and resuming from pause each start a **2,500 ms warmup
  grace**; those frames do not vote on shedding, and paused time never
  counts toward a clean recovery window.
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
| 2 | Particle multiplier 0.6; disable rim lighting (including Trio's cast lights) and the drop shock (speed-lines stay, thinned) |
| 3 | Disable contact shadows (Trio's cast), crack-glow capability and bloom; columns 64 px |
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

## Trio draw order (performers on)

Trio is the one world with `performers` enabled. The boundaries in
`Renderer.draw()` are:

1. Sky/parallax/phenomena use the zoomed view. The deep sky (Midasus's
   voyages and Star Atlas, `BiomeManager.drawDeepSky`) draws before the sun
   or moon, behind the ranges. The world renderer then switches to the fixed
   ground view for ground, footing and flood.
2. The cast (`_drawTrioCast`) on that ground: Broshi, then Midio, then
   Midasus with her orbital debris, each after its own contact shadow.
   Midasus away on a voyage is drawn by the deep sky instead. Each
   character is also lit by the others' glow (Midasus's core, Midio's beat
   flash), and its contact shadow follows the light, never below .45
   strength.
3. The foreground veil, then the transposition wave. Fracture drawing has
   been removed; its simulation timing still exists.
4. After restoring the camera transform, an opening assembly would capture
   the clean world composite **before post-processing and HUD**. Neither
   world constructs one, so this hook is dormant.
5. Hype frame → drop impact → drop motion blur → heat distortion → film
   finish. Bloom is off in both worlds: `_drawBloom` skips alpine worlds to
   keep the luminous crest lines clear. Pixel-sampling passes use the
   physical backing store at identity transform; logical overlays use the
   stage transform. Landscape skips the first three, which are performer
   passes. In Trio the hype frame, drop impact, drop motion blur and drop
   heat lens run on heard time.
6. HUD/seek strip follows post-processing; the dormant assembly's shards
   would follow the HUD. The Palette look is applied afterwards, in
   `PixelPresentation`. Freeze and highlight capture use the completed frame.

Ambient heat distortion grows toward the ground in backing-store coordinates;
it is no longer strongest at the top. Radial drop distortion remains a
separate contribution. Wildfire heat applies only where the fire is drawn
(never in alpine worlds). The radial drop lens needs visible performers
(Trio) and centres on the ground under Midio. Both run on heard time.

## Seeking and lifecycle

Seeking rebuilds playback simulation/renderer state at the destination,
clearing future transformations, cooldowns, disasters, trails and frame
history. Song, seed, world, presentation preferences, recording and paused
state are retained. Skipped events are advanced silently, destination scene
state and interpolation are initialized, and future anticipation is primed.
Score/holds and spatial origin restart as a new performance segment. This
is a fresh destination state, not replay of every earlier random particle.
Trio lens accents, the reframe's tilt side and the coda are pure functions of
heard time and song analysis, so a seek lands on the same state as
continuous play.

## Verification and remaining acceptance work

| Area | Evidence in the repository |
| --- | --- |
| Impact saturation, separate feedback pool, additive ignition ring, spawn scaling | `test/impactFX.test.js` |
| Ripple curves and scaled feedback | `test/rippleFX.test.js` |
| Brush lifetime, scaling, culling and future timestamps | `test/rainbowBrush.test.js` |
| Hype border, both shockwave rings, shock blits and speed-line opacity/compositing | `test/rendererFlash.test.js` |
| Backing-store sampling and blur | `test/rendererDrawables.test.js` |
| Governor shedding, grace (including resume from pause) and recovery | `test/perf-governor.test.js` |
| Observed particle draw counts | `test/perfGovernorConsumers.test.js` |
| Open-sky astronomical layers | `test/interiorSky.test.js` |
| Heat displacement envelope | `test/heatDistortionComposite.test.js` |
| Trio cast lights and contact shadows | `test/trioCastLighting.test.js` |
| Landscape vignette on the shared score | `test/filmFinish.test.js`, `test/landscapeFilm.test.js` |
| Universe dip restored on Range views (C3) | `test/stageZoom.test.js` |
| Range sky twilight, sweeps and streaks | `test/rangeSkyTwilight.test.js`, `test/skyPerformance.test.js` |
| Storm kinds, world-anchored rain and flash point | `test/rangeStorm.test.js` |
| Cloud shadows, shaft and mist music, rung fades | `test/cloudOcclusion.test.js`, `test/sunShaft.test.js`, `test/rangeAtmosphere.test.js`, `test/rangeQuality.test.js` |
| Lantern pulse and spread | `test/rangeActors.test.js` |
| Lens trust and handoff, cadence-anchored coda | `test/cameraLens.test.js`, `test/landscapeScore.test.js`, `test/codaDirector.test.js`, `test/effectsMusic.test.js` |
| Production composition order and presentation/capture boundary | `test/rendererComposition.test.js` |
| Range capture across q0–q6, Natural/Pixel/Palette, lake and inland | `npm run visual:eval -- --manifest test/fixtures/visual-evaluation-vfx.json --case <id>` |
| Static shading containment | `npm run test:shading` |
| Whole-system effect lifecycle across seeks | `npm run test:seek` |
| Upload/playback/replacement/stop | `npm run test:smoke` |
| Landscape and Trio selection/playback/seek, per-pass paint checks and Midasus's deep-sky voyage | `npm run test:worlds` |
| Trio pixel/palette captures, chooser preview and live/paused world switches | `npm run test:trio` |
| Legacy Range fallback and Pixel/Palette worlds | `npm run test:retro` (kept out of the strict Range v2 capture) |

These commands run locally (see `docs/local-validation.md`). The manually
dispatched `.github/workflows/test.yml` covers lint, unit tests and the core
upload/playback smoke; Pages deployment does not depend on it and checks only
the staged artifact's bootstrap and playback.
The world smoke fails if Trio's cast or deep sky runs in Landscape, or the
aurora space ridge runs in Trio. Browser liveness, isolated pixel checks and
unit tests do not establish subjective appeal, exhaustive accessibility or
real-device sustained FPS.

Still required:

- Human holdout reviews for appeal and musical timing. The checked-in holdout
  has eight tracks and zero reviews: `met: null`, `calibration: empty-holdout`.
  Do not claim the acceptance target has been met. See
  `docs/world-quality-evaluation.md` and `npm run eval:worlds -- --split holdout`.
- A device/scene matrix covering 1080p/4K, long tracks, sustained overload and
  recovery, plus complete simulation/audio/compositor costs. Repeated draws
  of one state measure JS submission only, not FPS or GPU completion.
- Review across songs of Trio's character outlines and trails over the
  procedural ranges. Overlay dominance is an art-direction observation,
  not a demonstrated defect for every song.
- Manual screen-reader and broader assistive-technology review of the chooser,
  and a final-frame flash assessment. The composition test pins the top-level
  order; it does not cover every per-pass ordering invariant.
