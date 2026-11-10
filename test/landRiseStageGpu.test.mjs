// Song range composition, Phase 4: the shipped SLOT_LAND_RISE_GLSL, run on a
// real WebGL2 implementation (headless Chromium, SwiftShader) through
// transform feedback, agrees with the CPU's slotSinkAt at every point the
// stage draws, and links within the vertex stage alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { SLOT_LAND_RISE_GLSL, SLOT_RISE_SLOTS, slotSinkAt } from '../src/world/alpine/LandRise.js';
import { stageSlotOwners } from '../src/world/alpine/StageAssembly.js';
import { pilotPlan } from '../src/world/terrain/SongRangePlan.js';
import MASSIF_CATALOG from '../src/world/terrain/massifCatalogData.js';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();

test('the GPU slot rise matches the CPU lift and gradient across a whole stage', {
  skip: !existsSync(executablePath) && 'Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH', timeout: 60000,
}, async () => {
  const grid = stageSlotOwners(pilotPlan('song-range-pilot-a', 'CONIFER'), MASSIF_CATALOG);
  const sinks = [0.42, 0.05, 0.61, 0.2, 0.66, 0.12, 0.33, 0.5, 0.27].slice(0, SLOT_RISE_SLOTS);
  const baseM = 2050, mean = sinks.reduce((a, b) => a + b) / sinks.length;
  let seed = 7;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const span = grid.tilesX * grid.tileM;
  const points = [];
  for (let i = 0; i < 6000; i++) {
    // A margin outside the grid checks the edge clamp too.
    points.push(grid.originM[0] - 2000 + random() * (span + 4000), 1200 + random() * 3600, grid.originM[1] - 2000 + random() * (span + 4000));
  }
  const browser = await chromium.launch({ headless: true, executablePath,
    args: ['--mute-audio', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  let out;
  try {
    const page = await browser.newPage();
    out = await page.evaluate(({ glsl, owners, nx, nz, frame, sinks, rise, points }) => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return { error: 'no WebGL2' };
      const vs = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
${glsl}
in vec3 aP;
out vec4 vOut;
void main() { vOut = vec4(riseLift(aP), riseGrad(aP)); gl_Position = vec4(0.0); }`;
      const fs = '#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(0.0); }';
      const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const prog = gl.createProgram();
      gl.attachShader(prog, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, fs));
      gl.transformFeedbackVaryings(prog, ['vOut'], gl.INTERLEAVED_ATTRIBS);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: gl.getProgramInfoLog(prog) };
      gl.useProgram(prog);
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, nx, nz, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(owners));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.uniform1i(gl.getUniformLocation(prog, 'uSlotOwner'), 0);
      gl.uniform1fv(gl.getUniformLocation(prog, 'uSlotSink'), new Float32Array(sinks));
      gl.uniform4fv(gl.getUniformLocation(prog, 'uSlotFrame'), new Float32Array(frame));
      gl.uniform2fv(gl.getUniformLocation(prog, 'uLandRise'), new Float32Array(rise));
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aP');
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      const n = points.length / 3, tfo = gl.createBuffer();
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, tfo); gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, n * 16, gl.STATIC_READ);
      const tf = gl.createTransformFeedback();
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf); gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, tfo);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, n); gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      const result = new Float32Array(n * 4);
      gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, result);
      return { result: Array.from(result), samplers: gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS), renderer: gl.getParameter(gl.RENDERER) };
    }, { glsl: SLOT_LAND_RISE_GLSL, owners: Array.from(grid.owners), nx: grid.tilesX, nz: grid.tilesZ,
      frame: [grid.originM[0], grid.originM[1], grid.tileM, 1], sinks, rise: [mean, baseM], points });
  } finally { await browser.close(); }
  assert.ok(!out.error, out.error);
  let worstLift = 0, worstGrad = 0;
  for (let i = 0; i < points.length / 3; i++) {
    const [x, y, z] = points.slice(i * 3, i * 3 + 3);
    const s = slotSinkAt(grid, sinks, x, z), above = y - baseM;
    const want = [-s.sink * above, -s.dx * above, -s.sink, -s.dz * above];
    const got = out.result.slice(i * 4, i * 4 + 4);
    worstLift = Math.max(worstLift, Math.abs(got[0] - want[0]));
    worstGrad = Math.max(worstGrad, ...[1, 2, 3].map((k) => Math.abs(got[k] - want[k])));
  }
  assert.ok(worstLift < 0.05, `lift differs by ${worstLift} m on ${out.renderer}`);
  assert.ok(worstGrad < 1e-4, `gradient differs by ${worstGrad} on ${out.renderer}`);
});
