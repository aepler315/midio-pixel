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
// for the cast's removal (no lantern light, uniforms or tree parting), then
// for b38fd8a's reworded comment inside LAND_RISE_GLSL, which these shaders
// embed (restoring the old comment text reproduces the previous pins exactly).
// These pins record shader/render-state contracts; actual driver compilation
// and visual evidence are recorded separately, not inferred from a hash.
// Creation order: mesh, meshDepth, meshCore, meshCoreDepth, board, boardDepth.
export const MAIN_PINS = {
  "partitioned": [
    "e01f575970f24f27a98f09673c5b4beb5f6879a72e231bf58000e71d236a1d3f",
    "43c103c9daca18ec5968d2fdd60457394ca2a1e33fae19e02917f91da9fdfe21",
    "f128e26d6a1d4ad8911bad8cb9ad10310f924fcc90fadf2abbd9a329ad5a6c2e",
    "7f063bb367147a957b2de17f4f2de6a04144f6b835a7afac57655d36ad0a357b",
    "e0acfe1a21f3e507b43fcc2e461a3763fe9b36ab60b1e44938ff4a175aa37ab5",
    "f84a1e87c7f205c6a6333ad3cfa59785809adddd7c5cb87dba97101231cd79b9"
  ],
  "partitioned debug": [
    "423c1dd57be6a95d4d0b120363f07c0700746a33b4cc3f2c09fde4a349ecc6a8",
    "43c103c9daca18ec5968d2fdd60457394ca2a1e33fae19e02917f91da9fdfe21",
    "9ca1ff9f547457ee88550b0b9a03f17decea7494a5f5b06cdfa3ea0bad3c0298",
    "7f063bb367147a957b2de17f4f2de6a04144f6b835a7afac57655d36ad0a357b",
    "e7ff18816680f4952bf2afa5764df409b969d99aa89a97c7f304393b494cc47b",
    "f84a1e87c7f205c6a6333ad3cfa59785809adddd7c5cb87dba97101231cd79b9"
  ],
  "plain": [
    "5610ed852a625e0dbb0854926caf2cd7fe90d33b2433be537791ab6b83555d40",
    "43c103c9daca18ec5968d2fdd60457394ca2a1e33fae19e02917f91da9fdfe21",
    "54705c27670f50154e1921c20a21827936f17a21dbae2f4716e3264928a99612",
    "f84a1e87c7f205c6a6333ad3cfa59785809adddd7c5cb87dba97101231cd79b9"
  ],
  "plain debug": [
    "3125998c22a81f1293dc8cea8f3faf4741a6a8a830095e11057bcbc089fc0274",
    "43c103c9daca18ec5968d2fdd60457394ca2a1e33fae19e02917f91da9fdfe21",
    "1ac70d9f2c0db546587386471ccd05f385603f69be54bcdd2c3acde3539ed33a",
    "f84a1e87c7f205c6a6333ad3cfa59785809adddd7c5cb87dba97101231cd79b9"
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
