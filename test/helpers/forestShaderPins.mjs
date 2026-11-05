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

// Recorded on main 7d48f2f, in creation order (material id): mesh,
// meshDepth, meshCore, meshCoreDepth, board, boardDepth. Without the
// partitioned layout no mesh uses the core pair.
export const MAIN_PINS = {
  'partitioned': [
    'e318f3f39ee6a11982572d4d25a24e6a5cf07d7c2cfd26e9628c8babe9e33519',
    '0d2f31559b45c24cb17997038a4a33510e0f93270f6e59c207c4042db8905608',
    '93dd2d22e1e35b630c3d7e45e90ea96d76e567ccf5756e60f3cda9183749b4df',
    '0e162365e58627210df885cc86119672b102446b2b6031958180700fb50cb330',
    '91dbd0fed80a7df25073db581a26984fcf1c873a5647b00c44a530410484bb39',
    '88402bd23b72def3644e9d1f6cf8e55f12815fd19d4ae5a9827fb0a4fa6eee2c',
  ],
  'partitioned debug': [
    'd99c0e5292f2bb9a53bd5fae42c72b27d5101ab5720ee005662de70932384b94',
    '0d2f31559b45c24cb17997038a4a33510e0f93270f6e59c207c4042db8905608',
    '6d09b9b6aab71ca9b394042293a1371f4da0fb67a483cf6579b38ab4abc3f5df',
    '0e162365e58627210df885cc86119672b102446b2b6031958180700fb50cb330',
    '6e0f2fdd3950361823265437fafeacae181dd2296b814aa0b51b2d69b0fe84ae',
    '88402bd23b72def3644e9d1f6cf8e55f12815fd19d4ae5a9827fb0a4fa6eee2c',
  ],
  'plain': [
    '873f26f2dca56286b9c8385ad12e9f5f32cf06ec8a626ceb9e087e063d497ab1',
    '0d2f31559b45c24cb17997038a4a33510e0f93270f6e59c207c4042db8905608',
    'a331dcd4714654d682958955d0f7ff04bcdf80980469dfb646f338b0d18138d9',
    '88402bd23b72def3644e9d1f6cf8e55f12815fd19d4ae5a9827fb0a4fa6eee2c',
  ],
  'plain debug': [
    'f100f3b160b6bdbdafb780435ae279ac2c7a2467fcd8e74802d708d87aadfde6',
    '0d2f31559b45c24cb17997038a4a33510e0f93270f6e59c207c4042db8905608',
    'fb08f899f2aecca8f159c21e3d2b77546112ff4a66dc04950c811c20558574c0',
    '88402bd23b72def3644e9d1f6cf8e55f12815fd19d4ae5a9827fb0a4fa6eee2c',
  ],
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
