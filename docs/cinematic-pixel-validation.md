# Cinematic Pixel validation — 2026-10-24

Repository base: `387f9631b43e254c56eb2d6e1545aef140f4392e`. Rendering implementation through `9d1f4b5`; final documentation commit is listed in the delivery manifest. Work is local on `feat/cinematic-pixel`. No merge, deployment or physical-display acceptance is implied.

## Observed visual result

The retained version creates deeper navy/green foreground values and separates those slopes from luminous distant air. Mountain shadow faces are cooler; snow and river highlights remain readable. The native stepped skyline remains evident. The first lighting-only iteration was too subtle; the larger improvement came from using depth-dependent atmospheric color before the final sRGB conversion. A first cloud tint was too dark and was corrected after actual sunrise inspection.

This is a meaningful improvement toward the supplied reference, not a claim of matching its authored beauty. Mid/far mountain faces can remain broad and flat. Clouds can retain a tinted rim. Forest crowns still reveal regular structure, and thin moving details still inherit native-raster aliasing. No temporal reconstruction was added, so there is no new temporal history to ghost or disocclude.

## Captures and provenance

All production captures were headless and muted. Native Windows Chrome reported `ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)`. Sources were immutable hash-addressed snapshots, with exact PNG/audio hashes and actual camera, time, quality, grid, backend and weather diagnostics. Output was 1280×720; Classic+ source was 400×225, with the engine's existing overscan target. Black Mountains additionally used Detailed 640×360. Exact PNG/audio players accompany the evidence; contact sheets are summaries only.

| Study | State and scope | Evidence |
|---|---|---|
| Original Classic+ baseline and regression | Jackson Lake, generated contrast, 12–13 s, 4 saved samples/s plus endpoint | All five Pixel PNGs byte-identical after implementation |
| Predawn | Same Jackson Lake passage, moon visible, night≈0.518, no storm | Five Cinematic frames; stronger near/distant separation |
| Sunrise cloud sea | Ross Lake, generated contrast, 24–25 s, cloud-sea fill = 1 | Intentionally dense cloud sea retained; source opacity/time unchanged |
| Natural storm | Ross Lake, generated contrast, 60–61 s, storm≈0.571, wet = 1 | Pixel/Cinematic at same camera/time; atmospheric-color revision inspected |
| Controlled dry daylight | Ross Lake, generated steady recording, 45–47 s, 12 fps | 25 matched PNGs per Look; camera/control/audio identity verified |
| Forest motion | Black Mountains, Detailed, steady recording, 45–47 s, 12 fps | 25 consecutive frames, quiet foreground texture and stepped silhouettes inspected |
| Inland coverage | Panamint, Classic+, steady recording, 45–46 s | Five frames; real v2 backend/quality/capture controls passed; this does not certify all inland material aesthetics |
| Cinematic repeat | Ross Lake natural storm, identical 60–61 s request | All five repeated PNGs byte-identical across the later lifecycle-only changes |

**Dry diagnostic disclosure:** the existing `mgr.stormOverride` was set to dry in both Looks before every draw. Every saved frame verifies actual terrain and sky weather zeros, cloud-sea fill = 0, night = 0 and fully visible sun (altitude≈0.831–0.907). Real terrain, procedural materials/forest, clouds, music analysis, camera and production export-clock drawing remained active. It isolates receiver lighting and ordinary haze; it is not evidence that authored weather naturally stays clear. The study uses the same audio hash, full camera/control snapshots and complete 25-frame schedule on both sides.

The original WSL bridge snapshot omitted source commit metadata, so the existing strict comparison tool rejected its baseline despite successful captures. That failed comparison is preserved. A separate check established exact PNG equality at all five baseline/regression frames. The bridge now captures real Git commit/dirty metadata before launching Windows. Old reports were not relabeled and comparison rules were not relaxed.

The final steady and forest clips cover only short fixed-clock windows. They do not prove every procedural scene, fast camera turn, full-length song, mobile GPU, physical display, audio listening quality or hardware encoding path. Source audio is deterministic generated diagnostic material; no representative real-song listening session is claimed.

## Live performance and fixes

Separate 30-second live traces ran the authored Teton tour with real upload/analysis/readiness, the same steady recording, Classic+, 1280×720, headless RTX 3060 and requested60 fps. Traces were serialized after other GPU probes stopped.

| Metric | Pixel baseline | Final Cinematic |
|---|---:|---:|
| Delivered FPS | 21.31 | 21.41 |
| Delivered interval median | 50.0 ms | 50.0 ms |
| Delivered interval p95 | 66.7 ms | 66.7 ms |
| Longest delivered interval | 100.1 ms | 116.7 ms |
| Gaps over100 ms /30 s | 1 | 3 |
| Failed presentations | 0 | 0 |
| Browser errors | 0 | 0 |
| Graphics overcommits | 0 | 0 |
| Peak accounted graphics | ≈510.6 MiB | ≈511.0 MiB |

**Both live runs fail the repository's delivery target** (p95≤20 ms and at most one >100 ms gap per minute). The single traces are observations, not a statistical performance-equivalence claim. Both reached quality rung 6; reconstruction and cloud tint variants were therefore shed, while cinematic lighting/atmospheric color remained active. The final Cinematic heard clock advanced normally and all non-delivery technical gates passed.

The live loop exposed defects that static screenshots did not: voluntary context loss during quality shedding, then optional title/cloud storage that delayed streamed terrain windows. The final design suspends/reuses one idle reconstruction context, keeps the legacy title free of that pass, and returns cinematic cloud allocations before terrain admission at q≥2. A failed intermediate run with180 presentations rejected is retained; the final repeat has zero rejected presentations.

At quality 0 in the static studies, the optional output pass cost roughly7–10 ms steady CPU presentation time at720p versus roughly1–3 ms for nearest presentation; first-use context/shader work was substantially slower. Those timings are neither GPU timer-query measurements nor liveFPS measurements. GPU utilization percentages and physical scanout were not measured. Ownership estimates exclude driver/context overhead. Mobile/4K performance remains unverified.

## Automated checks

**Final serial `npm test`: 5198 tests, 5187 passed, 11 skipped, zero failed (228.9 seconds).** `npm run lint` and `npm run stage:site` both exited successfully. A separate final native Windows Chrome GPU run passed its actual-browser regression; that fixture is one of the Linux suite's 11 skips. Other skips are environment/cached-data dependent and remain explicitly recorded in the full test log. The delivery manifest records command results and hashes.

The native Chrome regression additionally exercises actual WebGL output: vertical orientation, five numerical ramp positions, nearest partial-alpha ownership, transparency, genuine context loss/restoration, denied-resize resource retirement, and three idle suspend/resume cycles reusing the same context. It checks zero released ledger bytes and absence of invalid GL/context-loss events on normal suspension/disposal. Numerical/profile tests cover day/night/storm bounds, deep mist convergence, dark-source behavior, mode reset, persisted preferences, export ingress, strict capture validation and early cloud-cache shedding.

The unmodified baseline suite had5163 passes,10 skips and one failure in `shotPlanner.test.mjs`'s pre-existing <50 ms timing benchmark under load. Its isolated rerun passed. The final serial suite result is reported separately rather than hiding the baseline failure.

No captured media or report JSON was committed. The deliverables contain source/commits, documents and separately packaged evidence. Site staging is a build check; it is not publication or deployed-site verification.

## Next work by expected visual impact

1. Broad geological face/material variation: clearer large illuminated planes, less bright ground striping, richer soil/meadow grouping.
2. Separate nearest material/coverage from smooth low-frequency irradiance and atmosphere if compatible-cell color gradients remain limiting. Prototype with real depth/ownership rejection before expanding buffers.
3. Forest crown value grouping and movement: improve near/far consistency and reduce regularity/aliasing of thin silhouettes.
4. Directional cloud/mist scattering and less rimmed cloud light, using existing sun authority and terrain depth.
5. Camera composition scoring for foreground framing, quiet sky and multiple distinct landscape layers.

Streaming/frame-delivery work is a separate performance priority before claiming60 fps on this tour. Retain only changes supported by matched moving footage and measured cost.


## Moon correction — 2026-10-25

The shared smooth-sky moon now uses pale low-contrast procedural albedo, exact phase coverage and gently shaded lit-side compositing. The opaque blue-black backing sphere and artificial 16% minimum illuminated area are removed. Daytime unlit pixels remain sky-transparent; reflected earthlight is limited to a faint night limb. The existing projected solar tangent, body size/position, song phase clock and terrain illumination remain authoritative. One additional 192×192 accounted scratch shades the moon without per-frame pixel readback; reservation refusal draws a correctly phased silver silhouette.

The native Canvas regression checks seven phases in day/night, new/full/quarter area, shadow transparency, restrained full-moon texture, solar-facing orientation, allocation refusal and disposal. A matched Ross Lake capture uses the same 45-second dry diagnostic/audio/camera as the original evidence. This intentional shared-moon change affects Pixel and Cinematic; the earlier five-frame byte-identical Classic regression describes the original Cinematic implementation before this correction.
