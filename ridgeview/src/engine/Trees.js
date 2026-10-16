// Instanced 3D trees near the camera. Candidate trunks sit on a world-locked
// jittered grid (one per ~8 m mercator cell), so refining a tile into its
// children keeps every tree where it was. Each drawn tile close enough gets
// one instanced mesh for the cells it covers; the vertex shader runs the
// same land-cover function as the ground shader to decide which candidates
// are trees, so trunks stand exactly where the ground is painted forest.
import * as THREE from 'three';
import { NOISE, ATMOS, LOGDEPTH_VS } from './glsl.js';
import { LANDCOVER } from './landcover.glsl.js';
import { tileHeightAt } from './TileBuilder.js';
import { EARTH_RADIUS, DEG, mxToLon, myToLat } from '../core/geo.js';

const CIRC = 2 * Math.PI * EARTH_RADIUS;
const CELL = 8; // mercator metres between candidate trees
const MIN_Z = 16;

const VS = /* glsl */ `
precision highp float;
${NOISE}
${LANDCOVER}
attribute vec3 aOffset;
attribute vec2 aUv;
attribute float aH;
attribute float aSeed;
uniform sampler2D uTex;
uniform float uTexSize, uS, uTileSizeM, uTreeFar, uBroadleaf, uTreeScale, uClearR;
uniform vec2 uTileOrigin;
uniform vec3 uTileCenter;
uniform mat4 uShadowM0, uShadowM1, uMirror;
varying vec3 vRel;
varying vec3 vN;
varying float vH;
varying float vFade;
varying float vSnow;
varying float vShade;
varying vec3 vTint;
varying vec4 vS0;
varying vec4 vS1;
${LOGDEPTH_VS}
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  vec4 tx = texture(uTex, (vec2(1.5) + aUv * uS) / uTexSize);
  vec2 gp = uTileOrigin + aUv * uTileSizeM;
  gp.y = -gp.y;
  vec3 up = normalize(uTileCenter + aOffset);
  Cover c = landCover(tx, gp, aH, up);
  float r = h1(aSeed);
  vec4 base = modelMatrix * vec4(aOffset, 1.0);
  float dist = length(base.xyz);
  vFade = smoothstep(uTreeFar, uTreeFar * 0.7, dist);
  // A clearing around a low viewpoint: the calculated view has no trees in it.
  if (c.forest * (1.0 - c.water) < r * 0.9 + 0.08 || vFade <= 0.0 || dist < uClearR) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0); // not a tree: clipped away
    return;
  }
  vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), up));
  vec3 north = cross(up, east);
  float yaw = h1(aSeed + 3.1) * 6.2831;
  vec3 ax = east * cos(yaw) + north * sin(yaw), ay = -east * sin(yaw) + north * cos(yaw);
  // Smaller, wind-stunted trees toward the treeline.
  float tall = mix(14.0, 30.0, h1(aSeed + 7.7)) * (1.0 - 0.65 * c.alpine) * uTreeScale;
  float wide = tall * mix(0.26, 0.36, h1(aSeed + 9.1)) * mix(1.0, 1.9, uBroadleaf);
  vec3 p = position;
  vec3 local = ax * p.x * wide + ay * p.z * wide + up * p.y * tall;
  vec4 wp = base + vec4(local, 0.0);
  vN = normalize(ax * normal.x + ay * normal.z + up * normal.y * (wide / tall));
  vRel = wp.xyz;
  vH = aH + p.y * tall;
  vSnow = c.snow;
  vShade = p.y; // trunk dark, crown tips lighter
  vTint = vec3(0.85 + 0.3 * h1(aSeed + 1.3), 0.85 + 0.3 * h1(aSeed + 2.9), 0.9 + 0.2 * h1(aSeed + 4.4));
  vS0 = uShadowM0 * wp;
  vS1 = uShadowM1 * wp;
  gl_Position = projectionMatrix * viewMatrix * (uMirror * wp);
  applyLogDepth();
}
`;

const FS = /* glsl */ `
precision highp float;
${NOISE}
${ATMOS}
uniform vec3 uForestCol, uSnowCol, uAutumnCol, uSkyHorizon;
uniform float uAutumn, uBroadleaf, uStormDark, uClipOn, uReflH;
uniform sampler2D uShadow0, uShadow1;
uniform float uShadowOn;
uniform vec2 uShadowTexel, uShadowBias;
varying vec3 vRel;
varying vec3 vN;
varying float vH;
varying float vFade;
varying float vSnow;
varying float vShade;
varying vec3 vTint;
varying vec4 vS0;
varying vec4 vS1;
float shadowAt(sampler2D m, vec4 sc, float bias) {
  vec3 c = sc.xyz / sc.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return -1.0;
  float s = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++)
    s += step(c.z - bias, texture(m, c.xy + vec2(i, j) * uShadowTexel).r);
  return s / 9.0;
}
void main() {
  if (uClipOn > 0.5 && vH < uReflH + 0.6) discard;
  // Screen-door fade with distance (no sorting needed).
  float dither = hash12(gl_FragCoord.xy);
  if (vFade < dither) discard;
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 up = normalize(uCamKm + vRel * 0.001);
  float dist = length(vRel);
  vec3 V = -vRel / max(dist, 1e-3);
  float trunk = 1.0 - smoothstep(0.08, 0.14, vShade);
  vec3 crown = uForestCol * vTint * (0.75 + 0.5 * vShade);
  crown = mix(crown, uAutumnCol * vTint, uAutumn * uBroadleaf * 0.8);
  vec3 alb = mix(crown, vec3(0.09, 0.06, 0.04), trunk);
  // Snow lies on the upward-facing boughs.
  float snowy = vSnow * smoothstep(0.1, 0.6, dot(n, up)) * (1.0 - trunk);
  alb = mix(alb, uSnowCol * 0.9, snowy);
  float sh = 1.0;
  if (uShadowOn > 0.5) {
    float s = shadowAt(uShadow0, vS0, uShadowBias.x * 3.0);
    if (s < 0.0) s = shadowAt(uShadow1, vS1, uShadowBias.y * 3.0);
    sh = s < 0.0 ? 1.0 : s;
  }
  vec3 sunT = lightTransmittance(max(vH, 0.0) / 1000.0, dot(up, uSunDir));
  vec3 moonT = lightTransmittance(max(vH, 0.0) / 1000.0, dot(up, uMoonDir));
  float ndl = dot(n, uSunDir);
  float wrap = clamp((ndl + 0.4) / 1.4, 0.0, 1.0);
  // Light through the needles when the sun is behind the tree.
  float trans = pow(max(dot(-V, uSunDir), 0.0), 6.0) * 0.35 * (1.0 - trunk);
  vec3 col = alb / PI * (uSunPower * sunT * sh * (wrap * 0.85 + trans) + uMoonPower * moonT * max(dot(n, uMoonDir), 0.0)
           + uSkyIrr * (0.5 + 0.5 * dot(n, up)) * (0.55 + 0.45 * vShade));
  vec3 T, L;
  aerial(uCamKm, uCamKm + vRel * 0.001, -V, T, L);
  col = col * T + L;
  col = mix(col, uSkyHorizon * 0.9, uStormDark * (1.0 - exp(-dist / 9000.0)));
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Unit tree: y up from 0 to 1, radius ~1 at the widest. */
function treeGeometry(kind) {
  const pos = [], nrm = [], idx = [];
  const ring = (y, r, ny, sides) => {
    const start = pos.length / 3;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2, x = Math.cos(a), z = Math.sin(a);
      pos.push(x * r, y, z * r);
      const l = Math.hypot(x, ny, z);
      nrm.push(x / l, ny / l, z / l);
    }
    return start;
  };
  const tip = (y) => { pos.push(0, y, 0); nrm.push(0, 1, 0); return pos.length / 3 - 1; };
  const fan = (r0, t, sides) => { for (let i = 0; i < sides; i++) idx.push(r0 + i, t, r0 + ((i + 1) % sides)); };
  const band = (a, b, sides) => {
    for (let i = 0; i < sides; i++) {
      const i1 = (i + 1) % sides;
      idx.push(a + i, b + i, a + i1, a + i1, b + i, b + i1);
    }
  };
  // Trunk.
  const t0 = ring(0, 0.05, 0, 5), t1 = ring(0.25, 0.04, 0, 5);
  band(t0, t1, 5);
  if (kind === 'broadleaf') {
    const s = 8;
    const r0 = ring(0.2, 0.45, -0.7, s), r1 = ring(0.42, 0.95, -0.1, s), r2 = ring(0.68, 0.85, 0.4, s), r3 = ring(0.88, 0.45, 0.9, s);
    band(r0, r1, s); band(r1, r2, s); band(r2, r3, s);
    fan(r3, tip(0.98), s);
  } else {
    // Three overlapping tiers, like a spruce or fir.
    const s = 7;
    const tiers = [[0.12, 1.0, 0.55], [0.4, 0.72, 0.8], [0.64, 0.45, 1.0]];
    for (const [y0, r, y1] of tiers) {
      const r0 = ring(y0, r, 0.45, s);
      fan(r0, tip(y1), s);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

export class Trees {
  constructor(globals, tiles) {
    this.globals = globals;
    this.tiles = tiles;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.geoms = { conifer: treeGeometry('conifer'), broadleaf: treeGeometry('broadleaf') };
    this.kind = 'conifer';
    this.far = 1400;
    this.enabled = true;
    this.uniforms = {
      uTreeFar: { value: this.far }, uBroadleaf: { value: 0 }, uTreeScale: { value: 1 }, uClearR: { value: 0 },
    };
    this.count = 0;
    tiles.onDispose = (t) => this._drop(t);
  }

  setKind(biome) {
    const broad = biome === 'broadleaf' || biome === 'chaparral' || biome === 'pine-oak';
    this.uniforms.uBroadleaf.value = broad ? 1 : 0;
    this.uniforms.uTreeScale.value = biome === 'chaparral' || biome === 'desert' || biome === 'steppe' ? 0.45 : biome === 'tundra' || biome === 'ice' ? 0.6 : 1;
    const kind = broad ? 'broadleaf' : 'conifer';
    if (kind === this.kind) return;
    this.kind = kind;
    for (const t of this.tiles.built) this._drop(t); // rebuilt with the new shape on demand
  }

  setRange(far) { this.far = far; this.uniforms.uTreeFar.value = far; }

  _drop(t) {
    if (!t.trees) return;
    const g = t.trees.geometry;
    g.index = null; // shared with the base tree geometry
    g.dispose();
    t.trees.material.dispose();
    t.trees = null;
  }

  /** Build the candidate trunks of the world-locked cells inside a tile. */
  _build(t) {
    const n = 2 ** t.z, size = CIRC / n;
    const x0 = (t.x / n) * CIRC, y0 = (t.y / n) * CIRC;
    const c0x = Math.ceil(x0 / CELL), c1x = Math.floor((x0 + size) / CELL) - 1;
    const c0y = Math.ceil(y0 / CELL), c1y = Math.floor((y0 + size) / CELL) - 1;
    const count = Math.max(0, (c1x - c0x + 1) * (c1y - c0y + 1));
    const off = new Float32Array(count * 3), uv = new Float32Array(count * 2), hh = new Float32Array(count), seed = new Float32Array(count);
    const center = t.data.center;
    let k = 0;
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const s = hashCell(cx, cy);
        const mx = (cx + 0.15 + 0.7 * fract(s * 7.31)) * CELL, my = (cy + 0.15 + 0.7 * fract(s * 3.17)) * CELL;
        const u = (mx - x0) / size, v = (my - y0) / size;
        const h = tileHeightAt(t.data, u, v);
        const lon = mxToLon(mx / CIRC), lat = myToLat(my / CIRC);
        const r = EARTH_RADIUS + h, cl = Math.cos(lat * DEG);
        off[k * 3] = r * cl * Math.cos(lon * DEG) - center[0];
        off[k * 3 + 1] = r * cl * Math.sin(lon * DEG) - center[1];
        off[k * 3 + 2] = r * Math.sin(lat * DEG) - center[2];
        uv[k * 2] = u; uv[k * 2 + 1] = v; hh[k] = h; seed[k] = s * 1000;
        k++;
      }
    }
    const base = this.geoms[this.kind];
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.attributes.position = base.attributes.position;
    g.attributes.normal = base.attributes.normal;
    g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    g.setAttribute('aUv', new THREE.InstancedBufferAttribute(uv, 2));
    g.setAttribute('aH', new THREE.InstancedBufferAttribute(hh, 1));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    g.instanceCount = count;
    const tu = t.mesh.material.uniforms;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, side: THREE.DoubleSide,
      uniforms: {
        ...this.globals, ...this.uniforms,
        uTex: tu.uTex, uTexSize: tu.uTexSize, uS: tu.uS, uTileOrigin: tu.uTileOrigin, uTileSizeM: tu.uTileSizeM, uTileCenter: tu.uTileCenter,
      },
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    t.trees = mesh;
    t.treesFrom = t.data;
  }

  /** Choose tiles that get trees this frame and position their meshes. */
  update(budgetMs = 4) {
    this.group.children.length = 0;
    this.count = 0;
    if (!this.enabled) return;
    const t0 = performance.now();
    const cam = this.tiles.view.cam;
    for (const t of this.tiles.mainList) {
      if (t.z < MIN_Z) continue;
      const c = t.data.center;
      const d = Math.hypot(c[0] - cam[0], c[1] - cam[1], c[2] - cam[2]) - t.data.radius;
      if (d > this.far) continue;
      if (t.trees && t.treesFrom !== t.data) this._drop(t); // the tile was rebuilt
      if (!t.trees) {
        if (performance.now() - t0 > budgetMs) continue;
        this._build(t);
      }
      t.trees.matrixWorld.copy(t.mesh.matrixWorld);
      this.group.children.push(t.trees);
      t.trees.parent = this.group;
      this.count += t.trees.geometry.instanceCount;
    }
  }
}

function hashCell(x, y) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
const fract = (v) => v - Math.floor(v);
