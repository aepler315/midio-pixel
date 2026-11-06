// Whole-batch culling of the mesh trees (ForestCulling.js): every vertex
// the tree shader can place lies inside its cell's box, and a batch the
// test culls has no vertex inside the camera's clip volume.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';
import { assetExtents, forestBounds, forestCells, forestCellBox, forestGeometryVisible, forestLean, forestSpan, cullForestScene, restoreForestScene,
  CROWN_RADIUS_PER_WIDTH, TRUNK_RADIUS_M, SPAN_ALIGN, SPAN_SCAN_MAX } from '../src/world/alpine/ForestCulling.js';
import { frustumPlanes, boxOutsidePlanes, CHUNK_BOX_PAD_M } from '../src/world/alpine/TerrainChunks.js';
import { DANCE_WAVE_BOUND } from '../src/world/alpine/MirrorScissor.js';
import { landRiseLift, riseFromUniforms, risenHeight } from '../src/world/alpine/LandRise.js';
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
  // Then the song's rise maps its height toward the base (LandRise.js),
  // read from the uniforms as the shader reads them, not through
  // riseFromUniforms, which the bound itself uses.
  const L = u.uLandRise?.value;
  return [x, L ? y + landRiseLift(x, y, z, null, L.x, L.y) : y, z];
}

// Signed bases above and below the trees exercise both directions of travel.
// Include the exactly flat start and small sinks near the completed relief.
function rise(u, list, r) {
  const t = list[Math.floor(r() * list.length)];
  u.uLandRise = { value: { x: r() < .2 ? 1 : r() < .2 ? 1e-3 + r() * .049 : .05 + r() * .95,
    y: t.y + (r() * 2 - 1) * 3000 } };
}

// A landscape standing still: no deformation, dance, wind or parting (the
// gust's lean stays, as in the shader).
const still = () => ({ raw: { amp: 0, kick: 0, structural: 0, melodic: 0, gesture: 0, dance: { x: 0, y: 0, z: 0, w: 0 } },
  uDeformAmp: { value: 0 }, uDeformKick: { value: 0 }, uDeformStructural: { value: 0 }, uDeformMelodic: { value: 0 },
  uDeformGesture: { value: 0 }, uLandDance: { value: { x: 0, y: 0, z: 0, w: 0 } }, uGlacierEnabled: { value: 0 },
  uTime: { value: 0 }, uWind: { value: { x: 0, y: 0 } }, uParting: { value: { x: 0, y: 0, z: 90, w: 0 } } });

test('forest bounds transform their tops when trees rise from below the flat base', () => {
  const cells = Float64Array.of(0, 900, 0, 10, 1000, 10, 20, 3);
  const extents = { foliage: 1, trunk: 1 };
  const lift = { lo: 0, hi: 0, rise: { sink: 1, baseM: 2000 } };
  const box = forestCellBox(cells, 0, extents, lift, 0, 0);
  assert.equal(box[1], 2000);
  assert.equal(box[4], 2000);
  const bounds = forestBounds({ ...still(), uLandRise: { value: { x: .5, y: -300 } } });
  assert.deepEqual(bounds?.lift.rise, { sink: .5, baseM: -300 }, 'signed bases need no camera eye');
});

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

// A tour twin as ForestGL's twinGeometry builds it: each per-tree attribute
// a view at offset 0 of its own instanced buffer, stride = item size, room
// for `capacity` trees, drawing its first instanceCount (forestCull.prefix)
// span by span (forestCull.spans).
const spanned = (array, size) => new THREE.InterleavedBufferAttribute(new THREE.InstancedInterleavedBuffer(array, size, 1).setUsage(THREE.DynamicDrawUsage), size, 0);
function twin(base, list, { capacity = list.length, uniforms: u = {}, spans = true } = {}) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  for (const [k, v] of Object.entries(base.attributes)) geo.setAttribute(k, v);
  geo.setAttribute('iPos', spanned(new Float32Array(3 * capacity), 3));
  geo.setAttribute('iSize', spanned(new Float32Array(2 * capacity), 2));
  geo.setAttribute('iVar', spanned(new Float32Array(2 * capacity), 2));
  geo.setAttribute('iTour', spanned(new Uint8Array(capacity), 1));
  geo.userData.forestCull = { uniforms: u, prefix: true, spans };
  return refill(geo, list);
}
// Refill a twin in place as the tour layer's apply does: the same arrays,
// each buffer's version bumped, the count the trees it now holds.
function refill(geo, list) {
  const a = geo.attributes;
  list.forEach((t, i) => { a.iPos.setXYZ(i, t.x, t.y, t.z); a.iSize.setXY(i, t.h, t.w); a.iVar.setXY(i, t.species, t.id); a.iTour.setX(i, 1); });
  for (const name of ['iPos', 'iSize', 'iVar', 'iTour']) a[name].data.needsUpdate = true;
  geo.instanceCount = list.length;
  return geo;
}
// A lite twin over `detail`'s trees (ForestGL buildTwins): another asset,
// the same attribute objects.
function liteOf(detail, base) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  for (const [k, v] of Object.entries(base.attributes)) geo.setAttribute(k, v);
  for (const name of ['iPos', 'iSize', 'iVar', 'iTour']) geo.setAttribute(name, detail.attributes[name]);
  geo.userData.forestCull = { ...detail.userData.forestCull };
  geo.instanceCount = detail.instanceCount;
  return geo;
}
// A lite asset swap (ForestGL setLiteAsset): the index and base attributes
// of another asset, the trees kept.
function swapAsset(geo, base) {
  geo.setIndex(base.index);
  for (const [k, v] of Object.entries(base.attributes)) geo.setAttribute(k, v);
}
const treeAt = (geo, i) => {
  const a = geo.attributes;
  return { x: a.iPos.getX(i), y: a.iPos.getY(i), z: a.iPos.getZ(i), h: a.iSize.getX(i), w: a.iSize.getY(i), species: a.iVar.getX(i), id: a.iVar.getY(i) };
};
// The cell of one tree (forestCells' layout): what a span tests each tree by.
const oneTree = t => Float64Array.of(t.x, t.y + Math.min(0, t.h), t.z, t.x, t.y + Math.max(0, t.h), t.z, Math.abs(t.h), Math.abs(t.w));

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
  // A tree above the frame can move into it toward either base.
  for (const baseM of [800, 900]) {
    const risen = { uLandRise: { value: { x: .5, y: baseM } } };
    assert.equal(visible(below, risen), true, `the rise brings it down into view (base ${baseM})`);
  }
  // A sink of 1e-4 drops it a few cm, inside the box's slack: the frame's
  // top keeps it above.
  assert.equal(visible(below, { uLandRise: { value: { x: 1e-4, y: 0 } } }), false);
  // Tight: the frame's top edge 3 m above where the rise draws the root, for
  // strong and middling sinks toward signed bases. The box has
  // about 5 m of slack here (the root lift's 1 m, the pad and the crown's
  // reach), so this pins the entry to within that; 'the entry's bounds hold
  // the tight ones' pins the rise it reads exactly.
  for (const [sink, baseM] of [[.9, 0], [.5, 800], [.5, -300], [1, 900]]) {
    const gap = y => y + 500 * tan - (1000 + landRiseLift(0, 1000, -500, [0, y, 0], sink, baseM));
    let lo = 0, hi = 1000;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (gap(m) < 3) lo = m; else hi = m; }
    const y = (lo + hi) / 2, risen = { uLandRise: { value: { x: sink, y: baseM } } };
    assert.ok(Math.abs(gap(y) - 3) < 1e-6 && y < 1000);
    assert.equal(visible(view(y + 500 * tan, false), risen), true, `sink ${sink}, base ${baseM}: 3 m of trunk in view`);
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
    const L = u.uLandRise?.value;
    if (!L) { assert.equal(b.lift.rise, null); continue; }
    assert.deepEqual({ ...b.lift.rise }, { sink: L.x, baseM: L.y }, `seed ${seed}`);
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

test('every vertex the shader can place lies inside its tree\'s own one-tree box (no safety factor, no padding), and that box inside its cell\'s', () => {
  // A span drops a tree by its own box (ForestCulling forestSpan), so the
  // bound must hold tree by tree, not only over a cell: the extremes above
  // (deformation, wind and gust lean, parting, the rise), each tree on its
  // own, a few with negative heights and widths.
  let checked = 0, tighter = 0;
  for (let seed = 1; seed <= 36; seed++) {
    const r = rng(seed * 5 + 1), e = edgy(r), u = uniforms(r);
    const asset = ASSETS[(seed * 7) % ASSETS.length];
    const list = trees(r, 6, seed % 3 ? 2000 : 150).map((t, i) => i % 5 === 4 ? { ...t, h: -t.h, w: -t.w } : t);
    if (seed % 2 === 0) u.uParting.value = { x: list[0].x + (r() * 2 - 1) * 30, y: list[0].z + (r() * 2 - 1) * 30, z: 60 + r() * 60, w: .5 + r() };
    if (seed % 3 !== 1) rise(u, list, r);
    const cells = forestCells(batch(asset.geo, list)), ext = assetExtents(asset.geo);
    const d = deformBound(u), lift = { lo: -d, hi: d, rise: riseFromUniforms(u) }, lean = forestLean(u);
    const prod = forestBounds(u), own = new Float64Array(6), cell = new Float64Array(6), ownProd = new Float64Array(6);
    for (const tree of list) {
      const one = forestCells(batch(asset.geo, [tree]));
      assert.deepEqual([...one], [...oneTree(tree)], 'a one-tree cell is the tree\'s own values');
      forestCellBox(one, 0, ext, lift, lean, 0, own);
      for (let k = 0; k < asset.geo.attributes.position.count; k++) {
        const [x, y, z] = meshVertex(asset.geo, k, tree, u, e, r);
        // A float32 position against float64 math: allow 1 mm.
        const ok = x >= own[0] - 1e-3 && y >= own[1] - 1e-3 && z >= own[2] - 1e-3 && x <= own[3] + 1e-3 && y <= own[4] + 1e-3 && z <= own[5] + 1e-3;
        if (!ok) assert.fail(`seed ${seed} asset ${asset.family}/${asset.variant}/${asset.lod} vertex ${k}: ${[x, y, z].map(v => v.toFixed(3))} outside ${[...own].map(v => v.toFixed(3))}`);
        checked++;
      }
      // With production safety and padding, the tree's box lies inside its
      // cell's: a tree that can reach a volume is in a cell that can (so the
      // cells in view, and their span, hold every tree in view).
      forestCellBox(one, 0, ext, prod.lift, prod.lean, CHUNK_BOX_PAD_M, ownProd);
      forestCellBox(cells, cellOf(cells, tree), ext, prod.lift, prod.lean, CHUNK_BOX_PAD_M, cell);
      for (let j = 0; j < 3; j++) assert.ok(ownProd[j] >= cell[j] && ownProd[j + 3] <= cell[j + 3], `seed ${seed}: axis ${j} of a tree's box leaves its cell's`);
      if ([0, 1, 2].some(j => ownProd[j] > cell[j] + 1 || ownProd[j + 3] < cell[j + 3] - 1)) tighter++;
    }
  }
  assert.ok(checked > 200000, `checked ${checked}`);
  // The case needs cells of several trees, where a tree's own box is tighter.
  assert.ok(tighter > 50, `tighter than their cells: ${tighter}`);
});

test('the affine rise bounds every tree for signed bases, independently of horizontal distance', () => {
  const asset = ASSETS[4].geo;
  const list = [{ x: 128, y: 900, z: 20, h: 8, w: 3, species: 1, id: .3 },
    { x: 2, y: 960, z: 20, h: 8, w: 3, species: 1, id: .5 },
    { x: 254, y: 960, z: 20, h: 8, w: 3, species: 1, id: .7 }];
  const geo = batch(asset, list), cells = forestCells(geo), ext = assetExtents(geo);
  assert.equal(cells.length, 8, 'one cell');
  for (const sink of [.01, .5, .9, 1]) for (const baseM of [-1000, 0, 950, 2000]) {
    const u = { ...still(), uLandRise: { value: { x: sink, y: baseM } } };
    const r = rng(11), e = edgy(r), rise = riseFromUniforms(u);
    const box = forestCellBox(cells, 0, ext, { lo: 0, hi: 0, rise }, forestLean(u), 0);
    assert.equal(box[1], risenHeight(cells[1], 0, rise));
    assert.equal(box[4], risenHeight(cells[4], 0, rise));
    assert.equal(risenHeight(cells[1], 0, rise), risenHeight(cells[1], 100000, rise));
    for (const tree of list) for (let k = 0; k < asset.attributes.position.count; k++) {
      const [x, y, z] = meshVertex(asset, k, tree, u, e, r);
      assert.ok(x >= box[0] - 1e-3 && y >= box[1] - 1e-3 && z >= box[2] - 1e-3
        && x <= box[3] + 1e-3 && y <= box[4] + 1e-3 && z <= box[5] + 1e-3,
      `sink ${sink}, base ${baseM}: vertex ${k} outside its transformed box`);
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

test('every tree a twin\'s span drops has every vertex the shader can place outside one clip plane, mirrors, scissors and the scan cap included', () => {
  // The span's whole claim, checked without its boxes: a dropped tree makes
  // no fragment because all of its vertices lie past one plane of what the
  // render draws (the clip volume, narrowed to the scissor's own rectangle
  // when on), so no triangle of it reaches a pixel. Twins of a few to some
  // fifty trees spread round the view, some with trees past their prefix.
  let dropped = 0, partial = 0, nulls = 0, whole = 0, scissoredPartial = 0, mirroredPartial = 0, risenDropped = 0, capped = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed * 11 + 5), e = edgy(r), u = uniforms(r);
    const asset = ASSETS[(seed * 5) % ASSETS.length];
    const camera = new THREE.PerspectiveCamera(20 + r() * 70, .5 + r() * 2, 1 + r() * 10, 6000 + r() * 30000);
    camera.position.set((r() * 2 - 1) * 1500, 1500 + r() * 2500, (r() * 2 - 1) * 1500);
    const look = [(r() * 2 - 1) * 2000, 500 + r() * 2000, (r() * 2 - 1) * 2000];
    camera.lookAt(...look);
    camera.updateMatrixWorld();
    const mirrored = seed % 4 === 0;
    if (mirrored) {
      // A mirror: the view reflected across a lake plane (det -1).
      const level = 1000 + r() * 500;
      const reflect = new THREE.Matrix4().makeTranslation(0, level, 0).multiply(new THREE.Matrix4().makeScale(1, -1, 1)).multiply(new THREE.Matrix4().makeTranslation(0, -level, 0));
      camera.matrixWorldInverse.multiply(reflect);
    }
    // A scissored target on a third of the views: a partition or a probe
    // drawing part of the frame.
    let target = null;
    if (seed % 3 === 0) {
      const w = 704, h = 424, x = Math.floor(r() * w * .7), y = Math.floor(r() * h * .7);
      target = { scissorTest: true, scissor: new THREE.Vector4(x, y, Math.max(1, Math.floor(r() * (w - x))), Math.max(1, Math.floor(r() * (h - y)))),
        viewport: new THREE.Vector4(0, 0, w, h) };
    }
    const planes = frustumPlanes(camera, target);
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    // The drawn rectangle in NDC: the scissor's own pixels, no margin.
    const s = target?.scissor, v = target?.viewport;
    const [x0, x1, y0, y1] = s ? [(s.x - v.x) / v.z * 2 - 1, (s.x + s.z - v.x) / v.z * 2 - 1, (s.y - v.y) / v.w * 2 - 1, (s.y + s.w - v.y) / v.w * 2 - 1] : [-1, 1, -1, 1];
    const risen = seed % 3 === 1;
    const ur = risen ? { ...u, uTourEye: { value: { x: camera.position.x, y: camera.position.y, z: camera.position.z, w: 1 } },
      uLandRise: { value: { x: .05 + r() * .9, y: r() < .5 ? 0 : r() * .2 } } } : u;
    // Whether every vertex of `tree` lies outside one plane, the same plane
    // for all of them.
    const offscreen = tree => {
      let out = 0b111111;
      for (let k = 0; k < asset.geo.attributes.position.count && out; k++) {
        const [x, y, z] = meshVertex(asset.geo, k, tree, ur, e, r);
        const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12], cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
        const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14], cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
        if (!(cx < x0 * cw)) out &= ~1; if (!(cx > x1 * cw)) out &= ~2;
        if (!(cy < y0 * cw)) out &= ~4; if (!(cy > y1 * cw)) out &= ~8;
        if (!(cz < -cw)) out &= ~16; if (!(cz > cw)) out &= ~32;
      }
      return out !== 0;
    };
    for (let b = 0; b < 3; b++) {
      // A few trees anywhere (often none in view), more anywhere, and a
      // cluster round where the camera looks (cells of several trees).
      const n = b === 0 ? 1 + Math.floor(r() * 6) : 12 + Math.floor(r() * 36), extra = r() < .5 ? Math.floor(r() * 8) : 0;
      const list = b < 2 ? trees(r, n + extra, 4000)
        : trees(r, n + extra, 400).map(t => ({ ...t, x: Math.fround(t.x + look[0]), z: Math.fround(t.z + look[2]) }));
      const geo = twin(asset.geo, list, { uniforms: ur });
      geo.instanceCount = n;
      const verdict = new Map(), seen = i => { if (!verdict.has(i)) verdict.set(i, !offscreen(list[i])); return verdict.get(i); };
      const span = forestSpan(geo, planes, ur);
      if (!span) nulls++;
      else if (span[0] === 0 && span[1] === n - 1) whole++;
      else { partial++; if (target) scissoredPartial++; if (mirrored) mirroredPartial++; }
      // The cap's fallback drops trees by cells, never one the full scan keeps.
      for (const [label, sp] of [['full', span], ['scan 3', forestSpan(geo, planes, ur, { scan: 3, memo: false })], ['scan 0', forestSpan(geo, planes, ur, { scan: 0, memo: false })]]) {
        if (sp) assert.ok(sp[0] >= 0 && sp[0] <= sp[1] && sp[1] <= n - 1, `seed ${seed} twin ${b} ${label}: [${sp}] inside the prefix of ${n}`);
        if (sp && label !== 'full' && span && (sp[0] > span[0] || sp[1] < span[1])) assert.fail(`seed ${seed} twin ${b}: ${label} [${sp}] within the full scan's [${span}]`);
        if (label !== 'full' && sp && span && (sp[0] < span[0] || sp[1] > span[1])) capped++;
        for (let i = 0; i < n; i++) {
          if (sp && i >= sp[0] && i <= sp[1]) continue;
          if (seen(i)) assert.fail(`seed ${seed} twin ${b} (${label}, span ${sp && `[${sp}]`}): tree ${i} dropped with a vertex in view`);
          if (label === 'full') { dropped++; if (risen) risenDropped++; }
        }
      }
    }
  }
  assert.ok(dropped > 1000 && partial > 30 && nulls > 5 && whole > 5 && scissoredPartial > 5 && mirroredPartial > 5 && risenDropped > 200 && capped > 10,
    JSON.stringify({ dropped, partial, nulls, whole, scissoredPartial, mirroredPartial, risenDropped, capped }));
});

test('a twin\'s span runs from the first to the last tree whose own box is in view; its memo always equals a fresh one, and the scan cap only widens it', () => {
  // A tour-like run: four detail/lite pairs sharing their trees, a camera
  // roaming low over hills, and between renders refills (new counts, and
  // the same count with other trees), lite asset swaps, and changes to one
  // number at a time (the camera, lean, root lift, ice, and the rise's
  // sink and base) or to the rise itself. The span must be
  // exact against every tree's own box (the design's definition), and the
  // memo must never stand in for a span the numbers have moved.
  const r = rng(77);
  const u = { ...uniforms(r), uLandRise: { value: { x: 0, y: 0 } }, uTourEye: { value: { x: 0, y: 0, z: 0, w: 0 } }, uGlacierMaxThickness: { value: 0 } };
  // Each scan tests at most twice a twin's trees: the full one never runs
  // out here, so it must be exact.
  const CAPACITY = 240;
  assert.ok(2 * CAPACITY <= SPAN_SCAN_MAX);
  const hills = n => Array.from({ length: n }, () => {
    const x = (r() * 2 - 1) * 1500, z = (r() * 2 - 1) * 1500;
    return { x: Math.fround(x), y: Math.fround(1000 + 250 * Math.sin(x / 400) * Math.cos(z / 300) + r() * 40), z: Math.fround(z),
      h: Math.fround(3 + r() * 42), w: Math.fround(.05 + r() * 10), species: Math.floor(r() * 4), id: Math.fround(r() * .999) };
  });
  const asset = (family, variant, lod) => ASSETS[(family * FOREST_VARIANTS + variant) * 3 + lod].geo;
  // Besides the quality and pixel lites, an asset ten times as wide: a
  // swap whose extents move the boxes by tens of metres.
  const wide = base => {
    const g = base.clone(), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * 10, p.getY(i), p.getZ(i) * 10);
    return g;
  };
  const pairs = Array.from({ length: 4 }, (_, p) => {
    const family = p % FOREST_FAMILIES, variant = (p * 2) % FOREST_VARIANTS;
    const detail = twin(asset(family, variant, 0), hills(Math.floor(r() * CAPACITY)), { capacity: CAPACITY, uniforms: u });
    const lites = [asset(family, variant, 1), asset(family, variant, 2), wide(asset(family, variant, 1))];
    return { detail, lite: liteOf(detail, lites[0]), lites };
  });
  const geos = pairs.flatMap(p => [p.detail, p.lite]);
  const fillPair = (p, list) => { refill(p.detail, list); p.lite.instanceCount = p.detail.instanceCount; };
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 20000), planes = new Float64Array(24), box = new Float64Array(6);
  const move = () => {
    camera.fov = 30 + r() * 50; camera.aspect = .8 + r() * 1.5; camera.updateProjectionMatrix();
    // Often below the hilltops, so the rise lowers trees through the frame.
    camera.position.set((r() * 2 - 1) * 1500, 650 + r() * 600, (r() * 2 - 1) * 1500);
    const yaw = r() * Math.PI * 2, pitch = -.15 + r() * .4;
    camera.lookAt(camera.position.x + Math.sin(yaw), camera.position.y + Math.tan(pitch), camera.position.z + Math.cos(yaw));
    camera.updateMatrixWorld();
    // One scratch array, as production renders reuse theirs.
    frustumPlanes(camera, null, planes);
  };
  move();
  // The span by definition: each tree of the prefix by its own box.
  const exact = g => {
    const n = Math.min(g.attributes.iPos.count, g.instanceCount), bounds = forestBounds(u), ext = assetExtents(g);
    assert.ok(bounds && ext);
    let first = -1, last = -1;
    for (let i = 0; i < n; i++) {
      forestCellBox(oneTree(treeAt(g, i)), 0, ext, bounds.lift, bounds.lean, CHUNK_BOX_PAD_M, box);
      if (boxOutsidePlanes(planes, box[0], box[1], box[2], box[3], box[4], box[5])) continue;
      if (first < 0) first = i;
      last = i;
    }
    return first < 0 ? null : [first, last];
  };
  const counts = { steps: 0, hits: 0, wider: 0, refills: 0, sameCount: 0, partial: 0, nulls: 0 };
  const flips = { camera: 0, asset: 0, lean: 0, lift: 0, ice: 0, sink: 0, base: 0, rise: 0 };
  const previous = new Map();
  for (let step = 0; step < 4000; step++) {
    const k = r(), risen = u.uLandRise.value.x > 0;
    let what = 'none';
    if (k < .03) { what = 'refill'; counts.refills++; for (const p of pairs) fillPair(p, hills(r() < .1 ? 0 : Math.floor(r() * CAPACITY))); }
    else if (k < .08) {
      // The same count, other trees: the prefix shuffled, or new trees.
      what = 'same count'; counts.sameCount++;
      const p = pairs[Math.floor(r() * pairs.length)], n = p.detail.instanceCount;
      const held = Array.from({ length: n }, (_, i) => treeAt(p.detail, i));
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [held[i], held[j]] = [held[j], held[i]]; }
      fillPair(p, r() < .5 ? held : hills(n));
      assert.equal(p.detail.instanceCount, n);
    } else if (k < .14) {
      what = 'asset';
      const p = pairs[Math.floor(r() * pairs.length)], others = p.lites.filter(a => a.attributes.position !== p.lite.attributes.position);
      swapAsset(p.lite, others[Math.floor(r() * others.length)]);
    } else if (k < .22) {
      what = 'lean';
      if (r() < .6) u.uWind.value = { x: r() * 3, y: r() * .06 };
      else u.uParting.value = { ...u.uParting.value, w: r() * 1.5 };
    } else if (k < .27) { what = 'lift'; u.uDeformAmp.value = (r() * 2 - 1) * 30; u.uDeformKick.value = (r() * 2 - 1) * 20; }
    else if (k < .31) {
      // Ice raises the top alone.
      what = 'ice'; u.uGlacierEnabled.value = r() < .2 ? 0 : 1; u.uGlacierMaxThickness.value = r() * 150;
    } else if (k < .39 && risen) {
      // The sink alone, with the base kept.
      what = 'sink';
      u.uLandRise.value = { ...u.uLandRise.value, x: r() < .3 ? .005 + r() * .05 : .05 + r() * .95 };
    } else if (k < .45 && risen) { what = 'base'; u.uLandRise.value = { ...u.uLandRise.value, y: (r() * 2 - 1) * 2000 }; }
    else if (k < .57 && risen) {
      // Changing the fade eye does not affect rise bounds or their memo.
      const axis = 'xyz'[Math.floor(r() * 3)];
      what = 'none'; u.uTourEye.value = { ...u.uTourEye.value, [axis]: u.uTourEye.value[axis] + (r() * 2 - 1) * (axis === 'y' ? 150 : 1500) };
    } else if (k < .62) {
      what = 'rise';
      if (r() < .2) u.uLandRise.value = { x: 0, y: 0 };
      else { u.uLandRise.value = { x: .05 + r() * .95, y: (r() * 2 - 1) * 2000 }; u.uTourEye.value = { x: camera.position.x, y: camera.position.y, z: camera.position.z, w: 1 }; }
    } else if (k < .87) { what = 'camera'; move(); }
    for (const g of geos) {
      const a = forestSpan(g, planes, u), b = forestSpan(g, planes, u, { memo: false });
      assert.deepEqual(a, b, `step ${step} (${what}): the memo equals a fresh span`);
      assert.deepEqual(b, exact(g), `step ${step} (${what}): first to last tree in view`);
      const last = previous.get(g);
      if (what === 'none' && last) { assert.equal(a, last.a, `step ${step}: nothing moved, the memo answers`); counts.hits++; }
      if (last && JSON.stringify(b) !== JSON.stringify(last.b) && what in flips) flips[what]++;
      previous.set(g, { a, b });
      counts.steps++;
      if (!b) counts.nulls++; else if (b[0] > 0 || b[1] < g.instanceCount - 1) counts.partial++;
      // The cap settles for the cells' span: never narrower, inside the prefix.
      for (const scan of [3, 0]) {
        const c = forestSpan(g, planes, u, { scan, memo: false });
        if (c) assert.ok(c[0] >= 0 && c[0] <= c[1] && c[1] < g.instanceCount, `step ${step} scan ${scan}: [${c}] inside the prefix`);
        if (b) assert.ok(c && c[0] <= b[0] && c[1] >= b[1], `step ${step} (${what}) scan ${scan}: [${c}] holds [${b}]`);
        if (c && (!b || c[0] < b[0] || c[1] > b[1])) counts.wider++;
      }
    }
  }
  // Every kind of change moved some span, so the memo was tested on each.
  assert.ok(Object.values(flips).every(v => v >= 10) && counts.hits > 200 && counts.wider > 200 && counts.partial > 500 && counts.nulls > 200
    && counts.refills > 10 && counts.sameCount > 20, JSON.stringify({ flips, counts }));
});

test('a twin\'s span memo follows each number the span reads, changed alone, the scissor included', () => {
  // A level camera and three twins of trees just out of its view: above
  // the frame's top edge (the rise lowers them in), past its sides (the
  // lean and a wider asset reach in) and below its bottom (the root lift
  // and ice raise them in), each in order of how far out. Each number is
  // swept on its own: the memo must answer what a fresh span answers at
  // every step, and each sweep must move a span, or a key without that
  // number would go unnoticed. The scene stands off the origin, so every
  // plane has all four of its numbers.
  const r = rng(31), O = [300, 0, -200], camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
  camera.position.set(O[0], 1000, O[2]); camera.lookAt(O[0], 1000, O[2] + 1); camera.updateMatrixWorld();
  // One scratch array for every render, as production keeps.
  const planes = new Float64Array(24), target = { scissorTest: false, scissor: new THREE.Vector4(0, 0, 704, 704), viewport: new THREE.Vector4(0, 0, 704, 704) };
  frustumPlanes(camera, null, planes);
  const a = 20 * Math.PI / 180, t = Math.tan(a), c = Math.cos(a), sn = Math.sin(a);
  const quality = ASSETS[4].geo, ext = assetExtents(quality);
  const groups = [[], [], []];
  for (let i = 0; i < 90; i++) {
    const z = 300 + r() * 1500, gap = 5 + r() * 80, kind = i % 3, side = r() < .5 ? -1 : 1;
    const h = 10 + r() * 20, w = .5 + r() * 2;
    let tree;
    if (kind === 0) tree = { x: (r() * 2 - 1) * z * t * .8, y: 1000 + z * t + gap, z, h, w, out: gap };
    else if (kind === 1) {
      // Past a side plane by up to what a full wind adds to a still box's
      // reach (its corner, along the plane's normal).
      const reach = Math.max(ext.foliage * CROWN_RADIUS_PER_WIDTH * w, ext.trunk * TRUNK_RADIUS_M) + 2 * GUST_LEAN * h + CHUNK_BOX_PAD_M, out = r() * .07;
      tree = { x: side * (z * t + (reach + out * h) * (c + sn) / c), y: 990 - h / 2, z, h, w, out };
    } else tree = { x: (r() * 2 - 1) * z * t * .8, y: 1000 - z * t - h - gap, z, h, w, out: gap };
    groups[kind].push({ ...tree, x: Math.fround(tree.x + O[0]), y: Math.fround(tree.y), z: Math.fround(tree.z + O[2]), h: Math.fround(tree.h), w: Math.fround(tree.w), species: 1, id: .5 });
  }
  const wider = quality.clone(), p = wider.attributes.position;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * 10, p.getY(i), p.getZ(i) * 10);
  const u = { ...still(), uLandRise: { value: { x: 0, y: 0 } }, uTourEye: { value: { x: O[0], y: 1000, z: O[2], w: 1 } }, uGlacierMaxThickness: { value: 0 } };
  const twins = groups.map(g => twin(quality, g.sort((m, n) => m.out - n.out), { uniforms: u }));
  for (const tw of twins) assert.equal(forestSpan(tw, planes, u, { memo: false }), null, 'out of view, still');
  const scissor = v => {
    // The same camera through another partition's rectangle.
    target.scissorTest = v !== null;
    if (v) target.scissor.set(...v);
    frustumPlanes(camera, v ? target : null, planes);
  };
  const sweeps = [
    ['lean (wind)', v => { u.uWind.value = { x: v, y: 0 }; }, [0, .5, 1, 1.5, 2, 2.5, 3, 0]],
    ['lean (parting)', v => { u.uParting.value = { x: 0, y: 0, z: 90, w: v }; }, [0, .02, .05, .08, .12, .17, 0]],
    ['root lift', v => { u.uDeformKick.value = v; }, [0, 5, 10, 20, 40, 80, 0]],
    ['ice (the top alone)', v => { u.uGlacierEnabled.value = 1; u.uGlacierMaxThickness.value = v; }, [0, 5, 10, 20, 40, 80, 0]],
    // The floor alone: the kick sinks it while ice holds the top.
    ['the root lift\'s floor alone', v => { u.uDeformKick.value = v; u.uGlacierEnabled.value = 1; u.uGlacierMaxThickness.value = 80 - v; }, [0, 5, 10, 20, 40, 80, 0]],
    ['asset', v => { for (const tw of twins) swapAsset(tw, v ? wider : quality); }, [0, 1, 0, 1, 0]],
    ['sink', v => { u.uLandRise.value = { ...u.uLandRise.value, x: v }; }, [.02, .05, .1, .2, .3, .5, .7, 1, .02]],
    ['base', v => { u.uLandRise.value = { ...u.uLandRise.value, y: v }; }, [-1000, -500, 0, 500, 1000, 1500, 2000, -1000]],
    // Under a full wind and a kick, so trees stand inside every edge of the
    // frame: each half, then its outer edge moved alone.
    ['scissor', scissor, [null, [0, 0, 352, 704], [100, 0, 252, 704], [0, 0, 352, 704], [352, 0, 352, 704], [352, 0, 252, 704], [352, 0, 352, 704],
      [0, 0, 704, 352], [0, 100, 704, 252], [0, 0, 704, 352], [0, 352, 704, 352], [0, 352, 704, 252], [0, 352, 704, 352], null]],
  ];
  for (const [label, set, values] of sweeps) {
    // The rise's own numbers sweep under a middling rise at a fixed base.
    const risen = ['sink', 'base'].includes(label);
    u.uLandRise.value = risen ? { x: .15, y: 800 } : { x: 0, y: 0 };
    u.uWind.value = { x: label === 'scissor' ? 3 : 0, y: 0 };
    u.uDeformKick.value = label === 'scissor' ? 20 : 0; u.uGlacierMaxThickness.value = 0;
    // Each sweep ends where it starts, so a span that moves moves back.
    const seen = [];
    for (const v of values) {
      set(v);
      seen.push(JSON.stringify(twins.map(tw => {
        const m = forestSpan(tw, planes, u), f = forestSpan(tw, planes, u, { memo: false });
        assert.deepEqual(m, f, `${label} ${v}: the memo equals a fresh span`);
        return f;
      })));
    }
    const moves = seen.filter((v, i) => i > 0 && v !== seen[i - 1]).length;
    assert.ok(moves >= 3, `${label}: the sweep moves a span (${seen.join(' ')})`);
  }
});

test('the rise brings trees down through a frame\'s top edge; a batch it culls has no vertex in view', () => {
  // Views pitched up, a fixed ground base, and
  // trees standing just above the top edge: the rise lowers many of them
  // into the frame. Every batch with a vertex in view must be kept, and
  // enough of those must be out of view without the rise for that to test it.
  let brought = 0, culled = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 13 + 1), e = edgy(r);
    const fov = 20 + r() * 40, aspect = 1 + r(), pitch = (2 + r() * 15) * Math.PI / 180, eyeY = 500 + r() * 1500;
    const camera = new THREE.PerspectiveCamera(fov, aspect, 1, 40000);
    camera.position.set(0, eyeY, 0); camera.lookAt(0, eyeY + Math.tan(pitch), -1); camera.updateMatrixWorld();
    const baseM = eyeY - 200;
    const sink = r() < .3 ? .005 + r() * .05 : .05 + r() * .95;
    const u = { ...still(), uTourEye: { value: { x: 0, y: eyeY, z: 0, w: 1 } }, uLandRise: { value: { x: sink, y: baseM } } };
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
  // A twin of three trees behind the camera, drawing them of its room for
  // five: its span is none, or every tree it draws when the bound is unknown.
  const behindTwin = () => {
    const g = twin(ASSETS[3].geo, [0, 1, 2, 3, 4].map(i => ({ x: i * 40, y: 0, z: 5000 + i * 40, h: 10, w: 4, species: 1, id: .5 })), { uniforms: u });
    g.instanceCount = 3;
    return g;
  };
  assert.equal(forestSpan(behindTwin(), planes, u), null, 'behind the camera: no span');
  for (const broken of [
    { ...u, uWind: { value: { x: NaN, y: 0 } } },
    { ...u, uParting: { value: { x: 0, y: 0, z: 90, w: Infinity } } },
    { ...u, uDeformAmp: { value: undefined } },
    { ...u, uLandDance: { value: { x: NaN, y: 0, z: 0, w: 0 } } },
    { ...u, uLandRise: { value: { x: NaN, y: 0 } } },
    { ...u, uLandRise: { value: { x: .5, y: Infinity } } },
    { ...u, uLandRise: { value: { x: .5, y: -Infinity } } },
    { ...u, uLandRise: { value: { x: .5, y: NaN } } },
    // Above 1, drawn height decreases with source height.
    { ...u, uLandRise: { value: { x: 1.5, y: 0 } } },
    { ...u, uLandRise: { value: { x: 1 + 1e-9, y: 0 } } },
    {},
  ]) {
    assert.equal(forestGeometryVisible(behind(), planes, broken), true, JSON.stringify([broken.uLandRise?.value, broken.uTourEye?.value]));
    assert.deepEqual(forestSpan(behindTwin(), planes, broken), [0, 2], `the whole prefix: ${JSON.stringify([broken.uLandRise?.value, broken.uTourEye?.value])}`);
  }
  // A rise the box bounds, or none (a sink of 0 or less), still culls.
  for (const v of [{ x: .5, y: -300 }, { x: 1, y: 2000 }, { x: 0, y: -5 }, { x: -1, y: NaN }]) {
    const risen = { ...u, uLandRise: { value: v } };
    assert.equal(forestGeometryVisible(behind(), planes, risen), false, JSON.stringify(v));
    assert.equal(forestSpan(behindTwin(), planes, risen), null, JSON.stringify(v));
  }
  assert.equal(forestGeometryVisible(behind(), null, u), true, 'no planes');
  assert.deepEqual(forestSpan(behindTwin(), null, u), [0, 2], 'no planes: the whole prefix');
  const nan = behind(); nan.attributes.iPos.setX(0, NaN);
  assert.equal(forestGeometryVisible(nan, planes, u), true, 'a non-finite root');
  const nanTwin = behindTwin(); nanTwin.attributes.iPos.setX(1, NaN); nanTwin.attributes.iPos.data.needsUpdate = true;
  assert.deepEqual(forestSpan(nanTwin, planes, u), [0, 2], 'a non-finite root: the whole prefix');
  // Past the prefix it is not drawn, so not read.
  const nanPast = behindTwin(); nanPast.attributes.iPos.setX(4, NaN); nanPast.attributes.iPos.data.needsUpdate = true;
  assert.equal(forestSpan(nanPast, planes, u), null, 'a non-finite root past the prefix');
  const flat = behind(); flat.deleteAttribute('aBranch');
  assert.equal(forestGeometryVisible(flat, planes, u), true, 'no branch attribute (a billboard)');
  const flatTwin = behindTwin(); flatTwin.deleteAttribute('aBranch');
  assert.deepEqual(forestSpan(flatTwin, planes, u), [0, 2], 'no branch attribute: the whole prefix');
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

test('the tour layer\'s twins draw spans of the trees they hold (culled whole with tour.spans false), never its demote boards; the static batches as before', () => {
  const rows = (band, n, z) => Array.from({ length: n }, (_, i) => [i * 10, 0, z, 12, 4, i % 4, (i * .137) % 1, band]).flat();
  const placed = { meshDetail: new Float32Array([...rows(2, 6, -100), ...rows(2, 4, 900)]), mesh: new Float32Array([...rows(2, 8, -300), ...rows(1, 3, 2000)]),
    billboard: new Float32Array(rows(1, 5, -4000)), stride: 8, count: 26, railCount: { meshDetail: 6, mesh: 8, billboard: 5 } };
  const plain = createForest(THREE, placed, {}), f = createForest(THREE, placed, {}, { tour: { seed: 3 } });
  // The kill switch: the same twins, culled whole as on main.
  const off = createForest(THREE, placed, {}, { tour: { seed: 3, spans: false } });
  const statics = forest => [...Object.values(forest.byBand).flat(), ...forest.depth, ...Object.values(forest.depthByBand).flat()];
  // A static batch's tag, with its uniforms as "the forest's own".
  const tagOf = forest => m => {
    const t = m.geometry.userData.forestCull;
    return t && { ...t, uniforms: t.uniforms === forest.uniforms };
  };
  for (const forest of [f, off]) {
    assert.deepEqual(statics(forest).map(tagOf(forest)), statics(plain).map(tagOf(plain)), 'the static batches are tagged as without the tour layer');
    for (const m of statics(forest)) if (m.geometry.attributes.aBranch) assert.deepEqual(m.geometry.userData.forestCull, { uniforms: forest.uniforms });
    // Their trees stay plain instanced attributes: nothing reads them from an offset.
    for (const m of statics(forest)) for (const name of ['iPos', 'iSize', 'iVar']) assert.ok(m.geometry.attributes[name].isInstancedBufferAttribute, name);
  }
  for (const [forest, spans] of [[f, true], [off, false]]) {
    assert.ok(forest.tour.every.length > 0 && forest.tour.twins.length > 0 && forest.tour.boards.length > 0);
    for (const m of forest.tour.every) {
      const tagged = m.geometry.userData.forestCull;
      if (m.geometry.attributes.aBranch) assert.deepEqual(tagged, { uniforms: forest.uniforms, prefix: true, spans }, 'a twin is bound over its drawn prefix, span by span unless switched off');
      else assert.equal(tagged, undefined, 'a demote board is never culled');
    }
    for (const t of forest.tour.twins) {
      for (const g of [t.detail, t.lite].filter(Boolean)) assert.deepEqual(g.userData.forestCull, { uniforms: forest.uniforms, prefix: true, spans });
      // Each per-tree attribute is a view at offset 0 of its own instanced
      // buffer, stride = item size: main's bytes, pointer stride and type
      // (a span reads the same buffer from an offset). The lite reads the
      // detail's objects, so both draw the same trees.
      for (const [name, size] of [['iPos', 3], ['iSize', 2], ['iVar', 2], ['iTour', 1]]) {
        const a = t.detail.attributes[name];
        assert.ok(a.isInterleavedBufferAttribute && a.data.isInstancedInterleavedBuffer, name);
        assert.deepEqual([a.itemSize, a.offset, a.data.stride, a.data.meshPerAttribute, a.data.count], [size, 0, size, 1, t.n], name);
        // Read as main's InstancedBufferAttribute was: not normalized, so
        // iTour's bytes reach the shader as 0..3, and of the same type.
        assert.equal(a.normalized, false, `${name} is not normalized`);
        assert.ok(a.data.array instanceof (name === 'iTour' ? Uint8Array : Float32Array), `${name} holds main's type`);
        assert.equal(a.data.usage, THREE.DynamicDrawUsage, `${name} is refilled in place, as on main`);
        if (t.lite) assert.equal(t.lite.attributes[name], a, `the lite shares the detail's ${name}`);
      }
    }
    for (const g of forest.tour.boards) assert.equal(g.userData.forestCull, undefined);
    // No static batch is bound over a prefix: their cells stay those of #81.
    for (const m of statics(forest)) assert.ok(!m.geometry.userData.forestCull?.prefix);
  }
  for (const forest of [plain, f, off]) forest.dispose();
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

test('a same-count refill of an interleaved twin rebuilds its cells and tree lists, and its span follows the refilled trees', () => {
  // A twin's attributes are views of interleaved buffers, which have a
  // version where its attributes do not: a refill that keeps the count must
  // still be seen, or the span would come from the trees it held before.
  const geo = ASSETS[4].geo, u = still(), camera = new THREE.PerspectiveCamera(50, 1, 1, 20000);
  camera.position.set(0, 1010, 0); camera.lookAt(0, 1010, 1); camera.updateMatrixWorld();
  const planes = frustumPlanes(camera, null);
  const at = (x, z, y = 1000) => ({ x, y, z, h: 20, w: 5, species: 1, id: .5 });
  const asCells = c => Array.from({ length: c.length / 8 }, (_, i) => [...c.slice(i * 8, i * 8 + 8)]);
  const both = g => { const a = forestSpan(g, planes, u), b = forestSpan(g, planes, u, { memo: false }); assert.deepEqual(a, b, 'memo'); return a; };
  // Eight trees in two cells: A (ahead of the camera) and B (behind it).
  const A = i => at(10 + i, 800 + i), B = i => at(10 + i, -800 - i);
  const tw = twin(geo, [A(0), A(1), A(2), A(3), B(0), B(1), B(2), B(3)], { uniforms: u });
  assert.ok(tw.attributes.iPos.isInterleavedBufferAttribute && tw.attributes.iPos.version === undefined, 'an interleaved view has no version of its own');
  const before = forestCells(tw);
  assert.equal(before.length, 2 * 8);
  assert.deepEqual(both(tw), [0, 3]);
  // The same trees, B's first: the same cells, held by other trees.
  refill(tw, [B(0), B(1), B(2), B(3), A(0), A(1), A(2), A(3)]);
  assert.notEqual(forestCells(tw), before, 'rebuilt');
  assert.deepEqual(asCells(forestCells(tw)).sort((a, b) => a[2] - b[2]), asCells(before).sort((a, b) => a[2] - b[2]), 'the same cells');
  assert.deepEqual(both(tw), [4, 7], 'the trees ahead are the last four now');
  // Interleaved, with A's cell first in both: identical cells in the same
  // order, only the tree lists change. A stale list would draw [0, 3] and
  // drop trees 4 and 6, both ahead.
  refill(tw, [A(0), A(1), A(2), A(3), B(0), B(1), B(2), B(3)]);
  const cellsA = forestCells(tw);
  refill(tw, [A(0), B(0), A(1), B(1), A(2), B(2), A(3), B(3)]);
  assert.deepEqual([...forestCells(tw)], [...cellsA], 'the same cells, in the same order');
  assert.deepEqual(both(tw), [0, 6]);
  // Every tree behind, then one refilled ahead: none, then that one.
  refill(tw, [B(0), B(1), B(2), B(3), B(4), B(5), B(6), B(7)]);
  assert.equal(both(tw), null, 'every tree behind the camera');
  refill(tw, [B(0), B(1), B(2), B(3), B(4), at(40, 900), B(6), B(7)]);
  assert.deepEqual(both(tw), [5, 5], 'the refilled tree ahead');
  // Each buffer's version is read: the heights alone (trees ahead, 100 m
  // below the frame's bottom edge, one grown into it)...
  const size = tw.attributes.iSize, low = i => at(10 + i, 800 + i, 1010 - 800 * Math.tan(25 * Math.PI / 180) - 120);
  refill(tw, Array.from({ length: 8 }, (_, i) => low(i)));
  assert.equal(both(tw), null, 'below the frame');
  const top = forestCells(tw)[4];
  size.setX(2, 300); size.data.needsUpdate = true;
  assert.equal(forestCells(tw)[4] - top, 300 - 20, 'the height refill is seen');
  assert.deepEqual(both(tw), [2, 2], 'the tree grown into the frame');
  // ...and the ids alone: a bad id in the prefix is an unknown bound.
  const vars = tw.attributes.iVar;
  vars.setY(3, 7); vars.data.needsUpdate = true;
  assert.equal(forestCells(tw), null, 'the cells are rebuilt when only the ids change');
  assert.deepEqual(both(tw), [0, 7], 'unknown: the whole prefix');
  vars.setY(3, .5); vars.data.needsUpdate = true;
  assert.deepEqual(both(tw), [2, 2]);
  // Cells first built without tree lists (spans off) are rebuilt with them
  // once spans are on: a span of the trees ahead, not the whole prefix.
  const later = twin(geo, [B(0), A(0), B(1), A(1), B(2)], { uniforms: u, spans: false });
  assert.equal(forestCells(later).length, 2 * 8);
  later.userData.forestCull.spans = true;
  assert.deepEqual(both(later), [1, 3]);
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

test('a culled render draws a twin\'s span from an aligned first tree inside its buffers, or its whole prefix with no offset when the span does not fit', () => {
  const u = still(), camera = new THREE.PerspectiveCamera(50, 1, 1, 20000);
  camera.position.set(0, 1010, 0); camera.lookAt(0, 1010, 1); camera.updateMatrixWorld();
  const at = (x, z) => ({ x, y: 1000, z, h: 20, w: 5, species: 1, id: .5 });
  // Trees behind the camera, then ahead (5 to 9), then behind again.
  const list = Array.from({ length: 12 }, (_, i) => i >= 5 && i <= 9 ? at(10 * i - 70, 800 + 10 * i) : at(10 * i, -800 - 10 * i));
  const tw = twin(ASSETS[4].geo, list, { uniforms: u });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(tw));
  const NAMES = ['iPos', 'iSize', 'iVar', 'iTour'], base = Object.fromEntries(NAMES.map(k => [k, tw.attributes[k]]));
  const offsets = g => NAMES.map(k => g.attributes[k].offset / g.attributes[k].data.stride);
  const originals = g => NAMES.every(k => g.attributes[k] === base[k]);
  assert.deepEqual(forestSpan(tw, frustumPlanes(camera, null), u), [5, 9]);
  // The span from tree 4 (5 rounded down to a multiple of SPAN_ALIGN): new
  // views of the same buffers, every per-tree attribute from the same tree.
  assert.equal(SPAN_ALIGN, 4);
  const stats = { kept: 0, total: 0, batches: 0 };
  let touched = cullForestScene(scene, camera, null, stats);
  assert.equal(tw.instanceCount, 6);
  assert.deepEqual(offsets(tw), [4, 4, 4, 4]);
  for (const k of NAMES) assert.ok(tw.attributes[k] !== base[k] && tw.attributes[k].data === base[k].data && tw.attributes[k].itemSize === base[k].itemSize, k);
  assert.equal(tw.attributes.position, ASSETS[4].geo.attributes.position, 'the asset\'s own attributes are not touched');
  assert.deepEqual(stats, { kept: 6, total: 12, batches: 0 });
  const set = NAMES.map(k => tw.attributes[k]);
  restoreForestScene(touched);
  assert.ok(originals(tw) && tw.instanceCount === 12, 'restored');
  // Facing aside, every tree out of view: culled to 0 with the set it last
  // drew with, so its vertex arrays stay as they are.
  camera.lookAt(1, 1010, 0); camera.updateMatrixWorld();
  assert.equal(forestSpan(tw, frustumPlanes(camera, null), u), null);
  touched = cullForestScene(scene, camera, null);
  assert.equal(tw.instanceCount, 0);
  assert.deepEqual(NAMES.map(k => tw.attributes[k]), set, 'the same set objects');
  restoreForestScene(touched);
  assert.ok(originals(tw) && tw.instanceCount === 12);
  // A count past the trees (three's Infinity): the span still ends inside
  // the buffers, here at their very last tree.
  camera.lookAt(0, 1010, 1); camera.updateMatrixWorld();
  refill(tw, list.map((t, i) => i >= 9 ? at(10 * i - 100, 800 + 10 * i) : at(10 * i, -800 - 10 * i)));
  for (const count of [Infinity, 1e9]) {
    tw.instanceCount = count;
    assert.deepEqual(forestSpan(tw, frustumPlanes(camera, null), u), [9, 11]);
    touched = cullForestScene(scene, camera, null);
    assert.deepEqual([tw.instanceCount, ...offsets(tw)], [4, 8, 8, 8, 8], `count ${count}`);
    assert.ok(8 + tw.instanceCount <= tw.attributes.iPos.data.count);
    restoreForestScene(touched);
    assert.ok(originals(tw) && tw.instanceCount === count);
  }
  // A span that does not fit the prefix the render draws: here a count that
  // reads `drawn` for the render and more for the span after it (forestSpan
  // then spans all 12 trees: [5, 9]). three does not clamp a draw by
  // offset, so unless the span ends inside the render's prefix the whole
  // prefix draws, from tree 0, untouched; 10 is the first count it fits.
  refill(tw, list);
  for (const drawn of [10, 9, 7, 4, 1]) {
    let value = drawn, reads = 0;
    Object.defineProperty(tw, 'instanceCount', { configurable: true, get: () => reads++ === 0 ? value : 1e9, set: v => { value = v; } });
    touched = cullForestScene(scene, camera, null);
    assert.ok(reads > 1, 'the span read the count again');
    if (drawn === 10) assert.deepEqual([value, ...offsets(tw)], [6, 4, 4, 4, 4], 'the span fits: drawn from tree 4');
    else {
      assert.equal(touched.length, 0, `count ${drawn}: nothing changed`);
      assert.ok(originals(tw) && value === drawn, `count ${drawn}: the whole prefix, no offset`);
    }
    restoreForestScene(touched);
    assert.ok(originals(tw) && value === drawn);
    delete tw.instanceCount;
  }
  // The same without a trick: a geometry tagged for spans but not as a
  // prefix is bound over every tree it holds, so its span can pass the
  // count it draws.
  const loose = twin(ASSETS[4].geo, list, { uniforms: u });
  loose.userData.forestCull = { uniforms: u, spans: true };
  loose.instanceCount = 4;
  assert.deepEqual(forestSpan(loose, frustumPlanes(camera, null), u), [5, 9], 'a span past the 4 trees drawn');
  const looseScene = new THREE.Scene();
  looseScene.add(new THREE.Mesh(loose));
  touched = cullForestScene(looseScene, camera, null);
  assert.deepEqual([touched.length, loose.instanceCount, loose.attributes.iPos.offset], [0, 4, 0], 'the whole prefix, no offset');
  tw.instanceCount = 12;
  // A twin not built for spans is culled whole, as on main: the kill
  // switch, plain instanced attributes, a buffer of another length, or a
  // one-value attribute that does not reach every tree.
  const weight = meshPerAttribute => new THREE.InstancedBufferAttribute(new Float32Array([1]), 1, false, meshPerAttribute);
  const cases = [
    ['spans off', () => twin(ASSETS[4].geo, list, { uniforms: u, spans: false }), false],
    ['not interleaved', () => { const g = batch(ASSETS[4].geo, list); g.userData.forestCull = { uniforms: u, prefix: true, spans: true }; return g; }, false],
    ['a short buffer', () => { const g = twin(ASSETS[4].geo, list, { uniforms: u }); g.setAttribute('iTour', spanned(new Uint8Array(11), 1)); return g; }, false],
    ['a weight for one tree', () => { const g = twin(ASSETS[4].geo, list, { uniforms: u }); g.setAttribute('iLodWeight', weight(1)); return g; }, false],
    ['a weight for every tree', () => { const g = twin(ASSETS[4].geo, list, { uniforms: u }); g.setAttribute('iLodWeight', weight(12)); return g; }, true],
  ];
  for (const [label, make, spans] of cases) {
    const g = make(), other = new THREE.Scene(), before = { ...g.attributes };
    other.add(new THREE.Mesh(g));
    touched = cullForestScene(other, camera, null);
    if (spans) assert.deepEqual([g.instanceCount, g.attributes.iPos.offset], [6, 12], label);
    else {
      assert.deepEqual([touched.length, g.instanceCount], [0, 12], `${label}: a tree in view keeps it all`);
      for (const [k, v] of Object.entries(before)) assert.equal(g.attributes[k], v, `${label}: ${k}`);
    }
    restoreForestScene(touched);
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
