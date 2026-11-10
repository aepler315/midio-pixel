# Worlds — Landscape

**Status:** the app has one world, Landscape, registered in
`src/world/Worlds.js`. Every song plays in it.

| World | `id` | `kind` | Palettes | Ranges |
| --- | --- | --- | --- | --- |
| **Landscape** | `alpine` | `alpine` | Real biomes (`RealBiomes.js`) | Real terrain, presented by Range v2 and its tours |

**Landscape** is The Range on real terrain: each real biome on its own real
ranges, matched to the song in the background (see "Starting a song"). Range v2
draws them with WebGL2; when it cannot, the painted Range keeps playback
running. The Teton camera tour belongs here.

Trio (the pre-terrain Range with Midio, Midasus and Broshi performing), seven
other worlds (After Hours, Far Side, The Fathom, Redline, The Foundry,
Understory and The Nave) and the earlier Cathode have been removed. Their art
direction lives in this file's git history.

## One kind

A biome is a palette that rotates inside a world; a world is the landform
contract those palettes paint onto, and its `kind` names that contract.
Landscape is the `alpine` kind, which `BiomeManager` draws through its alpine
path. `Simulation` loads real terrain for `realBiomes` worlds. Landscape draws
no performers.

Lookups fall back rather than fail:

- `resolveWorldId` resolves an unknown id to `alpine` (Landscape). That
  includes `trio` and the other removed worlds' ids (`nocturne`, `farside`,
  `fathom`, `redline`, `foundry`, `understory`, `nave`, `cathode`), so an old
  link, a saved highlight or a saved playback id still plays.
- Per-kind policies keyed by `kind` fall back to the alpine entry for a kind
  they do not know: identity (`identityFor` in `WorldIdentity.js`), material
  (`materialFor` in `WorldMaterial.js`) and adaptation capabilities
  (`capabilitiesFor` in `WorldAdaptation.js`).

## What a registry entry declares

| Field | Meaning |
| --- | --- |
| `id`, `name`, `tagline` | The world's identity |
| `kind` | The landform contract the draw path and the per-kind policies read |
| `comfort`, `prefer`, `affinity` | The private fit's inputs (below) |
| `channels` | Scored signals; each names the renderer `consumer` (`file#symbol`) that actually uses it. A scored channel with no consumer is not a measurement |
| `palettes`, `temperature`, `cast` | The biomes the world rotates through and how a song casts them |
| `realBiomes` | Play on real terrain |

## Starting a song

Once a song is analysed it starts straight in Landscape. There is no world
picker. The start first waits up to 2.5 s for the song's own ranges (then
starts on the bundled Tetons), and an export waits for every biome so its
frames never depend on load timing. An old `?experience=` query parameter is
ignored.

## Song adaptation

Each song plays a song-specific instance of Landscape (`buildWorldVariant` in
`WorldScore.js`, `adaptWorld` in `WorldAdaptation.js`): palette, terrain
variation and musical response adapted to the song. Its public id is `custom`
and it records the world it came from as `baseId`. If the adaptation cannot be
built, the stock world plays instead. A dense mix is filtered rather than
amplified.

The current adaptation contract preserves the world's identity (`WorldIdentity.js`):
its landmark, signature motion, light source, palette floor and the shared
effects its setting allows. Adaptation may change color, timing and terrain
variation while retaining those elements. This describes the implemented
contract; task-authorized identity or adaptation experiments may evolve it under
the [experimental development policy](experimental-development.md), with relevant
compatibility and behavior checks updated alongside the change.

## The private fit

`scoreWorlds` (`WorldScore.js`) still rates how well the world's response
would sit with the song, after adaptation: `extractWatchFeatures()` reduces
the song to one vector, scored against the world's `comfort` band, `prefer`
ranges and declarative `affinity` weights. Nothing in the player reads it. It
is recorded as a fit readout in the debug overlay and in the private review
sheets of [world quality evaluation](world-quality-evaluation.md).
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

These controls consume existing energy curves and conductor rhythm events.
No tempo is invented for unmetered songs, and no persisted analysis schema
changes are required. The averaging includes intervening samples so rapid
periodic bass cannot alias into a full-strength pressure flash.

## Verification

`npm test` covers the control timing, missing data, sustained versus
transient bass, rapid drums and boundary provenance. `npm run test:smoke`
checks that an uploaded song starts straight in its tailored Landscape, and
`npm run test:landscape` and `npm run test:routes` cover the composed Range
frames and the ordinary staged routes. Synthetic fixtures establish behavior,
not a listener preference ranking.
