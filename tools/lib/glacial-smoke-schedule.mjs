/** BulkExport's clock only advances. Interleave the passage's frames with
 * still samples so later checkpoints cannot freeze a backward request. */
export function flightSchedule(samples, motion = false) {
  if (!samples.every(t => Number.isFinite(t) && t >= 0)) throw new Error('song times must be finite and nonnegative');
  const events = samples.map(timeMs => ({ type: 'sample', timeMs }));
  if (motion) for (let index = 0; index < 108; index++) {
    events.push({ type: 'motion', timeMs: 150000 + index * 1000 / 12, index });
  }
  return events.sort((a, b) => a.timeMs - b.timeMs || (a.type === 'sample' ? -1 : 1));
}

export function assertExportTime(clock, requestedMs) {
  if (!Number.isFinite(clock?.timeMs) || Math.abs(clock.timeMs - requestedMs) > 1000 / 120 + .01) {
    throw new Error(`export clock ${clock?.timeMs} does not match requested ${requestedMs} ms`);
  }
}
