// Shared measurement plumbing for bounded, fixed-clock renderer pilots.
export function pilotStats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = p => sorted[Math.round(p * (sorted.length - 1))];
  return { n: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: at(.5), p95: at(.95), max: sorted.at(-1) };
}

export function summarizePilotFrames(frames) {
  const valid = frames.filter(f => f.queries > 0 && f.resolved === f.queries && !f.disjoint
    && ['terrain', 'other'].every(kind => {
      const c = f.queryCoverage?.[kind];
      return c && Number.isInteger(c.attempted) && c.attempted >= 0
        && c.failed === 0 && c.created === c.attempted && c.resolved === c.created;
    }) && f.queryCoverage.terrain.created + f.queryCoverage.other.created === f.queries);
  return { frames: frames.length, validGpuSamples: valid.length,
    gpuTerrainMs: pilotStats(valid.map(f => f.gpu.terrain)), gpuOtherMs: pilotStats(valid.map(f => f.gpu.other)),
    frameSubmissionMs: pilotStats(frames.map(f => f.frameMs)), jsTerrainMs: pilotStats(frames.map(f => f.cpu.terrain)),
    callsTerrain: pilotStats(frames.map(f => f.calls.terrain)), trianglesTerrain: pilotStats(frames.map(f => f.triangles.terrain)) };
}

// Standalone browser function. A temporary read FBO observes uploaded level
// zero after CPU data was retired. State is restored before asynchronous
// hashing; this control-only scratch never enters the measured frame loop.
export async function readPilotTextureContent({ gl, textureHandle, width, height, maxBytes = 32 * 1024 * 1024 }) {
  const byteLength = width * height * 4;
  if (!textureHandle || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || !Number.isSafeInteger(byteLength) || byteLength > maxBytes) throw Error('unverifiable texture dimensions or readback exceeds scratch cap');
  if (gl.isContextLost?.() || gl.getError() !== gl.NO_ERROR) throw Error('invalid GL context before texture verification');
  const previous = { read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
    buffer: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
    pack: [gl.PACK_ALIGNMENT, gl.PACK_ROW_LENGTH, gl.PACK_SKIP_PIXELS, gl.PACK_SKIP_ROWS].map(key => [key, gl.getParameter(key)]) };
  const pixels = new Uint8Array(byteLength);
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw Error('texture verification framebuffer allocation failed');
  try {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textureHandle, 0);
    if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('texture verification framebuffer incomplete');
    gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    for (const [key] of previous.pack) gl.pixelStorei(key, key === gl.PACK_ALIGNMENT ? 1 : 0);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.isContextLost?.() || gl.getError() !== gl.NO_ERROR) throw Error('texture verification readback failed');
  } finally {
    for (const [key, value] of previous.pack) gl.pixelStorei(key, value);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous.buffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous.read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previous.draw);
    gl.deleteFramebuffer(framebuffer);
  }
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))].map(b => b.toString(16).padStart(2, '0')).join('');
  return { provenance: 'gpu-level-0-rgba8', width, height, byteLength, sha256 };
}

// Evaluated in the app page. Queries include trees/cast/depth in terrain
// scenes, and exclude Canvas2D output. No readback occurs inside a query.
export function installPilotProbe() {
  const scene = window.__SMW.sim.biomes.rangePresentation.scene, renderer = scene.renderer;
  const gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const render = renderer.render.bind(renderer), pending = [], frames = [];
  let current = null, active = false;
  renderer.info.autoReset = false;
  const kindOf = s => [...scene.prepared.values()].some(p => s === p.depthScene
    || Object.values(p.scenes || {}).includes(s) || Object.values(p.depthScenes || {}).includes(s)
    || (p.fringeTravel || []).some(f => f.scene === s)) ? 'terrain' : 'other';
  renderer.render = (s, c) => {
    if (!current || active) return render(s, c);
    const kind = kindOf(s), before = { ...renderer.info.render }, query = ext ? gl.createQuery() : null;
    const coverage = current.queryCoverage[kind];
    coverage.attempted++;
    if (query) coverage.created++; else coverage.failed++;
    if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    const t0 = performance.now(); active = true;
    try { return render(s, c); }
    finally {
      current.cpu[kind] += performance.now() - t0; active = false;
      if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ frame: current, kind, query }); current.queries++; }
      current.calls[kind] += renderer.info.render.calls - before.calls;
      current.triangles[kind] += renderer.info.render.triangles - before.triangles;
    }
  };
  const poll = () => {
    const disjoint = ext && gl.getParameter(ext.GPU_DISJOINT_EXT);
    for (let i = pending.length - 1; i >= 0; i--) {
      const { frame, kind, query } = pending[i];
      if (!disjoint && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (disjoint) frame.disjoint = true;
      else frame.gpu[kind] += gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      frame.resolved++; frame.queryCoverage[kind].resolved++; gl.deleteQuery(query); pending.splice(i, 1);
    }
  };
  window.__pilotProbe = {
    begin() { current = { cpu: { terrain: 0, other: 0 }, gpu: { terrain: 0, other: 0 }, calls: { terrain: 0, other: 0 },
      triangles: { terrain: 0, other: 0 }, queries: 0, resolved: 0, disjoint: false,
      queryCoverage: { terrain: { attempted: 0, created: 0, failed: 0, resolved: 0 },
        other: { attempted: 0, created: 0, failed: 0, resolved: 0 } } }; },
    end(extra) { frames.push(Object.assign(current, extra)); current = null; poll(); },
    async finish() {
      const t0 = performance.now();
      while (pending.length && performance.now() - t0 < 10000) { poll(); await new Promise(r => setTimeout(r, 16)); }
      const result = frames.splice(0);
      for (const { query } of pending.splice(0)) gl.deleteQuery(query);
      return result;
    },
  };
  return { timerQueries: !!ext };
}

export async function runPilotSteady(page, { startMs, frames, quality = 0 }) {
  return page.evaluate(async ({ startMs, frames, quality }) => {
    const smw = window.__SMW, probe = window.__pilotProbe, dt = 1000 / 60;
    for (let i = 0; i < 30; i++) smw.renderExportFrame(startMs + i * dt);
    for (let i = 0; i < frames; i++) {
      probe.begin(); const t0 = performance.now(), timeMs = startMs + (30 + i) * dt;
      smw.renderExportFrame(timeMs); probe.end({ frameMs: performance.now() - t0, timeMs });
      if (smw.perfLevel !== quality || !smw.rangeState.active) throw Error('inactive scene or quality drift during timing');
    }
    return probe.finish();
  }, { startMs, frames, quality });
}

// Compare the actual full-size PNG RGB channels, in levels 0..255. The
// standard evaluation thumbnail is too small for material-detail errors.
export async function comparePilotPngs(page, reference, candidate) {
  return page.evaluate(async ({ reference, candidate }) => {
    const decode = async data => {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const a = await decode(reference), b = await decode(candidate);
    if (a.width !== b.width || a.height !== b.height) throw Error('incompatible PNG sizes');
    let absolute = 0, squared = 0, maximum = 0, changed = 0;
    for (let i = 0; i < a.pixels.length; i += 4) {
      let pixelMax = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.pixels[i + c] - b.pixels[i + c]); absolute += d; squared += d * d; pixelMax = Math.max(pixelMax, d);
      }
      maximum = Math.max(maximum, pixelMax); if (pixelMax > 2) changed++;
    }
    const pixels = a.width * a.height;
    return { width: a.width, height: a.height, meanAbsoluteRgb: absolute / (pixels * 3),
      rootMeanSquareRgb: Math.sqrt(squared / (pixels * 3)), maxRgb: maximum, changedFractionOver2: changed / pixels };
  }, { reference, candidate });
}
