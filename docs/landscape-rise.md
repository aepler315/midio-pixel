# Landscape: the range rises with the song

Status: **on by default** in Landscape, for every view and both cameras (the
rail and shot tours). No URL flag and no setting. Code:
`src/world/alpine/LandRise.js`; tests: `test/landRise.test.mjs`; coverage
check: `npm run test:rise-coverage` (`--truth` checks against real
elevation).

At the first beat the mountains are pressed down toward the horizon, about a
tenth of their height above the eye. As the music plays they stand back up,
faster through loud passages and steadily through quiet ones, and the
complete range stands before the closing camera move. After that every pixel
is the one the view drew before this change.

## The map

Only land above the drawing eye moves, and only straight down. For a point
`h` metres above the eye at horizontal distance `r`:

    h' = s*h + (1 - s)*w*r*(1 - exp(-h / (w*r)))

`s` is the rise (0.1 at the first beat, 1 complete). `w = tan(0.6 deg)` is
the knee: ground within about 0.6 degrees of the horizon keeps its height,
so the lowered flanks meet the unmoved valley with no crease.

Why this shape and not "flatten toward the valley floor":

- **Nothing hidden comes into view.** A package ships only the tiles some
  baked camera can see at full height (`tools/lib/terrain-bake.mjs`).
  Flattening toward the valley floor uncovers hundreds of tiles that were
  never shipped, and the sky shows through the land. This map is monotone
  and concave in height with `f(eye) = eye`, so for any point Q between the
  eye and P, the lowered Q still lies on or above the sight line to the
  lowered P: whatever was hidden stays hidden (tested numerically).
- **Rays stay rays.** `h'` is homogeneous in `(r, h)`, so seen from the eye
  the change is a vertical squash of the frame above the horizon line, the
  same at every distance.
- **Below the eye nothing moves.** The lake, its mirror plane and clip
  plane, the shore, the valley, the mist and the cloud sea are exact. Water
  above the eye is lowered with its land but is only ever seen from below,
  behind its own shore.
- **The frame's top.** The squash also brings down land that stood above
  the top of the frame. See Coverage.

## The song's curve

`compileLandRise` (in `LandscapeScore`): progress is the integral of
`0.6 + energy` over heard time, normalised to reach 1 at
`max(0.6 * cadence, cadence - 20 s)`, where the cadence is the music's own
end and 20 s is the closing camera move (`FINALE_MS`). The last 15 % of the
climb eases onto the complete range. A 4-minute song whose music ends at
3:50 stands complete at 3:30. Previews and frames with no score show the
complete range.

When the whole-song analysis replaces the opening one, the land holds the
old curve up to the handoff and continues from where it stood (rebased in
progress), so it never jumps or sinks. If the new curve says the climb
should already be over, what is left is finished over 8 s.

## Where it is applied

One `uLandRise` float (the sink, `1 - s`) and the eye in `uTourEye.xyz`.
`uTourEnabled` moved into `uTourEye.w`, so the terrain fragment shader
stays at 247 of its 248 uniform vectors. At zero sink every function
returns early: the complete range costs nothing and is byte-identical.

- Terrain (`SCENE_VERT`, every pass: colour, depth, ownership, crest probe,
  feature ink, water, mirror): `p.y += riseLift(p)` after the glacier and
  the musical lift, outside the receiver mask and the tour fade. The land
  dance and the swell are computed exactly as before.
- Lighting: the gradient is taken once per vertex at the lifted point
  (`vRiseGrad`). Shading and silhouette-ink normals are carried through the
  map (inverse transpose). Snow, rock and forest masks keep the full-height
  slopes they were placed on. The baked sun horizon holds full-height
  elevations, so the light's tangent is stretched instead.
- Trees, roots, the cast (`groundLift`) and rivers lower with the land.
  Lantern lights are lowered on the CPU with their lanterns.
- The lake mirror lowers the land for the main eye, so the reflection shows
  the same range.

## Bounds

Lowering can move a box into the frame from above it. Every bound lowers the
box bottom through `risenFloor` (the bottom at the nearest horizontal
distance, since the drawn height rises with both height and distance):
chunk culling (`TerrainChunks`), the mirror and water scissors
(`MirrorScissor.liftBounds`), mapped-tour window plans (`TerrainWindow`,
planned for the lowest the land ever reaches, so a cached plan never
depends on which analysis was current), and the pixel-mode forest detail
footprint. The developer-only compiled-terrain experiment draws groups
that reach above the eye unculled while the land is rising.

## Coverage

- **Rails:** at 21 stations on each of the 19 rail views, no column has
  shipped land above the frame's top. Land rising above the top would cross
  it inside a tile the bake kept, so no unshipped land stands there either,
  and nothing missing can come down into the frame.
- **Shot tours** fly under ridges (San Gabriel: 91 of 165 sampled poses have
  land above the frame). Checked against real elevation (Terrarium z12,
  matched to each package within metres), no risen pixel on any of the
  13 tours has its first true hit on an unshipped tile, at the first beat's
  rise. The same check with a fifth of the tiles removed fails, as it
  should.

Run `npm run test:rise-coverage -- --truth` after rebaking a package or a
shot library.

## Limits

- Views whose skyline barely clears the horizon from the rail (Tombstone,
  Pend Oreille) barely rise: there is little land above the eye to lower.
- A tour camera above the whole range sees no change (Owens' tour).
- Mapped tours (only `teton-range-tour`, a candidate) plan summit tiles
  above the eye at finer strides for the whole song.
- Lantern light submersion uses the CPU-lowered anchor plus the musical
  lift; above the eye it can differ from the lantern by at most that lift,
  and the cloud sea never reaches above the eye.
- Performance: one `exp` per vertex per pass while rising, nothing once
  complete. Timing belongs on the RTX 3060 (see `landscape-performance.md`).
