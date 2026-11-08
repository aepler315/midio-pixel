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

// Updated for placement coverage and compact shared mist-flow metadata.
// These pins record shader/render-state contracts; actual driver compilation
// and visual evidence are recorded separately, not inferred from a hash.
// Creation order: mesh, meshDepth, meshCore, meshCoreDepth, board, boardDepth.
export const MAIN_PINS = {
  "partitioned": [
    "ec9b29e2ce7bdcb16e027a6d849c86112705a22a5b941ed06f5112b560b76fe2",
    "b563753c040e73c1d91aca64579a2f56516121ae5360613762bd4cbab095b75d",
    "d9d23c57ced3dd40fc1e9499b836839d11e045ff09190ff8013877ae4cb0b6e1",
    "b8033d45067cc44444f36610ae53e836c97a4a3d5eb21e24120d4072aaa59e89",
    "9c114565057e396d4637a7f00e0b3791b2b5183d709b22b4930406a7eb7e4984",
    "4b53b93c72f2935901f4c29d2cee2edc92e4f024f600426feda57e18f4ac26ff"
  ],
  "partitioned debug": [
    "fa00c555a5a7a224ae6c46455cbcddea2eef9b94f11f014d5a72d40a4b7a4025",
    "b563753c040e73c1d91aca64579a2f56516121ae5360613762bd4cbab095b75d",
    "f6d36b1556a99fc88e0bbafc96d9b14e6af8d6abd5455ec2b447ec0c5c63093b",
    "b8033d45067cc44444f36610ae53e836c97a4a3d5eb21e24120d4072aaa59e89",
    "5593b96aaf8a4266bea4d2b9549bd788994aa6d67c18f395bada0afb8a2d731e",
    "4b53b93c72f2935901f4c29d2cee2edc92e4f024f600426feda57e18f4ac26ff"
  ],
  "plain": [
    "66b84aa0cf399046fc583a9cba0c0049550f1b98211db94740b991cf75b6c4e1",
    "b563753c040e73c1d91aca64579a2f56516121ae5360613762bd4cbab095b75d",
    "164debd46d64ddac18cb09ba25f5d03eaab0d3e3f6331737de4a21b1119c5fb4",
    "4b53b93c72f2935901f4c29d2cee2edc92e4f024f600426feda57e18f4ac26ff"
  ],
  "plain debug": [
    "3fbe205a517d0a5bedcefb504706f8e11e9f071e9807f0b9f38d567956967f5a",
    "b563753c040e73c1d91aca64579a2f56516121ae5360613762bd4cbab095b75d",
    "0c75bb3ee948c130150b7b30f16c040a7f650861775de0f5be4da664e672f715",
    "4b53b93c72f2935901f4c29d2cee2edc92e4f024f600426feda57e18f4ac26ff"
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
