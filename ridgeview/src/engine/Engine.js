// Owns the renderer and runs one frame: apply the current look to the
// shader uniforms, choose terrain tiles, render sun shadows, then sky,
// terrain and clouds into an HDR target, then the post pass to the screen.
import * as THREE from 'three';
import { DemSource } from './DemSource.js';
import { TerrainTiles, QUALITY, resolveQuality } from './TerrainTiles.js';
import { createGlobals } from './TerrainMaterial.js';
import { Sky } from './Sky.js';
import { Clouds } from './Clouds.js';
import { Shadows } from './Shadows.js';
import { Post } from './Post.js';
import { Reflection } from './Reflection.js';
import { Trees } from './Trees.js';
import { sampleSkyLight, lightTransmittance } from './AtmosphereCPU.js';
import { CameraRig } from '../scene/CameraRig.js';
import { Looks } from '../scene/Looks.js';
import { clamp, enuBasis } from '../core/geo.js';

export class Engine {
  constructor(canvas, { proxy = false, quality = 'high', preserve = false } = {}) {
    quality = resolveQuality(quality);
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false, depth: true,
      powerPreference: 'high-performance', preserveDrawingBuffer: preserve,
    });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.gl2 = this.renderer.capabilities.isWebGL2;
    this.dem = new DemSource({ proxy, maxTiles: quality === 'low' ? 300 : 700 });
    this.globals = createGlobals();
    this.tiles = new TerrainTiles({ dem: this.dem, globals: this.globals, quality });
    this.sky = new Sky(this.globals);
    this.clouds = new Clouds(this.globals);
    this.shadows = new Shadows(this.globals, QUALITY[quality].shadowSize);
    this.post = new Post();
    this.reflection = new Reflection(this.globals);
    this.trees = new Trees(this.globals, this.tiles);
    this.trees.setRange(QUALITY[quality].treeFar);
    this.trees.enabled = QUALITY[quality].treeFar > 0;
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.add(this.tiles.group);
    this.scene.add(this.trees.group);
    this.scene.add(this.clouds.mesh);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.3, 1e8);
    this.rig = new CameraRig();
    this.looks = new Looks();
    this.exposure = 1;
    this.time = 0;
    this.frameNo = 0;
    this.skyLight = null;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.flightSpeed = 0;
    this.flash = 0;
    this.trans = null;
    this.resize();
  }

  setQuality(name) {
    name = resolveQuality(name);
    this.tiles.setQuality(name);
    this.shadows.setSize(QUALITY[name].shadowSize);
    this.trees.setRange(QUALITY[name].treeFar);
    this.trees.enabled = QUALITY[name].treeFar > 0;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, name === 'low' ? 1 : name === 'medium' ? 1.25 : 2);
    this.resize();
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    const W = Math.round(w * this.pixelRatio), H = Math.round(h * this.pixelRatio);
    if (!this.hdr || this.hdr.width !== W || this.hdr.height !== H) {
      this.hdr?.dispose();
      const depth = new THREE.DepthTexture(W, H, THREE.FloatType);
      this.hdr = new THREE.WebGLRenderTarget(W, H, {
        type: THREE.HalfFloatType, samples: 4, depthTexture: depth, depthBuffer: true,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
    }
    this.camera.aspect = w / h;
    this.post.uniforms.uRes.value.set(W, H);
    this.globals.uViewRes.value.set(W, H);
    this.width = w; this.height = h;
  }

  /** Height of the rendered ground under a lon/lat (NaN if unknown). */
  groundAt(lon, lat) { return this.tiles.heightAt(lon, lat); }

  /** Distance to the terrain along a screen ray (ndc), or null. */
  pick(ndcX, ndcY) {
    const d = this.rig.rayAt(ndcX, ndcY, this.camera.aspect);
    const t = this.tiles.raycast(this.rig.pos, d);
    return t === null ? null : { t, dir: d, point: [0, 1, 2].map((i) => this.rig.pos[i] + d[i] * t) };
  }

  /** Start a wipe from the current picture to whatever is drawn next. */
  beginWipe(kind = 0, duration = 1.1) {
    this.post.capture(this.renderer, this.hdr, this.hdr.width, this.hdr.height);
    this.post.uniforms.uHasSnap.value = 1;
    this.trans = { t: 0, duration, kind };
  }

  _applyLook() {
    const L = this.looks.cur, g = this.globals;
    const { sun, moon } = this.looks.directions();
    g.uSunDir.value.set(...sun);
    g.uMoonDir.value.set(...moon);
    g.uSunPower.value = 22 * L.sunMul;
    g.uMoonPower.value = 0.55 * clamp(Math.sin((L.moonEl * Math.PI) / 180) * 3, 0, 1);
    g.uMieMul.value = L.mieMul;
    g.uRayMul.value = L.rayMul;
    g.uSnowShift.value = L.snowShift;
    g.uAutumn.value = L.autumn;
    g.uWetness.value = L.wetness;
    g.uForestDensity.value = L.density;
    g.uForestFloor.value = L.floor;
    g.uDryness.value = L.dryness;
    g.uPlaya.value = L.playa;
    g.uCloudOn.value = L.cloudOn;
    g.uCloudTop.value = L.cloudTop;
    g.uStormDark.value = L.stormDark;
    g.uOverlayMix.value = L.overlayMix;
    g.uStyle.value = this.looks.styleCode;
    g.uOverlay.value = this.looks.overlayCode;
    const set = (u, c) => u.value.setRGB(c[0], c[1], c[2]);
    set(g.uForestCol, L.forest); set(g.uGrassCol, L.grass); set(g.uDryCol, L.dry); set(g.uRockCol, L.rock);
    set(g.uRockCol2, L.rock2); set(g.uSoilCol, L.soil); set(g.uAutumnCol, L.autumnCol);
    // Multiple scattering stand-in: a faint sky glow that follows the sun, plus airglow at night.
    const sinEl = Math.sin((L.sunEl * Math.PI) / 180);
    const day = clamp((sinEl + 0.12) / 0.4, 0, 1);
    // (Single scattering alone leaves a daytime sky ~3x too dark next to the sun.)
    g.uAmbientTint.value.set(0.0009 + 0.09 * day, 0.0012 + 0.11 * day, 0.002 + 0.15 * day).multiplyScalar(L.sunMul * 0.6 + 0.4);
    const cu = this.clouds.uniforms;
    cu.uCloudOn.value = L.deckOn;
    cu.uCoverage.value = L.deckCoverage;
    cu.uDark.value = L.deckDark;
    this.deckH = L.deckH;
    const ctx = this.looks.ctx;
    g.uHypso.value.set((ctx.ground ?? 0) - 300, ctx.summit ?? 4000);
    g.uDeckOn.value = L.deckOn;
    g.uDeckH.value = L.deckH;
    g.uDeckDark.value = L.deckDark;
    this.sky.uniforms.uHighClouds.value = L.highClouds ?? 0;
    const p = this.post.uniforms;
    p.uStyle.value = this.looks.styleCode;
    p.uSat.value = L.sat;
    p.uContrast.value = L.contrast;
    p.uTint.value.set(...(L.tint ?? [1, 1, 1]));
    p.uPrecip.value = (L.precip ?? 0) * clamp(1 - (this.agl ?? 0) / 4000, 0, 1); // not from orbit
  }

  _updateSkyLight() {
    const g = this.globals;
    const params = {
      sunDir: g.uSunDir.value.toArray(), moonDir: g.uMoonDir.value.toArray(), sunPower: g.uSunPower.value,
      moonPower: g.uMoonPower.value, mieMul: g.uMieMul.value, rayMul: g.uRayMul.value, ambient: g.uAmbientTint.value.toArray(),
    };
    const { lon, lat, h } = this.rig.lonLatH;
    const ground = this.groundAt(lon, lat);
    const hEval = Math.max(0, Number.isFinite(ground) ? Math.min(h, ground + 300) : h);
    const up = enuBasis(lon, lat).up;
    const oKm = up.map((v) => v * (6378.137 + hEval / 1000));
    this.skyLight = sampleSkyLight(oKm, up, params);
    const s = this.skyLight;
    g.uSkyIrr.value.set(...s.irradiance);
    g.uSkyZenith.value.set(...s.zenith);
    g.uSkyHorizon.value.set(...s.horizon);
    // Cloud colour (terrain fog inside the cloud sea): lit from above.
    const sunUp = Math.max(0, up[0] * params.sunDir[0] + up[1] * params.sunDir[1] + up[2] * params.sunDir[2]);
    const c = s.sunAtGround.map((v, i) => (0.85 / Math.PI) * (v * params.sunPower * (sunUp * 0.8 + 0.12) + s.irradiance[i]));
    g.uCloudCol.value.set(...c);
    // Auto exposure from the light reaching the ground here. Faces turned to
    // a low sun get far more than flat ground, so the sun's share is
    // weighted as if partly facing it; the moon counts as a light too.
    const moonUp = Math.max(0, up[0] * params.moonDir[0] + up[1] * params.moonDir[1] + up[2] * params.moonDir[2]);
    const face = (u) => (u > 0 ? 0.35 + 0.65 * u : 0);
    const E = s.sunAtGround.map((v, i) => v * params.sunPower * face(sunUp) + s.moonAtGround[i] * params.moonPower * face(moonUp) + s.irradiance[i]);
    // The summits may still be in sunlight when the valley is not (alpenglow):
    // expose for whichever is brighter so the glow reads against a dark valley.
    const peakKm = Math.max(hEval, this.looks.ctx.summit ?? 0) / 1000;
    const peakT = lightTransmittance(peakKm, sunUp, params);
    const Ep = peakT.map((v, i) => v * params.sunPower * 0.6 + s.irradiance[i]);
    const lumOf = (e) => (0.2 / Math.PI) * (0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2]);
    const lum = Math.max(lumOf(E), lumOf(Ep) * 0.8);
    let exposure = clamp((0.42 / Math.max(lum, 1e-6)) * this.looks.cur.exposure, 0.02, 60);
    // From high up, the eye adapts to the sunlit planet, not the ground below.
    const space = clamp((Math.log10(Math.max(h, 1)) - Math.log10(25000)) / (Math.log10(400000) - Math.log10(25000)), 0, 1);
    if (space > 0) {
      const sunlit = 0.42 / ((0.2 / Math.PI) * params.sunPower * 0.55);
      exposure = Math.exp(Math.log(exposure) * (1 - space) + Math.log(sunlit) * space);
    }
    this.exposureTarget = exposure;
  }

  _prefetch(t, K) {
    this._pfRig ??= new CameraRig();
    this._pfCam ??= new THREE.PerspectiveCamera(40, 1, 0.3, 1e8);
    const rig = this._pfRig, cam = this._pfCam;
    rig.fov = t.fov;
    rig.set(t.lon, t.lat, t.h, t.heading, t.pitch);
    cam.aspect = this.camera.aspect;
    rig.apply(cam);
    const proj = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.tiles.prefetch({ cam: rig.pos, frustum: new THREE.Frustum().setFromProjectionMatrix(proj), K: K * 0.5, casters: null });
  }

  frame(dt) {
    this.time += dt;
    this.frameNo++;
    this.looks.update(dt);
    this._applyLook();
    const g = this.globals;
    g.uTime.value = this.time;
    this.rig.apply(this.camera);
    const cam = this.rig.pos;
    g.uCamKm.value.set(cam[0] / 1000, cam[1] / 1000, cam[2] / 1000);
    this.sky.update(this.camera);
    const proj = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(proj);
    const K = (this.height * this.pixelRatio) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const { lon, lat, h } = this.rig.lonLatH;
    const ground = this.groundAt(lon, lat);
    this.agl = h - (Number.isFinite(ground) ? ground : 0);
    const sunVec = g.uSunDir.value;
    const up = enuBasis(lon, lat).up;
    const sunUp = sunVec.x * up[0] + sunVec.y * up[1] + sunVec.z * up[2];
    const shadowOn = this.looks.styleCode !== 1 && this.looks.styleCode !== 4 && sunUp > -0.06 && this.agl < 60000 && this.tiles.q.shadowSize > 0;
    const casters = this.shadows.fit(this.camera, sunVec, Math.max(0, this.agl), shadowOn);
    this.tiles.update({ cam, frustum, K, casters });
    if (this.prefetchTarget && this.frameNo % 3 === 0) this._prefetch(this.prefetchTarget, K);
    this.dem.update();
    if (this.frameNo % 4 === 1 || this.looks.animating || !this.skyLight) this._updateSkyLight();
    // Exposure adapts in log space (~0.6 s).
    const fixed = [1, 2, 3, 4].includes(this.looks.styleCode); // display-referred styles
    const target = fixed ? 1 : this.exposureTarget;
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * Math.min(1, dt * 2.5));
    const p = this.post.uniforms;
    p.uExposure.value = this.exposure;
    p.uTime.value = this.time;
    p.uSpeed.value = this.flightSpeed;
    p.uFlash.value = this.flash;
    p.uPixel.value = Math.max(3, Math.round(this.height * this.pixelRatio / 200));
    p.uVignette.value = 0.55;
    if (this.trans) {
      this.trans.t += dt;
      p.uTrans.value = Math.min(1, this.trans.t / this.trans.duration);
      p.uTransKind.value = this.trans.kind;
      if (this.trans.t >= this.trans.duration) { this.trans = null; p.uTrans.value = -1; p.uHasSnap.value = 0; }
    }
    this.clouds.update(cam, enuBasis(lon, lat), this.deckH ?? 3000);
    // Passes.
    const r = this.renderer;
    if (shadowOn) {
      this.tiles.usePass('shadow');
      this.clouds.mesh.visible = false;
      this.trees.group.visible = false; // the depth shader has no instancing
      this.shadows.render(r, this.scene);
      this.trees.group.visible = true;
      this.clouds.update(cam, enuBasis(lon, lat), this.deckH ?? 3000);
    }
    this.tiles.usePass('main');
    if (this.looks.biome !== this._treeBiome) { this._treeBiome = this.looks.biome; this.trees.setKind(this.looks.biome); }
    this.trees.group.visible = this.looks.styleCode === 0 || this.looks.styleCode === 5;
    this.trees.update();
    if (this.tiles.q.micro) {
      this.reflection.detect(this, performance.now());
      this.reflection.render(this, dt);
    } else this.globals.uReflOn.value = 0;
    r.setRenderTarget(this.hdr);
    r.clear(true, true, false);
    r.render(this.sky.scene, this.sky.camera);
    r.render(this.scene, this.camera);
    this.post.render(r, this.hdr, null);
  }
}
