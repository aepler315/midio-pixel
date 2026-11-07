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

// Updated for terrain-derived valley banks and exact source-anchor lighting.
// Complete generated shaders compile/link in the software GLES evidence;
// these pins record shader/render-state contracts, not artistic acceptance.
// Creation order: mesh, meshDepth, meshCore, meshCoreDepth, board, boardDepth.
export const MAIN_PINS = {
  "partitioned": [
    "824914a386c7451b093b5fee700f5ab8d1e8684358c78edbf8abf7cf9e12f65c",
    "ede5fd722a104e89b94f770508b49fd2ed290dfd0ec55ec99d746b61315a3310",
    "640bc736c007d172df85be885b8ac89781f24ce3fa3f1460e0ad79fe0f5a29ed",
    "f3a308052eb34f5fd3f4e68b8740f3fc5907b705882bd11bd877a989206fe066",
    "00246846e17210730d0065a3aec541644b3642408662b5b95bcdbc3349e17ad5",
    "30ebada97bf01578b088995e76ebffdbafe8c45e061f337982f6a56c8626f7d0"
  ],
  "partitioned debug": [
    "96d1555c78412654c0e40cc4e4cc787ffa276d65c3c8de1a71bc07169760a768",
    "ede5fd722a104e89b94f770508b49fd2ed290dfd0ec55ec99d746b61315a3310",
    "52c2746cebe2ade3edd036649326a243e5ba87871d454e8e2d10e193e9e0a1dc",
    "f3a308052eb34f5fd3f4e68b8740f3fc5907b705882bd11bd877a989206fe066",
    "e937c6fdc7e72b2765866e0afc374b71a3bd10fa2e1446c1bbd26adf7720ceae",
    "30ebada97bf01578b088995e76ebffdbafe8c45e061f337982f6a56c8626f7d0"
  ],
  "plain": [
    "6a7ba8434bcb578332e5e84f193ed2fff2a8e78c1db1a20ff9104fd8a688a6ae",
    "ede5fd722a104e89b94f770508b49fd2ed290dfd0ec55ec99d746b61315a3310",
    "352df1a455ad0730248d3376db5a1df840b61bf6c0627598accc1a16a3b34aa9",
    "30ebada97bf01578b088995e76ebffdbafe8c45e061f337982f6a56c8626f7d0"
  ],
  "plain debug": [
    "96d396c943e4f023d811cb4ff837cf14aeac4787872a759994a055ff082594cd",
    "ede5fd722a104e89b94f770508b49fd2ed290dfd0ec55ec99d746b61315a3310",
    "59f0eef75c2d79e0cd157282bf303d9c05affc466aad9356de67a3654f946c9a",
    "30ebada97bf01578b088995e76ebffdbafe8c45e061f337982f6a56c8626f7d0"
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
