// Execute the placement hash and trait twin in WebGL2, including signed
// cells and wrapping salts. Evidence belongs in the caller's ignored folder.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { hash2, treeTraits } from '../src/world/alpine/ForestCover.js';
const [url = 'http://127.0.0.1:8094', out = '.smoke/forest-parity'] = process.argv.slice(2);
await fs.mkdir(out, { recursive: false });
const errors = [], browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let report = { passed: false };
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(url + '/', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto(url);
  const result = await page.evaluate(async () => {
    const T = await import('/src/vendor/range/three-range.module.js');
    const F = await import('/src/world/alpine/ForestCover.js');
    if (!F.FOREST_HASH_GLSL || !F.FOREST_TRAITS_GLSL) throw new Error('Phase 5 GLSL hash/traits twin is missing');
    const renderer = new T.WebGLRenderer({ antialias: false });
    renderer.setSize(64,64); renderer.outputColorSpace = T.LinearSRGBColorSpace;
    const target = new T.WebGLRenderTarget(64,64), camera = new T.PerspectiveCamera(50,1,1,100000), scene = new T.Scene();
    const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
    const u = { seed: { value: 0 }, mode: { value: 0 }, rules: { value: new T.Vector4(2700,1,1e9,0) } };
    const mat = new T.ShaderMaterial({ glslVersion: T.GLSL3, uniforms: u, depthTest: false,
      vertexShader: 'void main(){gl_Position=vec4(position,1.);}',
      fragmentShader: `precision highp float; precision highp int; uniform uint seed; uniform int mode; uniform vec4 rules; out vec4 outColor;
        ${F.FOREST_HASH_GLSL}\n${F.FOREST_TRAITS_GLSL}
        void main(){ int i=int(gl_FragCoord.x)+64*int(gl_FragCoord.y); ivec2 cell=ivec2(i%257-128,i/257-8);
          uint bits;
          if(mode==0){ ivec2 hcell=ivec2(i%2==0 ? cell.x : (-2147483647+cell.x), cell.y); bits=hash2u(hcell.x,hcell.y,seed); }
          else { float y=rules.x-float((i%6)*250-50), slope=float((i%4)*12);
            ForestTraits t=forestTreeTraits(cell,seed,y,slope,rules.x,rules.y,rules.z);
            float value= mode==1?t.root.x:mode==2?t.root.y:mode==3?t.height:mode==4?t.width:mode==5?t.species:t.id;
            bits=floatBitsToUint(value); }
          outColor=vec4(float(bits&255u),float((bits>>8u)&255u),float((bits>>16u)&255u),float(bits>>24u))/255.; }` });
    const mesh=new T.Mesh(geo,mat);mesh.frustumCulled=false;scene.add(mesh);
    const runs=[];
    for(const config of [{seed:0,scale:1,cap:1e9},{seed:315,scale:1,cap:35},{seed:0xffffffff,scale:3,cap:35},{seed:0x80000000,scale:.3,cap:1e9}]) {
      u.seed.value=config.seed; u.rules.value.set(2700,config.scale,config.cap,0);
      const outputs=[];
      for(let mode=0;mode<=6;mode++) {u.mode.value=mode;renderer.setRenderTarget(target);renderer.render(scene,camera);
        const bytes=new Uint8Array(64*64*4);renderer.readRenderTargetPixels(target,0,0,64,64,bytes); outputs.push(Array.from(bytes));}
      runs.push({...config,outputs});
    }
    mat.dispose();geo.dispose();target.dispose();renderer.dispose();return runs;
  });
  assert.deepEqual(errors, []);
  const decode = (bytes,i,float=false) => { const b=Uint8Array.from(bytes.slice(i*4,i*4+4)); return new DataView(b.buffer)[float?'getFloat32':'getUint32'](0,true); };
  let maximumTraitError=0, hashCases=0, traitCases=0;
  for(const r of result) for(let i=0;i<4096;i++) {
    const ix=i%257-128, iz=Math.floor(i/257)-8;
    assert.equal(decode(r.outputs[0],i),hash2(i%2===0?ix:-2147483647+ix,iz,r.seed),`hash ${r.seed} ${i}`); hashCases++;
    const rules={treelineM:2700,treeScale:r.scale}, t=treeTraits(ix,iz,r.seed,2700-(i%6*250-50),i%4*12,rules,{tour:r.cap===35?{}:null});
    for(const [j,name] of ['x','z','height','width','species','id'].entries()) {
      const actual=decode(r.outputs[j+1],i,true), error=Math.abs(actual-t[name]);
      assert.ok(Number.isFinite(actual)&&error<=1e-3,`trait ${name} seed ${r.seed} cell ${ix},${iz}: GPU ${actual}, JS ${t[name]}`);
      maximumTraitError=Math.max(maximumTraitError,error);
    } traitCases++;
  }
  report={passed:true,hashCases,traitCases,maximumTraitError,errors};console.log(JSON.stringify(report));
} finally { await fs.writeFile(path.join(out,'report.json'),JSON.stringify({...report,errors},null,2));await browser.close(); }
