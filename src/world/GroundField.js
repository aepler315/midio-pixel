// The ground as a conveyor of EQ-bar-shaped slices (follow-up item 5):
// each slice's height echoes a shifted per-band energy reading from the
// same 7-band EnergyCurves the horizon EQ reads, so the terrain visually
// rhymes with the music playing far in the background, just offset by a
// few bars. Slices are baked at generation time and simply scroll by
// afterward (a rolling waveform, not something that keeps changing shape
// once it's passed) — with an occasional scripted "the ground gives way,
// then recovers spectacularly" gag layered on top.
import { clamp01, mulberry32, hashSeed, shuffle } from '../utils/math.js';
import { Role } from '../core/NoteEvent.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

const SLICE_WIDTH_PX = 90;
const NUM_BANDS = 7;
// Adjacent slices read adjacent bands (a slow triangular sweep across the
// band range, ~one full up-and-down every BAND_RAMP_PERIOD slices) instead
// of a fixed modulo shift -- neighbours used to land on unrelated bands and
// differ by up to the full RISE_AMPLITUDE_PX at every slice edge, reading as
// a stair-stepped shuffle rather than coherent terrain.
const BAND_RAMP_PERIOD = 2 * (NUM_BANDS - 1);
const RISE_AMPLITUDE_PX = 30; // how far energy alone can lift a slice
const SPRING_K = 40, SPRING_C = 12; // per-slice settle spring (critically-damped-ish)
const RECOVER_C = 4; // reduced damping during recovery -> elastic overshoot
const RECOVER_DURATION_MS = 700; // how long the softened damping lasts
const LOOKAHEAD_PX = 1600;
// Must exceed the ensemble roam window: Midio's screen anchor can sit as
// far right as ~0.62*stageW, so slices up to that far behind worldX are
// still on screen to his left.
const TRIM_BEHIND_PX = 940;

const GAG_LEAD_PX = 420; // how far ahead of Midio a gag is seeded, so it's visible before he reaches it
const GAG_SLICE_COUNT = 7;
const GAG_STAGGER_MS = 90;
const GAG_SAG_PX = 70;
const GAG_HOLD_MS = 500;
const GAG_KICK_SYNC_WINDOW_MS = 150;

// Landing ripples (The Light Show, pass 5): a damped, radially-traveling
// shockwave that bobs the render-only ground bars outward from an impact,
// then settles -- never touching heightAt() (the physics reference), same
// render-only discipline as the bass buzz above.
const RIPPLE_WAVE_SPEED_PX_S = 700;  // how fast the shockwave front travels outward
const RIPPLE_OSC_HZ = 5.5;           // local oscillation frequency once the front arrives
const RIPPLE_DECAY_TAU_SEC = 0.10;   // local envelope decay (time since the front passed this point)
const RIPPLE_LOCAL_LIFE_SEC = 0.32;  // beyond this, a point's contribution is treated as exactly 0
const RIPPLE_TOTAL_LIFE_MS = 480;    // hard wall-clock cap on a ripple record's life
const RIPPLE_AMPLITUDE_PX = 11;      // peak per-bar bob at strength=1
const RIPPLE_MAX_ACTIVE = 4;         // hard cap on concurrently-tracked ripples (oldest shed first)
const RIPPLE_SOFTCAP_PX = 20;        // tanh compressive ceiling on the SUMMED offset at a bar

// Kick ground glow: a brightness pulse (not a height wave) that races
// outward through the EQ-bar ground on every bass-drum hit, same traveling-
// front shape as the landing ripple above, but painted as an emissive rim
// on visibleBars() rather than a positional offset -- heightAt() (physics)
// is untouched by design, same discipline as the ripple and the buzz.
const GLOW_WAVE_SPEED_PX_S = 900;    // faster than the ripple -- a kick reads instantly, not a rolling thud
const GLOW_DECAY_TAU_SEC = 0.09;     // local brightness decay once the front passes a bar
const GLOW_LOCAL_LIFE_SEC = 0.30;    // beyond this a bar's contribution is exactly 0
const GLOW_TOTAL_LIFE_MS = 380;      // hard wall-clock cap on a glow record's life
const GLOW_MAX_ACTIVE = 3;           // hard cap on concurrently-tracked glow pulses (oldest shed first)

// Live EQ tracking: a slice's spring target used to be baked once at
// creation from a one-shot band sample; now it keeps chasing the same
// band's live level (eased, not snapped, so it never buzzes), so the
// terrain visibly rides the music passing through it rather than sitting
// on a frozen snapshot. heightAt() (physics) is unaffected in kind -- it's
// still just the spring's own output, same as it always was.
const BASE_TARGET_TAU_SEC = 0.6;

// Groove wave: a render-only traveling ripple (same discipline as buzz/
// ripple/glow above) whose amplitude rides the song's overall energy, so
// the ground visibly breathes with the track even between individual
// kicks/bands. Never touches heightAt().
const GROOVE_WAVE_AMPLITUDE_PX = 4;
const GROOVE_WAVELENGTH_PX = 300;
const GROOVE_HZ = 0.11;
const GROOVE_TAU_SEC = 0.30;

/**
 * How calm reshapes the groove wave -- the one ground effect that's
 * already a genuine traveling wave, not a jitter -- into a broader, slower
 * roll. Deliberately does NOT touch heightAt()'s physics (baseTarget/spring,
 * driven by live per-band energy) or the bass buzz (a shimmer, not a sweep;
 * calm already thins it naturally since it's bass-EMA-driven): only the
 * render-only groove's wavelength/rate, same render/physics split every
 * other ground effect in this file already keeps. Pure so it's directly
 * testable independent of the slice/spring machinery.
 */
export function calmGrooveParams(calmLevel) {
  const c = clamp01(calmLevel);
  return {
    wavelengthMul: 1 + 1.6 * c, // a much broader swell instead of a tight ripple
    rateMul: 1 - 0.55 * c,      // rolls across the ground more slowly
  };
}

/**
 * Pure per-ripple contribution at a given worldX/time. `ripple` =
 * { originWorldX, startMs, strength } (0..1 strength). The wavefront
 * travels outward at RIPPLE_WAVE_SPEED_PX_S; `tauLocal` is the elapsed
 * time since that front passed THIS point -- rearranging the "distance
 * traveled = speed * age" relationship into a per-point local clock.
 * Returns 0 before the front arrives (causality) and 0 once it has long
 * since passed (settled) -- continuous at both boundaries since
 * sin(tauLocal=0) = 0.
 */
export function rippleOffsetAt(worldX, nowMs, ripple) {
  const distancePx = Math.abs(worldX - ripple.originWorldX);
  const ageSec = (nowMs - ripple.startMs) / 1000;
  const tauLocal = ageSec - distancePx / RIPPLE_WAVE_SPEED_PX_S;
  if (tauLocal < 0 || tauLocal > RIPPLE_LOCAL_LIFE_SEC) return 0;
  const envelope = Math.exp(-tauLocal / RIPPLE_DECAY_TAU_SEC);
  return ripple.strength * RIPPLE_AMPLITUDE_PX * envelope * Math.sin(tauLocal * RIPPLE_OSC_HZ * 2 * Math.PI);
}

/**
 * Pure per-glow brightness contribution at a given worldX/time, 0..1.
 * `glow` = { originWorldX, startMs, strength } (0..1 strength). Same
 * traveling-front shape as rippleOffsetAt (causal, bounded local life) but
 * a pure exponential decay instead of a damped oscillation -- a kick reads
 * as a bright pulse racing outward, not a bob.
 */
export function kickGlowAt(worldX, nowMs, glow) {
  const distancePx = Math.abs(worldX - glow.originWorldX);
  const ageSec = (nowMs - glow.startMs) / 1000;
  const tauLocal = ageSec - distancePx / GLOW_WAVE_SPEED_PX_S;
  if (tauLocal < 0 || tauLocal > GLOW_LOCAL_LIFE_SEC) return 0;
  return glow.strength * Math.exp(-tauLocal / GLOW_DECAY_TAU_SEC);
}

/** Triangular sweep across [0, NUM_BANDS-1] as `index` increases: 0..6..0,
 *  each step exactly 1 apart, so consecutive slices always read spectrally
 *  adjacent bands (a coherent rise/fall) instead of a fixed-shift modulo
 *  scatter that could land neighbours on unrelated bands. Pure, exported for
 *  tests. */
export function triangularBandIndex(index, period = BAND_RAMP_PERIOD, numBands = NUM_BANDS) {
  const m = ((index % period) + period) % period;
  return m <= numBands - 1 ? m : period - m;
}

class Slice {
  constructor(index, worldXStart) {
    this.index = index;
    this.worldXStart = worldXStart;
    this.baseTarget = 0;
    this.offset = 0;
    this.vel = 0;
    this.gagTarget = null; // non-null while a gag is actively overriding this slice
    this.recoverUntilMs = -Infinity;
  }
}

export class GroundField {
  constructor(baseGroundY, { conductor, durationMs = 0, songSeed = 1, sliceWidth = SLICE_WIDTH_PX } = {}) {
    this.baseGroundY = baseGroundY;
    this.sliceWidth = sliceWidth;
    this.conductor = conductor;
    this.slices = [];
    this._nextIndex = 0;
    this._nextWorldXStart = -TRIM_BEHIND_PX;
    this.justRecovered = false;

    this._gagQueue = this._scheduleGags(durationMs, conductor?.barGrid, songSeed);
    this._activeGagSliceIdxs = null;

    // A per-instance phase into the band ramp (see triangularBandIndex) so
    // different songs don't all start their terrain sweep on the same band.
    this._bandPhase = Math.floor(mulberry32(hashSeed(`${songSeed}:groundband`))() * BAND_RAMP_PERIOD);
    this._nowMs = 0;
    this._ripples = []; // active landing-ripple records, render-only (see impulse())
    this._glows = []; // active kick-glow records, render-only (see kickGlow())
    this._groove = 0; // EMA of global energy, driving the render-only groove wave

    // The Unraveling (Movement V): set externally from CodaDirector.unravel
    // each frame -- the terrain-EQ slices visually flatten toward
    // baseGroundY as the ending arc progresses. Render-only, same
    // discipline as the bass buzz above: heightAt() (the physics
    // reference) never reads this, so landings stay exactly as tuned even
    // while the ground appears to lie down.
    this.flatten = 0;

    // Earthquake ground shake: set externally (Simulation) to a
    // QuakeDirector instance (or null) each frame. Render-only, read in
    // visibleBars() alongside the existing ripple/groove terms -- never
    // touches heightAt(), same discipline as every other effect in this
    // file.
    this.quake = null;
  }

  _scheduleGags(durationMs, barGrid, seed) {
    if (!durationMs || durationMs < 15000) return []; // too short for a scripted gag to land well
    const rand = mulberry32(hashSeed(`${seed}:gag`));
    const candidateTimes = (barGrid && barGrid.length > 8)
      ? barGrid.map((b) => b.ms)
      : Array.from({ length: 24 }, (_, i) => (i / 24) * durationMs);

    const backHalf = candidateTimes.filter((t) => t >= durationMs * 0.5 && t <= durationMs * 0.92);
    if (backHalf.length === 0) return [];

    const numGags = durationMs > 70000 ? 2 : 1;
    const minGapMs = durationMs * 0.2;
    const shuffled = shuffle(backHalf, rand);
    const chosen = [];
    for (const t of shuffled) {
      if (chosen.every((c) => Math.abs(c - t) >= minGapMs)) chosen.push(t);
      if (chosen.length >= numGags) break;
    }
    return chosen.sort((a, b) => a - b);
  }

  _spawnSlicesUpTo(worldXLimit) {
    while (this._nextWorldXStart < worldXLimit) {
      this.slices.push(new Slice(this._nextIndex, this._nextWorldXStart));
      this._nextIndex++;
      this._nextWorldXStart += this.sliceWidth;
    }
  }

  _trimBehind(worldX) {
    while (this.slices.length && this.slices[0].worldXStart + this.sliceWidth < worldX - TRIM_BEHIND_PX) {
      this.slices.shift();
    }
  }

  _maybeTriggerGag(nowMs, worldX) {
    if (this._gagQueue.length === 0) return;
    if (nowMs < this._gagQueue[0]) return;
    this._gagQueue.shift();

    const centerWorldX = worldX + GAG_LEAD_PX;
    const centerIdx = this.slices.findIndex((s) => s.worldXStart >= centerWorldX);
    if (centerIdx < 0) return;
    const startIdx = Math.max(0, centerIdx - Math.floor(GAG_SLICE_COUNT / 2));
    const group = this.slices.slice(startIdx, startIdx + GAG_SLICE_COUNT);
    if (group.length === 0) return;

    group.forEach((s, i) => {
      s._gagSinkAtMs = nowMs + i * GAG_STAGGER_MS;
    });
    // Recovery is a single synchronized moment for the whole group, snapped
    // to the nearest kick for punch (spec-style crack-birth kick sync).
    const holdEndEstimate = nowMs + (group.length - 1) * GAG_STAGGER_MS + GAG_HOLD_MS;
    const nearestKick = this.conductor
      ? this.conductor.nearestEventMs((e) => e.role === Role.RHYTHM && e.kick, holdEndEstimate, GAG_KICK_SYNC_WINDOW_MS)
      : null;
    const recoverMs = nearestKick ? Math.max(holdEndEstimate, nearestKick.tMs) : holdEndEstimate;
    for (const s of group) s._gagRecoverAtMs = recoverMs;
  }

  /** A one-off deformation at a world-x, reusing the scripted gag's own
   * sink/recover spring physics (elastic overshoot included) instead of any
   * new physics -- Broshi's mole-ridge surface tell and burrow eruption
   * both just call this with different sag depths and hold times.
   * `sagPx` follows the same sign convention as the gag: positive sinks the
   * ground, negative rises it (a small negative sag reads as a mole-ridge
   * bump; a larger positive one reads as the ground giving way). */
  pulseAt(nowMs, worldX, sagPx, recoverAtMs) {
    const s = this._sliceAt(worldX);
    if (!s) return;
    s._gagSinkAtMs = nowMs;
    s._gagSinkTarget = sagPx;
    s._gagRecoverAtMs = recoverAtMs;
    s._recoveredFired = false;
  }

  /** A one-off landing shockwave at a world-x: fire-and-forget, capped at
   *  RIPPLE_MAX_ACTIVE concurrent records (oldest/most-decayed shed first).
   *  Visual only -- never touches heightAt()'s physics. `strength` <= 0 is
   *  a no-op (a soft hop's near-zero intensity shouldn't allocate dead
   *  state). */
  impulse(worldX, strength, nowMs) {
    const s = clamp01(strength);
    if (s <= 0) return;
    if (this._ripples.length >= RIPPLE_MAX_ACTIVE) this._ripples.shift();
    this._ripples.push({ originWorldX: worldX, startMs: nowMs, strength: s });
  }

  /** Sums every active ripple's contribution at worldX, then applies a
   *  tanh compressive softcap so a pile-up of near-simultaneous landings
   *  can never blow the terrain past a fixed visual ceiling. */
  _rippleOffset(worldX, nowMs) {
    if (this._ripples.length === 0) return 0;
    let sum = 0;
    for (const r of this._ripples) sum += rippleOffsetAt(worldX, nowMs, r);
    return RIPPLE_SOFTCAP_PX * Math.tanh(sum / RIPPLE_SOFTCAP_PX);
  }

  /** A one-off kick-synced brightness pulse racing outward from worldX:
   *  fire-and-forget, capped at GLOW_MAX_ACTIVE concurrent records (oldest
   *  shed first). Visual only, read by visibleBars() -- never touches
   *  heightAt()'s physics. `vel` <= 0 is a no-op. */
  kickGlow(worldX, nowMs, vel = 1) {
    const s = clamp01(vel);
    if (s <= 0) return;
    if (this._glows.length >= GLOW_MAX_ACTIVE) this._glows.shift();
    this._glows.push({ originWorldX: worldX, startMs: nowMs, strength: s });
  }

  /** Sums every active glow's contribution at worldX, clamped to 1 -- a
   *  simple ceiling (not softcap) since brightness, unlike a positional
   *  offset, has no meaningful "overshoot" to compress. */
  _glowAt(worldX, nowMs) {
    if (this._glows.length === 0) return 0;
    let sum = 0;
    for (const g of this._glows) sum += kickGlowAt(worldX, nowMs, g);
    return Math.min(1, sum);
  }

  update(nowMs, dtSec, worldX, energyCurves, calmLevel = 0, heardTimeMs = nowMs) {
    this.justRecovered = false;
    this._nowMs = nowMs;
    this._renderNowMs = heardTimeMs;
    this._calmLevel = calmLevel; // visibleBars() reads this for the groove wave's shape
    if (this._ripples.length) this._ripples = this._ripples.filter((r) => heardTimeMs - r.startMs < RIPPLE_TOTAL_LIFE_MS);
    if (this._glows.length) this._glows = this._glows.filter((g) => heardTimeMs - g.startMs < GLOW_TOTAL_LIFE_MS);
    const globalEnergy = energyCurves ? clamp01(energyCurves.globalEnergy(heardTimeMs, FLAT_WEIGHTS)) : 0;
    this._groove += (1 - Math.exp(-dtSec / GROOVE_TAU_SEC)) * (globalEnergy - this._groove);
    this._spawnSlicesUpTo(worldX + LOOKAHEAD_PX);
    this._trimBehind(worldX);
    this._maybeTriggerGag(nowMs, worldX);

    const baseTargetAlpha = 1 - Math.exp(-dtSec / BASE_TARGET_TAU_SEC);
    for (const s of this.slices) {
      const bandIdx = triangularBandIndex(s.index + this._bandPhase);
      const e = energyCurves ? clamp01(energyCurves.sample(bandIdx, nowMs)) : 0.3;
      const liveTarget = -e * RISE_AMPLITUDE_PX; // more energy -> ground rises to meet it
      if (!s._initialized) {
        s.baseTarget = liveTarget;
        s._initialized = true;
      } else {
        // Keeps chasing the band's current level instead of the one-shot
        // value it was born with -- the terrain is a live EQ, not a
        // snapshot that just scrolls by.
        s.baseTarget += baseTargetAlpha * (liveTarget - s.baseTarget);
      }

      let target = s.baseTarget;
      let damping = SPRING_C;

      if (s._gagSinkAtMs !== undefined) {
        if (nowMs >= s._gagRecoverAtMs) {
          target = s.baseTarget;
          if (nowMs < s._gagRecoverAtMs + RECOVER_DURATION_MS) {
            damping = RECOVER_C; // softened briefly -> elastic overshoot on the way back up
            if (!s._recoveredFired) { s._recoveredFired = true; this.justRecovered = true; }
          } else {
            s._gagSinkAtMs = undefined; // gag fully resolved, back to plain band-driven behavior
          }
        } else if (nowMs >= s._gagSinkAtMs) {
          target = s._gagSinkTarget ?? GAG_SAG_PX;
        }
      }

      const accel = -SPRING_K * (s.offset - target) - damping * s.vel;
      s.vel += accel * dtSec;
      s.offset += s.vel * dtSec;
    }
  }

  _sliceAt(worldX) {
    // Slices are generated in ascending worldXStart order; linear scan is
    // fine at this count (a couple dozen live slices at once).
    for (let i = this.slices.length - 1; i >= 0; i--) {
      if (this.slices[i].worldXStart <= worldX) return this.slices[i];
    }
    return this.slices[0] || null;
  }

  /** Physics reference: the ground height directly under an arbitrary world-x (used for Midio's own position). */
  heightAt(worldX) {
    const s = this._sliceAt(worldX);
    return this.baseGroundY + (s ? s.offset : 0);
  }

  /** Rendering helper: slice rectangles visible across [worldX, worldX+screenWidth] in screen space.
   * No independent render-only shiver here -- heightAt() (the physics
   * reference) and this render path now agree on the same offset, so the
   * line Midio actually stands on and the terrain drawn under him are the
   * same line (a 13 Hz buzz previously desynced them, reading as jitter). */
  visibleBars(worldX, originX, screenWidth) {
    const bars = [];
    const renderNowMs = this._renderNowMs ?? this._nowMs;
    const settle = 1 - clamp01(this.flatten);
    const { wavelengthMul, rateMul } = calmGrooveParams(this._calmLevel || 0);
    for (const s of this.slices) {
      const screenXStart = s.worldXStart - worldX + originX;
      const screenXEnd = screenXStart + this.sliceWidth;
      if (screenXEnd < -20 || screenXStart > screenWidth + 20) continue;
      const ripple = this._rippleOffset(s.worldXStart, renderNowMs);
      const glow = this._glowAt(s.worldXStart, renderNowMs);
      const quakeOffset = this.quake ? this.quake.groundOffsetAt(s.worldXStart) : 0;
      // Groove wave: a slow traveling ripple keyed off the song's global
      // energy, phase-driven by world-x so it visibly rolls with scroll
      // rather than bobbing in lockstep -- the ground breathing with the
      // track between individual band/kick events.
      const groove = this._groove > 0.02
        ? GROOVE_WAVE_AMPLITUDE_PX * this._groove * Math.sin(
          s.worldXStart / (GROOVE_WAVELENGTH_PX * wavelengthMul) + renderNowMs / 1000 * GROOVE_HZ * rateMul * 2 * Math.PI,
        )
        : 0;
      bars.push({ x: screenXStart, width: this.sliceWidth, y: this.baseGroundY + (s.offset + ripple + groove + quakeOffset) * settle, glow, groove: this._groove });
    }
    return bars;
  }

  /** Screen-space light sources for currently-active kick-glow pulses (see
   *  LightField.groundGlowLights) -- so a pulse racing through the ground
   *  doesn't just brighten the terrain, it visibly lights up whichever
   *  character happens to be standing near it. Positioned at each pulse's
   *  own origin (where heightAt() already says the ground is), intensity
   *  from the same envelope visibleBars() uses -- just resolved at one
   *  point instead of summed across every visible bar. Empty whenever no
   *  pulse is active. */
  activeGlowScreenLights(worldX, originX) {
    if (!this._glows.length) return [];
    const out = [];
    for (const g of this._glows) {
      const intensity = kickGlowAt(g.originWorldX, this._renderNowMs ?? this._nowMs, g);
      if (intensity > 0.02) {
        out.push({ x: g.originWorldX - worldX + originX, y: this.heightAt(g.originWorldX), intensity });
      }
    }
    return out;
  }
}
