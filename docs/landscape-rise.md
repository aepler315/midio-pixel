# Landscape: flat ground grows into the range

Landscape starts with **level ground**. Every terrain height, including valleys
below the camera, starts at one fixed ground level and grows with the song. The
previous eye-relative squash left valleys intact and made the skyline look cut
off; it is no longer used.

The existing music-driven climb, slow camera retreat, weather, fog, water and
final landscape remain. The independent voxel prototype still owns its own
progressive cell-resolution demonstration; the default Landscape renderer does
not add a voxel conversion or a full-resolution postprocessing pass.

## Height and camera

For source elevation `y`, ground level `baseM`, and song rise `s`:

    drawnY = baseM + s * (y - baseM)

`s` starts at exactly 0 and reaches 1 before the closing camera move. The base is
stable for the entire view: its authored lake level when present, otherwise the
source terrain minimum. It is not recomputed from the camera or a streaming
window. Signed elevations are valid.

`LandRise.js` provides the CPU and GLSL mapping. `uLandRise` stores `(1-s, baseM)`.
At full height its functions return immediately. Terrain, trees, rivers, actors,
lanterns, mirrors and all terrain depth/ownership passes share this mapping.
Musical terrain movement is composed before the rise, so it cannot introduce
relief at the completely flat opening. Normals use a finite inverse-transpose
form at `s=0`; full-height normals are returned unchanged.

`LandRiseCamera.js` moves the authored eye with the ground below it while
preserving its clearance (at least 2 metres). The target follows the same height
map. This makes the opening look across ground instead of looking down from the
original summit-height camera. At `s=1` the original pose is returned unchanged.
The authored zoom and tour path still control horizontal travel and framing.

Mirror cameras reflect across the mapped water level. Fragment membership tests
continue to use the source water level because their coordinates are in source
space. Fog base/top follow the height map during growth. Billboard footprint
depth and the far-canopy viewing ray use the growing scene too.

## Ground coverage

The shipped terrain packages omit ground hidden from their original cameras.
Flattening the whole landscape can expose those gaps. `RiseGround.js` supplies a
bounded, temporary backdrop while `s<1`:

- An analytic level ground plane fills rays below the horizon.
- A 129 by 129 heightfield retains sampled shipped elevations and infers missing
  samples by nearest-source propagation and fixed relaxation. It grows with the
  real terrain. These inferred portions are scenery, not additional measured DEM.
- Fine terrain always draws over this background. Support depth is cleared before
  the real terrain prepass, so it cannot hide valleys, forest or water.
- The background fades during the final eight percent of relief and is omitted
  entirely once the climb completes, avoiding a completion-frame pop.

CPU/GPU buffers and construction scratch are admitted with the prepared view:
1,009,053 bytes per view. Both geometries and their materials are disposed with the
view, including prepare failures. The same ordering applies during travel and in
the lake mirror.

Bounds map both their minimum and maximum elevations. Tree culling includes the
flattened geometry. Tour forest selection uses horizontal route distance so trees
brought near the lower camera remain available; this can conservatively retain
more mesh trees than the former 3D selection even at full height. Streamed terrain
windows cover the continuous eye/aim envelope between flat and complete poses,
and accept the actual lowered camera without rebuilding on every frame.

## Song timing and seeking

`compileLandRise` in `LandscapeScore` integrates `0.6 + energy` over heard time.
It reaches full height at `max(0.6 * cadence, cadence - 20 seconds)`, easing the
last 15 percent of the climb. Previews without a score show the complete range.
When full-song analysis replaces the opening analysis, the curve holds the
previous rise through the handoff and continues from there, taking at least eight
seconds to finish. Seeking and restarting derive the height and camera from the
requested song time; no accumulated growth state needs resetting.

## Verification

Run `npm run test:rise-coverage` for structural coverage of every shipped view.
It checks the finite inferred grid, exact flat opening, full-height identity,
coverage extents and admitted memory. It does not claim that inferred elevations
are surveyed data or prove every intermediate camera pixel.

Focused tests cover CPU/GLSL height rules, finite normals, camera clearance,
rewind purity, transformed terrain/tree/mirror bounds, ground draw ordering and
tour-window coverage. Actual image and performance validation belongs on the
RTX 3060; see `single-stage-rendering.md` for the recorded runs.
