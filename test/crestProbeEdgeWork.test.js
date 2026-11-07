// Execute the terrain-mask shader's scalar control flow with counted texture
// reads. This checks work avoidance and mask parity; WebGL compilation and GPU
// timing remain the responsibility of tools/crest-edge-smoke.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EDGE_NEIGHBOURS, PROBE_EDGE_JUMP, PROBE_EDGE_MATCH, PROBE_LOG_RANGE } from '../src/world/alpine/CrestProbe.js';

const source = fs.readFileSync(new URL('../src/world/alpine/CrestProbe.js', import.meta.url), 'utf8');
const start = source.indexOf('vec4 edgeCell(int x, int y) {');
assert.ok(start > 0, 'test the actual shader function');
let depth = 1, end = source.indexOf('{', start) + 1;
const bodyStart = end;
while (depth && end < source.length) {
  if (source[end] === '{') depth++;
  if (source[end] === '}') depth--;
  end++;
}
const body = source.slice(bodyStart, end - 1);
const vec4 = (...v) => v.length === 1 ? Array(4).fill(v[0]) : v;

// The two vector expressions are expanded explicitly. The branch/loop body
// otherwise comes directly from GLSL, so removing the shader's early return
// makes the workload regression fail even when the resulting pixels match.
function compileShaderBody(glsl) {
  const scalar = glsl
    .replaceAll('${PROBE_EDGE_MATCH}', String(PROBE_EDGE_MATCH))
    .replace(/vec2 at = \(vec2\(sx, sy\) \+ 0\.5\) \/ float\(uFineK\) - 0\.5;/,
      'const at = [(sx + 0.5) / uFineK - 0.5, (sy + 0.5) / uFineK - 0.5];')
    .replace(/dot\(at - vec2\(NB\[n\]\), at - vec2\(NB\[n\]\)\)/g,
      '((at[0] - NB[n][0]) ** 2 + (at[1] - NB[n][1]) ** 2)')
    .replace(/NB\[n\]\.x/g, 'NB[n][0]').replace(/NB\[n\]\.y/g, 'NB[n][1]')
    .replace(/(?:float|int) (\w+)\[8\] = int\[8\]\(([^)]+)\);/g, 'const $1 = [$2];')
    .replace(/(?:float|int) (\w+)\[8\];/g, 'const $1 = Array(8).fill(0);')
    .replace(/\b(?:float|int|bool) (?=\w)/g, 'let ')
    .replace(/\bfloat\(/g, 'Number(')
    .replace(/\babs\(/g, 'Math.abs(');
  return new Function('cellDist', 'fineDist', 'NB', 'EDGE_JUMP', 'uFineK', 'vec4', 'x', 'y', scalar);
}

const optimized = compileShaderBody(body);
// Reference executes the same mask logic without the candidate-neighbour
// short circuit, matching the original renderer's unconditional subcell work.
const reference = compileShaderBody(body.replace(/^\s*if \(!any\) return vec4\(0\.0\);[^\n]*$/m, ''));
const jump = Math.log2(PROBE_EDGE_JUMP) / PROBE_LOG_RANGE;

function fixture(width, height, scale, value) {
  const fw = Math.round(width * scale), fh = Math.round(height * scale);
  const data = Float64Array.from({ length: fw * fh }, (_, i) => {
    const d = value(i % fw, Math.floor(i / fw), fw, fh);
    return d < 0 ? -1 : Math.round(d * 65535) / 65535;
  });
  return { width, height, fw, fh, data };
}

function sample(run, field, x, y) {
  let reads = 0;
  const fineDist = (fx, fy) => {
    reads++;
    const sx = Math.floor((fx + .5) * field.fw / (field.width * 4));
    const sy = Math.floor((fy + .5) * field.fh / (field.height * 4));
    return sx < 0 || sy < 0 || sx >= field.fw || sy >= field.fh ? -1 : field.data[sy * field.fw + sx];
  };
  const cellDist = (cx, cy) => {
    let sum = 0;
    for (let sy = 1; sy <= 2; sy++) for (let sx = 1; sx <= 2; sx++) {
      const d = fineDist(cx * 4 + sx, cy * 4 + sy);
      if (d < 0) return -1;
      sum += d;
    }
    return sum / 4;
  };
  const rgba = run(cellDist, fineDist, EDGE_NEIGHBOURS, jump, 4, vec4, x, y);
  return { rgba, reads };
}

test('terrain cells with no candidate neighbour skip all sixteen subcell texture reads', () => {
  const uniform = fixture(8, 6, 4, () => .6);
  const now = sample(optimized, uniform, 3, 3), before = sample(reference, uniform, 3, 3);
  assert.deepEqual(now.rgba, [0, 0, 0, 0]);
  assert.equal(now.reads, 36, 'only own and eight central 2x2 distances are needed');
  assert.equal(before.reads - now.reads, 16);
  const gentle = fixture(8, 6, 4.5, (_x, y) => .6 + y * jump / 32);
  assert.deepEqual(sample(optimized, gentle, 3, 3).rgba, [0, 0, 0, 0]);
  assert.equal(sample(optimized, gentle, 3, 3).reads, 36);
});

test('a real distance discontinuity retains the same sixteen-pixel mask and neighbour', () => {
  const border = fixture(3, 3, 4, x => x < 5 ? .7 : .5);
  const now = sample(optimized, border, 1, 1), before = sample(reference, border, 1, 1);
  assert.deepEqual(now, before, 'a candidate edge retains every original sample and decision');
  assert.deepEqual(now.rgba, [0x11 / 255, 0x11 / 255, 1 / 255, 1]);
});

test('mask bytes match the original scan across sky, smooth slopes, sharp ridges and fractional output sizes', () => {
  let seed = 0x81f731;
  const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 2 ** 32; };
  const fields = [];
  for (const scale of [1, 3, 4, 4.5, 6]) {
    fields.push(fixture(12, 8, scale, (x, y, w) => y < 3 ? -1 : y < 8 + .3 * x ? .72 : .48));
    fields.push(fixture(12, 8, scale, (x, y) => .6 + Math.sin(x * .1) * .001 + y * .00003));
    fields.push(fixture(12, 8, scale, () => random() < .08 ? -1 : .4 + Math.floor(random() * 4) * .1));
  }
  for (const field of fields) for (let y = 0; y < field.height; y++) for (let x = 0; x < field.width; x++) {
    const now = sample(optimized, field, x, y), before = sample(reference, field, x, y);
    assert.deepEqual(now.rgba, before.rgba, `mask changed at ${x},${y} / ${field.fw}x${field.fh}`);
    assert.ok(now.reads <= before.reads);
  }
});
