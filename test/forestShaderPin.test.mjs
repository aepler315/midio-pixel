// The static forest's six materials, pinned after the ground-based rise fix:
// vertex and fragment shaders, defines, blend and depth state, side,
// default attributes, uniform names and creation order. The rail draws
// these, so they must not change when the forest gains other materials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinPlaced, forestPins, MAIN_PINS } from './helpers/forestShaderPins.mjs';
import * as THREE from 'three';
import { createForest } from '../src/world/alpine/ForestGL.js';
import { PIN_OPTIONS } from './helpers/forestShaderPins.mjs';
import { recordingWebGL2 } from './helpers/recordingWebGL2.mjs';

test('the static forest materials match the reviewed shader and render-state pins', () => {
  assert.deepEqual(forestPins(pinPlaced()), MAIN_PINS);
});

// Twin spans draw a twin's trees first to last from an offset into its
// buffers (ForestCulling forestSpan): instance i of a span is tree
// first + i. A shader that read gl_InstanceID (or gl_VertexID) would see i,
// not the tree, and draw differently. So no forest shader may read either:
// not the sources createForest writes, nor what three compiles from them.
test('no forest or tour forest shader reads gl_InstanceID or gl_VertexID', () => {
  const ids = /\bgl_(InstanceID|VertexID)\b/;
  assert.ok(ids.test('x = gl_InstanceID;') && ids.test('gl_VertexID') && !ids.test('gl_InstanceIDs'), 'the check sees them');
  const toured = { ...pinPlaced(), railCount: { meshDetail: 3, mesh: 3, billboard: 3 } };
  for (const [name, options] of PIN_OPTIONS) for (const tour of [null, { seed: 7 }, { seed: 7, spans: false }]) {
    const label = `${name}${tour ? ` tour${tour.spans === false ? ' (spans off)' : ''}` : ''}`;
    const forest = createForest(THREE, tour ? toured : pinPlaced(), {}, { ...options, tour });
    assert.equal(!!forest.tour, !!tour);
    const meshes = [...Object.values(forest.byBand).flat(), ...forest.depth, ...Object.values(forest.depthByBand).flat(),
      ...(forest.tour ? [...Object.values(forest.tour.byBand).flat(), ...forest.tour.depth, ...Object.values(forest.tour.depthByBand).flat()] : [])];
    const materials = new Set([...meshes.map(m => m.material), ...Object.values(forest.tour?.materials || {})]);
    assert.ok(materials.size >= (tour ? 10 : 4), `${label}: ${materials.size} materials`);
    for (const m of materials) {
      assert.doesNotMatch(m.vertexShader, ids, `${label}: a vertex shader`);
      assert.doesNotMatch(m.fragmentShader, ids, `${label}: a fragment shader`);
    }
    // What three sends to GL, includes and prefixes resolved.
    const { gl, canvas } = recordingWebGL2(64, 64);
    const sources = [], shaderSource = gl.shaderSource;
    gl.shaderSource = (shader, source) => { sources.push(source); return shaderSource(shader, source); };
    const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
    const scene = new THREE.Scene();
    for (const m of meshes) { m.visible = true; scene.add(m); }
    // A tour material no mesh uses here (the core pair without the
    // partitioned layout) is compiled on a twin too.
    const used = new Set(meshes.map(m => m.material));
    for (const m of materials) if (!used.has(m)) scene.add(new THREE.Mesh(forest.tour.twins[0].detail, m));
    const camera = new THREE.PerspectiveCamera();
    camera.layers.enableAll();
    renderer.compile(scene, camera);
    for (const m of materials) assert.ok(renderer.properties.get(m).currentProgram, `${label}: every material compiled`);
    assert.ok(sources.length >= 2 * (tour ? 6 : 4), `${label}: ${sources.length} shaders`);
    for (const source of sources) assert.doesNotMatch(source, ids, `${label}: a compiled shader`);
    renderer.dispose();
    forest.dispose();
  }
});
