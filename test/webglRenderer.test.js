// WebGL path factory + resolve mode (MIDI restore + feature).
// No real WebGL in Node — we assert Canvas-safe construction and fallbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRendererMode, createRenderer, WebGLRenderer } from '../src/render/WebGLRenderer.js';
import { Renderer, hitTestComposerStrip } from '../src/render/Renderer.js';
import * as rendererModule from '../src/render/Renderer.js';
import fs from 'node:fs';
import vm from 'node:vm';

test('WP10 the compiled optional wash uses defined ascending smoothstep edges', () => {
  const shaders = [];
  const gl = new Proxy({
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2,
    createShader: type => ({ type }), shaderSource: (shader, source) => shaders.push({ type: shader.type, source }),
    getShaderParameter: () => true, getProgramParameter: () => true,
    createProgram: () => ({}), createBuffer: () => ({}), getAttribLocation: () => 0,
  }, { get: (target, key) => target[key] ?? (() => {}) });
  WebGLRenderer.prototype._buildProgram.call({ gl });
  const fragment = shaders.find(shader => shader.type === gl.FRAGMENT_SHADER).source;
  assert.match(fragment, /1\.0\s*-\s*smoothstep\(0\.25,\s*0\.95,\s*r\)/);
  for (const hit of fragment.matchAll(/smoothstep\(([\d.]+),\s*([\d.]+),/g)) {
    assert.ok(Number(hit[1]) < Number(hit[2]), 'every numeric smoothstep domain is ordered');
  }
});

test('resolveRendererMode defaults to canvas', () => {
  assert.equal(resolveRendererMode(''), 'canvas');
  assert.equal(resolveRendererMode('?foo=1'), 'canvas');
  assert.equal(resolveRendererMode('renderer=canvas'), 'canvas');
});

test('resolveRendererMode accepts ?renderer=webgl (case-insensitive)', () => {
  assert.equal(resolveRendererMode('?renderer=webgl'), 'webgl');
  assert.equal(resolveRendererMode('?renderer=WebGL&x=1'), 'webgl');
  assert.equal(resolveRendererMode('renderer=webgl'), 'webgl');
});

test('resolveRendererMode rejects unknown modes', () => {
  assert.equal(resolveRendererMode('?renderer=vulkan'), 'canvas');
  assert.equal(resolveRendererMode('?renderer='), 'canvas');
});

// Minimal canvas stub: createRenderer(canvas) must not throw in Node and
// must never call getContext('webgl') on the stage canvas.
function makeCanvasStub() {
  const calls = [];
  return {
    width: 1280,
    height: 720,
    parentElement: null,
    style: {},
    getContext(type, attrs) {
      calls.push({ type, attrs });
      if (type === '2d') {
        // Bare-minimum 2d context so Renderer constructor can run.
        return {
          canvas: this,
          save() {}, restore() {}, clearRect() {}, translate() {}, scale() {},
          rotate() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
          stroke() {}, fill() {}, arc() {}, createLinearGradient() {
            return { addColorStop() {} };
          },
          set fillStyle(_) {}, set strokeStyle(_) {}, set lineWidth(_) {},
          set globalAlpha(_) {}, set globalCompositeOperation(_) {},
          set lineCap(_) {}, set font(_) {}, set textAlign(_) {},
          fillText() {}, strokeText() {}, drawImage() {},
          roundRect() {}, closePath() {}, quadraticCurveTo() {},
          bezierCurveTo() {}, rect() {}, clip() {}, measureText() {
            return { width: 0 };
          },
        };
      }
      return null;
    },
    _calls: calls,
  };
}

test('createRenderer(canvas, canvas) returns stock Renderer and only uses 2d', () => {
  const canvas = makeCanvasStub();
  const r = createRenderer(canvas, 'canvas');
  assert.ok(r instanceof Renderer);
  assert.ok(canvas._calls.every((c) => c.type === '2d'));
  assert.ok(!canvas._calls.some((c) => String(c.type).startsWith('webgl')));
});

test('createRenderer(canvas, webgl) never steals WebGL context from stage canvas', () => {
  const canvas = makeCanvasStub();
  const r = createRenderer(canvas, 'webgl');
  assert.ok(r instanceof WebGLRenderer);
  // Stage canvas must only ever see '2d' (from the inner Canvas Renderer).
  assert.ok(canvas._calls.every((c) => c.type === '2d'),
    `stage context calls were ${JSON.stringify(canvas._calls)}`);
  // Without document/parent, backend falls back safely.
  assert.ok(r.backend === 'canvas-fallback' || r.backend === 'webgl' || r.backend === 'canvas');
  assert.equal(typeof r.draw, 'function');
  assert.equal(typeof r.dispose, 'function');
  r.dispose();
});

test('hudInFrame defaults off, and reaches the compositor through the WebGL wrapper', () => {
  // Bulk export switches the seekbar strip off; on the WebGL path the strip
  // is drawn by the inner canvas Renderer, so a flag that only landed on the
  // wrapper would silently leave it burned into every exported frame.
  const plain = createRenderer(makeCanvasStub(), 'canvas');
  assert.equal(plain.hudInFrame, false);
  plain.hudInFrame = false;
  assert.equal(plain.hudInFrame, false);

  const wrapped = createRenderer(makeCanvasStub(), 'webgl');
  assert.equal(wrapped.hudInFrame, false);
  wrapped.hudInFrame = false;
  assert.equal(wrapped.canvasRenderer.hudInFrame, false);
});

test('hidden seek strip rejects pointer hits and debug visibility re-enables real hit testing', () => {
  for (const mode of ['canvas', 'webgl']) {
    const renderer = createRenderer(makeCanvasStub(), mode);
    const compositor = renderer.canvasRenderer || renderer;
    const hit = { type: 'strip', tMs: 1234 };
    let calls = 0;
    compositor.composer = { hitTest: () => { calls++; return hit; } };
    renderer.hudInFrame = false;
    assert.equal(hitTestComposerStrip(renderer, 600, 680, { width: 1280, height: 720 }), null);
    assert.equal(calls, 0, 'invisible targets never capture beat taps');
    renderer.hudInFrame = true;
    assert.equal(hitTestComposerStrip(renderer, 600, 680, { width: 1280, height: 720 }), hit);
    assert.equal(calls, 1);
  }
});

test('seek reconstruction preserves explicitly visible debug strip and selected section', () => {
  const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const start = source.indexOf('function seekSong(ms) {');
  const seekSource = source.slice(start, source.indexOf('/** The player', start));
  for (const mode of ['canvas', 'webgl']) {
    const state = { running: true, paused: false, playbackPreparing: false,
      songRecorder: null, pendingCaptureOptions: null,
      sim: { songSeed: 7, conductor: { durationMs: 60000 }, showSectionLabels: true },
      audioEngine: { nowMs: 1000 }, lastTimelineData: {}, lastAudioBuffer: null,
      renderer: createRenderer(makeCanvasStub(), mode), updatePauseButtonUI() {} };
    const old = state.renderer.canvasRenderer || state.renderer;
    old.hudInFrame = true; old.composer = { selectedSection: 2 };
    state.startTimeline = () => {
      state.sim = { songSeed: 7, conductor: { durationMs: 60000 }, showSectionLabels: false };
      state.renderer = createRenderer(makeCanvasStub(), mode);
      state.renderer.draw = () => {
        const r = state.renderer.canvasRenderer || state.renderer;
        if (r.hudInFrame) r.composer = { selectedSection: -1 };
      };
    };
    vm.runInNewContext(`${seekSource}\nseekSong(2000);`, state);
    const fresh = state.renderer.canvasRenderer || state.renderer;
    assert.equal(fresh.hudInFrame, true);
    assert.equal(fresh.composer.selectedSection, 2);
    assert.equal(state.sim.showSectionLabels, true);
  }
});

test('glacial scenic flight reduces frame shake while retaining cast visibility zoom', () => {
  assert.equal(typeof rendererModule.presentationCamera, 'function');
  const camera = { shakeX: 20, shakeY: -10, roll: .02, zoom: .8 };
  const ordinary = { enabled: true, captionViewFor: () => ({ id: 'ordinary' }) };
  const glacier = { enabled: true, captionViewFor: () => ({ id: 'pilot', glacier: {} }) };
  const biomes = { currentBlend: { from: 'TAIGA', to: 'TAIGA', t: 1 } };
  assert.equal(rendererModule.presentationCamera(camera, ordinary, biomes), camera);
  const damped = rendererModule.presentationCamera(camera, glacier, biomes);
  assert.ok(Math.abs(damped.shakeX) <= 2 && Math.abs(damped.shakeY) <= 1);
  assert.ok(Math.abs(damped.roll) <= .002);
  assert.equal(damped.zoom, .8, 'character-fit zoom keeps its actual purpose');
  assert.equal(camera.shakeX, 20, 'does not mutate simulation camera');
  assert.deepEqual(rendererModule.presentationCamera(camera, glacier, biomes), damped, 'pure across redraw/seek');
});

test('Range views drop beat sway and calm drift and keep only a trace of impact shake', () => {
  const camera = { shakeX: 14, shakeY: 9, ambientX: 4, ambientY: 9, roll: .02, zoom: 1 };
  const biomes = { currentBlend: { from: 'TAIGA', to: 'TAIGA', t: 1 } };
  const range = { enabled: true, active: true, arrival: 1, captionViewFor: () => ({}) };
  const out = rendererModule.presentationCamera(camera, range, biomes);
  assert.ok(Math.abs(out.shakeX - 10 * .08) < 1e-9 && Math.abs(out.shakeY) < 1e-9);
  assert.ok(Math.abs(out.roll) <= .002);
  const arriving = rendererModule.presentationCamera(camera, { ...range, arrival: 0 }, biomes);
  assert.equal(arriving, camera, 'nothing changes before the view arrives');
  assert.equal(rendererModule.presentationCamera(camera, { ...range, active: false }, biomes), camera);
});

test('glacial foreground placement moves support, cast and pool together while ordinary scenes hold', () => {
  assert.equal(typeof rendererModule.groundPresentationOffsetY, 'function');
  assert.equal(typeof rendererModule.applyFixedGroundTransform, 'function');
  const biomes = { currentBlend: { from: 'TAIGA', to: 'TAIGA', t: 1 } };
  const glacier = { enabled: true, captionViewFor: () => ({ glacier: {} }) };
  const ordinary = { enabled: true, captionViewFor: () => ({}) };
  assert.equal(rendererModule.groundPresentationOffsetY(ordinary, biomes, 720, 614), 0);
  const offset = rendererModule.groundPresentationOffsetY(glacier, biomes, 720, 614);
  assert.ok(offset >= 100 && offset <= 115, '550px screen support moves to a narrow bottom ledge');
  const translations = [];
  const ctx = { setTransform() {}, rotate() {}, translate: (x, y) => translations.push([x, y]) };
  rendererModule.applyFixedGroundTransform(ctx, { sx: 1, sy: 1, width: 1280, height: 720,
    camera: { roll: 0, shakeX: 0, shakeY: 0 }, offsetY: offset });
  const delta = translations.reduce((sum, [, y]) => sum + y, 0);
  const support = 614 + delta, castFoot = 614 + delta, pool = 640 + delta;
  assert.ok(support > 650 && support < 670);
  assert.equal(castFoot, support);
  assert.equal(pool - support, 26, 'reflection plane remains registered to support');
  assert.equal(rendererModule.groundPresentationOffsetY(glacier, biomes, 720, 614), offset, 'pause/seek same state');
});

// --- O1: the optional wash is part of the composed, captured frame ---------
import { washEnergy } from '../src/render/WebGLRenderer.js';

function fakeGL() {
  const log = [];
  let lost = false, nextId = 0;
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, BLEND: 8,
    SRC_ALPHA: 9, ONE_MINUS_SRC_ALPHA: 10, COLOR_BUFFER_BIT: 11, TRIANGLES: 12,
    live: new Set(),
    createShader: () => ({ id: ++nextId }), shaderSource() {}, compileShader() {}, getShaderParameter: () => true, deleteShader() {},
    createProgram() { const p = { id: ++nextId, kind: 'program' }; gl.live.add(p); return p; }, attachShader() {}, linkProgram() {}, getProgramParameter: () => true,
    deleteProgram(p) { log.push('deleteProgram'); gl.live.delete(p); },
    createBuffer() { const b = { id: ++nextId, kind: 'buffer' }; gl.live.add(b); return b; }, bindBuffer() {}, bufferData() {},
    deleteBuffer(b) { log.push('deleteBuffer'); gl.live.delete(b); },
    getAttribLocation: () => 0, enableVertexAttribArray() {}, vertexAttribPointer() {}, enable() {}, blendFunc() {}, clearColor() {},
    getUniformLocation: (_p, n) => n, viewport() {}, clear() {}, useProgram() {},
    uniform1f: (n, v) => log.push([n, v]), drawArrays: () => log.push('drawArrays'),
    isContextLost: () => lost,
    lose() { lost = true; gl.live.clear(); },
    restore() { lost = false; },
  };
  return { gl, log };
}

function fakeGlCanvas(gl) {
  const listeners = {};
  return {
    width: 0, height: 0,
    getContext: (type) => (type === 'webgl2' ? gl : null),
    addEventListener: (t, f) => { (listeners[t] ||= new Set()).add(f); },
    removeEventListener: (t, f) => listeners[t]?.delete(f),
    fire: (t) => { for (const f of listeners[t] || []) f({ preventDefault() {} }); },
    listeners,
  };
}

function washRig() {
  const { gl, log } = fakeGL();
  const glCanvas = fakeGlCanvas(gl);
  const stage = makeCanvasStub();
  const r = new WebGLRenderer(stage, { createCanvas: () => glCanvas });
  const blits = [];
  const source = { width: 640, height: 360 };
  const sourceCtx = { save() {}, restore() {}, setTransform() {}, set globalAlpha(_) {}, set globalCompositeOperation(_) {},
    drawImage: (img, x, y, w, h) => blits.push({ img, x, y, w, h }) };
  // What PresentingRenderer does before each draw: point the scene at the
  // presentation's composed source.
  r.canvasRenderer.draw = function () { this.canvas = source; this.ctx = sourceCtx; };
  return { r, gl, log, glCanvas, blits, source, stage };
}

const sim = (timeMs = 1000) => ({ timeMs, heardTimeMs: timeMs, energyCurves: { sample: (b, t) => ((t / 1000 + b) % 1) } });

test('Natural frames composite the wash once into the composed source; Pixel/Palette get none', () => {
  const { r, blits, glCanvas, source, stage } = washRig();
  assert.equal(r.backend, 'webgl');
  assert.ok(stage._calls.every((c) => c.type === '2d'), 'the stage canvas never gets a WebGL context');
  r.draw(sim(), 0);
  assert.equal(blits.length, 1, 'exactly one wash per frame');
  assert.equal(blits[0].img, glCanvas);
  assert.deepEqual([blits[0].w, blits[0].h, glCanvas.width, glCanvas.height], [640, 360, 640, 360], 'sized to the source');
  assert.equal(source.width, 640);
  r.presentationPixelated = true;
  r.draw(sim(), 0);
  assert.equal(blits.length, 1, 'Pixel/Palette keep their no-wash look');
  assert.equal(r.washSkipped, 'pixel-look');
  r.dispose();
});

test('a lost context skips the wash (no stale image) and restoration rebuilds program and buffers', () => {
  const { r, gl, blits, glCanvas } = washRig();
  r.draw(sim(), 0);
  const firstProgram = r.program;
  gl.lose(); glCanvas.fire('webglcontextlost');
  r.draw(sim(1100), 0);
  assert.equal(blits.length, 1, 'no wash while lost; the canvas frame is still drawn');
  assert.equal(r.washSkipped, 'context-lost');
  gl.restore(); glCanvas.fire('webglcontextrestored');
  assert.ok(r.program && r.program !== firstProgram, 'program recreated');
  assert.ok(gl.live.has(r.program) && gl.live.has(r._vertexBuffer));
  r.draw(sim(1200), 0);
  assert.equal(blits.length, 2);
  r.dispose();
});

test('repeated loss/restore/dispose retains no GL resources or listeners', () => {
  const { r, gl, glCanvas, log } = washRig();
  for (let i = 0; i < 4; i++) { gl.lose(); glCanvas.fire('webglcontextlost'); gl.restore(); glCanvas.fire('webglcontextrestored'); }
  assert.equal(gl.live.size, 2, 'only the current program and buffer are live');
  r.dispose(); r.dispose();
  assert.equal(gl.live.size, 0);
  assert.equal(log.filter((x) => x === 'deleteProgram').length, 1, 'dead handles from lost contexts are never deleted');
  assert.equal(glCanvas.listeners.webglcontextlost.size, 0);
  assert.equal(glCanvas.listeners.webglcontextrestored.size, 0);
  // Disposed while lost: nothing is deleted against the dead context.
  const b = washRig();
  b.gl.lose(); b.glCanvas.fire('webglcontextlost');
  b.r.dispose();
  assert.equal(b.log.filter((x) => x === 'deleteProgram' || x === 'deleteBuffer').length, 0);
});

test('wash energy is a pure function of heard time, not of how often a frame is drawn', () => {
  const s = sim(4321);
  assert.equal(washEnergy(s), washEnergy(s));
  const { r, log } = washRig();
  r.draw(sim(4321), 0); r.draw(sim(4321), 0); r.draw(sim(4321), 0);
  const energies = log.filter((x) => Array.isArray(x) && x[0] === 'u_energy').map((x) => x[1]);
  assert.equal(new Set(energies).size, 1, 'a held or re-exported frame gets the same wash');
  assert.ok(energies[0] >= 0 && energies[0] <= 1);
  assert.notEqual(washEnergy(sim(4321)), washEnergy(sim(4900)));
  r.dispose();
});

test('the presenting renderer finishes a frame that already contains the wash', async () => {
  const { createPresentingRenderer } = await import('../src/render/PresentingRenderer.js');
  const { GraphicsResidency } = await import('../src/render/GraphicsResidency.js');
  const { r, blits } = washRig();
  const order = [];
  const source = { width: 640, height: 360, getContext: () => ({}) };
  const presenting = createPresentingRenderer({ canvas: {}, rendererFactory: () => r, presentation: {}, residency: new GraphicsResidency() });
  presenting.output.dispose();
  presenting.output = { presentation: { pixelated: false }, diagnostics: {},
    beginFrame: () => { order.push('begin'); return source; },
    finishFrame: () => { order.push(`finish:${blits.length}`); return { presented: true }; },
    failFrame: () => null, getCaptureSource: () => source, dispose() {} };
  presenting.draw(sim(), 0);
  assert.deepEqual(order, ['begin', 'finish:1'], 'the wash lands before the presentation finishes the frame');
  presenting.dispose();
});
