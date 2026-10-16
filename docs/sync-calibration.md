# Sync: setting the Bluetooth delay by tapping

**Sync** (the HUD button, or `C`) runs a two-part tap pass over the playing
song. Nothing stops, nothing is hidden: the music keeps going, the world
keeps moving, and the overlay takes no pointer input at all — taps fall
straight through to the canvas, which is what feeds both the beat anchor and
this measurement.

1. **Tap the kick, when you hear it.** Go by your ears.
2. **Tap when the ring flashes.** Go by your eyes.

The delay is the difference between the two, and it updates after every tap.

## Why two passes and not one

A tap made by ear says when the **sound** reached the ear. A tap made by eye
says when the **picture** reached the eye. Neither alone is the A/V skew.

A by-ear pass is blind to display latency entirely — which is how a
projected or re-encoded screen can be badly out of step while the pass keeps
reporting that everything is fine. That was the original failure: the only
correction it could ever propose was on the audio side, so a lagging
*picture* was invisible to it.

Setting the two arrivals equal:

```
sound at the ear   = kick + hardwareDelay + audioDelay
picture at the eye = kick + visualLag     + displayDelay
```

gives `trim = (hardwareDelay − reportedLatency) − displayDelay`, which is
exactly `median(ear) − median(eye)` once each side is normalised for the
trim in force when it was measured.

**The player's own bias cancels.** Everyone anticipates a beat by some
amount, and nobody's amount is the same. That habit appears in *both* passes
and drops out of the subtraction — so the answer is the machine's latency
rather than a mixture of the machine and the person. That is the real reason
to run two, and a single pass has no equivalent protection: there the habit
lands straight in the number.

## What the ring is, and why it is on that clock

The eye phase's target is drawn from the chart's kicks on the **visual
clock** — the same clock, with the same lag applied, that the characters'
beat-anchored moves are drawn on. Tapping it therefore measures the path
from "the app decided to draw this beat" to "a person saw it".

Concretely that clock is `sim.timeMs - sim.visualLagMs`, which is exactly
what `Renderer` and every performer evaluate. The presentation lead is
already inside `sim.timeMs`; taking it off again for the ring would put the
ring a lead (52ms) behind the visuals it stands in for, and every eye pass
would bank that as display latency. Measured in Chromium, doing so moved the
ring's flash from 10ms off the kick to 75ms off it.

A marker running on its own private timer would measure nothing: it would be
a stopwatch racing itself. This is also why the ear phase's big block count
is hidden during the eye phase — two things pulsing at once gives the eye a
choice, and the measurement wants one target in one fixed place. The ring
sits high and centred over sky for the same reason: a timing target has to
be in the same place every beat, and the middle of the stage is where the
characters are.

## Why raw offsets cannot be pooled

A tap is stamped on the clock the ear is on (`visualNow`), which already has
the current trim subtracted. So an offset measured under a trim of *T* is
the **residual** against *T*, not the absolute error. Once the trim moves
after every tap — the point of the feature — successive offsets are each
measured against a different trim, and pooling them converges on the wrong
number.

Ear taps are therefore stored as what each implies the trim *should* be
(`trimInForce + offset`), which cancels the trim in force at the time. Eye
taps are stored raw, because what they measure — how long the picture takes
to arrive — does not move when the trim does. Both use a trimmed median over
the last 16, so one stray tap cannot drag the delay.

Both signs work through the same arithmetic even though a positive trim
delays the **visuals** and a negative one delays the **audio**: the algebra
cancels either way, and a pass can cross zero mid-way without a discontinuity.

## Tap the kick

The instruction names what the pass actually measures. Taps are matched
against the chart's **kicks** (`RHYTHM` events flagged `kick`), so the
overlay's older wording — "the kick, the snare, wherever your hand wants to
go", which is right for teaching `BeatAnchor` a groove — sent a
snare-tapper's taps into the gaps between kicks, where they are discarded
and the delay never moves.

For the same reason a tap explicitly marked as the high part (`J`, or a
right-click) is left out of the measurement. It still reaches the beat
anchor, which wants both hands.

Measuring against *all* percussion was the other option, and it is worse:
kicks and snares together put onsets every half beat, which halves the range
of latency a tap can unambiguously express — and 100–200ms is exactly the
range this exists to find.

## Limits worth knowing

- **The trim cannot run away.** A positive trim is added to the lag
  `visualNow` clamps at `MAX_LATENCY_MS` (350ms), while the stored
  preference rails at ±500ms. Past the clamp the number rises and the
  picture does not, so a loop measuring its own residual would never close
  the error. The calibrator takes the ceiling that will actually take effect
  and says when it has reached it. Raise `MAX_LATENCY_MS` if a real setup
  needs more; the constant's own comment says so.
- **Onset lists are not a grid.** A real one ran `1010, 81, 917, 81` — the
  kicks arrive in flammed pairs. Clusters collapse to their first onset
  before matching, because a player taps where the cluster *starts*. The
  threshold is a fraction of the beat, not a fixed number of milliseconds:
  a 100ms double-kick is real music, and double-kick figures live in fast
  music, so a beat-relative threshold separates the ornament from the
  pattern.
- **One pass cannot discover an error larger than half a beat**, since past
  that the tap is nearer the next kick. At 120bpm that is 250ms.
- **A tap with no kick within that window is not a measurement.** Feeding it
  in as a zero would drag the estimate toward "no correction needed" — the
  one answer it cannot have earned. The last good reading stands.
- **A trim typed in by hand wins.** The chip stays reachable during a pass;
  a manual edit resets the calibrator to that value rather than being folded
  into it, because taps collected under the old trim are not evidence about
  the new one.

## The HUD

Both button clusters fade on the same timer, and both are held open while a
Sync pass or a recording is running — the control that ends either one lives
in there, and a faded HUD sits under the canvas where its wake-up tap is
deliberately absorbed.

## Testing

* `test/syncCalibrator.test.js` — the matching and the flam collapse, the
  closed loop under a moving trim, the two-phase arithmetic, the bias
  cancelling across five different player habits, the ceiling and the
  runaway it prevents, the marker pulse, session gaps, and the readout's
  wording.
* A browser pass drove both halves end to end against a simulated player
  whose screen ran 130ms behind: the trim reached a negative value — which a
  by-ear pass can never produce — the audio delay node followed it, the song
  kept playing and the world stayed drawn throughout.

## The ring and the match share one onset list

Real kick lists arrive in flammed pairs — `1010, 81, 917, 81` in the wild.
`collapseFlams` reduces each cluster to its first onset before a tap is
matched, with a beat-relative gap so a genuine fast double-kick survives.

The ring pulses on that **same collapsed list**, via
`SyncCalibrator.collapsedOnsets()`. Driving it from the raw kicks would
flash twice for one beat while the match resolved to the first of the pair,
so a player timing the second flash would have the ornament's gap — tens of
milliseconds — recorded as display latency and subtracted from the trim. The
list is cached on the identity of the onset array *and* the gap, so calling
it every frame is free and a tempo change still re-derives the grid.

## What the eye phase deliberately does not touch

- **The beat anchor.** An eye-phase tap is aimed at a ring, not at the
  groove. Feeding it to `BeatAnchor` would teach the anchor the display
  delay: six consistent taps drag `anchorMs` toward it, and that anchor goes
  on steering jumps and the ensemble long after the pass ends. Eye taps are
  routed only to the latency measurement, and never reach the persisted
  groove fingerprint.
- **The high/low distinction.** The ear phase measures against kicks, so a
  tap marked as the high part (J, or a right-click) is excluded there. The
  eye phase has no such distinction — there is one ring and both hands are
  aimed at it — so filtering there would leave a player using the documented
  right-hand input stuck at zero eye taps until the pass ran out.

## Each half gets its own eight measures

The pass deadline is re-based when the phase switches. The eight measures
are a budget for *one* half: shared, a sparse chart at one kick per measure
spends six of them on the six ear taps, leaving two measures in which to
collect six eye taps. The overlay would close mid-instruction and persist a
trim built on a two-sample eye median — the exact noisy number the six-tap
requirement exists to prevent.

## Reduced flash

The ring's pulse is the thing being timed, so reduced flash caps the swing
rather than removing it: the floor comes up and the ceiling comes down,
keeping the *onset* sharp — the edge is what a tap is timed against — while
the flash stays well short of a full-brightness strobe. This is handled in
`RecalibrationOverlay`, not CSS. The `prefers-reduced-motion` rule only ever
governed the scale, which left an OS reduced-motion user with the
full-strength brightness jump, and `getReducedFlash()` defaults to that OS
preference when nothing is stored.
