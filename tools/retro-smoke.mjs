// Pixel presentation through real title controls, playback, export and reload.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { seedBrowserConstruction, installSeedReceiver } from './lib/landscape-browser.mjs';
import { verifyPixelRaster } from './lib/pixel-raster.mjs';
import { snapshotSource } from './lib/visual-evaluation-server.mjs';
import { inspectPixelFrame, assertMeaningfulFrame, assertTemporalChange } from './lib/pixel-evidence.mjs';

const out = path.resolve(process.env.RETRO_OUT || '.smoke/retro');
await fs.mkdir(out,{recursive:true});
const wav = path.join(out,'contrast.wav');
execFileSync(process.execPath,['tools/gen-pilot-wav.mjs',wav,'16']);
const server = spawn(process.execPath,['tools/serve.js','8089'],{stdio:'ignore'});
let browser;
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),seed:315,
  source:(await snapshotSource(process.cwd())).digest,fixture:'gen-pilot-wav/16s',audioSha256:createHash('sha256').update(await fs.readFile(wav)).digest('hex'),frames:[],errors:[],status:'failed'};
// A bounded browser job must fail if a driver blocks a page evaluation.
// The v2 export cases alone take 6-10 minutes on SwiftShader runners (31-56 s
// each); the bound stays under the 30-minute job so report.json is written.
const watchdog=setTimeout(async()=>{
  report.error='Pixel smoke exceeded 24 minutes';console.error(report.error);
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));server.kill();
  setTimeout(()=>process.exit(1),3000);await browser?.close();process.exit(1);
},24*60*1000);
async function settings(page, values) {
  for(const [key,value] of Object.entries(values)) await page.selectOption(`#display-${key}`,String(value));
}
async function captureTitle(page,backend,tag) {
      const title=await page.evaluate(()=>{
        const c=document.querySelector('#stage'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        const colors=new Set();let lit=0,sum=0,opaque=true;
        for(let i=0;i<p.length;i+=4){colors.add(`${p[i]},${p[i+1]},${p[i+2]}`);const v=p[i]+p[i+1]+p[i+2];sum+=v;if(v>24)lit++;if(p[i+3]!==255)opaque=false;}
        return {width:c.width,height:c.height,colors:colors.size,litFraction:lit/(p.length/4),mean:sum/(p.length/4*3),opaque,png:c.toDataURL('image/png').split(',')[1]};
      });
      assertMeaningfulFrame(title,{requireOpaque:false});await fs.writeFile(path.join(out,`${backend}-title-${tag}.png`),Buffer.from(title.png,'base64'));delete title.png;
      report.frames.push({kind:'title',content:title,requestedRangeBackend:backend,backend:'title-canvas-2d',look:tag,requested:await page.evaluate(()=>window.__SMW.displayPrefs),diagnostics:await page.evaluate(()=>window.__SMW.presentationDiagnostics),dpr:1});
}

try {
  for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:8089')).ok)break;}catch{/* startup */}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH,headless:true,args:['--in-process-gpu','--ignore-gpu-blocklist']});
  report.browser=browser.version();
  report.raster=await verifyPixelRaster(browser,{url:'http://127.0.0.1:8089',out:path.join(out,'raster')});
  const backends=(process.env.RETRO_BACKENDS||'v2,legacy').split(',');
  assert.ok(backends.length&&backends.every(b=>['v2','legacy'].includes(b)));report.requestedBackends=backends;
  for(const backend of backends) {
    console.log('Checking backend',backend);
    const context=await browser.newContext({viewport:{width:1000,height:700},serviceWorkers:'block'});
    await context.addInitScript(seedBrowserConstruction,315);await context.addInitScript(installSeedReceiver);
    await context.route(/^https:\/\//,route=>route.abort());
    const page=await context.newPage();page.setDefaultTimeout(120000);
    page.on('pageerror',e=>report.errors.push(e.message));
    try {
      // v2 uses the default path, never a silently accepted fallback.
      await page.goto(`http://127.0.0.1:8089/?seed=315&rangeView=teton-jackson-lake${backend==='legacy'?'&rangeRenderer=legacy':''}`);
      await page.waitForFunction(()=>window.__SMW?.presentationDiagnostics?.frame?.presented);
      await captureTitle(page,backend,'natural');
      await page.locator('#titleSettings').evaluate(n=>{n.open=true;});
      await settings(page,{look:'palette',quality:'auto',scaling:'integer',palette:'range32',dither:.35});
      const titleFrameId=await page.evaluate(()=>window.__SMW?.presentationDiagnostics?.frame?.frameId);
      await page.selectOption('#stageFps','30');
      await page.waitForFunction(id=>window.__SMW?.presentationDiagnostics?.frame?.presented&&window.__SMW.presentationDiagnostics.frame.frameId!==id,titleFrameId);
      await page.waitForFunction(()=>window.__SMW?.presentationDiagnostics?.frame?.presented);
      await captureTitle(page,backend,'palette');
      await page.reload();
      assert.equal(await page.locator('#display-look').inputValue(),'palette');
      assert.equal(await page.locator('#display-quality').inputValue(),'auto');
      assert.equal(await page.locator('#display-scaling').inputValue(),'integer');
      assert.equal(await page.locator('#stageFps').inputValue(),'30');
      await page.locator('#titleSettings').evaluate(n=>{n.open=true;});
      await settings(page,{look:'pixel',quality:'auto',scaling:'fit'});
      await page.waitForFunction(()=>window.__SMW?.presentationDiagnostics?.effectiveLook==='pixel'&&window.__SMW.presentationDiagnostics.frame.presented);
      await captureTitle(page,backend,'pixel');
      await page.locator('#lyricGroundingBtn').evaluate(n=>{if(n.getAttribute('aria-pressed')==='true')n.click();});
      await page.locator('#fileInput').setInputFiles(wav);
      if(await page.locator('#worldSelect[open]').count())await page.locator('.worldCard').first().click();
      await page.waitForFunction(()=>!!window.__SMW?.sim,null,{polling:100});
      await page.locator('#pauseBtn').evaluate(n=>n.click()); // preserve a live frame while inspecting
      await page.evaluate(()=>window.__SMW.seek(1500));
      await page.evaluate(()=>window.__SMW.rangeReady({timeoutMs:120000}));
      await page.locator('#displaySettingsBtn').evaluate(n=>n.click());
      await settings(page,{look:'palette',quality:'economy',scaling:'integer',palette:'rgb332',dither:1});
      await page.selectOption('#stageFps','60');await page.locator('#displaySettingsClose').click();
      assert.equal(await page.evaluate(()=>window.__SMW.displayPrefs.quality),'economy');
      // Actual app live loop, with audio/fixed-step simulation kept separate.
      await page.locator('#pauseBtn').evaluate(n=>n.click());
      await page.waitForFunction(()=>window.__SMW.presentationDiagnostics?.effectiveLook==='palette');
      report.frames.push({kind:'playback-transition',requested:await page.evaluate(()=>window.__SMW.displayPrefs),diagnostics:await page.evaluate(()=>window.__SMW.presentationDiagnostics),rates:await page.evaluate(()=>window.__SMW.frameRates),backend:await page.evaluate(()=>window.__SMW.rangeState),dpr:1});
      if(backend==='legacy') {
        const before=await page.evaluate(()=>{
          const c=document.querySelector('#stage');window.__retroSize=[c.width,c.height];
          c.width=0;c.height=0; // Real backing loss; live grid needs no reservation.
          return {audio:window.__SMW.audioEngine.nowMs,sim:window.__SMW.sim.timeMs};
        });
        await page.waitForFunction(()=>window.__SMW.presentationDiagnostics?.frame?.reason==='output-context');
        await page.waitForTimeout(300);
        const after=await page.evaluate(()=>({audio:window.__SMW.audioEngine.nowMs,sim:window.__SMW.sim.timeMs,capture:window.__SMW.renderer.getCaptureSource(),diagnostic:window.__SMW.presentationDiagnostics.frame}));
        assert.ok(after.audio>before.audio);assert.ok(after.sim>before.sim);assert.equal(after.capture,null);
        await page.evaluate(()=>{const c=document.querySelector('#stage');[c.width,c.height]=window.__retroSize;});
        await page.waitForFunction(()=>window.__SMW.presentationDiagnostics?.frame?.presented);
        report.liveFailure={before,after,recovered:true};
      }
      await page.waitForFunction(()=>{try{window.__SMW.beginBulkExport({width:800,height:480});return true;}catch{return false;}},null,{timeout:180000});
      const cases=[
        [800,480,'natural','auto','fit','range32',0],
        [800,480,'pixel','auto','integer','range32',.35],
        [1920,1080,'palette','auto','fit','range32',.35],
        [1080,1080,'palette','economy','integer','rgb332',1],
        [1080,1920,'palette','economy','fit','range32',0],
        [160,90,'pixel','economy','integer','rgb332',1],
        [1280,720,'palette','auto','fit','chroma32',.35,'detailed','selective'],
        [800,480,'pixel','auto','integer','world',.35,'detailed','selective'],
      ];
      for(const [width,height,look,quality,scaling,palette,dither,pixelGrid='classic',ditherMode='ordered'] of cases) {
        console.log('Checking export',backend,width,height,look);
        const profile={version:2,look,quality,scaling,palette,dither,pixelGrid,ditherMode};
        await page.evaluate(async ({width,height,profile})=>{
          window.__resetLandscapeRandom();window.__SMW.beginBulkExport({width,height,presentation:profile});await window.__SMW.rangeReady({timeoutMs:120000});
        },{width,height,profile});
        const frames=[];
        for(const time of look==='pixel'&&width===800?[1500,6000,9500]:[6000]) {
          const clock=await page.evaluate(async time=>{let r=window.__SMW.renderExportFrame(time);if(await window.__SMW.rangeSettle())r=window.__SMW.renderExportFrame(time);return r;},time);
          assert.equal(clock.presented,true);
          const frame=await page.evaluate(inspectPixelFrame,{paletteId:look==='palette'?palette:'none'});
          assert.equal(frame.width,width);assert.equal(frame.height,height);
          assertMeaningfulFrame(frame);assert.equal(frame.paletteErrors,0);
          assert.equal(frame.barErrors,0,'scene output bars contain image pixels');
          if(look==='palette')assert.equal(frame.palettePixels,frame.grid.pixels);
          if(frame.placement)assert.ok(Math.abs(frame.placement.width/frame.placement.height-16/9)<1e-9);
          if(look!=='natural'){assert.deepEqual(frame.presentation.working,{width:frame.grid.width,height:frame.grid.height});assert.ok(frame.presentation.paletteStatus.pixels<=frame.grid.pixels);assert.equal(frame.grid.id,pixelGrid);}
          if(backend==='v2')assert.ok(frame.backend.mode==='v2'&&frame.backend.active&&frame.backend.runtime==='ready',`silent fallback: ${JSON.stringify(frame.backend)}`);
          else assert.equal(frame.backend.mode,'legacy');
          const png=`${backend}-${look}-${pixelGrid}-${width}x${height}-${time}.png`;await fs.writeFile(path.join(out,png),Buffer.from(frame.png,'base64'));delete frame.png;
          report.frames.push({...frame,clock,requested:profile,png});frames.push(frame.thumbnail);
        }
        if(frames.length>1)assertTemporalChange(frames);
      }
      // Real context loss must produce a labelled fallback, then recover.
      if(backend==='v2') {
        const supported=await page.evaluate(()=>{
          const scene=window.__SMW.sim.biomes.rangePresentation.scene;
          const ext=scene.renderer.getContext().getExtension('WEBGL_lose_context');
          if(!ext)return false;window.__retroContextExtension=ext;ext.loseContext();return true;
        });
        if(supported) {
          await page.waitForTimeout(100);
          await page.evaluate(()=>window.__SMW.renderExportFrame(10000));
          const lost=await page.evaluate(inspectPixelFrame);assertMeaningfulFrame(lost);assert.equal(lost.backend.active,false);
          report.contextLoss=lost.backend;
          await page.evaluate(()=>window.__retroContextExtension.restoreContext());
          await page.waitForTimeout(300);await page.evaluate(()=>window.__SMW.rangeReady());
          await page.evaluate(()=>window.__SMW.renderExportFrame(10500));
          const restored=await page.evaluate(inspectPixelFrame);assertMeaningfulFrame(restored);assert.equal(restored.backend.active,true);
          report.contextRestore=restored.backend;
        } else report.contextLoss='extension unavailable';
      }
      // Negative controls use actual Chromium pixels and completed scene
      // buffers, so a black or frozen image cannot pass just on color count.
      await page.evaluate(()=>{const c=document.querySelector('#stage'),ctx=c.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,c.width,c.height);});
      const black=await page.evaluate(inspectPixelFrame);assert.throws(()=>assertMeaningfulFrame(black),/blank/);
      await fs.writeFile(path.join(out,`${backend}-rejected-black.png`),Buffer.from(black.png,'base64'));
      await page.evaluate(()=>window.__SMW.renderExportFrame(11000));
      const held=await page.evaluate(inspectPixelFrame),repeat=await page.evaluate(inspectPixelFrame);
      assertMeaningfulFrame(held);assert.throws(()=>assertTemporalChange([held.thumbnail,repeat.thumbnail]),/frozen/);
      report.frames.push({kind:'negative-controls',backend,blackRejected:true,frozenRejected:true,black:{colors:black.colors,mean:black.mean},heldTimeMs:held.timeMs});
      // Reproduce first-frame export failure in the actual app, without an
      // untracked fallback canvas or allowing a returned blank file.
      const failed=await page.evaluate(async()=>{
        const {sharedResidency}=await import('/src/render/GraphicsResidency.js');const residency=sharedResidency(),budget=residency.budgetBytes;
        window.__SMW.renderer.dispose();residency.budgetBytes=1;
        try{window.__SMW.beginBulkExport({width:800,height:480,presentation:{version:1,look:'pixel',quality:'auto',palette:'range32',dither:.35,scaling:'integer'}});return {rejected:false};}
        catch(e){return {rejected:/presentation/i.test(e.message),error:window.__SMW_EXPORT_ERROR,capture:window.__SMW.renderer?.getCaptureSource(),ready:window.__SMW.exportReady,pendingBytes:residency.pendingBytes};}
        finally{residency.budgetBytes=budget;}
      });
      assert.equal(failed.rejected,true);assert.equal(failed.ready,false);assert.equal(failed.capture,null);assert.equal(failed.pendingBytes,0);report.frames.push({kind:'export-failure',backend,...failed});
    }finally{await context.close();}
  }
  // Force a real linked-program rejection through Chromium's GL API.
  // The app must label the legacy frame; it cannot count as a v2 pass.
  const shaderContext=await browser.newContext({viewport:{width:800,height:480}});
  try {
    await shaderContext.addInitScript(seedBrowserConstruction,315);
    await shaderContext.addInitScript(installSeedReceiver);
    await shaderContext.addInitScript(()=>{
      for(const type of [window.WebGLRenderingContext,window.WebGL2RenderingContext]) {
        if(!type)continue;const original=type.prototype.getProgramParameter;
        type.prototype.getProgramParameter=function(program,name){
          if(name===this.LINK_STATUS)return false;return original.call(this,program,name);
        };
      }
    });
    await shaderContext.route(/^https:\/\//,route=>route.abort());
    const page=await shaderContext.newPage();
    await page.goto('http://127.0.0.1:8089/?bulkExport=1&exportW=800&exportH=480&seed=315&rangeView=teton-jackson-lake');
    await page.locator('#titleSettings').evaluate(n=>{n.open=true;});
    await page.locator('#lyricGroundingBtn').evaluate(n=>{if(n.getAttribute('aria-pressed')==='true')n.click();});
    await page.locator('#fileInput').setInputFiles(wav);
    await page.waitForFunction(()=>window.__SMW?.exportReady);
    await page.evaluate(()=>window.__SMW.rangeReady({timeoutMs:120000}));
    await page.evaluate(()=>window.__SMW.renderExportFrame(1500));
    const frame=await page.evaluate(inspectPixelFrame);
    assertMeaningfulFrame(frame);assert.equal(frame.backend.mode,'v2');assert.equal(frame.backend.active,false);
    assert.ok(JSON.stringify(frame.backend).includes('shader'),'shader failure was not labelled');
    report.shaderFailure=frame.backend;
  } finally {await shaderContext.close();}
  assert.equal((await snapshotSource(process.cwd())).digest,report.source,'source changed during smoke');
  assert.deepEqual(report.errors,[]);report.status='passed';
  console.log(`PASS ${report.requestedBackends.join('/')}, preferences, title/playback transitions, pixel raster, eight export profiles/sizes, palette membership, temporal content, context recovery and export failure`);
}catch(e){report.error=String(e.stack||e);throw e;}
finally{clearTimeout(watchdog);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();server.kill();}
