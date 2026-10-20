// Range v2 device run (plan Task 16). Paste into the DevTools console on the
// title screen, BEFORE loading the song (see docs/range-v2-device-runs.md):
// the cold bucket then covers the song's real start -- world construction,
// strip bakes and the first view's preparation. Pasted during playback it
// still works, but reports `coldStartCaptured: false`.
// It records for MINUTES from the song's start and prints one JSON report.
// For the cold start, steady playback and view-to-view travels it reports
// two things separately (src/render/FrameDelivery.js):
// - `callbacks`: rAF callback intervals (median/p95/p99, >100 ms stalls);
// - `delivered`: intervals between successfully PRESENTED frames, from the
//   presentation's (generation, frameId). An FPS cap, a failed
//   presentation or a repeated frame is not a new delivered frame, and
//   paused or hidden time and song changes are excluded, never counted as
//   one long interval.
// Also: the quality levels the governor chose, FPS caps seen, the residency
// high-water mark (tracked by the ledger itself, so short-lived
// reservations count) by owner, the Range render/copy CPU submission cost
// per frame (every pass, both travel sides; not GPU completion), the stage
// and backing sizes, DPR and the GPU string. Nothing is sent anywhere; the
// report is also copied to the clipboard when DevTools allows it.
(async (MINUTES = 10) => {
  const MiB = 1048576;
  const { FrameDeliveryAggregator } = await import(new URL('src/render/FrameDelivery.js', document.baseURI).href);
  const COLD_MS = 20000;
  // A restarted song replaces window.__SMW (and its governor): read it
  // afresh every frame.
  const live = () => window.__SMW;
  const coldStartCaptured = !live()?.sim;
  if (coldStartCaptured) console.log('[range probe] waiting for a song; load one now');
  let last = performance.now();
  // Before the song exists nothing is recorded, but the ticks keep running
  // so the interval spanning world construction lands in the cold bucket.
  await new Promise((ready) => {
    const wait = (t) => { if (live()?.sim) { ready(); return; } last = t; requestAnimationFrame(wait); };
    requestAnimationFrame(wait);
  });
  const residency = () => live()?.sim?.biomes?.rangePresentation?.residency || null;
  // Started before the song: the ledger's high-water mark since page load
  // already holds the startup peak (construction, strip bakes, the first
  // view), so keep it -- open a fresh page for each run. Started during
  // playback: begin a new window here.
  if (!coldStartCaptured) residency()?.resetPeak?.();
  const buckets = { cold: new FrameDeliveryAggregator(), steady: new FrameDeliveryAggregator(), travel: new FrameDeliveryAggregator(), playback: new FrameDeliveryAggregator() };
  const levels = {};
  let previousBucket = null, segment = 0;
  const renderMs = [], copyMs = [];
  const MAX_TIMINGS = 40000; // ten minutes at 60 Hz, bounded
  let legacyFrames = 0, restarts = 0, lastSim = live().sim, lastFrameId = null;
  const t0 = last, end = t0 + MINUTES * 60000;
  console.log(`[range probe] recording ${MINUTES} min; keep the tab in front and the song playing`);
  await new Promise((done) => {
    const tick = (t) => {
      last = t;
      const smw = live();
      if (smw?.sim && smw.sim !== lastSim) { restarts++; lastSim = smw.sim; }
      const pres = smw?.sim?.biomes?.rangePresentation;
      const travelling = !!pres?.incomingViewId;
      // Which presented frame is on screen at this callback. A new song
      // (load generation) or presentation generation restarts frame ids.
      const shown = smw?.presentationDiagnostics?.frame || {};
      const bucket = t - t0 < COLD_MS ? 'cold' : travelling ? 'travel' : 'steady';
      if (bucket !== previousBucket) { segment++; previousBucket = bucket; }
      const sample = {
        wallMs: t, generation: smw?.generation ?? 0,
        frameId: shown.frameId == null ? null : `${shown.generation ?? 0}:${shown.frameId}`,
        presented: !!shown.presented, attempted: shown.reason !== 'not-rendered',
        paused: !!smw?.paused, hidden: document.hidden, capFps: smw?.fpsCap ?? null };
      buckets[bucket].push({ ...sample, segment });
      // Keep the post-cold playback chain continuous across travel and
      // quality changes, so a real boundary stall is still measured.
      if (bucket !== 'cold') buckets.playback.push(sample);
      levels[smw?.perfLevel] = (levels[smw?.perfLevel] || 0) + 1;
      if (pres?.active) {
        // The totals of the latest Range frame (every pass summed), once
        // per frame: CPU submission and copy, not GPU completion.
        const tm = pres.timings;
        if (tm.frameId !== lastFrameId && renderMs.length < MAX_TIMINGS) { renderMs.push(tm.frameRenderMs); copyMs.push(tm.frameCopyMs); }
        lastFrameId = tm.frameId;
      } else legacyFrames++;
      if (t < end) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
  const stats = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
    return { frames: s.length, medianMs: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), stallsOver100ms: s.filter((x) => x > 100).length };
  };
  const smw = live();
  const scene = smw?.sim?.biomes?.rangePresentation?.scene;
  const gl = scene?.renderer?.getContext?.();
  const dbg = gl?.getExtension?.('WEBGL_debug_renderer_info');
  const gpu = gl ? (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null;
  const stage = document.querySelector('#stage');
  const r = residency()?.snapshot?.() || null;
  const report = {
    when: new Date().toISOString(), url: location.href, userAgent: navigator.userAgent, gpu,
    deviceMemoryGB: navigator.deviceMemory ?? null, dpr: devicePixelRatio,
    stage: stage ? { css: `${stage.clientWidth}x${stage.clientHeight}`, backing: `${stage.width}x${stage.height}` } : null,
    rangeTarget: scene ? `${scene.size.width}x${scene.size.height}` : null,
    budget: smw?.rangeState?.residency?.budget ?? null,
    minutes: MINUTES, coldStartCaptured, songRestarts: restarts,
    frameDelivery: { cold: buckets.cold.summary(), steady: buckets.steady.summary(), travel: buckets.travel.summary(), playback: buckets.playback.summary() },
    qualityLevels: levels, legacyFrames,
    residencyPeakWindow: coldStartCaptured ? 'page load' : 'probe start',
    residencyPeakMiB: r ? +(r.peakBytes / MiB).toFixed(1) : null,
    residencyPeakByOwnerMiB: r ? Object.fromEntries(Object.entries(r.peakByOwner).map(([k, v]) => [k, +(v / MiB).toFixed(1)])) : null,
    overcommits: r?.overcommits ?? null, denials: r?.denials ?? null,
    rangeTimingScope: 'CPU submission and copy per Range frame; not GPU completion',
    rangeRenderMsPerFrame: stats(renderMs), rangeCopyMsPerFrame: stats(copyMs),
  };
  const text = JSON.stringify(report, null, 1);
  console.log(text);
  try { await navigator.clipboard.writeText(text); console.log('[range probe] report copied to the clipboard'); } catch { /* copy it from the log */ }
  return report;
})();
