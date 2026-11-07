# Mist that develops and travels through valleys

The requested behavior is low-born mist that develops gradually and moves upstream through valleys. Replace the camera-relative cloud-sea slab, its rising global ceiling, flat-plane color and height-only light blackout.

Build one bounded RGBA8 drainage field from each view's real source terrain. Store ground height, low-source-connected valley affinity, upstream distance and validity. Use a shared 96-sample maximum on all devices, retain packed bytes for matching CPU queries and charge both CPU/GPU copies. Build in bounded asynchronous slices; rail and tour modes use their own source-ground fields. A streaming tour uses its package-wide source, avoiding window seams/rebuilds. Scratch refusal or unavailable geography keeps low drifting banks instead of a slab.

The existing deterministic heard-time quiet-passage envelope controls spatial formation: low source cells develop first, then upstream branches. Local bank height follows ground (including song rise), with soft limited depth and uneven coverage. Advection follows upstream distance minus heard time. Keep the ordinary exponential mist baseline, ray occlusion, music response and existing 2–6 integer sample budget. The added bank model uses one drainage lookup and the existing noise mask per ray sample; no fluid simulation, new geometry pass or second mask.

Local three-dimensional occupancy drives lantern attenuation and surface lighting consistently. Camera altitude cannot raise or remove the bank field. Pause/direct seeks reconstruct the same state without accumulated history. This is procedural transport along derived drainage, not a physical fluid solver.

Verify synthetic branching valleys, source-first formation, ridge/no-data exclusion, uphill advection, continuity, low bounded height, local light attenuation, CPU/shader parity, texture accounting/disposal, camera modes and preparation. Use software offscreen shader compilation/rendering where available and report its scope; real-device FPS and artistic motion review remain separate evidence.
