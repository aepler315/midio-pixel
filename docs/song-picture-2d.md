# A 2D picture of the song (design note, 2026-11-27)

## Songprint 2D experiment

Under **Settings → Appearance → Song visualization**, choose **Songprint 2D**
before loading a song or starting the sample. The setting applies to the next
song. Playback, seeking, and MP4 export use that song's selected mode.

The artwork grows from the centre as the song plays. Pitch-class evidence
shapes its rings, tone sets their colour, and the strip below follows the song's
energy and section boundaries. Frame time clips one cached raster to the current
ring contour. The analysis uses Midio Pixel's reduced mono audio. It is an
adaptation of Songprint Fable, and cannot represent stereo width. A timeline or
energy-only score supplies the picture when Fable analysis is unavailable.

The geographic options below are design explorations.

## The question

Does Midio Pixel need a 3D world? The 3D landscape earns its keep in a few
places: real lighting on measured rock, parallax that reads as depth, and a
camera that can circle a summit. It also brings most of the project's cost:
LOD budgets, tile coverage and occlusion baking, admission control on the
JOYING head unit, camera rails, clearance probes and shot planning. The
camera work in the same PR as this note is a good example. Most of it exists
to stop a free 3D camera from doing something ugly.

A song is a line in time. Its structure (intro, verses, builds, drops, the
bridge, the last chorus, the cadence) already reads left to right. A 2D
picture can carry that structure directly and give up very little of what
makes the current scenes good, provided it keeps two things: the real
measured peaks and the slow, unnoticed growth into something menacing.

Constraints carried forward from earlier decisions:

- each song gets its own range from its Songprint (song DNA); two songs never
  share one range in different shapes;
- real measured peak scans placed by the song (procedural jagged peaks read
  as "too N64"; the river valleys are out);
- the range grows without the viewer noticing until it is suddenly huge;
- Midio, Broshi and Midasus are back in the show;
- scenes export cleanly to 16:9 video for the YouTube channel;
- heard song time controls everything, so seek, replay and export agree.

## What the repo already has for 2D

More than it looks like:

- `src/world/terrain/SkylineScan.js` and `songprintSkylines.js`: measured
  skyline outlines baked beside the catalog, and `tools/build-songprint-skylines.mjs`
  already matches a song's 16-height Songprint outline against surveyed
  silhouettes.
- `ProfileTravel.js`: music-driven travel along a scanned ridge profile, fitted
  to its strip, with a deterministic heard-time integral.
- `RidgeComposition.js`, `CrestLine.js`, `CrestPixelColors.js`: fitting real
  ranges to the screen and stroking pixel crests and shorelines.
- `SilhouetteGenerator.js`, `RidgePortrait.js`, `GeoCrest.js`, `SpaceRidge.js`
  and the painted renderer (`?rangeRenderer=legacy`): a working parallax
  painter with song-derived outlines and live spectral crests.
- `ComposerStrip.js`: the whole song drawn as one energy silhouette.
- Audio side: sections with roles and trust, the 7-band spectrum, stems,
  onsets, pitch tracking, Songprint passages (recurring 12 s phrases) and
  phrase families, all on the heard clock.
- `LandscapeScore`, `CinematicPulse`, `LandRise`/`StageRise`: heard-time
  construction and accent scores that do not care how the picture is drawn.
- Sky, weather, celestial and mood scores, and frame-by-frame MP4 export.

## Direction A: the long scroll

The song is one panoramic transect, drawn left to right at song tempo.

- **Picture.** Five to seven parallax layers. The far layers are measured
  skylines picked by the Songprint outline (the existing skyline matcher);
  the near layers are foothills and a foreground platform where the three
  performers travel.
- **Structure.** x is heard time. Each section is a stretch of country; its
  energy sets the scroll rate (ProfileTravel already does this). A returning
  Songprint passage brings the same massif back, seen from a different
  distance, so a chorus is a place you recognise. The bridge is a gap, a pass
  or a lake. The cadence is where the land runs out.
- **Growth and menace.** The far layer rises with `StageRise`, but its
  parallax ratio stays tied to its true distance, so it barely moves on screen
  while the near layers stream past. The eye anchors to the foreground and
  misses the far range swelling, until the last chorus pulls the haze off and
  the range is twice the height it was at the second verse.
- **Performers.** Midio, Broshi and Midasus run, jump and gesture on the
  platform, timed to onsets and section roles. The scroll gives them a reason
  to move.
- **Camera.** One axis (x) plus a slow lens. A whip pan is impossible by
  construction.
- **Cost of losing 3D.** Lighting on rock becomes painted or baked; you never
  circle a summit.

## Direction B: the elevation drawing

The whole song is visible at once as a cross-section that fills in.

- **Picture.** A single wide elevation, like a survey drawing or the
  ComposerStrip enlarged into the art. The song's range sits on a baseline
  across the full frame; the playhead is a band of light that moves across it.
- **Structure.** Sections deposit strata under the playhead: bass and kick
  build bedrock, mids build slopes, highs lay snow and crest detail.
  Recurring passages uplift the same formation again. By the end the frame
  holds the song's whole form as one mountain chain.
- **Growth and menace.** The vertical scale is fitted to the final height
  from the first frame, so early sections look like low hills on a huge empty
  canvas. The emptiness is the threat; the last chorus fills it.
- **Performers.** Small, on the baseline, walking with the playhead. Their
  size against the final chain sells the scale.
- **Camera.** A slow push in on the playhead and a pull back to the full
  drawing at the cadence. The final frame is a ready-made thumbnail and a
  printable portrait of the song.
- **Cost.** Less journey; the song reads as a diagram more than a place.

## Direction C: the diorama

Flat cut-out layers at real depth ratios, one layer per part of the band.

- **Picture.** Each layer is an impostor strip baked from the existing
  measured terrain packages: the 3D engine renders each measured massif once,
  offline or at song admission, with its real lighting and snow, into a wide
  strip. Playback composites the strips in 2D.
- **Structure.** Stems drive layers. Drums move the foreground rocks and dust,
  bass lifts the near range, harmony the middle range, melody the far skyline,
  vocals the sky and aurora. Sections relight the whole diorama; recurring
  passages re-light the same layer the same way.
- **Growth and menace.** The back layer grows a few pixels per bar, with
  haze held constant so it never draws attention, until a drop clears the
  haze and the scale arrives all at once.
- **Performers.** On the front layer, lit by the same baked key light.
- **Camera.** Lateral truck and lens only.
- **Cost.** A bake step and memory for the strips; relighting for day and
  night needs normal or height strips alongside colour.

## Recommendation

Build **A on C's engine**: the long scroll, drawn from impostor strips baked
from the measured terrain the project already has.

Why:

- It keeps the real peaks with their real light. The 3D renderer becomes a
  bake tool, so the Songprint stage composition, the measured massif
  catalogue and the terrain materials all carry over.
- Song structure maps onto x for free, and returning passages become
  returning places, which is the clearest way to make a song's DNA visible.
- The unnoticed growth works better in 2D. Parallax lets the far range swell
  while the eye is busy with the foreground.
- The performers get a stage and a direction of travel again.
- The camera problem disappears. Frame cost becomes predictable, which suits
  the JOYING target and long exports.
- 16:9 scroll footage is the natural YouTube format; silent landscapes and
  narrated scrolls fall out of the same renderer.

What to keep: the heard clock and every score (`LandscapeScore`,
`CinematicPulse`, rise and stage rise, weather, sky, celestial, mood), the
Songprint analysis and skyline matcher, the measured massif catalogue and
stage composition, the material and lighting code (as the bake), crest and
pixel presentation, the MP4 exporter, settings and verification tooling.

What to park: live 3D terrain draw, LOD and residency for terrain tiles,
camera rails, shot tours, Camera Studio, clearance probes, forest GL.

## First step

A spike behind an experimental setting, no engine rewrite:

1. Bake one composed song's principal and companion massifs into two wide
   colour + height strips from the existing stage, at the core lens.
2. Draw them as the far layers of the painted renderer, with ProfileTravel
   scrolling and `StageRise` scaling the far layer.
3. Put one performer on a foreground platform.
4. Export 60 seconds and compare it with the 3D scene on the same song.

If the spike looks right, Direction B is worth keeping as an ending card: at
the cadence, pull back from the scroll to the whole song's elevation.

## Open questions

- Strip resolution and memory for a 4 to 6 minute song on the head unit.
- How far baked lighting can follow the day/night score; whether height
  strips are enough for a cheap relight.
- How to keep provenance labels honest when a measured massif is scaled for
  menace (the visual contract already asks for this in 3D).
- Whether the performers' art should be pixel sprites at the terrain's pixel
  grid or drawn at output resolution.
