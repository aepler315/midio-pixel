# Worlds — Landscape and Trio

**Status:** the app has two worlds, registered in `src/world/Worlds.js`.
Every song is played in one of them, picked per song from the chooser.

| World | `id` | `kind` | `experience` | Palettes | Ranges |
| --- | --- | --- | --- | --- | --- |
| **Landscape** | `alpine` | `alpine` | `landscape` | Real biomes (`RealBiomes.js`) | Real terrain, presented by Range v2 and its tours |
| **Trio** | `trio` | `alpine` | `trio` | The invented `BiomeProfiles.js` palettes | Procedural, dancing ridges, with Midio, Midasus and Broshi performing |

- **Landscape** is The Range on real terrain: each real biome on its own real
  ranges, matched to the song in the background while the chooser is up.
  Range v2 draws them with WebGL2; when it cannot, the painted Range keeps
  playback running. The Teton camera tour belongs here.
- **Trio** is the Range as it was before real terrain arrived, with the cast
  performing on it: the crystalline space ridge, the seeded sky ensemble and
  Midasus's deep-sky voyages. See [Trio](trio-stage.md).

Seven other worlds (After Hours, Far Side, The Fathom, Redline, The Foundry,
Understory and The Nave), and the earlier Cathode, have been removed. Their
art direction lives in this file's git history.

## One kind, two presentations

A biome is a palette that rotates inside a world; a world is the landform
contract those palettes paint onto, and its `kind` names that contract. Both
worlds are the `alpine` kind, so `BiomeManager` draws both through its one
alpine path. `experience` says which presentation a world gets:
`worldExperience(id)` reads it from the registry, and
`LandscapePresentation` turns it into the frame's switches. Landscape draws no
performers; Trio draws the cast, the sky ensemble and the crystalline space
ridge. `Simulation` loads real terrain only for `realBiomes` worlds, so Trio's
ranges stay procedural.

Lookups fall back rather than fail:

- `resolveWorldId` resolves an unknown id to `alpine` (Landscape). That
  includes the removed worlds' ids (`nocturne`, `farside`, `fathom`,
  `redline`, `foundry`, `understory`, `nave`, `cathode`), so an old link or a
  saved playback id still plays.
- Per-kind policies keyed by `kind` fall back to the alpine entry for a kind
  they do not know: identity (`identityFor` in `WorldIdentity.js`), material
  (`materialFor` in `WorldMaterial.js`) and adaptation capabilities
  (`capabilitiesFor` in `WorldAdaptation.js`).

## What a registry entry declares

| Field | Meaning |
| --- | --- |
| `id`, `name`, `tagline` | The card's identity |
| `kind` | The landform contract the draw path and the per-kind policies read |
| `experience` | `landscape` or `trio`: which presentation the world gets |
| `comfort`, `prefer`, `affinity` | The private fit's inputs (below) |
| `channels` | Scored signals; each names the renderer `consumer` (`file#symbol`) that actually uses it. A scored channel with no consumer is not a measurement |
| `palettes`, `temperature`, `cast` | The biomes the world rotates through and how a song casts them |
| `realBiomes` | Landscape only: play on real terrain |

## Song adaptation

**Play** builds a song-specific instance of the chosen world
(`buildWorldVariant` in `WorldScore.js`, `adaptWorld` in
`WorldAdaptation.js`): palette, terrain variation and musical response
adapted to the song. Its public id is `custom` and it records the world it
came from as `baseId`. The adapted instance is the card's play target, never
a second card. A dense mix is filtered rather than amplified.

What must survive adaptation is the world's identity (`WorldIdentity.js`):
its landmark, signature motion, light source, palette floor and the shared
effects its setting allows. Adaptation may change color, timing and terrain
variation; it may not lose those.

## The chooser

Once a song is analyzed, the chooser (`#worldSelect`) opens with one equal
card per world, in registry order (`buildWorldChoices` in
`src/ui/WorldChooser.js`). There is no recommendation, no winner styling and
no public score.

- **Preview** plays the same quiet or peak stretch of this song in that
  world (`pickPreviewPassages` in `src/ui/WorldPreview.js`), so a comparison
  uses the same moments. One passage plays at a time, and preview audio and
  clocks cannot leak into playback. The Landscape card's still is labeled
  "Range illustration. Playback uses a 3D landscape."
- **Play** starts the song in that world.
- A page opened with `?experience=landscape` or `?experience=trio` has
  already chosen: songs start straight in that world with no chooser.
  Landscape first waits up to 2.5 s for the song's ranges (then starts on the
  bundled Tetons), an export waits for every biome, and Trio starts at once.
- The **World** setting switches worlds mid-song; the scene is rebuilt at the
  heard position and the recording keeps playing. The last choice is
  remembered (`midio-pixel:experience:v1`) but does not skip the chooser.

`node --test test/worldPreview.test.js test/worldChooser.test.js` pins the
passage picker, copy, cache, the one-at-a-time session and the card set.

## The private fit

`scoreWorlds` (`WorldScore.js`) still rates how well each world's response
would sit with the song, after adaptation: `extractWatchFeatures()` reduces
the song to one vector, scored against each world's `comfort` band, `prefer`
ranges and declarative `affinity` weights. With two worlds the player picks,
so nothing in the chooser reads it. It is recorded as a fit readout in the
debug overlay and in the private review sheets of
[world quality evaluation](world-quality-evaluation.md).
`test/worldScore.test.js` pins it.

## Musical behavior

The ranges share their musical controls with `WorldMusic.js`:

- The mountains grow with the song and change scale with each section.
  Ambient travel of the ridge is a 1.2 s energy average -- quiet songs keep a
  slow atmosphere, a groove breathes, and dense material settles so a wall of
  guitars does not strobe the skyline. Bass swells the flanks. Phrase
  boundaries that earned a lift add a brief extra scale; decorative cuts do
  not. Isolated accents sharpen a summit on a quiet song; dense material
  raises the floor so only stronger hits mark the ridge. Groove is derived
  from the clock, not a one-pole, so a backward seek cannot keep the previous
  passage's heave.
- In Trio the cast performs as well: Midio jumps to kicks and lead accents,
  Broshi hops with the bass, and Midasus follows the melody and flies her
  deep-sky voyages ([Trio](trio-stage.md)).

These controls consume existing energy curves and conductor rhythm events.
No tempo is invented for unmetered songs, and no persisted analysis schema
changes are required. The averaging includes intervening samples so rapid
periodic bass cannot alias into a full-strength pressure flash.

## Verification

Start the app and run `npm run test:worlds`. It uploads one generated
32-second quiet/loud/quiet fixture to both worlds with seed 315, picks each
through the chooser, and checks actual rhythm delivery, composed frames,
energy response and backward seeking. It sends Midasus to deep space in Trio
and saves screenshots plus a JSON report under `.smoke/worlds/`.

It also runs a **per-pass paint audit**: it wraps individual draw passes,
renders one frame at a pinned full-quality perf rung, and records how many
stage pixels each pass actually changed. A pass that runs and paints nothing
fails with its name attached, and a pass a world must never reach (Trio's cast
in Landscape, the aurora space ridge in Trio) fails if it runs. This exists
because judging the composed frame cannot catch a single dead pass —
BiomeManager's fata morgana ran every frame for a week while drawing zero
pixels (its call landed in a same-named method with a different signature)
and the frame was as colorful as ever throughout. Passes that may
legitimately paint nothing on a short fixture, such as `drawDeepSky` before
the Star Atlas fills, are recorded in the report rather than asserted.

`npm run test:trio` covers Trio end to end. `npm test` covers the control
timing, missing data, sustained versus transient bass, rapid drums and
boundary provenance. Synthetic fixtures establish behavior, not a listener
preference ranking.
