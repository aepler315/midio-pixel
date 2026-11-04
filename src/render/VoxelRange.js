import catalog from '../world/terrain/sceneCatalogData.js';
import { createVoxelRangeScore } from '../world/alpine/VoxelRangeScore.js';

const VIEW_ID = 'white-mountains-owens';
const VIEW = catalog.views.find(view => view.id === VIEW_ID);
const CAMERA = VIEW.camera;
const PACK_URL = new URL('../assets/range/v2/voxel/white-mountains-owens.bin', import.meta.url);
const STRIDE = 8;
const PACK_LIMIT = 16 * 1024 * 1024;
const SKY = [0.38, 0.47, 0.54];

const VERTEX = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 albedo;
layout(location = 2) in vec2 lifetime;
uniform float progress;
uniform vec3 eye, right, up, forward;
uniform vec2 scale;
uniform vec3 sky;
out vec3 color;
const float near = 50.0;
const float far = 100000.0;
void main() {
  if (progress < lifetime.x || progress >= lifetime.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 point = position - eye;
  float depth = dot(point, forward);
  gl_Position = vec4(dot(point, right) * scale.x, dot(point, up) * scale.y,
    (depth * (far + near) - 2.0 * far * near) / (far - near), depth);
  color = mix(albedo, sky, smoothstep(5000.0, 44000.0, depth) * 0.65);
}`;
const FRAGMENT = `#version 300 es
precision mediump float;
in vec3 color;
out vec4 pixel;
void main() { pixel = vec4(color, 1.0); }
`;

export function voxelRangeRequested(search = '') {
  return new URLSearchParams(search).get('voxelRange') === '1';
}

export function decodeVoxelRangePack(buffer) {
  if (!buffer.byteLength || buffer.byteLength > PACK_LIMIT || buffer.byteLength % (3 * STRIDE * 4)) {
    throw new Error('Invalid voxel pack length');
  }
  const vertices = new Float32Array(buffer);
  for (let i = 0; i < vertices.length; i += STRIDE) {
    const start = vertices[i + 6], end = vertices[i + 7];
    for (let j = 0; j < STRIDE; j++) {
      const value = vertices[i + j];
      if (!Number.isFinite(value) || (j >= 3 && j <= 5 && (value < 0 || value > 1))) {
        throw new Error('Invalid voxel vertex');
      }
    }
    if (start < 0 || start > 1 || end <= start || (end > 1 && end !== 2)) {
      throw new Error('Invalid voxel vertex lifetime');
    }
    const first = i - i % (3 * STRIDE);
    if (start !== vertices[first + 6] || end !== vertices[first + 7]) {
      throw new Error('Inconsistent triangle lifetime');
    }
  }
  return vertices;
}

function shader(gl, type, source) {
  const value = gl.createShader(type);
  if (!value) throw new Error('Could not create voxel shader');
  gl.shaderSource(value, source);
  gl.compileShader(value);
  if (gl.getShaderParameter(value, gl.COMPILE_STATUS)) return value;
  const error = gl.getShaderInfoLog(value);
  gl.deleteShader(value);
  throw new Error(error || 'Could not compile voxel shader');
}

function makeProgram(gl) {
  const program = gl.createProgram();
  if (!program) throw new Error('Could not create voxel program');
  let vertex, fragment;
  try {
    vertex = shader(gl, gl.VERTEX_SHADER, VERTEX);
    fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Could not link voxel program');
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

const unit = vector => {
  const length = Math.hypot(...vector);
  return vector.map(value => value / length);
};

// One page-owned GPU buffer. The transport can rebuild its simulation on
// seeks without downloading or uploading the terrain again.
let ownerId = 0;
export class VoxelRange {
  constructor({ ownerDocument, residency }) {
    this.ownerDocument = ownerDocument;
    this.residency = residency;
    this.key = `voxel-range:${++ownerId}`;
    this.state = 'idle';
    this.draws = 0;
  }

  get status() {
    return { state: this.state, reason: this.reason ?? null, gpu: this.gpu ?? null,
      viewId: VIEW_ID, progress: this.progress ?? null, heardTimeMs: this.heardTimeMs ?? null,
      triangles: (this.vertexCount ?? 0) / 3, draws: this.draws };
  }
  get view() { return VIEW; }

  setSong(generation, sim, throughMs = 0) {
    const sameSong = generation === this.generation;
    if (sameSong && !(this.opening && !sim.analysisOpening)) return;
    const durationMs = sim.conductor.durationMs;
    const next = createVoxelRangeScore({ sections: sim.biomes.sections,
      durationMs, beatTransport: sim.songBeat });
    // Late analysis can retime the rest of the build. Keep the already-heard
    // range intact so a seek reproduces the same terrain before the handoff.
    if (sameSong && throughMs > 0) {
      const previous = this.score;
      const built = previous.progressAt(throughMs);
      const anchor = next.progressAt(throughMs);
      this.score = { progressAt(timeMs) {
        if (timeMs <= throughMs) return previous.progressAt(timeMs);
        const remaining = anchor < 1 ? (next.progressAt(timeMs) - anchor) / (1 - anchor)
          : Math.min(1, (timeMs - throughMs) / Math.max(1, durationMs - throughMs));
        return built + (1 - built) * remaining;
      } };
    } else {
      this.score = next;
    }
    this.generation = generation;
    this.opening = !!sim.analysisOpening;
  }

  prepare() {
    if (this.state === 'idle') {
      this.state = 'loading';
      this.ready = this.load().catch(error => {
        this.fail(error.message);
        return false;
      });
    }
    return this.ready;
  }

  async load() {
    const response = await fetch(PACK_URL, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Voxel pack unavailable (HTTP ${response.status})`);
    const vertices = decodeVoxelRangePack(await response.arrayBuffer());
    // Cover the buffer and the largest selectable pixel-grid color/depth target.
    const reservation = this.residency.reserve({ key: this.key, owner: 'voxel-range',
      bytes: vertices.byteLength + 640 * 360 * 8, evictable: false });
    if (!reservation) throw new Error('Voxel range graphics budget exceeded');
    try {
      const canvas = this.ownerDocument.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false,
        depth: true, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true });
      if (!gl) throw new Error('Hardware WebGL2 unavailable');
      this.canvas = canvas;
      this.gl = gl;
      canvas.addEventListener('webglcontextlost', () => this.fail('Voxel WebGL context lost'), { once: true });
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpu = gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL || gl.RENDERER);
      const program = this.program = makeProgram(gl);
      const buffer = this.buffer = gl.createBuffer();
      if (!buffer) throw new Error('Could not create voxel buffer');
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      for (const [index, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 2, 24]]) {
        gl.enableVertexAttribArray(index);
        gl.vertexAttribPointer(index, size, gl.FLOAT, false, STRIDE * 4, offset);
      }
      const eye = [CAMERA.eyeStartM[0], CAMERA.eyeStartM[1] + 525, CAMERA.eyeStartM[2]];
      const forward = unit(CAMERA.targetStartM.map((value, index) => value - eye[index]));
      const right = unit([-forward[2], 0, forward[0]]);
      const up = [-right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1]];
      for (const [name, value] of Object.entries({ eye, forward, right, up, sky: SKY })) {
        gl.uniform3fv(gl.getUniformLocation(program, name), value);
      }
      this.scale = gl.getUniformLocation(program, 'scale');
      this.reveal = gl.getUniformLocation(program, 'progress');
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.clearColor(...SKY, 1);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Voxel GPU upload failed');
      if (!this.residency.commit(reservation, buffer, () => this.releaseGpu())) throw new Error('Voxel graphics reservation expired');
      this.vertexCount = vertices.length / STRIDE;
      this.state = 'ready';
      return true;
    } catch (error) {
      this.residency.releaseReservation(reservation);
      throw error;
    }
  }

  render(heardTimeMs, width, height) {
    const { canvas, gl } = this;
    if (this.state !== 'ready') return null;
    if (gl.isContextLost()) {
      this.fail('Voxel WebGL context lost');
      return null;
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const cot = 1 / Math.tan(CAMERA.fovYDeg * Math.PI / 360);
    gl.viewport(0, 0, width, height);
    gl.uniform2f(this.scale, cot * height / width, cot);
    this.heardTimeMs = heardTimeMs;
    this.progress = this.score.progressAt(heardTimeMs);
    gl.uniform1f(this.reveal, this.progress);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    this.draws++;
    return canvas;
  }

  fail(reason) {
    this.state = 'unavailable';
    this.reason = reason;
    this.residency.release(this.key);
    this.releaseGpu();
  }

  releaseGpu() {
    if (this.buffer) this.gl.deleteBuffer(this.buffer);
    if (this.program) this.gl.deleteProgram(this.program);
    this.buffer = this.program = this.gl = this.canvas = null;
  }
}
