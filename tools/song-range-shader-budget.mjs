// Uniform and sampler cost of the composed stage's per-slot rise (song range
// composition, Phase 4). Links the real terrain and forest programs through
// three.js in headless Chromium, once as a catalog view draws them and once
// with useSlotRise, then relinks each stage against a stub of the other so
// only that stage's active uniforms count (as Phase 0 measured).
//
//   node tools/song-range-shader-budget.mjs [--out FILE]
//
// Rows are vec4 uniform vectors: "naive" gives every non-sampler uniform
// whole rows (mat4 = 4, arrays per element). WebGL2 guarantees 256 vertex and
// 224 fragment vectors and 16 samplers per stage.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(root, '.smoke', 'p4-shader', 'budget.json'));

const PAGE = `<!doctype html><script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js"}}</script>
<script type="module">
import * as THREE from 'three';
import { sceneUniforms, createSceneMaterial, createDepthMaterial, useSlotRise } from '/src/world/alpine/TerrainMaterial.js';
import { createForest } from '/src/world/alpine/ForestGL.js';
const SIZE = { FLOAT: 1, FLOAT_VEC2: 1, FLOAT_VEC3: 1, FLOAT_VEC4: 1, INT: 1, BOOL: 1, INT_VEC2: 1, INT_VEC3: 1, INT_VEC4: 1,
  FLOAT_MAT2: 2, FLOAT_MAT3: 3, FLOAT_MAT4: 4 };
window.measure = () => {
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas });
  const gl = renderer.getContext();
  const typeName = (t) => Object.keys(WebGL2RenderingContext).find((k) => WebGL2RenderingContext[k] === t && SIZE[k] !== undefined || WebGL2RenderingContext[k] === t && /SAMPLER/.test(k)) || String(t);
  const stage = (vs, fs) => {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return { error: gl.getShaderInfoLog(s) };
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return { error: gl.getProgramInfoLog(p) };
    let rows = 0, samplers = 0, uniforms = 0;
    const list = [];
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      const u = gl.getActiveUniform(p, i), name = typeName(u.type);
      uniforms++;
      if (/SAMPLER/.test(name)) samplers += u.size; else rows += (SIZE[name] || 1) * u.size;
      list.push(u.name + ':' + name + (u.size > 1 ? '[' + u.size + ']' : ''));
    }
    return { uniforms, naiveRows: rows, samplers, list: list.sort() };
  };
  const sources = (material) => {
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    scene.add(new THREE.Mesh(geo, material));
    renderer.compile(scene, cam);
    const prog = renderer.properties.get(material).currentProgram?.program;
    if (!prog) return null;
    const shaders = gl.getAttachedShaders(prog).map((s) => [gl.getShaderParameter(s, gl.SHADER_TYPE), gl.getShaderSource(s)]);
    return { vs: shaders.find(([t]) => t === gl.VERTEX_SHADER)[1], fs: shaders.find(([t]) => t === gl.FRAGMENT_SHADER)[1] };
  };
  const stubFrag = '#version 300 es\\nprecision highp float; out vec4 o; void main() { o = vec4(0.0); }';
  const measureOf = (material) => {
    const s = sources(material);
    if (!s) return { error: 'did not compile' };
    // The vertex stage alone: its varyings feed a fragment that reads none.
    const vertex = stage(s.vs, stubFrag);
    // The fragment stage alone: a vertex stub writing every input it reads.
    const ins = [...s.fs.matchAll(/(?<=^|;)\\s*((?:(?:flat|smooth|centroid|highp|mediump|lowp)\\s+)*)in\\s+((?:(?:flat|smooth|centroid|highp|mediump|lowp)\\s+)*)(\\w+)\\s+([\\w\\s,]+);/gm)]
      .flatMap((m) => m[4].split(',').map((n) => [(m[1] + m[2]).includes('flat') ? 'flat' : '', m[3], n.trim()]));
    const vstub = '#version 300 es\\nprecision highp float;\\n' + ins.map(([q, t, n]) => q + ' out ' + t + ' ' + n + ';').join('\\n')
      + '\\nvoid main() {' + ins.map(([, t, n]) => n + ' = ' + t + '(0);').join(' ') + ' gl_Position = vec4(0.0); }';
    const fragment = stage(vstub, s.fs);
    return { vertex, fragment };
  };
  const results = [];
  const variants = [
    ['scene mobile (default flags)', (u) => createSceneMaterial(THREE, u, { budget: 'mobile' }), { MATERIAL_FEATURE_CACHE: 1 }],
    ['scene mobile river surface', (u) => createSceneMaterial(THREE, u, { budget: 'mobile', riverSurface: true }), { MATERIAL_FEATURE_CACHE: 1 }],
    ['depth', (u) => createDepthMaterial(THREE, u), {}],
  ];
  for (const [label, make, defines] of variants) {
    for (const slot of [false, true]) {
      const u = sceneUniforms(THREE, {});
      const m = make(u); Object.assign(m.defines, defines);
      if (slot) useSlotRise(m);
      results.push({ label, slotRise: slot, defines: { ...m.defines }, ...measureOf(m) });
    }
  }
  const placed = { mesh: new Float32Array(8), billboard: new Float32Array(8), stride: 8, count: 1, meshCount: 1, billboardCount: 1 };
  for (const slot of [false, true]) {
    const forest = createForest(THREE, placed, sceneUniforms(THREE, {}), { slotRise: slot });
    const mats = [...new Set([...Object.values(forest.byBand).flat(), ...forest.depth].map((x) => x.material))];
    const seen = new Set();
    for (const m of mats) {
      const key = m.vertexShader.length + ':' + m.fragmentShader.length;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ label: 'forest ' + (m.vertexShader.includes('iLodWeight') ? 'mesh' : 'board') + (m.colorWrite === false ? ' depth' : ''), slotRise: slot, ...measureOf(m) });
    }
  }
  return { renderer: gl.getParameter(gl.RENDERER), results };
};
window.ready = true;
</script>`;

const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: PAGE });
    try { return route.fulfill({ contentType: 'application/javascript', body: await fs.readFile(path.join(root, p)) }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://budget.test/');
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  const report = await page.evaluate(() => window.measure());
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(report.renderer);
  console.log('program | slot rise | vertex uniforms/rows/samplers | fragment uniforms/rows/samplers');
  for (const r of report.results) {
    const f = (s) => (s?.error ? `error: ${s.error.slice(0, 80)}` : s ? `${s.uniforms}/${s.naiveRows}/${s.samplers}` : 'n/a');
    console.log(`${r.label} | ${r.slotRise ? 'yes' : 'no'} | ${f(r.vertex)} | ${f(r.fragment)}`);
  }
  console.log(`report: ${path.relative(root, out)}`);
} finally { await browser.close(); }
