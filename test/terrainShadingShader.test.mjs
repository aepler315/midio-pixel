import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { MORAN_SHADING_GLSL } from '../src/world/alpine/TerrainShadingExperiment.js';

const browserPath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
test('actual Moran GLSL keeps snow endpoints, continuous edges and geographic bounds',
  { skip: !existsSync(browserPath) ? 'Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH' : false }, async () => {
    const browser = await chromium.launch({ executablePath: browserPath,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(source => {
        const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 1;
        const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
        if (!gl) throw new Error('WebGL2 unavailable');
        const shader = (type, text) => {
          const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
          return s;
        };
        const p = gl.createProgram();
        gl.attachShader(p, shader(gl.VERTEX_SHADER, `#version 300 es
          void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}`));
        gl.attachShader(p, shader(gl.FRAGMENT_SHADER, `#version 300 es
          precision highp float;
          uniform vec3 position; uniform float curvature, footprint;
          out vec4 color;
          ${source}
          void main(){float snow=(gl_FragCoord.x-.5)/255.;
            color=vec4(moranSnow(snow,curvature,footprint),moranSubject(position),0.,1.);}`));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        gl.useProgram(p);
        const draw = (position, curvature, footprint) => {
          gl.uniform3fv(gl.getUniformLocation(p, 'position'), position);
          gl.uniform1f(gl.getUniformLocation(p, 'curvature'), curvature);
          gl.uniform1f(gl.getUniformLocation(p, 'footprint'), footprint);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          const bytes = new Uint8Array(256 * 4); gl.readPixels(0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
          if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL draw error');
          return Array.from(bytes);
        };
        const centre = [-6128.6, 3800, -558.4];
        return {
          ramps: [-1, 0, 1].flatMap(c => [.01, .2, 1].map(f => draw(centre, c, f))),
          bounds: [centre, [-6128.6, 2900, -558.4], [-9500, 3800, -558.4], [0, 3800, 0]].map(p => draw(p, 0, .1)[1]),
          fade: Array.from({ length: 65 }, (_, i) => draw([-6128.6 + 1500 + i * 20, 3800, -558.4], 0, .1)[1]),
        };
      }, MORAN_SHADING_GLSL);
      for (const ramp of result.ramps) {
        assert.equal(ramp[0], 0, 'bare rock must remain snow-free at every footprint');
        assert.equal(ramp[255 * 4], 255, 'full snow must remain full snow');
        for (let i = 4; i < ramp.length; i += 4) {
          assert.ok(ramp[i] >= ramp[i - 4], 'coverage is monotonic');
          assert.ok(ramp[i] - ramp[i - 4] <= 3, 'no hard material threshold');
        }
      }
      assert.deepEqual(result.bounds, [255, 0, 0, 0], 'only the selected high mountain is included');
      for (let i = 1; i < result.fade.length; i++) {
        assert.ok(result.fade[i] <= result.fade[i - 1], 'geographic boundary fades out');
        assert.ok(result.fade[i - 1] - result.fade[i] <= 9, 'no abrupt patch boundary');
      }
    } finally { await browser.close(); }
  });
