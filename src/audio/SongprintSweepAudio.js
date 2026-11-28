import { Role } from '../core/NoteEvent.js';
import { clamp01, lerp } from '../utils/math.js';

// Playback and export both seek this evidence by absolute media time. Offline
// filter-bank RMS preserves rests, including stereo that cancels in a mono mix.
function recordedEnvelope(curves) {
  const bands = curves?.rmsBands;
  if (!bands?.length || !(curves.rateHz > 0) || !bands[0].length) return null;
  const power = new Float32Array(bands[0].length);
  const treble = new Float32Array(power.length);
  for (let i = 0; i < power.length; i++) {
    let total = 0, high = 0;
    for (let b = 0; b < bands.length; b++) {
      const p = bands[b][i] ** 2;
      total += p;
      if (b >= 4) high += p;
    }
    power[i] = Math.sqrt(total);
    treble[i] = Math.sqrt(high);
  }
  function reference(values) {
    const ordered = values.slice().sort();
    return Math.max(1e-8, ordered[Math.floor(.97 * (ordered.length - 1))], .08 * ordered.at(-1));
  }
  const ceiling = reference(power), brightCeiling = reference(treble);
  const attack = new Float32Array(power.length);
  let slow = 0, brightSlow = 0;
  const attackGain = 1 - Math.exp(-1 / (curves.rateHz * .02));
  const releaseGain = 1 - Math.exp(-1 / (curves.rateHz * .065));
  for (let i = 0; i < power.length; i++) {
    const rms = power[i] / ceiling, bright = treble[i] / brightCeiling;
    attack[i] = .65 * Math.max(0, rms - 1.1 * slow) + .35 * Math.max(0, bright - 1.15 * brightSlow);
    slow += (rms > slow ? attackGain : releaseGain) * (rms - slow);
    brightSlow += (bright > brightSlow ? attackGain : releaseGain) * (bright - brightSlow);
    power[i] = rms > .001 ? Math.min(1, rms ** .85) : 0;
  }
  const transientCeiling = reference(attack), decay = Math.exp(-1 / (curves.rateHz * .045));
  for (let i = 0; i < attack.length; i++) {
    attack[i] = power[i] > .005 ? Math.max(clamp01(attack[i] / transientCeiling), i ? attack[i - 1] * decay : 0) : 0;
  }
  return { power, attack, rate: curves.rateHz };
}

function interpolate(values, frame) {
  const lo = Math.floor(frame);
  return lerp(values[lo], values[Math.min(lo + 1, values.length - 1)], frame - lo);
}

// Equal-time chords become one physical accent. Midio adds synthetic pad
// events at estimated bar boundaries; those carry no observed attack.
function measuredOnsets(timeline) {
  const onsets = [];
  for (const e of timeline ?? []) {
    if (!Number.isFinite(e.tMs) || !(e.vel > 0) || e.pitchProvenance === 'synthetic'
      || (e.src !== 'midi' && e.role === Role.PAD)) continue;
    const previous = onsets.at(-1);
    if (previous?.time === e.tMs) previous.strength = Math.max(previous.strength, e.vel);
    else onsets.push({ time: e.tMs, strength: e.vel });
  }
  return onsets;
}

function recentAttack(onsets, ms, windowMs = 180) {
  let lo = 0, hi = onsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (onsets[mid].time <= ms) lo = mid + 1; else hi = mid;
  }
  let strength = 0;
  for (let i = lo - 1; i >= 0 && onsets[i].time >= ms - windowMs; i--) {
    strength = Math.max(strength, onsets[i].strength * Math.exp((onsets[i].time - ms) / 55));
  }
  return strength;
}

function localPhaseAt(segments, ms) {
  let lo = 0, hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid].tMs <= ms) lo = mid + 1; else hi = mid;
  }
  return segments[lo - 1];
}

export function createSweepAudio(sim, descriptor) {
  const curves = sim.energyCurves;
  const envelope = recordedEnvelope(curves);
  const onsets = measuredOnsets(sim.conductor?.timeline);
  const authored = !envelope && sim.conductor?.timeline?.some(event => event.src === 'midi');
  const through = sim.biomes?.analyzedThroughMs ?? Infinity;
  const metadata = sim.conductor?.beatMetadata;
  // The app's transport integrates local tempo. Audio analysis can also
  // measure a local phase anchor, so a tempo change needn't accumulate drift.
  const anchors = (metadata?.localTempo ?? []).map(segment => {
    const beat = Number.isFinite(segment.firstBeatMs) ? sim.songBeat?.snapshotAt(segment.firstBeatMs) : null;
    const position = beat ? beat.beatIndex + beat.phase01 : 0;
    return { tMs: segment.tMs, confidence: segment.phaseConfidence,
      correction: Number.isFinite(segment.phaseConfidence) ? Math.round(position) - position : 0 };
  });
  return (out, ms, withinPrint, slice) => {
    out.attack = 0; out.energy = 0; out.audible = 0;
    out.beatPosition = null; out.beatConfidence = 0;
    if (ms > through) return;
    const beat = sim.songBeat?.snapshotAt(ms);
    const anchor = localPhaseAt(anchors, ms);
    const confidence = Math.min(beat?.confidence ?? 0, anchor?.confidence ?? metadata?.phaseConfidence ?? 1);
    if (!beat?.freeTime && confidence >= .25 && Number.isFinite(beat.beatIndex + beat.phase01)) {
      out.beatPosition = beat.beatIndex + beat.phase01 + (anchor?.correction ?? 0);
      out.beatConfidence = confidence;
    }
    let onset = 0;
    if (envelope) {
      const frame = ms * envelope.rate / 1000;
      if (frame >= envelope.power.length) return;
      out.energy = interpolate(envelope.power, frame);
      onset = interpolate(envelope.attack, frame);
    } else if (curves) {
      // MIDI and old caches can have calibrated band activity only.
      out.energy = clamp01(curves.globalEnergy?.(ms) ?? curves.globalEnergyNorm?.(ms));
    } else if (withinPrint && descriptor.version === 2) {
      out.energy = clamp01(10 ** (descriptor.tone[slice * 3 + 2] / 20));
    }
    // A MIDI attack is scored at its exact timestamp. Its synthesized
    // activity curve can still be zero until the following envelope frame.
    if (authored && out.energy <= .005)
      out.energy = .18 * recentAttack(onsets, ms, 1000 / (curves?.rateHz || 50));
    if (out.energy <= .005) return;
    out.audible = clamp01(out.energy / .18);
    out.attack = out.audible * Math.max(onset, recentAttack(onsets, ms));
  };
}
