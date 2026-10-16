# Projected terrain motion

This is a geometric diagnostic of the three forced terrain pilots, not a visual approval. It measures source terrain anchors projected through one fixed camera, with music displacement enabled and disabled. Both sides retain the same heard time, glacier state, camera matrix and lighting. The report records the source hashes, asset hashes, camera matrices, synthetic channel inputs, calibration gain, geological cap, projected bound and measured distributions.

## Reproduce

From the repository root with the locked development dependencies installed:

```sh
node tools/range-motion-evidence.mjs \
  --output docs/evidence/terrain-continuation/projected-motion.json \
  --columns 12 --rows 12
```

The committed run uses the rail midpoint, 60 seconds in a 120-second synthetic journey, and a 1280×720 stage. It tests quiet, sustained bass, isolated kick and dense channel states separately. These are explicit synthetic calibration probes, not assertions about an unheard recording. The normal tool default is a denser 24×18 ray grid. Use `--stations 0,0.25,0.5,0.75,1` for additional fixed-camera stations; it takes proportionally longer.

The sampler rebuilds the same desktop-budget terrain mesh from payloads whose compressed and decoded SHA256 hashes are checked. It applies the production CPU deformation and glacier functions to each vertex, then compares matching triangle/barycentric anchors. Front-sided ray intersections exclude hidden terrain in both poses. Water-pinned triangles, off-stage points and the candidates' conservative foreground strip are excluded. The hydro displacement check also examines pinned vertices directly.

`crest` means the first sampled non-near terrain in each screen column, not a precise traced skyline. `flank` means the remaining sampled far/mid terrain. `near` means samples owned by the near terrain band. Groups are distinct, and empty groups report their zero sample count. Every displacement is normalized to a 720-pixel stage; portrait export bars are excluded from the normalization height.

## Midpoint results

All values are nominal 720-pixel displacement. The table highlights the strong probes; the JSON includes every state, sample count, median, p95 and maximum.

| Pilot | Probe | Crest p95 | Flank p95 | Near median / p95 |
|---|---|---:|---:|---:|
| Teton coherent candidate | Sustained bass | 1.80 | 0.78 | 0.02 / 0.05 |
| Teton coherent candidate | Dense | 3.04 | 0.77 | 0.06 / 0.12 |
| Monument coherent candidate | Sustained bass | 1.36 | 0.22 | 1.36 / 2.18 |
| Monument coherent candidate | Dense | 2.52 | 0.18 | 3.07 / 4.51 |
| Pend Oreille candidate | Sustained bass | 0.32 | No samples | 0.03 / 0.62 |
| Pend Oreille candidate | Dense | 0.63 | No samples | 0.04 / 0.43 |

Water-pinned vertices move exactly 0 metres in all twelve pairs. Quiet motion is lower than the strong probes. At this station and sampling density, Monument's upper near-feature distribution reaches roughly 4–5 pixels in the dense probe, while the other measured distributions remain restrained. None establishes the intended 4–10 pixel sustained-flank role. Pend Oreille exposes no sampled far/mid flanks at this station; that is missing group evidence, not proof of zero movement throughout its geography.

These findings support keeping the geological caps and doing closer-framing auditions before considering any gain change. No amplitude multiplier or cap increase was made from this diagnostic. A single camera station and synthetic state cannot establish which view succeeds throughout a real song.

## Browser continuation

The assembled smoke can record each actual source-derived frame and painted camera for the same three forced pilots:

```sh
node tools/landscape-performance-smoke.mjs \
  --url http://127.0.0.1:8080 \
  --fixtures /path/to/landscape-fixtures \
  --output .smoke/terrain-motion \
  --suite motion
```

It records pilot source positions at 21, 42 and 42.5 seconds plus a quiet-source position at 21 seconds. The resulting screenshot and geometry measurement have the same source frame; source passages are not labeled as isolated kick or bass without evidence. Full Three remains a Node development dependency, so no raycasting code is added to the production runtime bundle.

No current browser capture was possible in this environment because Chromium is unavailable. The geometric visibility mask does not model forests, luminous ridges, atmosphere, color contrast, or the final layered composite. Current-source 20–40 second clips, response-disabled comparisons, real-song judgments and physical-device timing remain necessary for artistic and performance acceptance.

## Source continuity

The JSON's `sources` map retains the exact source identities at evaluation time; it has not been relabeled as a final-branch capture. The run started at `d89b8914dec9d25958a238786d01c0567f2fe074`. A subsequent correction changed `buildRangeFrame`'s melody input. The directly probed `rangeMusicState`, `calibrateRangeMusic` and `sceneDeformation` function bodies were compared against that recorded commit and remain byte-identical; their hashes and the comparison commit are recorded in `sourceContinuity`. Every other source file in the measurement map matched the final measurement checkout when this continuity check ran. These direct synthetic probes do not exercise the corrected source-history melody handoff.
