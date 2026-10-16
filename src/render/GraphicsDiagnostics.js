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
export function graphicsReport({ range = null, profile = null, presentation = null, canvas = null, gl = null, env = globalThis } = {}) {
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
    profile: pick(profile, ['version', 'look', 'quality', 'scaling', 'palette', 'dither']),
    presentation: pick(presentation, ['requestedLook', 'effectiveLook', 'working', 'output', 'frame']),
    range: range == null ? null : { ...pick(range, ['mode', 'active', 'reason', 'runtime', 'viewId', 'tourMode', 'generation']),
      failures: Object.fromEntries(Object.entries(range.failures || {}).slice(0, 16).map(([k,v]) => [k, String(v).slice(0, 1024)])),
      deferred: (range.deferred || []).slice(0, 16),
      scene: pick(range.scene, ['contextLost', 'prepared', 'pending', 'size']),
      residency: pick(range.residency, ['budget', 'budgetBytes', 'liveBytes', 'pendingBytes', 'denials', 'overcommits', 'byOwner']) }, gpu };
}
