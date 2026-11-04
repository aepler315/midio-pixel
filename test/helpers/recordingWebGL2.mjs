// A no-op WebGL2 context that records indexed draws (index data, offset,
// count, instances, scissor state), and a timeline (state.ops) of program
// binds, vertex array binds and draws: enough for the vendored three.js to
// initialise and render, so a test can see exactly what a real render
// submits, and in what order.
export function recordingWebGL2(width = 300, height = 150) {
  const names = new Map(), ids = new Map();
  let next = 0x9000;
  const constant = name => {
    if (!names.has(name)) { names.set(name, next); ids.set(next, name); next++; }
    return names.get(name);
  };
  const state = { draws: [], ops: [], scissorTest: false, scissor: [0, 0, 0, 0], viewport: [0, 0, 0, 0] };
  let vao = null, boundArray = null;
  const defaultVao = { element: null };
  const params = {
    VERSION: 'WebGL 2.0', SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 3.00', VENDOR: 'test', RENDERER: 'test',
    MAX_TEXTURE_IMAGE_UNITS: 16, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
    MAX_TEXTURE_SIZE: 8192, MAX_CUBE_MAP_TEXTURE_SIZE: 8192, MAX_VERTEX_ATTRIBS: 16, MAX_VERTEX_UNIFORM_VECTORS: 1024,
    MAX_VARYING_VECTORS: 30, MAX_FRAGMENT_UNIFORM_VECTORS: 1024, MAX_SAMPLES: 4, MAX_RENDERBUFFER_SIZE: 8192,
    MAX_3D_TEXTURE_SIZE: 2048, MAX_ARRAY_TEXTURE_LAYERS: 2048, MAX_DRAW_BUFFERS: 8, MAX_COLOR_ATTACHMENTS: 8,
    MAX_UNIFORM_BUFFER_BINDINGS: 24, MAX_VIEWPORT_DIMS: new Int32Array([8192, 8192]),
  };
  const canvas = { width, height, style: {}, addEventListener() {}, removeEventListener() {} };
  const target = {
    canvas,
    drawingBufferWidth: width, drawingBufferHeight: height, drawingBufferColorSpace: 'srgb',
    getContextAttributes: () => ({ alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false }),
    getExtension: () => null, getSupportedExtensions: () => [],
    getParameter: p => {
      const n = ids.get(p);
      if (n === 'SCISSOR_BOX' || n === 'VIEWPORT') return new Int32Array([0, 0, width, height]);
      return n in params ? params[n] : 0;
    },
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    createShader: () => ({}), createProgram: () => ({}), createTexture: () => ({}), createFramebuffer: () => ({}), createRenderbuffer: () => ({}),
    createBuffer: () => ({ data: null }), createVertexArray: () => ({ element: null }),
    bindVertexArray: v => { vao = v; state.ops.push(['bindVertexArray', v]); },
    bindBuffer: (t, b) => { if (ids.get(t) === 'ELEMENT_ARRAY_BUFFER') (vao || defaultVao).element = b; else boundArray = b; },
    bufferData: (t, data) => { if (ids.get(t) === 'ELEMENT_ARRAY_BUFFER') (vao || defaultVao).element.data = data; else if (boundArray) boundArray.data = data; },
    getShaderParameter: () => true,
    getProgramParameter: (prog, p) => { const n = ids.get(p); return n === 'ACTIVE_UNIFORMS' || n === 'ACTIVE_ATTRIBUTES' ? 0 : true; },
    getShaderInfoLog: () => '', getProgramInfoLog: () => '', getShaderSource: () => '',
    getUniformLocation: () => null, getAttribLocation: () => -1, getUniformBlockIndex: () => 0,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'), isContextLost: () => false,
    enable: c => { if (ids.get(c) === 'SCISSOR_TEST') state.scissorTest = true; },
    disable: c => { if (ids.get(c) === 'SCISSOR_TEST') state.scissorTest = false; },
    scissor: (x, y, w, h) => { state.scissor = [x, y, w, h]; },
    viewport: (x, y, w, h) => { state.viewport = [x, y, w, h]; },
    drawElements: (mode, count, type, offset) => {
      state.draws.push({ index: (vao || defaultVao).element?.data, count, offset, scissorTest: state.scissorTest, scissor: [...state.scissor] });
      state.ops.push(['draw', state.draws.at(-1)]);
    },
    drawArrays: (mode, first, count) => { state.draws.push({ arrays: true, first, count }); state.ops.push(['draw', state.draws.at(-1)]); },
    drawArraysInstanced: (mode, first, count, instances) => { state.draws.push({ arrays: true, first, count, instances }); state.ops.push(['draw', state.draws.at(-1)]); },
    drawElementsInstanced: (mode, count, type, offset, instances) => {
      state.draws.push({ index: (vao || defaultVao).element?.data, count, offset, instances, scissorTest: state.scissorTest, scissor: [...state.scissor] });
      state.ops.push(['draw', state.draws.at(-1)]);
    },
    useProgram: p => { state.ops.push(['useProgram', p]); },
    getError: () => 0,
  };
  const gl = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      if (/^[A-Z0-9_]+$/.test(k)) return constant(k);
      return () => undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  canvas.getContext = () => gl;
  return { gl, canvas, state };
}
