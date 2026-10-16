// Real colour/depth shaders, sub-pixel raster coverage and the production copy.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { crownHalfWidth } from '../src/world/alpine/ForestGL.js';
const [url = 'http://127.0.0.1:8094', output = '.smoke/forest-billboard'] = process.argv.slice(2);
await fs.mkdir(output, { recursive: false });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
let report;
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(url + '/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto(url);
  report = await page.evaluate(async () => {
    const T = await import('/src/vendor/range/three-range.module.js');
    const { createForest, CROWN_GLSL } = await import('/src/world/alpine/ForestGL.js');
    const { sceneUniforms, FAR_FOREST_GLSL } = await import('/src/world/alpine/TerrainMaterial.js');
    const { RangeScene } = await import('/src/world/alpine/RangeScene.js');
    const renderer = new T.WebGLRenderer({ alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(256, 256); renderer.autoClear = false; renderer.outputColorSpace = T.LinearSRGBColorSpace;
    const receiver = new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); receiver.needsUpdate = true;
    const u = sceneUniforms(T, { uReceiver: { value: receiver }, uGridOrigin: { value: new T.Vector2(-100, -100) },
      uGridExtent: { value: new T.Vector2(200, 200) }, uTexel: { value: new T.Vector2(1, 1) }, uHeightRange: { value: new T.Vector2(0, 100) } });
    u.uTime.value = 0; u.uAirDensity.value = 0; u.uViewportPx.value.set(256, 256);
    const camera = new T.PerspectiveCamera(50, 1, 1, 10000); camera.position.set(0, 10, 100); camera.lookAt(0, 10, 0); camera.updateMatrixWorld();
    camera.layers.enableAll();
    u.uCameraPos.value.copy(camera.position);
    const placed = { mesh: new Float32Array(), billboard: new Float32Array([0, 0, 0, 20, 10, 1, .5, 1]), stride: 8, count: 1 };
    const tree = createForest(T, placed, u, { forestDebug: true });
    const scene = new T.Scene(); scene.add(...tree.byBand.mid);
    const target = new T.WebGLRenderTarget(256, 256, { minFilter: T.NearestFilter, magFilter: T.NearestFilter });
    const pixels = new Uint8Array(256 * 256 * 4);
    const draw = () => { renderer.setRenderTarget(target); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels); return new Uint8Array(pixels); };
    const normal = draw(), alpha = Array.from(normal).filter((_, i) => i % 4 === 3);
    const partial = alpha.filter(a => a > 0 && a < 255).length;
    const size = tree.byBand.mid[0].geometry.getAttribute('iSize');
    size.setY(0, 5); size.needsUpdate = true;
    const narrow = draw(); size.setY(0, 10); size.needsUpdate = true; draw();
    let originalArea = 0, narrowArea = 0;
    for (let i = 3; i < normal.length; i += 4) { originalArea += normal[i]; narrowArea += narrow[i]; }
    const widthAreaRatio = narrowArea / originalArea;
    const standalone = createForest(T, placed, u, { partitioned: false, forestDebug: true });
    const standaloneScene = new T.Scene(); standaloneScene.add(...standalone.byBand.mid);
    renderer.setRenderTarget(target); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(standaloneScene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
    let standaloneDisagreement = 0;
    for (let i = 3; i < pixels.length; i += 4) if (Math.abs(normal[i] - 128) > 2 && pixels[i] !== (normal[i] >= 128 ? 255 : 0)) standaloneDisagreement++;
    standalone.dispose(); draw();
    let premultError = 0;
    for (let i = 0; i < normal.length; i += 4) premultError = Math.max(premultError, Math.abs(normal[i + 2] - normal[i + 3]), normal[i], normal[i + 1]);
    // The production copy writes premultiplied bytes into a premultiplied canvas.
    const copy = RangeScene.prototype._createCopy.call({ THREE: T }); copy.mesh.material.uniforms.uColor.value = target.texture;
    renderer.setRenderTarget(null); renderer.clear(); renderer.render(copy.scene, copy.camera);
    const stage = document.createElement('canvas'); stage.width = stage.height = 256;
    const ctx = stage.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 256, 256); ctx.drawImage(renderer.domElement, 0, 0);
    const composited = ctx.getImageData(0, 0, 256, 256).data;
    let compositeError = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const a = normal[((255 - y) * 256 + x) * 4 + 3], i = (y * 256 + x) * 4;
      compositeError = Math.max(compositeError, Math.abs(composited[i] - (255 - a)), Math.abs(composited[i + 2] - a));
    }
    const depthScene = new T.Scene(); depthScene.add(...tree.depth);
    renderer.setRenderTarget(target); renderer.clear(); renderer.render(depthScene, camera);
    // A white plane behind the tree reveals exactly where its depth cut kept pixels.
    const quad = new T.BufferGeometry(); quad.setAttribute('position', new T.Float32BufferAttribute([-100,-100,0,100,-100,0,100,100,0,-100,-100,0,100,100,0,-100,100,0], 3));
    const plane = new T.Mesh(quad, new T.ShaderMaterial({ vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }', fragmentShader: 'void main(){ gl_FragColor = vec4(1.); }' }));
    plane.position.set(0, 10, -1); const behind = new T.Scene(); behind.add(plane); renderer.render(behind, camera);
    renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
    let depthDisagreement = 0;
    for (let i = 0; i < pixels.length; i += 4) if (Math.abs(normal[i + 3] - 128) > 2 && (pixels[i] === 0) !== (normal[i + 3] >= 128)) depthDisagreement++;
    // Translate a crown narrower than one pixel across a pixel: its integral stays stable.
    const geo = tree.byBand.mid[0].geometry, pos = geo.getAttribute('iPos');
    camera.position.z = 3000; camera.lookAt(0, 10, 0); camera.updateMatrixWorld(); u.uCameraPos.value.copy(camera.position);
    const metrePerPixel = 6000 * Math.tan(25 * Math.PI / 180) / 256, sums = [];
    for (let k = 0; k < 16; k++) {
      pos.setX(0, k / 16 * metrePerPixel); pos.needsUpdate = true;
      const frame = draw(); let sum = 0; for (let i = 3; i < frame.length; i += 4) sum += frame[i]; sums.push(sum);
    }
    // Probe raster support around the two-pixel billboard expansion boundary.
    // A tall controlled crown isolates horizontal coverage from vertical sampling.
    const supportSweep = [];
    const variant = geo.getAttribute('iVar');
    for (const species of [0, 1, 2, 3]) for (const widthPx of [1.2, 1.8, 2, 2.2, 3, 4]) {
      size.setX(0, 1000); size.setY(0, widthPx * metrePerPixel); size.needsUpdate = true;
      variant.setX(0, species); variant.needsUpdate = true;
      const integral = [];
      for (let k = 0; k <= 16; k++) {
        pos.setX(0, k / 16 * metrePerPixel); pos.needsUpdate = true;
        const frame = draw(); let sum = 0;
        for (let i = 3; i < frame.length; i += 4) sum += frame[i];
        integral.push(sum);
      }
      supportSweep.push({ species, widthPx, integral,
        variation: (Math.max(...integral) - Math.min(...integral)) / (integral.reduce((a, b) => a + b) / integral.length) });
    }
    size.setX(0, 20); size.setY(0, 10); size.needsUpdate = true;
    variant.setX(0, 1); variant.needsUpdate = true;
    const shaded = createForest(T, placed, u), shadedScene = new T.Scene(); shadedScene.add(...shaded.byBand.mid);
    const shadedPos = shaded.byBand.mid[0].geometry.getAttribute('iPos'), shadedSums = [];
    u.uLightDir.value.set(1, .5, .2).normalize();
    for (let k = 0; k < 16; k++) {
      shadedPos.setX(0, k / 16 * metrePerPixel); shadedPos.needsUpdate = true;
      renderer.setRenderTarget(target); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(shadedScene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
      let sum = 0; for (let i = 0; i < pixels.length; i++) if (i % 4 !== 3) sum += pixels[i]; shadedSums.push(sum);
    }
    // Narrow crowns need mean shading; wider crowns still need integrated
    // edge coverage. These controlled widths isolate raster behaviour from
    // placement traits; the 28 m fixture projects to 19 px tall.
    const resolveSweep = [], sg = shaded.byBand.mid[0].geometry;
    const resolveSize = sg.getAttribute('iSize'), resolveVar = sg.getAttribute('iVar');
    camera.position.set(0, 400 / 300, 400); camera.lookAt(0, 400 / 300, 0); camera.updateMatrixWorld();
    u.uCameraPos.value.copy(camera.position);
    const resolveMetrePerPixel = metrePerPixel * 400 / 3000;
    for (const species of [0, 1, 2, 3]) for (const widthPx of [4, 8, 12, 20]) {
      resolveSize.setX(0, 28); resolveSize.setY(0, widthPx * resolveMetrePerPixel); resolveSize.needsUpdate = true;
      resolveVar.setX(0, species); resolveVar.needsUpdate = true;
      const luma = [], area = [];
      for (let k = 0; k <= 16; k++) {
        shadedPos.setX(0, k / 16 * resolveMetrePerPixel); shadedPos.needsUpdate = true;
        renderer.setRenderTarget(target); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(shadedScene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
        let a = 0, l = 0;
        for (let j = 0; j < pixels.length; j += 4) {
          a += pixels[j + 3]; l += .2126 * pixels[j] + .7152 * pixels[j + 1] + .0722 * pixels[j + 2];
        }
        area.push(a); luma.push(l);
      }
      const variationOf = values => (Math.max(...values) - Math.min(...values)) / (values.reduce((a, b) => a + b) / values.length);
      resolveSweep.push({ species, heightM: 28, widthPx, luma, area,
        lumaVariation: variationOf(luma), areaVariation: variationOf(area) });
    }
    camera.position.set(0, 10, 3000); camera.lookAt(0, 10, 0); camera.updateMatrixWorld(); u.uCameraPos.value.copy(camera.position);
    shaded.dispose();
    const pause = draw(), repeated = draw();
    pos.setX(0, 0); pos.needsUpdate = true; camera.position.z = 100; camera.lookAt(0, 10, 0); camera.updateMatrixWorld(); u.uCameraPos.value.copy(camera.position);
    const colour = new T.Scene(); colour.add(plane, ...tree.byBand.mid);
    const planeDepth = new T.Mesh(quad, plane.material.clone()); planeDepth.position.copy(plane.position); planeDepth.material.colorWrite = false;
    depthScene.add(planeDepth);
    const p = { view: {}, uniforms: u, forest: tree, depthScene, scenes: { far: new T.Scene(), mid: colour, near: new T.Scene() } };
    const production = Object.assign(Object.create(RangeScene.prototype), { THREE: T, camera, renderer, target, canvas: renderer.domElement,
      size: { width: 256, height: 256 }, prepared: new Map([['probe', p]]), depthCache: { A: { frame: -1 } }, stats: { depthPasses: 0 }, _copy: copy,
      _setCamera() {}, _setUniforms() {}, _prepareMirror() {}, _setCanvasSize() {} });
    // Two partitions in one frame expose stale combined-depth reuse as well.
    production.renderPartition({ frameId: 1, qualityLevel: 6 }, 'far', 'probe');
    production.renderPartition({ frameId: 1, qualityLevel: 6 }, 'mid', 'probe');
    const opaqueDepthPasses = production.stats.depthPasses;
    renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
    let terrainHoles = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) terrainHoles++;
    const travelDepth = new T.Scene(); travelDepth.add(planeDepth.clone(), ...tree.depthByBand.mid);
    p.depthScenes = { far: new T.Scene(), mid: travelDepth, near: new T.Scene() };
    production.renderPartition({ frameId: 2, qualityLevel: 6 }, 'mid', 'probe', { bandColumns: { near: [.25, .75] } });
    renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
    let travelHoles = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) travelHoles++;
    // Two overlapping soft crowns must accumulate coverage before their hard
    // depth twins occlude ink. A front alpha > .5 is not an opaque surface:
    // cutting the rear crown here exposes bright receiver colour and twinkles.
    const overlapTrees = createForest(T, { mesh: new Float32Array(), billboard: new Float32Array([
      0, 0, 0, 20, 10, 1, .5, 1, 0, 0, -2, 20, 10, 1, .5, 1,
    ]), stride: 8, count: 2 }, u, { forestDebug: true });
    plane.position.z = planeDepth.position.z = -10;
    const overlapColour = new T.Scene(); overlapColour.add(plane, ...overlapTrees.byBand.mid);
    const overlapDepth = new T.Scene(); overlapDepth.add(planeDepth, ...overlapTrees.depth);
    camera.layers.set(0); camera.layers.enable(1);
    renderer.setRenderTarget(target); renderer.setClearColor(0, 0); renderer.clear();
    renderer.render(overlapColour, camera); renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
    const accumulated = new Uint8Array(pixels);
    p.forest = overlapTrees; p.depthScene = overlapDepth; p.scenes.mid = overlapColour;
    const overlapTravel = new T.Scene(); overlapTravel.add(planeDepth.clone(), ...overlapTrees.depthByBand.mid);
    p.depthScenes.mid = overlapTravel;
    const overlapErrors = [];
    for (const travel of [false, true]) {
      production.renderPartition({ frameId: travel ? 4 : 3, qualityLevel: 6 }, 'mid', 'probe',
        travel ? { bandColumns: { near: [.25, .75] } } : {});
      renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
      let error = 0, brightPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        error = Math.max(error, Math.abs(pixels[i] - accumulated[i]));
        if (pixels[i] > accumulated[i] + 2) brightPixels++;
      }
      overlapErrors.push({ travel, error, brightPixels });
    }
    overlapTrees.dispose();
    // A post-forest light behind a crown must be cut by its hard depth;
    // moving that same light in front must remain fully visible.
    p.forest = tree; p.depthScene = depthScene; p.scenes.mid = colour;
    const light = new T.Mesh(quad, new T.ShaderMaterial({ depthWrite: false,
      vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: 'void main(){ gl_FragColor = vec4(1.,0.,0.,1.); }' }));
    light.layers.set(3); light.position.set(0,10,-.5); colour.add(light);
    p.actors = { groups: { light } };
    const actorOcclusion = [];
    for (const inFront of [false,true]) {
      light.position.z = inFront ? 1 : -.5;
      production.renderPartition({ frameId: inFront ? 6 : 5, qualityLevel: 6 }, 'mid', 'probe');
      renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
      let checked = 0, error = 0;
      for (let i = 0; i < pixels.length; i += 4) if (normal[i+3] > 200) {
        checked++; error = Math.max(error, Math.abs(pixels[i] - (inFront ? 255 : 0)));
      }
      actorOcclusion.push({ inFront, checked, error });
    }
    // Combined depth cannot be reused as opaque depth, even in the same frame.
    light.position.z = -.5;
    const postDepthReuse = [];
    for (const consumer of ['actor', 'ink']) {
      p.actors = consumer === 'actor' ? { groups: { light } } : null;
      u.uNarrativeInk.value = consumer === 'ink' ? 1 : 0;
      const frame = { frameId: consumer === 'actor' ? 7 : 8, qualityLevel: 6 };
      production.renderPartition(frame, 'mid', 'probe');
      renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
      const first = pixels.slice();
      production.renderPartition(frame, 'far', 'probe');
      production.renderPartition(frame, 'mid', 'probe');
      renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
      let error = 0; for (let i = 0; i < pixels.length; i++) error = Math.max(error, Math.abs(pixels[i]-first[i]));
      postDepthReuse.push({ consumer, error });
    }
    u.uNarrativeInk.value = 0;
    colour.remove(light); light.material.dispose(); p.actors = null;
    // Isolate the shared production floor colour helper. The complete far
    // terrain, rock blend and ring handoff are tested by far-forest-smoke.
    const terrainMat = new T.ShaderMaterial({ glslVersion: T.GLSL3, depthTest: false, depthWrite: false,
      vertexShader: 'void main(){ gl_Position = vec4(position.xy / 100., 0., 1.); }',
      fragmentShader: `precision highp float; out vec4 outColor; ${FAR_FOREST_GLSL} void main(){
        vec3 pForestNear=vec3(.2,.3,.1),pForestFar=pForestNear,ground=vec3(.8,.7,.4),albedo;
        float dist=6000., forest=gl_FragCoord.x<160.?1.:gl_FragCoord.x<224.?.7:0.;
        vec4 cn=vec4(0.,0.,gl_FragCoord.x>=80.&&gl_FragCoord.x<160.?1.:0.,.5);
        albedo=forest>0.?mix(forestUnderstory(pForestNear,ground),pForestNear,cn.b):ground;
        outColor=vec4(albedo,1.); }` });
    const terrainScene = new T.Scene(); terrainScene.add(new T.Mesh(quad, terrainMat));
    renderer.setRenderTarget(target); renderer.clear(); renderer.render(terrainScene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
    const terrainAlbedo = [40, 120, 240].map(x => Array.from(pixels.slice((128 * 256 + x) * 4, (128 * 256 + x) * 4 + 3)));
    const mixedForestGap = Array.from(pixels.slice((128 * 256 + 200) * 4, (128 * 256 + 200) * 4 + 3));
    const profileMat = new T.ShaderMaterial({ glslVersion: T.GLSL3, depthTest: false, depthWrite: false,
      vertexShader: 'void main(){ gl_Position = vec4(position.xy / 100., 0., 1.); }',
      fragmentShader: `precision highp float; out vec4 outColor; ${CROWN_GLSL}
      void main(){ float y = floor(gl_FragCoord.y), species = floor(y / 64.);
        float side = mod(floor(y / 32.), 2.) < .5 ? -1. : 1., id = mod(y, 32.) / 31.;
        float hw = crownHalfWidth(species, (gl_FragCoord.x - .5) / 255., id, side);
        float q = floor(hw * 65535. + .5); outColor = vec4(floor(q / 256.), mod(q,256.), 0., 255.) / 255.; }` });
    const profileScene = new T.Scene(); profileScene.add(new T.Mesh(quad, profileMat));
    renderer.setRenderTarget(target); renderer.clear(); renderer.render(profileScene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
    return { partial, widthAreaRatio, premultError, compositeError, depthDisagreement, standaloneDisagreement, opaqueDepthPasses, terrainHoles, travelHoles, overlapErrors, actorOcclusion, postDepthReuse, terrainAlbedo, mixedForestGap, sums, shadedSums, supportSweep, resolveSweep,
      profileBytes: Array.from(pixels), pauseParity: pause.every((v, i) => v === repeated[i]), png: stage.toDataURL('image/png').split(',')[1] };
  });
  await fs.writeFile(path.join(output, 'composite.png'), Buffer.from(report.png, 'base64')); delete report.png;
  assert.ok(report.partial > 30, `No soft coverage edges: ${report.partial}`);
  assert.ok(report.widthAreaRatio > .45 && report.widthAreaRatio < .55, `placed crown width must set the silhouette scale: ${report.widthAreaRatio}`);
  assert.ok(report.premultError <= 1, `RGB must be premultiplied: ${report.premultError}`);
  assert.ok(report.compositeError <= 2, `Partition copy/Canvas fringe: ${report.compositeError}`);
  assert.equal(report.depthDisagreement, 0, 'colour/depth coverage disagree');
  assert.equal(report.standaloneDisagreement, 0, 'standalone forest retains the 0.5 alpha test');
  assert.equal(report.terrainHoles, 0, 'soft tree coverage must not punch holes through opaque ground');
  assert.equal(report.travelHoles, 0, 'travel depth stages must preserve the receiver colour');
  assert.equal(report.opaqueDepthPasses, 1, 'opaque-only depth survives the preceding partition when no post-forest consumer exists');
  for (const result of report.postDepthReuse) assert.equal(result.error, 0, `combined depth invalidation for ${result.consumer}`);
  for (const result of report.actorOcclusion) assert.ok(result.checked > 0 && result.error <= 2, `post-forest actor occlusion ${JSON.stringify(result)}`);
  for (const result of report.overlapErrors) assert.ok(result.error <= 2,
    `hard tree depth erased rear soft coverage: ${JSON.stringify(result)}`);
  const [gap, crown, bare] = report.terrainAlbedo;
  for (let k = 0; k < 3; k++) {
    assert.ok(gap[k] >= .4 * crown[k] - 1 && gap[k] <= .55 * crown[k] + 1, `understory is bright ground: ${JSON.stringify(report.terrainAlbedo)}`);
    assert.ok(Math.abs(bare[k] - [204, 179, 102][k]) <= 1, 'forest colour must respect the original forest mask');
    assert.ok(Math.abs(crown[k] - [51, 77, 26][k]) <= 1, 'canopy crown albedo must stay unchanged');
    assert.ok(report.mixedForestGap[k] <= crown[k] + 1, `partial forest retains bright meadow: ${report.mixedForestGap}`);
  }
  for (const sample of report.supportSweep) assert.ok(sample.variation < .02,
    `billboard raster support clips species ${sample.species} at ${sample.widthPx}px: ${sample.variation}`);
  for (const sample of report.resolveSweep) {
    assert.ok(sample.lumaVariation < .0065 && sample.areaVariation < (sample.widthPx === 4 ? .0065 : .01),
      `${sample.widthPx}-pixel crown twinkles for species ${sample.species}: luma ${sample.lumaVariation}, area ${sample.areaVariation}`);
  }
  assert.ok(Math.min(...report.sums) > 0, 'sub-pixel crown disappears between pixel centres');
  const variation = (Math.max(...report.sums) - Math.min(...report.sums)) / (report.sums.reduce((a, b) => a + b) / report.sums.length);
  assert.ok(variation < .1, `sub-pixel coverage varies ${variation}`);
  const shadedVariation = (Math.max(...report.shadedSums) - Math.min(...report.shadedSums)) / (report.shadedSums.reduce((a, b) => a + b) / report.shadedSums.length);
  report.shadedVariation = shadedVariation;
  assert.ok(shadedVariation < .1, `unresolved normal lighting twinkles ${shadedVariation}`);
  assert.equal(report.pauseParity, true); assert.deepEqual(errors, []);
  let profileMaxError = 0;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4, actual = (report.profileBytes[i] * 256 + report.profileBytes[i + 1]) / 65535;
    const expected = crownHalfWidth(Math.floor(y / 64), x / 255, (y % 32) / 31, Math.floor(y / 32) % 2 ? 1 : -1);
    profileMaxError = Math.max(profileMaxError, Math.abs(actual - expected));
  }
  delete report.profileBytes; report.profileMaxError = profileMaxError;
  assert.ok(profileMaxError <= 2 / 65535, `JS/GPU crown parity error ${profileMaxError}`);
  console.log(JSON.stringify({ ...report, variation, errors }));
} catch (e) { report = { ...report, failure: e.stack }; throw e; }
finally { await browser.close(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, errors }, null, 2)); }
