// Execute the shared cover math and complete production terrain fragment.
// Every capture/report stays in the caller's ignored evidence directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { expectedForestCover, meanForestTraits } from '../src/world/alpine/TerrainMaterial.js';
const [url = 'http://127.0.0.1:8094', out = '.smoke/far-forest'] = process.argv.slice(2);
await fs.mkdir(out, { recursive: false });
const errors = [], browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let report;
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(url + '/', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto(url);
  report = await page.evaluate(async () => {
    const T = await import('/src/vendor/range/three-range.module.js');
    const { sceneUniforms, FAR_FOREST_GLSL, SCENE_FRAG } = await import('/src/world/alpine/TerrainMaterial.js');
    const renderer = new T.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(64, 64); renderer.outputColorSpace = T.LinearSRGBColorSpace;
    const target = new T.WebGLRenderTarget(64, 64), pixels = new Uint8Array(64 * 64 * 4);
    const quad = new T.BufferGeometry(), scene = new T.Scene();
    quad.setAttribute('position', new T.BufferAttribute(new Float32Array([-1,-1,0,3,-1,0,-1,3,0]),3));
    const data = rgba => { const t = new T.DataTexture(new Uint8Array(rgba), 1, 1); t.needsUpdate = true; return t; };
    const surface = data([128,128,128,0]), neutral = data([128,128,128,128]), receiver = data([0,0,0,255]);
    const u = sceneUniforms(T, { uSurface: { value: surface }, uReceiver: { value: receiver },
      uGridOrigin: { value: new T.Vector2(-100,-100) }, uGridExtent: { value: new T.Vector2(200,200) },
      uTexel: { value: new T.Vector2(1,1) }, uHeightRange: { value: new T.Vector2(0,2000) } });
    const camera = new T.PerspectiveCamera(50, 1, 1, 100000);
    const shader = new T.ShaderMaterial({ glslVersion: T.GLSL3, depthTest: false, uniforms: {
      uProbe: { value: new T.Vector4() }, uProbeNormal: { value: new T.Vector3(0,1,0) } },
      vertexShader: 'void main(){gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader: `precision highp float; uniform vec4 uProbe; uniform vec3 uProbeNormal; out vec4 outColor;
        ${FAR_FOREST_GLSL}
        void main(){ float e=uProbe.x; vec3 w=vec3(cos(e),sin(e),0.);
          vec2 crown=meanForestCrown(uProbe.y,uProbe.z,uProbe.w,35.);
          float q=expectedForestCover(.7,crown,uProbeNormal,w);
          float a=floor(q*65535.+.5), b=floor(crown.x*1000.+.5);
          outColor=vec4(floor(a/256.),mod(a,256.),floor(b/256.),mod(b,256.))/255.; }` });
    const mesh = new T.Mesh(quad, shader); mesh.frustumCulled=false; scene.add(mesh);
    const cases = [];
    for (const below of [100,350,1000]) for (const slope of [0,35]) for (const angle of [0,.1,.5,Math.PI/2]) for (const scale of [.3,1,3]) {
      shader.uniforms.uProbe.value.set(angle,below,slope,scale);
      shader.uniforms.uProbeNormal.value.set(Math.sin(slope*Math.PI/180), Math.cos(slope*Math.PI/180),0);
      renderer.setRenderTarget(target); renderer.render(scene,camera); renderer.readRenderTargetPixels(target,0,0,64,64,pixels);
      const bytes=Array.from(pixels.slice((32*64+32)*4,(32*64+32)*4+4));
      cases.push({ below,slope,angle,scale,cover:(bytes[0]*256+bytes[1])/65535,radius:(bytes[2]*256+bytes[3])/1000 });
    }
    const terrain = new T.ShaderMaterial({ glslVersion: T.GLSL3, depthTest: false, uniforms: u,
      vertexShader: `out vec2 vUv; out vec3 vWorld; out vec3 vRenderedWorld; out float vViewDepth;
        void main(){vUv=vec2(.5); vWorld=vec3(position.x*10.,0.,position.y*10.);
          vRenderedWorld=vWorld; vViewDepth=6000.;gl_Position=vec4(position.xy,0.,1.);}`, fragmentShader: SCENE_FRAG });
    mesh.material = terrain;
    u.uHasMaterial.value=1; u.uDebugMask.value=3; u.rTreeline.value=2000;
    u.rForestFloor.value=-1000; u.rForestDensity.value=.7; u.rForestMaxSlope.value=36;
    u.rSnowline.value=1e6; u.rSnowFull.value=1e6+400;
    for (const name of ['tRock','tRockNear','tCanopy','tSnow','tSoil']) u[name].value=neutral;
    for (const name of ['pMeadow','pSoil','pMoss','pRockLit','pRockShade','pRockWarm','pLichen']) u[name].value.setRGB(.2,.2,.2);
    u.pForestNear.value.setRGB(.08,.1,.05); u.pForestFar.value.copy(u.pForestNear.value);
    u.uAirDensity.value=0; u.uFarForest.value.set(6500,7800,1,35);
    const draw = (eye, density=.7, uniformEye=eye) => {
      camera.position.set(...eye); camera.updateMatrixWorld(); u.uCameraPos.value.set(...uniformEye);
      u.rForestDensity.value=density; renderer.setRenderTarget(target); renderer.render(scene,camera);
      renderer.readRenderTargetPixels(target,0,0,64,64,pixels);
      return Array.from(pixels.slice((32*64+32)*4,(32*64+32)*4+3));
    };
    const near=draw([0,300,6000]);
    for (const name of ['pRockLit','pRockShade','pRockWarm','pLichen']) u[name].value.setRGB(.9,.8,.7);
    const brightRock=draw([0,300,6000]);
    const start=draw([0,300,6493.073]), end=draw([0,300,7800]), far=draw([0,300,9000]);
    u.uFarForest.value.set(0,0,1,35); const noInstances=draw([0,300,6000]);
    // The actual reflection draw keeps the main-eye lighting uniform. Make
    // it disagree with the draw camera so a uCameraPos forest ray fails.
    const above=draw([0,6000,0],.7,[0,300,6000]), reflected=draw([0,-300,6000],.7,[0,6000,0]);
    const bare=draw([0,300,6000],0);
    shader.dispose(); terrain.dispose(); quad.dispose(); neutral.dispose(); surface.dispose(); receiver.dispose();
    target.dispose(); renderer.dispose();
    return { cases, near, brightRock, start, end, far, noInstances, above, reflected, bare };
  });
  assert.deepEqual(errors, []);
  for (const c of report.cases) {
    const traits = meanForestTraits({ below:c.below,slopeDeg:c.slope,scale:c.scale,cap:35 });
    const normal=[Math.sin(c.slope*Math.PI/180),Math.cos(c.slope*Math.PI/180),0];
    const expected=expectedForestCover({ forest:.7,radius:traits.radius,crownHeight:traits.crownHeight,normal,toEye:[Math.cos(c.angle),Math.sin(c.angle),0] });
    assert.ok(Math.abs(c.cover-expected)<2/65535, `GPU cover parity ${JSON.stringify(c)}`);
    assert.ok(Math.abs(c.radius-traits.radius)<.0011, `GPU traits parity ${JSON.stringify(c)}`);
  }
  assert.deepEqual(report.near,report.brightRock,'sunlit rock overwrites the near forest floor');
  assert.deepEqual(report.near,report.start,'handoff starts before 6.5km');
  assert.deepEqual(report.end,report.far,'handoff is incomplete at 7.8km');
  assert.ok(report.noInstances[0]>report.near[0],'empty/coarse forest exposes bare floor instead of expected cover');
  assert.ok(report.above[0]<report.noInstances[0],'actual overhead camera must reduce crown cover');
  assert.ok(report.above.every(c => c > 0),'overhead probe must draw the production terrain');
  assert.ok(report.reflected[0]>=report.noInstances[0]-2,'reflected camera must use its own grazing ray');
  assert.ok(report.bare[0]>report.near[0],'nonforest rock remains open');
  console.log(JSON.stringify(report));
} finally {
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ ...report,errors },null,2));
  await browser.close();
}
