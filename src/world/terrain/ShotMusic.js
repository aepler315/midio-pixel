// Scenic shot tours: the song side of the planner (docs/scenic-tours.md).
//
// Payoff targets are energy *impacts*: places where the music gets louder
// fast, measured as the mean energy over the next second minus the mean over
// the previous second. Detected section labels are a weak cue -- on the
// structured test songs the detector places boundaries up to 2.5 s early and
// can misplace the final-chorus label, while the 1 s energy rise peaks within
// 0.2 s of every chorus downbeat. So a chorus/drop boundary only says "look
// within +-3 s for the rise"; the rise finds the impact and its onset sets
// the time: the 1 s rise peaks early where the music dips just before the
// downbeat (drop.wav: at 44.8 and 97.3 s for drops at 45.0 and 97.5 s), so
// the impact moves to the largest one-step jump in energy within
// onsetWindowMs of the rise peak whose level holds afterwards: its rise over
// onsetWindowMs (median of the next against median of the previous, so one
// loud sample does not count) at least half the largest such rise there. A
// lone beat spike just before the downbeat jumps as far but does not hold.
//
// Pure and deterministic: the same inputs give the same moments.

export const IMPACT_ROLES = new Set(['chorus', 'drop', 'post-chorus']);
export const CALM_ROLES = new Set(['breakdown', 'bridge', 'intro', 'outro']);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort(), at = q * (sorted.length - 1), lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/**
 * Musical moments of one song.
 * Returns { impacts: [{timeMs, strength 0..1, sectionIndex, role, boundary}],
 * climax (one of impacts) | null, calm: [{startMs, endMs}], phrases: [timeMs],
 * intensity (Float32Array on the energy lattice), intensityAt(t) 0..1 }.
 */
export function musicMoments({ durationMs, sections = [], roles = [], energy = [], energyStepMs = 100,
  minGapMs = 6000, boundaryWindowMs = 3000, thresholdFraction = .35, onsetWindowMs = 300 } = {}) {
  const step = energyStepMs > 0 ? energyStepMs : 100, n = energy?.length || 0;
  const duration = Math.max(0, Number(durationMs) || 0) || n * step;
  const roleOf = (i) => roles?.[i]?.role ?? sections[i]?.role ?? null;
  const finalOf = (i) => !!(roles?.[i]?.finalChorus ?? sections[i]?.finalChorus);
  const sectionAt = (t) => { let k = -1; for (let i = 0; i < sections.length; i++) if (sections[i].startMs <= t) k = i; return Math.max(0, k); };
  const phrases = [...new Set(sections.map((s) => s.startMs).filter((t) => t > 0 && t < duration))].sort((a, b) => a - b);
  const e = Float64Array.from({ length: n }, (_, i) => (Number.isFinite(energy[i]) ? Math.max(0, energy[i]) : 0));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + e[i];
  const mean = (a, b) => { a = Math.max(0, a); b = Math.min(n, b); return b > a ? (prefix[b] - prefix[a]) / (b - a) : 0; };

  // Intensity: 2 s centred mean, stretched between the song's own p10 and p95.
  const half = Math.max(1, Math.round(1000 / step)), smooth = Float64Array.from({ length: n }, (_, i) => mean(i - half, i + half + 1));
  const lo = quantile(smooth, .1), hi = quantile(smooth, .95);
  const intensity = Float32Array.from(smooth, (v) => (hi - lo > 1e-9 ? clamp01((v - lo) / (hi - lo)) : .5));
  const intensityAt = (t) => {
    if (!n) return .5;
    const at = Math.min(n - 1, Math.max(0, (Number(t) || 0) / step)), i = Math.min(n - 2, Math.floor(at));
    return i < 0 ? intensity[0] : intensity[i] + (intensity[i + 1] - intensity[i]) * (at - i);
  };

  // Rise at i: energy from i on against energy before i (1 s each side).
  const k = Math.max(1, Math.round(1000 / step)), rise = new Float64Array(n);
  for (let i = k; i + k <= n; i++) rise[i] = mean(i, i + k) - mean(i - k, i);
  const riseMax = Math.max(0, ...rise), threshold = Math.max(thresholdFraction * quantile(rise, .95), .02 * hi);
  const strengthOf = (r, boundary) => { const base = riseMax > 0 ? clamp01(r / riseMax) : 0; return boundary ? .15 + .85 * base : .85 * base; };
  const ow = Math.max(1, Math.round(onsetWindowMs / step));
  const median = (lo, hi) => { const v = Array.from(e.subarray(Math.max(0, lo), Math.min(n, hi))).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : 0; };
  const onset = (i) => {
    const a = Math.max(1, i - ow), b = Math.min(n - 1, i + ow), held = (j) => median(j, j + ow) - median(j - ow, j);
    let most = 0, at = i, jump = 0;
    for (let j = a; j <= b; j++) most = Math.max(most, held(j));
    for (let j = a; j <= b; j++) {
      const d = e[j] - e[j - 1];
      if (d > jump && held(j) >= .5 * most) { at = j; jump = d; }
    }
    return at;
  };
  const make = (i, sectionIndex, boundary) => ({ timeMs: Math.min(duration, onset(i) * step), strength: strengthOf(rise[i], boundary), rise: rise[i],
    sectionIndex, role: roleOf(sectionIndex), boundary });

  // Boundary impacts: the strongest rise near a chorus/drop/post-chorus or
  // final-chorus boundary, wherever the detector put that boundary.
  const accepted = [];
  const free = (i) => accepted.every((m) => Math.abs(m.timeMs - i * step) >= minGapMs);
  const boundaries = [];
  sections.forEach((s, j) => {
    if (!(s.startMs > 0) || !(IMPACT_ROLES.has(roleOf(j)) || finalOf(j))) return;
    let best = -1;
    for (let i = Math.max(k, Math.ceil((s.startMs - boundaryWindowMs) / step)); i <= Math.min(n - k, Math.floor((s.startMs + boundaryWindowMs) / step)); i++) {
      if (best < 0 || rise[i] > rise[best]) best = i;
    }
    if (best >= 0 && rise[best] > .25 * threshold) boundaries.push(make(best, j, true));
  });
  for (const m of boundaries.sort((a, b) => b.rise - a.rise || a.timeMs - b.timeMs)) if (free(m.timeMs / step)) accepted.push(m);

  // Any other strong rise: local maxima over +-0.5 s, strongest first.
  const peaks = [], h = Math.max(1, Math.round(k / 2));
  for (let i = k; i + k <= n; i++) {
    if (!(rise[i] > threshold)) continue;
    let peak = true;
    for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h) && peak; j++) if (j < i ? rise[j] >= rise[i] : j > i && rise[j] > rise[i]) peak = false;
    if (peak) peaks.push(i);
  }
  peaks.sort((a, b) => rise[b] - rise[a] || a - b);
  for (const i of peaks) if (free(onset(i))) accepted.push(make(i, sectionAt(i * step), false));
  const impacts = accepted.sort((a, b) => a.timeMs - b.timeMs).map(({ rise: _, ...m }) => m);

  // Climax: the strongest impact in the last 55%, preferring one inside the
  // final chorus when it is within 15% of the strongest.
  const late = impacts.filter((m) => m.timeMs >= .45 * duration);
  const strongest = late.reduce((best, m) => (!best || m.strength > best.strength || m.strength === best.strength && m.timeMs > best.timeMs ? m : best), null);
  const final = strongest && late.filter((m) => finalOf(m.sectionIndex) && m.strength >= .85 * strongest.strength)
    .reduce((best, m) => (!best || m.strength > best.strength ? m : best), null);
  const climax = final || strongest;

  // Calm: quiet intro/outro/bridge/breakdown sections and the songs' stops.
  const spans = [];
  sections.forEach((s, j) => {
    const a = Math.max(0, Math.floor(s.startMs / step)), b = Math.min(n, Math.ceil(s.endMs / step));
    let sum = 0;
    for (let i = a; i < b; i++) sum += intensity[i];
    if (CALM_ROLES.has(roleOf(j)) && b > a && sum / (b - a) < .45) spans.push({ startMs: s.startMs, endMs: Math.min(duration, s.endMs) });
    for (const stop of roles?.[j]?.stops || []) if (stop.endMs > stop.startMs) spans.push({ startMs: stop.startMs, endMs: stop.endMs });
  });
  const calm = [];
  for (const span of spans.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    const last = calm.at(-1);
    if (last && span.startMs <= last.endMs + step) last.endMs = Math.max(last.endMs, span.endMs);
    else calm.push({ ...span });
  }
  return { durationMs: duration, impacts, climax, calm, phrases, intensity, energyStepMs: step, intensityAt };
}
