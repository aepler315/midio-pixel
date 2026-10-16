// Song-owned, causal filters. Rendering queries immutable analysis rather than
// advancing envelopes; only seven states per filter are checkpointed.
import { VisualMusicHistory } from './VisualMusicHistory.js';
import { compileLandscapeSources } from './alpine/RangeNarrative.js';
import { ridgeKickEnv } from './MountainChoreo.js';
import { EnergyCurves } from '../audio/EnergyCurves.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';
import { clamp01, smoothstep } from '../utils/math.js';

const freeze = a => Object.freeze(a);
const zero = () => ({ bands: Array(7).fill(0), levels: Array(7).fill(0), depths: Array(7).fill(0), armed: Array(7).fill(true), flashMs: Array(7).fill(-Infinity), energy: 0, motionPresence01: 0, melodyActivity: 0, melodyPitchWeight: 0 });
const copy = s => ({ bands: [...s.bands], levels: [...s.levels], depths: [...s.depths], armed: [...s.armed], flashMs: [...s.flashMs], energy: s.energy, motionPresence01: s.motionPresence01, melodyActivity: s.melodyActivity, melodyPitchWeight: s.melodyPitchWeight });
const follow = (v, raw, dt, attack, release) => v + (1 - Math.exp(-dt / (raw > v ? attack : release))) * (raw - v);
let sessionId = 0;

/** Musical scrolling belongs to heard time, never a Simulation's reset origin. */
export function ridgeAdvectionPxAt(heardTimeMs, reducedMotion = false) {
  return reducedMotion || !Number.isFinite(heardTimeMs) ? 0 : 220 * Math.max(0, heardTimeMs) / 1000;
}

export class RidgeMotionHistory {
  #curves; #events; #visual; #sources; #checkpoints; #floor; #cal; #cues; #midi; #ends; #cache = new Map();
  constructor({ energyCurves = null, timeline = [], response = null, durationMs = 0, generation = 'analysis', stepMs = 20, casting, conductorCues = [] } = {}) {
    if (stepMs !== 20) throw new RangeError('Ridge history uses the canonical 20 ms clock');
    this.generation = generation;
    this.durationMs = Math.max(0, durationMs || 0);
    this.response = response ? freeze({ ...response }) : null;
    this.#events = freeze(timeline.filter(e => Number.isFinite(e.tMs) && e.tMs >= 0)
      .map(e => freeze({ ...e, durMs: Math.max(0, e.durMs || 0) })).sort((a, b) => a.tMs - b.tMs));
    this.#midi = this.#events.filter(e => e.src === 'midi');
    let end = 0;
    this.#ends = this.#midi.map(e => { end = Math.max(end, e.tMs + e.durMs + 120); return end; });
    casting ??= Object.fromEntries([['midio', 'MIDIO', 'bass'], ['broshi', 'BROSHI', 'melody'], ['midasus', 'MIDASUS', 'melody']]
      .map(([id, lane, fallback]) => [id, this.#events.some(e => e.lane === lane) ? 'source-lane' : fallback]));
    this.#sources = compileLandscapeSources({ timeline: this.#events, durationMs: this.durationMs, casting });
    this.#cues = conductorCues.filter(e => e.type === 'calm' || e.kind === 'calm').map(e => freeze({ ...e })).sort((a, b) => a.tMs - b.tMs);
    if (energyCurves?.bands) {
      const c = new EnergyCurves(this.durationMs, energyCurves.rateHz || 50);
      c.bands = Array.from({ length: 7 }, (_, b) => Float32Array.from(energyCurves.bands[b] || []));
      c.n = Math.max(2, ...c.bands.map(b => b.length));
      c.rmsBands = energyCurves.rmsBands ? Array.from({ length: 7 }, (_, b) => Float32Array.from(energyCurves.rmsBands[b] || [])) : null;
      this.#curves = c;
      const calibrated = new EnergyCurves(this.durationMs, c.rateHz);
      calibrated.n = c.n;
      calibrated.bands = c.bands.map(b => Float32Array.from({ length: c.n }, (_, i) => b[Math.min(i, b.length - 1)] || 0));
      this.#cal = calibrated.calibration(FLAT_WEIGHTS);
      const rms = c.rmsBands;
      const values = rms ? Array.from({ length: c.n }, (_, i) => Math.sqrt(rms.reduce((s, b) => s + (b[Math.min(i, b.length - 1)] || 0) ** 2, 0) / 7)).sort((a, b) => a - b) : [];
      const floor = values[Math.floor(values.length * .05)] || 0;
      this.#floor = rms ? (floor < 3e-5 ? Math.max(3e-5, floor * 1.5) : floor * .25) : 1e-9;
    }
    this.#visual = new VisualMusicHistory(this.#events.filter(e => e.src === 'midi' || this.#raw(e.tMs).activity01 > 0));
    const checkpoints = [zero()]; let state = zero();
    const ticks = Math.ceil(this.durationMs / 20);
    for (let tick = 1; tick <= ticks; tick++) {
      this.#advance(state, (tick - 1) * 20, tick * 20);
      if (tick % 100 === 0) checkpoints.push(copy(state));
    }
    this.#checkpoints = checkpoints;
    this.checkpointCount = checkpoints.length;
    Object.freeze(this);
  }
  #raw(at) {
    const c = this.#curves;
    const index = c ? Math.max(0, Math.floor(at * c.rateHz / 1000 + 1e-10)) : 0;
    const read = b => b?.[Math.min(index, b.length - 1)] || 0;
    const bands = Array.from({ length: 7 }, (_, b) => clamp01(read(c?.bands[b])));
    let midi = 0, lo = 0, hi = this.#midi.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (this.#midi[m].tMs <= at) lo = m + 1; else hi = m; }
    for (let i = lo - 1; i >= 0 && this.#ends[i] > at; i--) {
      const e = this.#midi[i];
      midi = Math.max(midi, clamp01(e.vel) * Math.min(1, (at - e.tMs) / 40) * clamp01((e.durMs + 120 - (at - e.tMs)) / 120));
    }
    const raw = bands.reduce((s, v) => s + v, 0) / 7;
    const rms = c?.rmsBands ? Math.sqrt(c.rmsBands.reduce((s, b) => s + read(b) ** 2, 0) / 7) : null;
    const hasMidi = this.#midi.length > 0;
    const audible = hasMidi ? midi > 0 : (rms ?? raw) > (this.#floor ?? 1e-9);
    const activity01 = audible ? Math.max(raw, midi) : 0;
    const cal = this.#cal;
    const mapped = cal ? .15 + .7 * (raw - cal.lo) / Math.max(1e-9, cal.spread) : raw;
    const norm = clamp01(cal ? raw + clamp01(cal.spread / .08) * (mapped - raw) : raw);
    return { bands: audible ? bands : Array(7).fill(0), activity01, energy: audible ? norm : 0 };
  }
  #advance(state, from, to) {
    // Split at actual source frames so an off-grid query includes arrived
    // samples without integrating a future frame backwards through time.
    let at = from;
    const rate = this.#curves?.rateHz || 50;
    while (at < to - 1e-8) {
      const edge = (Math.floor(at * rate / 1000 + 1e-8) + 1) * 1000 / rate;
      const end = Math.min(to, edge);
      const raw = this.#raw(at), dt = (end - at) / 1000;
      state.energy = follow(state.energy, raw.energy, dt, .4, .4);
      state.motionPresence01 = follow(state.motionPresence01, raw.activity01 > 0 ? 1 : 0, dt, .08, .45);
      if (state.motionPresence01 < 1e-5) state.motionPresence01 = 0;
      // Retain a causal physical melody tail independently of raw source
      // ownership. Decay its weighted pitch with the same coefficient so
      // silence cannot reset the spatial wavelength before activity releases.
      const melody = raw.activity01 > 0 ? this.#sources.sample(at).sources.midio : null;
      const targetActivity = melody?.pitchActivity || 0;
      const tau = targetActivity > state.melodyActivity ? .08 : .45;
      state.melodyActivity = follow(state.melodyActivity, targetActivity, dt, tau, tau);
      state.melodyPitchWeight = follow(state.melodyPitchWeight, targetActivity * (melody?.pitch01 ?? .5), dt, tau, tau);
      if (state.melodyActivity < 1e-5) { state.melodyActivity = 0; state.melodyPitchWeight = 0; }
      let calm = 1 - smoothstep(.25, .55, state.energy);
      for (const cue of this.#cues) {
        const age = at - cue.tMs;
        if (age >= 0 && age <= 10000) calm = Math.max(calm, clamp01(cue.strength ?? (typeof cue.value === 'number' ? cue.value : 1)) * (age <= 6000 ? 1 : 1 - (age - 6000) / 4000));
      }
      for (let b = 0; b < 7; b++) {
        state.bands[b] = follow(state.bands[b], raw.bands[b], dt, .08, .6);
        if (state.bands[b] <= .24) state.armed[b] = true;
        if (state.armed[b] && state.bands[b] >= .55) { state.flashMs[b] = end; state.armed[b] = false; }
        const target = state.bands[b] ** 1.4;
        state.levels[b] = follow(state.levels[b], target, dt, .05 * (1 + 3 * calm), .25 * (1 + 3 * calm));
        state.depths[b] = follow(state.depths[b], state.levels[b], dt, .05, .25);
      }
      at = end;
    }
  }
  #kick01(at) {
    const kicks = this.#visual.kicks;
    let lo = 0, hi = kicks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (kicks[mid].tMs <= at) lo = mid + 1; else hi = mid;
    }
    let retained = 0;
    for (let i = lo - 1; i >= 0; i--) {
      const age = at - kicks[i].tMs, envelope = ridgeKickEnv(age);
      // Every older envelope is lower once the 80ms attack has passed.
      // Bound by a full-strength hit, so weak newer hits cannot erase a
      // stronger tail and there is no arbitrary release cutoff.
      if (age >= 80 && envelope <= retained) break;
      retained = Math.max(retained, envelope * clamp01(.4 + .6 * kicks[i].vel));
    }
    // The upper envelope preserves each isolated accent and stays in 0..1;
    // a new attack enters at zero without resetting the body already moving.
    return retained;
  }
  sample(heardTimeMs = 0) {
    const at = Math.min(this.durationMs, Math.max(0, Number.isFinite(heardTimeMs) ? heardTimeMs : 0));
    if (this.#cache.has(at)) return this.#cache.get(at);
    const tick = Math.floor(at / 20), cp = Math.min(this.#checkpoints.length - 1, Math.floor(tick / 100));
    const state = copy(this.#checkpoints[cp]);
    for (let t = cp * 100; t < tick; t++) this.#advance(state, t * 20, (t + 1) * 20);
    this.#advance(state, tick * 20, at);
    const kick = this.#visual.sample(at), raw = this.#raw(at);
    let pressureEnergy01 = 0, bassPressure01 = 0;
    const taps = Math.max(8, Math.round((this.response?.smoothingMs ?? 1200) / 20));
    for (let i = 0; i < taps; i++) {
      const earlier = at - (i + .5) * 20;
      if (earlier < 0) continue;
      const prior = this.#raw(earlier);
      pressureEnergy01 += prior.energy / taps;
      bassPressure01 += (prior.bands[0] + prior.bands[1]) / (2 * taps);
    }
    const age = at - (kick.rhythm?.tMs ?? -Infinity);
    const rhythmAccent01 = age >= 0 && age < (this.response?.accentWindowMs ?? 800)
      ? clamp01(kick.rhythm.vel) * Math.exp(-age / (this.response?.accentDecayMs ?? 150)) * (this.response?.accentGain ?? 1) : 0;
    const sources = this.#sources.sample(at).sources;
    const gatedSources = raw.activity01 > 0 ? sources : freeze(Object.fromEntries(Object.entries(sources)
      .map(([id, s]) => [id, freeze({ ...s, activity: 0, pitchActivity: 0, pitch01: .5 })])));
    const sample = freeze({ generation: this.generation, pressureEnergy01, bassPressure01, rhythmAccent01, spaceFlash01: freeze(state.flashMs.map(ms => Math.max(0, 1 - (at - ms) / 300))), bands: freeze(state.bands), spaceLevels: freeze(state.levels), spaceDepths: freeze(state.depths),
      kickMs: kick.kickMs, kickAmp: kick.kickAmp, kick01: this.#kick01(at),
      activity01: raw.activity01, motionPresence01: state.motionPresence01,
      motionMelody: freeze({ activity: state.melodyActivity, pitch01: state.melodyActivity ? clamp01(state.melodyPitchWeight / state.melodyActivity) : .5 }), sources: gatedSources });
    // Small query memo only; checkpoints remain the musical authority.
    if (this.#cache.size >= 64) this.#cache.delete(this.#cache.keys().next().value);
    this.#cache.set(at, sample);
    return sample;
  }
}

export function createRidgeMusicSampler({ primary, previous = null, handoffStartMs = null, handoffDurationMs = 500 }) {
  const stateKey = freeze({ primaryGeneration: primary.generation, previousGeneration: previous?.generation ?? null,
    handoffStartMs: previous ? handoffStartMs : null, handoffDurationMs });
  return freeze({ generation: primary.generation, primary, previous, stateKey, sample(timeMs) {
    if (!previous || timeMs >= handoffStartMs + handoffDurationMs) return primary.sample(timeMs);
    if (timeMs <= handoffStartMs) return previous.sample(timeMs);
    const b = primary.sample(timeMs), a = previous.sample(timeMs);
    const u = clamp01((timeMs - handoffStartMs) / handoffDurationMs), mix = u * u * (3 - 2 * u);
    const lerp = (x, y) => x + (y - x) * mix;
    const contributionIndex = {};
    const sources = freeze(Object.fromEntries(Object.keys(b.sources).map(id => {
      const x = a.sources[id], y = b.sources[id];
      const activity = lerp(x.activity, y.activity), pitchActivity = lerp(x.pitchActivity, y.pitchActivity), pitch01 = lerp(x.pitch01, y.pitch01);
      const contributors = freeze(x.source === y.source
        ? [freeze({ source: x.source, activity, pitchActivity, pitch01 })]
        : [freeze({ ...x, activity: x.activity * (1 - mix), pitchActivity: x.pitchActivity * (1 - mix) }),
          freeze({ ...y, activity: y.activity * mix, pitchActivity: y.pitchActivity * mix })]);
      // Multiple presentation aliases can still name the same source. Keep
      // its strongest resolved contribution once, rather than summing aliases.
      for (const contributor of contributors) {
        const retained = contributionIndex[contributor.source];
        if (!retained || contributor.activity > retained.activity) contributionIndex[contributor.source] = contributor;
      }
      return [id, freeze({ source: x.source === y.source ? x.source : null, activity, pitchActivity, pitch01, contributors })];
    })));
    const sourceContributions = freeze(contributionIndex);
    const melodyActivity = lerp(a.motionMelody.activity, b.motionMelody.activity);
    const motionMelody = freeze({ activity: melodyActivity, pitch01: melodyActivity
      ? lerp(a.motionMelody.activity * a.motionMelody.pitch01, b.motionMelody.activity * b.motionMelody.pitch01) / melodyActivity : .5 });
    return freeze({ ...b, motionMelody, bands: freeze(b.bands.map((v, i) => lerp(a.bands[i], v))),
      spaceFlash01: freeze(b.spaceFlash01.map((v, i) => lerp(a.spaceFlash01[i], v))),
      spaceLevels: freeze(b.spaceLevels.map((v, i) => lerp(a.spaceLevels[i], v))), spaceDepths: freeze(b.spaceDepths.map((v, i) => lerp(a.spaceDepths[i], v))),
      pressureEnergy01: lerp(a.pressureEnergy01, b.pressureEnergy01), bassPressure01: lerp(a.bassPressure01, b.bassPressure01),
      motionPresence01: lerp(a.motionPresence01, b.motionPresence01),
      rhythmAccent01: lerp(a.rhythmAccent01, b.rhythmAccent01), activity01: lerp(a.activity01, b.activity01), kick01: lerp(a.kick01, b.kick01), kickAmp: lerp(a.kickAmp, b.kickAmp),
      kickMs: mix < 1 ? a.kickMs : b.kickMs, sources, sourceContributions });
  } });
}

/** Retained on song data, outside Simulation teardown/seek/export. */
export function ensureRidgeMusicSession(data, generation = `song-${++sessionId}`) {
  // Picker-time final analysis has no played handoff. Bind its response
  // once when the user chooses a presentation, retaining the new input ID.
  const retained = data.ridgeMusicSession;
  if (retained && !retained.previous && !retained.primary.response && data.ridgeResponse) {
    generation = `${retained.primary.generation}:presentation`;
    data.ridgeMusicSession = null;
  }
  if (!data.ridgeMusicSession) data.ridgeMusicSession = createRidgeMusicSampler({ primary: new RidgeMotionHistory({ ...data,
    response: data.ridgeResponse ?? data.response, generation, conductorCues: data.conductor?.liveCues }) });
  return data.ridgeMusicSession;
}

/** Must run before adoptFullAnalysis mutates the provisional data object. */
export function upgradeRidgeMusicSession(data, full, heardTimeMs = null, generation = `song-${++sessionId}:final`) {
  const previous = heardTimeMs == null ? null : ensureRidgeMusicSession(data).primary;
  const primary = new RidgeMotionHistory({ ...full, response: data.ridgeResponse ?? full.response, generation, durationMs: data.durationMs || full.durationMs, conductorCues: full.conductor?.liveCues });
  data.ridgeMusicSession = createRidgeMusicSampler({ primary, previous, handoffStartMs: heardTimeMs });
  return data.ridgeMusicSession;
}
