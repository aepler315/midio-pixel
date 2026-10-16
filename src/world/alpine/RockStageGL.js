// Range v2 rock stage on the GPU (Task 11). An orthographic camera mapped
// 1:1 onto the fixed-ground logical stage (y down), so the returned image
// composes under the ground transform exactly once. Geometry comes from
// RockStage.buildRockStage each frame (the support curve moves with the
// music); materials are the pack's stage data maps under its palette.
// Local light: the cast's own glows light the rock around them (up to 3
// emitters, in the same fixed-ground coordinates as their bodies).
import { setLinearFromHex } from './TerrainMaterial.js';
import { emitterStrength } from './RangeAtmosphere.js';

const VERT = /* glsl */`
  in float surface;
  in vec2 stageUv;
  out vec3 vN;
  out vec2 vUv;
  out vec2 vXY;
  out float vSurface;
  out float vDepth;
  void main() {
    vN = normal;
    vUv = stageUv;
    vXY = position.xy;
    vSurface = surface;
    vDepth = position.z;
    gl_Position = projectionMatrix * viewMatrix * vec4(position.xy, position.z, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tStage;  uniform float sStage;
  uniform sampler2D tWet;    uniform float sWet;
  uniform sampler2D tSoil;   uniform float sSoil;
  uniform vec3 pRockLit; uniform vec3 pRockShade; uniform vec3 pWetRock; uniform vec3 pMoss; uniform vec3 pSoil; uniform vec3 pLichen;
  uniform vec3 uKeyDir; uniform vec3 uKeyColor; uniform vec3 uSkyZenith; uniform vec3 uSkyHorizon;
  uniform float uAmbientScale; uniform float uExposure; uniform float uMoss;
  uniform vec4 uEmitters[3];      // x, y (logical px), radius px, intensity
  uniform vec3 uEmitterColor[3];  // linear
  uniform vec4 uPools[8];         // cx, cy, rx, ry  (logical px)
  uniform float uPoolAlpha[8];
  uniform float uDiag;
  uniform vec2 uNarrativeStage; // physical materials, water features
  in vec3 vN; in vec2 vUv; in vec2 vXY; in float vSurface; in float vDepth;
  out vec4 outColor;
  vec3 tonemap(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  void main() {
    bool riser = vSurface > 0.5;
    float front = riser ? 1.0 : vSurface / 0.45; // 0 back .. 1 front edge
    // Two rotated scales of the scan data hide its tile.
    vec2 uvB = mat2(0.8, -0.6, 0.6, 0.8) * vUv;
    vec4 st = mix(texture(tStage, vUv / (sStage * 2.6)), texture(tStage, uvB / sStage + 0.37), 0.5);
    vec4 so = texture(tSoil, uvB / sSoil);
    vec2 dn = (st.rg * 2.0 - 1.0) * 1.4;
    vec3 n = normalize(vN + (riser ? vec3(dn.x, dn.y, 0.0) : vec3(dn.x, 0.0, -dn.y)) * 0.9);
    // Moss gathers in low relief of the slab tops and just behind the lips.
    float lip = riser ? 0.0 : smoothstep(0.55, 0.85, front) * (1.0 - smoothstep(0.93, 1.0, front));
    float moss = uMoss * (smoothstep(0.5, 0.3, st.a) * 0.8 + smoothstep(0.5, 0.72, so.a) * 0.6) * (riser ? 0.25 : 1.0);
    moss = clamp(moss + lip * 0.3 * uMoss, 0.0, 1.0);
    // Damp ring around pools (the water itself is drawn separately).
    float damp = 0.0;
    for (int i = 0; i < 8; i++) {
      vec4 p = uPools[i];
      if (p.z <= 0.0) continue;
      vec2 q = (vXY - p.xy) / (p.zw * vec2(1.35, 2.2));
      damp = max(damp, uPoolAlpha[i] * (1.0 - smoothstep(0.7, 1.0, length(q))));
    }
    vec3 rock = mix(pRockShade, pRockLit, clamp((st.a - 0.5) * 1.8 + 0.45, 0.0, 1.0));
    // Worn front edge: the lit lip of each slab.
    float edge = riser ? 0.0 : smoothstep(0.9, 1.0, front);
    rock = mix(rock, pLichen, 0.18 * smoothstep(0.6, 0.9, so.a));
    vec3 albedo = mix(rock, pMoss, moss);
    albedo = mix(albedo, pWetRock, damp * 0.8);
    albedo *= riser ? 0.8 : 1.0 + 0.2 * edge;
    float rough = mix(st.b, 0.25, damp);
    float wrap = 0.2;
    float key = max((dot(n, uKeyDir) + wrap) / (1.0 + wrap), 0.0);
    // Sky light on near rock: a top sees the whole dome (zenith and the
    // brighter horizon band), a face toward the camera mostly the horizon.
    // Using the zenith alone left the stage black once night deepened.
    vec3 dome = mix(uSkyZenith, uSkyHorizon, 0.45);
    vec3 hemi = mix(uSkyHorizon * 0.6, dome, 0.5 + 0.5 * n.y) * uAmbientScale;
    // Tops face the open sky; faces toward the camera see the horizon.
    vec3 lit = albedo * (hemi * (riser ? 0.7 : 1.0) + uKeyColor * key * (1.0 + 0.4 * edge));
    // Local emitters: compact, material-dependent (wet rock returns more).
    for (int i = 0; i < 3; i++) {
      vec4 e = uEmitters[i];
      if (e.w <= 0.0) continue;
      vec2 d = vXY - e.xy;
      float fall = max(0.0, 1.0 - length(d) / e.z);
      fall *= fall;
      vec3 l = normalize(vec3(-d.x, max(8.0, e.z * 0.25), riser ? e.z * 0.3 : -d.y * 0.2));
      float face = max(dot(n, l), 0.0);
      lit += albedo * uEmitterColor[i] * e.w * fall * face * (1.0 + 1.5 * damp) * 3.0;
      lit += uEmitterColor[i] * e.w * fall * damp * 0.35 * pow(1.0 - rough, 2.0);
    }
    vec3 color = mix(uSkyHorizon, tonemap(lit * uExposure), uNarrativeStage.x);
    outColor = vec4(pow(max(color, 0.0), vec3(1.0 / 2.2)), 1.0);
    if (uDiag > 0.5) outColor = vec4(0.0, 1.0, 1.0, 1.0);
  }
`;

const WATER_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uKeyDir; uniform vec3 uKeyColor;
  uniform vec3 uSkyZenith; uniform vec3 uSkyHorizon; uniform vec3 pWater; uniform vec3 pWaterDeep;
  uniform float uExposure; uniform float uTime;
  uniform vec2 uNarrativeStage;
  uniform vec2 uWaterHits[8]; // age seconds, preserved contact strength
  uniform float uWaterFlash;
  uniform vec4 uEmitters[3]; uniform vec3 uEmitterColor[3];
  in vec2 vXY;
  in float vPoolAlpha;
  in vec2 vPoolCenter;
  out vec4 outColor;
  vec3 tonemap(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  void main() {
    // Shallow water seen at a grazing angle: mostly sky, a little bed.
    float ripple = 0.5 + 0.5 * sin(vXY.x * 0.09 + uTime * 1.3) * sin(vXY.y * 0.4 - uTime * 0.9);
    vec3 sky = mix(uSkyHorizon, uSkyZenith, 0.35 + 0.1 * ripple);
    // The sky it mirrors is seen at a grazing angle and darkened by the
    // shallow bed; kept below the lit rock so pools read as water, not glare.
    vec3 c = mix(pWaterDeep, sky * 0.1, 0.5);
    // Rough shallow water at the stage's grazing view. The same resolved
    // key used by the slabs supplies direction and visibility-weighted
    // radiance. The water mesh clips this response to real pool polygons.
    vec3 waterNormal = normalize(vec3(0.16 * cos(vXY.x * 0.09 + uTime * 1.3), 1.0,
      0.2 * sin(vXY.y * 0.4 - uTime * 0.9)));
    vec3 halfVector = normalize(uKeyDir + normalize(vec3(0.0, 0.25, 1.0)));
    float glint = pow(max(dot(waterNormal, halfVector), 0.0), 24.0);
    c += uKeyColor * glint * 1.2;
    for (int i = 0; i < 3; i++) {
      vec4 e = uEmitters[i];
      if (e.w <= 0.0) continue;
      float fall = max(0.0, 1.0 - length(vXY - e.xy) / (e.z * 1.4));
      // A glow nearby tints the water; kept weak so the pool stays dark
      // enough for the reflection drawn into it to read.
      c += uEmitterColor[i] * e.w * fall * fall * 0.18;
    }
    for (int i = 0; i < 8; i++) {
      vec2 hit = uWaterHits[i];
      if (hit.x < 0.0 || hit.x > 2.0 || hit.y <= 0.0) continue;
      vec2 q = (vXY - vPoolCenter) / vec2(4.0 + 22.0 * hit.x, 2.0 + 4.0 * hit.x);
      float ring = 1.0 - smoothstep(0.02, 0.18, abs(length(q) - 1.0));
      c += vec3(0.07) * ring * exp(-hit.x / 0.45) * hit.y * uWaterFlash;
    }
    vec3 color = tonemap(c * uExposure);
    float a = vPoolAlpha * uNarrativeStage.y;
    outColor = vec4(pow(color, vec3(1.0 / 2.2)) * a, a);
  }
`;

const WATER_VERT = /* glsl */`
  in float poolAlpha;
  in vec2 poolCenter;
  out vec2 vXY;
  out float vPoolAlpha;
  out vec2 vPoolCenter;
  void main() { vXY = position.xy; vPoolAlpha = poolAlpha; vPoolCenter = poolCenter; gl_Position = projectionMatrix * viewMatrix * vec4(position.xy, 1.2, 1.0); }
`;

export function hueToLinear(h, s = 0.75, l = 0.6) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
}

export class RockStageGL {
  constructor(THREE, { textures, palette, rules }) {
    this.THREE = THREE;
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 20);
    this.camera.position.set(0, 0, 10);
    this.scene = new THREE.Scene();
    const col = (hex) => setLinearFromHex(new THREE.Color(), hex);
    const u = {
      tStage: { value: textures.roles.stage.texture }, sStage: { value: 150 },
      tWet: { value: textures.roles.stageWet.texture }, sWet: { value: 120 },
      tSoil: { value: textures.roles.soil.texture }, sSoil: { value: 110 },
      pRockLit: { value: col(palette.rockLit) }, pRockShade: { value: col(palette.rockShade) }, pWetRock: { value: col(palette.wetRock) },
      pMoss: { value: col(palette.moss) }, pSoil: { value: col(palette.soil) }, pLichen: { value: col(palette.lichen) },
      pWater: { value: col(palette.water) }, pWaterDeep: { value: col(palette.waterDeep) },
      uKeyDir: { value: new THREE.Vector3(-0.4, 0.8, -0.3).normalize() }, uKeyColor: { value: new THREE.Color(0.2, 0.22, 0.28) },
      uSkyZenith: { value: new THREE.Color() }, uSkyHorizon: { value: new THREE.Color() },
      // Near rock sees far less of the sky than open terrain does (the cast,
      // the slabs behind and the valley walls shade it): a lower ambient
      // keeps the stage the darkest band of the frame, as in the reference.
      // Measured in the pilot (SwiftShader, mean sRGB of the stage): about
      // (50,63,61) at 30 s with the moon up and (26,33,36) at 90 s with it
      // set, against the reference's foreground rock ~(45,52,58).
      uAmbientScale: { value: 0.45 }, uExposure: { value: 2.0 }, uMoss: { value: rules.moss ?? 0.5 },
      uEmitters: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uEmitterColor: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      uPools: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
      uPoolAlpha: { value: new Array(8).fill(0) },
      uDiag: { value: 0 }, uTime: { value: 0 },
      uWaterHits: { value: Array.from({ length: 8 }, () => new THREE.Vector2(0, 0)) },
      uWaterFlash: { value: 1 },
      uNarrativeStage: { value: new THREE.Vector2(1, 1) },
    };
    this.uniforms = u;
    // The camera maps y down (top 0, bottom H), which mirrors triangle
    // winding: faces are two-sided so none is culled as a back face.
    this.material = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms: u,
      side: THREE.DoubleSide });
    this.geometry = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.waterMaterial = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG,
      uniforms: u, transparent: true, depthTest: false, depthWrite: false, premultipliedAlpha: true, side: THREE.DoubleSide });
    this.waterGeometry = new THREE.BufferGeometry();
    this.water = new THREE.Mesh(this.waterGeometry, this.waterMaterial);
    this.water.frustumCulled = false;
    this.scene.add(this.water);
    this.bytes = 0;
  }

  /** Upload this frame's stage and per-frame uniforms. */
  update(stage, { width, height, frame, lightDir, skyZenith, skyHorizon }) {
    const cam = this.camera;
    cam.left = 0; cam.right = width; cam.top = 0; cam.bottom = height;
    cam.updateProjectionMatrix();
    this._upload(this.geometry, { position: [stage.positions, 3], normal: [stage.normals, 3],
      surface: [stage.surfaces, 1], stageUv: [stage.uv, 2] }, stage.indices);
    // Water: fans of the exact pool polygons.
    const wp = [], wa = [], wc = [];
    const u = this.uniforms;
    u.uNarrativeStage.value.set(frame.narrative?.materials ?? 1, frame.narrative?.features ?? 1);
    stage.pools.slice(0, 8).forEach((p, i) => {
      const c = p.polygon.reduce((a, q) => [a[0] + q.x / p.polygon.length, a[1] + q.y / p.polygon.length], [0, 0]);
      for (let k = 0; k < p.polygon.length; k++) {
        const a = p.polygon[k], b = p.polygon[(k + 1) % p.polygon.length];
        wp.push(c[0], c[1], 0, a.x, a.y, 0, b.x, b.y, 0);
        wa.push(p.alpha ?? 1, p.alpha ?? 1, p.alpha ?? 1);
        wc.push(c[0], c[1], c[0], c[1], c[0], c[1]);
      }
      const xs = p.polygon.map((q) => q.x), ys = p.polygon.map((q) => q.y);
      u.uPools.value[i].set(c[0], c[1], (Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...ys) - Math.min(...ys)) / 2);
      u.uPoolAlpha.value[i] = p.alpha ?? 1;
    });
    for (let i = stage.pools.length; i < 8; i++) { u.uPools.value[i].set(0, 0, 0, 0); u.uPoolAlpha.value[i] = 0; }
    this._upload(this.waterGeometry, { position: [Float32Array.from(wp), 3], poolAlpha: [Float32Array.from(wa), 1], poolCenter: [Float32Array.from(wc), 2] }, null);
    this.water.visible = wp.length > 0;
    for (let i = 0; i < 8; i++) {
      const hit = frame.waterHits?.[i];
      const age = hit ? (frame.timeMs - hit.tMs) / 1000 : -1;
      u.uWaterHits.value[i].set(age, age >= 0 && age <= 2 && !frame.reducedMotion ? Math.min(1, Math.max(0, hit.strength || 0)) : 0);
    }
    u.uWaterFlash.value = frame.reducedFlash ? .35 : 1;
    const ems = (frame.emitters || []).filter((e) => e.visible).slice(0, 3);
    for (let i = 0; i < 3; i++) {
      const e = ems[i];
      if (!e) { u.uEmitters.value[i].set(0, 0, 1, 0); continue; }
      u.uEmitters.value[i].set(e.x, e.supportY ?? e.y, 150, emitterStrength({ airbornePx: e.airborneM, reducedFlash: frame.reducedFlash }) * (e.presence ?? 1));
      const [r, gg, b] = hueToLinear(e.hue ?? 180);
      u.uEmitterColor.value[i].set(r, gg, b);
    }
    if (lightDir) u.uKeyDir.value.copy(lightDir);
    if (skyZenith) u.uSkyZenith.value.copy(skyZenith);
    if (skyHorizon) u.uSkyHorizon.value.copy(skyHorizon);
    // Stage legibility is independently calibrated: keep sheltered fill
    // at night while the open terrain uses the full ambient reduction.
    u.uAmbientScale.value = .45 * (.65 + .35 * (frame.light?.ambientMultiplier ?? 1));
    u.uTime.value = frame.reducedMotion ? 0 : frame.timeMs / 1000;
    this.bytes = stage.positions.byteLength * 3 + stage.indices.byteLength + (wp.length + wa.length + wc.length) * 4;
  }

  /** Copy this frame's arrays into reused GPU attributes. Replacing an
   *  attribute object would orphan its GL buffer (three.js frees buffers only
   *  for the attributes a geometry holds when it is disposed), so storage
   *  grows geometrically and is otherwise rewritten in place. */
  _upload(geometry, attrs, indices) {
    const THREE = this.THREE;
    const count = attrs.position[0].length / 3;
    const cap = geometry.userData.capacity || 0;
    const icap = geometry.userData.indexCapacity || 0;
    // The first upload always allocates: an empty first frame (no pools yet)
    // is not "within capacity" when nothing has been allocated at all.
    if (!geometry.getAttribute('position') || count > cap || (indices && indices.length > icap)) {
      geometry.dispose();
      const n = Math.max(64, Math.ceil(count * 1.5)), ni = indices ? Math.max(96, Math.ceil(indices.length * 1.5)) : 0;
      for (const [name, [, size]] of Object.entries(attrs)) {
        const a = new THREE.BufferAttribute(new Float32Array(n * size), size);
        a.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(name, a);
      }
      if (indices) {
        const ia = new THREE.BufferAttribute(new Uint32Array(ni), 1);
        ia.setUsage(THREE.DynamicDrawUsage);
        geometry.setIndex(ia);
      }
      geometry.userData.capacity = n;
      geometry.userData.indexCapacity = ni;
    }
    for (const [name, [data]] of Object.entries(attrs)) {
      const a = geometry.getAttribute(name);
      a.array.set(data);
      a.clearUpdateRanges();
      a.addUpdateRange(0, data.length);
      a.needsUpdate = true;
    }
    if (indices) {
      geometry.index.array.set(indices);
      geometry.index.clearUpdateRanges();
      geometry.index.addUpdateRange(0, indices.length);
      geometry.index.needsUpdate = true;
    }
    geometry.setDrawRange(0, indices ? indices.length : count);
  }

  dispose() {
    this.geometry.dispose();
    this.waterGeometry.dispose();
    this.material.dispose();
    this.waterMaterial.dispose();
  }
}
