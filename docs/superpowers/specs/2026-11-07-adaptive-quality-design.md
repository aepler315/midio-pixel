# Adaptive quality with a consistent Landscape

The quality engine should seek the highest affordable detail under the selected FPS cap and General quality ceiling. Device tiers may change representation, sampling and output resolution, while terrain source, mountain construction, camera paths, heard-time responses, weather, sky landmarks and forest character remain recognizable.

Extend the existing PerfGovernor instead of adding a competing controller. Continue observing raw callback periods for stalls/GPU pressure; add measured CPU frame work only for actually rendered frames. CPU submission time is not GPU time. Require sustained work headroom before a quality increase, keep bounded one-rung probes, roll failed probes back quickly, and retain retry backoff. Sustained CPU work approaching the cap can lower detail before a dropped callback. Keep warmup, visibility, pause, export/fixture pins and explicit quality ceilings. Do not infer headroom from skipped draws at 24/30 FPS. Missing timing keeps the existing period-based fallback.

The Landscape quality policy keeps recognizable sky/lighting features present at every rung. Prefer sampling/geometry reductions and the existing adaptive output sizing. Preserve inexpensive sun shafts, cloud shadows, landscape forms and reflected sky; the expensive planar terrain mirror may fall back to existing sky reflection. Avoid changing artistic pixel-grid selection or memory-admission safety.

Alternatives considered: existing period-only recovery cannot detect CPU saturation before a missed frame; independent per-feature benchmark calibration adds invasive timing and extra renders. The selected extension is a bounded, reviewable improvement using current architecture. It cannot promise zero dropped frames or measure GPU headroom directly.

Validation: synthetic workload and cap simulations, failed-probe/backoff/ceiling/invalid-sample checks, Landscape feature-preservation tests, main-loop wiring tests, focused integration tests, lint/module linkage, and isolated browser smoke where available. Document measured evidence separately from cost estimates; physical JOYING validation remains a device test.
