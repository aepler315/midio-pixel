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
// The localized Songprint mist field adds uMistSongprint to the shared
// uniforms and updates the fragments that shade the forest.
// These pins record shader/render-state contracts; actual driver compilation
// and visual evidence are recorded separately, not inferred from a hash.
// Creation order: mesh, meshDepth, meshCore, meshCoreDepth, board, boardDepth.
export const MAIN_PINS = {
  "partitioned": [
    "403b780ec35cce426e33678d6d2b1a7dc9e12c8ee04e0feedf37956da56e9157",
    "1191986638a89f6f2e2e3086465a42616ef3d89ba8d32f85342a812ef9525154",
    "6dda44b781431103d63da73eb7e877d944b4ecc7ef6ad9ea769639be76bc9de8",
    "b381d8d43e2c90bff8d95dd48ccf75e793a4abbd36061ee71d79e76054a62694",
    "53e9ce04cd4ce932c3456b3242b1f246398ef7344b6385cdecd60e901376b743",
    "aeeb9c89fa3a0dbf96e7d1846fc8fa879d8aa3bc7d8e0a2ba26761ea21611159"
  ],
  "partitioned debug": [
    "0813d24ba1d1b95dda3c79a7808b0a279c658e8bf28195806491b3636096d401",
    "1191986638a89f6f2e2e3086465a42616ef3d89ba8d32f85342a812ef9525154",
    "cc0d9dffd09ae3150db2818ea9ae7096fd065c9f2f23acd05ed5325f8ee79a74",
    "b381d8d43e2c90bff8d95dd48ccf75e793a4abbd36061ee71d79e76054a62694",
    "4539422f3e1cc183a1404806df7ec032941cd26cf273a59950f20dfcfa8fa884",
    "aeeb9c89fa3a0dbf96e7d1846fc8fa879d8aa3bc7d8e0a2ba26761ea21611159"
  ],
  "plain": [
    "90ff22387fefb48241d4df539dc98e4de522ecea1e8ceb4d41541e16ab1db6f5",
    "1191986638a89f6f2e2e3086465a42616ef3d89ba8d32f85342a812ef9525154",
    "1cad48f993f7ee123caa2dc7a6649d866ebf988d09a9429d93e6c082e8d69a9f",
    "aeeb9c89fa3a0dbf96e7d1846fc8fa879d8aa3bc7d8e0a2ba26761ea21611159"
  ],
  "plain debug": [
    "bde29446ff3c0c363c2e202a3d5ca612024bf17dc4ed3874df068f812aa53691",
    "1191986638a89f6f2e2e3086465a42616ef3d89ba8d32f85342a812ef9525154",
    "e485dc81538715b9ae61d0778948fc874be45bea025bc6ef9deaa248cb9d582a",
    "aeeb9c89fa3a0dbf96e7d1846fc8fa879d8aa3bc7d8e0a2ba26761ea21611159"
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
