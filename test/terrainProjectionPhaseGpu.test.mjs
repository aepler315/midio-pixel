import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();

test('direct pixel camera pan advances two visible cliff edges without reversing the distant one', {
  skip: !existsSync(executablePath) && 'Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH', timeout: 30000,
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Layered terrain pan</title>' });
      if (!pathname.startsWith('/src/')) return route.fulfill({ status: 204 });
      return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL('..'+pathname,import.meta.url)) });
    });
    await page.goto('http://terrain-pan.test/');
    const traces = await page.evaluate(async () => {
      const T = await import('/src/vendor/range/three-range.module.js');
      const { RangeScene } = await import('/src/world/alpine/RangeScene.js');
      const { PresentingRenderer } = await import('/src/render/PresentingRenderer.js');
      const { GraphicsResidency } = await import('/src/render/GraphicsResidency.js');
      const out = document.createElement('canvas');
      out.width = 320; out.height = 176;
      const margin = 32, stage = { width: out.width+2*margin, height: out.height+2*margin };
      const width = stage.width/4, height = stage.height/4;
      const viewport = { logicalWidth: stage.width, logicalHeight: stage.height, overscanPx: margin };
      const ctx = out.getContext('2d',{willReadFrequently:true});
      const presentation = { cinematicPixel:true, scaling:'fit', freePixelMotion:true };
      const presenter = Object.assign(Object.create(PresentingRenderer.prototype), { canvas:out,
        output:{ presentation, grid:{ width:out.width/4, height:out.height/4 }, residency:new GraphicsResidency() } });
      const renderer = new T.WebGLRenderer({ alpha:true, antialias:false, preserveDrawingBuffer:true });
      renderer.setSize(width,height,false);
      renderer.autoClear = false;
      const camera = new T.PerspectiveCamera(45,stage.width/stage.height,.1,2000);
      const reference = { eyeStartM:[0,0,0], targetStartM:[4,0,-200] };
      function cliff(x,z,top,color) {
        const corners = [-1000,-800,z,x,-800,z,-1000,top,z, -1000,top,z,x,-800,z,x,top,z];
        const geometry = new T.BufferGeometry();
        geometry.setAttribute('position',new T.BufferAttribute(new Float32Array(corners),3));
        const scene = new T.Scene();
        scene.add(new T.Mesh(geometry,new T.MeshBasicMaterial({color})));
        return scene;
      }
      const far = cliff(45,-600,800,0xff0000), near = cliff(4,-200,0,0x00ff00);
      far.background = new T.Color(0x0000ff);
      const prepared = { view:{camera:reference}, depthScene:new T.Scene(), scenes:{far,near},
        uniforms:{uNarrativeInk:{value:0},uBackdropAmount:{value:0},uDiag:{value:0}} };
      const range = Object.assign(Object.create(RangeScene.prototype), {
        THREE:T, renderer, canvas:renderer.domElement, camera, size:{width,height}, stats:{depthPasses:0,partitions:0},
        prepared:new Map([['cliffs',prepared]]), depthCache:{A:{frame:-1}}, directTerrainMode:true, pixelated:true,
        _setCamera:()=>{camera.updateProjectionMatrix();camera.updateMatrixWorld(true);},
        _setUniforms(){}, _prepareMirror(){}, _updateForestDetail(){}, _shaftSource(){return null;},
      });
      range._copy=range._createCopy();
      range.target=range._scenicTarget(width,height);
      function edge(y,channel) {
        const row = ctx.getImageData(0,y,out.width,1).data;
        let last = -1;
        for (let x=0;x<out.width;x++) {
          if (row[4*x+3]!==255) throw new Error('The shifted layers exposed the output boundary');
          if (row[4*x+channel]>230) last=x;
        }
        return last;
      }
      const traces=[];
      for (const cropped of [false,true]) for (const yaw of [false,true]) for (const free of [false,true]) {
        const rows=[];
        if (cropped) camera.setViewOffset(480,290,31,21,stage.width,stage.height);
        else camera.clearViewOffset();
        camera.updateProjectionMatrix();
        const quarterCell=.25/(width*.5*camera.projectionMatrix.elements[0]);
        for (let i=0;i<25;i++) {
          camera.position.set(yaw?0:i*.48,0,0);
          camera.rotation.set(0,yaw?-i*quarterCell:0,0);
          range.freePixelMotion=free;
          presentation.freePixelMotion=free;
          ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,out.width,out.height);
          ctx.translate(-margin,-margin);
          const frame={frameId:i+1,qualityLevel:2,scenicViewport:viewport};
          for (const pass of ['far','near']) {
            const image=range.renderPartition(frame,pass,'cliffs',{pixelPhase:free});
            const phase=range.partitionPixelOffset;
            ctx.save();
            if (phase) ctx.translate(phase.x*stage.width,phase.y*stage.height);
            presenter._drawDirectTerrain(ctx,image,stage,{width,height},2);
            ctx.restore();
          }
          rows.push([edge(30,0),edge(142,1)]);
        }
        traces.push({cropped,yaw,free,rows});
      }
      range.target.dispose(); presenter._releaseDirect(); renderer.dispose();
      return traces;
    });
    for (const trace of traces) for (const band of [0,1]) {
      const values=trace.rows.map(row=>row[band]), steps=values.slice(1).map((x,i)=>x-values[i]);
      const label=JSON.stringify([trace.cropped,trace.yaw,trace.free,band]);
      assert.ok(values.every(x=>x>0 && x<319) && values.at(-1)<values[0],label);
      assert.ok(steps.every(step=>step<=0),`edge reversed: ${label} ${values}`);
      if (trace.yaw) {
        const largest = Math.max(...steps.map(Math.abs));
        assert.ok(trace.free ? largest<=2 : largest>=3,`yaw step ${largest}: ${label}`);
      }
    }
  } finally { await browser.close(); }
});
