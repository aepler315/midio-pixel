// The frame cost instrument's in-page counters (tools/range-frame-cost.mjs),
// run against recording stand-ins for the browser's context prototypes: what
// a draw, an upload, a filtered 2D operation and a waiting call are counted
// as, and what a dry run skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installCounters, passTable, mainThreadMs } from '../tools/range-frame-cost.mjs';

const GLOBALS = ['window', 'WebGL2RenderingContext', 'WebGLRenderingContext', 'CanvasRenderingContext2D', 'OffscreenCanvasRenderingContext2D',
  'HTMLCanvasElement', 'OffscreenCanvas'];

/** Install the counters over fake prototypes; returns the pieces and a restore(). */
function counters(options) {
  const saved = Object.fromEntries(GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const calls = [];
  const recording = (names) => {
    const Type = class {};
    for (const name of names) Type.prototype[name] = function (...a) { calls.push([name, a]); return name === 'getError' ? 0 : undefined; };
    return Type;
  };
  const GL2 = recording(['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'uniform1f', 'uniformMatrix4fv', 'useProgram',
    'bindFramebuffer', 'clear', 'texImage2D', 'texSubImage2D', 'bufferData', 'bufferSubData', 'readPixels', 'getBufferSubData', 'blitFramebuffer', 'getError']);
  GL2.prototype.getExtension = () => null;
  const GL1 = recording(['drawArrays', 'texImage2D', 'getError']);
  const D2 = recording(['fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'putImageData', 'getImageData']);
  const Canvas = class { getContext(type) { return type === '2d' ? new D2() : type === 'webgl' ? new GL1() : new GL2(); } };
  Object.assign(globalThis, { window: {}, WebGL2RenderingContext: GL2, WebGLRenderingContext: GL1, CanvasRenderingContext2D: D2,
    OffscreenCanvasRenderingContext2D: recording(['fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'putImageData', 'getImageData']),
    HTMLCanvasElement: Canvas, OffscreenCanvas: class { getContext() { return null; } } });
  installCounters(options);
  const C = globalThis.window.__gl;
  const restore = () => {
    for (const k of GLOBALS) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; }
  };
  return { C, calls, gl: new GL2(), gl1: new GL1(), ctx: new D2(), Canvas, restore };
}

test('uploads count the bytes of their source, never the destination offset', () => {
  const { C, gl, restore } = counters();
  try {
    const ARRAY_BUFFER = 0x8892, STATIC_DRAW = 0x88e4;
    gl.bufferSubData(ARRAY_BUFFER, 0, new Float32Array(100));
    assert.equal(C.by.other.bufferUploadBytes, 400, 'a 400-byte upload at offset 0');
    gl.bufferSubData(ARRAY_BUFFER, 4096, new Uint8Array(8));
    assert.equal(C.by.other.bufferUploadBytes, 408, 'an 8-byte upload at offset 4096');
    gl.bufferSubData(ARRAY_BUFFER, 64, new Float32Array(100), 10, 20);
    assert.equal(C.by.other.bufferUploadBytes, 488, '20 floats from element 10');
    gl.bufferSubData(ARRAY_BUFFER, 64, new Float32Array(100), 10);
    assert.equal(C.by.other.bufferUploadBytes, 848, 'from element 10 to the end');
    gl.bufferSubData(ARRAY_BUFFER, 8, new ArrayBuffer(24));
    assert.equal(C.by.other.bufferUploadBytes, 872, 'a plain ArrayBuffer');
    gl.bufferData(ARRAY_BUFFER, 1024, STATIC_DRAW);
    gl.bufferData(ARRAY_BUFFER, new Uint16Array(6), STATIC_DRAW);
    gl.bufferData(ARRAY_BUFFER, new Float32Array(100), STATIC_DRAW, 50, 10);
    assert.equal(C.by.other.bufferUploadBytes, 872 + 1024 + 12 + 40, 'bufferData by size, by view, and by a view range');
    assert.equal(C.by.other.bufferUploads, 8);
  } finally { restore(); }
});

test('draws count triangles, with instanced triangles apart, under the current pass label', () => {
  const { C, gl, calls, restore } = counters();
  try {
    gl.drawElements(4, 300, 0x1405, 0);
    gl.drawArrays(5, 0, 10);
    C.labels.push('mirror');
    gl.drawElementsInstanced(4, 6, 0x1405, 0, 50);
    gl.drawArraysInstanced(4, 0, 9, 4);
    gl.uniform1f(null, 1); gl.uniformMatrix4fv(null, false, []);
    C.labels.pop();
    assert.deepEqual([C.by.other.draws, C.by.other.triangles, C.by.other.instancedTriangles], [2, 108, 0]);
    assert.deepEqual([C.by.mirror.draws, C.by.mirror.triangles, C.by.mirror.instancedTriangles, C.by.mirror.instancedDraws, C.by.mirror.uniformCalls], [2, 112, 112, 2, 2]);
    assert.equal(calls.filter(([name]) => name.startsWith('draw')).length, 4, 'a full run issues every draw');
    const table = passTable({ passes: C.by });
    assert.deepEqual(table.total, { draws: 4, triangles: 220, instancedTriangles: 112, uniformCalls: 2 });
    assert.match(table.text.split('\n')[0], /^ {2}mirror/, 'heaviest pass first');
    C.reset();
    assert.deepEqual(C.by, {});
  } finally { restore(); }
});

test('a dry run counts draws and filtered 2D operations and issues neither', () => {
  const { C, gl, gl1, ctx, calls, restore } = counters({ dry: true });
  try {
    gl.drawElements(4, 300, 0x1405, 0);
    gl.drawElementsInstanced(4, 6, 0x1405, 0, 50);
    gl1.drawArrays(4, 0, 3);
    ctx.filter = 'blur(2.9px)';
    ctx.fillRect(0, 0, 1, 1); ctx.fill(); ctx.drawImage({}, 0, 0);
    ctx.filter = 'none';
    ctx.fillRect(0, 0, 1, 1);
    gl.clear(0x4000); gl.bufferSubData(0x8892, 0, new Uint8Array(4));
    assert.deepEqual([C.by.other.draws, C.by.other.triangles, C.presenter.draws], [2, 200, 1]);
    assert.deepEqual([C.canvas2d.ops, C.canvas2d.filteredOps, C.canvas2d.drawImage], [4, 3, 1]);
    assert.deepEqual(calls.map(([name]) => name), ['fillRect', 'clear', 'bufferSubData'], 'state changes, uploads and unfiltered 2D still run');
  } finally { restore(); }
});

test('calls that wait for rendering are timed by kind; the presenter stays out of the scene counts', () => {
  const { C, gl, gl1, ctx, Canvas, restore } = counters();
  try {
    const glCanvas = new Canvas();
    glCanvas.getContext('webgl2');
    ctx.drawImage(glCanvas, 0, 0);
    ctx.drawImage({}, 0, 0);
    ctx.getImageData(0, 0, 1, 1);
    gl.readPixels(0, 0, 1, 1, 0, 0, null);
    gl.texSubImage2D(0, 0, 0, 0, 0, 0, glCanvas);
    gl1.texImage2D(0, 0, 0, 0, 0, glCanvas); gl1.drawArrays(4, 0, 3); gl1.getError();
    assert.deepEqual(Object.keys(C.waits).sort(),
      ['2d.drawImage(gl canvas)', '2d.getImageData', 'gl.readPixels', 'gl.texSubImage2D(canvas)', 'gl1.getError', 'gl1.texImage2D(canvas)']);
    for (const w of Object.values(C.waits)) assert.equal(w.calls, 1);
    assert.deepEqual(C.presenter, { draws: 1, textureUploads: 1, getErrorCalls: 1 });
    assert.deepEqual([C.canvas2d.drawImage, C.canvas2d.drawImageFromGL, C.canvas2d.getImageData, C.canvas2d.ops], [2, 1, 1, 2]);
    assert.deepEqual([C.by.other.draws, C.by.other.readbacks, C.by.other.textureUploads], [0, 1, 1], 'no presenter draw in the scene passes');
  } finally { restore(); }
});

test('time outside waits is the frame minus its waiting calls', () => {
  assert.equal(mainThreadMs({ hostMs: 700, waits: { 'gl.readPixels': { calls: 1, ms: 640 }, 'gl1.getError': { calls: 1, ms: 18 } } }), 42);
  assert.equal(mainThreadMs({ hostMs: 12, waits: {} }), 12);
});
