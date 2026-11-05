// A no-op WebGL2 context that records indexed draws (index data, offset,
// count, instances, scissor state), and a timeline (state.ops) of program
// binds, vertex array binds and draws: enough for the vendored three.js to
// initialise and render, so a test can see exactly what a real render
// submits, and in what order.
//
// With `gpu`, it also keeps what reaches the GPU. Each buffer holds a byte
// copy of its uploads (bufferData, then bufferSubData ranges), found by the
// typed array first uploaded (state.bufferOf). Programs report their vertex
// shader's `in` declarations as active attributes, so three.js binds them
// and sets their divisors per vertex array. Each instanced draw records
// state.drawing (a test sets it, e.g. in onBeforeRender), `short`: the
// enabled instanced attributes whose buffers cannot feed its instances from
// their pointers' byte offsets, which WebGL2 rejects, `reads`: by attribute
// name, the bytes its instances read through those pointers (one element per
// instance, in instance order), as the buffer held them then, and
// `pointers`: by name, each instanced pointer (divisor, stride, element size,
// byte offset, GL type, normalized, integer).
export function recordingWebGL2(width = 300, height = 150, { gpu = false } = {}) {
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
  if (gpu) recordGpu(target, { constant, ids, state, vao: () => vao || defaultVao, defaultVao });
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

const TYPE_BYTES = { BYTE: 1, UNSIGNED_BYTE: 1, SHORT: 2, UNSIGNED_SHORT: 2, HALF_FLOAT: 2, INT: 4, UNSIGNED_INT: 4, FLOAT: 4 };

function recordGpu(target, { constant, ids, state, vao, defaultVao }) {
  const bound = new Map();
  state.bufferOf = new Map();
  target.createBuffer = () => ({ data: null, bytes: null });
  const { bindBuffer, bufferData, createVertexArray, drawElementsInstanced, drawArraysInstanced } = target;
  target.bindBuffer = (t, b) => { bindBuffer(t, b); bound.set(t, b); };
  target.bufferData = (t, data, usage) => {
    bufferData(t, data, usage);
    const b = bound.get(t);
    if (!b) return;
    if (typeof data === 'number') { b.bytes = new Uint8Array(data); return; }
    b.bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    if (!state.bufferOf.has(data)) state.bufferOf.set(data, b);
  };
  target.bufferSubData = (t, dstByte, src, srcOffset = 0, length = 0) => {
    const size = src.BYTES_PER_ELEMENT || 1, n = length || src.length - srcOffset;
    bound.get(t).bytes.set(new Uint8Array(src.buffer, src.byteOffset + srcOffset * size, n * size), dstByte);
  };
  // Vertex arrays: each attribute location's buffer, element size, switch
  // and divisor.
  defaultVao.attribs = [];
  target.createVertexArray = () => Object.assign(createVertexArray(), { attribs: [] });
  // elementBytes is the pointer's stride (its element size when packed),
  // offsetBytes where its first element starts.
  const attrib = (loc) => (vao().attribs[loc] ||= { enabled: false, divisor: 0, buffer: null, elementBytes: 0, sizeBytes: 0, offsetBytes: 0 });
  target.enableVertexAttribArray = (loc) => { attrib(loc).enabled = true; };
  target.disableVertexAttribArray = (loc) => { attrib(loc).enabled = false; };
  target.vertexAttribDivisor = (loc, divisor) => { attrib(loc).divisor = divisor; };
  state.pointerCalls = 0;
  // type, normalized and integer (an IPointer) say how the shader reads it.
  const pointer = (loc, size, type, stride, offset, normalized, integer) => {
    state.pointerCalls++;
    const sizeBytes = size * TYPE_BYTES[ids.get(type)];
    return Object.assign(attrib(loc), { buffer: bound.get(constant('ARRAY_BUFFER')), elementBytes: stride || sizeBytes, sizeBytes, offsetBytes: offset || 0,
      type: ids.get(type), normalized: !!normalized, integer });
  };
  target.vertexAttribPointer = (loc, size, type, normalized, stride, offset) => pointer(loc, size, type, stride, offset, normalized, false);
  target.vertexAttribIPointer = (loc, size, type, stride, offset) => pointer(loc, size, type, stride, offset, false, true);
  // Active attributes: the vertex shader's `in` declarations, in order.
  target.createShader = (type) => ({ type, source: '' });
  target.shaderSource = (shader, source) => { shader.source = source; };
  target.createProgram = () => ({ shaders: [] });
  let program = null;
  const { useProgram } = target;
  target.useProgram = (p) => { useProgram(p); program = p; };
  target.attachShader = (program, shader) => { program.shaders.push(shader); };
  const inputs = (program) => (program.inputs ||= [...new Set([...(program.shaders.find((sh) => sh.type === constant('VERTEX_SHADER'))?.source || '')
    .matchAll(/^\s*in\s+(?:(?:highp|mediump|lowp)\s+)?(?:float|vec[234]|ivec[234]|uvec[234]|int|uint)\s+(\w+)\s*;/gm)].map((m) => m[1]))]);
  target.getProgramParameter = (program, p) => {
    const n = ids.get(p);
    return n === 'ACTIVE_ATTRIBUTES' ? inputs(program).length : n === 'ACTIVE_UNIFORMS' ? 0 : true;
  };
  target.getActiveAttrib = (program, i) => ({ name: inputs(program)[i], type: constant('FLOAT_VEC4'), size: 1 });
  target.getAttribLocation = (program, name) => inputs(program).indexOf(name);
  const note = (instances) => {
    const draw = state.draws.at(-1);
    draw.drawing = state.drawing;
    const read = (a) => Math.ceil(instances / a.divisor);
    draw.short = vao().attribs.flatMap((a, loc) => (a?.enabled && a.divisor && a.buffer && instances > 0
      && a.offsetBytes + (read(a) - 1) * a.elementBytes + a.sizeBytes > a.buffer.bytes.length ? [loc] : []));
    draw.reads = {};
    draw.pointers = {};
    const names = program ? inputs(program) : [];
    vao().attribs.forEach((a, loc) => {
      if (!a?.enabled || !a.divisor || !a.buffer?.bytes || !names[loc]) return;
      const { divisor, elementBytes, sizeBytes, offsetBytes, type, normalized, integer } = a;
      draw.pointers[names[loc]] = { divisor, elementBytes, sizeBytes, offsetBytes, type, normalized, integer };
      const k = Math.max(0, read(a)), out = new Uint8Array(k * a.sizeBytes);
      for (let i = 0; i < k; i++) {
        const at = a.offsetBytes + i * a.elementBytes;
        out.set(a.buffer.bytes.subarray(at, Math.min(at + a.sizeBytes, a.buffer.bytes.length)), i * a.sizeBytes);
      }
      draw.reads[names[loc]] = out;
    });
  };
  target.drawElementsInstanced = (mode, count, type, offset, instances) => {
    drawElementsInstanced(mode, count, type, offset, instances);
    note(instances);
  };
  target.drawArraysInstanced = (mode, first, count, instances) => {
    drawArraysInstanced(mode, first, count, instances);
    note(instances);
  };
}
