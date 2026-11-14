import catalog from '../world/terrain/sceneCatalogData.js';
import { createVoxelRangeScore } from '../world/alpine/VoxelRangeScore.js';
import { sha256Hex } from '../world/alpine/RangeAssets.js';
import voxelAsset from '../assets/range/v2/voxel/white-mountains-owens.v2.js';
import { settingValue } from '../config/appSettings.js';

const VIEW_ID = 'white-mountains-owens';
const VIEW = catalog.views.find(view => view.id === VIEW_ID);
const CAMERA = VIEW.camera;
const PACK_BASE = new URL('../assets/range/v2/voxel/', import.meta.url);
const STRIDE = 8;
const PACK_LIMIT = 256 * 1024 * 1024;
const COMPRESSED_LIMIT = 32 * 1024 * 1024;
const PACK_MAGIC = 0x32525856;
const SKY = [0.72, 0.77, 0.79];
const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const smooth = value => { const x = clamp(value); return x * x * (3 - 2 * x); };

function validateAsset(asset) {
  const pin = asset?.payload, source = asset?.source;
  if (asset?.schema !== 'midio.voxel-range' || asset.version !== 2 || asset.viewId !== VIEW_ID
    || source?.mode !== 'rail' || source.terrainManifestUrl !== VIEW.terrainManifestUrl
    || source.terrainManifestSha256 !== VIEW.terrainManifestSha256
    || !/^[a-f0-9]{64}$/.test(source.demSha256) || !/^[a-f0-9]{64}$/.test(source.terrainPayloadSha256)
    || pin?.url !== `${VIEW_ID}.v2.bin.gz` || pin.encoding !== 'gzip'
    || !Number.isSafeInteger(pin.byteLength) || pin.byteLength < 18 || pin.byteLength > COMPRESSED_LIMIT
    || !Number.isSafeInteger(pin.decodedByteLength) || pin.decodedByteLength <= 0 || pin.decodedByteLength > PACK_LIMIT || pin.decodedByteLength % 4
    || !/^[a-f0-9]{64}$/.test(pin.sha256) || !/^[a-f0-9]{64}$/.test(pin.decodedSha256)) {
    throw new Error('Invalid voxel asset source or size pins');
  }
  return pin;
}

async function readPackResponse(response, pin) {
  if (Number(response.headers.get('content-length')) > Math.max(pin.byteLength, pin.decodedByteLength)) {
    await response.body.cancel();
    throw new Error('Voxel response exceeds its size limit');
  }
  const reader = response.body.getReader();
  const chunks = [], prefix = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (let i = 0; prefix.length < 2 && i < value.length; i++) prefix.push(value[i]);
      total += value.byteLength;
      const limit = prefix[0] === 0x1f && prefix[1] === 0x8b ? pin.byteLength : pin.decodedByteLength;
      if (total > limit) throw new Error('Voxel response exceeds its size limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function inflatePack(bytes, length) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Voxel gzip decompression unavailable');
  // Admission precedes both this output and the platform's inflation buffer.
  const output = new Uint8Array(length);
  const source = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader();
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > length - offset) throw new Error('Voxel gzip exceeds its declared length');
      output.set(value, offset); offset += value.byteLength;
    }
    if (offset !== length) throw new Error('Voxel gzip decoded length differs from its declaration');
    return output;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw new Error(`Voxel gzip decoding failed: ${error.message || 'invalid stream'}`, { cause: error });
  } finally { reader.releaseLock(); }
}

const VERTEX = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 albedo;
layout(location = 2) in vec2 lifetime;
uniform float progress;
uniform vec3 eye, right, up, forward;
uniform vec2 scale;
out vec3 color;
out vec3 worldPoint;
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
  color = albedo;
  worldPoint = position;
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec3 color;
in vec3 worldPoint;
uniform vec3 eye, sky;
uniform float dissolve, dissolveSide;
out vec4 pixel;
void main() {
  float stipple = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898,78.233))) * 43758.5453);
  if (dissolveSide < -0.5 && stipple < dissolve) discard;
  if (dissolveSide > 0.5 && stipple >= dissolve) discard;
  float distanceM = length(worldPoint - eye);
  float density = 0.000025 * exp(-max(worldPoint.y - 1200.0, 0.0) * 0.00024);
  float mist = 1.0 - exp(-distanceM * density);
  vec3 haze = mix(vec3(0.75,0.73,0.66), sky, smoothstep(2500.0,16000.0,distanceM));
  pixel = vec4(mix(color, haze, mist), 1.0);
}
`;
const SKY_VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 point = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  uv = point * 0.5 + 0.5;
  gl_Position = vec4(point,0.0,1.0);
}`;
const SKY_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 uv;
out vec4 pixel;
void main() {
  float altitude = smoothstep(0.30,1.0,uv.y);
  vec3 color = mix(vec3(0.77,0.79,0.77), vec3(0.25,0.43,0.61), altitude);
  float glow = exp(-dot((uv-vec2(0.79,0.61))*vec2(1.5,2.2),(uv-vec2(0.79,0.61))*vec2(1.5,2.2))*8.0);
  pixel = vec4(color + vec3(0.10,0.075,0.035)*glow,1.0);
}`;

export function voxelRangeRequested(search) {
  return settingValue('voxelRange', search);
}

export function decodeVoxelRangePack(buffer) {
  if (!buffer.byteLength || buffer.byteLength > PACK_LIMIT || buffer.byteLength % 4) {
    throw new Error('Invalid voxel pack length');
  }
  let offset = 0, levels, cameraLiftM = 525, version = 1;
  const header = new DataView(buffer);
  if (buffer.byteLength >= 32 && header.getUint32(0, true) === PACK_MAGIC) {
    version = header.getUint32(4, true);
    const count = header.getUint32(12, true);
    offset = header.getUint32(24, true);
    cameraLiftM = header.getFloat32(16, true);
    if (version !== 2 || header.getUint32(8, true) !== STRIDE || count < 2 || count > 8
      || offset !== 32 + count * 24 || offset >= buffer.byteLength
      || !Number.isFinite(cameraLiftM) || cameraLiftM < 0 || cameraLiftM > 5000
      || header.getUint32(20, true) * STRIDE * 4 !== buffer.byteLength - offset) {
      throw new Error('Invalid voxel pack header or length');
    }
    levels = [];
    let expectedFirst = 0, previousEnd = 0;
    for (let i = 0; i < count; i++) {
      const at = 32 + i * 24;
      const firstVertex = header.getUint32(at, true), vertexCount = header.getUint32(at + 4, true);
      const cellSizeM = header.getFloat32(at + 8, true);
      const startProgress = header.getFloat32(at + 12, true), endProgress = header.getFloat32(at + 16, true);
      const kind = header.getUint32(at + 20, true);
      if (firstVertex !== expectedFirst || !vertexCount || vertexCount % 3 || !Number.isFinite(cellSizeM) || cellSizeM <= 0
        || !Number.isFinite(startProgress) || !Number.isFinite(endProgress) || startProgress < previousEnd
        || endProgress > 1 || (i ? endProgress <= startProgress : startProgress !== 0 || endProgress !== 0)
        || kind > 1) throw new Error('Invalid voxel level');
      levels.push({ firstVertex, vertexCount, cellSizeM, startProgress, endProgress, kind: kind ? 'smooth' : 'columns' });
      expectedFirst += vertexCount; previousEnd = endProgress;
    }
    if (expectedFirst !== header.getUint32(20, true)) throw new Error('Invalid voxel level length');
  }
  if ((buffer.byteLength - offset) % (3 * STRIDE * 4)) throw new Error('Invalid voxel pack length');
  const vertices = new Float32Array(buffer, offset);
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
  levels ||= [{ firstVertex: 0, vertexCount: vertices.length / STRIDE, cellSizeM: 500,
    startProgress: 0, endProgress: 0, kind: 'columns' }];
  return { vertices, levels, cameraLiftM, version };
}

/** The camera, detail and raster follow the same seekable song progress. */
export function voxelRangeFrameState(progress, outputWidth = 1280, outputHeight = 720, cameraLiftM = 525) {
  const journey = smooth((clamp(progress) - .025) / .975);
  const detail = smooth((clamp(progress) - .05) / .9);
  const outputScale = Math.min(1, 1280 / Math.max(1, outputWidth), 720 / Math.max(1, outputHeight));
  const maxWidth = Math.max(2, Math.floor(outputWidth * outputScale / 2) * 2);
  const maxHeight = Math.max(2, Math.floor(outputHeight * outputScale / 2) * 2);
  const initialWidth = Math.min(320, maxWidth);
  const width = detail >= 1 ? maxWidth : Math.max(2, Math.floor((initialWidth + (maxWidth - initialWidth) * detail) / 16) * 16);
  const height = Math.max(2, Math.round(width * maxHeight / maxWidth));
  const lerp = (a, b) => a.map((value, index) => value + (b[index] - value) * journey);
  const eyeM = lerp(CAMERA.eyeStartM, CAMERA.eyeEndM);
  eyeM[1] += cameraLiftM;
  return { width, height, detail, camera: { eyeM, targetM: lerp(CAMERA.targetStartM, CAMERA.targetEndM),
    fovYDeg: CAMERA.fovYDeg * (.65 + .35 * journey) } };
}

export function voxelRangeLayersAt(progress, levels) {
  for (let index = 1; index < levels.length; index++) {
    const level = levels[index];
    if (progress < level.startProgress) return [{ index: index - 1, weight: 1 }];
    if (progress < level.endProgress) {
      const blend = smooth((progress - level.startProgress) / (level.endProgress - level.startProgress));
      return [{ index: index - 1, weight: 1 - blend }, { index, weight: blend }];
    }
  }
  return [{ index: levels.length - 1, weight: 1 }];
}

/** Complete the physical build before dissolving its walls into smooth DEM. */
export function voxelRangeGrowthProgress(progress, version = 2) {
  return version < 2 ? clamp(progress) : .025 + .975 * clamp((progress - .025) / (.84 - .025));
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

function makeProgram(gl, vertexSource = VERTEX, fragmentSource = FRAGMENT) {
  const program = gl.createProgram();
  if (!program) throw new Error('Could not create voxel program');
  let vertex, fragment;
  try {
    vertex = shader(gl, gl.VERTEX_SHADER, vertexSource);
    fragment = shader(gl, gl.FRAGMENT_SHADER, fragmentSource);
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
  constructor({ ownerDocument, residency, asset = voxelAsset }) {
    this.ownerDocument = ownerDocument;
    this.residency = residency;
    this.asset = asset;
    this.key = `voxel-range:${++ownerId}`;
    this.state = 'idle';
    this.draws = 0;
  }

  get status() {
    return { state: this.state, reason: this.reason ?? null, gpu: this.gpu ?? null,
      viewId: VIEW_ID, progress: this.progress ?? null, heardTimeMs: this.heardTimeMs ?? null,
      growthProgress: this.growthProgress ?? null,
      triangles: (this.vertexCount ?? 0) / 3, draws: this.draws, packVersion: this.packVersion ?? null,
      raster: this.canvas ? { width: this.canvas.width, height: this.canvas.height } : null,
      activeLevels: this.activeLevels ?? [], camera: this.frameState?.camera ?? null };
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
    const pin = validateAsset(this.asset);
    const response = await fetch(new URL(pin.url, PACK_BASE), { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Voxel pack unavailable (HTTP ${response.status})`);
    const compressed = await readPackResponse(response, pin);
    const gzip = compressed[0] === 0x1f && compressed[1] === 0x8b;
    if (gzip && compressed.length < 18) throw new Error('Invalid voxel gzip length');
    const decodedLength = pin.decodedByteLength;
    if (compressed.byteLength !== (gzip ? pin.byteLength : decodedLength)) throw new Error('Voxel payload length differs from its pin');
    if (gzip && new DataView(compressed.buffer).getUint32(compressed.length - 4, true) !== decodedLength) {
      throw new Error('Voxel gzip decoded length differs from its pin');
    }
    const staging = this.residency.reserve({ key: `${this.key}:decode`, owner: 'voxel-range-decode',
      bytes: compressed.byteLength + (gzip ? decodedLength : 0) + 65536, evictable: false });
    if (!staging) throw new Error('Voxel range decode budget exceeded');
    let reservation;
    try {
      const responseHash = await sha256Hex(compressed);
      if (responseHash !== (gzip ? pin.sha256 : pin.decodedSha256)) throw new Error('Voxel payload hash mismatch');
      // Keep staging charged while the GPU copy exists during upload.
      reservation = this.residency.reserve({ key: this.key, owner: 'voxel-range',
        bytes: decodedLength + 1280 * 720 * 8, evictable: false });
      if (!reservation) throw new Error('Voxel range graphics budget exceeded');
      const bytes = gzip ? await inflatePack(compressed, decodedLength) : compressed;
      if (gzip && await sha256Hex(bytes) !== pin.decodedSha256) throw new Error('Voxel decoded payload hash mismatch');
      const decoded = decodeVoxelRangePack(bytes.buffer);
      const { vertices } = decoded;
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
      this.skyProgram = makeProgram(gl, SKY_VERTEX, SKY_FRAGMENT);
      const buffer = this.buffer = gl.createBuffer();
      if (!buffer) throw new Error('Could not create voxel buffer');
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      for (const [index, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 2, 24]]) {
        gl.enableVertexAttribArray(index);
        gl.vertexAttribPointer(index, size, gl.FLOAT, false, STRIDE * 4, offset);
      }
      gl.uniform3fv(gl.getUniformLocation(program, 'sky'), SKY);
      this.cameraUniforms = Object.fromEntries(['eye', 'forward', 'right', 'up'].map(name => [name, gl.getUniformLocation(program, name)]));
      this.scale = gl.getUniformLocation(program, 'scale');
      this.reveal = gl.getUniformLocation(program, 'progress');
      this.dissolve = gl.getUniformLocation(program, 'dissolve');
      this.dissolveSide = gl.getUniformLocation(program, 'dissolveSide');
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.clearColor(...SKY, 1);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Voxel GPU upload failed');
      if (!this.residency.commit(reservation, buffer, () => this.releaseGpu())) throw new Error('Voxel graphics reservation expired');
      this.vertexCount = vertices.length / STRIDE;
      this.levels = decoded.levels;
      this.cameraLiftM = decoded.cameraLiftM;
      this.packVersion = decoded.version;
      this.state = 'ready';
      return true;
    } catch (error) {
      this.residency.releaseReservation(reservation);
      this.releaseGpu();
      throw error;
    } finally { this.residency.releaseReservation(staging); }
  }

  render(heardTimeMs, width, height) {
    const { canvas, gl } = this;
    if (this.state !== 'ready') return null;
    if (gl.isContextLost()) {
      this.fail('Voxel WebGL context lost');
      return null;
    }
    this.heardTimeMs = heardTimeMs;
    this.progress = this.score.progressAt(heardTimeMs);
    const state = this.frameState = voxelRangeFrameState(this.progress, width, height, this.cameraLiftM);
    if (canvas.width !== state.width || canvas.height !== state.height) {
      canvas.width = state.width;
      canvas.height = state.height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.useProgram(this.skyProgram);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
    gl.useProgram(this.program);
    const eye = state.camera.eyeM;
    const forward = unit(state.camera.targetM.map((value, index) => value - eye[index]));
    const right = unit([-forward[2], 0, forward[0]]);
    const up = [-right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1]];
    for (const [name, value] of Object.entries({ eye, forward, right, up })) gl.uniform3fv(this.cameraUniforms[name], value);
    const cot = 1 / Math.tan(state.camera.fovYDeg * Math.PI / 360);
    gl.uniform2f(this.scale, cot * canvas.height / canvas.width, cot);
    this.growthProgress = voxelRangeGrowthProgress(this.progress, this.packVersion);
    gl.uniform1f(this.reveal, this.growthProgress);
    const layers = voxelRangeLayersAt(this.progress, this.levels);
    this.activeLevels = layers.map(layer => ({ ...layer, kind: this.levels[layer.index].kind,
      cellSizeM: this.levels[layer.index].cellSizeM }));
    for (const [index, layer] of layers.entries()) {
      gl.uniform1f(this.dissolve, layers.length === 1 ? 0 : layers[1].weight);
      gl.uniform1f(this.dissolveSide, layers.length === 1 ? 0 : index ? 1 : -1);
      const level = this.levels[layer.index];
      gl.drawArrays(gl.TRIANGLES, level.firstVertex, level.vertexCount);
    }
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
    if (this.skyProgram) this.gl.deleteProgram(this.skyProgram);
    this.buffer = this.program = this.skyProgram = this.gl = this.canvas = null;
  }
}
