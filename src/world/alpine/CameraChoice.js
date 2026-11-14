// Range v2: one default camera (docs/landscape-camera.md#one-default-camera).
//
// Camera tours on ("Auto") is the single default. For every landscape the
// song shows, the camera is the best one available for *this song*:
//
//   1. the view's music-timed shot tour, when the view has an approved
//      library AND the plan for this song beats the authored rail on the
//      measurable checks below;
//   2. otherwise the authored rail at the selected Landscape pace (which
//      already follows the song's energy and carries the section moves).
//
// A tour is planned before the view's first frame and the choice is made
// once per song and view, so the camera never switches mid-landscape. A
// refinement that would fail the checks is held: the playing tour stays.
//
// Pure: given a restored shot timeline and the view's visible intervals it
// returns the verdict and the numbers it used, for status and review.
import { SHOT_KEY_MS } from '../terrain/ShotTimeline.js';
import { settingValue } from '../../config/appSettings.js';

/** Where a planned tour stops beating its rail. Calibrated on the R7
 *  candidate libraries (docs/landscape-camera.md#one-default-camera). */
export const AUTO_TOUR_GATE = Object.freeze({
  // Share of the on-screen time spent on connecting moves rather than shots.
  // A rail is all subject; a tour that is mostly transit reads as wandering.
  maxTransitShare: 0.5,
  // At least this many visible payoffs (a shot's best frame on a musical
  // moment). A tour without one is a rail with extra risk.
  minPayoffs: 1,
  // A payoff that lands this far from its musical moment is not a payoff.
  maxPayoffErrorMs: 1500,
  // Image flow past the comfort limit by this factor reads as a whip pan.
  maxFlowRatio: 1.25,
});

const overlaps = (t, visible) => visible.some((v) => t >= v.startMs && t <= v.endMs);

/** Measurements of a planned timeline over the heard time it is on screen. */
export function tourMetrics(timeline, visible = null) {
  const durationMs = timeline?.durationMs || 0;
  const spans = (visible?.length ? visible : [{ startMs: 0, endMs: durationMs }])
    .map((v) => ({ startMs: Math.max(0, v.startMs), endMs: Math.min(durationMs, v.endMs) }))
    .filter((v) => v.endMs > v.startMs);
  const meta = timeline?.meta, keys = meta ? Math.floor(meta.length / 4) : 0;
  let onScreen = 0, transit = 0;
  for (let k = 0; k < keys; k++) {
    const t = k * SHOT_KEY_MS;
    if (t > durationMs || !overlaps(t, spans)) continue;
    onScreen++;
    if (meta[k * 4 + 1]) transit++;
  }
  const payoffs = (timeline?.payoffs || []).filter((p) => overlaps(p.plannedMs, spans));
  const errors = payoffs.map((p) => (Number.isFinite(p.actualMs) ? Math.abs(p.actualMs - p.plannedMs) : Infinity));
  const d = timeline?.diagnostics || {};
  return {
    onScreenMs: onScreen * SHOT_KEY_MS,
    transitShare: onScreen ? transit / onScreen : 1,
    payoffs: payoffs.length,
    payoffErrorMs: errors.length ? Math.max(...errors) : null,
    flowRatio: Number.isFinite(d.maxFlowRatio) ? d.maxFlowRatio : 0,
    overLimit: (timeline?.notes || d.notes || []).filter((n) => /over the limit/.test(n)),
  };
}

/** Whether a planned tour beats the authored rail for this song.
 *  Returns { ok, reason (null when ok), metrics }. */
export function tourBeatsRail(timeline, visible = null, gate = AUTO_TOUR_GATE) {
  if (!timeline || timeline.fallback) return { ok: false, reason: timeline?.fallback || 'no plan', metrics: null };
  const m = tourMetrics(timeline, visible);
  const pct = (v) => `${Math.round(v * 100)}%`;
  let reason = null;
  if (m.overLimit.length) reason = m.overLimit[0];
  else if (m.payoffs < gate.minPayoffs) reason = 'no shot lands on a musical moment';
  else if (m.payoffErrorMs > gate.maxPayoffErrorMs) reason = `a payoff misses its moment by ${(m.payoffErrorMs / 1000).toFixed(1)} s`;
  else if (m.transitShare > gate.maxTransitShare) reason = `the tour spends ${pct(m.transitShare)} in transit`;
  else if (m.flowRatio > gate.maxFlowRatio) reason = `image flow ${m.flowRatio.toFixed(2)}x its comfort limit`;
  return { ok: !reason, reason, metrics: m };
}

/** The Tour quality gate setting; ?rangeTourGate=off plays every planned
 *  tour (review of weak plans). */
export function autoGateEnabled(search) {
  return settingValue('rangeTourGate', search);
}
