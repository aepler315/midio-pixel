import { resolveExperience } from '../core/Experience.js';
import { TrioPerformance } from './TrioPerformance.js';
import { cameraLensAt } from '../render/CameraLens.js';
// Listening simulation owns transport, musical context, scenery and tap calibration.
// Stage coordinates are independent of any performer or presentation backend.
import { Role } from '../core/NoteEvent.js';
import { Lane, laneCounts } from '../core/Casting.js';
import { MAX_LATENCY_MS, visualNow } from '../core/ChoreoClock.js';
import { CameraDirector, ZOOM_MIN } from '../render/CameraDirector.js';
import { CalmDirector } from './CalmDirector.js';
import { HypeDirector } from './HypeDirector.js';
import { VibeDirector } from './VibeDirector.js';
import { epicBiasForKind } from '../lyrics/SectionFusion.js';
import { BeatAnchor } from './BeatAnchor.js';
import { SongBeatTransport } from './SongBeatTransport.js';
import { KeyDirector } from './KeyDirector.js';
import { CodaDirector } from './CodaDirector.js';
import { FilmFinish } from '../render/FilmFinish.js';
import { BiomeManager } from '../world/BiomeManager.js';
import { alpineTerrainProfiles } from '../world/terrain/loadTerrain.js';
import { getWorld, resolveWorldId } from '../world/Worlds.js';
import { FractureEngine } from '../world/FractureEngine.js';
import { GroundField } from '../world/GroundField.js';
import { PerfGovernor } from '../render/PerfGovernor.js';
import { HighlightReel, highlightCandidatesFor } from '../render/HighlightReel.js';
import { hashSeed } from '../utils/math.js';
import { resolveSongSeed } from '../utils/seed.js';
import { ParallelUniverseDirector } from './ParallelUniverseDirector.js';
import { LatencyCalibrator } from './LatencyCalibrator.js';
import { SyncMonitor } from './SyncMonitor.js';
import { GrooveFingerprint } from './GrooveFingerprint.js';
import { OpeningDirector, MAX_HOLD_MS } from './OpeningDirector.js';
import { WeatherDirector } from './WeatherDirector.js';
import { OrogenyDirector } from '../world/OrogenyDirector.js';
import { QuakeDirector } from './QuakeDirector.js';
import { FireDirector } from './FireDirector.js';
import { DisasterDirector } from './DisasterDirector.js';
import { FloodDirector } from './FloodDirector.js';
import { CueDirector } from './CueDirector.js';
import { CueKind } from '../core/ConductorTrack.js';
import { compileLandscapeSources } from '../world/alpine/RangeNarrative.js';
import { resolveLandscapePresentation } from '../world/LandscapePresentation.js';

const WORLD_SPEED_PX_S = 220;

export class Simulation {
  constructor(conductor, paramBus, {
    bpm = 120, energyCurves = null, canvasWidth = 1280, canvasHeight = 720,
    customBiome = null, inputOffsetMs = 0, outputLatencyMs = null, visualLeadMs = 0, lyricSections = null, syncedLyrics = null, lyricSession = null, structure = null, tonalityTimeline = null,
    groove = null,
    songSeed: pinnedSeed = null,
    conductorCues = null,
    worldId = null,
    terrainProfiles = null,
    songTerrain = null,
    residency = null,
    chapterState = null,
    rangeListening = true,
    experience = 'landscape',
    ridgeMusicSession = null,
    // Set while the song is playing on its opening analysis only: how far
    // the timeline actually reaches (OpeningAnalysis.js asOpening).
    analyzedThroughMs = null,
  } = {}) {
    this.conductor = conductor;
    this.paramBus = paramBus;
    this.energyCurves = energyCurves;
    this.customBiome = customBiome || null;
    this.worldId = resolveWorldId(worldId);
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    this.stageW = canvasWidth;
    this.stageH = canvasHeight;
    this.bpm = bpm;

    this._outputLatencyFn = typeof outputLatencyMs === 'function' ? outputLatencyMs : null;
    this.visualLagMs = 0;

    this.visualLeadMs = Math.max(0, visualLeadMs || 0);

    const lanes = laneCounts(conductor.timeline);

    this._midasusCleanLane = lanes[Lane.MIDASUS] > 0;
    this._broshiBassLane = lanes[Lane.BROSHI] > 0;
    this._midioLeadLane = lanes[Lane.MIDIO] > 0;
    this.casting = {
      midasus: this._midasusCleanLane ? 'clean-lane' : 'melody',
      broshi: this._broshiBassLane ? 'bass-lane' : 'melody',
      midio: this._midioLeadLane ? 'lead-lane' : 'bass',
      counts: lanes,
    };
    this.rangeListening = !!rangeListening;
    this.presentation = resolveLandscapePresentation(getWorld(this.worldId));
    this.stageAnchor = { x: 220, groundY: 625 };

    // Deprecated inert pose alias; stageAnchor owns the world origin.
    this.midio = { screenX: 220, groundY: 625, renderY: 625, slipX: 0, scaleX: 1, scaleY: 1, leanDeg: 0 };

    this.beatAnchor = new BeatAnchor(60000 / bpm);
    this.songBeat = new SongBeatTransport({ ...conductor.beatMetadata, bpm: conductor.beatMetadata?.bpm ?? bpm });
    this.beatAnchor.anchorMs = this.songBeat.originMs;

    this.groove = groove || new GrooveFingerprint();

    this.recalibrating = false;

    this.opening = new OpeningDirector();
    this.kickTimes = conductor.timeline.filter(e => e.role === Role.RHYTHM && e.kick).map(e => e.tMs);
    this.camera = new CameraDirector();

    const songSeed = resolveSongSeed(conductor, pinnedSeed);
    this.songSeed = songSeed;
    this.parallelUniverse = new ParallelUniverseDirector();

    this.latency = new LatencyCalibrator(inputOffsetMs);

    this.syncMonitor = new SyncMonitor();

    this.calm = new CalmDirector();
    this.hype = new HypeDirector();
    this.weather = new WeatherDirector();

    this.cues = new CueDirector(conductorCues ? conductorCues.liveCues : []);
    this.filmFinish = new FilmFinish();
    this.vibe = new VibeDirector(conductor.timeline, tonalityTimeline);
    this.keyDirector = new KeyDirector();
    this.coda = new CodaDirector(conductor.durationMs || 0);
    this.groundField = new GroundField(this.stageAnchor.groundY, {
      conductor, durationMs: conductor.durationMs, songSeed,
    });

    this.fire = new FireDirector();
    this.flood = new FloodDirector();
    this.biomes = new BiomeManager({
      conductor, energyCurves, durationMs: conductor.durationMs,
      ridgeMusicSession,
      ridgeCasting: this.casting, ridgeCalmCues: conductorCues?.liveCues,
      canvasWidth, canvasHeight, groundY: this.stageAnchor.groundY, songSeed,
      groundField: this.groundField,
      fire: this.fire,
      flood: this.flood,
      customBiome: this.customBiome,
      lyricSections,
      syncedLyrics,
      lyricSession,
      structure,
      chapterState,
      conductorSchedule: conductorCues ? conductorCues.scheduleCues : null,
      worldId: this.worldId,

      terrainProfiles: getWorld(this.worldId)?.kind === 'alpine'
        ? (terrainProfiles || alpineTerrainProfiles()) : null,

      songTerrain: getWorld(this.worldId)?.kind === 'alpine' ? songTerrain : null,

      residency,
    });
    this.rangeNarrative = compileLandscapeSources({ durationMs: conductor.durationMs,
      timeline: conductor.timeline, casting: this.casting });
    this.reducedFlash = false;
    this.visualStyle = 'rendered';
    this.biomes.reducedFlash = this.reducedFlash;
    this.biomes.setVisualStyle(this.visualStyle);
    this.highlightReel = new HighlightReel();
    this.fracture = new FractureEngine(conductor, {
      canvasWidth, canvasHeight, songSeed, durationMs: conductor.durationMs,
      energyCurves, analyzedThroughMs,
    });

    this.orogeny = new OrogenyDirector(energyCurves, conductor.durationMs || 0, conductor.barGrid);

    this.quake = new QuakeDirector(songSeed);
    this.groundField.quake = this.quake; // render-only shake, read in visibleBars()
    this.disasters = new DisasterDirector(songSeed, conductor.durationMs || 0, [this.orogeny.climaxMs]);
    this._pendingQuakeTsunamiAtMs = -Infinity; // the linked event -- see the disasters.justStruck block in step()

    this.worldX = 0;
    this.timeMs = 0;

    this.pointer = { x: canvasWidth / 2, y: canvasHeight / 2, active: false, lastMoveMs: -Infinity };

    this.prev = this._snapshot();
    this.curr = this._snapshot();

    this._unsub = [conductor.on(Role.RHYTHM, evt => {
      if (!evt.kick) return;
      this.hype.onKick(evt.vel);
      if (!this.songBeat.freeTime) this.syncMonitor.onKick(evt.tMs, this.songBeat.snapshotAt(evt.tMs).periodMs, this.beatAnchor.anchorMs);
      this.groundField.kickGlow(this.worldX, evt.tMs, evt.vel);
    })];
    this.snowCover = 0;
    // Candidate-only song replay belongs to construction, before audio starts.
    // Draws read this immutable schedule rather than warming it on stage.
    highlightCandidatesFor(this);
    this.setExperience(experience);
  }

  setExperience(value) {
    const next = resolveExperience(value);
    if (this.experience === next) return;
    const prepared = next === 'trio' ? new TrioPerformance({ timeline: this.conductor.timeline,
      durationMs: this.conductor.durationMs, bpm: this.bpm, barGrid: this.conductor.barGrid,
      beatMetadata: this.conductor.beatMetadata, energyCurves: this.energyCurves,
      paramBus: this.paramBus, seed: this.songSeed, stageW: this.stageW, stageH: this.stageH,
      reducedFlash: this.reducedFlash, reducedMotion: this.reducedMotion, particleMul: this.perf?.particleMul ?? 1 }) : null;
    prepared?.seek(this.heardTimeMs ?? this.timeMs ?? 0);
    this.trio?.dispose(); this.trio = prepared;
    this.experience = next;
    this.presentation = resolveLandscapePresentation(getWorld(this.worldId), next);
  }

  _applyCues(nowMs) {
    for (const cue of this.cues.fired) {
      const strength = typeof cue.value === 'number' ? cue.value : 1;
      switch (cue.kind) {
        case CueKind.DROP:
          this.hype.cueDrop(nowMs, strength);
          break;
        case CueKind.KEY_CHANGE:
          this.keyDirector.forceChange(nowMs);
          break;
        case CueKind.CALM:
          this.calm.cueCalm(nowMs, strength);
          break;
        case CueKind.METEORS:
          this.biomes.cueMeteors(nowMs, strength);
          break;
        case CueKind.LIGHTNING:
          this.biomes.cueLightning(nowMs);
          break;
        case CueKind.WEATHER:
          this.weather.cueKind(nowMs, cue.value);
          break;
        case CueKind.SHAKE:
          this.camera.shake(3 + 9 * strength);
          break;
        case CueKind.GROUND_PULSE:
          this.groundField.impulse(this.worldX, strength, nowMs);
          break;
        default:
          break;
      }
    }
  }

  setPointer(x, y) {
    this.pointer.x = x;
    this.pointer.y = y;
    this.pointer.active = true;
    this.pointer.lastMoveMs = this.timeMs;
  }

  /** Tap calibration follows the heard clock without actor feedback. */
  onBeatTap(tMs, role = null) {
    this.beatAnchor.tap(tMs);

    if (this.beatAnchor.confidence >= 0.5) this.syncMonitor.onCalibrated();

    this.groove.observe({
      role,
      tMs,
      bands: this.energyCurves ? this.energyCurves.sampleAll(tMs) : null,
      energyNorm: this.energyCurves ? this.energyCurves.globalEnergyNorm(tMs) : 0,
      nearestOnsetMs: this._nearestKickMs(tMs),
    });
  }

  /** The detected onset closest to `tMs`, or null when the chart has none in
   *  reach. Feeds the fingerprint's timing offset: the gap between where the
   *  player tapped and where the song actually hit is this player's feel. */
  _nearestKickMs(tMs) {
    const kicks = this.kickTimes;
    if (!kicks || !kicks.length) return null;

    let lo = 0, hi = kicks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kicks[mid] < tMs) lo = mid + 1; else hi = mid;
    }
    let best = kicks[lo];
    if (lo > 0 && Math.abs(kicks[lo - 1] - tMs) < Math.abs(best - tMs)) best = kicks[lo - 1];
    return best;
  }

  /** Position a freshly constructed scene without replaying skipped cues or
   * notes. Seeking starts a new performance segment: score, holds and all
   * transient effects come from construction; immutable song data is kept.
   * Spatial travel starts at a new origin, rather than extrapolating today's
   * scroll speed backward over the song. */
  startAt(nowMs) {

    this.conductor.seekTo(Math.max(0, nowMs - this.visualLeadMs), { primeAhead: true });
    this.cues.seekTo(nowMs);
    this.disasters.seekTo(nowMs);

    this.biomes._lastSectionIdx = null;
    if (nowMs >= MAX_HOLD_MS) { this.opening.holding = false; this.opening.gain = 1; }

    const energy = this.energyCurves?.globalEnergyNorm(nowMs) ?? 0.3;
    this.hype.fast = energy; this.hype.slow = energy;
    this.step(0, nowMs);
    this.prev = this._snapshot();
    this.curr = this._snapshot();
  }

  /** Tear down every subscription this sim (and its owned subsystems) made
   *  on the shared conductor. Must run before the sim is discarded --
   *  conductor outlives every song, so a replay that skips this leaves the
   *  old sim's listeners firing forever, stacked on top of the new one's. */
  dispose() {
    this.trio?.dispose();
    for (const unsub of this._unsub) unsub();
    this._unsub.length = 0;
    this.biomes.dispose();
    this.fracture.dispose();
  }

  /** The Reel (Movement VI): live-toggle the reduced-flash accessibility
   *  setting, cascading to every consumer that caps its own flash alphas. */
  setReducedFlash(v) {
    this.reducedFlash = v;
    this.biomes.reducedFlash = v;
    this.fracture.reducedFlash = v;
  }

  setReducedMotion(v) {
    this.reducedMotion = !!v;
    this.biomes.reducedMotion = !!v;
  }

  syncSongBeat(nowMs) {
    const state = this.songBeat.snapshotAt(nowMs);
    this.beatAnchor.setSongBeatMs(state.periodMs, nowMs);
    if (!this.beatAnchor._history.length) this.beatAnchor.anchorMs = state.anchorMs;
    this.beatAnchor.update(nowMs);
    this.biomes.beatTransport = state;
    this.biomes._beatMs = state.periodMs;

    this.presentationBeatAnchor = {
      periodMs: this.beatAnchor.periodMs, anchorMs: this.beatAnchor.anchorMs,
      confidence: state.freeTime ? 0 : Math.max(state.confidence, this.beatAnchor.confidence),
      phaseRad: timeMs => this.beatAnchor.phaseRad(timeMs),
    };
    return state;
  }

  /** Compatibility adapter: complete scenery plus causal lane samples. */
  rangeNarrativeAt(timeMs = this.heardTimeMs ?? this.timeMs ?? 0) {
    return this.experience !== 'trio' && this.biomes?.world?.kind === 'alpine'
      ? this.rangeNarrative.sample(timeMs) : null;
  }

  setVisualStyle(v) {
    this.visualStyle = v === 'classic' ? 'classic' : 'rendered';
    this.biomes?.setVisualStyle?.(this.visualStyle);
  }

  step(dtMs, nowMs) {
    this.prev = this.curr;
    this.timeMs = nowMs;
    const dtSec = dtMs / 1000;
    if (!this.perf) this.perf = new PerfGovernor();
    this.visualLagMs = this._outputLatencyFn ? Math.min(MAX_LATENCY_MS, Math.max(0, this._outputLatencyFn() || 0)) : 0;
    this.heardTimeMs = visualNow(nowMs, this.visualLagMs);
    this.biomes.visualLagMs = this.visualLagMs;
    this.biomes.rangeNarrative = this.rangeNarrativeAt(this.heardTimeMs);
    this.syncSongBeat(this.heardTimeMs);
    this.conductor.dispatchUpTo(nowMs);
    this.cues.clearFrameFlags();
    this.cues.update(nowMs);
    this._applyCues(nowMs);
    this.calm.update(nowMs, dtSec, this.energyCurves);
    this.hype.update(nowMs, dtSec, this.energyCurves);
    this.vibe.epicBias = epicBiasForKind(this.biomes.currentKind, this.biomes.lyricIntensityEased, this.biomes.kindConfidenceEased);
    this.vibe.update(nowMs, dtSec, this.energyCurves);
    if (this.trio) {
      this.trio.update(this.heardTimeMs, { reducedFlash: this.reducedFlash, reducedMotion: this.reducedMotion, particleMul: this.perf.particleMul });
      this.worldX = this.trio.worldX;
      this.paramBus.step(); this.curr = this._snapshot(); return;
    }
    this.keyDirector.update(nowMs, dtSec, { tonic: this.vibe.tonic, tonicConfidence: this.vibe.tonicConfidence, conductor: this.conductor });
    if (this.keyDirector.justKeyChange) this.biomes.mandala.reseed(this.keyDirector.lastKeyChange.to);
    this.coda.update(nowMs);
    this.groundField.flatten = this.coda.unravel;
    this.weather.update(nowMs, dtSec, { valence: this.vibe.valence, epic: this.vibe.epic, calm: this.calm.level,
      energySlow: this.hype.slow, surge: this.hype.surge, unravel: this.coda.unravel });
    this.disasters.update(nowMs, this.worldX, { quake: this.quake, fire: this.fire, weather: this.weather,
      windAngle: this.biomes.atmosphere?.prevailingAngle() || 0 });
    this.quake.update(nowMs, dtSec, this.camera);
    this.fire.update(nowMs, dtSec);
    if (this.disasters.justStruck && this.disasters.struckKind === 'fire') this.weather.cueKind(nowMs, 'embers');
    if (this.disasters.justStruck && this.disasters.struckKind === 'quake') {
      this._pendingQuakeTsunamiAtMs = nowMs + 20000 + hashSeed(`${this.songSeed}:seaQuakeTsunami:${nowMs}`) % 20000;
    }
    if (Number.isFinite(this._pendingQuakeTsunamiAtMs) && nowMs >= this._pendingQuakeTsunamiAtMs) {
      if (this.biomes.acceptsOceanHazard()) this.biomes.armTsunami(nowMs, this.quake.epicenterWorldX >= this.worldX ? 1 : -1);
      this._pendingQuakeTsunamiAtMs = -Infinity;
    }
    this.syncMonitor.update(nowMs, { beatPeriodMs: this.beatAnchor.periodMs, anchorConfidence: this.beatAnchor.confidence,
      suppress: this.recalibrating || this.songBeat.freeTime || this.songBeat.confidence < .2 });
    this.syncMonitor.consumeCorrection();
    if (this.biomes.sectionJustChanged) this.parallelUniverse.shift(`${this.songSeed}:${this.biomes._lastSectionIdx}`);
    this.parallelUniverse.update(dtSec);
    this.groundField.update(nowMs, dtSec, this.worldX, this.energyCurves, this.calm.level, this.heardTimeMs);
    this.stageAnchor.groundY = this.groundField.heightAt(this.worldX);
    this.midio.groundY = this.midio.renderY = this.stageAnchor.groundY;
    this.worldX += WORLD_SPEED_PX_S * this.paramBus.live.scrollSpeed * dtSec;
    this.opening.update(nowMs, dtSec, this.energyCurves);
    Object.assign(this.biomes, {
      openingGain: 1, focusMul: 1, stillnessMul: 1,
      hypeBoost: 1 + .6 * this.hype.surge, heatShimmer: this.hype.fast,
      paletteRotation: this.keyDirector.paletteRotation,
      tonic: this.vibe.tonicConfidence >= .15 ? this.keyDirector.tonic : null,
      dropAtMs: this.hype.dropAtMs, unravel: this.coda.unravel,
      particleMul: this.perf.particleMul,

      fever: this.energyCurves?.globalEnergyNorm(this.heardTimeMs) ?? 0,
      midioX: this.stageAnchor.x, midioY: this.stageAnchor.groundY,
      weatherState: this.weather.state, dustLevel01: this.quake.dustLevel01, smokeLevel01: this.fire.smokeLevel01,
      universeHueDeg: this.parallelUniverse.hueDeg, universeHazeMul: this.parallelUniverse.hazeMul,
      universeWindMul: this.parallelUniverse.windMul, universeTerrainMul: this.parallelUniverse.terrainMul,
      floatTilt: this.camera.floatTilt, pullback01: (1 - this.camera.zoom) / (1 - ZOOM_MIN),
    });
    this.snowCover = Math.max(this.weather.groundCover, this.biomes.currentParticleKind?.() === 'snow' ? .8 : 0, this.biomes.floodFooting01());
    this.biomes.snowCover = this.snowCover;
    this.biomes.adoptPerf(this.perf);
    this.biomes.update(nowMs, dtSec, this.energyCurves, this.calm.level, this.worldX);
    this.biomes.pumpStripPrewarm();
    this.flood.update(nowMs, dtSec, { rainAccum01: this.weather.rainAccum01 });
    this.filmFinish.update(nowMs, dtSec, this.calm.level, this.biomes.budget, this.hype);
    this.fracture.update(nowMs, dtSec, this.energyCurves, this.camera);
    if (this.fracture.justEnteredFinale) this.filmFinish.hit('finale');
    this.orogeny.update(nowMs);
    this.biomes.orogenyGrowth = this.orogeny.growth;
    const period = Math.max(1, this.beatAnchor.periodMs);
    const tau = ((this.heardTimeMs - this.beatAnchor.anchorMs) % period + period) % period;
    this.camera.update(dtSec, this.calm.level, this.reducedFlash || this.reducedMotion, tau,
      this.songBeat.freeTime ? 0 : Math.max(this.vibe.epic, this.hype.surge), cameraLensAt({ sections: this.biomes.sections, timeMs: this.heardTimeMs, durationMs: this.biomes.durationMs, reducedMotion: this.reducedFlash || this.reducedMotion }).zoomPulse);
    this.paramBus.step();
    this.curr = this._snapshot();
  }

  _snapshot() {
    return {
      worldX: this.worldX,
      midioY: this.stageAnchor.groundY,
      slipX: this.midio.slipX || 0,
      scaleX: this.midio.scaleX,
      scaleY: this.midio.scaleY,
      leanDeg: this.midio.leanDeg,
    };
  }

  /** alpha in [0,1] — blend between the last two sim states for a jitter-free render. */
  lerpState(alpha) {
    const p = this.prev, c = this.curr;
    const lerp = (a, b) => a + (b - a) * alpha;
    return {

      worldX: lerp(p.worldX, c.worldX),
      originX: this.stageAnchor.x,
      midioX: this.stageAnchor.x,
      midioDrawX: this.stageAnchor.x + lerp(p.slipX ?? 0, c.slipX ?? 0),
      midioY: lerp(p.midioY, c.midioY),
      scaleX: lerp(p.scaleX, c.scaleX),
      scaleY: lerp(p.scaleY, c.scaleY),
      leanDeg: lerp(p.leanDeg, c.leanDeg),
      airborne: false,
    };
  }
}
