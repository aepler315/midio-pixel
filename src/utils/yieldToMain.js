// Yielding to the browser during long analysis, without paying for it.
//
// Analysis loops used to yield with `await new Promise((r) => setTimeout(r, 0))`
// every few frames. Browsers clamp a nested setTimeout(0) to at least 4ms,
// so each yield idled for 4ms whether or not anything else needed the
// thread: pitch tracking a four-minute song yielded ~1,300 times, which is
// several seconds of the load spent doing nothing at all.
//
// Two fixes, both here. yieldToMain() hands control back with no clamp
// (scheduler.yield where the browser has it, a MessageChannel round trip
// otherwise). createYielder() yields by elapsed time instead of by
// iteration count, so a fast loop yields rarely and a slow one still keeps
// the loading animation at frame rate.

let channel = null;
const waiting = [];

function messageChannel() {
  if (channel || typeof MessageChannel === 'undefined') return channel;
  channel = new MessageChannel();
  channel.port1.onmessage = () => {
    waiting.shift()?.();
    if (!waiting.length) channel.port1.unref?.();
  };
  // Node keeps a process alive while a port with a listener is referenced.
  // Hold that reference only while a yield is actually waiting: unref'd for
  // good, Node would exit mid-yield with the continuation still pending;
  // ref'd for good, an idle channel would keep a finished process running.
  // Browsers have neither method and need neither.
  channel.port1.unref?.();
  channel.port2.unref?.();
  return channel;
}

/** Let the browser run a frame (input, rendering, the loading show), then
 *  continue. Resolves on the next task, without setTimeout's 4ms clamp. */
export function yieldToMain() {
  const sched = globalThis.scheduler;
  if (typeof sched?.yield === 'function') return sched.yield();
  const ch = messageChannel();
  if (!ch) return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    waiting.push(resolve);
    ch.port1.ref?.();
    ch.port2.postMessage(0);
  });
}

/** A per-loop yield check: call `maybeYield()` every iteration and it only
 *  actually yields once `budgetMs` of work has passed since the last one. */
export function createYielder(budgetMs = 12, now = () => globalThis.performance?.now?.() ?? Date.now()) {
  let last = now();
  return async function maybeYield() {
    if (now() - last < budgetMs) return false;
    await yieldToMain();
    last = now();
    return true;
  };
}
