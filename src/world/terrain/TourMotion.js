/** The endpoint role owns each published frame interval. Stopped intervals
 * retain their view, and the final interval can be shorter than 100 ms. */
export const tourYawRate = role =>
  role === 'outro' || role === 'breakdown' ? 12 : 25;

export function tourYawBudget(frames) {
  const capacity = new Float64Array(frames.length);
  for (let i = 1; i < frames.length; i++) {
    const rate = frames[i].stop && frames[i - 1].stop ? 0 : tourYawRate(frames[i].role);
    capacity[i] = capacity[i - 1] + rate * (frames[i].timeMs - frames[i - 1].timeMs) / 1000;
  }
  const at = time => {
    if (time <= frames[0].timeMs) return 0;
    if (time >= frames.at(-1).timeMs) return capacity.at(-1);
    // All but the final frame lie on the 100 ms publication grid.
    const lo = Math.min(frames.length - 2, Math.floor(time / 100)), hi = lo + 1;
    const fraction = (time - frames[lo].timeMs) / (frames[hi].timeMs - frames[lo].timeMs);
    return capacity[lo] + (capacity[hi] - capacity[lo]) * fraction;
  };
  return (fromMs, toMs) => Math.max(0, at(toMs) - at(fromMs));
}
