# Frame pacing: why it stalls, and where to look first

Reported: *"performance is awful, even on my desktop in 8-bit mode. It'll be
60fps for a few seconds then drop to 1 or 2fps for a few seconds."*

That is two separate faults with the same shape, and neither of them is in
the drawing code people reach for first. This page records what was measured,
because the same wrong guess has now been made three times.

## The measurements that mattered

Every number below came from a real Chromium, driving a real song, with the
frame timing recorded inside the page. **Caveat on magnitudes: this
environment software-rasterizes, so the absolute millisecond figures are
inflated relative to a desktop GPU. The ratios, the call attribution and the
control experiments are what transfer.**

The first useful step was separating *our* JS from everything else: record the
rAF-to-rAF delta and, separately, the wall time spent inside every rAF
callback.

| stage | typical frame | our JS in it | during a stall | our JS in that |
| --- | --- | --- | --- | --- |
| 8-bit (320×180) | 16.8ms | 2.0ms | 333–383ms | 5–12ms |
| 4K (3840×2160) | 16.6ms | 1.7ms | 1083–1483ms | 800–1475ms |

Those two rows are different bugs. In 8-bit the stall is almost entirely
*outside* our code; at 4K it is almost entirely *inside* it.

## Fault 1 — a full-viewport blurred repaint, once a second

Visible in 8-bit, and the reason picking 8-bit does not help.

A control page doing nothing but `fillRect` showed **0 stalls in 45s** in the
same browser, so the stalls were ours. Chrome tracing then put the time in
`Commit` (10.7s of 35s) and `RasterTask` (9.5s), with **99.8% of all raster on
a single layer** — which `LayerTree` identified as the main document layer,
repainting about **0.83 times a second**.

That matches, almost exactly, the rate at which `main.js` rewrites the
`--spec-*` palette custom properties (0.86 batches/sec). `#app::before` — the
ambient glow behind the stage — is inset `-12%`, scaled 1.08, and carries
`filter: blur(48px)`. Every rewrite of a variable it reads repaints the whole
document layer and re-runs that blur **at display resolution**.

The decisive control: same 320×180 stage, different window sizes.

| displayed at | stalls over 25s | stalled |
| --- | --- | --- |
| 640px wide | 0 | 0ms |
| 1920px wide | 21 | 7050ms |

The stage resolution is not in that table at all. That is the whole reason
8-bit mode cannot fix this, and it is what makes the fault invisible to
anyone reasoning about draw calls.

**Fix:** the glow reads its own `--glow-*` tokens, quantized to 30° of
spectral drift instead of the chrome's 3°. A 0.38-alpha wash under a 48px
blur cannot show the difference. Document-layer repaints fell from 5 to 2 per
six seconds; stall time at 1920px fell from 7050ms to 2117ms.

**Measured and rejected:** promoting `#app::before` with `will-change: filter`
— the obvious move — made it **four times worse** (46fps → 17fps, 20s of
stalls in 25s), because the promoted layer then re-blurs every frame instead
of only when its colours change. Rendering the glow at quarter scale and
letting the compositor upscale it helped less than decoupling did and was not
worth the geometry. Neither is in the shipped fix.

## Fault 2 — the ladder shed the most expensive pass last, then oscillated

Visible at 1440p and above, and the source of the sawtooth.

At a 3840×2160 stage the CPU profile attributed **34% of all wall time to
`drawImage`**, in two call sites:

- `Renderer._drawDropMotionBlur` — 6807ms of 30s (**23%**)
- `Renderer._drawHypeFrame` — 2824ms (**9%**)

Together more than every other pass in the frame combined. Both copy or
re-blit the **whole composed frame**, so their cost scales with the backing
store, while everything else on the ladder sheds *draw calls*. And both were
gated on `heavyPostFx`, which is `level < 6` — **the last rung**. A 4K machine
therefore shed its vision loop, particles, rim light, contact shadows, bloom,
the veil, the entire phenomena layer and two of three haze layers, each worth
fractions of a percent, before reaching the one pass that was drowning it.

Two things then made that far worse than it had to be:

1. **Shedding was far too slow.** `SHED_WEIGHT_CAP` counted a frame at 1fps
   (54× over budget) as 6. One rung therefore needed ten such frames — ten
   seconds of unusable output — and six rungs would have taken a minute.
2. **Recovery was unconditional.** Ten clean seconds bought a rung back, every
   time, at the same price. On a machine that cannot afford that rung this
   turns the ladder into an oscillator: recover, collapse, spend an age
   shedding, recover. That is precisely "60fps for a few seconds then 1 or
   2fps for a few seconds."

**Fixes**, all in `PerfGovernor`:

- `fullFrameFxEnabled`, a gate for whole-frame copies that keys off the
  backing store: they shed at the first rung above 2560px, mid-ladder above
  1920px, and — at 1080p and below — behave exactly as they always did, so no
  machine loses an effect it was affording.
- Sustained catastrophic frames escalate past the severity cap. An isolated
  hitch is still capped (a tab stall, a GC pause, the OS swapping); a *run* of
  them is believed at full weight. At 1fps a rung now sheds on the third frame
  instead of the tenth.
- Recovery backs off exponentially, but **only for a rung the ladder had
  already climbed back into**. The first descent through a rung is a cold
  machine or a load hitch, not a verdict, so ordinary recovery is unchanged.
  A rung that fails again costs 20s, then 40s, then 80s.
- `_overCount` is clamped, so a machine parked at the floor cannot bank
  hundreds of units of stale evidence and cash them in the instant it
  recovers a rung.

Simulated over ten minutes against a machine that cannot afford its top rung:
**23.2% of runtime unplayable → 3.0%**, settling one rung down instead of
bouncing. `test/perf-governor.test.js` runs that simulation both ways, so the
test proves it is measuring the fix and not something that was always true.

## Three traps the escalation opens, and their guards

Making the ladder react faster and remember failures makes it more sensitive
to frame timing that is not about rendering cost at all. Three came out of
review, all real:

- **A shrinking stage must not raise the tier back.** `fullFrameFxEnabled`
  keys off the stage width, and under Auto the *live* width shrinks as the
  ladder sheds. Keyed off that number the gate is not monotonic: on a ~2880px
  backing store, level 1 sheds the whole-frame passes, then level 2's 0.85
  resolution scale drops the live width to ~2448 — inside the `level < 3`
  tier — and the most expensive passes in the frame come **back on** as
  pressure rises. It reads the unscaled target width instead
  (`targetCanvasWidth`), because the tier is a property of the display, not
  of how hard the ladder is currently squeezing.
- **A hidden page must not vote.** Chrome stops rAF for a hidden tab, but an
  embedded WebView may throttle it to about 1Hz instead — and a run of 1000ms
  "frames" is exactly the shape the escalation is built to believe. It would
  shed rung after rung while nothing was drawn at all, then hand back a
  degraded show. `main.js` skips sampling while `document.hidden`, and
  re-arms the warm-up grace on return so the first cold frames do not vote
  either.
- **An explicit quality change is a new workload.** Someone who drops from 4K
  to 720p because the frame rate fell apart has changed the amount of work,
  so the fallback counts gathered at 4K no longer describe anything. Left in
  place, a rung they can now easily afford could stay off for up to the
  capped recovery window — the opposite of what reaching for that menu is
  for. The stage-resolution handler calls `forgetRecoveryHistory()`;
  the governor's own Auto resizes deliberately keep their evidence.

## Still open: vertical banding at 4K

Reported alongside the above: flat vertical bands glitching across the stage
while loading at 4K. **Not reproduced here, and not fixed.**

What is established: the canvas content itself is clean. Captured directly
from the backing store at a real 3840×2160 stage, through the opening, every
frame was correct — so this is not the drawing code. That leaves the
compositor presenting tiles that raster has not caught up with, which is
consistent with the second-long frames above and with the report saying it
happened *while loading* at 4K. If so, Fault 2's fix should take it with it.
Worth re-checking on real hardware before anyone goes looking further.

## If it stalls again, do this first

1. Record the rAF delta **and** the time inside the rAF callback. If the delta
   is huge and the callback is small, stop reading render code.
2. Run a near-empty page in the same browser as a control.
3. Trace with `devtools.timeline` and group `RasterTask` by `layerId`. One
   layer at 99% means a DOM/CSS repaint, not canvas.
4. Vary the **window** size with the stage size held fixed. Anything that
   moves is display-resolution work, and no stage preset will help it.

## Display profiles (October 2026)

Look and workload now have independent controls. Economy pins rung 6; Pixel and Palette alone do not pin quality. The same 30/60 cap gates title and playback draws without changing the simulation clock. Palette processing has one presentation boundary and a 57,600-pixel ceiling, with readback and transform timings reported separately. See [pixel presentation](pixel-presentation.md) and its current evidence; the earlier measurements above remain historical.
