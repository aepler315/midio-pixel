// Range v2 shaders are GLSL strings node cannot compile, and a shader that
// fails to compile draws nothing without throwing (the terrain once vanished
// that way). This catches the static mistake that caused it: a function
// called above its own definition in the same source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('src/world/alpine');
const TYPES = 'void|float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4|Tri|[A-Z][A-Za-z0-9]*';
const DEF = new RegExp(`^\\s*(?:${TYPES})\\s+([A-Za-z_]\\w*)\\s*\\([^;{]*\\)\\s*\\{`, 'gm');

function glslLiterals(file) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  const out = [];
  const re = /\/\* glsl \*\/`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(src))) out.push({ at: src.slice(0, m.index).split('\n').length, body: m[1].replace(/\$\{[^}]*\}/g, '') });
  return out;
}

test('every GLSL helper is defined before its first call', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));
  let checked = 0;
  for (const file of files) {
    for (const { at, body } of glslLiterals(file)) {
      const defs = new Map();
      for (const d of body.matchAll(DEF)) if (d[1] !== 'main' && !defs.has(d[1])) defs.set(d[1], d.index);
      for (const [name, defAt] of defs) {
        const call = new RegExp(`\\b${name}\\s*\\(`, 'g');
        for (const c of body.matchAll(call)) {
          if (c.index >= defAt) break;
          assert.fail(`${file}:${at} calls ${name}() before defining it`);
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 10, `helpers checked: ${checked}`);
});

test('the cliff mask keeps its smoothstep edges ordered for every material pack', async () => {
  // GLSL smoothstep is undefined when edge0 >= edge1; with a low forest
  // slope limit (tundra, 20 degrees) the old edges inverted and marked every
  // flat as rock. Mirror the shader's edges and check them per pack.
  const { SCENE_FRAG } = await import('../src/world/alpine/TerrainMaterial.js');
  assert.match(SCENE_FRAG, /float cliff0 = max\(40\.0, rForestMaxSlope - 6\.0\);/);
  assert.match(SCENE_FRAG, /smoothstep\(cliff0, max\(cliff0 \+ 8\.0, rForestMaxSlope \+ 10\.0\)/);
  const dir = path.resolve('src/assets/range/v2/materials');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).rules.forestMaxSlopeDeg;
    const e0 = Math.max(40, m - 6), e1 = Math.max(e0 + 8, m + 10);
    assert.ok(e1 > e0, `${f}: cliff edges ${e0}..${e1}`);
  }
});

test('optional pack rules reach the shader as their defaults when a pack omits them', async () => {
  const { SCENE_FRAG, applyMaterial } = await import('../src/world/alpine/TerrainMaterial.js');
  const { RULE_DEFAULTS } = await import('../src/world/alpine/MaterialPackage.js');
  // The forest mask honours the lower forest limit.
  assert.match(SCENE_FRAG, /smoothstep\(rForestFloor - 60\.0, rForestFloor \+ 60\.0,/);
  const uniforms = new Proxy({}, { get: (o, k) => (o[k] ??= { value: { r: 0, g: 0, b: 0 } }) });
  const read = (f) => JSON.parse(fs.readFileSync(path.resolve('src/assets/range/v2/materials', f), 'utf8'));
  applyMaterial(uniforms, { manifest: read('wet-conifer.json') }, { roles: {} });
  assert.equal(uniforms.rForestFloor.value, RULE_DEFAULTS.forestFloorM);
  // A later pack's value, then a pack without it again: no stale carry-over.
  applyMaterial(uniforms, { manifest: read('steppe.json') }, { roles: {} });
  assert.equal(uniforms.rForestFloor.value, read('steppe.json').rules.forestFloorM);
  applyMaterial(uniforms, { manifest: read('icefield.json') }, { roles: {} });
  assert.equal(uniforms.rForestFloor.value, RULE_DEFAULTS.forestFloorM);
});
