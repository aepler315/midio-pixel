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

// Updated for ground-based rise (PR #88): shared vertex height mapping and
// billboard footprint depth now follow the flattened ground. Compared against
// 2b1aded: fragments differ only by shared rise GLSL; all material state is unchanged.
// Creation order: mesh, meshDepth, meshCore, meshCoreDepth, board, boardDepth.
export const MAIN_PINS = {
  "partitioned": [
    "cd443182bdde29fbff2b69133edae76ea8849f3c0f47aca8d3126e2ed9e489c5",
    "69120330a119708342dd55b26f9ebd1d32d6797fb8405333bb8d90c4da5c85f1",
    "8c02506c8fb2e6580abec487b9beeee900a308aaef02136a1873bdcac9efc333",
    "f2b89adfdc51dee47be134d47897ddcbb4c5ea90137a8291860e34d76e645b7a",
    "33e720b8599ea7390a995087fd6245669b740ea4d6c3b43bf6645504a9fade9c",
    "a43d4d7cc57db680a79577d91e6b9aa743c2a7de3051761dfab3163d4d1f5a62"
  ],
  "partitioned debug": [
    "b1cf8d70e9a0285504ee424a00d2434609b56a46a35e790db29e435f4c060324",
    "69120330a119708342dd55b26f9ebd1d32d6797fb8405333bb8d90c4da5c85f1",
    "fe12a8edd93b7a9042f8a00224d775a4f4a2d2fcb250bc903872ed895647dd56",
    "f2b89adfdc51dee47be134d47897ddcbb4c5ea90137a8291860e34d76e645b7a",
    "c9fa060136f7b88f358636d80f2f3b821732c82c06307576e935044efa902d59",
    "a43d4d7cc57db680a79577d91e6b9aa743c2a7de3051761dfab3163d4d1f5a62"
  ],
  "plain": [
    "3de855c7749c341753698aa895c806d2122fa04473ac1f9704f9b2e12dd82b60",
    "69120330a119708342dd55b26f9ebd1d32d6797fb8405333bb8d90c4da5c85f1",
    "ece3d93532f6ad2878f2a836da4dd4b1f2a908018be5e77755568314e80bc6a2",
    "a43d4d7cc57db680a79577d91e6b9aa743c2a7de3051761dfab3163d4d1f5a62"
  ],
  "plain debug": [
    "5c2e8273f6befd6c58a7c63b698421ecaddfa3120b39f1b6b68c7dfacd093bec",
    "69120330a119708342dd55b26f9ebd1d32d6797fb8405333bb8d90c4da5c85f1",
    "633c705a74979ec90ed1997a25423979b25dd37939708fed36217c973080cad7",
    "a43d4d7cc57db680a79577d91e6b9aa743c2a7de3051761dfab3163d4d1f5a62"
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
