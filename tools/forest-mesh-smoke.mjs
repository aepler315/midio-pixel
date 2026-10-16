// Production near shaders, geometric/fringe coverage, depth agreement and heard-time gusts.
// Captures stay in the new output directory; never add them to git.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const [url = 'http://127.0.0.1:8094', output = '.smoke/forest-mesh'] = process.argv.slice(2);
await fs.mkdir(output);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
let report = { cases: [] };
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(url + '/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto(url);
  const result = await page.evaluate(async () => {
    const T = await import('/src/vendor/range/three-range.module.js');
    const { createForest } = await import('/src/world/alpine/ForestGL.js');
    const { sceneUniforms } = await import('/src/world/alpine/TerrainMaterial.js');
    const { RangeScene } = await import('/src/world/alpine/RangeScene.js');
    const W = 512, renderer = new T.WebGLRenderer({ alpha: true, premultipliedAlpha: true, antialias: false });
    renderer.setSize(W, W); renderer.autoClear = false; renderer.outputColorSpace = T.LinearSRGBColorSpace;
    const receiver = new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); receiver.needsUpdate = true;
    const u = sceneUniforms(T, { uReceiver: { value: receiver }, uGridOrigin: { value: new T.Vector2(-100, -100) },
      uGridExtent: { value: new T.Vector2(200, 200) }, uTexel: { value: new T.Vector2(1, 1) }, uHeightRange: { value: new T.Vector2(0, 100) } });
    u.uTime.value = 0; u.uAirDensity.value = 0; u.uViewportPx.value.set(W, W);
    u.pForestNear.value.setRGB(.045, .085, .035); u.pForestFar.value.setRGB(.06, .09, .045);
    u.uLightColor.value.setRGB(.85, .75, .6); u.uLightDir.value.set(.5, .8, .3).normalize();
    u.uAmbientScale.value = 1; u.uExposure.value = 1.5;
    const camera = new T.PerspectiveCamera(50, 1, 1, 10000); camera.layers.enableAll();
    const target = new T.WebGLRenderTarget(W, W, { minFilter: T.NearestFilter, magFilter: T.NearestFilter });
    const colour = new T.Scene(), depth = new T.Scene(), pixels = new Uint8Array(W * W * 4), images = [];
    const png = (bytes, name) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = W;
      const ctx = canvas.getContext('2d'), data = ctx.createImageData(W, W);
      for (let y = 0; y < W; y++) data.data.set(bytes.subarray((W - y - 1) * W * 4, (W - y) * W * 4), y * W * 4);
      ctx.putImageData(data, 0, 0); images.push({ name, png: canvas.toDataURL('image/png').split(',')[1] });
    };
    const draw = scene => {
      renderer.setRenderTarget(target); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, W, W, pixels); return new Uint8Array(pixels);
    };
    const aim = top => { camera.position.set(top ? 24 : 0, top ? 65 : 12, top ? 24 : 60); camera.lookAt(0, 10, 0); camera.updateMatrixWorld(); u.uCameraPos.value.copy(camera.position); };
    const cases = [];
    // Same object transforms, opposite instance depths: renderer object sorting
    // cannot protect a near solid mesh from a later, farther instance lane.
    const row = z => new Float32Array([0, 0, z, 20, 7.6, 1, .53, 1]);
    const frontTree = createForest(T, { meshDetail: row(0), mesh: new Float32Array(), billboard: new Float32Array(), stride: 8, count: 1 }, u, { forestDebug: true });
    const backTree = createForest(T, { meshDetail: new Float32Array(), mesh: row(-20), billboard: new Float32Array(), stride: 8, count: 1 }, u, { forestDebug: true });
    for (const mesh of backTree.byBand.mid) mesh.material.fragmentShader = mesh.material.fragmentShader.replace('color = vec3(1.0, 0.0, 0.0);', 'color = vec3(0.0, 0.0, 1.0);');
    aim(false); const fScene = new T.Scene(); fScene.add(...frontTree.byBand.mid);
    const bScene = new T.Scene(); bScene.add(...backTree.byBand.mid);
    const fPixels = draw(fScene), bPixels = draw(bScene);
    // "Solid" is the front crown's core layer: fragments the pipeline itself
    // treats as opaque. Overlapping soft spray edges can also sum to full
    // alpha; those composite unsorted by design and are not this probe's.
    camera.layers.set(0); const fCore = draw(fScene); camera.layers.enableAll();
    const overlapColour = new T.Scene(); overlapColour.add(...frontTree.byBand.mid, ...backTree.byBand.mid);
    const overlapDepth = new T.Scene(); overlapDepth.add(...frontTree.depth, ...backTree.depth);
    const overlapCopy = RangeScene.prototype._createCopy.call({ THREE: T });
    const overlapPrepared = { view: {}, uniforms: u, forest: { counts: { meshDetail: 1, mesh: 1, billboard: 0 } }, depthScene: overlapDepth,
      scenes: { far: new T.Scene(), mid: overlapColour, near: new T.Scene() } };
    const overlapProduction = Object.assign(Object.create(RangeScene.prototype), { renderer, camera, target, canvas: renderer.domElement,
      size: { width: W, height: W }, prepared: new Map([['probe', overlapPrepared]]), depthCache: { A: { frame: -1 } }, stats: { depthPasses: 0 }, _copy: overlapCopy,
      _setCamera() {}, _setUniforms() {}, _prepareMirror() {}, _setCanvasSize() {} });
    overlapProduction.renderPartition({ frameId: 1, qualityLevel: 6 }, 'mid', 'probe');
    renderer.readRenderTargetPixels(target, 0, 0, W, W, pixels);
    let solidOverlapChecked = 0, solidOverlapError = 0; const overlapFailures = [];
    for (let i = 0; i < pixels.length; i += 4) if (fCore[i + 3] === 255 && bPixels[i + 3] === 255) {
      solidOverlapChecked++; if (pixels[i] < 253 || pixels[i + 2] > 2) {
        solidOverlapError++; if (overlapFailures.length < 10) overlapFailures.push({ x: (i / 4) % W, y: Math.floor(i / 4 / W), front: [...fPixels.subarray(i, i + 4)], actual: [...pixels.subarray(i, i + 4)] });
      }
    }
    png(pixels, 'solid-overlap.png');
    frontTree.dispose(); backTree.dispose(); overlapCopy.mesh.geometry.dispose(); overlapCopy.mesh.material.dispose(); camera.layers.enableAll();
    for (const lod of [0, 1]) for (let species = 0; species < 4; species++) {
      const row = new Float32Array([0, 0, 0, 20, [6, 7.6, 5.3, 8.5][species], species, .53, 1]);
      const placed = { meshDetail: lod === 0 ? row : new Float32Array(), mesh: lod === 1 ? row : new Float32Array(), billboard: new Float32Array(), stride: 8, count: 1 };
      const tree = createForest(T, placed, u, { forestDebug: true });
      if (!tree.byBand.mid.length || !tree.byBand.mid[0].geometry.attributes.aBranch) throw new Error('near LOD/branch contract unavailable');
      colour.add(...tree.byBand.mid); depth.add(...tree.depth);
      aim(false); const front = draw(colour); png(front, `lod${lod}-species${species}-front.png`);
      let partial = 0, occupied = 0, premultError = 0;
      for (let i = 0; i < front.length; i += 4) {
        if (front[i + 3]) occupied++;
        if (front[i + 3] > 0 && front[i + 3] < 255) partial++;
        premultError = Math.max(premultError, Math.abs(front[i] - front[i + 3]), front[i + 1], front[i + 2]);
      }
      const repeated = draw(colour), pauseParity = front.every((v, i) => v === repeated[i]);
      aim(true); const top = draw(colour); png(top, `lod${lod}-species${species}-above.png`);
      const mesh = tree.byBand.mid.find(m => m.layers.mask === 2);
      for (const m of tree.byBand.mid) { delete m.material.defines.FOREST_DEBUG; m.material.needsUpdate = true; }
      png(draw(colour), `lod${lod}-species${species}-above-shaded.png`);
      aim(false); png(draw(colour), `lod${lod}-species${species}-front-shaded.png`);
      aim(false);
      // Opaque standalone colour and the depth twin both cut individual fragments at .5.
      const standalone = createForest(T, placed, u, { partitioned: false, forestDebug: true });
      const standScene = new T.Scene(); standScene.add(...standalone.byBand.mid);
      const opaque = draw(standScene);
      const planeGeo = new T.BufferGeometry();
      planeGeo.setAttribute('position', new T.Float32BufferAttribute([-50, -50, 0, 50, -50, 0, 50, 50, 0, -50, -50, 0, 50, 50, 0, -50, 50, 0], 3));
      const planeMat = new T.ShaderMaterial({ vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
        fragmentShader: 'void main(){gl_FragColor=vec4(1.);}' });
      const plane = new T.Mesh(planeGeo, planeMat); plane.position.set(0, 10, -20);
      const maskScene = new T.Scene(); maskScene.add(plane);
      renderer.setRenderTarget(target); renderer.clear(); renderer.render(depth, camera); renderer.render(maskScene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, W, W, pixels);
      let depthDisagreement = 0;
      for (let i = 0; i < pixels.length; i += 4) if ((opaque[i + 3] > 0) !== (pixels[i] === 0)) depthDisagreement++;
      // Mesh-only forest through the production partition pipeline, including combined depth for ink.
      const groundDepth = plane.clone(); groundDepth.material = planeMat.clone(); groundDepth.material.colorWrite = false;
      colour.add(plane); depth.add(groundDepth);
      const copy = RangeScene.prototype._createCopy.call({ THREE: T });
      const p = { view: {}, uniforms: u, forest: tree, depthScene: depth, scenes: { far: new T.Scene(), mid: colour, near: new T.Scene() } };
      const production = Object.assign(Object.create(RangeScene.prototype), { renderer, camera, target, canvas: renderer.domElement,
        size: { width: W, height: W }, prepared: new Map([['probe', p]]), depthCache: { A: { frame: -1 } }, stats: { depthPasses: 0 }, _copy: copy,
        _setCamera() {}, _setUniforms() {}, _prepareMirror() {}, _setCanvasSize() {} });
      u.uNarrativeInk.value = .02;
      production.renderPartition({ frameId: 1, qualityLevel: 6 }, 'mid', 'probe');
      renderer.readRenderTargetPixels(target, 0, 0, W, W, pixels);
      let terrainHoles = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) terrainHoles++;
      u.uNarrativeInk.value = 0; camera.layers.enableAll(); colour.remove(plane); depth.remove(groundDepth);
      const gust = [], times = [];
      if (lod === 0 && species === 2) {
        for (let i = 0; i <= 48; i++) {
          u.uTime.value = i / 24; tree.uniforms.uGustAge.value[0] = 2.4 + i / 24; tree.uniforms.uGustAmp.value[0] = 1; tree.uniforms.uGustDir.value[0] = 1;
          const frame = draw(colour); let sum = 0, weighted = 0;
          for (let k = 3; k < frame.length; k += 4) { sum += frame[k]; weighted += frame[k] * ((k >>> 2) % W); }
          gust.push(weighted / sum); times.push(i / 24); png(frame, `gust-${String(i).padStart(3, '0')}.png`);
        }
        tree.uniforms.uGustAmp.value[0] = 0; u.uTime.value = 0;
      }
      // Thinned trees collapse in both passes, including geometry LOD0.
      tree.uniforms.uForestKeep.value = .4; const hidden = draw(colour); tree.uniforms.uForestKeep.value = 1;
      const hiddenPixels = Array.from(hidden).filter((v, i) => i % 4 === 3 && v).length;
      cases.push({ lod, species, triangles: mesh.geometry.index.count / 3, occupied, partial, premultError, pauseParity,
        depthDisagreement, terrainHoles, hiddenPixels, gust, times });
      colour.remove(...tree.byBand.mid); depth.remove(...tree.depth); tree.dispose(); standalone.dispose();
      copy.mesh.geometry.dispose(); copy.mesh.material.dispose(); planeGeo.dispose(); planeMat.dispose(); groundDepth.material.dispose();
    }
    target.dispose(); receiver.dispose(); renderer.dispose(); return { cases, images, solidOverlapChecked, solidOverlapError, overlapFailures };
  });
  report = { cases: result.cases, solidOverlapChecked: result.solidOverlapChecked, solidOverlapError: result.solidOverlapError, overlapFailures: result.overlapFailures };
  for (const img of result.images) await fs.writeFile(path.join(output, img.name), Buffer.from(img.png, 'base64'));
  const panels = result.cases.map(r => `<h2>LOD${r.lod} species ${r.species}</h2><img src="lod${r.lod}-species${r.species}-front-shaded.png"><img src="lod${r.lod}-species${r.species}-above-shaded.png">`).join('\n');
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Near forest probe</title><style>body{background:#222;color:#ddd;font:16px sans-serif}img{background:#33443b;width:384px}</style><h1>Controlled near conifers</h1><p>Two mesh LODs, four species. This supplement does not replace the approved tour crops.</p>${panels}`);
  for (const r of report.cases) {
    assert.ok(r.occupied > 100 && r.partial > 0, `missing near tree/coverage: ${JSON.stringify(r)}`);
    // Branch-spray assets (ForestSpeciesAssets): same budgets as test/range-forest-assets.
    assert.ok(r.triangles <= (r.lod === 0 ? 2400 : 360), `LOD${r.lod} triangles ${r.triangles}`);
    assert.ok(r.premultError <= 2); assert.equal(r.pauseParity, true);
    assert.equal(r.depthDisagreement, 0); assert.equal(r.terrainHoles, 0); assert.equal(r.hiddenPixels, 0);
    if (r.gust.length) assert.ok(Math.max(...r.gust) - Math.min(...r.gust) > .5, 'heard-time gust does not lean near crowns');
  }
  assert.ok(report.solidOverlapChecked > 100, 'solid overlap probe must intersect both crowns');
  assert.equal(report.solidOverlapError, 0, 'a farther mesh lane overpainted a nearer solid crown');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...report, errors }));
} catch (error) { report.failure = error.stack; throw error; }
finally { await browser.close(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, errors }, null, 2)); }
