/**
 * Advance a fixed-step simulation against an authoritative audio clock.
 * Short frame gaps take ordinary fixed steps; long gaps run one bounded
 * update at the current audio time so rendering cannot remain permanently
 * behind playback after a suspended tab or debugger pause.
 */
export function advanceFixedStepClock({
  nowMs,
  lastNowMs,
  simTime,
  accumulatorMs,
  stepMs,
  step,
  maxGapMs = 250,
}) {
  let deltaMs = nowMs - lastNowMs;
  if (deltaMs < 0) deltaMs = 0;

  if (deltaMs > maxGapMs) {
    step(maxGapMs, nowMs);
    return {
      lastNowMs: nowMs,
      simTime: nowMs,
      accumulatorMs: 0,
      resynced: true,
    };
  }

  let nextSimTime = simTime;
  let nextAccumulatorMs = accumulatorMs + deltaMs;
  while (nextAccumulatorMs >= stepMs) {
    nextSimTime += stepMs;
    step(stepMs, nextSimTime);
    nextAccumulatorMs -= stepMs;
  }
  return {
    lastNowMs: nowMs,
    simTime: nextSimTime,
    accumulatorMs: nextAccumulatorMs,
    resynced: false,
  };
}
