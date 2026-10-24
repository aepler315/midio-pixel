# Panamint and Teton transfer and ending repair

This pass starts from main `1b46e5e3fad38b7b8c75d2391af2e6b79500bfff`.
It shortens the two priority transfers, restores a readable Panamint opening,
and replaces both unfinished closing links with shot endings in the reviewed
Anthem plan. The approved geographic count remains **13**. Further locations
remain on hold for camera quality.

The source fixes and the fitted candidate assets are separate. The source
proposal preserves the approved rail packages. The asset branch,
`review/scenic-transfer-endings-20261023`, contains **15 useful candidate
libraries, 172 shots and 420 links**, with a **64,852,720-byte** Range asset
tree. Tombstone remains rail-only. No fit, diagnostic override or capture
grants a camera approval.

## Cause and source changes

The R4 runtime climb and pacing fixes are already in the starting main.
This pass leaves `ShotPlanner`, `ShotTimeline`, global weights, motion limits
and the 50-second authoring admission leash unchanged.

The builder's duration estimate omitted the runtime's supported-curve bound.
For example, the former selected Panamint connection advertised about 49
seconds while its geometry needed at least about 84 seconds under the existing
runtime cap. The builder now uses production `shotPaceLimits`, including the
source-shot/link/target-shot support, and rounds the lower bound upward.
Both fresh discovery and cached reselection refresh these estimates before
admission and selection. Panamint's cache admits 358 of 903 connections;
Teton's admits 774 of 1,379. Cached reselection retains its rejected geometry
for diagnosis.

This corrects admission evidence. A 50-second lower-bound gate does not cap
the transfer exposure chosen by the music planner. Decoded paths, the timed
profile and the final Float32 camera spline retain their own physical checks.
Changing the global ending or transit weights could not satisfy both camera
requirements without other pacing losses, so those diagnostic experiments
were rejected.

A separate lighting correction preserves the existing extra diffuse moon
fill beneath the clearing shadow mask. Terrain and both forest paths use
the same helper. Total authored light, exposure, direct sunlight/moonlight,
actor light, specular and water behavior retain their previous equations.
The correction has no effect when the extra moon contribution or clearing
mask is absent.

The neutral review page also avoids calling `THREE.Object3D.add()` with an
empty forest list. That pre-existing empty-desert case logged an error during
fresh rail parity. The guard preserves the ordering of nonempty forest bands;
the zero-error assertion was retained.

## Actual plan comparison

These are actual app-worker plans for the same uploaded `anthem.wav`, natural
seed **2031031581**, duration **167,984.7619 ms**, and detected song structure.
The source audio SHA-256 is
`a691d46ebb2575a1ff5841960a50e39acb41cd085852f0a6b59030354b8fca90`.
Production CPU replay matches the worker's items, payoffs and Float32 keys.

| Measure | Panamint baseline | Panamint repaired | Teton baseline | Teton repaired |
|---|---:|---:|---:|---:|
| Longest transfer | 95.341 s | **63.542 s** | 70.356 s | **37.062 s** |
| Total transfer | 114.854 s | **63.542 s** | 95.173 s | **80.028 s** |
| Strong payoffs | 16 / 128 s | **16 / 128 s** | 16 / 128 s | **16 / 64.5 / 128 s** |
| Last item | Partial link | **Completed hero shot** | Partial link | **Partial closing shot** |
| Closing shot reached | — | Before cutoff | — | **160.328 s** |

Panamint's longest transfer falls by 31.799 seconds, about 33%; total transit
falls by 51.312 seconds, about 45%. Teton's longest falls by 33.294 seconds,
about 47%; total transit falls by 15.144 seconds, about 16%.

Panamint keeps two scenic shots and its fallback rail, joined by three
connections. Its Telescope Peak approach remains the 128-second hero and
continues through the ending. The short opening is the retained visible
295-metre tail of the cached valley reveal, cut at 1,100 metres. This is a
curated network, not a claim that unconstrained automatic reselection will
produce the same edit.

Teton keeps eight mutually reachable scenic shots plus its fallback rail,
with ten direct connections. Grand Teton and Mount Moran remain named hero
subjects in the library. The actually played opening and 128-second climax
revisit an **unnamed peak** from different approaches; named metadata does
not establish a named-hero climax. The final 7.656 seconds are a partial
closing shot before its payoff, not a completed final shot.

## Rendered review and rejected iteration

The actual app uploaded and analyzed the audio, generated its worker plan,
and continuously rendered from song start through cutoff. Each full capture
saves **657 frames**, quarter-second cadence plus the final checkpoint, from 4.000 through actual
**167.975 seconds**, at 640 × 360 output and quality zero. The initial fade
is drawn but unsaved. The requested last checkpoint is 167.983 seconds;
the rendered time is about 9.762 ms before detected song end.

The browser reports Chromium 156.0.8078.4 and RTX 3060 through D3D12/ANGLE.
It runs headless, muted and isolated in the background. All saved frames in
the compared arms were inspected in chronological whole-frame paired pages,
with native controls at opening, joins, payoffs and cutoff. The saved PNGs
and actual timestamps are authoritative; the audio-backed MP4s are lossy
viewing copies. No independent music-listening or high-rate/device acceptance
is claimed.

The first Panamint rebuild cut the longest transfer to 48.212 seconds and
improved the hero ending, but delayed its first payoff to 48 seconds. Actual
review rejected it: a close brown slope filled almost the entire frame at
4–20 seconds, followed by a long hazy setup. Its complete capture, 42 paired
pages, 23 native controls and explicit rejection remain preserved.

The repaired Panamint opening already shows separated near ridges, valley
space, distant ridge and sky at 4/8/12 seconds. The valley is clearly readable
at the restored 16-second payoff. Joins around 33.052 and 96.594 seconds appear
continuous at the recorded cadence. Telescope Peak is isolated against the
sky at 128 seconds and retains its complete summit silhouette and face detail
through cutoff, improving on the former foreground-obscured moving link.
Keep these camera improvements. The broad orange haze around 20–47 seconds
has lower distant contrast than the baseline's distinct peaks, and mountain
faces remain dark around 137–153 seconds. The remaining 63.542-second transfer
and two-shot variety remain editorial limits.

Teton's intermediate payoff is visible and its final central mountain crown
and upper slopes stay readable within the frame. The former close cone grew
through the right and bottom edges. Keep the shortened route and closing shot.
The broader range composition isolates peaks less strongly; lower slopes and
valley remain dark, and a peripheral distant ridge crosses the far-right edge.
Storm flashes create pronounced contrast changes, and both arms retain blocky
sky marks at 153.5 seconds. These observations are preserved; they are not a
proven regression caused by the scoped moon-fill change. The 60 Hz diagnostic
reports 15 second-difference flags, three near joins, versus nine and zero in
the baseline. Four-fps images cannot clear high-rate jerk.

## Fixed-camera lighting control

Black Mountains and White Mountains use separate same-camera A/B captures,
with identical audio, full camera keys and assets. Review covers 140 matched
frame pairs: early 14–18-second controls and late windows around 126–130,
156–161 and 163.975–167.975 seconds.

The extra moon fill gives a modest increase in terrain relief without visible
glow or authored sky change. Both views' 17 early images are byte-identical.
Black's late arms differ in 37 of 53 images; White's in 40 of 53. Three White
storm-control images differ at four terrain pixels each by at most one
channel level. White also has 96 changed pixels across three inspected top
sky strips, confined to narrow aurora columns at one channel level. This is
visually unchanged sky, not a claim of universal sky byte equality.

Retain this limited lighting improvement. Black's near forested ridge remains
very dark at cutoff; White's close foreground slope still dominates the
composition. Those broader ending concerns remain open before another
location wave.

## Fit, clearance and rail preservation

Both final packages fit their original limits; no temporary regional headroom
was retained. Teton has only 3,155 bytes of asset-budget margin.

| Check | Panamint | Teton | Existing limit |
|---|---:|---:|---:|
| Added asset bytes | 431,864 | 1,396,845 | 800,000 / 1,400,000 |
| Desktop triangles | 2,537,818 | 2,535,414 | 3,200,000 |
| Mobile triangles | 638,158 | 1,228,782 | 1,800,000 |
| Forest placement bound | 18,378,752 B | 159,768,384 B | 167,772,160 B |
| Coverage holes / LOD violations | 0 / 0 | 0 / 0 | 0 / 0 |

An additional Panamint audit found about two metres of conservative-floor
undershoot on the two unused return connections in the first trimmed package.
Uniform added floor padding and 10/20-metre trim shifts were rejected. The
retained repair regenerates only these return paths with an external copy of
the production connector: 10-metre path sampling and a shorter interior-lift
ramp against the **original** floor. Production connector defaults are
unchanged. Source, helper and package hashes record that offline curation.
All seven played timeline lanes remain byte-identical to the reviewed trim.

After quantization, production-supported return geometry has minimum sampled
floor margins of **0.762 / 0.761 metres**, at 0.1-metre progress spacing. The
played 60 Hz timeline has minimum floor margin **1.902 metres**, minimum bare
DEM clearance **284.007 metres**, and no below-floor/outside-grid sample.
These are finite-sampling checks, not an analytic continuous-clearance proof.
The network remains strongly connected; its longest advertised minimum is
46.969 seconds under the unchanged 50-second rule.

These passing results concern the repaired scenic geometry and played route.
The unchanged fallback rail retains a conservative-floor diagnostic violation
in the same audit (minimum about −96.418 metres, bare DEM clearance about
145.657 metres). Its stored geometry is preserved; this pass does not claim
that every fallback path satisfies the later scenic padding model.

Fresh rail parity uses each original approved camera at nine stations,
original and rebaked terrain, and the same neutral production material setup.
It tests terrain/forest preservation, separately from song lighting. Teton
has identical terrain fraction, skyline and hole measurements at all nine
stations; three PNG pairs are identical, and the remaining channel deltas are
at most 3/255 with no pixel over the existing six-level threshold. The original
one-pixel mask holes at two stations persist equally in both arms.

Panamint also passes the existing parity thresholds at all nine stations,
with zero page or console errors. At worst, 13 of 230,400 pixels differ by
more than six channel levels; the maximum channel delta is 38 on sparse
pixels. Terrain share changes by at most two pixels, skyline top is identical,
and no hole is added. All native pairs were inspected: ridge and summit
shape, snow marker, basin framing and relief remain visually matched.

## Verification, identities and reproduction

Final source verification reports **5,048 tests: 5,047 passed, zero failed,
one skipped**, with full lint exit zero and an unchanged immutable source
snapshot. The skipped published Monument Valley test separately passes
**1/1 with zero skips** against the final candidate overlay.

The unchanged 18-shot/594-link cold-planning check passes: fresh-library
minimum **48.1 ms**, median **49.1 ms**, maximum **63.1 ms**. Its existing
minimum-under-50-ms assertion is unchanged. A concurrent authoring run failed
that same gate at a 51.6-ms minimum. An intermediate quiet runner terminated
after completed passing test output; the final isolated process-group run
records both test and lint exit codes. Those attempts remain preserved, and
the final result does not establish a universal per-request 50-ms guarantee.

The final all-15-library Anthem CPU control changes only Panamint and Teton;
the other 13 plans and camera keys remain exact. There are no timeline or
exact key-climb failures. The largest key climb is **20.583327 m/s**, below
22 m/s. Panamint is **4.453735 m/s**, Teton **10.462646 m/s**; their measured
60 Hz tangential maxima are **1.237210 / 2.459496 m/s²**, below 3.5 m/s².
This is an Anthem control; prior R4 Drop evidence remains separate.

Fresh final app captures bind directly to the final manifests and served
snapshot. Teton's 657 PNGs are byte-identical to the fully reviewed version.
Panamint's final terrain matches in 646 of 657 PNGs; all eleven changed
native pairs were inspected. They contain 48 changed pixels total, at most
one channel level and eight pixels in any frame. The opening, climax and
cutoff controls are byte-identical. Audio, timestamps, settings, worker keys
and planned items/payoffs match; the expected rebaked `viewIdentity` changes.

The source implementation is pinned by code commits
`da2d00ac69025f4def32a49d3d0a6645c5f77ff0` and
`255dcf68d00db555193ee10bd384cf3e571db828`, layered on the stated main base.
Final documentation is layered afterward on
`fix/scenic-transfer-endings-20261023`; the candidate branch adds the fitted
asset overlay to that source. Publication proofs compare the exact commit
parents, trees, full UTF-8 source content and served-file blob identities.
GitHub's contents route omits the body for the large terrain binaries, and
the blob connector rejects their binary decoding; their remote verification
uses the returned Git blob SHA and size against the local byte-derived hash.
No full remote binary download is claimed.

Final library SHA-256 identities:

| File | Panamint | Teton |
|---|---|---|
| Shot manifest | `01a6f957fd6475786d81832c84e3662333ba2b997e293e39a604d918f0b3d8db` | `9953982fd898468ff90e5a2e4f4e397e0d895a36ba7584ad9c0320a7e9040e82` |
| Shot payload | `bac33e375676e1d922555268c446b9e6e12d5b612e9b949afee0a87347e7df77` | `f3497afc0650f01071d424070a23b05faeb36d7b45b7e7fd456bd287b941f708` |
| Terrain manifest | `fe9fe197b8e554e2249b3656b023b585d43a79168edd8a0f8dbbef090e33a795` | `f9c0851679291f6b6003ec885030aa78909371b17780337022f8cda106139f65` |

The final served snapshot has 682 files, digest
`a55914d09ecdaaa82b5606a82f5e849380bdbb70a346977d6b5acfc549a8a9ba`.
The separate candidate branch preserves the fitted files. To review it, use
Node 24, `npm ci --ignore-scripts`, and `node tools/serve.js 8080`, then the
existing diagnostic URLs with `?rangeView=panamint-dantes-view&rangeShots=all`
or `?rangeView=teton-jackson-lake&rangeShots=all`. Diagnostic playback grants
no approval and still checks package/base identity.

All media, capture JSON, helper prototypes, failed runs and hash proofs remain
outside Git in:

```text
C:\Users\aeple\Documents\ChatGPT\Midio Pixel\verification\rebuild-20261022\transfer-endings-r5
```

The local index is `actual-app-transfer-review.html`. Review records include
`panamint-motion-review/` (rejected), `panamint-repaired-motion-review/`,
`teton-independent-app-review/`, `source-review-r5-lighting-review.md`,
`fresh-rail-parity/`, final authoring fit directories and worker-binding files.
No captured evidence is committed. Source publication, candidate asset
publication, merge, deployment and camera approval remain separate states.
