// A small, deterministic director for an explicitly selected two-massif stage.
// It owns no renderer, event dispatch, transport clock or per-frame integration.
import { musicMoments } from '../terrain/ShotMusic.js';

const unit = x => Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
const ease = x => { const u = unit(x); return u * u * u * (u * (u * 6 - 15) + 10); };
const between = (t, a, b) => ease((t - a) / Math.max(1, b - a));
const mix = (a, b, u) => a + (b - a) * u;
const IDS = ['first-presence', 'emergence', 'interplay', 'convergence', 'afterglow'];

/** Analysis adoption keeps the authored schedule, including the broad role
 * envelopes captured by its music reader. Seeks reconstruct this same object.
 * The performance is deliberately opt-in; ordinary songs never call this. */
export function compileDualSummitsPerformance({ durationMs = 0, energyCurves = null,
  sections = [], music = null, previous = null } = {}) {
  const duration = Math.max(1, Number.isFinite(durationMs) ? durationMs : 1);
  if (previous?.id === 'dual-summits' && previous.durationMs === duration) return previous;
  const step = Math.max(500, duration / 8192);
  const read = music?.at ? t => music.at(t).energy : t => energyCurves?.globalEnergyNorm?.(t) ?? energyCurves?.globalEnergy?.(t) ?? 0;
  const energy = Float32Array.from({ length: Math.ceil(duration / step) }, (_, i) => unit(read(i * step)));
  const moments = musicMoments({ durationMs: duration, sections: music?.roleSource === 'measured-stems' ? [] : sections,
    energy, energyStepMs: step });
  const late = moments.impacts.filter(m => m.timeMs >= .48 * duration && m.timeMs <= .9 * duration);
  const strongest = late.reduce((a, b) => !a || b.strength > a.strength || b.strength === a.strength && b.timeMs > a.timeMs ? b : a, null);
  const climaxMs = strongest?.timeMs ?? duration * .78;
  const early = moments.impacts.find(m => m.timeMs > duration * .06 && m.timeMs < duration * .25);
  const emergenceMs = Math.min(climaxMs * .25, early?.timeMs ?? duration * .13);
  const interplayMs = Math.max(emergenceMs * 1.8, Math.min(climaxMs * .56, duration * .32));
  const convergenceMs = Math.max(interplayMs, climaxMs - Math.min(18000, duration * .12));
  const afterglowMs = Math.min(duration * .96, climaxMs + Math.min(18000, duration * .06));
  const cues = Object.freeze({ emergenceMs, interplayMs, convergenceMs, climaxMs, afterglowMs });
  const boundaries = [0, emergenceMs, interplayMs, convergenceMs, afterglowMs, duration];
  const acts = Object.freeze(IDS.map((id, i) => Object.freeze({ id, startMs: boundaries[i], endMs: boundaries[i + 1] })));
  // Copy broad musical balance onto a bounded lattice once. Late analysis,
  // mutable source curves and arbitrary draw order cannot change these keys.
  const measured = music?.roleSource === 'measured-stems';
  const clean = Float32Array.from(energy, (_, i) => measured ? unit(music.at(i * step).cleanShare) : 0);
  const distortion = Float32Array.from(energy, (_, i) => measured ? unit(music.at(i * step).distortionShare) : 0);
  const balance = Float32Array.from(energy, (_, i) => measured && clean[i] + distortion[i] > .01
    ? distortion[i] / (clean[i] + distortion[i]) : .5);
  const sample = (values, at) => {
    const k = Math.min(values.length - 1, Math.max(0, at / step)), a = Math.floor(k);
    return mix(values[a], values[Math.min(a + 1, values.length - 1)], k - a);
  };
  const at = timeMs => {
    const t = Number.isFinite(timeMs) ? Math.max(0, Math.min(duration, timeMs)) : 0;
    const reveal01 = between(t, emergenceMs, interplayMs);
    const convergence01 = between(t, convergenceMs, climaxMs);
    const resolved = t >= climaxMs;
    const roleBalance = sample(balance, t);
    const focus01 = mix(mix(0, .28 + .44 * roleBalance, reveal01), .5, convergence01);
    // Geological growth only moves forwards. Texture emphasis lives in the
    // camera, never in per-beat mountain scaling or alternating height wobble.
    const riseA = mix(.62, 1, between(t, 0, climaxMs));
    const riseB = mix(.28, 1, between(t, emergenceMs * .5, climaxMs));
    const act = acts.find(a => t < a.endMs)?.id ?? 'afterglow';
    const fovYDeg = mix(mix(18, 32, reveal01), 40, convergence01);
    return Object.freeze({ id: 'dual-summits', act, reveal01, convergence01,
      focus01: resolved ? .5 : focus01, fovYDeg: resolved ? 40 : fovYDeg,
      roleSource: music?.roleSource ?? 'mix-energy-only',
      cleanShare: measured ? sample(clean, t) : null, distortionShare: measured ? sample(distortion, t) : null,
      rise01: (riseA + riseB) / 2,
      slotRise01: Object.freeze({ B1: riseA, B2: riseB }),
      // The shared image, not a flash, is the climax. It survives the tail.
      finalHold: resolved, energy01: sample(energy, t) });
  };
  return Object.freeze({ id: 'dual-summits', durationMs: duration, cues, acts,
    evidence: strongest ? 'measured-energy-arrival' : 'timed-fallback', at });
}

/** A fixed safe eye and slow changes of aim teach the geography without
 * revealing terrain outside the assembled stage. Heights use each summit's
 * actual slot transform, rather than the global mean-rise camera mapping. */
export function dualSummitsPose(view, state, { baseM = 2050 } = {}) {
  if (view?.signaturePerformance !== 'dual-summits' || state?.id !== 'dual-summits') return null;
  const peaks = view.signatureSummits;
  if (peaks?.length !== 2 || peaks.some(p => !Array.isArray(p.positionM) || p.positionM.length !== 3 || !p.positionM.every(Number.isFinite))) return null;
  const eye = view.camera?.eyeEndM;
  if (!Array.isArray(eye) || eye.length !== 3 || !eye.every(Number.isFinite)) return null;
  const risen = peaks.map(p => [p.positionM[0], baseM + (p.positionM[1] - baseM) * (state.slotRise01[p.slotId] ?? 1), p.positionM[2]]);
  const focus = unit(state.focus01), convergence = unit(state.convergence01);
  const targetM = risen[0].map((v, i) => mix(v, risen[1][i], focus));
  // A low aim leaves room above both crests and for their lake reflection.
  const relief = Math.max(risen[0][1], risen[1][1]) - baseM;
  targetM[1] = mix(targetM[1] - relief * .12, baseM + relief * .25, convergence);
  return { eyeM: [...eye], targetM, fovYDeg: state.fovYDeg, signature: 'dual-summits' };
}
