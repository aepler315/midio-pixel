// Midasus, the airborne fairy (spec §3.1). Obeys the score: absolute
// pitch-space coordinates, zero inertia tolerance. Sequential no-skip note
// tracking with a 70% trajectory snap on each trigger, a PD pursuit
// controller between triggers, and a Lissajous orbit during rests.
import { Role } from '../core/NoteEvent.js';
import { visualNow } from '../core/ChoreoClock.js';
import { ObjectPool } from '../utils/ObjectPool.js';
import { clamp, lerp, mulberry32, softRepel1D } from '../utils/math.js';
import { MIDASUS_MESH, MIDASUS_HEX_R } from '../render/meshes.js';
import { computeRestLengths, drawMeshPart, displaceMeshRadial, meltMesh, drawGlowHalo } from '../render/MeshDrawer.js';
import { ModalRing } from '../render/oscillators.js';
import { OrbitalDebris } from './OrbitalDebris.js';
import { SkyVoyage, VoyagePhase } from './SkyVoyage.js';
import { BabyStars } from './BabyStars.js';
import { FlourishGate } from './FlourishGate.js';
import { MIDASUS_CURVES, MIDASUS_CURVE_NAMES, HARMONOGRAPH_DECAY_MS, normalizeCurveEnv } from './MidasusCurves.js';

const SILENCE_MS = 800;
const BLEND_SEC = 0.4;
const KP = 90, KD = 12;
const SNAP = 0.70;
const DRAW_SCALE = 5.4; // 3× the previous 1.8 stage scale — she's the star of the sky
const BANK_GAIN = 0.0016, BANK_MAX = 0.6; // she rolls into her darts
const SLASH_LIFE_SEC = 0.18;
// Pirouette rate limit: a full 320ms roll on every vel>0.85 note meant a
// loud passage restarted it before it ever landed. The floor comfortably
// outlasts the move so each one resolves.
const PIROUETTE_MIN_GAP_MS = 2500;
const PIROUETTE_CHANCE = 0.5, PIROUETTE_CHANCE_HOT = 0.85;
// Disc spin (trio flourish -- see update()'s discCue gate):
// wider and longer than the single-accent pirouette so it reads as its own
// distinct move, "turning into a spinning disc" rather than just a hard bank.
const DISC_MS = 420;
const DISC_TURNS = 2.4;
const DISC_SCALE_PEAK = 1.9; // both axes together -- see draw()'s presScale
// Anticipation (ChoreoClock): she launches her dart this far BEFORE each
// note so she's arriving as it sounds -- the impact FX (burst/slash/pulse)
// wait for the note's own heard moment.
const ANTICIPATE_MS = 140;

export class Midasus {
  /**
   * @param {?Function} opts.noteFilter which timeline events are HER line
   *   -- set by Simulation from the casting lanes (clean melodies when a
   *   clean lane exists, every MELODY event otherwise).
   */
  constructor(timeline, midio, { groundY = 480, ceilingY = 40, seed = 777, stageW = 1280, stageH = 720, noteFilter = null } = {}) {
    this.midio = midio;
    this.yFloor = groundY;
    this.yCeiling = ceilingY;
    this.stageW = stageW;
    this.stageH = stageH;

    const filter = noteFilter || ((e) => e.role === Role.MELODY);
    this.q = timeline.filter(filter).sort((a, b) => a.tMs - b.tMs);
    this.i = 0;
    this._impacts = []; // scheduled note-impact FX, drained at each note's heard moment
    this.visualLagMs = 0; // output-latency compensation, set by Simulation each step

    let pMin = 48, pMax = 84;
    if (this.q.length) {
      const pitches = this.q.map((n) => n.pitch).sort((a, b) => a - b);
      pMin = pitches[Math.floor(0.05 * pitches.length)];
      pMax = pitches[Math.min(pitches.length - 1, Math.floor(0.95 * pitches.length))];
      if (pMax <= pMin) pMax = pMin + 12;
    }
    this.pMin = pMin;
    this.pMax = pMax;

    this.p = { x: midio.screenX + 150, y: groundY - 230 };
    this.v = { x: 0, y: 0 };
    this.lastNoteMs = -Infinity;
    this.hue = 200;
    this.rest = 0; // 0 = active/full color, 1 = resting/desaturated

    this.rand = mulberry32(seed);
    this.phi = 0;
    this.particles = new ObjectPool(() => ({}), (o, init) => Object.assign(o, init, { age: 0 }), 600);
    this._emitAccum = 0;

    this._meshRest = computeRestLengths(MIDASUS_MESH);
    this.pulse = 1;
    this.slashes = []; // short bright cuts along her velocity on note onsets
    // Her diamond core shivers on every melody onset -- quicker and lighter
    // than Midio's body (higher base frequency, faster ring-down).
    this.modal = new ModalRing({ modes: 3, baseHz: 11, decaySec: 0.4, seed: seed + 1 });
    // Gravitationally bound shards: they trail and slingshot as she darts.
    this.debris = new OrbitalDebris(seed + 2);
    // Occasional deep-sky excursion: BiomeManager draws it (see
    // drawDeepSky), far behind the world, while this is active.
    this.voyage = new SkyVoyage(seed + 3);
    // Three baby stars use her as their secure base: orbiting close,
    // exploring one at a time in calm stretches, rushing home when loud.
    this.babies = new BabyStars(seed + 4);

    // Rest-flight repertoire: each time she settles into a rest she picks a
    // fresh figure to trace (see _orbitAnchor), never the same one twice
    // running. Hard melody accents also spin her into a brief pirouette.
    this.orbitStyle = 'lissajous';
    // Must be valid for orbitStyle from frame one: _orbitAnchor can be
    // called on the very first silence, before any rest-transition has
    // ever run to populate this properly (silence starts immediately, well
    // before `rest` ramps past the 0.5 threshold that triggers a pick) --
    // an empty {} here left lissajous's point() reading params.p/q as
    // undefined, i.e. permanent NaN position from the first quiet beat.
    this._curveParams = MIDASUS_CURVES.lissajous.params(normalizeCurveEnv({}));
    this._restStartMs = -Infinity;
    // Tracked purely to shape the NEXT rest figure (MidasusCurves.js): the
    // interval between the last two notes and how hard the most recent one
    // hit -- "the music that just played," not a music-theory model.
    this._prevPitch = null;
    this._lastIntervalSemitones = 0;
    this._lastVel = 0.5;
    this._wasResting = false;
    this.rollExtra = 0; // pirouette roll, added to her banking in draw()
    this._pirouetteStartMs = -Infinity;
    this._pirouetteGate = new FlourishGate({
      minGapMs: PIROUETTE_MIN_GAP_MS, chance: PIROUETTE_CHANCE,
      intensityChance: PIROUETTE_CHANCE_HOT, intensityScale: 0.5, rand: this.rand,
    });
    // Disc spin (the trio's shared flourish, see EnsembleDirector.maybeDisc):
    // a wide spinning-disc turn on the same cue as Broshi's, but hers grows
    // BOTH axes together (presScale already drives scaleX/scaleY equally)
    // instead of Midio's single-axis pinch -- she flattens into a round
    // halo, not an ellipse edge-on.
    this._discStartMs = -Infinity;
    this._discScale = 1;
    this._discRoll = 0;
  }

  /** Test/debug hook: send her on a voyage right now regardless of natural
   * triggers. No-op if she's already away. */
  forceVoyage(nowMs, chorusText, lyricSymbol = null) {
    return this.voyage.trigger(nowMs, { ...this.p }, this.stageW, this.stageH, chorusText, lyricSymbol);
  }

  _target(n) {
    const norm = clamp((n.pitch - this.pMin) / (this.pMax - this.pMin), 0, 1);
    // Floor raised (was yFloor-120) -- her lowest notes used to sit inside
    // Midio's own body; now even the deepest pitch keeps clear headroom.
    const y = lerp(this.yFloor - 210, this.yCeiling + 60, norm);
    const x = this.midio.screenX + 150 + 55 * n.vel;
    // The ensemble pulls her across the stage; pitch stays primary vertically.
    if (this._ens) {
      return {
        x: x * 0.35 + this._ens.x * 0.65,
        y: y + clamp(this._ens.y - y, -110, 110) * 0.35,
      };
    }
    return { x, y };
  }

  _orbitAnchor(nowMs, calmLevel) {
    const ax = this._ens ? this._ens.x : this.midio.screenX;
    // Raised (was -130) -- her rest orbit used to sit low enough to overlap
    // Midio when he's grounded; now it clears him by a real margin.
    const ay = this.midio.groundY - this.midio.y - 230;
    const t = nowMs / 1000;
    // Calm sections: the orbit widens and slows -- a lazier, dreamier drift
    // instead of the tighter, quicker figure she traces when energetic.
    const a = 1 + 0.6 * calmLevel;
    const r = 1 - 0.5 * calmLevel;
    const curve = MIDASUS_CURVES[this.orbitStyle] || MIDASUS_CURVES.lissajous;
    const restU = this._restStartMs > -Infinity
      ? clamp((nowMs - this._restStartMs) / HARMONOGRAPH_DECAY_MS, 0, 1)
      : 0;
    const p = curve.point(t, this.phi, a, r, this._curveParams, restU);
    return { x: ax + p.x, y: ay + p.y };
  }

  _hueOf(pitch) { return (((pitch % 12) + 12) % 12) * 30; }

  _burst(n, hue) {
    for (let i = 0; i < n; i++) {
      const ang = this.rand() * Math.PI * 2;
      const speed = 40 + 80 * this.rand();
      this.particles.spawn({
        x: this.p.x, y: this.p.y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
        size: 4, hue, life: 0.3 + 0.2 * this.rand(),
      });
    }
  }

  _emitStreak(speed) {
    const jitter = 25;
    // Calm sections get a longer, fainter ribbon instead of a short, punchy trail.
    const calmLevel = this._calmLevel || 0;
    this.particles.spawn({
      x: this.p.x, y: this.p.y,
      vx: this.v.x * 0.3 + (this.rand() * 2 - 1) * jitter,
      vy: this.v.y * 0.3 + (this.rand() * 2 - 1) * jitter,
      size: 3, hue: this.hue, life: ((260 + 160 * this.rand()) * (1 + 0.6 * calmLevel)) / 1000,
    });
  }

  update(nowMs, dtSec, calmLevel = 0, ensemble = null, particleMul = 1, wind = null) {
    this._calmLevel = calmLevel;
    this._ens = ensemble;
    this._nowMs = nowMs;
    // Disc spin: a trio-wide flourish, cued and rate-limited by
    // EnsembleDirector.maybeDisc on a section change / drop / combo
    // milestone. It used to fire on ensemble.justClean -- but the show is
    // autoplay, so every landing is clean, and a 420ms spin restarted every
    // ~500ms left her permanently rotating.
    if (ensemble && ensemble.discCue) this._discStartMs = nowMs;
    // Apex-on-beat (ChoreoClock): the DART starts early -- cursor runs
    // ANTICIPATE_MS ahead, so the 70% trajectory snap and the PD pursuit
    // are already carrying her toward the perch as the note arrives...
    while (this.i < this.q.length && this.q[this.i].tMs <= nowMs + ANTICIPATE_MS) {
      const n = this.q[this.i++];
      const t = this._target(n);
      // Dart toward the target as a VELOCITY kick, not an instant position
      // jump. This used to move her SNAP of the remaining distance in a
      // single frame -- a real teleport, one per note, which on a normal
      // melody (a note roughly every second) read as a twitchy stutter
      // rather than the fast dart the surrounding comments describe. Sized
      // so she covers SNAP of the distance over the anticipation window,
      // then the PD pursuit below (already running every frame) takes over
      // and eases her the rest of the way -- same destination, same
      // "arriving as the note sounds" timing, but the travel is now an
      // actual, visible motion instead of a pop.
      const boostSec = ANTICIPATE_MS / 1000;
      this.v.x = SNAP * (t.x - this.p.x) / boostSec;
      this.v.y = SNAP * (t.y - this.p.y) / boostSec;
      this.hue = this._hueOf(n.pitch);
      if (this._prevPitch != null) this._lastIntervalSemitones = n.pitch - this._prevPitch;
      this._prevPitch = n.pitch;
      this._lastVel = n.vel;
      if (this.voyage.active) this.voyage.onMelodyOnset(n); // deep space hears the melody too
      this._impacts.push(n);
    }
    // ...while the IMPACT (burst, slash, pulse, core ring) waits for the
    // note's own heard moment: move early, hit exactly on time.
    const vNowMs = visualNow(nowMs, this.visualLagMs);
    while (this._impacts.length && this._impacts[0].tMs <= vNowMs) {
      const n = this._impacts.shift();
      // Stamped at the heard moment (not at dart time, which runs up to
      // ANTICIPATE_MS ahead) so the silence clock never reads the future.
      this.lastNoteMs = n.tMs;
      // Hard accents spin her right around -- but rate-limited, and stamped
      // on the note's own heard time. Ungated, any run of loud notes
      // restarted the 320ms roll on every onset, so it never once reached
      // its eased-out landing and read as continuous rotation.
      if (n.vel > 0.85 && this._pirouetteGate.tryFire(n.tMs, { intensity: n.vel })) {
        this._pirouetteStartMs = n.tMs;
      }
      // The impacting NOTE's own color -- this.hue has already darted ahead
      // to a newer note on dense passages, same reason the slash below
      // re-derives it from n.pitch.
      this._burst(8 + 24 * n.vel, this._hueOf(n.pitch));
      this.pulse = 1.7 + 0.5 * n.vel; // a brief mesh flash on each note onset
      this.modal.excite(1.2 + 3 * n.vel);
      if (n.vel > 0.75) this.debris.burst(n.vel); // hard notes fling the shards outward
      // A slash: a bright cut through her position along her motion.
      const sp = Math.hypot(this.v.x, this.v.y);
      const ang = sp > 20 ? Math.atan2(this.v.y, this.v.x) : this.rand() * Math.PI * 2;
      this.slashes.push({ x: this.p.x, y: this.p.y, ang, len: 26 + 60 * n.vel, age: 0, hue: this._hueOf(n.pitch) });
      if (this.slashes.length > 8) this.slashes.shift();
    }

    this.pulse += (1 - this.pulse) * Math.min(1, dtSec / 0.12);
    this.modal.update(dtSec);
    this.phi += 0.15 * dtSec;

    const nxt = this.q[this.i];
    const silence = nowMs - this.lastNoteMs >= SILENCE_MS || !nxt;
    const target = silence ? this._orbitAnchor(nowMs, calmLevel) : this._target(nxt);
    const restTarget = silence ? 1 : 0;
    this.rest += clamp((restTarget - this.rest) * (dtSec / BLEND_SEC), -1, 1);
    this.rest = clamp(this.rest, 0, 1);

    // Each time she settles into a rest she picks a fresh figure to trace —
    // figure-8s, loop-the-loops, a petaled rose — never the same twice
    // running, with a fresh phase so the entry point varies too.
    const resting = this.rest >= 0.5;
    if (resting && !this._wasResting) {
      const styles = MIDASUS_CURVE_NAMES.filter((s) => s !== this.orbitStyle);
      this.orbitStyle = styles[Math.floor(this.rand() * styles.length)];
      this.phi = this.rand() * Math.PI * 2;
      this._restStartMs = nowMs;
      // The figure is shaped by whatever she was just playing -- the
      // interval into the last note and how hard it hit -- not fixed
      // constants, so the same handful of families reads as real variety.
      this._curveParams = MIDASUS_CURVES[this.orbitStyle].params(normalizeCurveEnv({
        lastIntervalSemitones: this._lastIntervalSemitones,
        lastPitchClass: this._prevPitch,
        lastVel: this._lastVel,
      }));
    }
    this._wasResting = resting;

    // Pirouette: a full roll, eased out, landing exactly back at her bank.
    // On the HEARD clock, like the impact FX it accompanies -- these rotation
    // channels used to run on raw nowMs while the burst/slash/pulse beside
    // them drained at vNowMs, so on a high-latency output her spins led the
    // note they were reacting to.
    const pirU = (vNowMs - this._pirouetteStartMs) / 320;
    this.rollExtra = pirU >= 0 && pirU < 1 ? Math.PI * 2 * (1 - (1 - pirU) ** 3) : 0;

    // Disc spin: a wide, fast turn distinct from the single-accent
    // pirouette above -- more turns, and (unlike rollExtra) it carries its
    // own scale swell so she visibly widens into a spinning disc rather
    // than just banking harder. Smoothstep in and back out so she reads as
    // *turning into* the disc and back, not popping to it.
    const discU = (vNowMs - this._discStartMs) / DISC_MS;
    if (discU >= 0 && discU < 1) {
      const ease = Math.sin(discU * Math.PI); // 0 -> 1 -> 0 across the window
      this._discRoll = DISC_TURNS * Math.PI * 2 * (1 - (1 - discU) ** 3);
      this._discScale = 1 + (DISC_SCALE_PEAK - 1) * ease;
    } else {
      this._discRoll = 0;
      this._discScale = 1;
    }

    this.v.x += (KP * (target.x - this.p.x) - KD * this.v.x) * dtSec;
    this.v.y += (KP * (target.y - this.p.y) - KD * this.v.y) * dtSec;
    // Soft personal space: drift off Midio and Broshi when she crowds them
    // (quadratic falloff — never a hard shove). Strengthened on X (was 240)
    // -- against the KP=90 target spring, 240 was negligible whenever a low
    // note's target sat anywhere near his own x, so a low note could still
    // slide her right through him; strong enough now to actually win a tug
    // of war against the spring at close range.
    const midioX = this.midio.screenX;
    const midioY = this.midio.groundY - this.midio.y - 30;
    this.v.x += softRepel1D(this.p.x, midioX, 170, 900) * dtSec;
    this.v.y += softRepel1D(this.p.y, midioY, 100, 160) * dtSec;
    if (this._ens && Number.isFinite(this._ens.broshiX)) {
      // Matched to Broshi's own repel-from-Midasus (Broshi.js SOFT_REPEL_MIDASUS)
      // -- previously much weaker than the Midio repel above, so the trio's
      // two "orbiting" characters still crowded each other even once each was
      // separately well clear of Midio.
      this.v.x += softRepel1D(this.p.x, this._ens.broshiX, 160, 450) * dtSec;
      if (Number.isFinite(this._ens.broshiY)) {
        this.v.y += softRepel1D(this.p.y, this._ens.broshiY, 110, 200) * dtSec;
      }
    }
    this.p.x += this.v.x * dtSec;
    this.p.y += this.v.y * dtSec;

    const speed = Math.hypot(this.v.x, this.v.y);
    const rateMul = 0.15 + 0.85 * (1 - this.rest);
    const rate = (2 + 26 * Math.min(1, speed / 1400)) * rateMul * particleMul;
    this._emitAccum += rate * dtSec * 60;
    while (this._emitAccum >= 1) { this._emitAccum -= 1; this._emitStreak(speed); }

    // The settling stardust rides the same global wind everything else
    // does -- one sample for the whole trail, not per-mote.
    const windX = wind ? wind.x : 0, windY = wind ? wind.y : 0;
    this.particles.step(dtSec, (o, dt) => {
      o.x += (o.vx + windX) * dt; o.y += (o.vy + windY) * dt; o.age += dt;
      return o.age < o.life;
    });
    for (const s of this.slashes) s.age += dtSec;
    while (this.slashes.length && this.slashes[0].age >= SLASH_LIFE_SEC) this.slashes.shift();

    // Note pulses briefly raise her effective mass (orbits tighten);
    // calm sections lower it, so the shards drift into wider, lazier arcs.
    const massMul = (0.8 + 0.5 * (this.pulse - 1)) * (1 - 0.3 * calmLevel);
    this.debris.update(dtSec, this.p, Math.max(0.3, massMul));

    // Sky voyage: the note/PD logic above keeps running harmlessly
    // underneath (so a return never has to catch up on a backlog), but
    // once she's away the voyage fully owns where "she" is -- draw() skips
    // rendering her here and BiomeManager's deep-sky pass takes over.
    const anchorX = this._ens ? this._ens.x : this.midio.screenX + 150;
    const anchorY = this._ens ? this._ens.y : this.yFloor - 230;
    this.voyage.update(nowMs, dtSec, ensemble ? ensemble.epic || 0 : 0, { x: anchorX, y: anchorY });
    if (this.voyage.active) {
      this.p = { ...this.voyage.p };
      this.hue = this.voyage.hue;
      // A lengthened comet streak through the climb: the normal streak
      // above rides `this.v`, the PD-pursuit velocity, which is stale/
      // irrelevant once the voyage owns her position -- this one rides her
      // TRUE frame-to-frame voyage displacement, with a longer life than
      // the everyday trail so ASCENT specifically reads as racing away.
      if (this.voyage.phase === VoyagePhase.ASCENT && this._prevVoyageP) {
        const dt = Math.max(dtSec, 1e-4);
        const vx = (this.p.x - this._prevVoyageP.x) / dt;
        const vy = (this.p.y - this._prevVoyageP.y) / dt;
        this.particles.spawn({
          x: this.p.x, y: this.p.y,
          vx: -vx * 0.25 + (this.rand() * 2 - 1) * 12,
          vy: -vy * 0.25 + (this.rand() * 2 - 1) * 12,
          size: 3, hue: this.hue, life: 0.6 + 0.3 * this.rand(),
        });
      }
      this._prevVoyageP = { x: this.p.x, y: this.p.y };
    } else {
      this._prevVoyageP = null;
    }
    // The babies track her wherever the frame puts her (ensemble, darts,
    // even voyage return points). They render at the mains' intensity (her
    // pulse + the song's epic-ness), are hyper curious about every point of
    // interest the sim hands over (Midio, Broshi, obstacles, the user's
    // cursor), and are aware of the user via that pointer.
    this.babies.update(nowMs, dtSec, this.p, calmLevel, {
      epic: this._ens ? (this._ens.epic || 0) : 0,
      melt: this._ens ? (this._ens.melt || 0) : 0,
      pulse: this.pulse,
      interests: (this._ens && this._ens.interests && this._ens.interests.length)
        ? this._ens.interests
        : [{ x: this.midio.screenX, y: this.midio.groundY - this.midio.y - 40 }],
      pointer: this._ens ? this._ens.pointer : null,
    });

    if (this.voyage.justLanded) {
      // Touchdown: her core rings hard, the shards fling, and a five-point
      // slash star marks the landing (drawn by her normal pass, which has
      // just resumed since depth is back to 0).
      this.modal.excite(6);
      this.debris.burst(1);
      for (let k = 0; k < 5; k++) {
        this.slashes.push({ x: this.p.x, y: this.p.y, ang: (k / 5) * Math.PI, len: 64, age: 0, hue: this.hue });
      }
      while (this.slashes.length > 8) this.slashes.shift();
    }
    if (this.voyage.justLaunched) {
      // Send-off: the exact symmetric counterpart to the touchdown above --
      // the spiral wind-up releases into a ring, a burst, and a slash star
      // right as she breaks for ASCENT, so leaving reads as dramatic as
      // arriving instead of just fading into a background dot.
      this.modal.excite(6);
      this.debris.burst(1);
      for (let k = 0; k < 5; k++) {
        this.slashes.push({ x: this.p.x, y: this.p.y, ang: (k / 5) * Math.PI, len: 64, age: 0, hue: this.hue });
      }
      while (this.slashes.length > 8) this.slashes.shift();
    }
    // A steady hum while she winds up -- the spiral itself vibrating with
    // gathering power, growing as _phaseU approaches 1.
    if (this.voyage.phase === VoyagePhase.WINDUP) {
      this.modal.excite(2.2 * dtSec * (1 + this.voyage._phaseU));
    }
  }

  /** Current on-screen width in px -- pulses in sync with her core on note
   *  onsets (the same `pulse` value her mesh render uses), then settles. */
  get shadowWidthPx() {
    return 2 * MIDASUS_HEX_R * DRAW_SCALE * this.pulse;
  }

  /** Conservative logical box around everything draw() paints this frame:
   *  core and glow, her particle ribbon and the orbiting debris, for
   *  single-draw capture. Null when draw() paints nothing (deep space). */
  drawBounds() {
    if (this.voyage.phase === VoyagePhase.DEEP_SPACE) return null;
    const swell = this._ens && this._ens.swell != null ? this._ens.swell : 1;
    const pres = this.voyage.presentationScale * swell * this._discScale;
    const r = MIDASUS_HEX_R * 2.4 * Math.max(1, this.pulse) * DRAW_SCALE * pres + 40;
    let x0 = this.p.x - r, x1 = this.p.x + r, y0 = this.p.y - r, y1 = this.p.y + r;
    for (const q of this.particles.active) {
      x0 = Math.min(x0, q.x - q.size); x1 = Math.max(x1, q.x + q.size);
      y0 = Math.min(y0, q.y - q.size); y1 = Math.max(y1, q.y + q.size);
    }
    for (const q of this.debris.shards) {
      x0 = Math.min(x0, q.x - q.size - 2); x1 = Math.max(x1, q.x + q.size + 2);
      y0 = Math.min(y0, q.y - q.size - 2); y1 = Math.max(y1, q.y + q.size + 2);
    }
    return { x: x0 - 8, y: y0 - 8, w: x1 - x0 + 16, h: y1 - y0 + 16 };
  }

  draw(ctx, particleMul = 1, lights = null) {
    // Only DEEP_SPACE hands rendering to BiomeManager's tiny comet-head dot
    // (drawDeepSky) -- WINDUP/ASCENT/REENTRY render right here, in the
    // character layer, in front of the mountains, where the player is
    // actually looking (previously all three were hidden the instant depth
    // ticked past 0.02, ~24ms into a voyage -- the whole departure/return
    // was invisible).
    if (this.voyage.phase === VoyagePhase.DEEP_SPACE) return;
    // Shared build-up swell (EnsembleDirector.swell) composes with her own
    // voyage presentation scale -- 1 (no-op) outside a build-up.
    const swell = this._ens && this._ens.swell != null ? this._ens.swell : 1;
    // _discScale composes here rather than replacing presScale, so a clean
    // combo mid-voyage still widens her, on top of whatever the launch/climb
    // is already doing -- and because scaleX/scaleY below both read this
    // same value, growing it widens BOTH axes together (her disc, unlike
    // Midio's single-axis pinch, spans x and y equally).
    const presScale = this.voyage.presentationScale * swell * this._discScale;
    const sat = Math.round(58 - 28 * this.rest); // spectral: pale, never candy
    this.debris.draw(ctx, this.hue, this.rest, particleMul); // behind her core and trail
    // Calm sections fade the ribbon rather than shortening it -- the longer
    // reach comes from _emitStreak's extended particle life, this is the
    // "fainter" half of that same trade.
    const calmFade = 1 - 0.4 * (this._calmLevel || 0);
    for (const p of this.particles.active) {
      const t = p.age / p.life;
      const size = p.size * (1 - t);
      if (size <= 0) continue;
      ctx.fillStyle = `hsla(${p.hue},${sat}%,65%,${(1 - t) * 0.9 * calmFade})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    // Note slashes: bright cuts along her velocity, gone in a blink.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const s of this.slashes) {
      const u = s.age / SLASH_LIFE_SEC;
      ctx.strokeStyle = `hsla(${s.hue},70%,78%,${0.85 * (1 - u)})`;
      ctx.lineWidth = 2.6 * (1 - u * 0.6);
      const ext = s.len * (0.4 + 0.6 * u); // the cut extends as it fades
      ctx.beginPath();
      ctx.moveTo(s.x - Math.cos(s.ang) * ext, s.y - Math.sin(s.ang) * ext);
      ctx.lineTo(s.x + Math.cos(s.ang) * ext, s.y + Math.sin(s.ang) * ext);
      ctx.stroke();
    }
    ctx.restore();

    const hub = MIDASUS_MESH.vertices[0];
    const coreMesh = meltMesh(
      displaceMeshRadial(MIDASUS_MESH, hub.x, hub.y, this.modal),
      hub.x, hub.y, (this._nowMs || 0) / 1000, (this._ens ? this._ens.melt : 0) * 0.7, 3,
    );
    // Banking: she rolls into her darts like something with mass, and her
    // pulse breathes on her ensemble phase -- in step when the trio locks.
    const bank = clamp(this.v.x * BANK_GAIN, -BANK_MAX, BANK_MAX)
      + (this._ens ? 0.08 * Math.sin(this._ens.phase) : 0);

    const rot = bank + this.rollExtra + this._discRoll; // pirouette + disc spin ride on top of the banking

    // Keep the halo modest — a huge soft disc under the hexagram read as a
    // broken white blob next to Broshi's clean wireframe. presScale swells
    // her before a voyage launch and recedes her through the climb (1
    // outside a voyage, so ordinary performance is untouched).
    const coreGlowR = MIDASUS_HEX_R * 1.55 * this.pulse * DRAW_SCALE * presScale;
    drawGlowHalo(ctx, this.p.x, this.p.y, coreGlowR, coreGlowR, this.hue, 0.32, { sat, light: 74 });

    // Ink contour (outline) under the crisp pass: her diamond stays
    // knife-edged against the blurred halo drawn just above.
    drawMeshPart(ctx, coreMesh, this._meshRest, {
      tx: this.p.x, ty: this.p.y, rot,
      scaleX: this.pulse * DRAW_SCALE * presScale, scaleY: this.pulse * DRAW_SCALE * presScale,
      // Rare shared transition tumble (see EnsembleDirector.maybeTumble).
      rotX: this._ens ? (this._ens.tumbleRotX || 0) : 0,
      rotY: this._ens ? (this._ens.tumbleRotY || 0) : 0,
    }, this.hue, {
      satBase: sat, lightBase: 70, outline: true,
      widthBase: 2.1, widthGlow: 2.4,
      lights, // Movement VII: celestial + ground pulses (never her own glow -- see Renderer.draw)
    });

    // The baby stars ride on top of her pass — small enough never to mask her.
    this.babies.draw(ctx, this.hue, this.rest);
  }
}
