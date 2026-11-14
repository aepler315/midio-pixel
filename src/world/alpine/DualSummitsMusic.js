// A recording-specific, explicitly selected performance. These measurements
// come from aligned exported stem groups, never inferred from mixed timbre.
import { DS182_EVIDENCE } from '../../assets/performance/ds182.js';
import { settingValue } from '../../config/appSettings.js';

const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const STEP_MS = 100;
const TAU_MS = 4000;
const ROLES = ['mix', 'clean', 'distortion', 'other'];
const EMPTY = Object.freeze({ energy: 0, clean: 0, distortion: 0, other: 0,
  cleanShare: 0, distortionShare: 0, foreground: 'unavailable' });

/** Both explicit direction and the canonical source hash are required for
 * stem claims. Duration alone cannot identify an arrangement or recording. */
export function ds182EvidenceFor({ signature, durationMs, sourceSha256 } = {}) {
  return signature === 'dual-summits' && Number.isFinite(durationMs)
    && Math.abs(durationMs - DS182_EVIDENCE.durationMs) <= 500
    && sourceSha256 === DS182_EVIDENCE.sources.mix.sha256
    ? DS182_EVIDENCE : null;
}

/** Only a byte-identical canonical upload selects the performance by itself.
 * A URL can explicitly request its direction with other audio, in which case
 * unmatched audio retains the mix-energy fallback and no stem-role claims. */
export function dualSummitsSelection({ durationMs, sourceSha256, search } = {}) {
  const requested = settingValue('performance', search);
  if (requested === 'off') return 'off';
  if (requested === 'dual-summits') return 'dual-summits';
  return sourceSha256 === DS182_EVIDENCE.sources.mix.sha256
    && ds182EvidenceFor({ signature: 'dual-summits', durationMs, sourceSha256 }) ? 'dual-summits' : undefined;
}

/** Compile once per selected recording. Sampling is stateless across seeks.
 * Each integration step reads only a fully completed RMS window. A four
 * second response gives phrases emphasis without following every drum hit. */
export function compileDualSummitsMusic({ signature, durationMs = 0, sourceSha256, energyCurves } = {}) {
  const evidence = ds182EvidenceFor({ signature, durationMs, sourceSha256 });
  if (!evidence) return { roleSource: 'unavailable', evidence: null, at: now => {
    if (!Number.isFinite(now) || now < 0 || now >= durationMs) return EMPTY;
    return { ...EMPTY, energy: unit(energyCurves?.globalEnergyNorm?.(now)) };
  } };
  const count = Math.ceil(evidence.durationMs / STEP_MS) + 1;
  const levels = Object.fromEntries(ROLES.map(role => [role, new Float32Array(count)]));
  const gain = 1 - Math.exp(-STEP_MS / TAU_MS);
  for (let i = 1; i < count; i++) {
    const completed = Math.floor((i - 1) * STEP_MS / evidence.stepMs) - 1;
    for (const role of ROLES) {
      const prior = levels[role][i - 1];
      const rms = completed >= 0 ? evidence.tracks[role].rms[completed] || 0 : 0;
      levels[role][i] = prior + (rms - prior) * gain;
    }
  }
  const read = (role, now) => {
    const at = now / STEP_MS, lo = Math.floor(at), hi = Math.min(count - 1, lo + 1);
    return levels[role][lo] + (levels[role][hi] - levels[role][lo]) * (at - lo);
  };
  return { roleSource: 'measured-stems', evidence, at: now => {
    if (!Number.isFinite(now) || now < 0 || now >= evidence.durationMs) return EMPTY;
    const clean = read('clean', now), distortion = read('distortion', now), other = read('other', now);
    const total = clean * clean + distortion * distortion + other * other;
    const cleanShare = total > 1 ? clean * clean / total : 0;
    const distortionShare = total > 1 ? distortion * distortion / total : 0;
    return { energy: unit(read('mix', now) / evidence.tracks.mix.p95),
      clean: unit(clean / evidence.tracks.clean.p95), distortion: unit(distortion / evidence.tracks.distortion.p95),
      other: unit(other / evidence.tracks.other.p95), cleanShare, distortionShare,
      foreground: total <= 1 ? 'mixed' : cleanShare > distortionShare + .12 ? 'clean' : distortionShare > cleanShare + .12 ? 'distortion' : 'mixed' };
  } };
}
