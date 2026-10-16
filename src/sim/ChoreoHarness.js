// A slim autoplay runner for the demo-song oracle. It steps the SAME
// character-choreography path Simulation.step uses (chart taps → jump /
// air-jump, conductor cues → disc / drop / calm, performer tricks, Broshi
// hops, Midasus disc) without building a world, so a 96-second song is a
// few hundred milliseconds of Node, not a canvas.
//
// RidgeAnchor is forced OPEN: this harness tests "did the music ask for a
// jump", not "was the far range heaved up". The mountain gate is a
// separate director with its own tests.
import { Role } from '../core/NoteEvent.js';
import { Lane, laneCounts } from '../core/Casting.js';
import { Conductor } from '../core/Conductor.js';
import { CueKind } from '../core/ConductorTrack.js';
import { ParamBus } from '../core/ParamBus.js';
import { synthesizeEnergyCurves } from '../core/EnergyCurvesSynth.js';
import { JumpController, quantizeJumpVel } from './JumpController.js';
import { EnsembleDirector } from './EnsembleDirector.js';
import { HypeDirector } from './HypeDirector.js';
import { CalmDirector } from './CalmDirector.js';
import { MidioPerformer } from './MidioPerformer.js';
import { ComboSystem } from './ComboSystem.js';
import { Broshi } from './Broshi.js';
import { Midasus } from './Midasus.js';
import { CueDirector } from './CueDirector.js';
import { PhraseTracker } from '../core/PhraseTracker.js';
import { AirJumpSequencer } from './AirJumpSequencer.js';
import { buildNoteChart } from './NoteChart.js';
import { VibeDirector } from './VibeDirector.js';

const STEP_MS = 1000 / 120;

function fakeMidio() {
  return { leanDeg: 0, scaleX: 1, scaleY: 1, y: 0, renderY: 400, screenX: 280, groundY: 540, halfWidth: 20 };
}

/**
 * @param {ReturnType<typeof import('../core/DemoSong.js').buildDemoSong>} song
 * @param {{stepMs?: number, energyCurves?: object|null}} [opts]
 */
export function runChoreo(song, { stepMs = STEP_MS, energyCurves = null } = {}) {
  const conductor = new Conductor();
  conductor.load(song);
  const energy = energyCurves || synthesizeEnergyCurves(song.timeline, song.durationMs);
  const paramBus = new ParamBus();
  const jump = new JumpController(paramBus);
  jump.setKickTimes(song.timeline.filter((e) => e.kick).map((e) => e.tMs));

  const chart = buildNoteChart(song.timeline, song.durationMs);
  const phrases = new PhraseTracker(song.barGrid, energy);
  const airSeq = new AirJumpSequencer(phrases);
  const ensemble = new EnsembleDirector(1, { stageW: 1280, stageH: 720 });
  const hype = new HypeDirector();
  const calm = new CalmDirector();
  const vibe = new VibeDirector(song.timeline);
  const performer = new MidioPerformer(1);
  const combo = new ComboSystem();
  const cues = new CueDirector(song.conductor ? song.conductor.liveCues : []);
  const midio = fakeMidio();
  const lanes = laneCounts(song.timeline);
  const midioLeadLane = lanes[Lane.MIDIO] > 0;
  const broshiBassLane = lanes[Lane.BROSHI] > 0;
  const midasusCleanLane = lanes[Lane.MIDASUS] > 0;
  const accentFilter = midioLeadLane
    ? (e) => e.lane === Lane.MIDIO
    : (e) => e.role === Role.BASS;

  const broshi = new Broshi(conductor, paramBus, {
    seed: 1,
    hopFilter: broshiBassLane ? (e) => e.lane === Lane.BROSHI : null,
  });
  const midasus = new Midasus(song.timeline, midio, {
    groundY: 540, seed: 1,
    noteFilter: midasusCleanLane ? (e) => e.lane === Lane.MIDASUS : null,
  });

  const log = {
    takeoffs: [],
    airJumps: [],
    landings: [],
    discs: [],
    drops: [],
    tricks: [],
    hops: [],
    midasusDisc: [],
    calmAt: [],
  };

  conductor.on(Role.RHYTHM, (evt) => {
    if (!evt.kick) return;
    jump.noteKickTiming(evt.tMs);
    performer.onKick(evt.tMs);
    hype.onKick(evt.vel);
  });
  // Simulation's accent-line double-jump: a lead (or bass, pre-casting)
  // onset while airborne spends one air-jump from the phrase budget.
  conductor.on('*', (evt) => {
    if (!accentFilter(evt)) return;
    if (!jump.airborne) return;
    const grant = airSeq.tryConsume(evt.tMs);
    if (!grant) return;
    const performed = jump.airJump({ tMs: evt.tMs, vel: evt.vel }, grant.boostMul * 0.8, grant);
    if (!performed) airSeq.refund();
  });

  const queue = [];
  let autoplayCursor = 0;
  let pendingDiscReason = null;
  let lastDropCount = 0;
  let lastHopY = 0;
  let lastMidasusDisc = -Infinity;

  const enqueue = (kind, tMs) => {
    let i = queue.length;
    while (i > 0 && queue[i - 1].tMs > tMs) i--;
    queue.splice(i, 0, { kind, tMs });
  };

  const endMs = song.durationMs + 200;
  for (let t = 0; t <= endMs; t += stepMs) {
    const dtSec = stepMs / 1000;
    jump.clearFrameFlags();
    combo.clearFrameFlags();
    performer.clearFrameFlags();
    cues.clearFrameFlags();

    conductor.dispatchUpTo(t);
    cues.update(t);
    for (const cue of cues.fired) {
      const strength = typeof cue.value === 'number' ? cue.value : 1;
      if (cue.kind === CueKind.DROP) {
        hype.cueDrop(t, strength);
        pendingDiscReason = 'cue';
      } else if (cue.kind === CueKind.FLOURISH) {
        // Same deferral as Simulation: ensemble.update() clears discCue, so
        // a maybeDisc here would never reach the characters.
        pendingDiscReason = 'cue';
      } else if (cue.kind === CueKind.CALM) {
        calm.cueCalm(t, strength);
      }
    }

    while (autoplayCursor < chart.notes.length && chart.notes[autoplayCursor].tMs <= t) {
      const n = chart.notes[autoplayCursor++];
      enqueue('down', n.tMs);
      enqueue('up', n.type === 'hold' ? n.endMs : n.tMs + 60);
    }

    while (queue.length && queue[0].tMs <= t) {
      const ev = queue.shift();
      if (ev.kind !== 'down') continue;
      const vel = quantizeJumpVel(0.7);
      const tapEvt = { tMs: ev.tMs, vel };
      let performed = false;
      if (jump.airborne) {
        const remaining = jump.jumpStartMs + jump.D - ev.tMs;
        if (remaining > 80) {
          const grant = airSeq.tryConsume(ev.tMs);
          if (grant) {
            performed = jump.airJump(tapEvt, grant.boostMul, grant);
            if (!performed) airSeq.refund();
          }
        }
      }
      if (!performed) {
        jump.onPlayerTap(tapEvt);
        log.takeoffs.push(ev.tMs);
      }
    }

    hype.update(t, dtSec, energy);
    if (hype.dropCount !== lastDropCount) {
      lastDropCount = hype.dropCount;
      pendingDiscReason = pendingDiscReason || 'drop';
      log.drops.push(t);
    }
    calm.update(t, dtSec, energy);
    vibe.update(t, dtSec, energy);
    ensemble.update(t, dtSec, vibe, jump.beatPeriodMs, null, hype.buildUp);
    if (pendingDiscReason) {
      ensemble.maybeDisc(t, pendingDiscReason, vibe.epic);
      pendingDiscReason = null;
    }

    jump.update(t);
    midio.y = jump.y;

    if (jump.pendingAirJump) log.airJumps.push(t);
    if (jump.pendingLanding) {
      log.landings.push(t);
      combo.onLanding(t, true);
      performer.onLanding(t, true, combo.displayM, jump.lastLaunchVel);
    }
    if (ensemble.discCue) log.discs.push({ tMs: t, reason: ensemble.lastDisc?.reason });

    performer.update(t, dtSec, midio, jump, combo, calm.level, ensemble, null);
    if (performer.trick && performer.trick.jumpStartMs === jump.jumpStartMs) {
      const already = log.tricks.length && log.tricks[log.tricks.length - 1].jumpStartMs === performer.trick.jumpStartMs;
      if (!already) log.tricks.push({ tMs: t, type: performer.trick.type, jumpStartMs: performer.trick.jumpStartMs });
    }

    broshi.update(t, dtSec, midio, energy, 0, 540, calm.level, {
      justClean: combo.justClean, justLanded: !!jump.pendingLanding,
      midioAirborne: jump.airborne, discCue: ensemble.discCue,
      trailX: midio.screenX - 180,
    }, null);
    if (broshi.hopY > 4 && lastHopY <= 4) log.hops.push(t);
    lastHopY = broshi.hopY;

    midasus.update(t, dtSec, calm.level, { justClean: combo.justClean, discCue: ensemble.discCue }, 1, null);
    if (midasus._discStartMs !== lastMidasusDisc && Number.isFinite(midasus._discStartMs) && midasus._discStartMs > 0) {
      log.midasusDisc.push(midasus._discStartMs);
      lastMidasusDisc = midasus._discStartMs;
    }

    if (calm.level > 0.7) log.calmAt.push(t);
  }

  return { log, jump, ensemble, hype, calm, performer, broshi, midasus, chart, energy };
}

export { STEP_MS };
