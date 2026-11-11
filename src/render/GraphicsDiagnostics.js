import { MAX_LEVEL } from './PerfGovernor.js';

// Local, bounded support evidence. Never creates a context or includes audio,
// filenames, lyrics, page URLs, storage contents or credentials.
export function shaderFailureLog(gl, program) {
  let link = '', shaders = [], warnings = [];
  try { link = gl.getProgramInfoLog(program) || ''; } catch { /* lost context */ }
  try {
    for (const shader of gl.getAttachedShaders(program) || []) {
      const log = gl.getShaderInfoLog(shader) || '';
      if (!log) continue;
      (gl.getShaderParameter?.(shader, gl.COMPILE_STATUS) ? warnings : shaders).push(log.slice(0, 768));
    }
  } catch { /* driver may not expose attached shaders */ }
  return [...shaders, link, ...warnings].join('\n').trim().slice(0, 768) || 'program link failed';
}
const pick = (value, keys) => value == null ? null : Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
// The performance block copies only known numeric, boolean and short string
// fields, so a stray object (or a live governor) cannot make the report
// unbounded or leak song data into it.
const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const flag = (v) => typeof v === 'boolean' ? v : null;
const str = (v) => typeof v === 'string' ? v.slice(0, 128) : null;
const obj = (v) => (v !== null && typeof v === 'object' ? v : null);
const PERF_EVENT_CAP = 32;
const PERF_LEVELS = MAX_LEVEL + 1;
const SYNC_WAIT_FIELDS = ['totalMs', 'calls', 'crestRead', 'crestEdgesRead', 'probeCollect', 'probeSyncRead', 'presenterGetError'];
const frameStats = (s) => obj(s) && { count: num(s.count) ?? 0, median: num(s.median), p95: num(s.p95), max: num(s.max) };
const governorBlock = (g) => {
  if (!obj(g)) return null;
  const counters = obj(g.counters), frames = obj(g.frames);
  const events = Array.isArray(g.events) ? g.events.slice(-PERF_EVENT_CAP) : [];
  return {
    workTimingEnabled: flag(g.workTimingEnabled), framePeriodMs: num(g.framePeriodMs), observedWorkMs: num(g.observedWorkMs),
    workHeadroomMs: num(g.workHeadroomMs), probeLevel: num(g.probeLevel), probeUntilMs: num(g.probeUntilMs),
    level: num(g.level), minLevel: num(g.minLevel), sinceStartMs: num(g.sinceStartMs),
    levelMs: Array.isArray(g.levelMs) || ArrayBuffer.isView(g.levelMs) ? Array.from({ length: PERF_LEVELS }, (_, i) => num(g.levelMs[i]) ?? 0) : null,
    counters: counters && Object.fromEntries(['samples', 'overBudget', 'workPressure', 'noHeadroom', 'levelChanges'].map(k => [k, num(counters[k]) ?? 0])),
    events: events.map(e => obj(e) && { atMs: num(e.atMs), from: num(e.from), to: num(e.to), cause: str(e.cause),
      periodMs: num(e.periodMs), workMs: num(e.workMs), overCount: num(e.overCount), workOverCount: num(e.workOverCount) }),
    eventsDropped: num(g.eventsDropped) ?? 0,
    frames: frames && { periodMs: frameStats(frames.periodMs), workMs: frameStats(frames.workMs), syncWaitMs: frameStats(frames.syncWaitMs) },
  };
};
/** The graphics report's `performance` block: what the perf governor did and
 *  why, the frame statistics, the last callback's synchronous waits and the
 *  drawn view's size. Pure and defensive; missing pieces become null. */
export function performanceBlock({ level = null, fpsCap = null, presentedFps = null, callbackFps = null, governor = null,
  syncWait = null, drawn = null } = {}) {
  const g = governorBlock(governor), last = obj(obj(syncWait)?.last), d = obj(drawn), trees = obj(d?.trees);
  return { level: num(level), fpsCap: num(fpsCap), presentedFps: num(presentedFps), callbackFps: num(callbackFps),
    governor: g,
    syncWait: { last: last && Object.fromEntries(SYNC_WAIT_FIELDS.map(k => [k, num(last[k])])), stats: g?.frames?.syncWaitMs ?? null },
    drawn: { viewId: str(d?.viewId), songRangeId: str(d?.songRangeId), tiles: num(d?.tiles), geometryTriangles: num(d?.geometryTriangles),
      trees: { mesh: num(trees?.mesh), billboards: num(trees?.billboards) }, mirror: flag(d?.mirror), backdrop: flag(d?.backdrop) },
    gpuTimer: null };
}
export function graphicsReport({ range = null, voxelRange = null, profile = null, presentation = null, canvas = null, gl = null,
  performance = null, env = globalThis } = {}) {
  let gpu = null;
  if (gl) {
    gpu = { contextLost: !!gl.isContextLost?.() };
    try {
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      for (const [name, token] of Object.entries({ version: gl.VERSION, shadingLanguage: gl.SHADING_LANGUAGE_VERSION,
        renderer: debug?.UNMASKED_RENDERER_WEBGL || gl.RENDERER, vendor: debug?.UNMASKED_VENDOR_WEBGL || gl.VENDOR,
        fragmentUniformVectors: gl.MAX_FRAGMENT_UNIFORM_VECTORS, vertexUniformVectors: gl.MAX_VERTEX_UNIFORM_VECTORS,
        textureSize: gl.MAX_TEXTURE_SIZE, textureUnits: gl.MAX_TEXTURE_IMAGE_UNITS })) {
        gpu[name] = gl.getParameter(token);
      }
    } catch { /* retain context-loss evidence */ }
  }
  return { version: 1, capturedAt: new Date().toISOString(),
    device: { browser: String(env.navigator?.userAgent || '').slice(0, 512), dpr: env.devicePixelRatio ?? null,
      touchPoints: env.navigator?.maxTouchPoints ?? null, deviceMemory: env.navigator?.deviceMemory ?? null,
      screen: pick(env.screen, ['width', 'height']) },
    stage: pick(canvas, ['width', 'height']),
    profile: pick(profile, ['version', 'look', 'quality', 'scaling']),
    presentation: pick(presentation, ['requestedLook', 'effectiveLook', 'rangePipeline', 'working', 'output', 'frame']),
    ...(voxelRange ? { voxelRange: pick(voxelRange, ['state', 'reason', 'viewId', 'progress', 'heardTimeMs', 'triangles', 'draws']) } : {}),
    range: range == null ? null : { ...pick(range, ['mode', 'active', 'reason', 'runtime', 'viewId', 'tourMode', 'generation']),
      failures: Object.fromEntries(Object.entries(range.failures || {}).slice(0, 16).map(([k,v]) => [k, String(v).slice(0, 1024)])),
      deferred: (range.deferred || []).slice(0, 16),
      scene: pick(range.scene, ['contextLost', 'prepared', 'pending', 'size']),
      residency: pick(range.residency, ['budget', 'budgetBytes', 'liveBytes', 'pendingBytes', 'denials', 'overcommits', 'byOwner']) }, gpu,
    performance: performance == null ? null : performanceBlock(performance) };
}
