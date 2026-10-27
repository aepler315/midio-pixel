import { Conductor } from '../core/Conductor.js';
import { Lane } from '../core/Casting.js';
import { Midio } from './Midio.js';
import { Broshi } from './Broshi.js';
import { Midasus } from './Midasus.js';
import { JumpController } from './JumpController.js';
import { MidioPerformer } from './MidioPerformer.js';
import { EnsembleDirector } from './EnsembleDirector.js';
import { CalmDirector } from './CalmDirector.js';
import { VibeDirector } from './VibeDirector.js';
import { ExcursionDirector } from './ExcursionDirector.js';
import { GroundField } from '../world/GroundField.js';
import { TrioWander, TrioGaze } from './TrioWander.js';

const STEP = 1000 / 120;
// Performer consumes this legacy scalar to choose its trick repertoire;
// there is no judge, points, streak, health or artificial perfect-tap feed.
const PERFORMANCE = Object.freeze({ displayM: 1 });
// The finale: every star Midasus wrote into her atlas goes supernova this
// long before the song ends, as the song shatters.
const ATLAS_DETONATE_LEAD_MS = 4000;

export class TrioPerformance {
  constructor({ timeline = [], durationMs = 0, bpm = 120, barGrid = [], beatMetadata = null,
    energyCurves = null, paramBus, seed = 315, stageW = 1280, stageH = 720,
    particleMul = 1, ground = null } = {}) {
    this.song = { timeline, durationMs, bpm, barGrid, ...beatMetadata };
    this.energyCurves = energyCurves;
    this.paramBus = paramBus;
    this.seed = seed; this.w = stageW; this.h = stageH;
    // The world's fixed screen origin: the ground is drawn from here, and
    // each of the cast stands on the ground at their own screen x, so a
    // stroll moves them over the ground rather than the ground with them.
    this.originX = stageW * .34;
    this.kicks = timeline.filter(e => e.role === 'RHYTHM' && e.kick && e.vel >= .2);
    this.leads = timeline.filter(e => e.lane === Lane.MIDIO && e.vel >= .65 && (e.pitchConfidence == null || e.pitchConfidence >= .5));
    this.motionEvents = [...this.kicks.map(event => ({ kind: 'kick', event })), ...this.leads.map(event => ({ kind: 'lead', event }))]
      .sort((a, b) => a.event.tMs - b.event.tMs || (a.kind === 'kick' ? -1 : 1));
    this.particleMul = particleMul;
    // The ground the world draws. Sharing it is what keeps the cast standing
    // on the drawn surface instead of a private copy beside it.
    this.sharedGround = ground;
    this.hype = null; this.chorusText = null; this.lyricSymbol = null;
    this._lookB = { x: 0, y: 0 }; this._lookF = { x: 0, y: 0 };
    this.voyageEvents = { launched: false, landed: false };
    this.disposed = false;
    // Where they potter between the beats: a pure function of seed and
    // heard time (TrioWander), so it needs no rebuilding on a seek.
    this.wander = new TrioWander(seed, { stageW, stageH, energyCurves });
    this.gaze = new TrioGaze();
    this.seek(0);
  }

  _reset(startMs) {
    this.broshi?.dispose();
    this.conductor = new Conductor(); this.conductor.load(this.song);
    this.conductor.seekTo(startMs, { primeAhead: true });
    this.midio = new Midio(); this.midio.screenX = this.w * .34;
    this.midio.groundY = this.h * 625 / 720;
    this.jump = new JumpController(this.paramBus);
    this.jump.setKickTimes(this.kicks.map(e => e.tMs));
    this.performer = new MidioPerformer(this.seed);
    this.ensemble = new EnsembleDirector(this.seed, { stageW: this.w, stageH: this.h });
    this.ensemble._t = startMs / 1000;
    this.calm = new CalmDirector();
    this.vibe = new VibeDirector(this.song.timeline);
    this.ground = this.sharedGround || new GroundField(this.midio.groundY, { conductor: this.conductor, durationMs: this.song.durationMs, songSeed: this.seed });
    // Midasus's deep-sky voyages and the (disabled) burrow, scheduled off
    // the music. A seek starts a new performance segment, so its budget and
    // the atlas she writes start over with it.
    this.excursions = new ExcursionDirector(this.song.durationMs || 0);
    this._atlasDetonated = false;
    const bassLane = this.song.timeline.some(e => e.lane === Lane.BROSHI);
    const melodyLane = this.song.timeline.some(e => e.lane === Lane.MIDASUS);
    this.broshi = new Broshi(this.conductor, this.paramBus, { seed: this.seed + 1,
      hopFilter: e => bassLane ? e.lane === Lane.BROSHI : e.role === 'BASS' });
    this.midasus = new Midasus(this.song.timeline, this.midio, { seed: this.seed + 2,
      stageW: this.w, stageH: this.h, groundY: this.midio.groundY, ceilingY: 70,
      noteFilter: e => Number.isFinite(e.tMs) && Number.isFinite(e.pitch)
        && (melodyLane ? e.lane === Lane.MIDASUS : e.role === 'MELODY')
        && (e.pitchConfidence == null || e.pitchConfidence >= .45 || e.src === 'midi') });
    while (this.midasus.i < this.midasus.q.length && this.midasus.q[this.midasus.i].tMs < startMs - 250) this.midasus.i++;
    this.eventCursor = 0; this.lastAirJumpMs = -Infinity; this.lastFlourishMs = -Infinity;
    this._advanceNotes(startMs - .0001, false);
    this.jump.update(startMs);
    this.energySlow = this.energyCurves?.globalEnergyNorm?.(startMs) || 0;
    this.clockMs = startMs;
    this.worldX = startMs * .22;
  }

  /** Rebuild only a bounded recent window; old notes never burst at the
   * destination. JumpController cheaply primes its exact full kick history. */
  seek(timeMs) {
    if (this.disposed) return;
    const t = Math.max(0, Number(timeMs) || 0);
    const start = Math.max(0, Math.floor((t - 6000) / STEP) * STEP);
    this._reset(start);
    this._step(start, 0);
    while (this.clockMs + STEP <= t + 1e-6) this._step(Math.min(t, this.clockMs + STEP), STEP / 1000);
    if (t - this.clockMs > 1e-6) this._step(t, (t - this.clockMs) / 1000);
    this.clockMs = t;
  }

  /** `hype` and the chorus text come from the listening simulation: a drop
   * holds a voyage back, and a chorus voyage sky-writes its lyric. */
  update(timeMs, { particleMul = 1, hype = null, chorusText = null, lyricSymbol = null } = {}) {
    if (this.disposed) return;
    this.particleMul = particleMul; this.hype = hype; this.chorusText = chorusText; this.lyricSymbol = lyricSymbol;
    this.voyageEvents.launched = this.voyageEvents.landed = false;
    const t = Math.max(0, Number(timeMs) || 0);
    if (t < this.clockMs || t - this.clockMs > 1500) { this.seek(t); return; }
    while (this.clockMs + STEP <= t + 1e-6) this._step(Math.min(t, this.clockMs + STEP), STEP / 1000);
    // Keep fractional live steps for interpolation; fixed app/export ticks
    // ordinarily arrive on this same 120 Hz lattice.
    if (t - this.clockMs > 1e-6) this._step(t, (t - this.clockMs) / 1000);
    this.clockMs = t;
  }

  _advanceNotes(throughMs, notify) {
    while (this.eventCursor < this.motionEvents.length && this.motionEvents[this.eventCursor].event.tMs <= throughMs) {
      const { kind, event } = this.motionEvents[this.eventCursor++];
      if (kind === 'kick') {
        this.jump.onKick(event);
        if (notify) { this.performer.onKick(event.tMs); this.midasus.voyage.onKick(event.vel); }
      } else {
        this.jump.update(event.tMs);
        if (this.jump.airborne && this.jump.y < 220 && event.tMs - this.lastAirJumpMs > 8000
          && this.jump.airJump(event, .4)) this.lastAirJumpMs = event.tMs;
      }
    }
  }

  _step(nowMs, dt) {
    this.clockMs = nowMs;
    this.worldX = nowMs * .22 * (this.paramBus.live.scrollSpeed || 1);
    this.jump.clearFrameFlags(); this.performer.clearFrameFlags();
    this.conductor.dispatchUpTo(nowMs);
    this._advanceNotes(nowMs, true);
    this.jump.update(nowMs);
    this.calm.update(nowMs, dt, this.energyCurves);
    this.vibe.update(nowMs, dt, this.energyCurves);
    this.ensemble.update(nowMs, dt, this.vibe, this.jump.beatPeriodMs);
    const energy = this.energyCurves?.globalEnergyNorm?.(nowMs) ?? this.energyCurves?.globalEnergy?.(nowMs) ?? 0;
    const oldEnergy = this.energySlow;
    this.energySlow += (energy - this.energySlow) * (1 - Math.exp(-dt / 3));
    if (energy - oldEnergy > .25 && nowMs - this.lastFlourishMs > 16000) {
      this.ensemble.maybeDisc(nowMs, 'drop', Math.max(.6, this.vibe.epic));
      this.lastFlourishMs = nowMs;
    }
    if (!this.sharedGround) this.ground.update(nowMs, dt, this.worldX, this.energyCurves, this.calm.level, nowMs);
    const plan = this.wander.update(nowMs);
    this.midio.screenX = plan.midio.x;
    this.midio.groundY = this.groundAt(this.midio.screenX);
    this.midio.y = this.jump.y;
    // The performer only adds to this: tricks and strut ride on his stroll.
    this.midio.leanDeg = plan.midio.leanDeg; this.midio.scaleX = this.midio.scaleY = 1;
    if (this.jump.pendingLanding) this.performer.onLanding(nowMs, false, 1, this.jump.lastLaunchVel);
    this.performer.update(nowMs, dt, this.midio, this.jump, PERFORMANCE, this.calm.level, this.ensemble);
    const common = { justClean: false, justLanded: !!this.jump.pendingLanding, midioAirborne: this.jump.airborne,
      discCue: this.ensemble.discCue, phase: this.ensemble.phase(1), melt: 0,
      // free: they roam their own plan rather than holding formation
      // offsets around Midio (Broshi.js, Midasus.js).
      free: true, trailX: plan.broshi.x, broshiFacing: plan.broshi.facing, broshiLook: plan.broshi.look,
      midasusX: plan.midasus.x, midasusY: plan.midasus.y, tilt: plan.midasus.tilt,
      stageW: this.w, worldSpeed: 220, epic: this.vibe.epic, midioY: this.midio.y };
    // Midio's own place on the world's ground: Broshi's spring (and a
    // burrow's hole) are measured from it.
    const midioWorldX = this.worldX + this.midio.screenX - this.originX;
    // Decided before either companion updates, so a launch animates this step.
    this.excursions.update(nowMs, dt, { vibe: this.vibe, calm: this.calm, hype: this.hype,
      energyCurves: this.energyCurves, conductor: this.conductor, midasus: this.midasus, broshi: this.broshi,
      worldX: midioWorldX, chorusText: this.chorusText, lyricSymbol: this.lyricSymbol });
    this.broshi.update(nowMs, dt, this.midio, this.energyCurves, midioWorldX,
      this.h * 625 / 720, this.calm.level, common, this.ground, this.particleMul ?? 1);
    this.broshi.groundY = this.groundAt(this.broshi.renderX);
    this.midasus.update(nowMs, dt, this.calm.level, { ...common, phase: this.ensemble.phase(2),
      x: common.midasusX, y: common.midasusY, broshiX: this.broshi.renderX, broshiY: this.broshi.groundY - this.broshi.hopY }, this.particleMul ?? 1);
    const voyage = this.midasus.voyage;
    const b = this.broshi, f = this.midasus;
    this._lookB.x = b.renderX; this._lookB.y = b.groundY - b.hopY - 30;
    this._lookF.x = f.p.x; this._lookF.y = voyage.active ? -200 : f.p.y;
    this.gaze.aim(plan, nowMs, this.midio.screenX, this.midio.groundY - this.midio.y - 40,
      b.burrow.depth > .02 ? null : this._lookB, this._lookF);
    // While she is away the ensemble feels the hole she leaves.
    this.ensemble.setPresence(2, voyage.active ? 0 : 1);
    voyage.atlasPulse = this.hype?.slam ?? 0;
    if (voyage.justLaunched) this.voyageEvents.launched = true;
    if (voyage.justLanded) this.voyageEvents.landed = true;
    const end = this.song.durationMs || 0;
    if (!this._atlasDetonated && end > 0 && nowMs >= end - ATLAS_DETONATE_LEAD_MS && voyage.atlas.length > 0) {
      this._atlasDetonated = true;
      voyage.detonateAtlas(nowMs);
    }
  }

  /** Ground height under screen x, on the ground the world draws. */
  groundAt(screenX) {
    return this.ground.heightAt(this.worldX + screenX - this.originX);
  }

  pose() {
    const m = this.midio;
    return { midioDrawX: m.screenX, midioY: m.groundY - m.y,
      scaleX: m.scaleX, scaleY: m.scaleY, leanDeg: m.leanDeg,
      worldX: this.worldX, midioX: m.screenX, originX: this.originX };
  }

  dispose() {
    if (this.disposed) return;
    this.broshi?.dispose(); this.disposed = true;
  }
}
