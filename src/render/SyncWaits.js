// Synchronous waits inside the frame callback.
//
// A few calls in a Landscape frame stop the main thread until the GPU has
// finished earlier work: getImageData on the GPU-backed working grid (the
// crest line), the crest probe's buffer collection, and the Cinematic
// presenter's getError and copy. Time spent there is the GPU's time showing
// up on the main thread, so a frame's callback duration overstates its own
// work by exactly that much. Each site reports its wait here; the frame loop
// takes the per-frame total (`syncWaitMs`) and hands it to the governor's
// frame statistics and the graphics report.
//
// Module state on purpose: the sites live in unrelated objects and a frame
// is single-threaded. No allocation per frame.

export const SYNC_WAIT_SITES = Object.freeze(['crestRead', 'crestEdges', 'probeCollect', 'presenter']);

const current = { crestRead: 0, crestEdges: 0, probeCollect: 0, presenter: 0, total: 0, calls: 0 };
const last = { crestRead: 0, crestEdges: 0, probeCollect: 0, presenter: 0, total: 0, calls: 0 };

/** Record one synchronous wait of `ms` at a site from SYNC_WAIT_SITES. */
export function noteSyncWait(site, ms) {
  if (!(ms >= 0) || !Number.isFinite(ms)) return;
  if (site in current && site !== 'total' && site !== 'calls') current[site] += ms;
  current.total += ms;
  current.calls++;
}

/** End the frame's accounting: returns its total wait in ms and starts a new frame. */
export function takeSyncWaits() {
  for (const k in current) { last[k] = current[k]; current[k] = 0; }
  return last.total;
}

/** Discard waits recorded outside a measured frame. */
export function resetSyncWaits() {
  for (const k in current) current[k] = 0;
}

/** The last completed frame's waits by site (a copy). */
export function lastSyncWaits() { return { ...last }; }
