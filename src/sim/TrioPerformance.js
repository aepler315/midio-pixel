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
import { GroundField } from '../world/GroundField.js';

const STEP = 1000 / 120;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Performer consumes this legacy scalar to choose its trick repertoire;
// there is no judge, points, streak, health or artificial perfect-tap feed.
const PERFORMANCE = Object.freeze({ displayM: 1 });

export class TrioPerformance {
  constructor({ timeline = [], durationMs = 0, bpm = 120, barGrid = [], beatMetadata = null,
    energyCurves = null, paramBus, seed = 315, stageW = 1280, stageH = 720,
    reducedFlash = false, reducedMotion = false, particleMul = 1 } = {}) {
    this.song = { timeline, durationMs, bpm, barGrid, ...beatMetadata };
    this.energyCurves = energyCurves;
    this.paramBus = paramBus;
    this.seed = seed; this.w = stageW; this.h = stageH;
    this.kicks = timeline.filter(e => e.role === 'RHYTHM' && e.kick && e.vel >= .2);
    this.leads = timeline.filter(e => e.lane === Lane.MIDIO && e.vel >= .65 && (e.pitchConfidence == null || e.pitchConfidence >= .5));
    this.motionEvents = [...this.kicks.map(event => ({ kind: 'kick', event })), ...this.leads.map(event => ({ kind: 'lead', event }))]
      .sort((a, b) => a.event.tMs - b.event.tMs || (a.kind === 'kick' ? -1 : 1));
    this.reducedFlash = !!reducedFlash; this.reducedMotion = !!reducedMotion;
    this.particleMul = particleMul;
    this.disposed = false;
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
    this.ground = new GroundField(this.midio.groundY, { conductor: this.conductor, durationMs: this.song.durationMs, songSeed: this.seed });
    const bassLane = this.song.timeline.some(e => e.lane === Lane.BROSHI);
    const melodyLane = this.song.timeline.some(e => e.lane === Lane.MIDASUS);
    this.broshi = new Broshi(this.conductor, this.paramBus, { seed: this.seed + 1,
      hopFilter: e => bassLane ? e.lane === Lane.BROSHI : e.role === 'BASS' });
    this.midasus = new Midasus(this.song.timeline, this.midio, { seed: this.seed + 2,
      stageW: this.w, stageH: this.h, groundY: this.midio.groundY, ceilingY: 70,
      noteFilter: e => (melodyLane ? e.lane === Lane.MIDASUS : e.role === 'MELODY')
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

  update(timeMs, { reducedFlash = false, reducedMotion = false, particleMul = 1 } = {}) {
    if (this.disposed) return;
    this.reducedFlash = reducedFlash; this.reducedMotion = reducedMotion; this.particleMul = particleMul;
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
        this.jump.onKick(event); if (notify) this.performer.onKick(event.tMs);
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
    if (!this.reducedMotion && energy - oldEnergy > .25 && nowMs - this.lastFlourishMs > 16000) {
      this.ensemble.maybeDisc(nowMs, 'drop', Math.max(.6, this.vibe.epic));
      this.lastFlourishMs = nowMs;
    }
    this.ground.update(nowMs, dt, this.worldX, this.energyCurves, this.calm.level, nowMs);
    this.midio.screenX = clamp(this.ensemble.anchors[0].x, this.w * .25, this.w * .55);
    this.midio.groundY = this.ground.heightAt(this.worldX);
    this.midio.y = this.jump.y;
    this.midio.leanDeg = 0; this.midio.scaleX = this.midio.scaleY = 1;
    if (this.jump.pendingLanding) this.performer.onLanding(nowMs, false, 1, this.jump.lastLaunchVel);
    this.performer.update(nowMs, dt, this.midio, this.jump, PERFORMANCE, this.calm.level, this.ensemble);
    const common = { justClean: false, justLanded: !!this.jump.pendingLanding, midioAirborne: this.jump.airborne,
      discCue: this.ensemble.discCue, phase: this.ensemble.phase(1), melt: 0,
      trailX: clamp(this.ensemble.anchors[1].x, this.midio.screenX + 130, this.w - 100),
      midasusX: this.ensemble.anchors[2].x, midasusY: this.ensemble.anchors[2].y,
      stageW: this.w, worldSpeed: 220, epic: this.vibe.epic, midioY: this.midio.y };
    this.broshi.reducedFlash = !!this.reducedFlash;
    this.midasus.reducedFlash = !!this.reducedFlash;
    this.broshi.update(nowMs, dt, this.midio, this.energyCurves, this.worldX,
      this.h * 625 / 720, this.calm.level, common, this.ground, this.particleMul ?? 1);
    this.broshi.groundY = this.ground.heightAt(this.worldX + this.broshi.renderX - this.midio.screenX);
    this.midasus.update(nowMs, dt, this.calm.level, { ...common, phase: this.ensemble.phase(2),
      x: common.midasusX, y: common.midasusY, broshiX: this.broshi.renderX, broshiY: this.broshi.groundY - this.broshi.hopY }, this.particleMul ?? 1);
  }

  pose() {
    const m = this.midio, motion = this.reducedMotion ? .35 : 1;
    return { midioDrawX: m.screenX, midioY: m.groundY - m.y * motion,
      scaleX: m.scaleX, scaleY: m.scaleY, leanDeg: m.leanDeg * motion,
      worldX: this.worldX, midioX: m.screenX };
  }

  dispose() {
    if (this.disposed) return;
    this.broshi?.dispose(); this.disposed = true;
  }
}
