# Camera tour promotion (2026-11-03)

Ashton chose to promote the R7 reviewed shot libraries, with the Auto
camera's tour-versus-rail check ([one default camera](landscape-camera.md#one-default-camera))
guarding each song, and to rebuild their terrain so the rails keep the far
ridge. This file is the approval evidence for that promotion.

Source: [`review/scenic-framing-endings-20261023`](https://github.com/aepler315/midio-pixel/tree/review/scenic-framing-endings-20261023)
commit `27a6af0`, reviewed in [the R7 framing and ending review](scenic-framing-endings-review-2026-10-23.md).

## How a view with a shot tour draws (2026-11-04)

A tour package ships ground only its shot tour sees, marked `rail: false`
(tools/align-tour-terrain.mjs). The runtime draws two modes from the same
buffers, switched by draw ranges and instance counts when a song picks its
camera (src/world/alpine/RailDraw.js); nothing is rebuilt.

- **Rail**: only the rail's own tiles, shaped as if the tour-only tiles were
  absent; the forest the view places without a footprint; the water level,
  mirror plane and height range of the rail's tiles; the cast on the rail's
  water.
- **Tour**: every tile once, crack-free; the forest of the tour's footprint;
  the water, mirror and height range of all its ground.

The approval checks below measure the rail exactly as it draws: rail tiles
only (`terrainBandsFor(..., 'rail')`) and the rail's own trees.

## Rail parity with main

Measured against `origin/main` at `77febde`, for the 14 views with a
library.

- **Tiles**: every main tile ships as a rail tile, no extra rail tile, the
  same bands, and bit-identical shared samples. Some rail tiles are stored or
  drawn finer than main's, because the fixed tour bake (0347dca) never lets a
  rail tile be coarser than the rail package, but lets a close tour shot
  refine it. Rail triangles, desktop and mobile budgets:

  | View | Main desktop | Rail desktop | Main mobile | Rail mobile | Tour desktop |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | teton-jackson-lake | 1,484,050 | 1,484,050 (+0.0%) | 994,582 | 1,031,446 (+3.7%) | 2,596,206 |
  | denali-wonder-lake | 2,189,600 | 2,221,856 (+1.5%) | 843,248 | 923,048 (+9.5%) | 2,780,994 |
  | muncho-lake-south | 1,344,384 | 1,427,328 (+6.2%) | 521,784 | 763,440 (+46.3%) | 1,827,628 |
  | izta-popo-west | 1,122,984 | 1,129,128 (+0.5%) | 586,560 | 592,830 (+1.1%) | 1,194,918 |
  | black-mountains-catawba | 935,936 | 960,512 (+2.6%) | 615,200 | 696,608 (+13.2%) | 2,730,374 |
  | san-gabriel-baldy | 1,491,968 | 1,522,688 (+2.1%) | 901,952 | 943,424 (+4.6%) | 1,670,144 |
  | white-mountains-owens | 1,371,378 | 1,380,594 (+0.7%) | 783,900 | 850,812 (+8.5%) | 1,662,522 |
  | la-sal-castle-valley | 1,133,568 | 1,156,608 (+2.0%) | 678,306 | 854,850 (+26.0%) | 2,106,252 |
  | panamint-dantes-view | 2,382,928 | 2,429,104 (+1.9%) | 524,098 | 717,058 (+36.8%) | 2,707,504 |
  | chugach-matanuska | 1,717,384 | 1,743,496 (+1.5%) | 752,092 | 843,580 (+12.2%) | 2,418,686 |
  | monument-valley-163 | 893,110 | 893,494 (+0.0%) | 697,306 | 751,552 (+7.8%) | 1,791,830 |
  | sawtooth-redfish-north | 1,164,416 | 1,164,416 (+0.0%) | 817,922 | 817,922 (+0.0%) | 1,365,134 |
  | shenandoah-stony-man-west | 781,440 | 806,016 (+3.1%) | 372,630 | 475,446 (+27.6%) | 1,251,474 |
  | superstition-west-front | 1,880,420 | 1,938,788 (+3.1%) | 888,818 | 1,031,888 (+16.1%) | 2,465,414 |

- **Forest**: on every one of the 14 views, the rail draws exactly the trees
  of the view placed without a footprint (the same records as a multiset,
  ring by ring), and every placement fits its reservation bound. Before
  this, the footprint's forest also played on the rail: 2.4 to 4.3 times the
  trees (Teton 208k to 901k), which lowered Shenandoah's far crest from 0.971
  to 0.872 and failed a new travel pair.

## Far-crest exposure (`--approve` checks)

Rail exposure at 21 stations, worst station, with the rail drawn as above
(floor 0.55 exposed, 0.5 of the frame spanned). Every value equals main's.

| View | Worst exposed | Crest span | Main |
| --- | ---: | ---: | ---: |
| nc-ross-lake-north | 0.643 | 1 | 0.643 |
| teton-jackson-lake | 1 | 1 | 1 |
| denali-wonder-lake | 1 | 1 | 1 |
| tombstone-north-klondike | 0.768 | 1 | 0.768 |
| muncho-lake-south | 0.911 | 1 | 0.911 |
| izta-popo-west | 1 | 1 | 1 |
| black-mountains-catawba | 1 | 1 | 1 |
| san-gabriel-baldy | 0.919 | 1 | 0.919 |
| white-mountains-owens | 1 | 1 | 1 |
| la-sal-castle-valley | 1 | 1 | 1 |
| panamint-dantes-view | 1 | 1 | 1 |
| chugach-matanuska | 0.815 | 1 | 0.815 |
| monument-valley-163 | 0.753 | 1 | 0.753 |
| sawtooth-redfish-north | 0.755 | 1 | 0.755 |
| shenandoah-stony-man-west | 0.971 | 1 | 0.971 |
| superstition-west-front | 0.807 | 1 | 0.807 |

Travel between every pair of the 16 views: the same 10 pairs fail as on
main, each with Sawtooth, Shenandoah or Superstition on one side (worst
Shenandoah to Sawtooth, 0.393). Every pair between approved views passes.

## Tour coverage

Each library was fitted to the R7 package of its view (`bb85fa8`). On all
14 aligned packages every R7 tile ships, visible wherever R7's was, at no
coarser stored stride and no coarser desktop or mobile level, with
bit-identical shared samples. Each library's manifest binds the current
terrain manifest (`terrainManifestSha256`).

## Result (2026-11-04)

`tools/build-range-scene.mjs --approve`, then `--approve-tour`, with this
file and the R7 review as evidence (plus each view's earlier rail evidence):

- **Approved, view and tour (11)**: Teton, Denali, Muncho, Izta, Black
  Mountains, San Gabriel, White Mountains, La Sal, Panamint, Chugach,
  Monument Valley. With Ross Lake and Tombstone (unchanged rails, no tour)
  the catalog approves the same 13 views as main, so every biome keeps its
  approved scene.
- **Still candidates (3)**: Sawtooth, Shenandoah and Superstition pass their
  own stations (worst 0.76, 0.97, 0.81) and fail travel against Ross Lake
  (0.41, 0.53, 0.54), exactly as on main. Their tours need an approved base
  view first.
