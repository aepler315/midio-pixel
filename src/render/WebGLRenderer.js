// Optional WebGL render path for Super Maudio World.
//
// SAFETY CONTRACT:
//   - NEVER calls getContext('webgl*') on the main #stage canvas. That would
//     permanently steal the 2D context and kill the Canvas Renderer (which is
//     how the whole show is drawn).
//   - Scene composition always goes through the existing Canvas 2D Renderer.
//   - When WebGL is available, an OFFSCREEN canvas renders a cheap
//     energy-driven wash (tint / vignette) which is composited once into the
//     same composed source the presentation finishes. Display and capture
//     (recordings, exports) therefore show the same wash; Pixel/Palette get
//     none. Nothing is layered over the stage in the DOM.
//   - The wash's energy is a pure function of heard time and song state, so
//     exports, held frames and seeks agree with live playback.
//   - Context loss skips the wash (the frame stays current, never stale);
//     restoration rebuilds the program and buffers. When WebGL is missing or
//     fails to init, draw() is a pure Canvas passthrough.
//
// Toggle with ?renderer=webgl (or createRenderer(canvas, 'webgl')).

import { Renderer } from './Renderer.js';

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform float u_time;
uniform float u_energy;
uniform float u_hue;
out vec4 outColor;
void main() {
  vec2 c = v_uv - 0.5;
  float r = length(c);
  float vig = 1.0 - smoothstep(0.25, 0.95, r);
  float pulse = 0.55 + 0.45 * sin(u_time * 2.4 + r * 6.0);
  float a = (0.04 + 0.12 * u_energy) * vig * pulse;
  // Soft hue wash — additive feel via low alpha over the canvas below.
  float h = u_hue / 360.0;
  vec3 col = 0.5 + 0.5 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67)));
  outColor = vec4(col, a);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(info || 'shader compile failed');
  }
  return sh;
}

function link(gl, vs, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(info || 'program link failed');
  }
  return prog;
}

/** Wash energy at heard time: the strongest of the hype/vibe state and a
 *  short, decaying look-back over the band energies. No per-draw smoothing,
 *  so the same heard time gives the same wash however often it is drawn. */
export function washEnergy(sim) {
  let e = 0;
  if (sim?.hype) e = Math.max(e, sim.hype.fast || 0, sim.hype.slam || 0, (sim.hype.surge || 0) * 0.8);
  if (sim?.vibe) e = Math.max(e, sim.vibe.epic || 0);
  const curves = sim?.energyCurves;
  if (curves && typeof curves.sample === 'function') {
    try {
      const t = sim.heardTimeMs ?? sim.timeMs ?? 0;
      let sum = 0, weights = 0;
      for (let k = 0; k < 8; k++) {
        const w = Math.exp(-k * 50 / 110);
        let bands = 0;
        for (let b = 0; b < 7; b++) bands += curves.sample(b, Math.max(0, t - k * 50)) || 0;
        sum += w * bands / 7; weights += w;
      }
      e = Math.max(e, sum / weights);
    } catch { /* ignore */ }
  }
  return Math.max(0, Math.min(1, e));
}

/** Halo hue (degrees) from the active biome, or `fallback`. */
export function washHue(sim, fallback = 210) {
  const hex = sim?.biomes?.currentHaloColor?.();
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d <= 1e-6) return fallback;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * @param {HTMLCanvasElement} canvas main #stage (must stay Canvas 2D)
 * @param {{ preferWebGL?: boolean, createCanvas?: () => HTMLCanvasElement }} [opts]
 */
export class WebGLRenderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.canvasRenderer = new Renderer(canvas);
    this.preferWebGL = opts.preferWebGL !== false;
    this._createCanvas = opts.createCanvas
      || (typeof document !== 'undefined' ? () => document.createElement('canvas') : null);
    this.glCanvas = null;
    this.gl = null;
    this.program = null;
    this.backend = 'canvas'; // 'webgl' | 'canvas' | 'canvas-fallback'
    this._hue = 210;
    this._disposed = false;
    this.contextLost = false;
    // Evidence: frames that received the wash, and why the last one did not.
    this.washFrames = 0;
    this.washSkipped = null;

    if (this.preferWebGL) this._tryInitWebGL();
  }

  get enabled() {
    return this.backend === 'webgl';
  }

  /** The HUD strip is drawn by the canvas compositor underneath, so the
   *  switch has to reach it rather than land on this wrapper. */
  get hudInFrame() { return this.canvasRenderer.hudInFrame; }

  set hudInFrame(on) { this.canvasRenderer.hudInFrame = !!on; }

  _tryInitWebGL() {
    if (!this._createCanvas) {
      this.backend = 'canvas-fallback';
      return;
    }
    try {
      const glCanvas = this._createCanvas();
      glCanvas.width = this.canvas.width;
      glCanvas.height = this.canvas.height;
      const gl = glCanvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
      });
      if (!gl) {
        this.backend = 'canvas-fallback';
        return;
      }
      this.glCanvas = glCanvas;
      this.gl = gl;
      this._onLost = (e) => {
        e?.preventDefault?.(); // allow restoration
        this.contextLost = true;
        // Handles from the lost context are dead; never delete them later.
        this.program = null;
        this._vertexBuffer = null;
      };
      this._onRestored = () => {
        this.contextLost = false;
        try { this._buildProgram(); } catch (err) {
          console.warn('[WebGLRenderer] restore failed, using Canvas only:', err?.message || err);
          this.backend = 'canvas-fallback';
        }
      };
      glCanvas.addEventListener?.('webglcontextlost', this._onLost);
      glCanvas.addEventListener?.('webglcontextrestored', this._onRestored);
      this._buildProgram();
      this.backend = 'webgl';
    } catch (err) {
      console.warn('[WebGLRenderer] init failed, using Canvas only:', err?.message || err);
      this._teardownGL();
      this.backend = 'canvas-fallback';
    }
  }

  /** Program, quad buffer and blend state, in the current context. */
  _buildProgram() {
    const gl = this.gl;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = link(gl, vs, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this._vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ]), gl.STATIC_DRAW);

    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    this.program = program;
    this._uTime = gl.getUniformLocation(program, 'u_time');
    this._uEnergy = gl.getUniformLocation(program, 'u_energy');
    this._uHue = gl.getUniformLocation(program, 'u_hue');
  }

  _syncSize(target) {
    if (this.glCanvas.width !== target.width || this.glCanvas.height !== target.height) {
      this.glCanvas.width = target.width;
      this.glCanvas.height = target.height;
    }
  }

  get composer() { return this.canvasRenderer.composer; }
  set composer(value) { this.canvasRenderer.composer = value; }

  get drawCount() { return this.canvasRenderer?.drawCount ?? 0; }
  get rangePresentation() { return this.canvasRenderer?.rangePresentation ?? null; }
  set rangePresentation(p) { if (this.canvasRenderer) this.canvasRenderer.rangePresentation = p; }

  /** Same interface as Renderer.draw: draws the Canvas scene, then (Natural
   *  look, live context) composites the wash once into that same source --
   *  the canvas the presenting renderer finishes and capture reads. */
  draw(sim, alpha) {
    this.canvasRenderer.draw(sim, alpha);
    if (this.backend !== 'webgl' || !this.gl || this._disposed) return;
    if (this.presentationPixelated) { this.washSkipped = 'pixel-look'; return; }
    const gl = this.gl;
    if (this.contextLost || !this.program || gl.isContextLost?.()) { this.washSkipped = 'context-lost'; return; }
    const target = this.canvasRenderer.canvas, ctx = this.canvasRenderer.ctx;
    if (!target || !ctx || !(target.width > 0 && target.height > 0)) { this.washSkipped = 'no-source'; return; }
    try {
      this._syncSize(target);
      this._hue = washHue(sim, this._hue);
      gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.uniform1f(this._uTime, (sim?.heardTimeMs ?? sim?.timeMs ?? 0) / 1000);
      gl.uniform1f(this._uEnergy, washEnergy(sim));
      gl.uniform1f(this._uHue, this._hue);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      // A context lost during the draw leaves nothing worth compositing.
      if (gl.isContextLost?.()) { this.washSkipped = 'context-lost'; return; }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(this.glCanvas, 0, 0, target.width, target.height);
      ctx.restore();
      this.washFrames++;
      this.washSkipped = null;
    } catch (err) {
      // The composed frame is still this frame's scene, just without wash.
      this.washSkipped = 'wash-failed';
      console.warn('[WebGLRenderer] wash skipped:', err?.message || err);
    }
  }

  _teardownGL() {
    if (this.glCanvas) {
      this.glCanvas.removeEventListener?.('webglcontextlost', this._onLost);
      this.glCanvas.removeEventListener?.('webglcontextrestored', this._onRestored);
    }
    const live = this.gl && !this.contextLost && !this.gl.isContextLost?.();
    if (live && this._vertexBuffer) {
      try { this.gl.deleteBuffer(this._vertexBuffer); } catch { /* ignore */ }
    }
    if (live && this.program) {
      try { this.gl.deleteProgram(this.program); } catch { /* ignore */ }
    }
    if (this.glCanvas) { this.glCanvas.width = 0; this.glCanvas.height = 0; }
    this._vertexBuffer = null;
    this._onLost = null;
    this._onRestored = null;
    this.glCanvas = null;
    this.gl = null;
    this.program = null;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._teardownGL();
    this.canvasRenderer.dispose();
  }
}

/**
 * Factory used by main.js. mode: 'canvas' | 'webgl'
 * Canvas mode returns the stock Renderer; webgl mode returns WebGLRenderer
 * (which itself falls back to Canvas scene drawing if GL is unavailable).
 *
 */
export function createRenderer(canvas, mode = 'canvas') {
  if (mode === 'webgl') return new WebGLRenderer(canvas, { preferWebGL: true });
  return new Renderer(canvas);
}

/** Resolve renderer mode from URL (?renderer=webgl) or explicit override. */
export function resolveRendererMode(search = (typeof location !== 'undefined' ? location.search : '')) {
  try {
    const raw = search || '';
    const q = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
    const m = (q.get('renderer') || 'canvas').toLowerCase();
    return m === 'webgl' ? 'webgl' : 'canvas';
  } catch {
    return 'canvas';
  }
}
