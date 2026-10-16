# The spectral sea: what it does, and what it does not

`src/world/WaveField.js` is a real Pierson-Moskowitz wave spectrum —
log-spaced components sampled from the PM energy density, each obeying the
deep-water dispersion relation, superposed with Gerstner horizontal
displacement so crests sharpen and troughs flatten. `BiomeManager` layers it
under the hand-tuned ocean contour rows in `Ocean.js`. Music never drives a
wave; it only ever shifts the *weather* (sea state → wind speed), eased over
about ten seconds.

The physics is sound and tested. This page is about the two things standing
between it and the screen, both measured rather than estimated.

## Fixed: the spectrum was frozen at dead calm for the entire song

The rebuild test read:

```js
const nextSeaState = easeSeaState(this._seaState, targetSeaState, dtSec, 10);
if (Math.abs(nextSeaState - this._seaState) > 0.01) { /* rebuild */ }
```

`easeSeaState` has a ~10s time constant, so one frame at 60fps moves the sea
state by at most `dt/tau` — about **0.0017**, against a step of **0.01**.
Compared against the *previous frame's* value the condition could never fire,
at any tempo, for any song. `buildWaveComponents` ran exactly once, in the
constructor, at sea state 0. The sea stayed dead calm no matter how loud the
low end got.

The fix is the baseline, not the step: `shouldRebuildSpectrum(seaState,
spectrumSeaState)` measures against the sea state the *live spectrum was
built at*, so the small per-frame deltas accumulate. Over a 60s calm-to-storm
ramp that is 95 rebuilds — roughly one per 38 frames — and the spectrum's
energy ends 1200× higher than the one it replaced, instead of unchanged.

Rebuilds are phase-independent of one another (the components are re-drawn
from a fresh seeded sequence), so each one is a discontinuity in principle.
Measured at the current gain it is at most **0.15px** of vertical jump, which
is why this is noted rather than engineered around. If the gain is ever
raised, phase continuity across a rebuild becomes a real requirement.

## Not fixed: the layer is sub-pixel, and past Nyquist

Fixing the rebuild makes the spectrum follow the weather, which is what the
code always intended. It does **not** make the sea look different. The draw
site applies

```js
x += wave.dx * 0.6 * ampScale;
y += wave.dy * 0.4 * ampScale;
```

to contour rows sampled at 48 points across the canvas, with `ampScale` at
most 1 and usually well below it. Measured peak-to-trough vertical excursion
of the layer, at `ampScale = 1`, swept over six times across a 1920px row:

| sea state | drawn Y | drawn X |
| --- | --- | --- |
| 0.0 | 0.020px | 0.004px |
| 0.2 | 0.090px | 0.014px |
| 0.4 | 0.174px | 0.039px |
| 0.6 | 0.333px | 0.063px |
| 0.8 | 0.559px | 0.089px |
| 1.0 | 0.755px | 0.128px |

Against `SEA_LINE_MAX` — the hand-tuned rows' own amplitude — of **12.9px**.
A full storm moves the water three quarters of one pixel. At the sea states
most music actually reaches it is a twentieth of a pixel. The "real spectral
sea" is, as drawn, invisible.

Turning the gain up does not fix it on its own, because of the second
measurement: the spectrum's peak wavelength at a full storm is **~56px**, and
the rows are sampled every **40px**. That is under two samples per
wavelength, so even the peak component is past Nyquist. Raise the gain as
things stand and what appears is per-vertex jitter, not swell — and it gets
worse as the sea calms, because a calmer PM spectrum peaks at a *higher*
frequency (1.6px wavelength at sea state 0).

Both measurements are pinned by tests in `test/waveField.test.js`, tagged
`MEASURED:`, so a future retune has to walk past them.

### What a real fix needs

Three things, together — any one alone makes it worse:

1. **A spatial scale that lands the spectrum in the band the rows can
   carry.** `seaLineY` tops out at 11 cycles across a row, which at 48
   samples is about 4 samples per cycle. The field's x would need scaling
   into that band. This is not free: the whole 35× wavelength range across
   sea states is *the physics*, so a fixed scale factor puts only part of
   the range on screen, and a sea-state-dependent one throws away the
   dispersion the layer exists to show. Raising the row sample count
   instead costs a wider band but is honest about it.
2. **A gain calibrated against `SEA_LINE_MAX`**, not left at whatever makes
   the current sub-pixel numbers look like a fraction. The design intent in
   the header comment is "deliberately modest next to Ocean.js's own rows" —
   a stated target (say 15–25% of 12.9px at a full storm) is checkable;
   "modest" is not.
3. **Phase continuity across a spectrum rebuild**, per above, since at a
   visible gain the current discontinuity becomes a visible snap. Carrying
   each component's accumulated phase across the rebuild — advancing phase
   by `omega * dt` per frame rather than computing `omega * t` from absolute
   time — makes a wind change alter the *rate* of phase advance instead of
   the phase itself.

None of that is a bug fix, which is why it is written down here instead of
guessed at. It is a look change, and the look is reviewed by the holdout
protocol in `docs/world-quality-evaluation.md`, not by me.
