import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

// Run with PLAYWRIGHT_CHROMIUM_PATH when Chromium is not installed by Playwright.
// The source shader is compiled and drawn here; no CPU reimplementation is tested.
const browserPath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
test('real depth shader preserves coverage, identities, edges and continuous fixed-grid transitions',
  { skip: !existsSync(browserPath) ? 'Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH for the GPU regression' : false }, async () => {
const s = Object.create(RangeScene.prototype); s.THREE = THREE;
const { vertexShader, fragmentShader } = s._createCopy().mesh.material;
const browser = await chromium.launch({ executablePath: browserPath, headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  const results = await page.evaluate(({ vertexShader, fragmentShader }) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    const shader = (kind, source) => {
      const s = gl.createShader(kind); gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, '#version 300 es\nin vec3 position;\n' + vertexShader));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, '#version 300 es\n' + fragmentShader));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0, 3,-1,0, -1,3,0]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(p, 'position'); gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos,3,gl.FLOAT,false,0,0);
    const tex = (unit, internal, format, type, data) => {
      gl.activeTexture(gl.TEXTURE0 + unit); const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,t);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D,0,internal,8,8,0,format,type,data); return t;
    };
    const loc = name => gl.getUniformLocation(p,name);
    gl.uniform1i(loc('uColor'),0); gl.uniform1i(loc('uPixelDepth'),1); gl.uniform1i(loc('uOwn'),2);
    gl.uniform1f(loc('uUseOwn'),0); gl.uniform2f(loc('uPixelDepthSize'),8,8); gl.uniform2f(loc('uPixelCameraRange'),20,150000);
    const input = new Uint8Array(256);
    for(let y=0;y<8;y++)for(let x=0;x<8;x++)input.set([x*30,y*30,(x+y)*15,255],(y*8+x)*4);
    tex(2,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(256));
    const depthAt = metres => (150000 - 20*150000/metres)/(150000-20);
    const draw = (metres, color=input, enabled=true) => {
      const depths = new Float32Array(64);
      for(let i=0;i<64;i++)depths[i] = depthAt(typeof metres==='number'?metres:metres[i]);
      const c = tex(0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,color), d = tex(1,gl.R32F,gl.RED,gl.FLOAT,depths);
      gl.uniform1f(loc('uPixelDepthEnabled'),enabled?1:0); gl.drawArrays(gl.TRIANGLES,0,3);
      const out = new Uint8Array(256); gl.readPixels(0,0,8,8,gl.RGBA,gl.UNSIGNED_BYTE,out);
      if(gl.getError()!==gl.NO_ERROR)throw new Error('WebGL draw error');
      gl.deleteTexture(c); gl.deleteTexture(d); return Array.from(out);
    };
    const alphaInput = input.slice(); for(let i=0;i<64;i++)alphaInput[i*4+3]=i*4;
    const translucency = input.slice(); translucency[0]=250; translucency[1]=250; translucency[2]=250; translucency[3]=128;
    const farAnchor = new Array(64).fill(1000); farAnchor[0]=8000;
    const deltas = [0,.02,.03,.04,.05,.06,.07,.08,.10].map(delta=>{const d=new Array(64).fill(1000); d[0]=1000*(1+delta); return draw(d)[1*4];});
    return { input:Array.from(input), original:draw(100,input,false), distant:draw(20000), near:draw(100),
      middle:draw(3000), alphaInput:Array.from(alphaInput), alpha:draw(100,alphaInput),
      translucency:Array.from(translucency), protectedAlpha:draw(100,translucency), protectedDepth:draw(farAnchor),
      deltas, continuity:[599,600,601,2199,2200,2201,3999,4000,4001,11999,12000,12001].map(d=>({depth:d,color:draw(d)[3*4]})),
      transition:[600,1000,1400,1800,2200,4000,6000,8000,10000,12000].map(d=>({depth:d,color:draw(d)[3*4]})),
      repeatA:draw(1000), repeatB:draw(1000), renderer:gl.getParameter(gl.RENDERER) };
  }, { vertexShader, fragmentShader });
  assert.deepEqual(results.original,results.input,'Original exact identity');
  assert.deepEqual(results.distant,results.input,'Distant exact identity');
  for(let y=0;y<8;y++)for(let x=0;x<8;x++) {
    const i=(y*8+x)*4;
    assert.deepEqual(results.near.slice(i,i+4),results.input.slice((Math.floor(y/4)*4*8+Math.floor(x/4)*4)*4,(Math.floor(y/4)*4*8+Math.floor(x/4)*4)*4+4),'near 4px cells');
    assert.deepEqual(results.middle.slice(i,i+4),results.input.slice((Math.floor(y/2)*2*8+Math.floor(x/2)*2)*4,(Math.floor(y/2)*2*8+Math.floor(x/2)*2)*4+4),'middle 2px cells');
    assert.equal(results.alpha[i+3],results.alphaInput[i+3],'alpha exact');
  }
  assert.deepEqual(results.alpha,results.alphaInput,'translucent source unchanged');
  assert.deepEqual(results.protectedAlpha.slice(4,8),results.input.slice(4,8),'transparent sample cannot bleed');
  assert.deepEqual(results.protectedDepth.slice(4,8),results.input.slice(4,8),'different depth cannot bleed');
  for(let i=1;i<results.deltas.length;i++)assert.ok(results.deltas[i]>=results.deltas[i-1],'depth edge guard continuous monotonic');
  assert.ok(new Set(results.deltas).size>3,'edge guard has graded protection');
  for(let i=0;i<results.continuity.length;i+=3) assert.ok(Math.abs(results.continuity[i].color-results.continuity[i+2].color)<=1,'no hard resolution band');
  assert.ok(new Set(results.transition.map(s=>s.color)).size>5,'broad blend has intermediate samples');
  assert.deepEqual(results.repeatA,results.repeatB,'repeat has no history');
} finally { await browser.close(); }

});
