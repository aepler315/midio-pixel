// Optional screen-space solar scattering. Coverage comes from the same full
// resolution terrain/forest depth twins used by the scenic partitions. No
// angle fan or independent light animation is involved.
export const SHAFT_KEY = 'range:sun-shafts';
export function shaftSize(width, height) {
  const scale = Math.min(.25, 512 / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
export function shaftSource(frame) {
  const source = frame.light?.celestial;
  // Under the full squall deck no sun scatters: skip the passes entirely.
  const stormGain = (1 - (frame.storm?.amount || 0)) * (1 + (frame.storm?.break01 || 0) * 2.8);
  return source?.body === 'sun' && source.visibility > 0 && source.intensity > 0 && stormGain > 0
    && Number.isFinite(source.xFrac) && Number.isFinite(source.yFrac) ? { ...source, stormGain } : null;
}
const VERT = /* glsl */`
  out vec2 vUv;
  void main(){vUv=position.xy*.5+.5;gl_Position=vec4(position.xy,0.,1.);}
`;
// A near opaque receiver has no scattering layer. Beyond three kilometres,
// the view ray has room for distant valley air, saturating at eighteen km.
// This is a screen-space air bound, not a world-space shadow map.
const AIR_DEPTH = /* glsl */`
  uniform vec2 uCameraRange;
  float airDepth(float d){
    float n=uCameraRange.x,f=uCameraRange.y;
    float metres=(n*f)/(f-d*(f-n));
    return smoothstep(3000.,18000.,metres);
  }
`;
const SCATTER = /* glsl */`
  precision highp float;
  uniform sampler2D uDepth;
  uniform vec2 uSun;
  uniform vec2 uRadius;
  uniform float uGain;
  ${AIR_DEPTH}
  in vec2 vUv;
  out vec4 outColor;
  float air(vec2 uv){
    if(any(lessThan(uv,vec2(0.))) || any(greaterThan(uv,vec2(1.))))return 0.;
    return airDepth(texture(uDepth,uv).r);
  }
  float apertureAt(vec2 uv){
    if(any(lessThan(uv,vec2(0.))) || any(greaterThan(uv,vec2(1.))))return 0.;
    return step(1.,texture(uDepth,uv).r);
  }
  void main(){
    // A finite source aperture must be visible. Hidden/offscreen sources do
    // not become bright border texels through clamp-to-edge sampling.
    float aperture=(apertureAt(uSun)+apertureAt(uSun+vec2(uRadius.x,0.))+apertureAt(uSun-vec2(uRadius.x,0.))
      +apertureAt(uSun+vec2(0.,uRadius.y))+apertureAt(uSun-vec2(0.,uRadius.y)))*.2;
    float openSum=0.,blocked=0.;
    for(int i=0;i<32;i++){
      float t=(float(i)+.5)/32.;
      float coverage=air(mix(vUv,uSun,t*.94));
      openSum+=coverage*(1.-t*.55);
      blocked+=1.-coverage;
    }
    // Pure open sky has no vegetation pattern to scatter; fully closed
    // coverage has no transmitted light. Only their boundary contributes.
    float a=air(vUv)*aperture*(openSum/23.2)*(blocked/32.)*uGain;
    a*=exp(-length((vUv-uSun)*vec2(1.,.7))*1.6);
    outColor=vec4(a);
  }
`;
const COMPOSITE = /* glsl */`
  precision highp float;
  uniform sampler2D uDepth;
  uniform sampler2D uShaft;
  uniform vec3 uTint;
  ${AIR_DEPTH}
  in vec2 vUv;
  out vec4 outColor;
  void main(){
    // Exact full-resolution coverage guard, after quarter-resolution
    // filtering: even one-pixel opaque near edges receive no wash.
    float availability=airDepth(texture(uDepth,vUv).r);
    if(availability<=0.)discard;
    float a=texture(uShaft,vUv).r*availability;
    outColor=vec4(uTint*a,a);
  }
`;

/** Construct only after the whole active-side bundle has been reserved.
 * Depth textures replace existing depth renderbuffers (same base charge).
 * This bundle owns their attachment/detachment; the target owns GL deletion.
 */
export class SunShaftGL {
  constructor(THREE, targets) {
    this.targets = targets;
    this.buffers = {};
    this.sourceTargets = Object.values(targets);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.geometry = geo;
    const uniforms = this.uniforms = {
      uDepth: { value: null }, uShaft: { value: null }, uSun: { value: new THREE.Vector2() },
      uRadius: { value: new THREE.Vector2() }, uCameraRange: { value: new THREE.Vector2() },
      uGain: { value: 0 }, uTint: { value: new THREE.Color() },
    };
    this.scatter = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: SCATTER,
      uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.composite = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: COMPOSITE,
      uniforms, depthTest: false, depthWrite: false, transparent: true,
      premultipliedAlpha: true, blending: THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.scatter);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    for (const [side, target] of Object.entries(targets)) {
      const { width, height } = shaftSize(target.width, target.height);
      this.buffers[side] = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.UnsignedByteType,
      });
      // Reinitialize an existing FBO so the old unsampleable renderbuffer is
      // replaced rather than retained beside the sampled attachment.
      target.dispose();
      target.depthTexture = new THREE.DepthTexture(target.width, target.height, THREE.UnsignedIntType);
    }
  }

  render(renderer, side, source, camera, scenicViewport) {
    const target = this.targets[side], buffer = this.buffers[side];
    if (!target || !buffer || !source) return false;
    const u = this.uniforms;
    u.uDepth.value = target.depthTexture;
    u.uCameraRange.value.set(camera.near, camera.far);
    u.uSun.value.set(source.xFrac, 1 - source.yFrac);
    const radius = source.radiusFrac || 0;
    // CelestialState and the painter normalize radius by logical width.
    // Backing pixels can scale X/Y differently during export, so keep the
    // same logical disc before that shared display transform is applied.
    u.uRadius.value.set(radius, radius * scenicViewport.logicalWidth / scenicViewport.logicalHeight);
    u.uGain.value = .55 * Math.min(1, source.intensity / 1.6) * (source.stormGain ?? 1);
    this.mesh.material = this.scatter;
    renderer.setRenderTarget(buffer);
    renderer.render(this.scene, this.camera);
    return true;
  }

  compositeToScreen(renderer, side, source) {
    const u = this.uniforms;
    u.uDepth.value = this.targets[side].depthTexture;
    u.uShaft.value = this.buffers[side].texture;
    // The scenic canvas is display encoded. Preserve the source's display
    // tint directly; there is no second sRGB encode.
    const h = (source.colorHex || '#fff3df').replace('#', '');
    u.uTint.value.setRGB(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
    this.mesh.material = this.composite;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    for (const t of this.sourceTargets) {
      // WebGLRenderTarget disposal deletes its depthTexture exactly once.
      t.dispose();
      t.depthTexture = null;
    }
    this.sourceTargets = [];
    for (const b of Object.values(this.buffers)) b.dispose();
    this.buffers = {};
    this.geometry.dispose();
    this.scatter.dispose();
    this.composite.dispose();
  }
}
