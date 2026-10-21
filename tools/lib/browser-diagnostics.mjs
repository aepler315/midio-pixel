// Browser severity and acceptance severity are separate: Chromium reports some
// invalid WebGL draws as warnings even though those draws cannot be accepted.
const invalidGraphics = [
  /\b(?:GL_)?INVALID_(?:VALUE|OPERATION)\b/i,
  /\bshader\s+error\b/i,
  /\b(?:failed|failure|error)\b[^\n]*\b(?:compil\w*|link\w*)\b[^\n]*\b(?:shader|program)\b/i,
  /\b(?:shader|program)\b[^\n]*\b(?:compil\w*|link\w*)\b[^\n]*\b(?:failed|failure|error)\b/i,
  /\bprogram\b[^\n]*\b(?:not valid|invalid)\b|\binvalid\s+program\b/i,
  /\bwebglcontextlost\b|\bCONTEXT_LOST_WEBGL\b|\bwebgl\w*[^\n]*\bcontext\s+(?:was\s+)?lost\b/i,
];
let bridgeId = 0;

// Call after closing the context and disposing its listener bridge, immediately
// before saving the final result. Earlier checks cannot cover teardown events.
export function finalizeBrowserDiagnostics(diagnostics, report, { preserveFailure = false } = {}) {
  if (!diagnostics.errors.length) return;
  if ('status' in report) report.status = 'failed';
  if ('passed' in report) report.passed = false;
  if (preserveFailure) return;
  const error = new Error(`Browser diagnostics failed:\n${diagnostics.errors.join('\n')}`);
  report.error ??= String(error.stack || error);
  throw error;
}

// Install before navigation. isExpectedRequestFailure may return true or the
// warning explanation for a specific superseded request. The default accepts
// no failed requests.
export async function attachBrowserDiagnostics(page, diagnostics, { phase = 'startup', origin, isExpectedRequestFailure } = {}) {
  diagnostics.errors ??= [];
  diagnostics.warnings ??= [];
  diagnostics.events ??= [];
  diagnostics.loadedFiles ??= new Set();
  let active = true;
  const record = (source, message, severity, fatal, details = {}) => {
    if (!active) return;
    diagnostics.events.push({ source, message, severity, phase, fatal, ...details });
    if (fatal) diagnostics.errors.push(message);
    if (severity === 'warning') diagnostics.warnings.push(message);
  };
  const onConsole = entry => {
    const message = entry.text(), severity = entry.type();
    record('console', message, severity, severity === 'error' || invalidGraphics.some(pattern => pattern.test(message)));
  };
  const onPageError = error => record('pageerror', error.message, 'error', true);
  const onResponse = response => {
    const url = new URL(response.url());
    if (origin && url.origin !== origin) return;
    diagnostics.loadedFiles.add(url.pathname);
    const status = response.status();
    if (status >= 400) record('response', `HTTP ${status} ${url.pathname}`, 'error', true, { url: url.href, status });
  };
  const onRequestFailed = request => {
    const url = new URL(request.url());
    if (origin && url.origin !== origin) return;
    const errorText = request.failure()?.errorText;
    const expected = isExpectedRequestFailure?.(request);
    const message = typeof expected === 'string' && expected ? expected : `request failed ${url.pathname}: ${errorText}`;
    record('requestfailed', message, expected ? 'warning' : 'error', !expected,
      { url: url.href, errorText, ...(expected ? { expected: true } : {}) });
  };
  const listeners = { console: onConsole, pageerror: onPageError, response: onResponse, requestfailed: onRequestFailed };
  for (const [event, listener] of Object.entries(listeners)) page.on(event, listener);
  const bindingName = `__midioBrowserDiagnostics${++bridgeId}`;
  let binding, initScript;
  try {
    binding = await page.exposeBinding(bindingName, ({ frame }, message) => {
      record('webglcontextlost', message, 'error', true, { url: frame.url() });
    });
    initScript = await page.addInitScript(bindingName => {
      const listener = event => {
        // Context loss need not produce a console entry. Observe the canvas
        // itself: RangeScene's renderer canvas is detached from the document.
        // Do not change preventDefault or the application's recovery behavior.
        globalThis[bindingName]?.(event.statusMessage || 'WebGL context lost')?.catch(() => {});
      };
      const observed = new WeakSet(), canvases = [], wrappers = [];
      for (const prototype of [globalThis.HTMLCanvasElement?.prototype, globalThis.OffscreenCanvas?.prototype]) {
        if (!prototype) continue;
        const original = prototype.getContext;
        const wrapped = function (...args) {
          const context = Reflect.apply(original, this, args);
          if (context && ['webgl', 'webgl2', 'experimental-webgl'].includes(args[0]) && !observed.has(this)) {
            observed.add(this);
            canvases.push(new WeakRef(this));
            this.addEventListener('webglcontextlost', listener, true);
          }
          return context;
        };
        prototype.getContext = wrapped;
        wrappers.push({ prototype, original, wrapped });
      }
      globalThis[`${bindingName}Cleanup`] = () => {
        for (const { prototype, original, wrapped } of wrappers) if (prototype.getContext === wrapped) prototype.getContext = original;
        for (const reference of canvases) reference.deref()?.removeEventListener('webglcontextlost', listener, true);
      };
    }, bindingName);
  } catch (error) {
    active = false;
    for (const [event, listener] of Object.entries(listeners)) page.off(event, listener);
    await binding?.dispose();
    throw error;
  }
  return {
    setPhase(name) { phase = name; },
    async dispose() {
      active = false;
      for (const [event, listener] of Object.entries(listeners)) page.off(event, listener);
      if (!page.isClosed()) await Promise.allSettled(page.frames().map(frame => frame.evaluate(bindingName => {
        globalThis[`${bindingName}Cleanup`]?.();
        delete globalThis[`${bindingName}Cleanup`];
      }, bindingName)));
      await initScript?.dispose();
      await binding?.dispose();
    },
  };
}
