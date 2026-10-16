import { cameraLensAt } from '../../render/CameraLens.js';
import { stormAt } from './RangeStorm.js';
import { resolveRangeComposition } from './RangeComposition.js';
import { sampleHorizonRidge, sampleSpaceRidge } from './RidgeMotion.js';
import { ridgeAdvectionPxAt } from '../RidgeMotionHistory.js';
// Range v2: the one presentation adapter allowed to read the simulation
// (plan §7.2). It assembles an immutable RangeFrame -- time, assigned
// views, rail progress, viewports, light, music, support bars and emitters
// -- before anything draws, so GPU/material/forest/water modules never
// reach back into mutable state and the same instant always yields the
// same snapshot (forward seek, backward seek, pause, repeated draws).
import { hashSeed, smoothstep } from '../../utils/math.js';
import { scenePoseAt, focalPx, sceneProgressAt, SCENE_PREVIEW_PROGRESS } from '../terrain/SceneTravel.js';
import { sampleWorldMusic, boundaryLift01 } from '../WorldMusic.js';
import { ridgeEnvelope } from './Ridge.js';
import { ridgeKickEnv } from '../MountainChoreo.js';
import { GUST_FRONTS, GUST_IDLE_SEC } from './Gust.js';
import { sectionIndexAt } from '../BiomeSchedule.js';
import { resolveCelestialState } from '../CelestialState.js';
import { computeLight } from '../../render/LightField.js';
import { convertLightBetween } from './LightSpace.js';
import { recentConductorHits } from './GroundResponse.js';
import { glacierStateAt } from './GlacierField.js';
import { profileTravelPx } from '../terrain/ProfileTravel.js';
import { styleDials } from '../../render/VisualStyle.js';
import { cloudSeaAt } from './CloudSea.js';
import { rangeActorsAt } from './RangeActors.js';
import { rangeCameraMoveAt, rangeUserCamera } from './RangeCamera.js';
import { hexLerp } from '../../utils/color.js';

const NIGHT_SKY = '#05060d';

function freezeDeep(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freezeDeep(v);
  }
  return o;
}

/** A viewport's logical size, backing size, overscan and the six-number
 *  Canvas affine transform (a, b, c, d, e, f) in effect when it is drawn. */
export function viewportState({ logicalWidth, logicalHeight, backingWidth, backingHeight, overscanPx = 0,
  transform = [1, 0, 0, 1, 0, 0], nominalWidth = logicalWidth, nominalHeight = logicalHeight, pixelRatio = 1, presentationOffsetY = 0 }) {
  return { logicalWidth, logicalHeight, backingWidth, backingHeight, overscanPx, transform: [...transform], nominalWidth, nominalHeight, pixelRatio, presentationOffsetY };
}

/** Shared source-space field. receiver=0 pins hydro receivers and shores. */
export function sceneDeformation(music, x, z, y, heightRange, receiver = 1) {
  if (!music) return 0;
  const span = Math.max(1, heightRange[1] - heightRange[0]);
  const h = Math.min(1, Math.max(0, (y - heightRange[0]) / span));
  const along = x * music.waveDir[0] + z * music.waveDir[1];
  const across = x * music.melodyDir[0] + z * music.melodyDir[1];
  const swell = Math.sin(along * music.waveK - music.phaseRad);
  const melody = Math.sin(across * music.melodyK - music.melodyPhaseRad);
  return Math.min(1, Math.max(0, receiver)) * h * h * (
    music.amplitudeM * swell + music.kickM + music.structuralM
    + music.melodicM * melody + h * h * music.gestureM);
}

const unit = v => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;

/** Indexed causal melody read: never depends on conductor dispatch or replay.
 * Geometry uses authored pitches at full authority and recording estimates at
 * their measured confidence (unqualified recording estimates have weak weight).
 * Bounded durations prevent an inferred note from moving the whole song. */
export function sampleRangeMelody(timeline = [], timeMs = 0) {
  let lo = 0, hi = timeline.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (timeline[mid].tMs <= timeMs) lo = mid + 1; else hi = mid; }
  let activity = 0, pitch = 0, pan = 0;
  for (let i = lo - 1; i >= 0 && timeMs - timeline[i].tMs <= 4000; i--) {
    const e = timeline[i];
    if (e.role !== 'MELODY' || !Number.isFinite(e.pitch) || e.pitchProvenance === 'synthetic') continue;
    const age = timeMs - e.tMs, duration = Math.min(4000, Math.max(90, e.durMs || 90));
    if (age >= duration) continue;
    const confidence = e.src === 'midi' ? 1 : unit(e.pitchConfidence ?? .25)
      * (e.pitchProvenance === 'tracked' ? 1 : .25);
    const weight = unit(e.vel) * confidence * Math.min(1, age / 40) * Math.min(1, (duration - age) / 120);
    activity += weight;
    pitch += weight * unit((e.pitch - 36) / 60);
    pan += weight * Math.min(1, Math.max(-1, e.pan || 0));
  }
  return { activity: unit(activity), pitch01: activity ? pitch / activity : .5, pan: activity ? pan / activity : 0 };
}

/** Repeated sections retain a recognizable recipe inside the same geography.
 * A boundary eases between recipes; only label/variant evidence selects them.
 * Decorative subdivisions with their parent's label leave the recipe intact. */
export function rangeSectionMotif(section, previous, timeMs, seed = 0) {
  const recipe = s => {
    const id = s?.motifId ?? (s?.label != null ? `section:${s.label}` : 'home');
    const h = hashSeed(`${seed}:${id}`) / 4294967296;
    return { id, angle: (h - .5) * .9, hueDeg: h * 360,
      heightMul: s?.variant?.heightMul ?? s?.heightMul ?? 1,
      snowLine01: s?.variant?.snowLine01 ?? s?.snowLine01 ?? 1 };
  };
  const current = recipe(section), prior = recipe(previous || section);
  const t = unit((timeMs - (section?.startMs ?? 0)) / 4000);
  const ease = t * t * (3 - 2 * t);
  const hueDelta = ((current.hueDeg - prior.hueDeg + 540) % 360) - 180;
  return { ...current, angle: prior.angle + (current.angle - prior.angle) * ease,
    hueDeg: (prior.hueDeg + hueDelta * ease + 360) % 360,
    intensity01: .04 + .07 * unit(section?.relEnergy01) };
}

/** Independent slow pressure, rhythmic lift, summit gesture, melodic tilt and
 * standing section growth. Time is always heard time, never integrated.
 * Reduced flash belongs to lighting; reduced motion suppresses geometry.
 * `gustFronts` are the kicks' fronts in flight, newest first:
 * { ageMs, amp, dir } with dir the front's way across the frame (+-1). */
export function rangeMusicState({ env = null, tSec = 0, kickAgeMs = Infinity, kickAmp = 0,
  gustFronts = [], melody = null, structural01 = 0, motif = null, reducedMotion = false, evaluatedKick01 = null, activity01 = null,
  motionPresence01 = null, calibrationActivity01 = null } = {}) {
  const groove = unit(env?.groove), sustain = unit(env?.sustain);
  const scaleMul = Math.min(1.3, Math.max(1, env?.scaleMul ?? 1));
  const kickMul = unit(env?.kickMul);
  const gesture = unit(env?.gesture);
  const kick01 = evaluatedKick01 == null ? (Number.isFinite(kickAgeMs) ? ridgeKickEnv(kickAgeMs) * unit(kickAmp) : 0) : unit(evaluatedKick01);
  const activity = unit(activity01 ?? Math.max(groove, sustain, kick01, unit(melody?.activity)));
  const presence = unit(motionPresence01 ?? (activity > 0 ? 1 : 0));
  const motion = reducedMotion ? 0 : presence;
  const pan = Math.min(1, Math.max(-1, melody?.pan || 0));
  const pitch01 = unit(melody?.pitch01 ?? .5);
  const angle = Math.atan2(-.6, .8) + (motif?.angle || 0);
  const state = {
    groove, sustain, scaleMul, kickMul, gesture, kick01, activity01: activity,
    motionPresence01: presence, calibrationActivity01: unit(calibrationActivity01 ?? activity),
    amplitudeM: (3 + 8 * groove + 28 * sustain) * scaleMul * motion,
    // Dense music retains a readable accent instead of the old .18 floor.
    kickM: 18 * kick01 * (.55 + .45 * kickMul) * motion,
    gestureM: 12 * gesture * motion,
    melodicM: 14 * unit(melody?.activity) * (.4 + .6 * pitch01) * motion,
    structuralM: 12 * unit(structural01) * motion,
    waveK: (2 * Math.PI) / 4800, waveDir: [Math.cos(angle), Math.sin(angle)],
    phaseRad: 2 * Math.PI * .045 * tSec,
    melodyK: (2 * Math.PI) / (2400 + 2400 * pitch01),
    melodyDir: [Math.cos(pan * .7 + .9), Math.sin(pan * .7 + .9)],
    melodyPhaseRad: 2 * Math.PI * (.065 + .045 * pitch01) * tSec,
    // Gust fronts across the forest, a fixed number of slots; ages are
    // heard time since each front's kick, empty slots idle.
    gusts: Array.from({ length: GUST_FRONTS }, (_, i) => {
      const f = gustFronts[i];
      const live = f && Number.isFinite(f.ageMs) && f.ageMs >= 0;
      return { ageSec: live ? f.ageMs / 1000 : GUST_IDLE_SEC,
        amp01: live ? unit(f.amp) * (.55 + .45 * kickMul) * motion : 0, dir: f?.dir < 0 ? -1 : 1 };
    }),
  };
  state.totalBoundM = state.amplitudeM + state.kickM + state.gestureM + state.melodicM + state.structuralM;
  return state;
}

/** The land moves only at the song's big moments (Ashton, 2026-10-02:
 *  constant heaving with every kick and phrase read as accidental). At a
 *  section change the range swells over `riseMs`, holds, and settles over
 *  `settleMs`; a lift into a louder section swells fully, any other change
 *  by `changeFloor`, a repeat of the same part not at all. Metres are
 *  before view calibration (RANGE_MOTION_REFERENCE_M is the reference). */
export const LAND_SWELL = Object.freeze({ riseMs: 3000, holdMs: 2000, settleMs: 9000, changeFloor: 0.35,
  waveM: 50, liftM: 40, waveHz: 0.012 });

const partOf = (s) => s?.motifId ?? s?.label ?? null;

/** How far the land is into a swell at `timeMs` (0 still .. 1 a full
 *  lift), from the section boundaries alone: pure in heard time.
 *  `history` ({ sections, throughMs }) is the section list the show was
 *  playing on before a live re-analysis replaced it: boundaries before
 *  `throughMs` are the ones already heard on it, so a swell under way
 *  carries on and a boundary the new list adds in the past starts none.
 *  `rejoinMs` is where the rebuilt show actually rejoined the music: a
 *  boundary crossed while it was being built (never drawn) starts none. */
export function landMoment01(sections, timeMs, history = null) {
  const has = Array.isArray(history?.sections) && Number.isFinite(history.throughMs);
  const through = has ? history.throughMs : -Infinity;
  const rejoin = has ? Math.max(through, Number.isFinite(history.rejoinMs) ? history.rejoinMs : through) : -Infinity;
  return Math.max(swellOf(history?.sections, timeMs, -Infinity, through), swellOf(sections, timeMs, rejoin, Infinity));
}

function swellOf(sections, timeMs, fromMs, toMs) {
  if (!Array.isArray(sections)) return 0;
  const { riseMs, holdMs, settleMs, changeFloor } = LAND_SWELL;
  const span = riseMs + holdMs + settleMs;
  let best = 0;
  for (let i = sections.length - 1; i >= 1; i--) {
    const start = sections[i]?.startMs ?? Infinity;
    const age = timeMs - start;
    if (age < 0 || start < fromMs || start >= toMs) continue;
    if (age >= span) break;
    const sec = sections[i], prev = sections[i - 1];
    // A decorative cut only paces the schedule (no musical event), and a
    // repeat of the same part never swells, louder or not -- unless the
    // song's author cued the change, which always counts.
    if (sec?.provenance === 'decorative') continue;
    if (sec?.provenance !== 'authored' && partOf(sec) != null && partOf(sec) === partOf(prev)) continue;
    const strength = Math.max(changeFloor, boundaryLift01(sec, prev));
    const env = smoothstep(0, riseMs, age) * (1 - smoothstep(riseMs + holdMs, span, age));
    best = Math.max(best, strength * env);
  }
  return best;
}

/** The land's geometry for a frame: the rhythmic, melodic and gesture
 *  channels are kept as `source` (for evidence and the water) but move
 *  nothing; only the moment's slow swell and lift do, at a fixed target
 *  size, so the land is still between moments. The swell runs one way for
 *  the whole song (from `seed`, not the section), so neither a section
 *  change nor a re-analysis can turn it mid-swell. */
export function landWaveDir(seed = 0) {
  const angle = Math.atan2(-.6, .8) + (hashSeed(`${seed}:land`) / 4294967296 - .5) * .9;
  return [Math.cos(angle), Math.sin(angle)];
}

export function landMotion(music, moment01, { tSec = 0, reducedMotion = false, seed = 0 } = {}) {
  const m = reducedMotion ? 0 : unit(moment01);
  const out = { ...music, source: music, landMoment01: m, waveDir: landWaveDir(seed),
    amplitudeM: LAND_SWELL.waveM * m,
    kickM: 0, gestureM: 0, melodicM: 0, structuralM: LAND_SWELL.liftM * m,
    phaseRad: 2 * Math.PI * LAND_SWELL.waveHz * tSec, calibrationActivity01: 1 };
  out.totalBoundM = out.amplitudeM + out.structuralM;
  return out;
}

export const RANGE_MOTION_REFERENCE_M = 106.7;

/** The kicks' fronts in flight at `timeMs`, newest first. Each keeps the
 *  way across the frame its section's motif leaned when its kick landed,
 *  so a section change never turns a front around mid-flight. */
export function gustFrontsAt(mgr, timeMs, seed = 0) {
  return (mgr._gustFronts || []).map((f) => {
    const i = sectionIndexAt(mgr.sections, f.tMs);
    const motif = i >= 0 ? rangeSectionMotif(mgr.sections[i], mgr.sections[i - 1], f.tMs, seed) : null;
    return { ageMs: timeMs - f.tMs, amp: f.amp, dir: (motif?.angle || 0) < 0 ? -1 : 1 };
  });
}

/** Calibrate the whole field once per geographic view. Nominal viewport
 * preserves motion across DPR/overscan. Geological caps win when a distant
 * view cannot safely attain the activity-dependent projected budget. */
export function calibrateRangeMusic(music, { view = null, progress01 = .5, depthM = null,
  fovYDeg = view?.camera?.fovYDeg ?? 40, nominalHeight = 720, heightRange = [0, 2000] } = {}) {
  if (view && !(depthM > 0)) { const pose = scenePoseAt(view, { progress01 }); depthM = Math.hypot(...pose.eyeM.map((v, i) => v - pose.targetM[i])); }
  const metresPerPixel = Math.max(1, depthM || 10000) / focalPx(fovYDeg, nominalHeight);
  const cap = Math.min(180, Math.max(0, heightRange[1] - heightRange[0]) * .065);
  const targetPx = 8 + 12 * smoothstep(.25, .90, unit(music.calibrationActivity01 ?? music.activity01));
  const gain = Math.min(targetPx * metresPerPixel / RANGE_MOTION_REFERENCE_M, cap / RANGE_MOTION_REFERENCE_M);
  const m = { ...music };
  for (const k of ['amplitudeM', 'kickM', 'gestureM', 'melodicM', 'structuralM']) m[k] *= gain;
  m.totalBoundM = music.totalBoundM * gain;
  m.targetPx = targetPx;
  m.calibrationGain = gain;
  m.projectedBoundPx = m.totalBoundM / metresPerPixel;
  return m;
}

/** Clear daylight sky the Range opens toward at midday, and how far. */
export const RANGE_DAYLIGHT = Object.freeze({ top: '#3a6fb8', mid: '#78a8d8', horizon: '#b4cde0' });
export const RANGE_DAYLIGHT_MIX = 0.6;
/** How far a moonless night pulls every sky stop (and the air) toward space. */
export const RANGE_MOONLESS_PULL = 0.85;

/** Sky colours the scene's atmosphere must agree with (same stops and
 *  night pull as BiomeManager._drawSky's three-stop case). */
export function rangeSkyState(mgr, A, B, t, night, narrative = null) {
  // A moonless night (before dawn, after sunset) pulls nearly to space.
  // The horizon (and the air with it) goes dark too, not only the zenith.
  const darkness = mgr.celestialState?.darkness01 ?? 0;
  const pull = 0.62 * night + (styleDials(mgr.visualStyle).spaceWash ? .14 : 0);
  const stop = (i, k) => {
    const c = mgr._rotated(mgr.lerpCache.get(A.sky[i], B.sky[i], t));
    const amount = Math.min(0.97, pull * k + RANGE_MOONLESS_PULL * darkness);
    return amount > 0.02 ? mgr.lerpCache.get(c, NIGHT_SKY, amount) : c;
  };
  if (!narrative) return { top: stop(0, 1), mid: stop(1, .75), horizon: stop(2, .45), air: mgr._airColor || stop(2, .45) };
  const dark = narrative.skyDark;
  let top = mgr.lerpCache.get('#fff3db', stop(0, 1), dark);
  let mid = mgr.lerpCache.get('#f8e5ca', stop(1, .75), dark);
  let horizon = mgr.lerpCache.get('#eed7ba', stop(2, .45), dark);
  // Daylight: with the sun high the sky opens toward clear blue, so the
  // song's day reads as day between its dawn and its dusk.
  const sunAlt = mgr.celestialState?.sun?.altitude01 ?? 0;
  const day = (1 - night) * smoothstep(0.12, 0.6, sunAlt) * RANGE_DAYLIGHT_MIX;
  if (day > 0.01) {
    top = hexLerp(top, RANGE_DAYLIGHT.top, day);
    mid = hexLerp(mid, RANGE_DAYLIGHT.mid, day);
    horizon = hexLerp(horizon, RANGE_DAYLIGHT.horizon, day);
  }
  // Sunrise and sunset colour the whole sky, horizon most, and the air
  // with it, so distant ranges glow in the same light.
  const tw = mgr._twilight;
  if (tw?.amount01 > 0.01) {
    const a = tw.amount01;
    top = hexLerp(top, tw.colors.top, 0.35 * a);
    mid = hexLerp(mid, tw.colors.mid, 0.6 * a);
    horizon = hexLerp(horizon, tw.colors.horizon, 0.8 * a);
  }
  return { top, mid, horizon, air: horizon };
}

/**
 * Assemble the frame snapshot.
 *   frameId, generation   renderer frame counter and load generation
 *   sim                   the Simulation (read here and nowhere else)
 *   pose                  sim.lerpState(alpha) for this frame
 *   scenicViewport, groundViewport   viewportState() records
 *   sceneAssignments      Map biome -> SceneChoice (song terrain)
 *   forcedView            optional diagnostic SceneChoice for every biome
 */
export function buildRangeFrame({
  frameId, generation = 0, sim, pose, scenicViewport, groundViewport, sceneAssignments = null, forcedView = null, renderedViews = null,
}) {
  const mgr = sim.biomes;
  const blend = mgr.currentBlend || { from: mgr.sections?.[0]?.profile, to: mgr.sections?.[0]?.profile, t: 1 };
  const nameOf = (p) => (typeof p === 'string' ? p : p?.name ?? null);
  const biomeFrom = nameOf(blend.from), biomeTo = nameOf(blend.to);
  const choice = (b) => forcedView || sceneAssignments?.get?.(b) || null;
  const timeMs = sim.heardTimeMs ?? (mgr.tSec || 0) * 1000;
  const narrative = sim.rangeNarrativeAt?.(timeMs) || null;
  const reducedFlash = !!mgr.reducedFlash;
  const reducedMotion = !!(sim.reducedMotion || mgr.reducedMotion);
  const progress01 = mgr.terrainPreview ? SCENE_PREVIEW_PROGRESS : sceneProgressAt({
    timeMs, curves: mgr.energyCurves, durationMs: mgr.durationMs, reducedFlash: reducedMotion, response: mgr.world?.response,
  });
  const durationSec = (mgr.durationMs || 0) / 1000;
  // Normalize the integrated journey separately from the old strip's
  // opening station. The glacier always begins at its southern terminus.
  const totalTravel = durationSec > 0 ? profileTravelPx(durationSec, mgr.energyCurves, false, mgr.world?.response) : 0;
  const glacier = glacierStateAt({ timeMs, durationMs: mgr.terrainPreview ? 0 : mgr.durationMs,
    progress01: totalTravel > 0 ? profileTravelPx(timeMs / 1000, mgr.energyCurves, false, mgr.world?.response) / totalTravel : undefined });
  // Production always resolves before beginScenic; a pure fallback supports
  // standalone frame consumers without a BiomeManager paint pass.
  const state = mgr.celestialState || resolveCelestialState({ timeMs, cycleMs: mgr._dayNightCycleMs,
    viewport: { width: scenicViewport?.logicalWidth || 1280, height: scenicViewport?.logicalHeight || 720 },
    approach: { progress01: mgr._progress || 0 }, reducedMotion });
  const A = mgr._profile(blend.from), B = mgr._profile(blend.to);
  const t = blend.t ?? 1;
  const light = mgr._scenicLight || computeLight({ canvasWidth: scenicViewport?.logicalWidth || 1280,
    canvasHeight: scenicViewport?.logicalHeight || 720, celestialState: state });
  const active = state[state.activeBody] || state.sun;
  const lens = cameraLensAt({ sections: mgr.sections, timeMs, durationMs: mgr.durationMs, reducedMotion: reducedMotion || reducedFlash, preview: mgr.terrainPreview });
  const skyScale = mgr.rangePresentation?.tourMode ? 1 : lens.halfAngleScale;
  const celestial = skyScale === 1 ? active : { ...active, xFrac: .5 + ((active.xFrac ?? .5) - .5) / skyScale,
    yFrac: .5 + ((active.yFrac ?? .5) - .5) / skyScale };
  const lightState = {
    space: 'scenic-stage logical px; ground anchor converted through recorded view transforms',
    state, celestial: { ...celestial, body: state.activeBody, intensity: light.intensity },
    ground: mgr._groundLight || convertLightBetween(light, scenicViewport?.transform, groundViewport?.transform),
    ambientMultiplier: state.ambientMultiplier,
    night01: state.night01, dawn01: state.dawn01 || 0, dusk01: state.dusk01 || 0,
    sky: A && B ? rangeSkyState(mgr, A, B, t, state.night01, narrative) : null,
  };
  const section = mgr.sections?.[mgr._lastSectionIdx];
  const prior = mgr.sections?.[mgr._lastSectionIdx - 1];
  // The luminous ridge keeps its own flash policy. Terrain derives the same
  // musical channels without turning reduced-flash into reduced-motion.
  const sampled = sampleWorldMusic({ nowMs: timeMs, energyCurves: mgr.energyCurves,
    rhythm: mgr.worldRhythm, section, response: mgr.world?.response });
  const ridgeSample = mgr.ridgeMusicSession?.sample(timeMs);
  if (ridgeSample) {
    sampled.energy = ridgeSample.pressureEnergy01;
    sampled.bass = ridgeSample.bassPressure01;
    sampled.accent = ridgeSample.rhythmAccent01;
  }
  const env = ridgeEnvelope({ energy: sampled.energy, bass: sampled.bass, accent: sampled.accent,
    reveal: sampled.reveal, lift: boundaryLift01(section, prior) });
  const motif = rangeSectionMotif(section, prior, timeMs, sim.songSeed ?? 0);
  const music = rangeMusicState({
    env, tSec: timeMs / 1000, evaluatedKick01: ridgeSample?.kick01, kickAgeMs: timeMs - (mgr._danceKickMs ?? -Infinity), kickAmp: mgr._danceKickAmp || 0,
    gustFronts: gustFrontsAt(mgr, timeMs, sim.songSeed ?? 0),
    melody: ridgeSample ? ridgeSample.motionMelody : narrative ? { activity: narrative.sources.midio.pitchActivity,
      pitch01: narrative.sources.midio.pitch01 } : sampleRangeMelody(mgr.conductor?.timeline || sim.conductor?.timeline || [], timeMs),
    structural01: section?.provenance === 'detected'
      ? unit(section.relEnergy01) * unit((timeMs - section.startMs) / 4000) : 0,
    reducedMotion, motif, activity01: ridgeSample?.activity01 ?? sampled.energy,
    motionPresence01: ridgeSample?.motionPresence01, calibrationActivity01: ridgeSample?.pressureEnergy01,
  });
  const land = landMotion(music, landMoment01(mgr.sections, timeMs, mgr._landHistory),
    { tSec: timeMs / 1000, reducedMotion, seed: sim.songSeed ?? 0 });
  const ridgeViewport = { width: sim.stageW || 1280, height: sim.stageH || 720 };
  const ridges = mgr._frameRidges || (mgr.ridgeMusicSession && mgr.spaceRidge ? {
    stateKey: mgr.ridgeMusicSession.stateKey,
    dance: sampleHorizonRidge({ viewport: ridgeViewport, crest: mgr._horizonCrest,
      songP: mgr.durationMs > 0 ? unit(timeMs / mgr.durationMs) : 0, advectionPx: ridgeAdvectionPxAt(timeMs, reducedMotion),
      heardTimeMs: timeMs, history: mgr.ridgeMusicSession, tuning: mgr._horizonTuning, reducedMotion }),
    space: sampleSpaceRidge({ viewport: ridgeViewport, seededGeometry: mgr.spaceRidge,
      heardTimeMs: timeMs, history: mgr.ridgeMusicSession, reducedMotion }),
  } : null);
  // Support curve exactly as the ground painter receives it (render-only
  // ripple/groove/quake included); physics heightAt() is not consulted.
  const gf = mgr.groundField;
  const groundWidth = groundViewport?.logicalWidth ?? sim.stageW ?? 1280;
  const groundBars = gf ? gf.visibleBars(pose.worldX, pose.midioX, groundWidth).map((b) => ({
    x: b.x, width: b.width, y: b.y, glow: b.glow || 0,
  })) : [];
  const emitters = [];
  const from = choice(biomeFrom), to = choice(biomeTo);
  for (const e of emitters) {
    e.presence = narrative?.cast[e.id] ?? 1;
    e.visible = e.visible && e.presence > .001;
  }
  return freezeDeep({
    frameId, generation, timeMs, seed: sim.songSeed ?? 0,
    beatTransport: mgr.beatTransport ? { ...mgr.beatTransport } : null,
    sectionId: section?.sectionId ?? section?.sourceSegmentId ?? null,
    motifId: motif.id, chapterId: section?.chapterId ?? null, motif,
    biomeFrom, biomeTo, transition01: t,
    compositions: Object.fromEntries((renderedViews || [from?.view, to?.view]).filter(Boolean).map(v => [v.id, resolveRangeComposition(v)])),
    viewFromId: from?.view?.id ?? null, viewToId: to?.view?.id ?? null,
    forcedCandidate: !!forcedView?.forcedCandidate,
    progress01, glacier, qualityLevel: sim.perf?.level ?? 0, reducedFlash, reducedMotion,
    // How much of the Forest Service map under the land shows (quiet passages).
    cloudSea01: cloudSeaAt(mgr, timeMs),
    storm: stormAt(mgr, timeMs),
    // The cast as lights in the land: brightness, travel and peaks per lane.
    actors: rangeActorsAt(sim, timeMs),
    cameraEffects: lens,
    // Camera: this section's slow cinematic move, and the listener's zoom.
    cameraMove: rangeCameraMoveAt({ timeMs, sections: mgr.sections, durationMs: mgr.durationMs,
      seed: sim.songSeed ?? 0, reducedMotion, preview: !!mgr.terrainPreview }),
    userCamera: sim.userCameraEnabled ? rangeUserCamera.sample() : null,
    scenicViewport, groundViewport,
    light: lightState, music: land, ridges, narrative, groundBars, emitters,
    waterHits: recentConductorHits(mgr.conductor?.timeline || sim.conductor?.timeline || [], timeMs),
    // World anchoring for fixed-ground dressing (rock stage, pools).
    worldX: pose.worldX, originX: pose.midioX,
  });
}

/**
 * The scenic camera's projection for a viewport: vertical field of view and
 * aspect. Terrain keeps the same pixels per radian as at the nominal stage,
 * so a camera pull-back (a larger logical stage) or the shake overscan shows
 * MORE landscape at the same scale -- characters and terrain keep their
 * proportions -- and backing size / DPR never change what is framed.
 */
export function scenicProjection(fovYDeg, vp) {
  const nominalH = vp.nominalHeight || 720;
  const tanHalf = Math.tan((fovYDeg * Math.PI) / 360) * (vp.logicalHeight / nominalH);
  return { fovYDeg: (2 * Math.atan(tanHalf) * 180) / Math.PI, aspect: vp.logicalWidth / vp.logicalHeight, tanScale: vp.logicalHeight / nominalH };
}
