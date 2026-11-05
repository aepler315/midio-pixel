// Whole-batch culling of the mesh trees (ForestCulling.js): every vertex
// the tree shader can place lies inside its cell's box, and a batch the
// test culls has no vertex inside the camera's clip volume.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';
import { assetExtents, forestBounds, forestCells, forestCellBox, forestGeometryVisible, forestLean, cullForestScene, restoreForestScene,
  CROWN_RADIUS_PER_WIDTH, TRUNK_RADIUS_M } from '../src/world/alpine/ForestCulling.js';
import { frustumPlanes, CHUNK_BOX_PAD_M } from '../src/world/alpine/TerrainChunks.js';
import { DANCE_WAVE_BOUND } from '../src/world/alpine/MirrorScissor.js';
import { landRiseLift, riseFromUniforms, risenHeight, risePivot, LAND_RISE_KNEE } from '../src/world/alpine/LandRise.js';
import { coniferGeometry, createForest } from '../src/world/alpine/ForestGL.js';
import { crownHalfWidth } from '../src/world/alpine/ForestProfile.js';
import { FOREST_FAMILIES, FOREST_VARIANTS } from '../src/world/alpine/ForestSpeciesAssets.js';
import { WIND_SWAY, GUST_LEAN, PARTING_LEAN, WIND_DIR } from '../src/world/alpine/ForestWind.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
// Values in [0, 1] that land on the ends often: the bounds are tight there.
const edgy = r => () => { const v = r(); return v < .2 ? 0 : v > .8 ? 1 : r(); };
const fract = x => x - Math.floor(x);
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const crownBase = (s, id) => s < .5 ? .46 + .06 * id : s > 1.5 && s < 2.5 ? .015 : .08;
const crownRatio = s => s < .5 ? .30 : s < 1.5 ? .38 : s < 2.5 ? .265 : .425;

const ASSETS = [];
for (let family = 0; family < FOREST_FAMILIES; family++) for (let variant = 0; variant < FOREST_VARIANTS; variant++) {
  for (const lod of [0, 1, 2]) ASSETS.push({ family, variant, lod, geo: coniferGeometry(THREE, { lod, family, variant }) });
}

// The forest uniforms a frame can hold (production reaches uWind.x 1.8 and
// uParting.w 1; these go past both).
function uniforms(r) {
  const s = () => (r() * 2 - 1);
  const v = { amp: s() * 30, kick: s() * 20, structural: s() * 20, melodic: s() * 15, gesture: s() * 10,
    dance: { x: s() * 12, y: r(), z: s() * 8, w: r() * 6.3 } };
  if (r() < .25) Object.assign(v, { amp: 0, kick: 0, structural: 0, melodic: 0, gesture: 0, dance: { x: 0, y: 0, z: 0, w: 0 } });
  return {
    raw: v,
    uDeformAmp: { value: v.amp }, uDeformKick: { value: v.kick }, uDeformStructural: { value: v.structural },
    uDeformMelodic: { value: v.melodic }, uDeformGesture: { value: v.gesture }, uLandDance: { value: v.dance },
    uGlacierEnabled: { value: 0 }, uTime: { value: r() * 600 },
    uWind: { value: r() < .2 ? { x: 1, y: 0 } : { x: r() * 3, y: r() * .06 } },
    uParting: { value: r() < .3 ? { x: 0, y: 0, z: 90, w: 0 } : { x: s() * 400, y: s() * 400, z: 20 + r() * 120, w: r() * 1.5 } },
  };
}

// deformAt (TerrainDeform.js) with the receiver, tour fade, height, sines
// and the hierarchy texel drawn at random within their ranges.
function deformAt(u, e, r) {
  const d = u.raw, recv = e(), fade = e(), h = e(), sa = e() * 2 - 1, sm = e() * 2 - 1;
  const base = recv * fade * h * h * (d.amp * sa + d.kick + d.structural + d.melodic * sm + h * h * d.gesture);
  if (d.dance.x === 0 && d.dance.z === 0) return base;
  const hr = e(), spine = e(), cs = [e() * 255, e() * 255].map(v => (v - 127.5) / 127.5);
  const wave = cs[1] * Math.cos(d.dance.w) + cs[0] * Math.sin(d.dance.w);
  return base + recv * fade * hr * (d.dance.x * spine * (.35 + .65 * hr) + d.dance.z * wave);
}
const deformBound = u => { const d = u.raw; return Math.abs(d.amp) + Math.abs(d.kick + d.structural) + Math.abs(d.melodic) + Math.abs(d.gesture) + Math.abs(d.dance.x) + DANCE_WAVE_BOUND * Math.abs(d.dance.z); };

// windAt (ForestGL.js TREE_COMMON), with the gust's clamped lean and the
// camera-right direction drawn at random.
function windAt(tree, y01, u, e, r) {
  const ph = tree.id * 6.2831, t = u.uTime.value, wind = u.uWind.value, part = u.uParting.value;
  const s = Math.sin(t * .65 + ph) * .6 + Math.sin(t * 1.45 + ph * 1.7) * .25;
  const sway = [s * WIND_SWAY * wind.x, s * .4 * WIND_SWAY * wind.x];
  const gust = e() * 2 - 1, a = r() * Math.PI * 2;
  const ax = tree.x - part.x, az = tree.z - part.y, d = Math.hypot(ax, az);
  const p = part.w * (1 - smooth(part.z * .3, part.z, d));
  const lx = Math.cos(a) * gust * GUST_LEAN + ax / Math.max(d, 1) * p * PARTING_LEAN + WIND_DIR[0] * wind.y;
  const lz = Math.sin(a) * gust * GUST_LEAN + az / Math.max(d, 1) * p * PARTING_LEAN + WIND_DIR[1] * wind.y;
  const k = tree.h * y01 * y01;
  return [(sway[0] + lx) * k, (sway[1] + lz) * k];
}

// MESH_VERT's world position for vertex k of `geo` on `tree`.
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
  // Then the song's rise lowers it where it stands (LandRise.js riseLift),
  // read from the uniforms as the shader reads them, not through
  // riseFromUniforms, which the bound itself uses.
  const L = u.uLandRise?.value, E = u.uTourEye?.value;
  return [x, L && E ? y + landRiseLift(x, y, z, [E.x, E.y, E.z], L.x, L.y) : y, z];
}

// The song's rise with the eye near one of a batch's trees and below it, so
// the trees stand above the eye where the rise lowers them; a pivot half
// the time (LandRise.js risePivot). 40% of the time the eye is among the
// trees, inside a cell's footprint, where a box's nearest point to it is
// not a corner. The sink spans what the bound accepts, (0, 1]: a fifth of
// the time a small one, as at the end of every climb.
function rise(u, list, r) {
  const t = list[Math.floor(r() * list.length)], near = r() < .4, d = near ? 15 : 400;
  u.uTourEye = { value: { x: t.x + (r() * 2 - 1) * d, y: t.y - (near ? 1 + r() * 40 : 20 + r() * 600), z: t.z + (r() * 2 - 1) * d, w: r() < .5 ? 1 : 0 } };
  u.uLandRise = { value: { x: r() < .2 ? 1e-3 + r() * .049 : Math.min(1, .05 + r() * .96), y: r() < .5 ? 0 : r() * .3 } };
}

// A landscape standing still: no deformation, dance, wind or parting (the
// gust's lean stays, as in the shader).
const still = () => ({ raw: { amp: 0, kick: 0, structural: 0, melodic: 0, gesture: 0, dance: { x: 0, y: 0, z: 0, w: 0 } },
  uDeformAmp: { value: 0 }, uDeformKick: { value: 0 }, uDeformStructural: { value: 0 }, uDeformMelodic: { value: 0 },
  uDeformGesture: { value: 0 }, uLandDance: { value: { x: 0, y: 0, z: 0, w: 0 } }, uGlacierEnabled: { value: 0 },
  uTime: { value: 0 }, uWind: { value: { x: 0, y: 0 } }, uParting: { value: { x: 0, y: 0, z: 90, w: 0 } } });

function batch(base, trees) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  for (const [k, v] of Object.entries(base.attributes)) geo.setAttribute(k, v);
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(Float32Array.from(trees.flatMap(t => [t.x, t.y, t.z])), 3));
  geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(Float32Array.from(trees.flatMap(t => [t.h, t.w])), 2));
  geo.setAttribute('iVar', new THREE.InstancedBufferAttribute(Float32Array.from(trees.flatMap(t => [t.species, t.id])), 2));
  geo.instanceCount = trees.length;
  return geo;
}

function trees(r, n, spread = 2000) {
  return Array.from({ length: n }, () => {
    const thin = r() < .25;
    // Positions on the float32 grid, as the instance attribute holds them.
    return { x: Math.fround((r() * 2 - 1) * spread), y: Math.fround(800 + r() * 2400), z: Math.fround((r() * 2 - 1) * spread),
      h: Math.fround(thin ? 3 + r() * 4 : 3 + r() * 42), w: Math.fround(thin ? .05 + r() * .4 : .05 + r() * 12),
      species: Math.floor(r() * 4), id: Math.fround(r() * .999) };
  });
}

function cellOf(cells, tree) {
  for (let o = 0; o < cells.length; o += 8) {
    if (tree.x >= cells[o] && tree.x <= cells[o + 3] && tree.z >= cells[o + 2] && tree.z <= cells[o + 5]) return o;
  }
  return -1;
}

test('the tree shader still places vertices the way the bound reads it', () => {
  const f = createForest(THREE, { mesh: new Float32Array([0, 0, 0, 10, 4, 1, .5, 2]), billboard: new Float32Array(), stride: 8, count: 1 }, {});
  const vert = f.byBand.near.find(m => m.material.vertexShader.includes('aBranch')).material.vertexShader;
  const norm = s => s.replace(/\s+/g, ' ');
  for (const line of [
    'vec3 rootOf() { vec3 r = iPos; r.y += deformAt(iPos); return r; }',
    'float y01 = aBranch.w > .5 ? base + (1.0 - base) * position.y : position.y;',
    'vec2 radial = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * position.xz;',
    'float jitter = mix(.85, 1.15, fract(sin(iVar.y * 269.5 + aBranch.x * 183.3) * 43758.5453));',
    'float radius = crownHalfWidth(iVar.x, y01, iVar.y, side) / crownRatio(iVar.x) * iSize.y * jitter;',
    'vec2 xz = radial * (aBranch.w > .5 ? radius : (.12 + .14 * iVar.y) * (1.0 - .94 * y01));',
    'vec3 p = root + vec3(xz.x + w.x, y01 * iSize.x, xz.y + w.y);',
    'gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);',
    'return vec2(clamp(lean, -1.0, 1.0), sheen);',
    `vec2 sway = vec2(s, s * 0.4) * ${WIND_SWAY.toFixed(3)} * uWind.x;`,
    `vec2 lean = normalize(vec2(viewMatrix[0][0], viewMatrix[2][0]) + 1e-5) * gust.x * ${GUST_LEAN.toFixed(3)};`,
    `lean += away / max(dAway, 1.0) * part * ${PARTING_LEAN.toFixed(3)};`,
    `lean += vec2(${WIND_DIR[0].toFixed(6)}, ${WIND_DIR[1].toFixed(6)}) * uWind.y;`,
    'return (sway + lean) * iSize.x * y01 * y01;',
    'float s = sin(uTime * 0.65 + ph) * 0.6 + sin(uTime * 1.45 + ph * 1.7) * 0.25;',
    // The crown profile's largest factor is its .5 * rag (1 + .045 sin).
    'float rag = 1.0 + .045 * sin(v * 80.0 + id * 40.0 + side * 2.3) * fine;',
    'float crown = crownRatio(species) * (.97 + .03 * id) * .5 * smoothstep(base - .015, base + .025, v) * pow(1.0 - q, .8) * mix(.935, .87 + .13 * tooth, teeth) * rag;',
  ]) assert.ok(norm(vert).includes(norm(line)), line);
  // Whole spans too, so a statement added or changed anywhere in them fails
  // (the lines above say which term of the bound reads what).
  for (const span of [
    `vec2 windAt(float y01) {
      float ph = iVar.y * 6.2831;
      float s = sin(uTime * 0.65 + ph) * 0.6 + sin(uTime * 1.45 + ph * 1.7) * 0.25;
      vec2 sway = vec2(s, s * 0.4) * ${WIND_SWAY.toFixed(3)} * uWind.x;
      // The gust leans crowns the way the front travels (camera right in xz).
      vec2 gust = gustAt();
      vec2 away = iPos.xz - uParting.xy;
      float dAway = length(away);
      float part = uParting.w * (1.0 - smoothstep(uParting.z * 0.3, uParting.z, dAway));
      vGust = max(gust.y, part * 0.8);
      vec2 lean = normalize(vec2(viewMatrix[0][0], viewMatrix[2][0]) + 1e-5) * gust.x * ${GUST_LEAN.toFixed(3)};
      lean += away / max(dAway, 1.0) * part * ${PARTING_LEAN.toFixed(3)};
      // Downwind along the fixed world wind the clouds drift on, not camera right.
      lean += vec2(${WIND_DIR[0].toFixed(6)}, ${WIND_DIR[1].toFixed(6)}) * uWind.y;
      return (sway + lean) * iSize.x * y01 * y01;
    }`,
    `vec3 root = rootOf();
      float base = crownBase(iVar.x, iVar.y);
      float y01 = aBranch.w > .5 ? base + (1.0 - base) * position.y : position.y;
      // One rotation per tree keeps the authored spacing between sprays;
      // each branch then swings a little on its own.
      float angle = 6.283185 * fract(sin(iVar.y * 127.1) * 43758.5453)
        + (fract(sin(iVar.y * 91.7 + aBranch.x * 311.7) * 43758.5453) - .5) * .7 * aBranch.w;
      vec2 radial = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * position.xz;
      float jitter = mix(.85, 1.15, fract(sin(iVar.y * 269.5 + aBranch.x * 183.3) * 43758.5453));
      float side = radial.x < 0.0 ? -1.0 : 1.0;
      float radius = crownHalfWidth(iVar.x, y01, iVar.y, side) / crownRatio(iVar.x) * iSize.y * jitter;
      vec2 xz = radial * (aBranch.w > .5 ? radius : (.12 + .14 * iVar.y) * (1.0 - .94 * y01));
      vec2 w = windAt(y01);
      vec3 p = root + vec3(xz.x + w.x, y01 * iSize.x, xz.y + w.y);
      // The rise lowers the whole tree with the land under it (LandRise.js).
      vRiseK = 1.0 + riseGrad(p).y;
      p.y += riseLift(p);`,
    `float crownBase(float species, float id) { return species < .5 ? .46 + .06 * id : species > 1.5 && species < 2.5 ? .015 : .08; }
    float crownRatio(float species) { return species < .5 ? .30 : species < 1.5 ? .38 : species < 2.5 ? .265 : .425; }
    float crownHalfWidthFiltered(float species, float v, float id, float side, float dv) {
      float base = crownBase(species, id);
      float q = clamp((v - base) / (1.0 - base), 0.0, 1.0);
      float phase = id * 7.0 + (side < 0.0 ? .37 : .03), tiers = 6.0 + floor(id * 4.0);
      float t = fract(v * tiers + phase);
      // Each detail loses contrast before its own period becomes sub-pixel.
      float teeth = 1.0 - smoothstep(.25, .5, dv * tiers);
      float fine = 1.0 - smoothstep(.25, .5, dv * 80.0 / 6.283185);
      float tooth = smoothstep(0.0, .15, t) * sqrt(1.0 - t);
      float rag = 1.0 + .045 * sin(v * 80.0 + id * 40.0 + side * 2.3) * fine;
      float crown = crownRatio(species) * (.97 + .03 * id) * .5 * smoothstep(base - .015, base + .025, v)
        * pow(1.0 - q, .8) * mix(.935, .87 + .13 * tooth, teeth) * rag;
      float leader = .0025 * smoothstep(.85, .94, v) * max(0.0, (1.0 - v) / .06);
      return max(crown, leader);
    }
    float crownHalfWidth(float species, float v, float id, float side) {
      return crownHalfWidthFiltered(species, v, id, side, 0.0);
    }`,
  ]) assert.ok(norm(vert).includes(norm(span)), span.slice(0, 60));
  // Nothing moves the position between that span and its projection.
  const main = vert.slice(vert.indexOf('p.y += riseLift(p);'), vert.indexOf('gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);'));
  assert.ok(main.length > 0);
  assert.equal(main.split('\n').slice(1).filter(l => /\b(p|root)(\.[xyzw]{1,4})?\s*[-+*/]?=(?!=)/.test(l)).length, 0, 'nothing moves p after the rise');
  // No model matrix: positions are world positions whatever the mesh's.
  assert.doesNotMatch(vert, /\bmodelMatrix\b/);
  assert.equal(CROWN_RADIUS_PER_WIDTH, .5 * 1.045 * 1.15);
  assert.equal(TRUNK_RADIUS_M, .12 + .14);
});

test('every conifer asset is bounded: positions in [0, 1] up, foliage and trunk radii measured', () => {
  for (const a of ASSETS) {
    const ext = assetExtents(a.geo);
    assert.ok(ext, `${a.family}/${a.variant}/${a.lod}`);
    assert.ok(ext.foliage > 0 && ext.foliage < 2 && ext.trunk > 0 && ext.trunk < 2, JSON.stringify(ext));
  }
  // Above 1 (or below 0) the height term no longer holds: never culled.
  const bad = coniferGeometry(THREE, { lod: 1, family: 0, variant: 0 }).clone();
  bad.attributes.position.setY(0, 1.01);
  assert.equal(assetExtents(bad), null);
  assert.equal(assetExtents(new THREE.BufferGeometry()), null);
});

test('a cell holds its trees\' extremes whatever their order; bad ids and heights are handled', () => {
  const geo = ASSETS[4].geo;
  const list = [
    { x: 40, y: 1000, z: 40, h: 2, w: .6, species: 1, id: .3 },
    { x: 50, y: 990, z: 60, h: 30, w: 7.2, species: 1, id: .6002 },
    { x: 45, y: 1010, z: 30, h: 12, w: 9, species: 1, id: .1 },
    // Another cell, 256 m on.
    { x: 300, y: 500, z: 40, h: 5, w: 1, species: 1, id: .2 },
  ];
  const expect = [[40, 990, 30, 50, 1022, 60, 30, 9], [300, 500, 40, 300, 505, 40, 5, 1]];
  const asCells = c => Array.from({ length: c.length / 8 }, (_, i) => [...c.slice(i * 8, i * 8 + 8)].map(v => Math.round(v * 1e3) / 1e3))
    .sort((a, b) => a[0] - b[0]);
  for (const order of [[0, 1, 2, 3], [2, 1, 0, 3], [3, 1, 2, 0], [1, 0, 3, 2]]) {
    assert.deepEqual(asCells(forestCells(batch(geo, order.map(i => list[i])))), expect, `order ${order}`);
  }
  // A negative height reaches below the root; a negative width is a width.
  assert.deepEqual(asCells(forestCells(batch(geo, [{ x: 0, y: 100, z: 0, h: -20, w: -3, species: 1, id: .5 }]))), [[0, 80, 0, 0, 100, 0, 20, 3]]);
  // An id outside [0, 1] breaks the crown and trunk bounds: never culled.
  for (const id of [1.5, -.1, NaN]) assert.equal(forestCells(batch(geo, [{ ...list[0], id }])), null, `id ${id}`);
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 1000);
  camera.lookAt(0, 0, -1); camera.updateMatrixWorld();
  const out = batch(geo, [{ x: 0, y: 0, z: 5000, h: 10, w: 4, species: 1, id: 2 }]);
  assert.equal(forestGeometryVisible(out, frustumPlanes(camera, null), uniforms(rng(3))), true);
});

test('the root lift keeps a tree the music lifts into view, or sinks into it', () => {
  // A level camera with a 20 degree view; trees 500 m ahead.
  const tan = Math.tan(10 * Math.PI / 180);
  const view = (edgeY, up) => {
    const camera = new THREE.PerspectiveCamera(20, 1, 1, 5000);
    // The frame's bottom (or top) edge crosses edgeY 500 m ahead.
    const y = up ? edgeY + 500 * tan : edgeY - 500 * tan;
    camera.position.set(0, y, 0); camera.lookAt(0, y, -1); camera.updateMatrixWorld();
    return frustumPlanes(camera, null);
  };
  // No wind or parting, and a still landscape (a missing uniform is an
  // unknown bound, which never culls).
  const calm = { uWind: { value: { x: 0, y: 0 } }, uParting: { value: { x: 0, y: 0, z: 90, w: 0 } },
    uDeformAmp: { value: 0 }, uDeformKick: { value: 0 }, uDeformStructural: { value: 0 }, uDeformMelodic: { value: 0 },
    uDeformGesture: { value: 0 }, uLandDance: { value: { x: 0, y: 0, z: 0, w: 0 } } };
  const tree = batch(ASSETS[4].geo, [{ x: 0, y: 1000, z: -500, h: 20, w: 3, species: 1, id: .5 }]);
  const visible = (planes, extra) => forestGeometryVisible(tree, planes, { ...calm, ...extra });
  // Rising: the frame's bottom edge 10 m above the treetop.
  const above = view(1030, true);
  assert.equal(visible(above, {}), false, 'a still tree stays out of view');
  for (const [name, extra] of [
    ['kick', { uDeformKick: { value: 10 } }],
    ['amplitude', { uDeformAmp: { value: -10 } }],
    ['gesture', { uDeformGesture: { value: 10 } }],
    ['spine dance', { uLandDance: { value: { x: 10, y: 0, z: 0, w: 0 } } }],
    ['wave dance', { uLandDance: { value: { x: 0, y: 0, z: 10, w: 0 } } }],
  ]) assert.equal(visible(above, extra), true, `${name}: lifted 10 m into view`);
  // Sinking: the frame's top edge 10 m below the root.
  const below = view(990, false);
  assert.equal(visible(below, {}), false, 'a still tree stays out of view');
  for (const [name, extra] of [
    ['kick', { uDeformKick: { value: -10 } }],
    ['melodic', { uDeformMelodic: { value: 10 } }],
    ['spine dance', { uLandDance: { value: { x: -10, y: 0, z: 0, w: 0 } } }],
  ]) assert.equal(visible(below, extra), true, `${name}: sunk 10 m into view`);
  // The song's rise lowers land above the eye (the camera's) toward the
  // horizon: a tree standing above the frame's top edge comes down into it,
  // with or without a pivot.
  const eyeY = 990 - 500 * tan;
  for (const pivot of [0, .05]) {
    const risen = { uLandRise: { value: { x: .5, y: pivot } }, uTourEye: { value: { x: 0, y: eyeY, z: 0, w: 0 } } };
    assert.equal(visible(below, risen), true, `the rise brings it down into view (pivot ${pivot})`);
  }
  // A sink of 1e-4 drops it a few cm, inside the box's slack: the frame's
  // top keeps it above.
  assert.equal(visible(below, { uLandRise: { value: { x: 1e-4, y: 0 } }, uTourEye: { value: { x: 0, y: eyeY, z: 0, w: 0 } } }), false);
  // Tight: the frame's top edge 3 m above where the rise draws the root, for
  // a strong and a middling sink, with and without a pivot. The box has
  // about 5 m of slack here (the root lift's 1 m, the pad and the crown's
  // reach), so this pins the entry to within that; 'the entry's bounds hold
  // the tight ones' pins the rise it reads exactly.
  for (const [sink, pivot] of [[.9, 0], [.5, 0], [.5, .05]]) {
    const gap = y => y + 500 * tan - (1000 + landRiseLift(0, 1000, -500, [0, y, 0], sink, pivot));
    let lo = 0, hi = 1000;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (gap(m) < 3) lo = m; else hi = m; }
    const y = (lo + hi) / 2, risen = { uLandRise: { value: { x: sink, y: pivot } }, uTourEye: { value: { x: 0, y, z: 0, w: 0 } } };
    assert.ok(Math.abs(gap(y) - 3) < 1e-6 && y < 1000);
    assert.equal(visible(view(y + 500 * tan, false), risen), true, `sink ${sink}, pivot ${pivot}: 3 m of trunk in view`);
  }
  // A sink of .01, as near the end of every climb, still lowers a tree 8 km
  // out by some 13 m: unrisen it stands above the frame, risen its root
  // draws 3 m below the frame's top edge.
  const far = new THREE.PerspectiveCamera(20, 1, 1, 20000);
  far.position.set(0, 1000, 0); far.lookAt(0, 1000, -1); far.updateMatrixWorld();
  const edge = 1000 + 8000 * tan - 3, drawnRoot = y => y + landRiseLift(0, y, -8000, [0, 1000, 0], .01, 0);
  let lo = edge, hi = edge + 100;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (drawnRoot(m) < edge) lo = m; else hi = m; }
  const out = batch(ASSETS[4].geo, [{ x: 0, y: (lo + hi) / 2, z: -8000, h: 20, w: 3, species: 1, id: .5 }]);
  assert.ok((lo + hi) / 2 - edge > 10, 'the rise lowers it more than 10 m');
  assert.equal(forestGeometryVisible(out, frustumPlanes(far, null), calm), false, 'unrisen, it stands above the frame');
  assert.equal(forestGeometryVisible(out, frustumPlanes(far, null), { ...calm, uLandRise: { value: { x: .01, y: 0 } },
    uTourEye: { value: { x: 0, y: 1000, z: 0, w: 0 } } }), true, 'a sink of .01 brings it down into view');
});

test('the entry\'s bounds hold the tight ones, and read the rise as the shader does', () => {
  // The brute force builds its boxes from the tight bounds; forestBounds is
  // what forestGeometryVisible uses: it must hold them, with the rise taken
  // straight from the uniforms the shader reads.
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed * 3 + 2), u = uniforms(r), list = trees(r, 3);
    if (seed % 4) rise(u, list, r);
    const b = forestBounds(u), d = deformBound(u);
    assert.ok(b, `seed ${seed}: known`);
    assert.ok(b.lift.lo <= -d && b.lift.hi >= d && b.lean >= forestLean(u), `seed ${seed}: ${JSON.stringify(b)}`);
    const L = u.uLandRise?.value, E = u.uTourEye?.value;
    if (!L) { assert.equal(b.lift.rise, null); continue; }
    assert.deepEqual({ ...b.lift.rise }, { sink: L.x, eye: [E.x, E.y, E.z], knee: LAND_RISE_KNEE, pivot: L.y }, `seed ${seed}`);
  }
  assert.equal(forestBounds({ ...uniforms(rng(1)), uLandRise: { value: { x: 0, y: 0 } }, uTourEye: { value: { x: 0, y: 0, z: 0, w: 0 } } }).lift.rise, null);
});

test('every vertex the shader can place lies inside its cell\'s box (no safety factor, no padding)', () => {
  let checked = 0;
  for (let seed = 1; seed <= 36; seed++) {
    const r = rng(seed), e = edgy(r), u = uniforms(r);
    const asset = ASSETS[seed % ASSETS.length];
    const list = trees(r, 6, seed % 3 ? 2000 : 300);
    // Broshi passing among the trees half the time: the parting lean.
    if (seed % 2 === 0) u.uParting.value = { x: list[0].x + (r() * 2 - 1) * 30, y: list[0].z + (r() * 2 - 1) * 30, z: 60 + r() * 60, w: .5 + r() };
    if (seed % 3 !== 1) rise(u, list, r);
    const geo = batch(asset.geo, list), cells = forestCells(geo), ext = assetExtents(geo);
    const d = deformBound(u), lift = { lo: -d, hi: d, rise: riseFromUniforms(u) }, lean = forestLean(u);
    const box = new Float64Array(6);
    for (const tree of list) {
      const o = cellOf(cells, tree);
      assert.ok(o >= 0, 'every tree has a cell');
      forestCellBox(cells, o, ext, lift, lean, 0, box);
      for (let k = 0; k < asset.geo.attributes.position.count; k++) {
        const [x, y, z] = meshVertex(asset.geo, k, tree, u, e, r);
        // A float32 position against float64 math: allow 1 mm.
        const ok = x >= box[0] - 1e-3 && y >= box[1] - 1e-3 && z >= box[2] - 1e-3 && x <= box[3] + 1e-3 && y <= box[4] + 1e-3 && z <= box[5] + 1e-3;
        if (!ok) assert.fail(`seed ${seed} asset ${asset.family}/${asset.variant}/${asset.lod} vertex ${k}: ${[x, y, z].map(v => v.toFixed(3))} outside ${[...box].map(v => v.toFixed(3))}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 200000, `checked ${checked}`);
});

test('under the rise a box\'s floor is its bottom where it comes nearest the eye, not at a corner', () => {
  // Three trees in one cell and the eye over the cell, 100 m below and 20 m
  // from the lowest: the box comes nearest the eye along an edge, and its
  // corners are some 130 m away, where the rise lowers less.
  const asset = ASSETS[4].geo;
  const list = [{ x: 128, y: 900, z: 20, h: 8, w: 3, species: 1, id: .3 }, { x: 2, y: 960, z: 20, h: 8, w: 3, species: 1, id: .5 },
    { x: 254, y: 960, z: 20, h: 8, w: 3, species: 1, id: .7 }];
  const cells = forestCells(batch(asset, list)), ext = assetExtents(batch(asset, list)), box = new Float64Array(6);
  assert.equal(cells.length, 8, 'one cell');
  for (const pivot of [0, .05, .1]) {
    const u = { ...still(), uTourEye: { value: { x: 128, y: 800, z: 0, w: 1 } }, uLandRise: { value: { x: .9, y: pivot } } };
    const r = rng(11), e = edgy(r), lift = { lo: 0, hi: 0, rise: riseFromUniforms(u) };
    forestCellBox(cells, 0, ext, lift, forestLean(u), 0, box);
    let lowest = Infinity;
    for (const tree of list) for (let k = 0; k < asset.attributes.position.count; k++) {
      const [x, y, z] = meshVertex(asset, k, tree, u, e, r);
      assert.ok(x >= box[0] - 1e-3 && y >= box[1] - 1e-3 && z >= box[2] - 1e-3 && x <= box[3] + 1e-3 && y <= box[4] + 1e-3 && z <= box[5] + 1e-3,
        `pivot ${pivot} vertex ${k}: ${[x, y, z].map(v => v.toFixed(3))} outside ${[...box].map(v => v.toFixed(3))}`);
      lowest = Math.min(lowest, y);
    }
    // The case needs its geometry: a floor taken at the corners would cut
    // these trees, by more than the box's padding once there is a pivot.
    const corner = Math.min(...[[box[0], box[2]], [box[0], box[5]], [box[3], box[2]], [box[3], box[5]]]
      .map(([x, z]) => risenHeight(cells[1], Math.hypot(x - 128, z), lift.rise)));
    assert.ok(lowest < corner - (pivot ? CHUNK_BOX_PAD_M : 0), `pivot ${pivot}: corner floor ${corner.toFixed(3)}, lowest drawn ${lowest.toFixed(3)}`);
  }
  // The eye under a tree, and a metre or so beside a thin one, 200 m below
  // their roots: the floor still comes from the box's nearest point (the
  // shader clamps the distance at 1 m), up to steep pivots (risePivot does
  // not clamp them).
  for (const pivot of [.3, .6, 1.5]) for (const tree of [
    { x: .3, y: 1000, z: -.2, h: 20, w: 3, species: 1, id: .4 },
    { x: 1.8, y: 1000, z: .5, h: 3, w: .05, species: 1, id: .6 },
  ]) {
    const u = { ...still(), uTourEye: { value: { x: 0, y: 800, z: 0, w: 1 } }, uLandRise: { value: { x: .9, y: pivot } } };
    const geo = batch(asset, [tree]), one = forestCells(geo), r = rng(13), e = edgy(r);
    forestCellBox(one, 0, assetExtents(geo), { lo: 0, hi: 0, rise: riseFromUniforms(u) }, forestLean(u), 0, box);
    for (let k = 0; k < asset.attributes.position.count; k++) {
      const [x, y, z] = meshVertex(asset, k, tree, u, e, r);
      assert.ok(x >= box[0] - 1e-3 && y >= box[1] - 1e-3 && z >= box[2] - 1e-3 && x <= box[3] + 1e-3 && y <= box[4] + 1e-3 && z <= box[5] + 1e-3,
        `pivot ${pivot} tree at ${tree.x}: vertex ${k} ${[x, y, z].map(v => v.toFixed(3))} outside ${[...box].map(v => v.toFixed(3))}`);
    }
  }
});

test('the bound needs each of its terms', () => {
  // Shrink one term at a time: some vertex must land outside. A strong
  // parting inflates the lean of trees out of its reach, so it only runs
  // for the parting's own term.
  const escapes = (mutate, { parting = false, risen = false } = {}) => {
    for (let seed = 1; seed <= 36; seed++) {
      const r = rng(seed), e = edgy(r), u = uniforms(r);
      const asset = ASSETS[seed % ASSETS.length];
      const list = trees(r, 6, seed % 3 ? 2000 : 300);
      if (parting && seed % 2 === 0) u.uParting.value = { x: list[0].x + (r() * 2 - 1) * 30, y: list[0].z + (r() * 2 - 1) * 30, z: 60 + r() * 60, w: .5 + r() };
      if (risen) rise(u, list, r);
      const geo = batch(asset.geo, list), cells = forestCells(geo);
      const d = deformBound(u);
      let ext = assetExtents(geo), lift = { lo: -d, hi: d, rise: riseFromUniforms(u) }, lean = forestLean(u);
      ({ ext, lift, lean } = mutate({ ext, lift, lean, parting: u.uParting.value.w }));
      const box = new Float64Array(6);
      for (const tree of list) {
        forestCellBox(cells, cellOf(cells, tree), ext, lift, lean, 0, box);
        for (let k = 0; k < asset.geo.attributes.position.count; k++) {
          const [x, y, z] = meshVertex(asset.geo, k, tree, u, e, r);
          if (x < box[0] - 1e-3 || y < box[1] - 1e-3 || z < box[2] - 1e-3 || x > box[3] + 1e-3 || y > box[4] + 1e-3 || z > box[5] + 1e-3) return true;
        }
      }
    }
    return false;
  };
  assert.ok(escapes(m => ({ ...m, lean: m.lean * .8 })), 'wind lean');
  assert.ok(escapes(m => ({ ...m, lean: m.lean - PARTING_LEAN * Math.abs(m.parting) }), { parting: true }), 'parting lean');
  assert.ok(escapes(m => ({ ...m, lift: { ...m.lift, lo: m.lift.lo * .8 } })), 'root sinking');
  assert.ok(escapes(m => ({ ...m, lift: { ...m.lift, hi: m.lift.hi * .8 } })), 'root lift');
  assert.ok(escapes(m => ({ ...m, lift: { ...m.lift, rise: null } }), { risen: true }), 'the rise');
  assert.ok(escapes(m => ({ ...m, lift: { ...m.lift, rise: m.lift.rise && { ...m.lift.rise, sink: m.lift.rise.sink * .8 } } }), { risen: true }), 'the rise\'s sink');
});

test('the crown and trunk radii are within 10% of what the shader reaches', () => {
  // Their slack hides behind the wind term in the brute force above, so
  // check them on their own: the largest radius any foliage or trunk vertex
  // reaches, over every asset, species and a sweep of tree ids.
  let crown = 0, trunk = 0;
  for (const a of ASSETS) {
    const ext = assetExtents(a.geo), pos = a.geo.attributes.position, br = a.geo.attributes.aBranch;
    for (let species = 0; species < 4; species++) for (let t = 0; t < 120; t++) {
      const id = Math.fround(t / 120 + .004);
      for (let k = 0; k < pos.count; k++) {
        const tree = { x: 0, y: 0, z: 0, h: 1, w: 1, species, id };
        const px = pos.getX(k), pz = pos.getZ(k), py = pos.getY(k), bw = br.getW(k), bx = br.getX(k);
        const base = crownBase(species, id), y01 = bw > .5 ? base + (1 - base) * py : py;
        const angle = 6.283185 * fract(Math.sin(id * 127.1) * 43758.5453) + (fract(Math.sin(id * 91.7 + bx * 311.7) * 43758.5453) - .5) * .7 * bw;
        const rx = Math.cos(angle) * px + Math.sin(angle) * pz;
        const jitter = .85 + .3 * fract(Math.sin(id * 269.5 + bx * 183.3) * 43758.5453);
        if (bw > .5) {
          const radius = crownHalfWidth(species, y01, id, rx < 0 ? -1 : 1) / crownRatio(species) * jitter;
          crown = Math.max(crown, Math.hypot(px, pz) * radius / (ext.foliage * CROWN_RADIUS_PER_WIDTH * tree.w));
        } else {
          trunk = Math.max(trunk, Math.hypot(px, pz) * (.12 + .14 * id) * (1 - .94 * y01) / (ext.trunk * TRUNK_RADIUS_M));
        }
      }
    }
  }
  assert.ok(crown <= 1 && crown > .9, `crown reaches ${crown.toFixed(3)} of its bound`);
  assert.ok(trunk <= 1 && trunk > .9, `trunk reaches ${trunk.toFixed(3)} of its bound`);
});

test('a batch the test culls has no vertex inside the clip volume; one in front of the camera is never culled', () => {
  let culled = 0, kept = 0, culledRisen = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed * 7 + 3), e = edgy(r), u = uniforms(r);
    const asset = ASSETS[(seed * 5) % ASSETS.length];
    const camera = new THREE.PerspectiveCamera(20 + r() * 70, .5 + r() * 2, 1 + r() * 10, 6000 + r() * 30000);
    camera.position.set((r() * 2 - 1) * 1500, 1500 + r() * 2500, (r() * 2 - 1) * 1500);
    camera.lookAt((r() * 2 - 1) * 2000, 500 + r() * 2000, (r() * 2 - 1) * 2000);
    camera.updateMatrixWorld();
    if (seed % 4 === 0) {
      // A mirror: the view reflected across a lake plane (det -1).
      const level = 1000 + r() * 500;
      const reflect = new THREE.Matrix4().makeTranslation(0, level, 0).multiply(new THREE.Matrix4().makeScale(1, -1, 1)).multiply(new THREE.Matrix4().makeTranslation(0, -level, 0));
      camera.matrixWorldInverse.multiply(reflect);
    }
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const planes = frustumPlanes(camera, null);
    // The song's rise on a third of the views, from the camera's eye (a
    // mirror keeps the main eye, as RangeScene does).
    const risen = seed % 3 === 1;
    const ur = risen ? { ...u, uTourEye: { value: { x: camera.position.x, y: camera.position.y, z: camera.position.z, w: 1 } },
      uLandRise: { value: { x: .05 + r() * .9, y: r() < .5 ? 0 : r() * .2 } } } : u;
    for (let b = 0; b < 4; b++) {
      const list = trees(r, 3 + Math.floor(r() * 4), 4000);
      const geo = batch(asset.geo, list);
      if (forestGeometryVisible(geo, planes, ur)) { kept++; continue; }
      culled++; if (risen) culledRisen++;
      for (const tree of list) for (let k = 0; k < asset.geo.attributes.position.count; k += 3) {
        const [x, y, z] = meshVertex(asset.geo, k, tree, ur, e, r);
        const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12], cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
        const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14], cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
        const inside = cw > 0 && Math.abs(cx) <= cw && Math.abs(cy) <= cw && Math.abs(cz) <= cw;
        assert.ok(!inside, `seed ${seed}: a culled tree's vertex is in view`);
      }
    }
    // A tree on the camera's axis, well inside the near and far planes.
    const ahead = new THREE.Vector3(0, 0, -(camera.near + 200)).applyMatrix4(new THREE.Matrix4().copy(camera.matrixWorldInverse).invert());
    const one = batch(asset.geo, [{ x: ahead.x, y: ahead.y - 5, z: ahead.z, h: 10, w: 4, species: 1, id: .5 }]);
    assert.ok(forestGeometryVisible(one, planes, u), `seed ${seed}: the tree ahead is kept`);
  }
  assert.ok(culled > 20 && kept > 20 && culledRisen > 5, `culled ${culled} (${culledRisen} under the rise), kept ${kept}`);
});

test('the rise brings trees down through a frame\'s top edge; a batch it culls has no vertex in view', () => {
  // Views pitched up, the pivot from the camera as RangeScene sets it, and
  // trees standing just above the top edge: the rise lowers many of them
  // into the frame. Every batch with a vertex in view must be kept, and
  // enough of those must be out of view without the rise for that to test it.
  let brought = 0, culled = 0;
  const unit = (x, y, z, k = 1) => { const l = Math.hypot(x, y, z); return [k * x / l, k * y / l, k * z / l]; };
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 13 + 1), e = edgy(r);
    const fov = 20 + r() * 40, aspect = 1 + r(), pitch = (2 + r() * 15) * Math.PI / 180, eyeY = 500 + r() * 1500;
    const camera = new THREE.PerspectiveCamera(fov, aspect, 1, 40000);
    camera.position.set(0, eyeY, 0); camera.lookAt(0, eyeY + Math.tan(pitch), -1); camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    const pivot = risePivot(unit(m[8], m[9], m[10], -1), unit(m[4], m[5], m[6]), unit(m[0], m[1], m[2]), fov, aspect);
    const sink = r() < .3 ? .005 + r() * .05 : .05 + r() * .95;
    const u = { ...still(), uTourEye: { value: { x: 0, y: eyeY, z: 0, w: 1 } }, uLandRise: { value: { x: sink, y: pivot } } };
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const planes = frustumPlanes(camera, null), top = Math.tan(pitch + fov * Math.PI / 360);
    const half = Math.tan(fov * Math.PI / 360) * aspect, asset = ASSETS[(seed * 5) % ASSETS.length].geo;
    const inView = (tree) => {
      for (let k = 0; k < asset.attributes.position.count; k += 3) {
        const [x, y, z] = meshVertex(asset, k, tree, u, e, r);
        const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12], cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
        const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14], cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
        if (cw > 0 && Math.abs(cx) <= cw && Math.abs(cy) <= cw && Math.abs(cz) <= cw) return true;
      }
      return false;
    };
    for (let b = 0; b < 4; b++) {
      const list = Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
        const d = 300 + r() * 6000;
        return { x: Math.fround((r() * 2 - 1) * .5 * half * d), y: Math.fround(eyeY + d * top + 4 + r() * 80), z: Math.fround(-d),
          h: Math.fround(3 + r() * 40), w: Math.fround(.05 + r() * 10), species: Math.floor(r() * 4), id: Math.fround(r() * .999) };
      });
      const geo = batch(asset, list), seen = list.some(inView);
      if (!forestGeometryVisible(geo, planes, u)) {
        culled++;
        assert.ok(!seen, `seed ${seed} batch ${b}: culled with a vertex in view`);
      } else if (seen && !forestGeometryVisible(geo, planes, still())) brought++;
    }
  }
  assert.ok(brought > 60 && culled > 5, `brought into view ${brought}, culled ${culled}`);
});

test('an unknown bound never culls', () => {
  const r = rng(5), u = uniforms(r);
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 1000);
  camera.position.set(0, 0, 0); camera.lookAt(0, 0, -1); camera.updateMatrixWorld();
  const planes = frustumPlanes(camera, null);
  const behind = () => batch(ASSETS[3].geo, [{ x: 0, y: 0, z: 5000, h: 10, w: 4, species: 1, id: .5 }]);
  assert.equal(forestGeometryVisible(behind(), planes, u), false, 'behind the camera: culled');
  for (const broken of [
    { ...u, uWind: { value: { x: NaN, y: 0 } } },
    { ...u, uParting: { value: { x: 0, y: 0, z: 90, w: Infinity } } },
    { ...u, uDeformAmp: { value: undefined } },
    { ...u, uLandDance: { value: { x: NaN, y: 0, z: 0, w: 0 } } },
    { ...u, uLandRise: { value: { x: NaN, y: 0 } }, uTourEye: { value: { x: 0, y: 0, z: 0, w: 0 } } },
    { ...u, uLandRise: { value: { x: .5, y: 0 } }, uTourEye: { value: { x: NaN, y: 0, z: 0, w: 0 } } },
    { ...u, uLandRise: { value: { x: .5, y: Infinity } }, uTourEye: { value: { x: 0, y: 0, z: 0, w: 0 } } },
    // The shader reads the pivot raw; riseFromUniforms makes these 0.
    { ...u, uLandRise: { value: { x: .5, y: -.1 } }, uTourEye: { value: { x: 0, y: 0, z: 0, w: 0 } } },
    { ...u, uLandRise: { value: { x: .5, y: NaN } }, uTourEye: { value: { x: 0, y: 0, z: 0, w: 0 } } },
    // Above 1, drawn height falls with height: the bottom is not the floor.
    { ...u, uLandRise: { value: { x: 1.5, y: 0 } }, uTourEye: { value: { x: 0, y: 0, z: 0, w: 0 } } },
    // No eye: the shader measures from (0, 0, 0).
    { ...u, uLandRise: { value: { x: .5, y: 0 } } },
    // Just past each edge, and every eye axis.
    { ...u, uLandRise: { value: { x: 1 + 1e-9, y: 0 } }, uTourEye: { value: { x: 0, y: 0, z: 0, w: 0 } } },
    { ...u, uLandRise: { value: { x: .5, y: -1e-9 } }, uTourEye: { value: { x: 0, y: 0, z: 0, w: 0 } } },
    ...[['y', NaN], ['z', NaN], ['y', Infinity], ['z', -Infinity]].map(([k, v]) =>
      ({ ...u, uLandRise: { value: { x: .5, y: 0 } }, uTourEye: { value: { x: 0, y: 0, z: 0, w: 0, [k]: v } } })),
    {},
  ]) assert.equal(forestGeometryVisible(behind(), planes, broken), true, JSON.stringify([broken.uLandRise?.value, broken.uTourEye?.value]));
  // Why those edges: past them the box's floor is no floor. A tall tree far
  // above the eye draws below it.
  for (const [v, by] of [[{ x: 1.2, y: 0 }, 5], [{ x: .5, y: -.1 }, 50]]) {
    const tree = { x: 0, y: 3000, z: -2000, h: 45, w: 3, species: 1, id: .5 }, geo = batch(ASSETS[4].geo, [tree]);
    const uu = { ...still(), uLandRise: { value: v }, uTourEye: { value: { x: 0, y: 0, z: 0, w: 0 } } }, r2 = rng(2), e2 = edgy(r2);
    const box = forestCellBox(forestCells(geo), 0, assetExtents(geo), { lo: 0, hi: 0, rise: riseFromUniforms(uu) }, forestLean(uu), 0);
    let lowest = Infinity;
    for (let k = 0; k < ASSETS[4].geo.attributes.position.count; k++) lowest = Math.min(lowest, meshVertex(ASSETS[4].geo, k, tree, uu, e2, r2)[1]);
    assert.ok(lowest < box[1] - by, `${JSON.stringify(v)}: lowest drawn ${lowest.toFixed(2)}, floor ${box[1].toFixed(2)}`);
  }
  // A rise the box bounds, or none (a sink of 0 or less), still culls.
  for (const v of [{ x: .5, y: 0 }, { x: 1, y: .05 }, { x: 0, y: -5 }, { x: -1, y: NaN }]) {
    const risen = { ...u, uLandRise: { value: v }, uTourEye: { value: { x: 0, y: 0, z: 0, w: 0 } } };
    assert.equal(forestGeometryVisible(behind(), planes, risen), false, JSON.stringify(v));
  }
  assert.equal(forestGeometryVisible(behind(), null, u), true, 'no planes');
  const nan = behind(); nan.attributes.iPos.setX(0, NaN);
  assert.equal(forestGeometryVisible(nan, planes, u), true, 'a non-finite root');
  const flat = behind(); flat.deleteAttribute('aBranch');
  assert.equal(forestGeometryVisible(flat, planes, u), true, 'no branch attribute (a billboard)');
});

test('createForest marks mesh-tree batches for culling, never billboards', () => {
  const rows = (band, n) => Array.from({ length: n }, (_, i) => [i * 10, 0, -100, 12, 4, i % 4, (i * .137) % 1, band]).flat();
  const f = createForest(THREE, { meshDetail: new Float32Array(rows(2, 6)), mesh: new Float32Array(rows(2, 8)),
    billboard: new Float32Array(rows(1, 5)), stride: 8, count: 19 }, {});
  const all = [...Object.values(f.byBand).flat(), ...f.depth, ...Object.values(f.depthByBand).flat()];
  let marked = 0;
  for (const m of all) {
    const tagged = m.geometry.userData.forestCull;
    if (m.geometry.attributes.aBranch) { assert.ok(tagged); assert.equal(tagged.uniforms, f.uniforms); marked++; }
    else assert.equal(tagged, undefined, 'billboard');
  }
  assert.ok(marked > 0);
  // Detail and lite twins share their trees, so they share cells.
  const near = f.byBand.near.filter(m => m.userData.nearLod);
  const detail = near.find(m => m.userData.nearLod === 'detail'), lite = near.find(m => m.userData.nearLod === 'lite');
  assert.equal(forestCells(detail.geometry), forestCells(lite.geometry));
});

test('the tour layer\'s twins are culled over the trees they draw, never its demote boards; the static batches as before', () => {
  const rows = (band, n, z) => Array.from({ length: n }, (_, i) => [i * 10, 0, z, 12, 4, i % 4, (i * .137) % 1, band]).flat();
  const placed = { meshDetail: new Float32Array([...rows(2, 6, -100), ...rows(2, 4, 900)]), mesh: new Float32Array([...rows(2, 8, -300), ...rows(1, 3, 2000)]),
    billboard: new Float32Array(rows(1, 5, -4000)), stride: 8, count: 26, railCount: { meshDetail: 6, mesh: 8, billboard: 5 } };
  const plain = createForest(THREE, placed, {}), f = createForest(THREE, placed, {}, { tour: { seed: 3 } });
  const statics = forest => [...Object.values(forest.byBand).flat(), ...forest.depth, ...Object.values(forest.depthByBand).flat()];
  assert.deepEqual(statics(f).map(m => !!m.geometry.userData.forestCull), statics(plain).map(m => !!m.geometry.userData.forestCull));
  for (const m of statics(f)) if (m.geometry.attributes.aBranch) assert.equal(m.geometry.userData.forestCull.uniforms, f.uniforms);
  assert.ok(f.tour.every.length > 0 && f.tour.twins.length > 0 && f.tour.boards.length > 0);
  for (const m of f.tour.every) {
    const tagged = m.geometry.userData.forestCull;
    if (m.geometry.attributes.aBranch) assert.deepEqual(tagged, { uniforms: f.uniforms, prefix: true }, 'a twin is bound over its drawn prefix');
    else assert.equal(tagged, undefined, 'a demote board is never culled');
  }
  for (const t of f.tour.twins) for (const g of [t.detail, t.lite].filter(Boolean)) assert.equal(g.userData.forestCull.prefix, true);
  for (const g of f.tour.boards) assert.equal(g.userData.forestCull, undefined);
  // No static batch is bound over a prefix: their cells stay those of #81.
  for (const m of statics(f)) assert.ok(!m.geometry.userData.forestCull?.prefix);
  for (const forest of [plain, f]) forest.dispose();
});

test('a prefix batch\'s cells cover only the trees it draws and follow every refill; other batches ignore the count', () => {
  const geo = ASSETS[4].geo;
  const at = (x, z) => ({ x, y: 1000, z, h: 20, w: 5, species: 1, id: .5 });
  const asCells = c => Array.from({ length: c.length / 8 }, (_, i) => [...c.slice(i * 8, i * 8 + 3)]);
  // Static: every tree, whatever instanceCount says (a rail prefix included).
  const fixed = batch(geo, [at(10, 10), at(600, 10), at(1200, 10)]);
  fixed.userData.forestCull = { uniforms: {} };
  fixed.instanceCount = 1;
  assert.equal(forestCells(fixed).length, 3 * 8);
  // A twin: the first instanceCount trees only.
  const twin = batch(geo, [at(10, 10), at(600, 10), at(1200, 10)]);
  twin.userData.forestCull = { uniforms: {}, prefix: true };
  twin.instanceCount = 1;
  assert.deepEqual(asCells(forestCells(twin)), [[10, 1000, 10]]);
  twin.instanceCount = 2;
  assert.deepEqual(asCells(forestCells(twin)).sort((a, b) => a[0] - b[0]), [[10, 1000, 10], [600, 1000, 10]]);
  // A refill in place, same count: new roots, new cells (not the cached ones).
  const pos = twin.attributes.iPos;
  pos.setXYZ(0, 5000, 1000, -5000); pos.setXYZ(1, 5010, 1000, -5000); pos.needsUpdate = true;
  assert.deepEqual(asCells(forestCells(twin)), [[5000, 1000, -5000]]);
  // A refill of the heights alone is seen too.
  const size = twin.attributes.iSize;
  size.setX(0, 300); size.needsUpdate = true;
  assert.equal(forestCells(twin)[4], 1300);
  // So is a refill of the ids alone, at the same count: a bad id in the prefix.
  const vars = twin.attributes.iVar;
  vars.setY(0, 7); vars.needsUpdate = true;
  assert.equal(forestCells(twin), null, 'the cells are rebuilt when only the ids change');
  vars.setY(0, .5); vars.needsUpdate = true;
  assert.ok(forestCells(twin));
  // An id outside [0, 1] beyond the prefix is not drawn, so not read; inside it, never culled.
  twin.attributes.iVar.setY(2, 7); twin.attributes.iVar.needsUpdate = true;
  assert.ok(forestCells(twin));
  twin.instanceCount = 3;
  assert.equal(forestCells(twin), null);
  // The camera faces the refilled trees: the stale bound would have culled them.
  const u = uniforms(rng(4)), camera = new THREE.PerspectiveCamera(50, 1, 1, 20000);
  const moving = batch(geo, [at(0, -800), at(0, -900)]);
  moving.userData.forestCull = { uniforms: u, prefix: true };
  camera.position.set(0, 1010, 0); camera.lookAt(0, 1010, 1); camera.updateMatrixWorld();
  const planes = frustumPlanes(camera, null);
  assert.equal(forestGeometryVisible(moving, planes, u), false, 'behind the camera');
  moving.attributes.iPos.setZ(0, 800); moving.attributes.iPos.setZ(1, 900); moving.attributes.iPos.needsUpdate = true;
  assert.equal(forestGeometryVisible(moving, planes, u), true, 'refilled in front of it');
});

test('a prefix batch whose count is past its trees, three\'s default Infinity included, is bound over every tree, as three draws them', () => {
  const u = uniforms(rng(4)), camera = new THREE.PerspectiveCamera(50, 1, 1, 20000);
  camera.position.set(0, 1010, 0); camera.lookAt(0, 1010, -1); camera.updateMatrixWorld();
  const planes = frustumPlanes(camera, null);
  const at = z => ({ x: 0, y: 1000, z, h: 20, w: 5, species: 1, id: .5 });
  // The first tree behind the camera, the second straight ahead of it.
  const twin = batch(ASSETS[4].geo, [at(800), at(-800)]);
  twin.userData.forestCull = { uniforms: u, prefix: true };
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(twin));
  assert.equal(new THREE.InstancedBufferGeometry().instanceCount, Infinity, 'three\'s default count');
  // three draws min(instanceCount, the instance count): every tree.
  for (const count of [Infinity, 2 ** 31, 2 ** 32 + 1, 1e300]) {
    twin.instanceCount = count;
    assert.equal(forestCells(twin).length, 2 * 8, `count ${count}: every tree is bound`);
    assert.equal(forestGeometryVisible(twin, planes, u), true, `count ${count}: the tree ahead keeps the batch`);
    assert.equal(cullForestScene(scene, camera, null).length, 0, `count ${count}: not culled`);
    assert.equal(twin.instanceCount, count);
  }
  // Below the trees' count, the prefix as before: the one drawn tree is behind.
  for (const count of [1, 1.5]) {
    twin.instanceCount = count;
    assert.equal(forestCells(twin).length, 8);
    assert.equal(forestGeometryVisible(twin, planes, u), false, `count ${count}: culled`);
  }
  for (const count of [0, -1, NaN]) {
    twin.instanceCount = count;
    assert.equal(forestCells(twin).length, 0, `count ${count}: nothing drawn, nothing bound`);
  }
});

test('the culled count is restored however the scene\'s renders end', () => {
  const r = rng(9), u = uniforms(r);
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 1000);
  camera.position.set(0, 0, 0); camera.lookAt(0, 0, -1); camera.updateMatrixWorld();
  const mesh = new THREE.Mesh(batch(ASSETS[4].geo, [{ x: 0, y: 0, z: 5000, h: 10, w: 4, species: 1, id: .5 }]));
  mesh.geometry.userData.forestCull = { uniforms: u };
  // Batches differ in size: each gets its own count back.
  const tree = i => ({ x: i * 10, y: 0, z: 5000 + i * 50, h: 10, w: 4, species: 1, id: .25 });
  const two = new THREE.Mesh(batch(ASSETS[7].geo, [tree(1), tree(2)])), three = new THREE.Mesh(batch(ASSETS[2].geo, [tree(3), tree(4), tree(5)]));
  two.geometry.userData.forestCull = { uniforms: u }; three.geometry.userData.forestCull = { uniforms: u };
  const scene = new THREE.Scene(); scene.add(mesh, two, three);
  const stats = { kept: 0, total: 0, batches: 0 };
  const touched = cullForestScene(scene, camera, null, stats);
  assert.deepEqual([mesh, two, three].map(m => m.geometry.instanceCount), [0, 0, 0]);
  assert.deepEqual(stats, { kept: 0, total: 6, batches: 3 });
  restoreForestScene(touched);
  assert.deepEqual([mesh, two, three].map(m => m.geometry.instanceCount), [1, 2, 3]);
  assert.equal(touched.length, 0);
  scene.remove(two, three);
  // Hidden, or on a layer the camera skips: left alone.
  mesh.visible = false;
  assert.equal(cullForestScene(scene, camera, null).length, 0);
  mesh.visible = true; mesh.layers.set(3);
  assert.equal(cullForestScene(scene, camera, null).length, 0);
  mesh.layers.set(0); mesh.position.set(1, 0, 0); mesh.updateMatrixWorld();
  assert.equal(cullForestScene(scene, camera, null).length, 0, 'a moved mesh is not culled');
});

test('RangeScene culls the forest in every scene that culls the terrain', () => {
  const src = fs.readFileSync(new URL('../src/world/alpine/RangeScene.js', import.meta.url), 'utf8');
  assert.match(src, /attachTerrainCulling\(scene, lift, this\.terrainCull\);\s*attachForestCulling\(scene, this\.forestCull\);/);
  assert.match(src, /forestCull: \{ \.\.\.this\.forestCull \}/);
});
