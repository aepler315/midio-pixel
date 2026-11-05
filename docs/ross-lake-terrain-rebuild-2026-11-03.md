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
would need a fresh base approval as well.

## Shipping that tour would stop Ross Lake loading on phones

On 2026-11-04 Ashton chose to ship the tour over its byte and triangle
budgets. The rebake (`node tools/rebake-tour-terrain.mjs --view
nc-ross-lake-north`, on the camera-tour branch at 251d00d) gives the
numbers above and passes the base approval checks: far crest 0.64 at its
worst station, and travel to all 12 approved views. It is over a third
budget, though. The tour fit's forest build bound (`budget.forestBuildBytes`,
160 MiB) is 218.3 MiB, against 27.5 MiB for main's rail. Dropping shots
barely moves it: without the two most forest-hungry shots it was still
161 MiB under the older bound, because the 940 rail tiles that fill the
lake reflection drive it, not the library's own tiles.

So before raising that cap we measured whether the view still loads. A
budget denial in `RangeScene.prepare` defers the view and retries it for
good, so a view whose prepare can never fit is never shown. Ross Lake was
loaded in the app (headless Chromium, the live render-ready path) with the
residency budget forced through `navigator.deviceMemory`, touch points and
screen size, for main's rail package and for the rebaked tour package with
its approved library:

| Budget (who gets it) | main's rail | Rebaked tour |
| --- | --- | --- |
| 192 MiB (iPhone, iPad, Chrome with 4 GB or less) | loads, peak 176.9 MiB | never loads: the 218.3 MiB forest build is denied 274 times |
| 320 MiB (Android with 8 GB or more) | loads, peak 212.8 MiB | never loads: the 221.1 MiB terrain GPU reservation is denied 25 times |
| 256 MiB (forced; real Chrome never reports 6 GB) | loads, peak 249.4 MiB | never loads: the 298.5 MiB terrain GPU reservation is denied |
| 512 MiB (desktops) | loads, peak 249.4 MiB | not established: Range's own reservations reach 489.5 MiB and fit, then legacy strips push the ledger over 512 and the page stalled under SwiftShader |

An offline trace of the same reservations from the package data agrees. The
forest build is not what blocks the phones. It is admitted early, shrinks
after placement to 113.7 MiB of records that stay held, and then the terrain
GPU reservation, which charges the mesh and 2.31 M forest instances twice
(GPU plus the CPU copy kept on the buffer attributes), lands on top:

| Ross Lake's own prepare peak | main's rail | Rebaked tour |
| --- | --- | --- |
| mobile level of detail | 173 MiB | 408 MiB |
| desktop level of detail | 210 MiB | 486 MiB |
| steady state, mobile / desktop | 107 / 144 MiB | 252 / 329 MiB |

So raising the forest cap changes nothing on phones. A tighter forest bound
does not either: one counted for placement's own seed brings it to
148.4 MiB, under the cap, while the phones still fail at the GPU step. Even
with main's forest, the 1,105-tile terrain alone peaks at about 212 MiB on
mobile, over 192. 83% of the 2.31 M forest records are drawn by the tour
only, and the library's footprint is applied to the forest whenever the
library loads, on the rail too, so keeping phones on the rail saves nothing
without a code change.

On a 512 MiB desktop the tour would need about 486 MiB for itself, so
Ross Lake could not prepare during the travel into it (no approved view is
small enough to share the budget) and would always join late.

The measurement harness, the offline ledger and the per-view outputs are in
the project files under `ross-lake-residency/`. The tour fit's 160 MiB cap
guards the build bound, not the prepare peak that actually decides
loading, so a fit can pass while the view never loads on phones.

Shipping it would therefore take Ross Lake away from every phone that shows
it today. The decision went back to Ashton with that evidence, and until
then Ross Lake keeps main's approved rail package.

## Shipped without caps; each device takes what it holds (2026-11-04)

Ashton's answer was to cut the limits. Main had meanwhile changed under
the numbers above. A static view whose tour does not fit beside what is
resident is prepared for its rail alone (its shot tour state says "rail
kept"). Phones that report 8 GB now get a 512 MiB ledger, like desktops.
So Ross Lake's region sets every tour budget to `null`, which lifts that
cap (`budgetCap`, `tools/build-scenic-tours.mjs`). The 1,105-tile package
then ships with its approved library, and the runtime decides per device.

On main's runtime that package played its tour on no device and lost the
iPhone class. Two changes to `RangeScene.prepare` fix both. The second is
#80's, which this work builds on:

- **The surface build borrows the forest's idle allowance.** A static
  view's forest build entry keeps its grouping (16 B a tree) and an 8 MiB
  asset-build allowance until `createForest`, which runs only after the
  surface scratch is freed. Before, the 43.1 MiB surface scratch was
  charged beside them. Now it is charged only beyond that allowance (29.1
  MiB for Ross Lake's rail, about 0 for its tour). The ledger still holds
  at least what is live at every step, and never more than before.
- **The tour room check counts what prepare holds, in turn** (#80,
  `_tourRoom`). `_tourFits` added the forest placement bound to the GPU
  reservation and the surface, though prepare shrinks that bound to its
  records before it reserves either. It also counted the bound's 3.56 M
  trees, where placement keeps 2.31 M. It asked 550 MiB on a phone and
  628 MiB on a desktop. #80 takes the larger of the two peaks; a desktop
  whose placement fits places the forest and decides at the trees placed,
  and a phone keeps the up-front check at the bound. With the surface
  borrow counted there too, Ross Lake's tour asks 460 MiB up front on a
  phone (503 MiB without it).

Measured in the app as above (headless Chromium on SwiftShader, the live
render-ready path, the budget forced; ledger numbers, not timings):

| Budget (who gets it) | main's rail package | Uncapped tour on main's runtime | Uncapped tour with both changes (this branch) |
| --- | --- | --- | --- |
| 192 MiB (iPhone, iPad, 4 GB or less) | loads on its rail, peak 176.9 MiB | never loads: the rail fallback's surface scratch is denied 116 times at 189 of 192 MiB | loads on its rail and reports ready; ledger at most 192 MiB, 35.9 MiB of it evictable legacy strips |
| 512 MiB mobile (phones reporting 8 GB) | not run | loads on its rail ("its tour does not fit this device"), peak 231.9 MiB | prepares the tour (2.31 M trees, 1.41 M triangles): peak 405.5 MiB, then 320 MiB while it draws; never reports ready under SwiftShader (below) |
| 512 MiB desktop | not run | loads on its rail, peak 288.9 MiB | prepares the tour once its forest is placed (3.43 M triangles): peak 483.4 MiB, 35.9 MiB of it evictable legacy strips, then 398 MiB; never reports ready under SwiftShader |

No run crashed the page or was refused memory. Peak browser memory (all
Chromium processes, with SwiftShader keeping GPU memory in RAM) stayed
between 1.6 and 1.85 GB.

The prepare peaks this check now guards were also measured in Node. Each
of the 12 views with a loaded tour was prepared for both cameras from its
real package (stub renderer, 4 GiB ledger), at both levels of detail. The
table gives what each prepare reserved beyond what was resident when the
fit asked, and what the old check asked for:

| View | Mobile: reserved / old ask (MiB) | Desktop: reserved / old ask (MiB) |
| --- | --- | --- |
| nc-ross-lake-north | 335.3 / 550.3 | 413.2 / 628.2 |
| teton-jackson-lake | 261.3 / 469.9 | 310.7 / 519.3 |
| black-mountains-catawba | 311.1 / 449.3 | 376.7 / 514.9 |
| muncho-lake-south | 149.6 / 276.7 | 193.4 / 320.5 |
| izta-popo-west | 95.2 / 239.5 | 97.7 / 264.7 |
| san-gabriel-baldy | 139.2 / 190.4 | 163.8 / 215.0 |
| denali-wonder-lake | 133.1 / 166.2 | 185.1 / 218.1 |
| la-sal-castle-valley | 138.5 / 160.6 | 180.2 / 202.3 |
| panamint-dantes-view | 116.8 / 154.8 | 185.7 / 223.8 |
| monument-valley-163 | 128.3 / 156.8 | 155.2 / 183.8 |
| white-mountains-owens | 118.1 / 157.6 | 151.5 / 190.9 |
| chugach-matanuska | 112.4 / 153.3 | 162.4 / 203.2 |

The old check overstated every view, by 22 to 215 MiB. Teton and Black
Mountains, like Ross Lake, asked more than 512 MiB on a desktop, so no
desktop ever got their tours either (#80).

With what `test/tourRoom.test.mjs` holds resident (the decoded package,
12 MiB of material, 10 MiB of targets), the check on this branch gives
Ross Lake its rail on 192 and 320 MiB phones and on a 256 MiB desktop,
both cameras on a 512 MiB phone, and both cameras on a 512 MiB desktop
once its forest is placed. On a 192 MiB phone, Denali and La Sal now get
both cameras too, with White Mountains, Panamint, Chugach and Monument
Valley.

### What is still open

Frames. The tour places 2.16 M billboard trees, where the rail places
0.38 M. Under SwiftShader its frames draw up to 1.37 M billboard instances
in one call, in the lake's mirror pass and again in the band passes, 0.4 to
0.54 G vertices a frame. A frame there takes 10 to 90 s, so the
render-ready gate never reported ready within its bound, though the view
was prepared and drawing. That says nothing about a phone or desktop GPU:
frame timing has to come from the RTX 3060 workstation and a real phone.

The probe (now with a WebGL draw log), its results and the Node check are
in the project files under `ross-lake-residency/uncapped-2026-11-04/`.
