# Ross Lake terrain rebuild from 3DEP (2026-11-03)

Part of the [camera tour promotion](camera-tour-promotion-2026-11-03.md).
`tools/reband-tour-terrain.mjs` refused Ross Lake (`nc-ross-lake-north`)
because its R7 tour terrain differed from main's approved heights by up to
3.65 m on 25 tiles. This note records why, the fix, and what a rebuild from
the source elevation shows.

## The drift came from the DEM cache, not the bake

main's Ross Lake package and R7's tour package carry the same 68 source
hashes and the same `dem` block. Only the normalized grid differs: main's
`demSha256` is `83648e55…`, R7's is `c6d71624…`.

main's grid was normalized on 2026-09-29, before
`tools/terrain/normalize-dem.py` cached 3DEP windows, straight from the
remote Cloud Optimized GeoTIFFs. Since 2026-09-30 each tile is cached as a
crop of the whole view envelope, padded with no-data beyond the tile. GDAL's
average warp then writes partial-coverage averages over the 1-degree tile
seams. The cells that move are one row along 49° N and one column along
121° W: 2,647 of 5,022,081 cells, by up to 3.65 m.

Rebuilt from 3DEP here (GDAL 3.8.4), the three ways to read the same four
tile files give:

| Read | Grid heights sha256 |
| --- | --- |
| Remote COGs, no cache (how main was built) | `83648e55…` (main) |
| Each tile cached as its own window (`--window-cache tile`) | `83648e55…` (main) |
| Each tile cached as the padded envelope (default) | `6162e98f…`, the same heights as R7 on every shipped tile |

## The fix

- `normalize-dem.py --window-cache tile` caches each tile's own window, the
  pixels its provenance already hashes, and warps bit-identically to the
  direct read. `envelope` stays the default, because six multi-tile 3DEP
  views were baked with it since 2026-09-30 and still reproduce: Monument
  Valley, Panamint, Pend Oreille, Sawtooth, Teton Jackson Lake and the Teton
  range tour. A view inside one tile gets the same grid either way.
- A view's `dem` block can set `windowCache` and `pin` (3DEP tile id to
  dated URL, or an absolute path to a local copy). Pinned tiles skip the TNM
  products API and can't move to a newer publication under an approved
  view.
- The TNM products API is retried with backoff, because it answers 504s and
  200s whose body is an error object.
- Ross Lake sets `"windowCache": "tile"` and pins main's four tile files.
  `node tools/build-range-scene.mjs --view nc-ross-lake-north` now rebuilds
  main's rail package with an identical payload (`b621d841…`). Only the
  manifest's provenance block changes (`readFrom`, `cacheLayout`,
  `retrievedAt`).
- `test/terrainDemContract.test.mjs` pins two synthetic 3DEP-style tiles
  that meet at 121° W to local files. It checks that the tile-window cache,
  on a miss and on a hit, gives the same heights as warping the files
  directly.

## The tour terrain is over budget once it covers the rail's reflection

A tour bake from the corrected grid keeps main's heights and bands on every
tile the rail ships. It needs 1,105 tiles, though, where R7 shipped 718.

The 387 extra tiles are all far (11 to 53 km), and they come from the 21
mirrored rail stations. `libraryCoverage` has added those stations since
e23ab1a (2026-10-23) and holds them to the rail's pixel limits. R7's
package predates that rule: a rail + tour bake without the mirrored rail
gives exactly R7's 718 tiles and 2,919,458 desktop triangles. Validated
against today's rule, R7's package leaves all 21 mirrored rail stations
with holes on both budgets. main's rail-only package does too, with holes
up to 15% of the reflected frame.

With the rail-tile rule of 0347dca (mirrored rail stations are rail viewers
when the rail's own tiles carry the lake), the full bake ships 940 rail
tiles: main's 355 with their heights and bands unchanged and 11 strides
finer, plus 585 that fill the reflection. The other 165 are tour-only
(`rail: false`). It adds 1.88 MB against Ross Lake's 1.4 MB `assetBytes`,
and its 3,428,354 desktop triangles exceed the 3.2 M default (mobile
1,412,642 is within 1.8 M). Because the rail's tile set changes, the view
would need a fresh base approval as well. Whether Ross Lake's
tour ships over budget, is trimmed, or waits on its rail is Ashton's call.
Until then Ross Lake keeps main's approved rail package.
