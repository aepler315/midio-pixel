// Shared synchronous and time-sliced consumers keep terrain preparation's
// bytes and traversal order identical. Live builds leave room for frames;
// cancellation is checked before any work and after every event-loop turn.
export function finishPreparation(steps) {
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

export async function prepareInSlices(steps, { sliceMs = 8, yieldTo = () => new Promise(r => setTimeout(r, 0)), signal = null, checkCurrent = null } = {}) {
  const check = () => { signal?.throwIfAborted(); checkCurrent?.(); };
  let start = performance.now();
  check();
  let result = steps.next();
  while (!result.done) {
    check();
    if (performance.now() - start >= sliceMs) {
      await yieldTo();
      check();
      start = performance.now();
    }
    result = steps.next();
  }
  check();
  return result.value;
}
