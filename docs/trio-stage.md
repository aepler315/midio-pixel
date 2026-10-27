# Trio

The app has two worlds, picked per song from the chooser once the song is
ready: **Landscape** (The Range on real terrain, presented by Range v2 and its
tours) and **Trio**. A page opened with `?experience=landscape` or
`?experience=trio` has already chosen, so songs start straight in that world;
links, exports and the smoke tools use it. The **World** setting (in Settings
on the title screen, and under Display during playback) switches worlds
mid-song: the scene is rebuilt at the heard position through the same playback
gate as a seek, and the recording keeps playing. The last choice is remembered
under `midio-pixel:experience:v1`; it no longer skips the chooser. The Teton
camera tour belongs to Landscape: in Trio its toggle is disabled and reads
"Available in Landscape", and a saved tour preference is kept for Landscape.

Trio is the Range as it was in Midio-5 before real terrain arrived (the
reference is Midio-5 `6b8130e`, the parent of the first terrain commit), with
Midio, Midasus and Broshi performing on it:

- **The dancing ridge.** No terrain profiles are loaded, so every L2–L5 layer
  is a procedural silhouette that dances with the kicks, groove and phrases
  (MountainChoreo), and the horizon EQ ridge draws its live spectrum.
- **The space ridge.** The crystalline node-and-segment line with its tumbling
  icosahedron (`SpaceRidge.draw`), not Landscape's aurora form.
- **The star system.** The generated star catalogue, the constellation weaver
  and the seeded planets, comets and other sky artifacts (`SkyEnsemble`), the
  whole planetary set rather than Landscape's single planet.
- **Midasus traveling to space to draw.** `ExcursionDirector` sends her on at
  most two deep-sky voyages per song, after the first 12 s and never in the
  last 25 s, when the mood holds epic or calm for four seconds. She sky-writes
  seeded mathematical figures (a chorus voyage writes its lyric), and finished
  figures crystallize into her Star Atlas, which glints with the hype and
  goes supernova four seconds before the end. `BiomeManager.drawDeepSky` draws
  all of it behind the ranges.

`Worlds.js` registers Trio as its own world (`id: 'trio'`, kind `alpine`,
the invented `BiomeProfiles` palettes, `experience: 'trio'`). The world
decides the presentation: `Simulation` loads real terrain only for
`realBiomes` worlds, and `LandscapePresentation` gives Trio performers, the sky
ensemble and the crystalline space ridge. `TrioPerformance` owns the cast's
choreography (Midio's kick jumps and lead accents, Broshi's bass hops,
Midasus's melody flight and her voyages) and stands them on the world's own
`GroundField`: the ground is drawn from a fixed origin (`TrioPerformance.originX`)
and each of the cast stands on it at their own screen x, so the cast and the
drawn ground agree. Effects anchored on Midio (the kick glow and ground
pulses, the drop speed-lines and heat lens, the spotlight snap) start from
where he stands (`TrioPerformance.midioWorldX`, `lerpState().midioDrawX`,
`BiomeManager.spotX`), not from the ground's origin. `Renderer._drawTrioCast` draws them with contact shadows
after the scenery and before the foreground veil.

Between the beats the cast wander rather than hold a formation around Midio.
`TrioWander` cuts each character's time into seeded intent segments (stroll
to a spot, pause and idle, watch a companion or the sky, wander over to
investigate one another; Broshi also sniffs about, Midasus visits and
stargazes), with travel likelier in loud passages and idling in quiet ones
(stays can follow stays, so a quiet stretch idles through several looks).
Each plan is a pure function of seed and heard time, so a seek lands where
continuous play would; that includes which side of Midio Broshi keeps.
Midio's spot and carriage come straight from it (his eye is aimed through
`TrioGaze`); Broshi's spring and Midasus's flight follow it in their `free`
modes. Broshi springs in absolute screen space (Midio's stroll does not drag
him), faces the way he is moving or else what he is watching, and leapfrogs
Midio's landing column to cross him; his bar surges keep only the pounce
coil, since a displacement counted from his own bar history would differ
after a seek. Midasus eases aside when Midio strolls in under her. The
music still owns the moves themselves. None of them leaves a drawn path:
Midio's jump ghosts, Broshi's comet motes and Midasus's flight ribbon are
gone (her note bursts, slashes, debris and baby stars remain).

Bulk export accepts `--experience landscape|trio`; the default is Landscape:

```sh
npm run export:bulk -- --experience trio --res 1080 --fps 30 --out exports song.wav
```

`npm run test:worlds -- http://127.0.0.1:8080` drives both worlds through the
chooser, playback, seeking and a per-pass paint audit, and sends Midasus to
deep space to check that the deep sky paints. `npm run test:trio -- http://127.0.0.1:8080`
covers Trio's pixel/palette captures, its chooser preview, live and paused
world switches, and rejects terrain, tour and material requests in Trio.
Captures stay outside Git.
