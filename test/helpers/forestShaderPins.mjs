// The static forest's materials as pins (test/forestShaderPin.test.mjs).
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { createForest } from '../../src/world/alpine/ForestGL.js';

const row = (x, z, species, id, band) => [x, 1000, z, 14, 5, species, id, band];
export function pinPlaced() {
  const meshDetail = [], mesh = [], billboard = [];
  for (let i = 0; i < 6; i++) {
    meshDetail.push(...row(i * 20, -100, i % 4, (i * .37) % 1, 2));
    mesh.push(...row(i * 20, -900, i % 4, (i * .53) % 1, 1));
    billboard.push(...row(i * 20, -3000, i % 4, (i * .71) % 1, 0));
  }
  return { meshDetail: new Float32Array(meshDetail), mesh: new Float32Array(mesh), billboard: new Float32Array(billboard), stride: 8, count: 18 };
}

const sha = s => createHash('sha256').update(s).digest('hex');
/** A forest's static materials in creation order, each as one string. */
export function staticMaterials(forest) {
  const seen = new Set();
  for (const m of [...Object.values(forest.byBand).flat(), ...forest.depth, ...Object.values(forest.depthByBand).flat()]) seen.add(m.material);
  return [...seen].sort((a, b) => a.id - b.id);
}
export function materialPin(m) {
  return JSON.stringify({
    vertexShader: sha(m.vertexShader), fragmentShader: sha(m.fragmentShader), defines: m.defines, glsl: m.glslVersion,
    blend: [m.transparent, m.premultipliedAlpha, m.blending, m.blendEquation, m.blendEquationAlpha, m.blendSrc, m.blendSrcAlpha, m.blendDst, m.blendDstAlpha],
    depth: [m.depthTest, m.depthWrite, m.depthFunc, m.colorWrite], side: m.side, attributes: m.defaultAttributeValues,
    uniforms: Object.keys(m.uniforms).sort(),
  });
}

// Updated for placement coverage and compact shared mist-flow metadata, then
// for the cast's removal (no lantern light, uniforms or tree parting).
// These pins record shader/render-state contracts; actual driver compilation
// and visual evidence are recorded separately, not inferred from a hash.
// Creation order: mesh, meshDepth, meshCore, meshCoreDepth, board, boardDepth.
export const MAIN_PINS = {
  "partitioned": [
    "62f79a0749aeb2733c04f8282640510dcba2c97ef968e6cca1dd393a8a018845",
    "40e588a3531b05091975624eeab872ee6bd08eb4930350a530aa3e3caa80f701",
    "e7a9515b2c78786465795b3bbaa226a372a682d5073ddd59a51a37d8ac2f2c97",
    "881f4b573683f37c4c2087034a1a218df1719499703852aceb96aa496dac22ae",
    "d3436790509941b7a13863d523855d997d56d00d08b865636538a183a5cc2b54",
    "3008fad8948db672e810585d976aa695a613b593483253557f70301b47aa31ad"
  ],
  "partitioned debug": [
    "ce51d88c8a0d795c00617f5cc5431d5559ada2dd6ecbaaf4a9f5ce3cc40f8ce4",
    "40e588a3531b05091975624eeab872ee6bd08eb4930350a530aa3e3caa80f701",
    "cda083dcb6d8f0608aaeae7eeb187f01809b504082d4cb3737df91eed23a28bf",
    "881f4b573683f37c4c2087034a1a218df1719499703852aceb96aa496dac22ae",
    "fa6293afe067f8882376048f4723a1034fc0003cd638298c5e4a4817688e5552",
    "3008fad8948db672e810585d976aa695a613b593483253557f70301b47aa31ad"
  ],
  "plain": [
    "6e05ac535e2beada45306cdc24a290372e89f52e68abe68486600eecd761162d",
    "40e588a3531b05091975624eeab872ee6bd08eb4930350a530aa3e3caa80f701",
    "91ce0bc478e0be9be0cd6aa4a32e620a37cbb08ca93079cbb15a76601aad203e",
    "3008fad8948db672e810585d976aa695a613b593483253557f70301b47aa31ad"
  ],
  "plain debug": [
    "b46e75f2a1479894cf9f4526878427e2d6448e021545e3a6d3520aed9d0f8237",
    "40e588a3531b05091975624eeab872ee6bd08eb4930350a530aa3e3caa80f701",
    "285b16140c47a0f714e39a7024183da6f755adaafe7644db3208955dbf5e0d7b",
    "3008fad8948db672e810585d976aa695a613b593483253557f70301b47aa31ad"
  ]
};
export const PIN_OPTIONS = [['partitioned', {}], ['partitioned debug', { forestDebug: true }], ['plain', { partitioned: false }], ['plain debug', { partitioned: false, forestDebug: true }]];

/** Each option set's static material pins for a forest of `placed`. */
export function forestPins(placed, extra = {}) {
  const out = {};
  for (const [name, options] of PIN_OPTIONS) {
    const forest = createForest(THREE, placed, {}, { ...options, ...extra });
    out[name] = staticMaterials(forest).map(m => sha(materialPin(m)));
    forest.dispose();
  }
  return out;
}
