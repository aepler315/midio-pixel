// Broshi, the ground raptor (spec §3.2). Obeys the groove: a relative-
// velocity spring against Midio (no absolute position target), a
// frequency->anatomy mapping driven by live band energy and note onsets,
// and a Rabid overlay gated on global track energy.
import { Role } from '../core/NoteEvent.js';
import { CHOREO_LEAD_MS, apexHopY, visualNow } from '../core/ChoreoClock.js';
import { clamp, clamp01, smoothstep, mulberry32, lerp, softRepel1D } from '../utils/math.js';
import { spectralHue, easeHueDeg, SlashBurst } from '../render/stellar.js';
import { RABID_WEIGHTS } from '../audio/bands.js';
import { ObjectPool } from '../utils/ObjectPool.js';
import { BROSHI_BODY, BROSHI_HEAD, BROSHI_JAW, BROSHI_EYE, BROSHI_TAIL } from '../render/meshes.js';
import { computeRestLengths, drawMeshPart, displaceMeshRadial, meltMesh, applyTransform, drawGlowHalo } from '../render/MeshDrawer.js';
import { kickEnv } from '../world/MountainChoreo.js';
import { ModalRing } from '../render/oscillators.js';
import { FlourishGate } from './FlourishGate.js';
import { Burrow } from './Burrow.js';

const K = 22, C = 3.6; // slightly softer spring so he settles further out
// He runs POINT, not rear guard: the default set-point is ahead of Midio.
// (Named D_TRAIL throughout for the spring it feeds; the sign is what
// changed, not the machinery.)
const D_TRAIL = 200, D_SURGE = 150;
// How close to the frame edge he is allowed to get. Roughly his own drawn
// half-width plus a little air, so he reads as "at the edge of shot" rather
// than half-cropped by it.
const EDGE_MARGIN_PX = 70;

// Midio always lands at his own fixed screenX -- so the danger zone is a
// fixed band straddling xRel=0, not a moving target. Keep Broshi's spring
// SET-POINT out of it (keepOutTarget below), and as a last resort clamp
// his actual RENDERED position out of it too (see update()'s renderX
// guard) so no upstream signal (ensemble roam, a mid-transition spring
// crossing) can ever put him where the hero comes down.
// Wider still: at the old 85/100 the two draw scales (each character's
// own wireframe silhouette runs a good deal wider than its physics
// halfWidth) still read as tangled meshes, not two distinct bodies.
const KEEPOUT_HALF = 165;
const RENDER_KEEPOUT_HALF = 150;
// Cap relative speed so a SURGE target jump never hard-teleports him.
const MAX_XREL_SPEED = 380; // px/s
const RENDER_KEEPOUT_TAU = 0.09; // soft ease out of Midio's landing column
const SOFT_REPEL_MIDIO = 170;   // start easing away from Midio inside this
const SOFT_REPEL_MIDASUS = 160; // and from Midasus when she flies near
// Disc spin: a wide vertical turn on a clean combo (mirrors Midio's own
// flourish trigger), a temporary pair of wings, and the hop they explain.
const DISC_MS = 420;
const DISC_TURNS = 2.2;
const DISC_SCALE_Y_PEAK = 2.0;  // spans the Y-axis -- tall, not wide
const DISC_SCALE_X_DIP = 0.62;  // narrows as he goes edge-on, like a coin
const DISC_HOP_H = 46;          // the "sudden vertical-travel inclinement"
const TAKEOFF_CROUCH_MS = 140;
const CHEER_TAIL_MS = 600;
const ECHO_HOP_RISE_MS = 70;
const ECHO_HOP_H = 8;

/** Two quick sine bumps ~160ms apart -- the cheer double-hop shape, added
 *  on top of whatever else hopY is doing. Pure/testable. */
export function cheerBumpY(ageMs) {
  const BUMP_MS = 90, GAP_MS = 160, H = 10;
  for (const start of [0, GAP_MS]) {
    const u = (ageMs - start) / BUMP_MS;
    if (u >= 0 && u <= 1) return H * Math.sin(u * Math.PI);
  }
  return 0;
}

/** Push a spring set-point out of the keep-out band around 0, snapping to
 *  whichever edge `lastSide` last held (hysteresis -- it doesn't matter
 *  which side, only that it doesn't flicker between them frame to frame).
 *  Pure/testable. */
export function keepOutTarget(dStar, lastSide, half = KEEPOUT_HALF) {
  if (Math.abs(dStar) >= half) return dStar;
  const side = lastSide < 0 ? -1 : 1;
  return side * half;
}
const RABID_ENTER_G = 0.75, RABID_EXIT_G = 0.60, RABID_ENTER_HOLD_MS = 1500;
const RABID_FADE_SEC = 0.8;
const G_EMA_TAU = 0.4;
const TONGUE_COOLDOWN_MS = 350;

// Calm/idle behaviors (follow-up item 3): a relaxed lope (softer hops, a
// wide lazy tail sway) plus an occasional yawn during sustained quiet
// stretches, so low-intensity sections still feel alive.
const TAIL_BASE_HZ = 1.3, TAIL_CALM_HZ = 0.32;
const TAIL_BASE_DEG = 9, TAIL_CALM_DEG = 18;
const DRAW_SCALE = 2.15; // render-only; physics footprint stays the mesh's local span
const WEAVE_PX = 6;      // predatory side-to-side drift while trailing
// BROSHI_BODY+BROSHI_HEAD combined local-space x-span (snout spike to
// swept tail spike, see meshes.js) -- the only source of truth for his
// on-screen width, used by the contact shadow.
const BODY_WIDTH_LOCAL = 57;
const CALM_LEVEL_THRESHOLD = 0.5;
const CALM_BAR_THRESHOLD = 4;
const YAWN_CHANCE_PER_BAR = 0.35;
const YAWN_COOLDOWN_BARS = 8;
const YAWN_DUR_MS = 1400;

// Ferocity/variety pass: airborne barrel rolls on hard hops (likelier the
// more rabid he is), a pounce-crouch telegraph when a surge kicks off, a
// goofy tail-chase spin when things stay calm long enough, and a jittery
// rabid skitter layered onto the predatory weave.
const ROLL_CHANCE_BASE = 0.30;
const ROLL_CHANCE_RABID = 0.70; // what ROLL_CHANCE_BASE + 0.4*rho used to reach at rho=1
const ROLL_MIN_GAP_MS = 3000;   // he may be excited; he may not be a propeller
const ROLL_DUR_MS = 340;
const POUNCE_MS = 180;
const TAILCHASE_DUR_MS = 900;
const TAILCHASE_CHANCE_PER_BAR = 0.18;
const TAILCHASE_COOLDOWN_BARS = 6;

/** Pitch anchoring: a hop's height multiplier from where its triggering
 *  note sits in his own line's observed pitch range -- higher notes lift
 *  him higher (works identically over a bass line's 28-52 register and a
 *  melody's 60-96). Pure/testable; falls back to 1 (no bias) before any
 *  range has been observed. */
export function broshiHopHeightMul(pitch, pitchMin, pitchMax) {
  if (!Number.isFinite(pitch) || !(pitchMax > pitchMin)) return 1;
  const norm = clamp01((pitch - pitchMin) / (pitchMax - pitchMin));
  return 0.75 + 0.6 * norm;
}

const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeOutElastic = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * (2 * Math.PI)) / 3) + 1;
};

const RING_JITTER_HZ = 30;
/** Stateless 0..1 hash of (seed, frame, index) for render-only variation. */
export function renderJitter01(seed, frame, index) {
  let h = (seed ^ Math.imul(frame | 0, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class Broshi {
  /**
   * @param {?Function} opts.hopFilter which events are HIS line to hop --
   *   set by Simulation from the casting lanes (bass -> him when a bass
   *   lane exists; the melody fallback keeps un-cast timelines dancing).
   */
  constructor(conductor, paramBus, { seed = 555, hopFilter = null } = {}) {
    this.conductor = conductor;
    this.rand = mulberry32(seed);
    // Draw-only variation comes from a stateless hash of this seed and the
    // heard time, never from `rand`: drawing twice (export, reflections,
    // repeated diagnostics) must not change what he does next.
    this._renderSeed = seed >>> 0;
    this._hopFilter = hopFilter || ((evt) => evt.role === Role.MELODY);
    // Output-latency compensation (ChoreoClock): set by Simulation each
    // step; every decorative envelope below evaluates on the heard clock.
    this.visualLagMs = 0;

    this.state = 'TRAIL'; // TRAIL | SURGE
    this.surgeUntilMs = -Infinity;
    this._barEnergyAccum = 0;
    this._barEnergySamples = 0;
    this._barEnergyHistory = [];
    this._barsSinceSurge = 0;
    this._lastBarPeriodMs = 500;

    this.xRel = D_TRAIL;
    // Overwritten from the ensemble payload every frame; this is only the
    // value used before the first update lands.
    this._stageW = 1280;
    this.xRelVel = 0;

    this.G = 0;
    this.rabid = false;
    this.rho = 0;
    this._rabidCandidateSinceMs = null;

    this.tongue = { state: 'idle', t: 0, len: 0, cooldownUntilMs: 0, targetLen: 0 };
    this.jawOpen = 0; // 0..1
    this._jawUntilMs = -Infinity;
    this.hopY = 0;
    // screenX/renderX/groundY are only ever computed inside update() (they
    // need `midio`'s live position, not available at construction) -- but a
    // fresh restart (Play again / video export) can render the very first
    // frame before any step has run yet (zero completed sim.step() calls
    // still gets rendered, interpolating the freshly-constructed state).
    // Previously undefined here, so that first draw() translated to
    // NaN/NaN and crashed the whole render loop; 0 is a safe placeholder,
    // overwritten by the first real update() a step later.
    this.screenX = 0;
    this.renderX = 0;
    this.groundY = 0;
    // Apex-on-beat hop (ChoreoClock): a parabola anchored so its peak lands
    // exactly ON the note's own tMs -- he leaves the ground before the note
    // sounds. Null when grounded.
    this._hop = null;
    this._kickTMs = -Infinity; // the latest AUDIBLE kick's onset, for the closed-form beat flash
    // Kicks not yet heard (see MidioPerformer._kickPending): on high-latency
    // outputs a newer kick must not orphan the one still in flight to the
    // ear, so onsets queue and update() promotes them at their heard moment.
    this._kickPending = [];
    this.neckAngle = 0;
    this._neckStartMs = -Infinity;
    this._neckAmp = 0;

    this.spittle = new ObjectPool(() => ({}), (o, i) => Object.assign(o, i, { age: 0 }), 60);
    this.drool = new ObjectPool(() => ({}), (o, i) => Object.assign(o, i, { age: 0 }), 60);
    this._droolAccum = 0;
    // A comet-star trail (Midasus's stardust ribbon, his own version): a
    // stream of fading motes off the tail on hops and rolls, thicker the
    // more rabid he's running.
    this.trail = new ObjectPool(() => ({}), (o, i) => Object.assign(o, i, { age: 0 }), 120);
    this._trailAccum = 0;

    // Midasus style: a pale pitch-class SPECTRAL color (eased toward the hue
    // of his own line's latest note) replaces the old green->red raptor skin,
    // plus additive note "slashes" on hard hops -- so he reads as the same
    // luminous instrument she does, while keeping the raptor silhouette/rig.
    // Rabid now reads as heat (brighter/whiter), not a color change.
    this.hue = 210;
    this._hueTarget = 210;
    this.slashes = new SlashBurst();
    this._slashPending = 0; // a hard hop's velocity, awaiting a slash once renderX is known

    this._bodyRest = computeRestLengths(BROSHI_BODY);
    this._headRest = computeRestLengths(BROSHI_HEAD);
    this._jawRest = computeRestLengths(BROSHI_JAW);
    this._eyeRest = computeRestLengths(BROSHI_EYE);
    this._tailRest = computeRestLengths(BROSHI_TAIL);

    this._calmLevel = 0;
    this._calmBarsStreak = 0;
    this._barsSinceYawn = Infinity;
    this._yawnStartMs = -Infinity;
    this.tailAngle = 0;
    this._tailPhase = this.rand() * Math.PI * 2;

    // Body vibration: struck by kicks and hops, and fed a continuous low
    // shiver while rabid so his whole silhouette trembles at high energy.
    this.modal = new ModalRing({ modes: 4, baseHz: 7, decaySec: 0.5, seed: seed + 1 });
    this.beatFlash = 0;
    this._nowMs = 0;
    this._trailTarget = D_TRAIL;
    this._ensPhase = null;
    this._melt = 0;
    this._swell = 1; // shared build-up swell (EnsembleDirector.swell) -- 1 until the first update()
    // Keep-out hysteresis: which side of Midio he was last clearly on.
    this._lastSide = 1; // starts out in front (D_TRAIL is positive)

    // True-companion behaviors -- all render-only, driven by Midio's own
    // state via the ensemble bag (see update()).
    this._wasAirborne = false;
    this._takeoffCrouchStartMs = -Infinity;
    this._cheerStartMs = -Infinity;
    this._echoHopAnchorMs = -Infinity;
    this._dartUntilMs = -Infinity;
    this._nextDartCheckMs = 0;
    this._nextShakeCheckMs = 0;
    this._shakeUntilMs = -Infinity;
    this._watchLift = 0; // neck-up tilt while watching Midio fly, render-only

    // Barrel roll / pounce / tail-chase state (render-only, like the weave).
    this.bodyRoll = 0;         // radians added to the whole-glyph rotation
    this.squashX = 1;
    this.squashY = 1;
    this._rollStartMs = -Infinity;
    this._rollDurMs = ROLL_DUR_MS;
    this._rollTurns = 1;
    this._rollDir = 1;
    this._rollGate = new FlourishGate({
      minGapMs: ROLL_MIN_GAP_MS, chance: ROLL_CHANCE_BASE, intensityChance: ROLL_CHANCE_RABID,
      intensityScale: 0.6, rand: this.rand,
    });
    this._pounceStartMs = -Infinity;
    this._lastState = 'TRAIL';
    this._barsSinceTailChase = Infinity;

    // Disc spin (same clean-combo flourish as the cheer above): unlike the
    // barrel roll, this stretches tall instead of pinching wide -- a
    // vertical disc, not Midio's horizontal one -- and grows a pair of
    // wings for its duration to sell the sudden vertical launch that
    // follows. Independent channels from bodyRoll/squashX/Y so it composes
    // with whatever the roll/pounce/crouch systems are already doing rather
    // than fighting them.
    this._discStartMs = -Infinity;
    this._discRoll = 0;
    this._discScaleX = 1;
    this._discScaleY = 1;
    this._discWings = 0; // 0..1 wing extension, for draw()
    // Occasional underground excursion: drawn beneath the world (see
    // Renderer.js), fog-of-war dirt-sight owned entirely by Burrow.
    this.burrow = new Burrow(seed + 2);

    // Line anchoring: he hops HIS line (the bass when the casting found
    // one, the melody otherwise). Pitch range is learned adaptively from
    // onsets actually seen so far (no full timeline is handed to him at
    // construction, unlike Midasus).
    this._pitchMin = Infinity;
    this._pitchMax = -Infinity;
    // His line's onset times, delivered by the anticipation channel (up to
    // CHOREO_LEAD_MS early) -- bucketed against the bar boundary by each
    // note's OWN tMs in _onBar, so the density windows stay bar-aligned
    // even though delivery runs ahead.
    this._laneOnsetTimes = [];
    this._barMelodyHistory = [];

    // conductor outlives every song (see main.js); dispose() must undo
    // exactly these four subscriptions or a replay stacks a fresh Broshi's
    // listeners on top of every previous one still firing.
    this._unsub = [
      conductor.onBar((bar) => this._onBar(bar)),
      conductor.on(Role.RHYTHM, (evt) => {
        if (evt.kick) { this._onKick(evt); this.burrow.onKick(evt.vel); }
        // Kicks still snap the jaw and light the beat flash (see _onKick) --
        // he still feels the drums, he just doesn't hop to them anymore.
      }),
      // His hop line arrives EARLY (ChoreoClock's anticipation channel), each
      // event carrying its true tMs, so the hop's apex can be anchored right
      // on the note instead of starting rise-time late.
      conductor.subscribeAhead('*', CHOREO_LEAD_MS, (evt) => {
        if (!this._hopFilter(evt)) return;
        if (Number.isFinite(evt.pitch)) {
          this._pitchMin = Math.min(this._pitchMin, evt.pitch);
          this._pitchMax = Math.max(this._pitchMax, evt.pitch);
          this._hueTarget = spectralHue(evt.pitch); // his color tracks his own line, Midasus-style
        }
        this._laneOnsetTimes.push(evt.tMs ?? this._nowMs);
        if (evt.vel >= 0.3) this._onMiniHopTrigger(evt);
      }),
      // The head still nods to the tune regardless of which line his BODY
      // answers to -- head to the melody, feet to his own instrument.
      conductor.on(Role.MELODY, (evt) => {
        this._onHeadBob(evt);
        this.burrow.onMelodyOnset(evt);
      }),
    ];
  }

  /** Undo every conductor subscription made at construction. */
  dispose() {
    for (const unsub of this._unsub) unsub();
    this._unsub.length = 0;
  }

  /** Test/debug hook: send him underground right now regardless of natural
   * triggers. No-op if he's already away. */
  forceBurrow(nowMs, worldX) {
    // The hole belongs where HE stands, not at Midio's world anchor:
    // his world-x is Midio's plus the trailing spring offset.
    return this.burrow.trigger(nowMs, { x: this.screenX, y: this.groundY }, worldX, this.groundY, worldX + this.xRel);
  }

  _onBar(bar) {
    const barEnergy = this._barEnergySamples > 0 ? this._barEnergyAccum / this._barEnergySamples : 0;
    const hist = this._barEnergyHistory;
    if (hist.length > 0) {
      const window = hist.slice(-4);
      const mean4 = window.reduce((a, b) => a + b, 0) / window.length;
      if (mean4 > 1e-6 && barEnergy > mean4 * 1.3) this._triggerSurge(bar.ms);
    }
    hist.push(barEnergy);
    if (hist.length > 8) hist.shift();

    // Line density: a bar of unusually busy playing on HIS line (a run, a
    // flurry) reads as excitement too, independent of the drums' energy.
    // Only onsets whose own tMs lands before this boundary belong to the
    // closing bar; anticipated notes from the next bar stay queued for it.
    const closed = this._laneOnsetTimes.filter((t) => t < bar.ms).length;
    this._laneOnsetTimes = this._laneOnsetTimes.filter((t) => t >= bar.ms);
    const mhist = this._barMelodyHistory;
    if (mhist.length > 0) {
      const mwindow = mhist.slice(-4);
      const mmean4 = mwindow.reduce((a, b) => a + b, 0) / mwindow.length;
      if (mmean4 > 1e-6 && closed > mmean4 * 1.5) this._triggerSurge(bar.ms);
    }
    mhist.push(closed);
    if (mhist.length > 8) mhist.shift();

    this._barsSinceSurge++;
    if (this._barsSinceSurge >= 8) this._triggerSurge(bar.ms);
    this._barEnergyAccum = 0;
    this._barEnergySamples = 0;

    if (this._calmLevel > CALM_LEVEL_THRESHOLD) this._calmBarsStreak++;
    else this._calmBarsStreak = 0;
    this._barsSinceYawn++;
    this._barsSinceTailChase++;
    if (this._calmBarsStreak >= CALM_BAR_THRESHOLD && this._barsSinceYawn >= YAWN_COOLDOWN_BARS
      && !this.rabid && this.rand() < YAWN_CHANCE_PER_BAR) {
      this._yawnStartMs = bar.ms;
      this._barsSinceYawn = 0;
    }
    // Bored enough for long enough -> he chases his own tail: a slow goofy
    // double spin, mutually exclusive with the yawn so they don't stack.
    if (this._calmBarsStreak >= 2 && this._barsSinceTailChase >= TAILCHASE_COOLDOWN_BARS
      && !this.rabid && bar.ms - this._yawnStartMs > YAWN_DUR_MS
      && this.rand() < TAILCHASE_CHANCE_PER_BAR) {
      this._rollStartMs = bar.ms;
      this._rollDurMs = TAILCHASE_DUR_MS;
      this._rollTurns = 2;
      this._rollDir = this.rand() < 0.5 ? 1 : -1;
      this._barsSinceTailChase = 0;
    }
  }

  _triggerSurge(nowMs) {
    this.state = 'SURGE';
    this.surgeUntilMs = nowMs + this._lastBarPeriodMs;
    this._barsSinceSurge = 0;
  }

  _onKick(evt) {
    this.jawOpen = 1;
    this._jawUntilMs = -Infinity; // set precisely in update() using nowMs snapshot
    this._jawKickPending = true;
    // The flash itself is computed closed-form in update() -- kickEnv
    // anchored on the kick's true onset, latency-compensated -- so its
    // shape and phase are exact regardless of dispatch step timing.
    this._kickPending.push(evt && Number.isFinite(evt.tMs) ? evt.tMs : this._nowMs);
    if (this._kickPending.length > 8) this._kickPending.shift();
  }

  _onMiniHopTrigger(evt) {
    this._hopPending = { vel: evt.vel, pitch: evt.pitch, anchorMs: evt.tMs };
  }

  _onHeadBob(evt) {
    this._neckPending = { vel: evt.vel };
  }

  update(nowMs, dtSec, midio, energyCurves, worldX, groundY, calmLevel = 0, ensemble = null, groundField = null, particleMul = 1) {
    this._calmLevel = calmLevel;
    this._particleMul = particleMul;
    this._ensPhase = ensemble ? ensemble.phase : null;
    this._melt = ensemble ? ensemble.melt : 0;
    // Shared build-up swell (EnsembleDirector.swell) -- see Midasus/Renderer
    // for the other two; 1 (no-op) outside a build-up.
    this._swell = ensemble && ensemble.swell != null ? ensemble.swell : 1;
    // Rare shared transition tumble (see EnsembleDirector.maybeTumble).
    this._tumbleRotX = ensemble ? (ensemble.tumbleRotX || 0) : 0;
    this._tumbleRotY = ensemble ? (ensemble.tumbleRotY || 0) : 0;
    // The ensemble roams him around the floor: his spring's TRAIL set-point
    // chases the formation anchor instead of a fixed -140px offset.
    // Keep the set-point on-frame. The ensemble roams him around the floor,
    // and -420px of trail puts him off the left edge whenever Midio is
    // standing anywhere near it -- he "falls back off the screen" and there
    // is nothing to pull him in, because the spring is happily sitting on
    // its target. Clamping the TARGET (rather than only the final position)
    // means the spring never fights a wall it can't see.
    this._stageW = ensemble && ensemble.stageW > 0 ? ensemble.stageW : this._stageW;
    const roam = ensemble ? clamp(ensemble.trailX - midio.screenX, -420, 320) : D_TRAIL;
    // Clamp the set-point in BOTH cases, not just when an ensemble is roaming
    // him: the fixed -200 default already puts him at screen x=0 whenever
    // Midio stands at 200, which is the "falls back off the screen" report.
    // Clamping the TARGET rather than only the drawn position is what stops
    // the spring from parking against the edge and fighting the backstop
    // below every frame -- it simply aims somewhere it can actually sit.
    const lo = EDGE_MARGIN_PX - midio.screenX;
    const hi = this._stageW - EDGE_MARGIN_PX - midio.screenX;
    this._trailTarget = lo <= hi ? clamp(roam, lo, hi) : roam;
    // Song-relative: RABID_ENTER_G/RABID_EXIT_G now ask "is this the top of
    // THIS song?" -- otherwise he was permanently rabid on a loud master and
    // never once rabid on a quiet one, whatever the arrangement did.
    const gInstant = energyCurves ? energyCurves.globalEnergyNorm(nowMs, RABID_WEIGHTS) : 0;
    this._barEnergyAccum += gInstant;
    this._barEnergySamples++;

    // --- True companion: he reacts to HIS HERO, not just the music ---
    const midioAirborne = !!(ensemble && ensemble.midioAirborne);
    const justLanded = !!(ensemble && ensemble.justLanded);
    const justClean = !!(ensemble && ensemble.justClean);
    const midioYNow = ensemble ? (ensemble.midioY || 0) : 0;
    const worldSpeed = ensemble ? (ensemble.worldSpeed || 0) : 0;
    const weatherKind = ensemble ? ensemble.weatherKind : null;
    const weatherIntensity = ensemble ? (ensemble.weatherIntensity || 0) : 0;

    // Watch him fly: the neck tilts up while Midio's airborne, tracking
    // roughly how high he is.
    this._watchLift = midioAirborne ? 0.5 * clamp01(midioYNow / 280) : 0;

    // Anticipation crouch: the instant he leaves the ground, a quick coil.
    if (midioAirborne && !this._wasAirborne) this._takeoffCrouchStartMs = nowMs;

    // Cheer on a clean landing: double mini-hop, tail flourish, happy jaw.
    // Small, cheap, and it should happen often -- that's the companionship.
    if (justClean) { this._cheerStartMs = nowMs; this.jawOpen = Math.max(this.jawOpen, 0.5); this._jawUntilMs = nowMs + 200; }
    // The disc spin is NOT part of that. It's a trio-wide flourish cued by
    // EnsembleDirector.maybeDisc on a section change / drop / milestone and
    // rate-limited there. It used to ride on justClean, which -- the show
    // being autoplay, so every landing is clean -- restarted a 420ms spin
    // every ~500ms and left him permanently rotating.
    if (ensemble && ensemble.discCue) this._discStartMs = nowMs;

    // Echo hop: a half-beat after ANY landing, he hops right along with him.
    if (justLanded) this._echoHopAnchorMs = nowMs + Math.max(120, (this._lastBarPeriodMs || 500) / 8);

    this._wasAirborne = midioAirborne;

    // Calm play-dart: bored and relaxed, he occasionally darts ahead and
    // drifts back -- seeded so it's not a metronome. Keep-out (below) still
    // applies to wherever this sends the spring's target.
    if (nowMs >= this._nextDartCheckMs) {
      this._nextDartCheckMs = nowMs + 1000;
      if (calmLevel > 0.6 && nowMs >= this._dartUntilMs && this.rand() < (1 / 7)) this._dartUntilMs = nowMs + 1200;
    }
    const darting = nowMs < this._dartUntilMs;

    // The heard clock (ChoreoClock): every anchored envelope below -- hop
    // arc, beat flash -- evaluates against this, not the raw song clock.
    const vNow = visualNow(nowMs, this.visualLagMs);

    if (this._jawKickPending) { this._jawKickPending = false; this._jawUntilMs = nowMs + 80; this.jawOpen = 1; this.modal.excite(2.6); }
    if (this._hopPending) {
      const { vel, pitch, anchorMs } = this._hopPending;
      this._hopPending = null;
      // Busy guard: on runs denser than the anticipation lead, the next
      // note's early trigger would otherwise replace the CURRENT hop before
      // its window even opens, flattening every hop on fast lines. One hop
      // finishes before the next installs; mid-run triggers just drop.
      if (!this._hop || vNow >= this._hop.anchorMs + this._hop.riseMs) {
        this._startHop(nowMs, vel, pitch, anchorMs);
        this.modal.excite(0.6 + 1.2 * vel);
      }
    }
    if (this._neckPending) { const { vel } = this._neckPending; this._neckPending = null; this._neckStartMs = nowMs; this._neckAmp = 10 + 16 * vel; }

    // --- locomotion FSM ---
    if (this.state === 'SURGE' && nowMs >= this.surgeUntilMs) this.state = 'TRAIL';

    // Pounce telegraph: the instant a surge starts he coils — a quick
    // crouch-and-release squash before the burst forward reads as intent.
    if (this.state === 'SURGE' && this._lastState !== 'SURGE') this._pounceStartMs = nowMs;
    this._lastState = this.state;

    let rawDStar = this.state === 'SURGE' ? D_SURGE : this._trailTarget;
    if (darting && this.state === 'TRAIL') rawDStar = this._trailTarget + 180;

    // Side-crossing discipline: a target that would flip which side of
    // Midio he sits on only takes effect once he's grounded again -- while
    // he's airborne, hold the PREVIOUS side's target so the spring isn't
    // mid-crossing (near xRel=0, right where he'll come down) at the exact
    // moment of landing.
    const naturalSide = rawDStar === 0 ? this._lastSide : Math.sign(rawDStar);
    let dStar = rawDStar;
    if (midioAirborne && naturalSide !== this._lastSide) {
      dStar = this._lastSide >= 0 ? Math.abs(rawDStar) : -Math.abs(rawDStar);
    }
    // Keep-out: never ask the spring to rest inside the landing column.
    dStar = keepOutTarget(dStar, this._lastSide);

    // Iced footing (Traction.js): lost traction is lost damping -- the
    // stiffness (his legs) is untouched but he genuinely can't shed speed,
    // so he overshoots the formation and slides back. Floor keeps the
    // spring visibly underdamped, never divergent.
    const cEff = C * (0.35 + 0.65 * (this.traction ?? 1));
    const accel = -K * (this.xRel - dStar) - cEff * this.xRelVel;
    this.xRelVel += accel * dtSec;
    // Soft personal space: ease off Midio (and Midasus when she crowds the
    // floor band) without a hard teleport — strength falls off quadratically.
    this.xRelVel += softRepel1D(this.xRel, 0, SOFT_REPEL_MIDIO, 450) * dtSec;
    if (ensemble && Number.isFinite(ensemble.midasusX)) {
      const midasusRel = ensemble.midasusX - midio.screenX;
      this.xRelVel += softRepel1D(this.xRel, midasusRel, SOFT_REPEL_MIDASUS, 350) * dtSec;
    }
    // Speed clamp — a large dStar jump (SURGE) stays continuous motion.
    if (this.xRelVel > MAX_XREL_SPEED) this.xRelVel = MAX_XREL_SPEED;
    else if (this.xRelVel < -MAX_XREL_SPEED) this.xRelVel = -MAX_XREL_SPEED;
    this.xRel += this.xRelVel * dtSec;
    if (Math.abs(this.xRel) >= KEEPOUT_HALF) this._lastSide = Math.sign(this.xRel);

    // --- Rabid gate ---
    const alpha = 1 - Math.exp(-dtSec / G_EMA_TAU);
    this.G += alpha * (gInstant - this.G);
    if (!this.rabid) {
      if (this.G > RABID_ENTER_G) {
        if (this._rabidCandidateSinceMs == null) this._rabidCandidateSinceMs = nowMs;
        if (nowMs - this._rabidCandidateSinceMs >= RABID_ENTER_HOLD_MS) this.rabid = true;
      } else {
        this._rabidCandidateSinceMs = null;
      }
    } else if (this.G < RABID_EXIT_G) {
      this.rabid = false;
    }
    this.rho = this.rabid
      ? smoothstep(RABID_ENTER_G, 0.95, this.G)
      : Math.max(0, this.rho - dtSec / RABID_FADE_SEC);

    // --- tongue-lash (BASS band E1) ---
    const e1 = energyCurves ? energyCurves.sample(1, nowMs) : 0;
    const s = smoothstep(0.55, 0.80, e1);
    const tongueCap = 96 * (1 + 0.5 * this.rho);
    const cooldownMs = TONGUE_COOLDOWN_MS * (1 - 0.45 * this.rho);
    if (this.tongue.state === 'idle' && nowMs >= this.tongue.cooldownUntilMs && s > 0.05) {
      this.tongue.state = 'extend';
      this.tongue.t = 0;
      this.tongue.targetLen = tongueCap * s;
    } else if (this.tongue.state === 'extend') {
      this.tongue.t += dtSec / 0.09;
      this.tongue.len = this.tongue.targetLen * easeOutCubic(clamp(this.tongue.t, 0, 1));
      if (this.tongue.t >= 1) {
        this.tongue.state = 'retract';
        this.tongue.t = 0;
        this._spawnSpittle();
      }
    } else if (this.tongue.state === 'retract') {
      this.tongue.t += dtSec / 0.22;
      const e = easeOutElastic(clamp(this.tongue.t, 0, 1));
      this.tongue.len = Math.max(0, this.tongue.targetLen * (1 - e));
      if (this.tongue.t >= 1) {
        this.tongue.state = 'idle';
        this.tongue.len = 0;
        this.tongue.cooldownUntilMs = nowMs + cooldownMs;
      }
    }

    // --- jaw (yawn takes priority over the idle decay, kicks/rabid override both) ---
    const sinceYawn = nowMs - this._yawnStartMs;
    if (sinceYawn >= 0 && sinceYawn < YAWN_DUR_MS) {
      this.jawOpen = Math.sin((sinceYawn / YAWN_DUR_MS) * Math.PI) * 0.85;
    } else if (nowMs >= this._jawUntilMs) {
      this.jawOpen = Math.max(0, this.jawOpen - dtSec / 0.05);
    }
    const jawSnapHz = 2 * (1 + 3 * this.rho);
    if (this.rabid) this.jawOpen = 0.5 + 0.5 * Math.sin(2 * Math.PI * jawSnapHz * (nowMs / 1000));

    // --- tail sway: wider and lazier the calmer things get, never still ---
    const tailHz = lerp(TAIL_BASE_HZ, TAIL_CALM_HZ, calmLevel);
    let tailDeg = lerp(TAIL_BASE_DEG, TAIL_CALM_DEG, calmLevel);
    // Cheer flourish: a clean landing gets a bigger tail wag for a moment.
    const cheerAge = nowMs - this._cheerStartMs;
    if (cheerAge >= 0 && cheerAge < CHEER_TAIL_MS) tailDeg *= 2;
    this.tailAngle = tailDeg * Math.sin(2 * Math.PI * tailHz * (nowMs / 1000) + this._tailPhase);

    // --- barrel roll / tail-chase spin: one shared roll channel ---
    // On the HEARD clock (vNow), like the hop arc and beat flash below. These
    // rotation channels used to evaluate on raw nowMs while everything they
    // compose with used vNow, so on a high-latency output (Bluetooth, up to
    // 350ms) his spins ran ahead of the beat his hops landed on -- and the
    // disc's own hop term was summed with the note hop across two clocks.
    const rollU = (vNow - this._rollStartMs) / this._rollDurMs;
    if (rollU >= 0 && rollU < 1) {
      this.bodyRoll = this._rollDir * this._rollTurns * Math.PI * 2 * easeOutCubic(rollU);
      // Mid-tail-chase his tail whips fast — he's chasing it, after all.
      if (this._rollDurMs >= TAILCHASE_DUR_MS) {
        this.tailAngle += 14 * Math.sin(2 * Math.PI * 6 * (nowMs / 1000));
      }
    } else {
      // Trot shimmy: a light roll while running grounded, scaled by how
      // fast the world's actually moving under him -- standing still, he
      // stands still.
      this.bodyRoll = midioAirborne ? 0 : 0.02 * clamp(worldSpeed / 220, 0, 1) * Math.sin(worldX / 30);
    }

    // --- disc spin: independent channel, composes with the roll above ---
    const discU = (vNow - this._discStartMs) / DISC_MS;
    if (discU >= 0 && discU < 1) {
      const ease = Math.sin(discU * Math.PI); // 0 -> 1 -> 0, turning in and back out
      this._discRoll = DISC_TURNS * Math.PI * 2 * (1 - (1 - discU) ** 3);
      this._discScaleY = 1 + (DISC_SCALE_Y_PEAK - 1) * ease;
      this._discScaleX = 1 - (1 - DISC_SCALE_X_DIP) * ease;
      this._discWings = ease;
    } else {
      this._discRoll = 0;
      this._discScaleY = 1;
      this._discScaleX = 1;
      this._discWings = 0;
    }

    // --- pounce crouch: sine in-out squash over POUNCE_MS ---
    const pounceU = (nowMs - this._pounceStartMs) / POUNCE_MS;
    const crouch = pounceU >= 0 && pounceU < 1 ? Math.sin(pounceU * Math.PI) : 0;
    // A second, gentler coil the instant MIDIO leaves the ground -- he's
    // anticipating the landing, same shape as the surge pounce.
    const takeoffU = (nowMs - this._takeoffCrouchStartMs) / TAKEOFF_CROUCH_MS;
    const takeoffCrouch = takeoffU >= 0 && takeoffU < 1 ? Math.sin(takeoffU * Math.PI) : 0;
    this.squashY = 1 - 0.22 * crouch - 0.15 * takeoffCrouch;
    this.squashX = 1 + 0.16 * crouch + 0.10 * takeoffCrouch;

    // --- weather reactions: he answers the sky, not just his hero ---
    if (weatherKind === 'snow' && weatherIntensity > 0.15) {
      // A quick continuous tremble, amplitude riding the snowfall's own
      // intensity -- cold, not excited.
      const shiver = 0.02 * weatherIntensity * Math.sin(nowMs * 0.09);
      this.squashX += shiver;
      this.squashY -= shiver * 0.6;
    }
    if (weatherKind === 'rain' && weatherIntensity > 0.15) {
      // A periodic shake-off, like a wet dog -- a quick body wobble every
      // few seconds, never more often than that so it reads as a tell,
      // not a tic.
      if (nowMs >= this._nextShakeCheckMs) {
        this._nextShakeCheckMs = nowMs + 3500 + this.rand() * 2000;
        this._shakeUntilMs = nowMs + 260;
      }
      const shakeAge = 260 - (this._shakeUntilMs - nowMs);
      if (shakeAge >= 0 && shakeAge < 260) {
        const u = shakeAge / 260;
        this.squashX += 0.12 * Math.sin(u * Math.PI * 5) * (1 - u);
      }
    }

    // --- body vibration: continuous feed while rabid, ring-down otherwise ---
    if (this.rho > 0.05) this.modal.excite(4 * this.rho * dtSec);
    this.modal.update(dtSec);

    // --- mini-hop: closed-form parabola whose apex lands exactly ON the
    // triggering note's own onset, evaluated on the heard clock (ChoreoClock
    // apex-on-beat). No per-step integration, so no tick quantization.
    if (this._hop) {
      this.hopY = apexHopY(vNow, this._hop.anchorMs, this._hop.riseMs, this._hop.h);
      if (vNow > this._hop.anchorMs + this._hop.riseMs) this._hop = null;
    } else {
      this.hopY = 0;
    }
    // Cheer double-hop, on top of whatever his line's own hop is doing.
    if (cheerAge >= 0 && cheerAge < CHEER_TAIL_MS) this.hopY += cheerBumpY(cheerAge);
    // Disc spin's launch: the wings above are cosmetic without an actual
    // vertical kick to justify them, so the same window lifts him for real.
    if (discU >= 0 && discU < 1) this.hopY += DISC_HOP_H * Math.sin(discU * Math.PI);
    // Echo hop: a half-beat after Midio lands, he hops right along with
    // him -- a small apex-on-beat parabola anchored the same way as his
    // note hops, just triggered by a landing instead of a note.
    if (Math.abs(vNow - this._echoHopAnchorMs) < ECHO_HOP_RISE_MS * 2) {
      this.hopY += apexHopY(vNow, this._echoHopAnchorMs, ECHO_HOP_RISE_MS, ECHO_HOP_H);
    }
    // Trot: a light stride bounce while his feet are on the ground, so
    // running never reads as pure gliding.
    if (!this._hop && this.hopY <= 0.5) {
      this.hopY += 1.5 * Math.abs(Math.sin(worldX / 38));
    }

    // --- head-bob (neck angle) ---
    const dt = nowMs - this._neckStartMs;
    this.neckAngle = dt >= 0 && dt < 600
      ? this._neckAmp * Math.exp(-dt / 180) * Math.sin((2 * Math.PI * dt) / 220)
      : 0;
    // Watch him fly: tilts up on top of the head-bob while Midio's airborne.
    this.neckAngle -= this._watchLift * 18;

    // --- rabid aura / drool ---
    if (this.rabid) {
      this._droolAccum += 4 * this.rho * this._particleMul * dtSec;
      while (this._droolAccum >= 1) {
        this._droolAccum -= 1;
        this.drool.spawn({ x: 0, y: 0, vy: 40, life: 0.6 + 0.3 * this.rand() });
      }
    }

    this.spittle.step(dtSec, (o, dtt) => { o.x += o.vx * dtt; o.y += o.vy * dtt; o.vy += 400 * dtt; o.age += dtt; return o.age < o.life; });
    this.drool.step(dtSec, (o, dtt) => { o.y += o.vy * dtt; o.age += dtt; return o.age < o.life; });

    // Comet trail: rate scales with speed and rabid-ness, motes drift
    // behind him (world-relative, since they should stay in place as he
    // runs on) and fade over ~0.4s.
    const trailSpeed = Math.abs(this.xRelVel);
    const trailRate = (4 + 26 * Math.min(1, trailSpeed / 250)) * (1 + 1.2 * this.rho) * this._particleMul;
    this._trailAccum += trailRate * dtSec;
    while (this._trailAccum >= 1) {
      this._trailAccum -= 1;
      this.trail.spawn({
        x: -18 - 4 * this.rand(), y: -13 + (this.rand() * 2 - 1) * 5,
        life: 0.28 + 0.18 * this.rand(),
      });
    }
    this.trail.step(dtSec, (o, dtt) => { o.age += dtt; return o.age < o.life; });

    // Beat flash: the mountains' own kickEnv anchored on the kick's true
    // onset -- identical shape and phase to the ranges' bounce, and it
    // peaks when the EAR gets the kick, not when the dispatcher did. Queued
    // onsets promote at their own heard moments so a newer kick never
    // orphans one still in flight to the ear.
    while (this._kickPending.length && this._kickPending[0] <= vNow) this._kickTMs = this._kickPending.shift();
    this.beatFlash = kickEnv(vNow - this._kickTMs);
    this._nowMs = nowMs;
    this.groundY = groundY;
    this.screenX = midio.screenX + this.xRel;
    // Predatory weave (+ rabid skitter): stalks side to side instead of
    // gliding on rails. Render-only -- the spring physics/panic hops above
    // are untouched. Hoisted here (rather than computed inline in draw())
    // so Renderer can read his true rendered x for the contact shadow
    // without reaching into underscore-prefixed internals.
    const weave = WEAVE_PX * (1 - 0.5 * this._calmLevel) * Math.sin(this._ensPhase != null ? this._ensPhase : nowMs * 0.006)
      + 3.5 * this.rho * Math.sin(nowMs * 0.031);
    this.renderX = this.screenX + weave;
    // Soft keep-out on the drawn pose: ease out of Midio's landing column
    // instead of hard-clamping (instant clamp was a visible teleport).
    const renderOff = this.renderX - midio.screenX;
    if (Math.abs(renderOff) < RENDER_KEEPOUT_HALF) {
      const side = renderOff === 0 ? (this._lastSide < 0 ? -1 : 1) : Math.sign(renderOff);
      const target = midio.screenX + side * RENDER_KEEPOUT_HALF;
      const k = 1 - Math.exp(-dtSec / RENDER_KEEPOUT_TAU);
      this.renderX += (target - this.renderX) * k;
      // Keep spring state near the soft edge so we don't fight the ease next frame.
      const softXRel = this.renderX - midio.screenX - weave;
      if (Math.abs(softXRel) > Math.abs(this.xRel) * 0.5 || Math.abs(this.xRel) < RENDER_KEEPOUT_HALF) {
        this.xRel = softXRel;
        this.xRelVel *= 0.85;
      }
    }
    // Backstop: the set-point above keeps him aiming on-frame, but a hop, the
    // weave, a panic burst or a keep-out ease can still carry him past the
    // edge. Bring the spring's own state back with him and kill the outward
    // velocity, so he stops AT the edge instead of pressing into it and
    // snapping back the moment the force relents.
    const minX = EDGE_MARGIN_PX, maxX = Math.max(minX, this._stageW - EDGE_MARGIN_PX);
    if (this.renderX < minX || this.renderX > maxX) {
      const clamped = clamp(this.renderX, minX, maxX);
      const pushedOut = (this.renderX < minX && this.xRelVel < 0)
        || (this.renderX > maxX && this.xRelVel > 0);
      this.renderX = clamped;
      this.xRel = clamped - midio.screenX - weave;
      this.screenX = midio.screenX + this.xRel;
      if (pushedOut) this.xRelVel = 0;
    }

    // Midasus style: ease his spectral color toward his line's latest note,
    // advance the note-slashes, and -- now that his rendered position is
    // known -- throw a fresh slash for any hard hop that just triggered.
    this.hue = easeHueDeg(this.hue, this._hueTarget, 1 - Math.exp(-dtSec / 0.25));
    this.slashes.update(dtSec);
    if (this._slashPending > 0) {
      const bodyY = this.groundY - this.hopY - 30;
      const ang = Math.atan2(-1, this.xRelVel * 0.01); // up-ish, leaning with his drift
      this.slashes.add(this.renderX, bodyY, ang, 30 + 46 * this._slashPending, this.hue);
      this._slashPending = 0;
    }

    // Locomotion/rendering above keeps running harmlessly underneath (so a
    // resurface never has to catch up on anything); once he's away,
    // draw() skips him here and Renderer draws the underground band
    // instead (see Burrow.draw, called directly from Renderer.js). The
    // bass band (e1, computed above for the tongue) doubles as the cave
    // walls' vibration drive.
    this.burrow.update(nowMs, dtSec, worldX, groundField, e1);
    if (this.burrow.justSurfaced) {
      // Resurface at the hole he actually exited — spring state was free to
      // wander during the tunnel and used to snap him across the stage.
      const exitWorldX = this.burrow.surfaceWorldX ?? (worldX + this.xRel);
      this.xRel = exitWorldX - worldX;
      this.xRelVel = 0;
      if (Math.abs(this.xRel) < KEEPOUT_HALF) {
        this.xRel = (this._lastSide < 0 ? -1 : 1) * KEEPOUT_HALF;
      }
      this._lastSide = Math.sign(this.xRel) || this._lastSide;
      this.screenX = midio.screenX + this.xRel;
      this.renderX = this.screenX;
      // The pop-out: a real hop arc, a hard body ring, and a beat flash --
      // he bursts out of the ground, he doesn't fade back in. And always
      // with a celebratory flip: he's proud of the tunnel. (A reaction, not
      // a charted note, so its hop anchors a rise-time ahead of "now".)
      this._hop = { anchorMs: vNow + 150, h: 40, riseMs: 150 };
      this._rollStartMs = nowMs;
      this._rollDurMs = 300;
      this._rollTurns = 1;
      this._rollDir = 1;
      this.modal.excite(5);
      // Backdated to kickEnv's peak so the pop-out flash is INSTANTLY full,
      // matching the old hard set-to-1 -- not a 40ms ramp from zero.
      this._kickTMs = vNow - 40;
    }
  }

  _startHop(nowMs, vel, pitch, anchorMs = nowMs + 80) {
    // Relaxed lope: calm sections soften the hop instead of cutting it
    // entirely. Pitch anchoring: a higher note lifts him higher (and the
    // hop resolves a touch quicker -- lighter, not heavier). The arc is
    // anchored so its APEX lands on anchorMs -- the note's own onset.
    const liftMul = broshiHopHeightMul(pitch, this._pitchMin, this._pitchMax);
    this._hop = {
      anchorMs,
      h: (16 + 26 * vel) * liftMul * (1 - 0.5 * this._calmLevel),
      riseMs: 80 / Math.sqrt(liftMul),
    };
    if (vel > 0.5) this._slashPending = vel; // a hard hop throws a Midasus-style slash

    // Hard hops sometimes come with a full barrel roll — likelier (and
    // occasionally doubled) the more rabid he's running. The gate carries a
    // real cooldown now: "not already rolling" was the only limit before, so
    // at high rho (chance up to 0.70 per hard hop) a dense line had him
    // barrel-rolling essentially without pause.
    const rollU = (anchorMs - this._rollStartMs) / this._rollDurMs;
    const rolling = rollU >= 0 && rollU < 1;
    if (!rolling && vel > 0.6 && this._rollGate.tryFire(anchorMs, { intensity: this.rho })) {
      // Stamped on the note's OWN time, not dispatch time: this runs from a
      // subscribeAhead channel that fires CHOREO_LEAD_MS early, and the
      // envelope reads on the heard clock -- so the roll begins exactly when
      // the hop it belongs to is heard.
      this._rollStartMs = anchorMs;
      this._rollDurMs = ROLL_DUR_MS;
      this._rollTurns = this.rho > 0.6 && this.rand() < 0.5 ? 2 : 1;
      this._rollDir = this.xRelVel >= 0 ? 1 : -1;
    }
  }

  _spawnSpittle() {
    for (let i = 0; i < 3; i++) {
      const ang = -0.38 + (this.rand() * 2 - 1) * 0.3; // ~22deg below horizontal, jittered
      const speed = 80 + 60 * this.rand();
      this.spittle.spawn({
        x: this.tongue.len, y: 0,
        vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
        life: 0.3 + 0.2 * this.rand(),
      });
    }
  }

  /** Current on-screen width in px -- the contact shadow's only source of
   *  truth for his size. Widens on the same pounce-crouch squash frames
   *  his body does. */
  get shadowWidthPx() {
    return BODY_WIDTH_LOCAL * DRAW_SCALE * this.squashX;
  }

  /** Conservative logical box around everything draw() paints this frame
   *  (body, rho ring, wings, glow), for single-draw capture. Null while he
   *  is underground (draw() paints nothing then). */
  drawBounds() {
    if (this.burrow.depth > 0.02) return null;
    const x = this.renderX, y = this.groundY - this.hopY;
    const half = 0.5 * this.shadowWidthPx + 95;
    return { x: x - half, y: y - 175, w: 2 * half, h: 240 };
  }

  draw(ctx, pose, lights = null, focusMul = 1) {
    if (this.burrow.depth > 0.02) return; // he's underground; Renderer draws the Burrow band instead
    // Midasus style: a pale pitch-class spectral hue (eased in update), not
    // the old green->red raptor skin. Rabid reads as heat/brightness below.
    const baseHue = this.hue;
    const x = this.renderX;
    const y = this.groundY - this.hopY;

    ctx.save();
    // Baseline for FocusDirector's dampening -- everything below that
    // doesn't explicitly reset globalAlpha inherits this. The two spots
    // that DO set an absolute value (rho ring, disc wings) multiply
    // focusMul back in explicitly since an absolute assignment would
    // otherwise clobber this baseline.
    ctx.globalAlpha = focusMul;
    ctx.translate(x, y);
    ctx.scale(DRAW_SCALE, DRAW_SCALE);

    if (this.rho > 0.02) {
      // The serration re-rolls at RING_JITTER_HZ of heard time, as it
      // used to at frame rate, but the same instant always draws the same ring.
      const ringFrame = Math.floor((this._nowMs || 0) * RING_JITTER_HZ / 1000);
      ctx.save();
      ctx.globalAlpha = 0.38 * this.rho * focusMul;
      ctx.strokeStyle = '#e8f2ff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 0; i <= 14; i++) {
        const ang = (i / 14) * Math.PI * 2;
        const r = (i % 2 === 0 ? 30 : 21) + (renderJitter01(this._renderSeed, ringFrame, i) * 2 - 1) * 4; // serrated, not round
        const px = Math.cos(ang) * r, py = -16 + Math.sin(ang) * r * 0.7;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    // tongue (behind head, extends forward/down)
    if (this.tongue.len > 0.5) {
      ctx.strokeStyle = 'rgba(200,228,255,0.85)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(6, -16);
      const midX = 6 + this.tongue.len * 0.55, midY = -16 + this.tongue.len * 0.10;
      const endX = 6 + this.tongue.len * Math.cos(22 * Math.PI / 180);
      const endY = -16 + this.tongue.len * Math.sin(22 * Math.PI / 180);
      ctx.lineTo(midX, midY); // an angular lash, not a soft curve
      ctx.lineTo(endX, endY);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(200,230,255,0.8)';
    for (const p of this.spittle.active) {
      ctx.fillRect(6 + p.x - 1, -16 + p.y - 1, 2.4, 2.4); // sparks, not droplets
    }

    // Comet trail: fading motes behind him, drawn before the body so his
    // silhouette sits on top of his own tail of light.
    if (this.trail.active.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const p of this.trail.active) {
        const u = p.age / p.life;
        ctx.fillStyle = `hsla(${baseHue},60%,72%,${(1 - u) * 0.55})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2 * (1 - u), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore(); // done with the ctx.translate-relative aura/tongue/spittle drawing

    // Body/head/jaw/eye as a low-poly wireframe (follow-up item 1): manually
    // transformed (not via ctx.rotate) so edge angle/length -- and therefore
    // hue/glow -- actually reacts to the neck-bob and jaw snap.
    const neckRad = (this.neckAngle * Math.PI) / 180;
    // bodyRoll tumbles the whole glyph (barrel roll / tail-chase); the
    // pounce squash coils it. Both render-only, like everything else here.
    const group = {
      tx: x, ty: y, rot: neckRad + this.bodyRoll + this._discRoll,
      scaleX: DRAW_SCALE * this.squashX * this._swell * this._discScaleX,
      scaleY: DRAW_SCALE * this.squashY * this._swell * this._discScaleY,
      rotX: this._tumbleRotX || 0, rotY: this._tumbleRotY || 0,
    };
    const bodyHub = BROSHI_BODY.vertices[0];
    // Crisper raptor glyph: cap melt so the body stays a raptor, not soup.
    const meltAmt = Math.min(this._melt || 0, 1.2);
    const bodyMeshClean = meltMesh(
      displaceMeshRadial(BROSHI_BODY, bodyHub.x, bodyHub.y, this.modal),
      bodyHub.x, bodyHub.y, this._nowMs / 1000, meltAmt, 2,
    );
    const glyphOpts = {
      satBase: 38 + 18 * this.rho,
      lightBase: 54 + 14 * this.rho,
      widthBase: 2.2,
      widthGlow: 2.1,
      lights, // Movement VII: celestial + any nearby secondary lights (see LightField.js)
    };

    // Modest under-glow — big halos washed him out next to Midio.
    const glowAlpha = 0.12 + 0.18 * this.rho + 0.22 * this.beatFlash;
    const glowCenter = applyTransform(bodyHub, group);
    drawGlowHalo(ctx, glowCenter.x, glowCenter.y, 22 * group.scaleX, 18 * group.scaleY, baseHue, glowAlpha, { sat: 36, light: 72 });

    // Ink contour under the crisp strokes: silhouette stays sharp.
    drawMeshPart(ctx, bodyMeshClean, this._bodyRest, group, baseHue, { ...glyphOpts, outline: { widthAdd: 3.2 } });
    drawMeshPart(ctx, BROSHI_HEAD, this._headRest, group, baseHue, { ...glyphOpts, outline: { widthAdd: 3.0 } });
    if (this.beatFlash > 0.03) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      drawMeshPart(ctx, bodyMeshClean, this._bodyRest, group, baseHue, {
        alpha: 0.45 * this.beatFlash, satBase: 60, lightBase: 70, widthBase: 2.0,
      });
      ctx.restore();
    }

    const jawTip = BROSHI_JAW.vertices[1];
    const jawMesh = { vertices: [BROSHI_JAW.vertices[0], { x: jawTip.x, y: jawTip.y + this.jawOpen * 10 }], edges: BROSHI_JAW.edges };
    drawMeshPart(ctx, jawMesh, this._jawRest, group, baseHue + 12, {
      satBase: 28, lightBase: 58, widthBase: 1.5, outline: true,
    });

    const tailRad = (this.tailAngle * Math.PI) / 180;
    const [tailBase, tailTip0] = BROSHI_TAIL.vertices;
    const tdx = tailTip0.x - tailBase.x, tdy = tailTip0.y - tailBase.y;
    const tailTip = {
      x: tailBase.x + tdx * Math.cos(tailRad) - tdy * Math.sin(tailRad),
      y: tailBase.y + tdx * Math.sin(tailRad) + tdy * Math.cos(tailRad),
    };
    const tailMesh = { vertices: [tailBase, tailTip], edges: BROSHI_TAIL.edges };
    drawMeshPart(ctx, tailMesh, this._tailRest, group, baseHue - 8, {
      satBase: 30, lightBase: 50, widthBase: 1.6, outline: true,
    });

    // Rabid lights the eye white-hot rather than switching to predatory red.
    const eyeLit = this.rho > 0.3;
    drawMeshPart(ctx, BROSHI_EYE, this._eyeRest, group, baseHue, {
      satBase: 28, lightBase: eyeLit ? 90 : 22, alpha: eyeLit ? 0.55 + 0.4 * this.rho : 0.95,
      widthBase: 1.4,
    });

    // Disc-spin wings: sprout only for the move's duration, folding back
    // out as it ends -- they exist to explain the hop, not as a permanent
    // feature. Rotate with the spin like the body does, but scale UNIFORMLY
    // (DRAW_SCALE, not group.scaleX/Y) -- the body's own scale is wildly
    // asymmetric during the disc (tall, pinched narrow), and reusing it here
    // would squash the wingspan down to an unreadable sliver instead of a
    // wide, angled span reaching out from the spin.
    if (this._discWings > 0.02) {
      const w = this._discWings;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(group.rot);
      ctx.scale(DRAW_SCALE, DRAW_SCALE);
      // Lightness kept well under the body's own near-white wireframe --
      // at ~85% the hue barely reads at all, and the membrane vanished into
      // "more wireframe" instead of standing out as its own translucent
      // panel.
      ctx.globalAlpha = 0.6 * w * focusMul;
      ctx.fillStyle = `hsla(${baseHue},75%,62%,0.6)`;
      ctx.strokeStyle = `hsla(${baseHue - 10},85%,80%,1)`;
      ctx.lineWidth = 2.2 / DRAW_SCALE;
      for (const side of [-1, 1]) {
        // A big, unmissable sweep reaching well clear of the body silhouette
        // (his mesh spans roughly -20..20 local units) -- these are meant to
        // read instantly as "wings," not as a subtle body-hugging detail.
        const spanX = side * 48 * w, sweepY = -34 * w;
        ctx.beginPath();
        ctx.moveTo(0, -8);
        ctx.quadraticCurveTo(side * 20, -12 + sweepY * 0.6, spanX, -6 + sweepY);
        ctx.quadraticCurveTo(side * 22, 10, 0, 10);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(DRAW_SCALE, DRAW_SCALE);
    for (const d of this.drool.active) {
      ctx.fillStyle = 'rgba(150,220,255,0.7)';
      ctx.beginPath();
      ctx.arc(12, -16 + d.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // Midasus-style note slashes: bright additive cuts along his hops, drawn
    // last in absolute space so they read over his silhouette.
    this.slashes.draw(ctx);
  }
}
