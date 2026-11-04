# Landscape: the range rises with the song

Status: **on by default** in Landscape, for every view and both cameras (the
rail and shot tours). No URL flag and no setting. Code:
`src/world/alpine/LandRise.js`; tests: `test/landRise.test.mjs`; coverage
check: `npm run test:rise-coverage` (`--truth` checks against real
elevation).

At the first beat the mountains are pressed down toward the horizon, about a
tenth of their height above the eye (in a shot looking up past the horizon,
onto the frame's bottom edge). As the music plays they stand back up,
faster through loud passages and steadily through quiet ones, and the
complete range stands before the closing camera move. After that every pixel
is the one the view drew before this change.

## The map

Only land above the drawing eye moves, and only straight down. For a point
`h` metres above the pivot (the eye's level, or the frame's bottom edge when
that looks above the horizon; see below) at horizontal distance `r`:

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
- **The frame's bottom.** A shot pitched up at a summit need not show the
  horizon (Denali's tour looks 11-13 degrees up at Denali and Foraker).
  Squashed toward the horizon, its land would leave through the bottom of
  the frame, and the shot would hold only sky for the first third of the
  song. So when the frame's lowest corner looks above the horizon, the
  squash pivots there (`risePivot`, packed with the sink): `h` is measured
  above the cone at that elevation, land at the bottom edge stays put, and
  the range is pressed down onto it. Any increasing remap of elevation keeps
  the two properties above, and nothing drops below the pivot.
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
progress), so it never jumps or sinks. What is left never finishes faster
than over 8 s, so a new curve whose climb is over, or a moment from over,
at the handoff eases the land up instead of snapping it complete.

## Where it is applied

One `uLandRise` vec2 (the sink, `1 - s`, and the pivot's tangent) and the
eye in `uTourEye.xyz`.
`uTourEnabled` moved into `uTourEye.w`, so the terrain fragment shader
stays at 247 of its 248 uniform vectors. At zero sink every function
returns early: the complete range costs nothing and is byte-identical.

- Terrain (`SCENE_VERT`, every pass: colour, depth, ownership, crest probe,
  feature ink, water, mirror): `p.y += riseLift(p)` after the glacier and
  the musical lift, outside the receiver mask and the tour fade. The land
  dance and the swell are computed exactly as before; above the eye they
  are drawn through the squash too, so early in the song a swell there
  moves the land by about the rise's share of its usual pixels. (Lowering
  the unlifted land and adding the swell after would make a swell act about
  ten times larger on the squashed range, uncovering land the package's
  swell margin never shipped.)
- Lighting: the gradient and the drop are taken once per vertex at the
  lifted point (`vRiseGrad`, w the drop; creeks take both at their bank's
  corners). Ground shading and silhouette-ink normals are carried through
  the map (inverse transpose). Snow, rock and forest masks keep the
  full-height slopes they were placed on. The baked sun horizon holds
  full-height elevations, so the light's tangent is stretched instead.
- The painted far forest is the complete range's, as the mesh trees are
  (lowered vertex by vertex, so their image is the complete range's
  squashed): its cover and tree dots are seen along the ray to the
  unlowered point, and its crown normals are not carried through the map.
  The two forests cross-fade at 6.5-7.8 km, so they must be one picture.
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
depends on which analysis was current). The pixel-mode forest detail
footprint moves and grows each tree's sphere instead (`risenSphere`), by
the spread of the drop across it, so it is exactly the unrisen sphere
below the eye and once the range stands complete: tree detail does not
pop when the climb ends. The developer-only compiled-terrain experiment
draws groups that reach above the eye unculled while the land is rising.

## Coverage

- **Rails:** at 21 stations on each of the 19 rail views, no column has
  shipped land above the frame's top. Land rising above the top would cross
  it inside a tile the bake kept, so no unshipped land stands there either,
  and nothing missing can come down into the frame.
- **Shot tours** fly under ridges: 137 of 2444 sampled poses across the 14
  libraries have shipped land above the frame (San Gabriel: 91 of 165).
  Those are checked against real elevation (Terrarium z12, georeferenced to
  each package from its landmarks and rail ends; heights agree with the
  package to tens of metres at the 90th percentile). A pixel whose
  full-height ray lies inside the frame shows land the complete range
  draws too, at another row, so only rays from outside the frame are new:
  at the first beat's rise none of the 658 k such pixels first meets an
  unshipped tile. The same check with a fifth of the tiles removed fails,
  as it should. Poses with no land above the frame are covered by the rail
  argument.
- **Land kept:** at every rail station and sampled tour pose, every column
  with land in frame at full height still has land at the first beat.
  Without the frame-bottom pivot, Denali's tour (30 of its 200 sampled
  poses pivot) loses all the land in 987 of those columns.

Run `npm run test:rise-coverage -- --truth` after rebaking a package or a
shot library.

## Limits

- Views whose skyline barely clears the horizon from the rail (Tombstone,
  Pend Oreille) barely rise: there is little land above the eye to lower.
- A tour camera above the whole range sees no change (Owens' tour).
- A shot pitched up past the horizon presses its range onto the frame's
  bottom edge, so early in the song its subject sits low in the frame.
- Mapped tours (only `teton-range-tour`, a candidate) plan summit tiles
  above the eye at finer strides for the whole song.
- Lantern light submersion uses the CPU-lowered anchor plus the musical
  lift; above the eye it can differ from the lantern by at most that lift,
  and the cloud sea never reaches above the eye.
- Performance: one `exp` per vertex per pass while rising, nothing once
  complete. Timing belongs on the RTX 3060 (see `landscape-performance.md`).
