# Worlds — the other six

**Status:** all eight worlds now have registered render paths. The sections
below retain the original art direction; they are not a feature checklist.
The chooser presents equal choices and tailors each selected painterly world
to the song. Cathode is retired; old playback IDs resolve to The Range.

### Musical behavior: The Range, After Hours, Fathom, Redline, Foundry, Far Side, Understory, Nave

The painterly worlds share a small set of controls from
`WorldMusic.js`, while interpreting those controls differently:

- **The Range:** the mountains already grow with the song and change scale
  with each section. Ambient travel of the ridge is now the same 1.2s energy
  average -- quiet songs keep a slow atmosphere, a groove breathes, and dense
  material settles so a wall of guitars does not strobe the skyline. Bass
  swells the flanks. Phrase boundaries that earned a lift add a brief extra
  scale; decorative cuts do not. Isolated accents sharpen a summit on a quiet
  song; dense material raises the floor so only stronger hits mark the ridge.
  Groove is derived from the clock, not a one-pole, so a backward seek cannot
  keep the previous passage's heave.
- **After Hours:** lit windows, street lamps and the wet road share one glow
  envelope (`CityGlow.js`). A dimmed baseline tracks window occupancy and
  breathes on a slow cycle, so quiet passages recede rather than sitting at
  the same brightness as the rest of the song; the headroom that frees up is
  spent on blooms at section boundaries that earned one. A boundary earns a
  bloom by being a genuine step up in section energy and by arriving at a
  section that sits high in the song overall -- a continuation, a fall into a
  bridge, and a decorative pacing cut all get nothing. Measured over a real
  song this fires at two of ten boundaries, about 3% of its running time.
  Detected percussion still brightens one district at a time on top. Six pairs
  of traffic lights travel along the ground with restrained road reflections;
  percussion accents individual pairs without increasing their count or speed.
- **The Fathom:** broad light shafts respond to average sub/bass energy over
  the preceding 1.2 seconds. Slow currents stay independent of percussion.
  Four small colonies retain ambient light, with only one answering each
  transient. Measured section boundaries open the shafts gradually; inferred
  boundaries have half the response, and decorative pacing cuts have none.
- **Redline:** the lane grid travels at a rate taken from the same 1.2s energy
  average -- quiet songs crawl, a groove cruises, and dense material drops to
  half-time so a 170 BPM mix does not strobe the road. No tempo is invented
  from BPM. Phrase boundaries that earned a lift close a tunnel mouth and then
  open a horizon wash; decorative cuts do neither. Reflectors and neon signage
  idle with energy; one gantry catches each accent, density never spawns more.
- **The Foundry:** furnace heat is that same 1.2s energy average, never a
  single-frame sample -- a kick is not a pour. Quiet input stays as low embers.
  Percussion drops one hammer in the mill the current section picked; the other
  three mills stay idle. Earned section lifts flood the ground from below, then
  fall back to the heat envelope.
- **Far Side:** the terminator still walks the song (the slow form sweep);
  its contrast eases as energy rises so a dense mix cannot strobe the limb.
  Illumination of the primary follows the 1.2s energy average plus an earned
  phrase lift. Isolated accents leave a surface trace; dense material raises
  the floor so only the stronger hits mark the regolith. Sparse songs keep
  the composition and the stillness.
- **Understory:** canopy occupancy is that same energy average plus the
  orogeny arc -- a kick never adds a trunk. Phrases that earned a lift open
  the light shafts; decorative cuts do not. One spore colony answers each
  accent; the other three keep their ambient drift. Shaft sway is the slow
  current already zeroed under reduced flash.
- **The Nave:** bass is the resonance of the interior (1.2s average, never a
  single bin). Returning structural labels light the same stained-glass bays;
  a different label lights a different set. Decorative cuts and missing labels
  do not invent a chorus -- every bay follows bass equally (broad phrasing).
  Inferred structure is worth half a measured one. Earned phrase openings lift
  the motif bays.
- **Reduced motion:** the new current sway, traffic travel and hammer drop are
  suppressed, local accents are softened, cruise rate and ridge travel are halved, pours and phrase-scale lifts are tempered, additive layers fall
  back to non-additive compositing. Existing world/character motion remains
  governed by the existing controls.

These controls consume existing energy curves and conductor rhythm events.
No tempo is invented for unmetered songs, and no persisted analysis schema
changes are required. The averaging includes intervening samples so rapid
periodic bass cannot alias into a full-strength pressure flash.

**Verification:** start the app and run `npm run test:worlds`. This uploads the
same generated 32-second quiet/loud/quiet fixture to **every registered world**
with seed 315, checks world selection, actual rhythm delivery, composed frames,
energy response, backward seeking, reduced flashing (the `R` shortcut) and
reduced motion (its own chip) separately, and saves screenshots plus a JSON
report under `.smoke/worlds/`. Before the worlds it checks both preference
chips at 1280x800 and 390x844: pointer, Enter/Space and `R` reach the same
reduced-flash state, motion stays independent, reload and seeking keep both,
and blocked storage falls back to the system setting.

The chooser renders stills at two shared timestamps (a quiet stretch and a
peak), so a card comparison uses the same moments. The Range card is labeled
as a legacy illustration; playback uses Range v2. Other cards render their
selected world's configuration. Preview
plays one passage at a time and cannot leak its audio or clock into
playback. Reduced motion keeps the still and skips the animated clip.
`node --test test/worldPreview.test.js test/worldChooser.test.js` pins the
passage picker, copy, cache, and one-at-a-time session.

It also runs a **per-pass paint audit**: it wraps individual draw passes,
renders one frame at a pinned full-quality perf rung, and records how many
stage pixels each pass actually changed. A pass that runs and paints nothing
fails with its name attached. This exists because judging the composed frame
cannot catch a single dead pass — BiomeManager's fata morgana ran every frame
for a week while drawing zero pixels (its call landed in a same-named method
with a different signature) and the frame was as colorful as ever throughout.
Passes that may legitimately paint nothing on a short fixture — `drawDeepSky`,
whose Star Atlas is still empty — are recorded in the report rather than
asserted.

`npm test` covers the
control timing, missing data, sustained versus transient bass, rapid drums,
boundary provenance and reduced-motion behavior. Synthetic fixtures establish
behavior, not a listener preference ranking; real-song visual evaluation and
rendered chooser previews remain later buildout work.

---

## 1. What a world is (and is not)

From `src/world/Worlds.js`:

> A biome is a palette that rotates inside a world. A world is the landform
> contract those palettes paint onto.

Concretely, a world is exactly three things:

| Seam | File | What it declares |
| --- | --- | --- |
| **Registry entry** | `src/world/Worlds.js` | id, name, tagline, `kind`, comfort band, channels, `prefer` ranges, palette list, temperature map, cast fn |
| **Silhouette profile** | `src/world/SilhouetteGenerator.js` → `<world>/…Silhouette.js` | how the song's ridge portrait becomes a height field for L2–L5 |
| **Draw path** | `<world>/draw<World>.js` | what `BiomeManager.draw()` hands off to after the shared sky/blend prologue |

Plus two smaller ones the city already pays: a `.worldCardPreview.<kind>`
CSS thumbnail, and — new, see §3 — an affinity descriptor for the scorer.

**The bar for being a world.** A candidate is a *palette*, not a world, if
you could express it by changing `sky`, `silhouette`, `particles`, and `fx`
on an existing world. A candidate is a world only if it changes what the
*shape* means: what the height field is (a peak, a building, a vault, a
trench wall), what the parallax stack is (distance? depth? time?), and what
the light does. Every world below fails the palette test on purpose — each
one reinterprets the same `RidgePortrait` genome as a different physical
thing.

**The other bar: the show has to survive.** The city commit is the honest
template — it lists what it *scrapped* (mountain dance, GeoCrest, ocean,
spectrum massif, mandala, cymatics, sun, connector hills) because those
systems lose their meaning off the mountain. Every world below does the same
accounting: translated / new / scrapped. A world that keeps everything isn't
a world; a world that keeps nothing is a second renderer.

---

## 2. The design law: worlds partition the watchability space

`WorldScore.extractWatchFeatures()` reduces a song to one vector. The match
percentage is not genre — it's whether this world's channels, driven by this
song, land in a sweet spot. That only produces meaningful spread if the
worlds *claim different regions*. Two worlds with the same comfort band and
the same `prefer` ranges will always score within a few points of each
other, and the select screen degrades into a coin flip with decoration.

Today the space is covered like this:

```
drive →   0.0      0.2      0.4      0.6      0.8      1.0
Range              |······························|          arc, tempoHeat
After Hours   |·················|                             groove, warmth, dark
              ↑                            ↑          ↑
        nothing here                nothing here   nothing here
```

The six new worlds are chosen to fill those holes, and to split the two
crowded ones along a *second* axis so overlapping comfort bands still
resolve. The intended partition:

| World | `kind` | drive comfort | Wins on | Loses on |
| --- | --- | --- | --- | --- |
| The Range | `alpine` | 0.34 – 0.84 | arc, contrast, tempoHeat | drones, wall-of-sound |
| After Hours | `city` | 0.20 – 0.64 | groove, warmth, dark centroid | bright, fast, arc-less |
| **The Fathom** | `abyssal` | 0.04 – 0.38 | bass, warmth, phrase, low onset | anything busy or bright |
| **Far Side** | `airless` | 0.02 – 0.30 | air, centroid, spread, low bass | groove, bass, density |
| **Understory** | `overgrowth` | 0.14 – 0.52 | texture, spread, low contrast | sharp onsets, hard cuts |
| **The Nave** | `nave` | 0.30 – 0.72 | contrast, form, phrase | formless, sectionless mixes |
| **Redline** | `strip` | 0.48 – 0.90 | tempoHeat, groove, centroid | slow, rubato, arc-driven |
| **The Foundry** | `foundry` | 0.62 – 0.99 | onset, energyMean, dyn | quiet, sparse, pretty |

Read down the "loses on" column: every song has somewhere to go, and no song
has everywhere to go. A 90 BPM dub record scores The Fathom high and Redline
low. A 174 BPM drum-and-bass track inverts it. A drone scores Far Side high
and everything else in the 40s. That's the deliverable — not eight cards
that all read 71%.

**Two low-drive worlds is deliberate.** The Fathom and Far Side both live
under 0.40 drive, and they split on **warmth**: The Fathom wants bass and
body (dub, downtempo, doom, ambient with weight), Far Side wants air and
nothing under 200 Hz (drone, minimal, modular, ECM piano). `warmth` is
already in the feature vector and already separates them cleanly.

---

## 3. Two pieces of shared work the six worlds require

These are prerequisites, not per-world work. Do them first.

### 3.1 Affinity must move into the registry

`WorldScore.affinityScore()` currently hardcodes two formulas:

```js
if (world.kind === 'city') { /* groove, warmth, dark */ }
return /* arc, contrast, tempoHeat */;
```

With eight worlds this becomes an eight-branch switch that lives in the
wrong file. Replace it with a declarative weight map on the registry entry,
with the existing formulas expressed as data so behavior is unchanged:

```js
// Worlds.js — alpine
affinity: { arc: 0.40, contrast: 0.25, tempoHeat: 0.35 },
// Worlds.js — nocturne
affinity: { groove: 0.42, warmth: 0.38, centroidInv: 0.20 },
```

```js
// WorldScore.js
const INVERTED = { centroidInv: 'centroid', onsetInv: 'onset', warmthInv: 'warmth' };
function affinityScore(features, world) {
  const w = world.affinity;
  if (!w) return 0.5;
  let acc = 0, sum = 0;
  for (const [key, weight] of Object.entries(w)) {
    const src = INVERTED[key];
    const v = clamp01(src ? 1 - (features[src] ?? 0.5) : (features[key] ?? 0.4));
    acc += v * weight; sum += weight;
  }
  return sum > 0 ? clamp01(acc / sum) : 0.5;
}
```

Weights per world are given in each section below. `test/worldScore.test.js`
should grow a case asserting the two shipping worlds score identically
before and after the refactor.

### 3.2 The silhouette contract needs three new capabilities

The alpine and city height fields both assume *ground-anchored, upward,
hazed* geometry. Three of the six worlds break one of those assumptions, and
each break is a small, shared addition to `generateSilhouette()`:

- **`anchor: 'ceiling'`** — the strip is drawn hanging from the top of the
  canvas rather than standing on the bottom. Needed by The Fathom (trench
  ceiling, ice shelf) and The Nave (vault ribs). Implementation is a flip of
  the fill polygon and the `yOff` sign in `drawTiledStrip`; the height field
  generator is untouched.
- **`aerial: false`** — a per-world flag that zeroes `AERIAL_PULL` and skips
  `_drawHaze()`. Needed by Far Side: no atmosphere means no aerial
  perspective, and faking it there is the single tell that would break the
  whole premise. Depth has to be carried by contrast and parallax rate only.
- **`profile: 'columnar'`** — vertical members with a top capital and a
  base, evenly spaced by a rhythm rather than a noise field. Needed by The
  Nave (columns) and reused by The Foundry (stacks, gantry legs). This is
  the one genuinely new height-field kernel; the other five reuse or bend
  `alpineHeightField` / `cityHeightField`.

---

## 4. The Fathom

> **Tagline:** "Everything down here is slow on purpose."
> **`kind`:** `abyssal` · **`id`:** `fathom`

### Premise

The camera is *under* the water, not beside it. The Range already has an
ocean; this is not that. The parallax stack stops meaning "distance across a
valley" and starts meaning "depth through a water column" — near layers are
particulate and dark, far layers dissolve into a blue-green nothing that
never resolves. There is no sky. The top of the frame is the surface seen
from below: a shifting mirror that admits shafts of light and nothing else.

This is the world for records where almost nothing happens and the nothing
is the point — dub, doom, downtempo, ambient with a body, the long quiet
half of a post-rock record.

### Landform contract

The ridge portrait is read **twice, in opposite directions**, because a
trench has two sides:

| Layer | Anchor | Reads | Becomes |
| --- | --- | --- | --- |
| L2 | ceiling | macro form | The surface. Not a silhouette — a caustic mirror whose displacement is the phrase wave. Landmarks become brighter light shafts. |
| L3 | ceiling | timbre | Hanging trench wall, far side. `massProfile` inverted; air share thins it toward transparency. |
| L4 | ground | grain | Seamounts and vent chimneys rising from below. Reuses `alpineHeightField` with `character: 'crags'` and `wBase` halved — narrow, tall, close-packed. |
| L5 | ground | phrase-scale bass | Silt floor. `profile: 'rolling'` at very low amplitude, because the sea floor is a plain, not hills. |

Pressure is the arc: `orogenyGrowth` is repurposed as **descent**. Over the
song the whole stack drifts down — L5 silt darkens, L2's surface recedes
and dims, particulate density rises. The finale is the darkest, quietest
frame in the game, which is exactly right for the songs that score here.

### Palettes

Temperature axis is **shallow → abyssal**, not cold → hot.

```js
export const FATHOM_TEMPERATURE = {
  SHALLOWS: 0.10, THERMOCLINE: 0.32, MIDWATER: 0.55, HADAL: 0.78, VENT: 0.94,
};
```

| Name | sky (surface gradient) | silhouette | celestial | particles | fx |
| --- | --- | --- | --- | --- | --- |
| `SHALLOWS` | `#0a2e3a` `#12586a` `#3fa0a8` | `#08313a` | sun, veiled, `#bff0ea`, r 54 (seen through water) | `bubbles` `#cdf2ff` ×40 sp 26 | `godRays` |
| `THERMOCLINE` | `#062430` `#0c4050` `#1f7280` | `#062a34` | sun, veiled, `#8fd8d8`, r 44 | `bubbles` `#a8dcea` ×30 sp 20 | `godRays` |
| `MIDWATER` | `#03151f` `#062a38` `#0d4552` | `#04202a` | moon, veiled, `#7fc0c8`, r 30 | `spores` `#8ad0d8` ×34 sp 9 (marine snow) | `bioluminescence` |
| `HADAL` | `#01090f` `#03151d` `#06242e` | `#020d14` | moon, veiled, `#5a8a94`, r 22 | `spores` `#6fb0bc` ×46 sp 6 | `bioluminescence` |
| `VENT` | `#0c0806` `#1a1008` `#2a1a10` | `#0a0806` | moon, veiled, `#e0a060`, r 18 | `embers` `#ff9a4c` ×26 sp 14 (black smoker) | `emberGlow` |

`VENT` is the release valve: the one palette with warmth, cast onto the
loudest section so the song's peak has somewhere to go without breaking the
world's rule that there is no sky.

### Registry entry

```js
{
  id: 'fathom',
  name: 'The Fathom',
  tagline: 'Everything down here is slow on purpose.',
  kind: 'abyssal',
  // Saturates early and hard: this suite has no fast channels. A busy mix
  // turns marine snow into static and the caustics into a strobe.
  comfort: { lo: 0.04, hi: 0.38 },
  channels: [
    { id: 'caustics', reads: 'phrase',  weight: 1.20 },
    { id: 'column',   reads: 'warmth',  weight: 1.10 },
    { id: 'descent',  reads: 'arc',     weight: 0.80 },
    { id: 'snow',     reads: 'texture', weight: 0.95 },
    { id: 'life',     reads: 'form',    weight: 0.70 },
    { id: 'vents',    reads: 'onset',   weight: 0.45 },
  ],
  prefer: {
    onset:    [0.02, 0.30],
    warmth:   [0.45, 0.95],
    centroid: [0.08, 0.42],
    phrase:   [0.30, 0.95],
    arc:      [0.08, 0.55],
  },
  affinity: { warmth: 0.34, phrase: 0.26, onsetInv: 0.24, bass: 0.16 },
  palettes: FATHOM_PALETTES,
  temperature: FATHOM_TEMPERATURE,
}
```

### Draw path

**Translated:** parallax stack, haze (as water turbidity — *stronger* near,
inverted from air), ground field (silt, breathing with bass), particle
fields, section transitions, film finish, the trio, `Ocean`'s spectral
`WaveField` (drives the L2 surface displacement instead of a horizon line),
`OceanLife` (finally in its natural habitat — silhouettes crossing at depth
rather than fins on a horizon), `Burrow` (vent tube-worm colonies).

**New:** caustic projector (one baked, tiled, scrolling light-pattern strip
multiplied over L3–L5, displaced by the wave field); marine-snow depth cue
(particles rendered at three parallax rates so the water column has volume);
descent drift.

**Scrapped:** sky ensemble, star catalogue, celestial motion, aurora,
mountain dance, GeoCrest, spectrum massif, connector hills, far vignettes,
wildfire, lightning, meteor shower, murmuration. The sun exists only as a
veiled disc in `SHALLOWS`/`THERMOCLINE` and is gone below.

### Risks

Legibility of the trio against a near-black frame at `HADAL`. Mitigation is
already in the codebase: `ensureContrast()` on the silhouette tint, plus a
rim light from the bioluminescence layer. Budget one pass on character
readability, the same one PR #101 did for the title stage.

---

## 5. Far Side

> **Tagline:** "No air. Nothing softens."
> **`kind`:** `airless` · **`id`:** `farside`

### Premise

A body with no atmosphere. The entire visual language of the game so far —
haze, aerial perspective, fog banks, depth desaturation — is *atmospheric*,
and this world's premise is that all of it is switched off. Distance is
carried only by parallax rate and by contrast, which makes the frame read as
uncannily flat and enormous at the same time. That is the effect.

The sky is black at noon and full of stars at noon. A gas giant occupies a
quarter of the frame and does not move fast enough to notice, but it does
move. The horizon is visibly *curved* and much closer than it should be —
the single cheapest, strongest cue that this is a small airless body.

This is the world for drones, minimal techno, modular patches, sparse piano,
anything where the mix is mostly air and space and there is no groove to
follow.

### Landform contract

| Layer | Anchor | Reads | Becomes |
| --- | --- | --- | --- |
| L2 | ground | macro form | The limb. A single arc across the frame — the curved horizon — with the portrait's landmarks as low crater rims breaking it. Amplitude tiny; the *curve* does the work. |
| L3 | ground | timbre | Crater walls and ejecta rays, hard-edged. `alpineHeightField` with weathering set to zero: no erosion, because there's no weather. |
| L4 | ground | grain | Regolith boulder field. Discrete, sparse, high-contrast — not a ridge. |
| L5 | ground | phrase | Near regolith, nearly flat, with long hard shadows from the single light source. |

`aerial: false` (§3.2) is mandatory here. So is a change to `LightRig`: one
light, no fill, no bounce. Shadows go to full black with a hard terminator.
`ContactShadow` gets its softness parameter driven to zero. The existing
`ShadowLanguage` work does most of this already — it just needs a world-level
"vacuum" preset.

### Palettes

Temperature axis is **shadow → glare**.

```js
export const FARSIDE_TEMPERATURE = {
  UMBRA: 0.06, EARTHSHINE: 0.28, TERMINATOR: 0.50, MARE: 0.72, GLARE: 0.95,
};
```

| Name | sky | silhouette | celestial | particles | fx |
| --- | --- | --- | --- | --- | --- |
| `UMBRA` | `#000000` `#020208` `#05060e` | `#0a0c12` | moon (the primary), `#2a3a5a`, r 120, `dominant` | `antigrav` `#7f8fb0` ×14 sp 6 | `starTwinkle` |
| `EARTHSHINE` | `#01020a` `#040814` `#0a1226` | `#101828` | moon, `#6f90d8`, r 130, halo `#3a5a9a`, `dominant` | `antigrav` `#9fb4e0` ×18 sp 8 | `starTwinkle` |
| `TERMINATOR` | `#020208` `#080a14` `#141826` | `#1a1e2a` | sun, `#ffffff`, r 18, halo `#ffffff` (no bloom — no air to bloom in) | `antigrav` `#c0c8d8` ×12 sp 10 | `crystalGlint` |
| `MARE` | `#03040c` `#0a0c16` `#181c28` | `#242832` | sun, `#ffffff`, r 18 | `sand` `#b8bcc8` ×22 sp 14 (kicked regolith) | `crystalGlint` |
| `GLARE` | `#06070e` `#12141c` `#2a2c34` | `#3a3c44` | sun, `#ffffff`, r 20, `dominant` | `flaresparks` `#ffffff` ×10 sp 40 | `crystalGlint` |

Note how narrow the hue range is. That's correct and it's the discipline the
world demands: airless bodies are grey, and the color has to come from the
primary hanging in the sky, not from the ground. `ColorLaw`'s One Spectrum
tonic rotation should be clamped to roughly a third of its usual amplitude
here, applied mostly to the primary's albedo.

### Registry entry

```js
{
  id: 'farside',
  name: 'Far Side',
  tagline: 'No air. Nothing softens.',
  kind: 'airless',
  aerial: false,
  // The lowest comfort band in the game. This world is *supposed* to be
  // still; the failure mode isn't boredom, it's a busy mix making a
  // vacuum look like a music visualizer.
  comfort: { lo: 0.02, hi: 0.30 },
  channels: [
    { id: 'limb',      reads: 'form',     weight: 0.90 },
    { id: 'primary',   reads: 'air',      weight: 1.25 },
    { id: 'stars',     reads: 'spread',   weight: 1.05 },
    { id: 'terminator',reads: 'contrast', weight: 0.85 },
    { id: 'regolith',  reads: 'onset',    weight: 0.40 },
    { id: 'libration', reads: 'phrase',   weight: 0.70 },
  ],
  prefer: {
    air:      [0.22, 0.95],
    centroid: [0.45, 0.98],
    warmth:   [0.02, 0.45],
    onset:    [0.00, 0.26],
    spread:   [0.35, 0.95],
  },
  affinity: { air: 0.32, centroid: 0.24, spread: 0.22, warmthInv: 0.22 },
  palettes: FARSIDE_PALETTES,
  temperature: FARSIDE_TEMPERATURE,
}
```

### Draw path

**Translated:** parallax (rate only), star catalogue *at full fidelity and
never twinkling* — twinkle is an atmospheric artifact and its absence is a
feature — `SpaceRidge`, `MeteorShower` (as impacts: they hit, silently, and
throw a ballistic ejecta plume), `ConstellationWeaver`, ground field, film
finish, the trio, `DayNight` (a very slow terminator sweep across the whole
song).

**New:** the limb (curved-horizon height field); the primary (a large,
banded, phase-lit planet using the existing `celestial` shattered/ring
machinery at 3× radius); ballistic dust (particles with no air resistance —
parabolas, not drift, which is a two-line change in `ParticleField`'s
integrator behind a `ballistic: true` flag); hard terminator shading.

**Scrapped:** haze, fog banks, depth desaturation, aerial perspective, wind,
weather of every kind, ocean, wildfire, lightning, murmuration, canopy, the
entire `Atmosphere` module. Also scrapped: the horizon EQ, which reads as an
atmosphere effect.

### Risks

The honest one: a world whose thesis is "less" can read as unfinished. The
defense is fidelity elsewhere — the star catalogue and the primary have to
be the best-rendered objects in the game, because they're the only ones on
screen. If the primary looks cheap, the world fails.

---

## 6. Understory

> **Tagline:** "Nothing is built. Everything grows."
> **`kind`:** `overgrowth` · **`id`:** `understory`

### Premise

The only world with **no ridge line at all**. Every other world answers "what
is the silhouette?" — this one answers "there isn't one." The camera is
inside a canopy, looking through layers of growth toward a light that is
never directly visible. Depth is occlusion, not horizon.

And it is the only world where the ridge portrait drives *rates* rather than
*heights*. The song doesn't describe a shape here; it describes a growth
schedule. `ReactionDiffusion`, `KuramotoSwarm`, and `GroundScatter` are
already in the tree and are exactly the right machinery — they're currently
accents on the mountain, and here they become the entire world.

This is the world for shoegaze, ambient folk, field-recording-adjacent
records, anything with high `texture` and `spread` and soft edges — mixes
where `contrast` is low because the song genuinely doesn't cut, and every
other world reads that as a defect.

### Landform contract

| Layer | Anchor | Reads | Becomes |
| --- | --- | --- | --- |
| L2 | ceiling | macro form | Canopy roof. A reaction-diffusion mask, not a height field — the portrait's landmarks seed the gaps that light comes through. |
| L3 | ceiling | timbre | Mid-canopy: hanging vines and branch masses. Air share opens it; bass share closes it. |
| L4 | both | grain | Trunks. Vertical members at portrait-landmark x-positions, `profile: 'columnar'`, but organic — width from `massProfile`, taper from lithology. |
| L5 | ground | phrase | Fern and root fabric, the one layer that behaves like conventional ground scatter. |

**Growth is the arc.** `orogenyGrowth` becomes canopy occupancy: the song
starts sparse and near-bare, and by the finale the frame is nearly closed —
the opposite trajectory from The Fathom's descent, and the reason both can
sit in a similar drive band without feeling alike. Growth is monotonic and
never resets; section cuts change the *species* (palette), not the amount.

### Palettes

Temperature axis is **dawn floor → deep growth**.

```js
export const UNDERSTORY_TEMPERATURE = {
  DAWNFLOOR: 0.12, MOSSLIGHT: 0.30, CANOPY: 0.52, ROTBLOOM: 0.74, NIGHTBLOOM: 0.92,
};
```

| Name | sky (light through canopy) | silhouette | celestial | particles | fx |
| --- | --- | --- | --- | --- | --- |
| `DAWNFLOOR` | `#1a2410` `#3a5220` `#a8c060` | `#12200e` | sun, shafts, `#e8ffb0`, r 42, halo `#c0e880` | `pollen` `#e8ffb0` ×44 sp 7 | `godRays` |
| `MOSSLIGHT` | `#0e2418` `#1e5030` `#78c088` | `#0a1e14` | sun, shafts, `#d0ffd0`, r 38 | `spores` `#c8f0b8` ×50 sp 5 | `canopyDapple` |
| `CANOPY` | `#08200e` `#134a22` `#4a9850` | `#061a0c` | sun, veiled, shafts, `#b8e890`, r 34 | `pollen` `#d8ffa0` ×38 sp 6 | `canopyDapple` |
| `ROTBLOOM` | `#140e1a` `#2e2038` `#6a4a70` | `#100a16` | moon, `#e0c8f0`, r 30, halo `#a880c0` | `spores` `#d8a8f0` ×54 sp 4 | `sporeGlow` |
| `NIGHTBLOOM` | `#040c10` `#0a2028` `#164048` | `#03080c` | moon, veiled, `#a8f0e0`, r 26 | `fireflies` `#a8ffd8` ×40 sp 10 | `bioluminescence` |

### Registry entry

```js
{
  id: 'understory',
  name: 'Understory',
  tagline: 'Nothing is built. Everything grows.',
  kind: 'overgrowth',
  // Wide-ish band but low ceiling: growth is a slow channel, and a
  // high-onset mix makes the canopy flicker like a bad fluorescent.
  comfort: { lo: 0.14, hi: 0.52 },
  channels: [
    { id: 'growth',  reads: 'arc',      weight: 1.00 },
    { id: 'canopy',  reads: 'texture',  weight: 1.30 },
    { id: 'shafts',  reads: 'air',      weight: 0.90 },
    { id: 'fabric',  reads: 'spread',   weight: 1.10 },
    { id: 'species', reads: 'contrast', weight: 0.55 },
    { id: 'motes',   reads: 'onset',    weight: 0.60 },
  ],
  prefer: {
    texture:  [0.40, 0.98],
    spread:   [0.42, 0.95],
    contrast: [0.02, 0.48],
    onset:    [0.05, 0.45],
    centroid: [0.30, 0.78],
  },
  affinity: { texture: 0.36, spread: 0.26, air: 0.20, contrast: 0.18 },
  palettes: UNDERSTORY_PALETTES,
  temperature: UNDERSTORY_TEMPERATURE,
}
```

### Draw path

**Translated:** parallax stack (as occlusion depth), haze (as humid air —
this world can push it further than any other), `ReactionDiffusion` (promoted
from accent to the L2/L3 mask generator), `KuramotoSwarm` (fireflies and
insect choruses that phase-lock to the beat — the existing sync visual is
finally load-bearing), `GroundScatter` (promoted the same way),
`Murmuration`, `ParticleField`, `LightField` god-rays, film finish, the trio,
weather (rain through canopy is the best-looking rain in the game).

**New:** the growth scheduler (one module that turns the portrait into a
per-species accretion curve and hands masks to L2–L5); trunk generator
(`columnar` + organic taper); occlusion-based contact shadows on the trio as
they pass behind trunks.

**Scrapped:** every ridge line, mountain dance, orogeny-as-uplift, GeoCrest,
spectrum massif, ocean, monolith, connector hills, far vignettes, star
catalogue (a few stars leak through the canopy in `NIGHTBLOOM`, drawn as
part of the mask, not as the sky), meteor shower, lightning as a silhouette
event (kept as a light event only — flash through the canopy, no bolt).

### Risks

Performance. Reaction-diffusion at two parallax layers plus a growth
schedule plus scatter is the heaviest world in the set. It must bake: the
growth curve is offline-computable at load (the game already precomputes
takeoff schedules and biome casts), so the runtime cost should be blitting
pre-baked mask frames and cross-fading between growth stages, not simulating
per frame. Budget explicitly for `PerfGovernor` rungs here.

---

## 7. The Nave

> **Tagline:** "Architecture that rebuilds itself every chorus."
> **`kind`:** `nave` · **`id`:** `nave`

### Premise

The first **interior**. The parallax stack becomes a receding colonnade —
bay after bay of arches marching away from the camera — and the "sky" is a
vaulted ceiling. Nothing is natural; everything is built, symmetric, and
rhythmic. Where the city is architecture seen from outside at street level,
this is architecture that *encloses* the frame.

The reason it earns a slot: it's the only world keyed on **form and
contrast** rather than energy. Its channels reward exactly what every other
world treats as secondary — how many distinct sections a song has, how hard
it cuts between them, how strong its phrase structure is. A song with five
clearly-delineated sections and a modest dynamic range scores mediocre
everywhere today; here it's the best possible input, because each section
literally rebuilds the architecture: bay spacing, arch geometry, vault
height, and the rose window's figure all re-derive on the cut.

And it's where `Mandala` finally has a job. The rose window is a mandala,
driven by the tonic through `ColorLaw`'s One Spectrum — the existing
harmonic-color machinery pointed at the one object in the game where
stained glass is the literal correct answer.

### Landform contract

| Layer | Anchor | Reads | Becomes |
| --- | --- | --- | --- |
| L2 | ceiling | macro form | Vault. Rib arcs whose springing height is the portrait's macro envelope; the boss line runs down the frame's centre. |
| L3 | ceiling+ground | timbre | Far colonnade, small and dim — the receding bays. Column spacing from `phrasePeriod`, not from noise. |
| L4 | ground | grain | Near colonnade: full-height columns, `profile: 'columnar'`, with capitals sized by lithology (bass = heavy Romanesque, air = slender Gothic). |
| L5 | ground | phrase | Floor: flagstones and a processional runner, scrolling with a real perspective foreshortening. |

**Column spacing is the metric grid.** This is the world's signature and its
hardest constraint: bays must line up with bars. `Conductor.barGrid` already
exists and is authoritative; column x-positions come from it, scaled so a
bay is one or two bars depending on tempo. Get this wrong and the world is
just a hallway; get it right and the camera's scroll *is* the meter.

### Palettes

Temperature axis is **stone → glass**, i.e. how much of the frame is light
coming through colored glass versus lit masonry.

```js
export const NAVE_TEMPERATURE = {
  CRYPT: 0.08, LAUDS: 0.30, TRANSEPT: 0.52, ROSE: 0.76, GLORIA: 0.95,
};
```

| Name | sky (vault) | silhouette | edgeLight | celestial | particles | fx |
| --- | --- | --- | --- | --- | --- | --- |
| `CRYPT` | `#0a0a0e` `#14141c` `#22222c` | `#0c0c12` | — | moon, veiled, `#c0c0cc`, r 22 | `fog` `#8a8a98` ×20 sp 4 | `starTwinkle` |
| `LAUDS` | `#101018` `#242436` `#4a4460` | `#16161e` | `#8a7ad0` | sun, shafts, `#e8dcff`, r 30 | `sunshine` `#e8dcff` ×24 sp 6 | `godRays` |
| `TRANSEPT` | `#0e1420` `#1e3048` `#3a6080` | `#101620` | `#5ea0d0` | sun, shafts, `#d0e8ff`, r 34 | `sunshine` `#cfe8ff` ×30 sp 7 | `godRays` |
| `ROSE` | `#1a0e18` `#3a1830` `#7a2e50` | `#1c0e18` | `#d05070` | sun, shafts, dominant, `#ffd0d8`, r 40 | `sunshine` `#ffc0cc` ×28 sp 8 | `crystalGlint` |
| `GLORIA` | `#2a1c08` `#5a3c10` `#c08a30` | `#241806` | `#ffc860` | sun, dominant, shafts, `#fff0c0`, r 52 | `sunshine` `#ffe8b0` ×34 sp 10 | `prominence` |

`edgeLight` is already supported (the city uses it for neon) and here it's
the glass color spilling onto stone — the same field, a completely different
read.

### Registry entry

```js
{
  id: 'nave',
  name: 'The Nave',
  tagline: 'Architecture that rebuilds itself every chorus.',
  kind: 'nave',
  // Mid band, and unusually tolerant at the top: a big chorus filling a
  // vault with light is the payoff shot. It fails downward — an
  // undifferentiated mix leaves the architecture inert.
  comfort: { lo: 0.30, hi: 0.72 },
  channels: [
    { id: 'bays',    reads: 'phrase',   weight: 1.15 },
    { id: 'vault',   reads: 'form',     weight: 1.25 },
    { id: 'glass',   reads: 'contrast', weight: 1.30 },
    { id: 'organ',   reads: 'bass',     weight: 0.85 },
    { id: 'shafts',  reads: 'air',      weight: 0.70 },
    { id: 'censer',  reads: 'onset',    weight: 0.50 },
  ],
  prefer: {
    contrast: [0.45, 0.98],
    form:     [0.35, 0.95],
    phrase:   [0.40, 0.98],
    arc:      [0.25, 0.80],
    centroid: [0.25, 0.75],
  },
  affinity: { contrast: 0.34, form: 0.28, phrase: 0.24, arc: 0.14 },
  palettes: NAVE_PALETTES,
  temperature: NAVE_TEMPERATURE,
}
```

### Draw path

**Translated:** parallax (as bay recession), haze (as incense and dust in
light shafts — heavily used), `LightField` god-rays (the single most
important effect in this world), `Mandala` (rose window), `ColorLaw` /
One Spectrum (glass hue from the tonic), `ContactShadow` (columns cast onto
the floor), section transitions (promoted to *the* structural event: a cut
rebuilds the architecture), film finish, the trio, `FractureEngine` (a
shatter that reads as breaking glass — the best use it's ever had).

**New:** the bay generator (bar-grid-locked columns, arches, and vault ribs
with correct perspective foreshortening across L3/L4); the rose window
compositor (mandala rendered once per section, blitted with a glass-spill
`edgeLight` pass); floor perspective (the only world with a true
foreshortened ground plane, which needs a small addition to `_drawGround`).

**Scrapped:** every natural landform, ocean, weather, wildfire, meteor
shower, star catalogue (except a few through the clerestory in `CRYPT`),
murmuration, aurora, mountain dance, GeoCrest, spectrum massif, connector
hills, ground scatter, canopy.

### Risks

Perspective. Every other world is orthographic parallax; this one implies a
vanishing point, and a colonnade that doesn't converge correctly will read
as broken rather than stylized. Mitigation: commit to a *fixed, shallow*
convergence baked into the strips at generation time rather than a real
projection at draw time. The strips stay tileable; the perspective is a
property of the art, not of the camera.

---

## 8. Redline

> **Tagline:** "A road that only exists at speed."
> **`kind`:** `strip` · **`id`:** `redline`

### Premise

The fast world. Everything in it is a function of velocity: a vanishing
point on the horizon, a perspective grid rushing under the camera, sign
gantries and pylons strobing past, and a low sun that never sets because the
road is heading straight at it. Where After Hours is a city at a standstill
at 3 a.m., Redline is the highway out of it at 140.

It exists because there is currently no home for fast, bright, groove-locked
music. The Range's `tempoHeat` affinity means a 170 BPM track scores well
there, but the alpine suite is *slow* — mountains don't move at 170, and the
result is a fast song in a static frame. Redline makes tempo the primary
driver of every channel: grid scroll rate, gantry spacing, strobe cadence,
and the horizon's roll all come off `bpm` and `groove` rather than energy.

This is the world for drum and bass, house, disco, italo, motorik krautrock,
anything with a locked fast pulse and a bright mix.

### Landform contract

Redline is the one world that mostly **doesn't use the silhouette
generator** — its geometry is procedural furniture on a perspective grid, not
a height field. It still declares the profile, because two layers need it:

| Layer | Anchor | Reads | Becomes |
| --- | --- | --- | --- |
| L2 | ground | macro form | Far mesas / overpass structures on the horizon line — a low, sparse `alpine` field at 0.2 amplitude, purely to give the vanishing point something to sit against. |
| L3 | ground | timbre | Sign gantries and pylons. Spacing from `bpm` (one gantry per bar at the current scroll rate), height from the portrait's landmarks. |
| L4 | — | grain | Guard rail and reflector posts: pure procedural furniture, spaced on the beat. Reflectors flash on the onset. |
| L5 | ground | phrase | The road surface itself: a perspective grid whose lane lines scroll at exactly the beat rate. |

**The grid is the metronome.** Lane markers pass the bottom of the frame on
the beat, gantries on the bar. This is the same discipline The Nave applies
to columns, applied to time instead of space — and it means the world is
*read* as in-time even when nothing else is happening.

### Palettes

Temperature axis is **dusk → overdrive**.

```js
export const REDLINE_TEMPERATURE = {
  DUSKRUN: 0.10, VAPOR: 0.32, TUNNEL: 0.50, NEONMILE: 0.74, OVERDRIVE: 0.94,
};
```

| Name | sky | silhouette | edgeLight | celestial | particles | fx |
| --- | --- | --- | --- | --- | --- | --- |
| `DUSKRUN` | `#1a1030` `#4a2050` `#e05a50` | `#180c28` | `#ff7a90` | sun, dominant, `#ff8a6a`, r 68, halo `#ffb37a` | `wind` `#ffb0a0` ×20 sp 90 | `heatShimmer` |
| `VAPOR` | `#12082a` `#3a1060` `#f050a0` | `#140828` | `#40e8ff` | sun, dominant, `#ff70c0`, r 74, halo `#a050ff` | `wind` `#a0e0ff` ×24 sp 110 | `neonGrid` |
| `TUNNEL` | `#06060a` `#0c0c14` `#1a1a24` | `#08080c` | `#ffd040` | moon, veiled, `#c0c0d0`, r 20 | `flaresparks` `#ffd040` ×18 sp 140 | `neonGrid` |
| `NEONMILE` | `#08041a` `#180a3a` `#3a1a70` | `#0a0618` | `#30ffd0` | moon, `#d0f0ff`, r 26, halo `#5060c0` | `digitalrain` `#30ffd0` ×30 sp 120 | `neonGrid` |
| `OVERDRIVE` | `#2a0400` `#6a1000` `#ff5010` | `#200400` | `#ffe060` | sun, dominant, `#ffe060`, r 86, halo `#ff7020` | `flaresparks` `#ffb040` ×26 sp 170 | `prominence` |

`TUNNEL` is the structural trick: the one palette where the sky closes
overhead. Cast it on a breakdown and the world gets a genuine dynamic event
— the light goes away, the reflectors carry the beat alone, and the exit
back into `NEONMILE` on the drop is the payoff.

### Registry entry

```js
{
  id: 'redline',
  name: 'Redline',
  tagline: 'A road that only exists at speed.',
  kind: 'strip',
  // High band, and it fails *upward* gracefully — this is the one suite
  // where more is mostly better. It fails downward hard: a slow song
  // makes the grid crawl and the whole premise collapses.
  comfort: { lo: 0.48, hi: 0.90 },
  channels: [
    { id: 'grid',    reads: 'tempoHeat', weight: 1.40 },
    { id: 'gantry',  reads: 'groove',    weight: 1.20 },
    { id: 'signs',   reads: 'onset',     weight: 1.00 },
    { id: 'horizon', reads: 'centroid',  weight: 0.80 },
    { id: 'sun',     reads: 'energyMean',weight: 0.65 },
    { id: 'tunnel',  reads: 'contrast',  weight: 0.75 },
  ],
  prefer: {
    tempoHeat: [0.45, 1.00],
    groove:    [0.30, 0.95],
    centroid:  [0.40, 0.92],
    onset:     [0.28, 0.85],
    arc:       [0.10, 0.65],
  },
  affinity: { tempoHeat: 0.40, groove: 0.28, centroid: 0.20, onset: 0.12 },
  palettes: REDLINE_PALETTES,
  temperature: REDLINE_TEMPERATURE,
}
```

### Draw path

**Translated:** parallax (rates re-derived from bpm rather than depth
constants), haze (as headlight glare and horizon bloom), ground field (the
road, still bass-breathing), the sign-gantry
animation (rotating figures on the boards; the milestone-digit
`EpicycleShow` it was to reuse has been removed, so it needs its own), particle fields, weather (rain
on a highway at speed is excellent), film finish, the trio, section
transitions (as tunnel mouths).

**New:** the perspective grid (a single shader-free scrolling grid with
correct 1/z spacing, locked to the beat clock); gantry/pylon spawner on the
bar grid; reflector strobe on the onset stream; the tunnel state (sky
occlusion + reverb-ish visual damping).

**Scrapped:** mountain dance, GeoCrest, orogeny, ocean, monolith, spectrum
massif, connector hills, far vignettes, star catalogue, meteor shower,
murmuration, wildfire, aurora, canopy — essentially the whole natural suite.
Lightning is *kept*, as a storm on the horizon ahead.

### Risks

Motion sickness and flash. A beat-locked grid at 170 BPM with reflector
strobes is the single most seizure-adjacent thing in the game. It must run
`capFlashAlpha()` on every channel, respect the existing reduced-flash
toggle aggressively (grid rate halved, reflectors to steady glow, tunnel
transitions cross-faded rather than cut), and cap effective strobe frequency
below 3 Hz regardless of tempo. This is a hard requirement, not polish.

---

## 9. The Foundry

> **Tagline:** "It only stops when the song does."
> **`kind`:** `foundry` · **`id`:** `foundry`

### Premise

The world for maximum input. Everything else in the set has a ceiling it
clips against; The Foundry's premise is that there is no such thing as too
much — a mill running flat out, all noise and molten light, where a wall of
sound is the *design target* rather than the failure mode.

Mechanically it inverts the game's usual energy mapping. Elsewhere loud means
brighter and more; here loud means the pour, and the pour means the frame
fills with orange light from *below*. The dominant light source is the
ground, which no other world does, and that single inversion — up-lighting,
with the trio rim-lit from underneath against a black roof — is the whole
look.

This is the world for metal, industrial, breakcore, hardcore, noise, and the
loudest 40 seconds of anything else.

### Landform contract

| Layer | Anchor | Reads | Becomes |
| --- | --- | --- | --- |
| L2 | ground | macro form | Blast furnace stacks and cooling towers. `profile: 'columnar'` at huge scale — the portrait's biggest landmarks become the biggest stacks. |
| L3 | ground | timbre | Gantry trusses: horizontal members with diagonal bracing, the first *horizontal-dominant* silhouette in the game. Bass share thickens the members; air share adds bracing density. |
| L4 | ground | grain | Pipework, conveyors, ladder cages. Dense, near-black, high-frequency detail — this is where `onset` lives. |
| L5 | ground | phrase | Slag heaps and the pour channel: the one soft, organic form in a world of straight lines, and the emissive one. |

**Heat is the arc.** `orogenyGrowth` becomes furnace temperature. The floor
channel goes from dull red to white over the song; at peak the L5 emission
lights L4 and L3 from below and blows out the near field. Section cuts are
*pours* — a ladle tips, the frame floods, and the light level resets down
after.

### Palettes

Temperature axis is, for once, literal: **cold iron → white heat**.

```js
export const FOUNDRY_TEMPERATURE = {
  COLDIRON: 0.08, SCALE: 0.28, POUR: 0.55, WHITEHEAT: 0.80, QUENCH: 0.95,
};
```

| Name | sky (roof) | silhouette | edgeLight | celestial | particles | fx |
| --- | --- | --- | --- | --- | --- | --- |
| `COLDIRON` | `#08080a` `#101014` `#1c1c22` | `#0a0a0c` | `#4a5a6a` | moon, veiled, `#8a94a4`, r 20 | `fog` `#6a7280` ×26 sp 8 (steam) | `starTwinkle` |
| `SCALE` | `#0c0806` `#180e08` `#2a1a10` | `#0c0806` | `#a04020` | moon, veiled, `#c08050`, r 18 | `embers` `#d05820` ×30 sp 40 | `emberGlow` |
| `POUR` | `#140800` `#301000` `#6a2400` | `#0e0604` | `#ff6010` | sun, dominant, veiled, `#ff7020`, r 56, halo `#ff9040` | `embers` `#ff7020` ×48 sp 70 | `emberGlow` |
| `WHITEHEAT` | `#2a1000` `#701e00` `#ffa030` | `#140800` | `#ffd070` | sun, dominant, `#fff0c0`, r 72, halo `#ffb040` | `flaresparks` `#ffd880` ×54 sp 130 | `prominence` |
| `QUENCH` | `#04080c` `#0a1620` `#183040` | `#050a0e` | `#60c0e0` | moon, veiled, `#a0d0e8`, r 24 | `fog` `#a0c0d0` ×60 sp 20 (steam flash) | `heatShimmer` |

`QUENCH` is the counterpart to Redline's `TUNNEL` — cast it after the
loudest section and the whole frame slams from white heat to cold steam in
one cut. It's the only cool palette in the world and it should feel like
relief.

### Registry entry

```js
{
  id: 'foundry',
  name: 'The Foundry',
  tagline: 'It only stops when the song does.',
  kind: 'foundry',
  // The highest band in the set, by design. Nothing else wants a drive of
  // 0.95. It fails downward: a quiet mix leaves a cold, dead mill.
  comfort: { lo: 0.62, hi: 0.99 },
  channels: [
    { id: 'pour',    reads: 'energyMean', weight: 1.30 },
    { id: 'hammers', reads: 'onset',      weight: 1.35 },
    { id: 'stacks',  reads: 'form',       weight: 0.85 },
    { id: 'gantry',  reads: 'bass',       weight: 1.00 },
    { id: 'sparks',  reads: 'dyn',        weight: 0.95 },
    { id: 'steam',   reads: 'texture',    weight: 0.60 },
  ],
  prefer: {
    onset:      [0.45, 1.00],
    energyMean: [0.50, 1.00],
    dyn:        [0.30, 0.95],
    tempoHeat:  [0.35, 1.00],
    warmth:     [0.30, 0.90],
  },
  affinity: { onset: 0.32, energyMean: 0.30, dyn: 0.20, tempoHeat: 0.18 },
  palettes: FOUNDRY_PALETTES,
  temperature: FOUNDRY_TEMPERATURE,
}
```

### Draw path

**Translated:** parallax, haze (as smoke and steam — the thickest in the
game), ground field (the pour channel, breathing with bass), `Wildfire`
(retargeted from forest to slag and flare stacks — the fire system already
handles spread and intensity, and here it's permanent rather than an event),
`FractureEngine` (screen shatter as the loudest hits, its natural home),
`Lightning` (as arc-furnace flash: no bolt, just the strike light and the
shadow snap), `ContactShadow` inverted for up-lighting, film finish, the
trio, `ParticleField` embers and sparks.

**New:** the emissive ground (an L5 that is a *light source*, requiring
`LightRig` to accept a ground-plane emitter and `ShadowLanguage` to cast
shadows upward); the gantry generator (horizontal-dominant truss height
field — the first one, and the piece the columnar profile in §3.2 is
designed to share); the pour event (section cuts as ladle tips).

**Scrapped:** sky in any meaningful sense (there's a roof), star catalogue,
celestial motion beyond the veiled disc, ocean, monolith, spectrum massif,
mountain dance, GeoCrest, orogeny-as-uplift, connector hills, murmuration,
canopy, aurora, ground scatter, meteor shower.

### Risks

Up-lighting is a real renderer change, not a draw-path change — `LightRig`,
`ContactShadow`, and the character shading all assume a light above. Scope
it honestly: this is the most expensive world in the set on the *engine*
side, even though its geometry is simpler than The Nave's. Also flash: arc
furnaces and screen shatter together need the same `capFlashAlpha` discipline
Redline needs.

---

## 10. Build order

Sequenced by (a) how much shared engine work they force and (b) how much of
the existing suite they can reuse, cheapest and highest-reuse first:

1. **Shared work (§3)** — affinity in the registry, `anchor: 'ceiling'`,
   `aerial: false`, `profile: 'columnar'`. Nothing else starts cleanly
   without these.
2. **Far Side** — smallest new surface area. Mostly *subtraction* (haze off,
   weather off) plus one hero object (the primary) and a curved-limb height
   field. Proves the `aerial: false` seam.
3. **The Fathom** — high reuse (Ocean, OceanLife, WaveField, Burrow all
   already exist and improve underwater). Proves `anchor: 'ceiling'`.
4. **Redline** — no new engine features; the grid and gantries are
   self-contained, and the beat-lock discipline is a good forcing function
   for the bar-grid work The Nave needs later.
5. **The Nave** — needs `columnar`, baked perspective, and the mandala
   compositor. Medium engine cost, high payoff (the rose window is the best
   single image in the set).
6. **Understory** — needs the growth scheduler and a real perf plan; worth
   doing after `PerfGovernor` has one more world's worth of data.
7. **The Foundry** — last, because up-lighting touches `LightRig`,
   `ContactShadow`, and character shading, and it's better to make that
   change once the other worlds have stressed those modules.

Each world is roughly: one palettes file, one silhouette file, one draw
file, one registry entry, one CSS preview, plus a `worldScore` test case
asserting it wins on its intended song shape and loses on its stated weakness.
That last test is the important one — it's what keeps the eight cards from
converging back into eight ways of saying 70%.

---

## 11. What this document does not decide

- **Character casting per world.** Midio, Midasus, and the third companion
  presumably need per-world silhouette treatments (a diver, a suited figure,
  a driver). Out of scope here; it's a `Casting` question, not a landform one.
- **Whether all eight should always be offered.** There's an argument for
  hiding worlds scoring under ~45 rather than showing a wall of bad matches.
  A UX call, best made once the scores exist and can be looked at.
