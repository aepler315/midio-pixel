// Twin spans (ForestCulling forestSpan and cullForestScene's spans path,
// ForestGL's tour twins): each culled render draws only the trees first to
// last of a twin, read from an offset into the same GPU buffers. It must
// submit exactly what whole-twin culling (tour.spans false, main's path)
// submits, less trees that make no fragment. Rendered through the vendored
// three r186 on a recording WebGL2 context that keeps buffer bytes and
// vertex arrays; the three internals that identity rests on are pinned
// below too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { attachForestCulling, cullForestScene, restoreForestScene, forestGeometryVisible, SPAN_ALIGN } from '../src/world/alpine/ForestCulling.js';
import { frustumPlanes } from '../src/world/alpine/TerrainChunks.js';
import { DANCE_WAVE_BOUND } from '../src/world/alpine/MirrorScissor.js';
import { landRiseLift } from '../src/world/alpine/LandRise.js';
import { createForest } from '../src/world/alpine/ForestGL.js';
import { crownHalfWidth } from '../src/world/alpine/ForestProfile.js';
import { WIND_SWAY, GUST_LEAN, WIND_DIR } from '../src/world/alpine/ForestWind.js';
import { setTerrainDrawMode } from '../src/world/alpine/RailDraw.js';
import { recordingWebGL2 } from './helpers/recordingWebGL2.mjs';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
// Values in [0, 1] that land on the ends often: vertices reach furthest there.
const edgy = r => () => { const v = r(); return v < .2 ? 0 : v > .8 ? 1 : r(); };

// ---------------------------------------------------------------------------
// The tree vertex shader on the CPU (ForestGL MESH_VERT), copied from
// forestCulling.test.mjs: the world position of vertex k of `geo` on `tree`,
// with the hidden inputs (receiver, fade, sines, gust, wind direction)
// drawn at random within their ranges.
const fract = x => x - Math.floor(x);
const crownBase = (s, id) => s < .5 ? .46 + .06 * id : s > 1.5 && s < 2.5 ? .015 : .08;
const crownRatio = s => s < .5 ? .30 : s < 1.5 ? .38 : s < 2.5 ? .265 : .425;
function deformAt(u, e, r) {
  const d = u.raw, recv = e(), fade = e(), h = e(), sa = e() * 2 - 1, sm = e() * 2 - 1;
  const base = recv * fade * h * h * (d.amp * sa + d.kick + d.structural + d.melodic * sm + h * h * d.gesture);
  if (d.dance.x === 0 && d.dance.z === 0) return base;
  const hr = e(), spine = e(), cs = [e() * 255, e() * 255].map(v => (v - 127.5) / 127.5);
  const wave = cs[1] * Math.cos(d.dance.w) + cs[0] * Math.sin(d.dance.w);
  return base + recv * fade * hr * (d.dance.x * spine * (.35 + .65 * hr) + d.dance.z * wave);
}
const deformBound = u => { const d = u.raw; return Math.abs(d.amp) + Math.abs(d.kick + d.structural) + Math.abs(d.melodic) + Math.abs(d.gesture) + Math.abs(d.dance.x) + DANCE_WAVE_BOUND * Math.abs(d.dance.z); };
function windAt(tree, y01, u, e, r) {
  const ph = tree.id * 6.2831, t = u.uTime.value, wind = u.uWind.value;
  const s = Math.sin(t * .65 + ph) * .6 + Math.sin(t * 1.45 + ph * 1.7) * .25;
  const sway = [s * WIND_SWAY * wind.x, s * .4 * WIND_SWAY * wind.x];
  const gust = e() * 2 - 1, a = r() * Math.PI * 2;
  const lx = Math.cos(a) * gust * GUST_LEAN + WIND_DIR[0] * wind.y;
  const lz = Math.sin(a) * gust * GUST_LEAN + WIND_DIR[1] * wind.y;
  const k = tree.h * y01 * y01;
  return [(sway[0] + lx) * k, (sway[1] + lz) * k];
}
function meshVertex(geo, k, tree, u, e, r) {
  const pos = geo.attributes.position, br = geo.attributes.aBranch;
  const px = pos.getX(k), py = pos.getY(k), pz = pos.getZ(k), bx = br.getX(k), bw = br.getW(k);
  const base = crownBase(tree.species, tree.id);
  const y01 = bw > .5 ? base + (1 - base) * py : py;
  const angle = 6.283185 * fract(Math.sin(tree.id * 127.1) * 43758.5453) + (fract(Math.sin(tree.id * 91.7 + bx * 311.7) * 43758.5453) - .5) * .7 * bw;
  const c = Math.cos(angle), s = Math.sin(angle);
  const rx = c * px + s * pz, rz = -s * px + c * pz;
  const jitter = .85 + .3 * fract(Math.sin(tree.id * 269.5 + bx * 183.3) * 43758.5453);
  const radius = crownHalfWidth(tree.species, y01, tree.id, rx < 0 ? -1 : 1) / crownRatio(tree.species) * tree.w * jitter;
  const scale = bw > .5 ? radius : (.12 + .14 * tree.id) * (1 - .94 * y01);
  const w = windAt(tree, y01, u, e, r);
  const x = tree.x + rx * scale + w[0], y = tree.y + deformAt(u, e, r) + y01 * tree.h, z = tree.z + rz * scale + w[1];
  const L = u.uLandRise?.value;
  return [x, L ? y + landRiseLift(x, y, z, null, L.x, L.y) : y, z];
}
// The port's view of the forest's uniforms, read as the shader reads them.
const portUniforms = u => ({
  raw: { amp: u.uDeformAmp.value, kick: u.uDeformKick.value, structural: u.uDeformStructural.value, melodic: u.uDeformMelodic.value,
    gesture: u.uDeformGesture.value, dance: { x: u.uLandDance.value.x, y: u.uLandDance.value.y, z: u.uLandDance.value.z, w: u.uLandDance.value.w } },
  uTime: u.uTime, uWind: u.uWind,
});

// ---------------------------------------------------------------------------
// No fragment: every vertex of a tree outside one common clip plane. The
// planes are the clip volume itself (-w <= x, y, z <= w) and the scissor's
// exact rectangle, as world-space linear forms (inside >= 0), built here
// from the camera's matrices, not from TerrainChunks.frustumPlanes.
function clipPlanes(camera, target) {
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
  const row = r => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const [X, Y, Z, Wr] = [row(0), row(1), row(2), row(3)];
  let x0 = -1, x1 = 1, y0 = -1, y1 = 1;
  if (target.scissorTest) {
    const s = target.scissor, v = target.viewport;
    x0 = Math.max(-1, (s.x - v.x) / v.z * 2 - 1); x1 = Math.min(1, (s.x + s.z - v.x) / v.z * 2 - 1);
    y0 = Math.max(-1, (s.y - v.y) / v.w * 2 - 1); y1 = Math.min(1, (s.y + s.w - v.y) / v.w * 2 - 1);
  }
  const lin = (a, ka, b, kb) => a.map((_, i) => ka * a[i] + kb * b[i]);
  return [lin(X, 1, Wr, -x0), lin(Wr, x1, X, -1), lin(Y, 1, Wr, -y0), lin(Wr, y1, Y, -1), lin(Z, 1, Wr, 1), lin(Wr, 1, Z, -1)];
}
const planeAt = (P, x, y, z) => P[0] * x + P[1] * y + P[2] * z + P[3];

// An asset's largest |position.xz| over its foliage and its trunk vertices,
// measured here (not ForestCulling.assetExtents).
const radialCache = new WeakMap();
function radial(position, branch) {
  if (radialCache.has(position)) return radialCache.get(position);
  let foliage = 0, trunk = 0;
  for (let k = 0; k < position.count; k++) {
    const d = Math.hypot(position.getX(k), position.getZ(k));
    if (branch.getW(k) > .5) foliage = Math.max(foliage, d); else trunk = Math.max(trunk, d);
  }
  const out = { foliage, trunk };
  radialCache.set(position, out);
  return out;
}
// A generous box around every vertex the port can place for `tree`: each
// term of MESH_VERT bounded loosely (crownHalfWidth / crownRatio * jitter
// is at most .5 * 1.045 * 1.15 < 1; the trunk's scale at most .26), then
// half as much again. Only ever used to pass a tree quickly: a tree it does
// not clear goes through the port vertex by vertex.
function looseBox(asset, tree, pu) {
  const { foliage, trunk } = radial(asset.attributes.position, asset.attributes.aBranch), wind = pu.uWind.value;
  const lean = .92 * WIND_SWAY * Math.abs(wind.x) + GUST_LEAN + Math.abs(wind.y);
  const R = 1.5 * (foliage * tree.w + trunk * .26 + lean * tree.h) + 1, D = 1.5 * deformBound(pu) + 1;
  return [tree.x - R, tree.y - D, tree.z - R, tree.x + R, tree.y + tree.h + D, tree.z + R];
}
const boxOutsideOne = (planes, b) => planes.some(P => {
  for (let c = 0; c < 8; c++) if (planeAt(P, c & 1 ? b[3] : b[0], c & 2 ? b[4] : b[1], c & 4 ? b[5] : b[2]) >= 0) return false;
  return true;
});
const VERTEX_DRAWS = 2;
/** True when every vertex the shader port places for `tree` on `asset`
 *  (VERTEX_DRAWS draws of its hidden inputs each) lies outside one of
 *  `planes`, the same one for all. `stats.ported` counts trees it had to
 *  check vertex by vertex. */
function noFragment(asset, tree, pu, planes, r, stats) {
  if (boxOutsideOne(planes, looseBox(asset, tree, pu))) return true;
  stats.ported++;
  const e = edgy(r);
  let alive = (1 << planes.length) - 1;
  for (let k = 0; k < asset.attributes.position.count; k++) for (let j = 0; j < VERTEX_DRAWS; j++) {
    const [x, y, z] = meshVertex(asset, k, tree, pu, e, r);
    for (let p = 0; p < planes.length; p++) if (alive & (1 << p) && planeAt(planes[p], x, y, z) >= 0) alive &= ~(1 << p);
    if (!alive) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The recording context, tapped: program and vertex array ids in bind
// order, the bound program and vertex array, and per draw what each
// enabled attribute location points at. A per-vertex attribute is compared by its buffer's
// content, an instanced one by the bytes its instances read (draw.reads).
const sha = bytes => createHash('sha1').update(bytes).digest('hex');
// A program's vertex shader inputs in declaration order: the attribute
// locations the recording context gives them.
const inputsOf = (gl, program) => [...new Set([...(program?.shaders?.find(sh => sh.type === gl.VERTEX_SHADER)?.source || '')
  .matchAll(/^\s*in\s+(?:(?:highp|mediump|lowp)\s+)?(?:float|vec[234]|ivec[234]|uvec[234]|int|uint)\s+(\w+)\s*;/gm)].map(m => m[1]))];
function tapContext(gl, state) {
  const ids = new Map();
  const id = (kind, o) => {
    if (o == null) return 'null';
    let m = ids.get(kind);
    if (!m) ids.set(kind, m = new Map());
    if (!m.has(o)) m.set(o, m.size);
    return m.get(o);
  };
  const tap = { id, program: null, vao: null, created: 0, subData: [] };
  const bound = new Map();
  const wrap = (name, after) => {
    const orig = gl[name];
    gl[name] = (...a) => { const out = orig(...a); after(out, ...a); return out; };
  };
  // Ids in bind order, which both forests a test compares share.
  wrap('useProgram', (_, p) => { tap.program = p; id('useProgram', p); });
  wrap('bindVertexArray', (_, v) => { tap.vao = v; id('bindVertexArray', v); });
  wrap('createBuffer', () => { tap.created++; });
  wrap('bindBuffer', (_, t, b) => { bound.set(t, b); });
  wrap('bufferData', (_, t) => { if (bound.get(t)) bound.get(t).hash = null; });
  wrap('bufferSubData', (_, t, dst, src, srcOffset = 0, length = 0) => {
    const b = bound.get(t);
    if (b) b.hash = null;
    if (tap.subData.length < 1e4) tap.subData.push({ buffer: b, dst, src, srcOffset, length });
  });
  const indexHash = new WeakMap();
  const annotate = () => {
    const d = state.draws.at(-1), names = inputsOf(gl, tap.program);
    d.drawing = state.drawing;
    d.program = id('useProgram', tap.program);
    d.attribs = {};
    const vertex = [];
    (tap.vao?.attribs || []).forEach((a, loc) => {
      if (!a?.enabled) return;
      d.attribs[names[loc]] = { divisor: a.divisor, elementBytes: a.elementBytes, sizeBytes: a.sizeBytes, offsetBytes: a.offsetBytes, type: a.type, normalized: a.normalized, integer: a.integer, buffer: a.buffer };
      if (!a.divisor) vertex.push(`${names[loc]}:${a.buffer ? (a.buffer.hash ||= sha(a.buffer.bytes)) : '-'}:${a.elementBytes}:${a.sizeBytes}:${a.offsetBytes}:${a.type}:${a.normalized}:${a.integer}`);
    });
    d.vertex = vertex.join('|');
    if (d.index) {
      if (!indexHash.has(d.index)) indexHash.set(d.index, sha(new Uint8Array(d.index.buffer, d.index.byteOffset, d.index.byteLength)));
      d.indexHash = indexHash.get(d.index);
    }
  };
  for (const name of ['drawElementsInstanced', 'drawArraysInstanced', 'drawElements', 'drawArrays']) wrap(name, annotate);
  return tap;
}

// ---------------------------------------------------------------------------
// The forest: trees on a 900 m square around the origin, the detail ring
// (twins with a lite) and the mesh ring, every species, and billboards
// further out.
function placedTrees(seed) {
  const r = rng(seed), rows = { meshDetail: [], mesh: [], billboard: [] };
  for (let i = 0; i < 1400; i++) {
    const detail = r() < .25;
    rows[detail ? 'meshDetail' : 'mesh'].push((r() - .5) * 900, r() * 30, (r() - .5) * 900, 8 + 20 * r(), 3 + 4 * r(), Math.floor(r() * 4), r() * .999, detail ? 2 : 1);
  }
  for (let i = 0; i < 50; i++) rows.billboard.push((r() - .5) * 4000, 0, (r() - .5) * 4000, 14, 5, Math.floor(r() * 4), r() * .999, 0);
  const of = k => Float32Array.from(rows[k]);
  return { meshDetail: of('meshDetail'), mesh: of('mesh'), billboard: of('billboard'), stride: 8,
    count: (rows.meshDetail.length + rows.mesh.length + rows.billboard.length) / 8, railCount: { meshDetail: 3, mesh: 9, billboard: 2 } };
}
// One set of terrain uniforms, shared by the forests a test compares.
function forestUniforms() {
  return { uDeformAmp: { value: 3 }, uDeformKick: { value: 1 }, uDeformStructural: { value: 0 }, uDeformMelodic: { value: .5 },
    uDeformGesture: { value: 0 }, uLandDance: { value: new THREE.Vector4() }, uTime: { value: 37.5 },
    uWind: { value: new THREE.Vector2(1.2, .02) } };
}

const W = 320, H = 180;
const PER_TREE = ['iPos', 'iSize', 'iVar', 'iTour'];
// view: { eye, at, fov, near, far, mirror (a lake plane's y), scissor [x, y, w, h] }
function setView(camera, target, v) {
  camera.fov = v.fov ?? 50; camera.near = v.near ?? 1; camera.far = v.far ?? 20000; camera.updateProjectionMatrix();
  camera.matrixAutoUpdate = true;
  camera.position.set(...v.eye); camera.lookAt(...v.at); camera.updateMatrix();
  if (v.mirror != null) {
    // The view reflected in a lake plane (determinant -1), as a mirror pass.
    camera.matrix.premultiply(new THREE.Matrix4().set(1, 0, 0, 0, 0, -1, 0, 2 * v.mirror, 0, 0, 1, 0, 0, 0, 0, 1));
    camera.matrixAutoUpdate = false;
  }
  camera.matrixWorldNeedsUpdate = true;
  camera.updateMatrixWorld(true);
  if (v.scissor) { target.scissorTest = true; target.scissor.set(...v.scissor); } else target.scissorTest = false;
}

/** A forest with its tour layer in one scene, culled (attachForestCulling)
 *  on its own recording context, on the tour. */
function world(spans, placed, uniforms) {
  const { gl, canvas, state } = recordingWebGL2(W, H, { gpu: true });
  const tap = tapContext(gl, state);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.autoClear = false;
  const f = createForest(THREE, placed, uniforms, { tour: { seed: 5, spans } }), t = f.tour;
  const scene = new THREE.Scene();
  scene.add(...f.byBand.far, ...f.byBand.mid, ...f.byBand.near, ...f.depth, ...t.byBand.far, ...t.byBand.mid, ...t.byBand.near, ...t.depth);
  // The last object three reaches, which can throw after the cull.
  const bomb = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -5, 1, 0, -5, 0, 1, -5], 3)), new THREE.MeshBasicMaterial());
  bomb.frustumCulled = false; bomb.renderOrder = 99;
  scene.add(bomb);
  const w = { f, t, gl, state, tap, renderer, scene, armed: false };
  for (const m of scene.children) m.onBeforeRender = () => {
    if (m === bomb && w.armed) throw new Error('render threw');
    const g = m.geometry;
    state.drawing = { mesh: m, geometry: g, attributes: { ...g.attributes }, index: g.index, count: g.instanceCount };
    state.ops.push(['object', m, state.drawing]);
  };
  for (const g of f.modeGeometries) setTerrainDrawMode(g, 'tour');
  t.setMode('tour');
  attachForestCulling(scene);
  w.camera = new THREE.PerspectiveCamera(50, W / H, 1, 20000);
  w.camera.layers.enable(1); w.camera.layers.enable(2);
  w.target = new THREE.WebGLRenderTarget(W, H);
  w.twins = new Set(t.twins.flatMap(({ detail, lite }) => lite ? [detail, lite] : [detail]));
  w.liteTwins = new Set(t.twins.filter(x => x.lite).map(x => x.lite));
  // The render's timeline: objects reached (with what they held then),
  // program and vertex array binds, and draws.
  w.events = () => state.ops.splice(0).map(([op, v, snap]) => op === 'object' ? { op, key: `object ${scene.children.indexOf(v)}`, mesh: v, snap }
    : op === 'draw' ? { op, draw: v } : { op, key: `${op} ${tap.id(op, v)}` });
  w.render = view => {
    setView(w.camera, w.target, view);
    state.ops.length = 0; state.draws.length = 0; tap.subData.length = 0;
    renderer.setRenderTarget(w.target);
    renderer.render(scene, w.camera);
    return w.events();
  };
  w.fill = (keepA, keepB = keepA, fade = 1) => {
    const index = t.index, A = new Uint32Array(index.words), B = new Uint32Array(index.words);
    for (let u = 0; u < index.count; u++) {
      const x = index.pos[3 * u], z = index.pos[3 * u + 2];
      if (keepA(x, z, u)) A[u >>> 5] |= 1 << (u & 31);
      if (keepB(x, z, u)) B[u >>> 5] |= 1 << (u & 31);
    }
    t.apply({ a: { bits: A }, b: { bits: keepB === keepA ? A : B }, f: fade });
    f.applyVisibility();
  };
  return w;
}

// The bytes trees first .. first + n - 1 of a twin's per-tree attribute
// hold on the CPU (what apply() staged).
const treeBytes = (attribute, first, n) => {
  const { data } = attribute, bpe = data.array.BYTES_PER_ELEMENT;
  return Buffer.from(data.array.buffer, data.array.byteOffset + first * data.stride * bpe, n * data.stride * bpe);
};
const treeAt = (g, i) => {
  const p = g.attributes.iPos.data.array, s = g.attributes.iSize.data.array, v = g.attributes.iVar.data.array;
  return { x: p[3 * i], y: p[3 * i + 1], z: p[3 * i + 2], h: s[2 * i], w: s[2 * i + 1], species: v[2 * i], id: v[2 * i + 1] };
};
// How a draw's attribute is read, but for where it starts and its GL buffer
// (each arm has its own context).
const reading = ({ offsetBytes, buffer, ...rest }) => rest;
const signature = (d, instances = true) => `${d.arrays ? 'arrays' : 'elements'} ${d.count}x${instances ? d.instances ?? 1 : '-'}@${d.offset ?? d.first}`
  + ` program ${d.program} scissor ${d.scissorTest} ${d.scissor} index ${d.indexHash} vertex ${d.vertex}`;
// What an object holds per vertex when three reaches it: its index and
// every attribute that is not per instance, by content. (The recording
// context binds only the attributes a shader declares with `in`, so
// position and normal, from three's own prefix, reach no pointer there.)
const contentHash = new WeakMap();
const hashOf = array => {
  if (!contentHash.has(array)) contentHash.set(array, sha(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)));
  return contentHash.get(array);
};
const perVertex = snap => [`index ${snap.index ? hashOf(snap.index.array) : '-'}`, ...Object.entries(snap.attributes)
  .filter(([, a]) => !a.isInstancedBufferAttribute && !a.data?.isInstancedInterleavedBuffer)
  .map(([name, a]) => `${name} ${hashOf(a.array)}`).sort()].join(' | ');
const firstOf = attributes => attributes.iPos.isInterleavedBufferAttribute ? attributes.iPos.offset / attributes.iPos.data.stride : 0;

/** Compare one render of the same view in the spans-off world `A` and the
 *  spans-on world `B`. */
function compareRender(label, A, B, offEvents, onEvents, stats) {
  const skeleton = evs => evs.filter(e => e.op !== 'draw').map(e => e.key);
  assert.deepEqual(skeleton(onEvents), skeleton(offEvents), `${label}: the same objects, programs and vertex arrays, in the same order`);
  const byObject = evs => {
    const out = [{ e: null, draws: [] }];
    for (const e of evs) if (e.op === 'object') out.push({ e, draws: [] }); else if (e.op === 'draw') out.at(-1).draws.push(e.draw);
    return out;
  };
  const offs = byObject(offEvents), ons = byObject(onEvents);
  const offDraws = offEvents.filter(e => e.op === 'draw').length, onDraws = onEvents.filter(e => e.op === 'draw').length;
  assert.ok(onDraws <= offDraws, `${label}: spans never add a draw (${onDraws} > ${offDraws})`);
  stats.renders++; stats.draws += onDraws; stats.offDraws += offDraws;
  for (const e of [...offEvents, ...onEvents]) if (e.op === 'draw') assert.deepEqual(e.draw.short || [], [], `${label}: no draw reads past an instanced attribute`);
  const pu = portUniforms(B.f.uniforms), planes = clipPlanes(B.camera, B.target), r = rng(stats.renders * 7919 + 1);
  const checked = new Map();
  for (let j = 0; j < offs.length; j++) {
    const off = offs[j], on = ons[j], geometry = on.e?.mesh.geometry;
    if (on.e && on.e.mesh.geometry) assert.equal(perVertex(on.e.snap), perVertex(off.e.snap), `${label}: an object holds the same vertices`);
    if (!on.e || !B.twins.has(geometry)) {
      assert.equal(on.draws.length, off.draws.length, `${label}: an object other than a twin keeps its draws`);
      off.draws.forEach((d, i) => {
        assert.equal(signature(on.draws[i]), signature(d), `${label}: a draw other than a twin's is unchanged`);
        assert.deepEqual(Object.keys(on.draws[i].attribs).sort(), Object.keys(d.attribs).sort());
        for (const [name, a] of Object.entries(d.attribs)) assert.deepEqual({ ...reading(on.draws[i].attribs[name]), offsetBytes: on.draws[i].attribs[name].offsetBytes }, { ...reading(a), offsetBytes: a.offsetBytes }, `${label}: ${name} of a draw other than a twin's is read as before`);
        assert.deepEqual(Object.keys(on.draws[i].reads || {}), Object.keys(d.reads || {}));
        for (const name of Object.keys(d.reads || {})) assert.ok(Buffer.from(on.draws[i].reads[name]).equals(Buffer.from(d.reads[name])), `${label}: ${name} bytes of a draw other than a twin's`);
      });
      continue;
    }
    assert.ok(off.draws.length <= 1 && on.draws.length <= off.draws.length, `${label}: a twin draws once, or not at all with spans`);
    if (!off.draws.length) continue;
    const whole = off.draws[0], n = whole.instances;
    assert.equal(firstOf(off.e.snap.attributes), 0, `${label}: whole-twin culling reads every twin from its first tree`);
    assert.equal(n, Math.min(on.e.snap.attributes.iPos.count, Math.floor(off.e.snap.count)), `${label}: whole-twin culling draws the twin's prefix`);
    for (const name of PER_TREE) if (whole.reads[name]) {
      assert.ok(Buffer.from(whole.reads[name]).equals(treeBytes(off.e.snap.attributes[name], 0, n)), `${label}: a whole twin reads its ${name} as apply() staged it`);
    }
    let first = 0, drawn = 0;
    if (on.draws.length) {
      const d = on.draws[0];
      first = firstOf(on.e.snap.attributes); drawn = d.instances;
      assert.equal(signature(d, false), signature(whole, false), `${label}: a twin's span is the same draw, but for its instance count`);
      assert.ok(Number.isInteger(first) && first % SPAN_ALIGN === 0, `${label}: a span starts at a multiple of ${SPAN_ALIGN} trees (${first})`);
      assert.ok(drawn > 0 && first + drawn <= n, `${label}: a span lies inside the prefix`);
      assert.deepEqual(Object.keys(d.reads).sort(), Object.keys(whole.reads).sort());
      assert.deepEqual(Object.keys(d.attribs).sort(), Object.keys(whole.attribs).sort());
      for (const [name, a] of Object.entries(whole.attribs)) {
        // Read as whole-twin culling reads it: the same type, normalization,
        // stride and divisor; only a per-tree attribute's start may move.
        assert.deepEqual(reading(d.attribs[name]), reading(a), `${label}: a span reads ${name} as the whole twin does`);
        if (!PER_TREE.includes(name)) assert.equal(d.attribs[name].offsetBytes, a.offsetBytes, `${label}: ${name} starts where it did`);
      }
      for (const name of PER_TREE) if (d.attribs[name]) {
        // As main reads them: floats, and iTour's bytes as whole numbers 0..3.
        assert.deepEqual([d.attribs[name].type, d.attribs[name].normalized, d.attribs[name].integer], [name === 'iTour' ? 'UNSIGNED_BYTE' : 'FLOAT', false, false], `${label}: ${name} is read as main reads it`);
      }
      for (const name of Object.keys(whole.reads)) {
        const a = whole.attribs[name], span = Buffer.from(d.reads[name]), all = Buffer.from(whole.reads[name]);
        if (a.divisor === 1) {
          assert.ok(span.equals(all.subarray(first * a.sizeBytes, (first + drawn) * a.sizeBytes)), `${label}: a span reads ${name} of trees ${first} to ${first + drawn - 1} of the whole draw, in order`);
          assert.ok(span.equals(treeBytes(on.e.snap.attributes[name], first, drawn)), `${label}: a span reads the ${name} apply() staged for its trees`);
        } else assert.ok(span.equals(all), `${label}: ${name}, one value for every instance, is unchanged`);
      }
      if (drawn < n) stats.partial++;
      if (first > 0) stats.offset++;
    } else stats.vanished++;
    // Every tree the span leaves out makes no fragment: all its vertices
    // outside one clip plane, through the shader port. Once per geometry
    // and span (its meshes draw the same span).
    const key = `${first}:${drawn}`, seen = checked.get(geometry);
    if (seen) { assert.equal(seen, key, `${label}: every mesh of a twin draws one span`); continue; }
    checked.set(geometry, key);
    const asset = { attributes: { position: on.e.snap.attributes.position, aBranch: on.e.snap.attributes.aBranch } };
    for (let i = 0; i < n; i++) {
      if (i >= first && i < first + drawn) { stats.kept++; continue; }
      stats.dropped++;
      assert.ok(noFragment(asset, treeAt(geometry, i), pu, planes, r, stats), `${label}: tree ${i} of a twin, left out of the span [${first}, ${first + drawn - 1}], can reach the view`);
    }
    // The loose box holds every vertex of a tree the port places (a check
    // of the check, on one tree per span).
    const tree = treeAt(geometry, Math.floor(r() * n)), box = looseBox(asset, tree, pu), e = edgy(r);
    for (let k = 0; k < asset.attributes.position.count; k++) {
      const [x, y, z] = meshVertex(asset, k, tree, pu, e, r);
      assert.ok(x >= box[0] && y >= box[1] && z >= box[2] && x <= box[3] && y <= box[4] && z <= box[5], 'the loose box holds the tree');
    }
  }
}

const look = (eye, yawDeg, pitch = -.08, extra = {}) => {
  const a = yawDeg * Math.PI / 180;
  return { eye, at: [eye[0] + Math.sin(a), eye[1] + pitch, eye[2] + Math.cos(a)], ...extra };
};

test('spans submit what whole-twin culling submits, call for call and byte for byte, less trees that make no fragment', () => {
  const placed = placedTrees(1), uniforms = forestUniforms();
  const A = world(false, placed, uniforms), B = world(true, placed, uniforms);
  const stats = { renders: 0, draws: 0, offDraws: 0, partial: 0, offset: 0, vanished: 0, kept: 0, dropped: 0, ported: 0 };
  const both = fn => { fn(A); fn(B); };
  const step = (label, view) => compareRender(label, A, B, A.render(view), B.render(view), stats);
  both(w => w.fill(() => true));
  const centre = [0, 30, 0], aside = [-300, 60, 120];
  for (let yaw = 0; yaw < 360; yaw += 30) step(`turning ${yaw}`, look(centre, yaw));
  for (let yaw = 15; yaw < 360; yaw += 60) step(`aside ${yaw}`, look(aside, yaw, -.2));
  // The same view twice: the second render draws from what the first set up.
  step('again', look(centre, 75)); step('again', look(centre, 75));
  for (const [i, scissor] of [[0, 0, 60, 180], [130, 60, 40, 30], [220, 100, 100, 80], [0, 0, 320, 20]].entries()) step(`scissor ${i}`, look(centre, 120, -.1, { scissor }));
  // Mirrors: the view reflected in a lake plane below the eye.
  for (const yaw of [0, 100, 230]) step(`mirror ${yaw}`, look([60, 45, -40], yaw, .15, { mirror: 2 }));
  step('near far', look(centre, 200, -.05, { far: 150 }));
  step('far near', look(centre, 200, -.05, { near: 120 }));
  step('narrow', look(aside, 90, -.1, { fov: 8 }));
  step('wide', look(centre, 300, -.3, { fov: 110 }));
  step('down', { eye: [50, 500, -30], at: [50.1, 0, -30] });
  // Behind: every tree out of view, so every twin goes.
  step('behind', look([0, 30, 1200], 0, .02));
  step('above', { eye: [0, 5000, 0], at: [0, 6000, .1] });
  step('back', look(centre, 75));
  // Refills: fewer trees in other slots, then a fade between two sets.
  both(w => w.fill(x => x > -100));
  for (const yaw of [30, 160, 280]) step(`refilled ${yaw}`, look(centre, yaw));
  both(w => w.fill((x, z, u) => (u & 3) !== 0, (x, z) => z < 150, .4));
  for (const yaw of [0, 140, 250]) step(`fading ${yaw}`, look(aside, yaw, -.15));
  // The music lifts and leans the trees: the bounds grow, and the spans
  // with them, over the very view the last span was found for. From above
  // the trees, looking up: the lift brings trees up through the bottom edge.
  const lift = on => {
    uniforms.uDeformAmp.value = on ? 30 : 3; uniforms.uDeformKick.value = on ? 12 : 1;
    uniforms.uWind.value.set(on ? 2.5 : 1.2, on ? .3 : .02); uniforms.uLandDance.value.set(on ? 4 : 0, on ? .5 : 0, on ? 2 : 0, on ? 1.3 : 0);
  };
  for (const yaw of [60, 150, 240, 330]) {
    const view = look([0, 120, 0], yaw, .3);
    step(`still ${yaw}`, view); lift(true); step(`lifted ${yaw}`, view); lift(false); step(`settled ${yaw}`, view);
  }
  lift(true);
  for (const yaw of [140, 250]) step(`lifted aside ${yaw}`, look(aside, yaw, -.15));
  lift(false);
  // The lite twins draw (nearDetail off), then the pixel asset (on).
  both(w => w.fill(() => true));
  both(w => w.f.updateDetailView({ camera: w.camera, width: W, height: H, pixelated: true, nearDetail: false }));
  for (const yaw of [20, 200]) step(`lite ${yaw}`, look(centre, yaw));
  both(w => w.f.updateDetailView({ camera: w.camera, width: W, height: H, pixelated: true, nearDetail: true }));
  for (const yaw of [20, 200]) step(`pixel ${yaw}`, look(centre, yaw));
  // A render that throws after the cull leaves its spans in place; then
  // the lite twins change asset with no restore between (each forest on its
  // own: the restore list is shared). The next render puts back only what
  // the spans put in.
  both(w => w.f.updateDetailView({ camera: w.camera, width: W, height: H, pixelated: true, nearDetail: false }));
  const thrown = view => [A, B].map(w => {
    w.render(view);
    w.armed = true;
    assert.throws(() => w.render(view), /render threw/);
    w.armed = false;
    if (w === B) assert.ok([...w.liteTwins].some(g => g.attributes.iPos.offset > 0), 'the thrown render left a lite twin in a span');
    for (const group of w.t.detailGroups) {
      const base = group.lite.index === group.pixelBase.index ? group.qualityBase : group.pixelBase;
      group.lite.setIndex(base.index);
      for (const [name, attribute] of Object.entries(base.attributes)) group.lite.setAttribute(name, attribute);
    }
    return w.render(view);
  });
  for (const yaw of [20, 290]) { const [a, b] = thrown(look(centre, yaw)); compareRender(`thrown ${yaw}`, A, B, a, b, stats); }
  for (const w of [A, B]) for (const group of w.t.detailGroups) {
    const base = group.lite.index === group.pixelBase.index ? group.pixelBase : group.qualityBase;
    for (const [name, attribute] of Object.entries(base.attributes)) assert.equal(group.lite.attributes[name], attribute, 'a lite twin draws one asset');
  }
  // The spans path ran, and both ways: partial spans, offsets, twins gone.
  assert.ok(stats.partial > 500 && stats.offset > 300 && stats.vanished > 30, JSON.stringify(stats));
  assert.ok(stats.dropped > 5000 && stats.ported > 20, JSON.stringify(stats));
  assert.ok(stats.draws < stats.offDraws, 'spans drop the draws of twins out of view');
});

test('with spans a render never makes more draws than whole-twin culling', () => {
  const placed = placedTrees(2), uniforms = forestUniforms();
  const A = world(false, placed, uniforms), B = world(true, placed, uniforms);
  for (const w of [A, B]) w.fill(() => true);
  const r = rng(17);
  let fewer = 0;
  for (let i = 0; i < 40; i++) {
    const eye = [(r() - .5) * 1200, 10 + r() * 200, (r() - .5) * 1200];
    const view = { eye, at: [eye[0] + r() - .5, eye[1] - r() * .4, eye[2] + r() - .5], fov: 20 + r() * 80 };
    const [a, b] = [A, B].map(w => w.render(view).filter(e => e.op === 'draw').length);
    assert.ok(b <= a, `view ${i}: ${b} draws with spans, ${a} without`);
    if (b < a) fewer++;
  }
  assert.ok(fewer > 10, `${fewer} views drew fewer`);
});

// ---------------------------------------------------------------------------
// Vertex-array steadiness (T9): a span set is a new attribute object per
// first tree, kept while the twin draws nothing, so steady renders rebind
// nothing.

test('a frame drawn again with spans rebinds nothing: no vertexAttribPointer call', () => {
  const w = world(true, placedTrees(3), forestUniforms());
  w.fill(() => true);
  let spanned = 0;
  for (const view of [look([0, 30, 0], 40), look([-300, 60, 120], 200, -.2), look([0, 30, 0], 120, -.1, { scissor: [130, 60, 40, 30] }), look([60, 45, -40], 100, .15, { mirror: 2 })]) {
    const a = w.render(view), calls = w.state.pointerCalls, b = w.render(view);
    assert.equal(w.state.pointerCalls - calls, 0, 'the second render of a frame makes no vertexAttribPointer call');
    const draws = evs => evs.filter(e => e.op === 'draw').map(e => `${signature(e.draw)} ${Object.values(e.draw.reads || {}).map(x => sha(x)).join(',')}`);
    assert.deepEqual(draws(b), draws(a));
    spanned += a.filter(e => e.op === 'object' && w.twins.has(e.mesh.geometry) && firstOf(e.snap.attributes) > 0).length;
  }
  assert.ok(spanned > 0, 'some twin drew from an offset');
});

test('a render that culls a twin to 0 keeps the span it last drew, so the twin comes back with no vertex array rebuilt', () => {
  const w = world(true, placedTrees(3), forestUniforms());
  w.fill(() => true);
  const main = look([0, 30, 0], 40), away = { eye: [0, 5000, 0], at: [0, 6000, .1] };
  // As RangeScene alternates the main view and a mirror facing elsewhere.
  for (let i = 0; i < 2; i++) { w.render(main); w.render(away); }
  const calls = w.state.pointerCalls;
  for (let i = 0; i < 4; i++) {
    const seen = w.render(main).filter(e => e.op === 'object' && w.twins.has(e.mesh.geometry));
    const held = new Map(seen.map(e => [e.mesh.geometry, e.snap.attributes.iPos]));
    assert.ok([...held.values()].some(a => a.offset > 0), 'the main view draws twins from an offset');
    const gone = w.render(away);
    assert.equal(gone.filter(e => e.op === 'draw' && w.twins.has(e.draw.drawing?.geometry)).length, 0, 'facing away, no twin draws');
    for (const e of gone) if (e.op === 'object' && held.has(e.mesh.geometry)) {
      assert.equal(e.snap.count, 0, 'a twin out of view draws no tree');
      assert.equal(e.snap.attributes.iPos, held.get(e.mesh.geometry), 'and holds the span set it last drew with');
    }
  }
  assert.equal(w.state.pointerCalls - calls, 0, 'steady frames make no vertexAttribPointer call');
});

// ---------------------------------------------------------------------------
// What spans need of a twin's attributes (ForestCulling spannable): a twin
// with a per-tree attribute that cannot start at an offset is culled whole.

test('a twin with a per-tree attribute a span cannot offset is culled whole, its attributes untouched', () => {
  const f = createForest(THREE, placedTrees(4), forestUniforms(), { tour: { seed: 5 } }), t = f.tour;
  for (const g of f.modeGeometries) setTerrainDrawMode(g, 'tour');
  t.setMode('tour');
  t.apply({ a: t.index.all, b: t.index.all, f: 1 });
  f.applyVisibility();
  const detail = t.twins.filter(x => x.lite).map(x => x.detail).sort((a, b) => b.instanceCount - a.instanceCount)[0];
  const n = detail.instanceCount;
  assert.ok(n > 40);
  // Narrow, at the twin's middle tree from beside it: a few of its trees.
  const mid = treeAt(detail, n >> 1), camera = new THREE.PerspectiveCamera(6, 1, 385, 415);
  camera.position.set(mid.x - 400, mid.y + 15, mid.z); camera.lookAt(mid.x, mid.y + 15, mid.z); camera.updateMatrixWorld();
  camera.layers.enableAll();
  const mesh = t.byBand.near.find(m => m.geometry === detail && m.visible);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cull = () => {
    const before = { ...detail.attributes }, touched = cullForestScene(scene, camera, null, null, { touched: [] });
    const out = { count: detail.instanceCount, swapped: Object.keys(before).filter(k => detail.attributes[k] !== before[k]), touched: touched.slice() };
    restoreForestScene(touched);
    assert.equal(detail.instanceCount, n);
    for (const k of Object.keys(before)) assert.equal(detail.attributes[k], before[k], 'the restore puts every attribute back');
    return out;
  };
  // As built: a span, from an offset, of fewer trees.
  const spanned = cull();
  assert.ok(spanned.count > 0 && spanned.count < n, `a span of ${spanned.count} of ${n}`);
  assert.deepEqual(spanned.swapped.sort(), ['iPos', 'iSize', 'iTour', 'iVar']);
  const visible = forestGeometryVisible(detail, frustumPlanes(camera, null), detail.userData.forestCull.uniforms);
  assert.equal(visible, true);
  const array = (k, size) => new Float32Array(k * size).fill(.5);
  const interleaved = (k, size, { stride = size, offset = 0, meshPerAttribute = 1 } = {}) => new THREE.InterleavedBufferAttribute(new THREE.InstancedInterleavedBuffer(new Float32Array(k * stride), stride, meshPerAttribute), size, offset);
  const cap = detail.attributes.iPos.count;
  const cases = {
    'a per-tree InstancedBufferAttribute': () => detail.setAttribute('iExtra', new THREE.InstancedBufferAttribute(array(cap, 2), 2)),
    'one value for too few instances': () => detail.setAttribute('iExtra', new THREE.InstancedBufferAttribute(array(1, 1), 1, false, 3)),
    'an interleaved attribute from an offset': () => detail.setAttribute('iExtra', interleaved(cap + 1, 1, { offset: 1, stride: 2 })),
    'an interleaved attribute wider than its item': () => detail.setAttribute('iExtra', interleaved(cap, 3, { stride: 4 })),
    'an interleaved attribute of other trees': () => detail.setAttribute('iExtra', interleaved(cap + 8, 2)),
    'an interleaved attribute per two instances': () => detail.setAttribute('iExtra', interleaved(cap, 2, { meshPerAttribute: 2 })),
    'iPos not interleaved': () => detail.setAttribute('iPos', new THREE.InstancedBufferAttribute(detail.attributes.iPos.data.array, 3)),
  };
  for (const [name, add] of Object.entries(cases)) {
    const iPos = detail.attributes.iPos;
    add();
    const whole = cull();
    assert.equal(whole.count, n, `${name}: the twin draws all its trees`);
    assert.deepEqual(whole.swapped, [], `${name}: no attribute is swapped`);
    for (let i = 2; i < whole.touched.length; i += 3) assert.equal(whole.touched[i], null, `${name}: nothing to put back but the count`);
    detail.deleteAttribute('iExtra');
    detail.setAttribute('iPos', iPos);
    assert.ok(cull().count < n, 'and spans again once it is gone');
  }
  // Out of view, a refused twin is culled whole to 0, as a static batch.
  detail.setAttribute('iExtra', new THREE.InstancedBufferAttribute(array(cap, 2), 2));
  camera.lookAt(mid.x - 800, mid.y + 15, mid.z); camera.updateMatrixWorld();
  assert.equal(cull().count, 0);
  detail.deleteAttribute('iExtra');
  f.dispose();
});

// ---------------------------------------------------------------------------
// The three r186 internals that span identity rests on (T10), observed
// through the recording context on the vendored bundle.

const SPAN_VERT = 'in vec3 iPos;\nin float iTour;\nvoid main() { gl_Position = projectionMatrix * viewMatrix * vec4(position + iPos + vec3(iTour), 1.0); }';
const SPAN_FRAG = 'out vec4 c;\nvoid main() { c = vec4(1.0); }';
function bench(count = 10) {
  const { gl, canvas, state } = recordingWebGL2(64, 64, { gpu: true });
  const tap = tapContext(gl, state);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setIndex([0, 1, 2]);
  // Distinct bytes per tree, so a read from the wrong tree shows.
  const pos = Float32Array.from({ length: 3 * count }, (_, i) => i + .25), flags = Uint8Array.from({ length: count }, (_, i) => 100 + i);
  const posData = new THREE.InstancedInterleavedBuffer(pos, 3, 1).setUsage(THREE.DynamicDrawUsage);
  const flagData = new THREE.InstancedInterleavedBuffer(flags, 1, 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(posData, 3, 0));
  geometry.setAttribute('iTour', new THREE.InterleavedBufferAttribute(flagData, 1, 0));
  geometry.instanceCount = count;
  const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: SPAN_VERT, fragmentShader: SPAN_FRAG }));
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.PerspectiveCamera();
  camera.position.z = 5; camera.updateMatrixWorld();
  const render = () => { state.draws.length = 0; renderer.render(scene, camera); return state.draws.splice(0).filter(d => d.instances !== undefined); };
  return { gl, state, tap, renderer, geometry, mesh, scene, camera, render, pos, flags, posData, flagData };
}
const bytesOf = (array, from, n) => Buffer.from(array.buffer, array.byteOffset + from * array.BYTES_PER_ELEMENT, n * array.BYTES_PER_ELEMENT);

test('three points an interleaved instanced attribute at offset * bytesPerElement with stride * bytesPerElement, one step per instance', () => {
  const b = bench(10);
  b.render();
  b.geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(b.posData, 3, 6));
  b.geometry.setAttribute('iTour', new THREE.InterleavedBufferAttribute(b.flagData, 1, 5));
  b.geometry.instanceCount = 4;
  const [d] = b.render();
  assert.equal(d.instances, 4);
  assert.deepEqual({ ...d.attribs.iPos, buffer: undefined }, { divisor: 1, elementBytes: 12, sizeBytes: 12, offsetBytes: 24, type: 'FLOAT', normalized: false, integer: false, buffer: undefined });
  assert.deepEqual({ ...d.attribs.iTour, buffer: undefined }, { divisor: 1, elementBytes: 1, sizeBytes: 1, offsetBytes: 5, type: 'UNSIGNED_BYTE', normalized: false, integer: false, buffer: undefined });
  assert.ok(Buffer.from(d.reads.iPos).equals(bytesOf(b.pos, 6, 12)), 'instance i reads element offset/stride + i');
  assert.ok(Buffer.from(d.reads.iTour).equals(bytesOf(b.flags, 5, 4)));
  // A stride wider than the item: the pointer's stride is the buffer's.
  const wide = new THREE.InstancedInterleavedBuffer(new Float32Array(40), 4, 1);
  b.geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(wide, 3, 1));
  const [w] = b.render();
  assert.deepEqual([w.attribs.iPos.elementBytes, w.attribs.iPos.sizeBytes, w.attribs.iPos.offsetBytes], [16, 12, 4]);
});

test('three sets an instanced geometry\'s _maxInstanceCount once, from meshPerAttribute * data.count, and clamps no draw by an attribute\'s offset', () => {
  const b = bench(10);
  assert.equal(b.geometry._maxInstanceCount, undefined);
  b.geometry.instanceCount = 25;
  assert.equal(b.render()[0].instances, 10, 'a draw is min(instanceCount, _maxInstanceCount)');
  assert.equal(b.geometry._maxInstanceCount, 10);
  // A new attribute over a larger buffer: the vertex array is rebuilt, the
  // maximum is not.
  b.geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(new THREE.InstancedInterleavedBuffer(new Float32Array(3 * 40), 3, 1), 3, 0));
  b.geometry.setAttribute('iTour', new THREE.InterleavedBufferAttribute(new THREE.InstancedInterleavedBuffer(new Uint8Array(40), 1, 1), 1, 0));
  assert.equal(b.render()[0].instances, 10);
  assert.equal(b.geometry._maxInstanceCount, 10);
  // From an offset, the same count: three draws it, past the buffer's end
  // (cullForestScene keeps first + drawn within the prefix).
  b.geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(b.posData, 3, 3 * 6));
  b.geometry.setAttribute('iTour', new THREE.InterleavedBufferAttribute(b.flagData, 1, 6));
  b.geometry.instanceCount = 10;
  const [d] = b.render();
  assert.equal(d.instances, 10);
  assert.equal(d.short.length, 2, 'both instanced attributes read past their buffers');
  // One value for every instance (iLodWeight): count 1, meshPerAttribute n.
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', b.geometry.attributes.position); g.setIndex([0, 1, 2]);
  g.setAttribute('iTour', new THREE.InstancedBufferAttribute(new Float32Array([1]), 1, false, 7));
  g.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(3), 3, false, 7));
  g.instanceCount = 7;
  b.mesh.geometry = g;
  b.render();
  assert.equal(g._maxInstanceCount, 7);
});

test('three rebuilds a vertex array when an attribute object changes, never when only its offset does', () => {
  const b = bench(12);
  b.render();
  let calls = b.state.pointerCalls;
  const [same] = b.render();
  assert.equal(b.state.pointerCalls - calls, 0, 'nothing changed: nothing rebound');
  // The offset changed in place: three binds the old pointers.
  b.geometry.attributes.iPos.offset = 3 * 4;
  b.geometry.attributes.iTour.offset = 4;
  b.geometry.instanceCount = 8;
  calls = b.state.pointerCalls;
  const [stale] = b.render();
  assert.equal(b.state.pointerCalls - calls, 0);
  assert.equal(stale.attribs.iPos.offsetBytes, 0, 'an offset changed in place never reaches the GPU');
  assert.ok(Buffer.from(stale.reads.iPos).equals(bytesOf(b.pos, 0, 24)));
  assert.ok(Buffer.from(same.reads.iPos).subarray(0, 96).equals(Buffer.from(stale.reads.iPos)));
  // A new object at that offset: rebuilt, and read from it.
  b.geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(b.posData, 3, 3 * 4));
  b.geometry.setAttribute('iTour', new THREE.InterleavedBufferAttribute(b.flagData, 1, 4));
  calls = b.state.pointerCalls;
  const [moved] = b.render();
  assert.ok(b.state.pointerCalls - calls > 0);
  assert.equal(moved.attribs.iPos.offsetBytes, 48);
  assert.ok(Buffer.from(moved.reads.iPos).equals(bytesOf(b.pos, 12, 24)));
  assert.ok(Buffer.from(moved.reads.iTour).equals(bytesOf(b.flags, 4, 8)));
  // Back to an earlier object: rebuilt again (identity, not content).
  const set = b.geometry.attributes.iPos;
  b.geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(b.posData, 3, 3 * 4));
  calls = b.state.pointerCalls;
  b.render();
  assert.ok(b.state.pointerCalls - calls > 0, 'an equal but new object rebuilds');
  b.geometry.setAttribute('iPos', set);
  calls = b.state.pointerCalls;
  b.render();
  assert.ok(b.state.pointerCalls - calls > 0);
  calls = b.state.pointerCalls;
  b.render();
  assert.equal(b.state.pointerCalls - calls, 0);
});

test('an instanced draw of 0 instances makes no draw call, after three has set up its vertex array', () => {
  const b = bench(10);
  b.render();
  b.geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(b.posData, 3, 3 * 4));
  b.geometry.instanceCount = 0;
  const calls = b.state.pointerCalls;
  b.state.draws.length = 0;
  b.renderer.render(b.scene, b.camera);
  assert.deepEqual(b.state.draws, [], 'no draw call');
  assert.ok(b.state.pointerCalls - calls > 0, 'the new attribute was bound though nothing drew');
  // Drawn again with that attribute: nothing left to bind.
  b.geometry.instanceCount = 4;
  const again = b.state.pointerCalls;
  const [d] = b.render();
  assert.equal(b.state.pointerCalls - again, 0);
  assert.equal(d.instances, 4);
  assert.ok(Buffer.from(d.reads.iPos).equals(bytesOf(b.pos, 12, 12)));
});

test('Scene.onBeforeRender runs before three projects the scene, and onAfterRender after its last draw', () => {
  const b = bench(10);
  const other = new THREE.Mesh(b.geometry.clone(), b.mesh.material);
  other.frustumCulled = false;
  b.scene.add(other);
  b.render();
  const order = [];
  b.scene.onBeforeRender = () => {
    order.push('before');
    // What attachForestCulling changes there: a count, an attribute object,
    // visibility. Projection and the draws must see all three.
    b.geometry.instanceCount = 3;
    b.geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(b.posData, 3, 3 * 4));
    other.visible = false;
  };
  b.scene.onAfterRender = () => { order.push(`after ${b.state.draws.length}`); };
  const D = b.gl.drawElementsInstanced;
  b.gl.drawElementsInstanced = (...a) => { order.push('draw'); return D(...a); };
  const draws = b.render();
  assert.deepEqual(order, ['before', 'draw', 'after 1']);
  assert.equal(draws.length, 1, 'the object hidden before projection does not draw');
  assert.equal(draws[0].instances, 3);
  assert.ok(Buffer.from(draws[0].reads.iPos).equals(bytesOf(b.pos, 12, 9)));
});

test('an interleaved buffer with update ranges uploads one bufferSubData per range into its one GL buffer, shared by every attribute over it', () => {
  const b = bench(16);
  b.render();
  const gpu = () => b.state.bufferOf.get(b.pos).bytes;
  const created = b.tap.created;
  // Span sets: new attribute objects over the same buffer.
  b.geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(b.posData, 3, 3 * 8));
  b.geometry.instanceCount = 8;
  b.render();
  assert.equal(b.tap.created, created, 'no GL buffer for an attribute over a buffer three holds');
  // A refill of the first 5 trees, as apply() writes it.
  for (let i = 0; i < 15; i++) b.pos[i] = 1000 + i;
  b.posData.clearUpdateRanges();
  b.posData.addUpdateRange(0, 5 * b.posData.stride);
  b.posData.needsUpdate = true;
  b.tap.subData.length = 0;
  b.render();
  const ours = b.tap.subData.filter(s => s.src === b.pos);
  assert.deepEqual(ours.map(s => [s.dst, s.srcOffset, s.length]), [[0, 0, 15]]);
  assert.equal(b.tap.created, created, 'no GL buffer for a refill');
  assert.ok(Buffer.from(gpu()).equals(bytesOf(b.pos, 0, 48)), 'the GPU holds the refill');
  assert.deepEqual(b.posData.updateRanges, [], 'three clears the ranges it uploaded');
  // Two ranges apart: two calls, each at its own byte offset.
  b.pos[3 * 9] = 7; b.pos[3 * 14 + 2] = 8;
  b.posData.addUpdateRange(3 * 9, 3); b.posData.addUpdateRange(3 * 14, 3);
  b.posData.needsUpdate = true;
  b.tap.subData.length = 0;
  b.render();
  assert.deepEqual(b.tap.subData.filter(s => s.src === b.pos).map(s => [s.dst, s.srcOffset, s.length]), [[27 * 4, 27, 3], [42 * 4, 42, 3]]);
  assert.ok(Buffer.from(gpu()).equals(bytesOf(b.pos, 0, 48)));
  assert.equal(b.tap.created, created);
});

test('computeBoundingSphere reads only position, so a span set in place never changes a twin\'s sphere', () => {
  const b = bench(10);
  const read = new Set(), attributes = b.geometry.attributes;
  b.geometry.attributes = new Proxy(attributes, { get(t, k) { read.add(k); return t[k]; } });
  b.geometry.boundingSphere = null;
  b.geometry.computeBoundingSphere();
  const sphere = b.geometry.boundingSphere.clone();
  assert.deepEqual([...read], ['position']);
  b.geometry.attributes = attributes;
  b.geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(b.posData, 3, 3 * 4));
  b.geometry.boundingSphere = null;
  b.geometry.computeBoundingSphere();
  assert.deepEqual(b.geometry.boundingSphere, sphere);
});
