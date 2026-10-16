// Actual app/export clock, plus a neutral station-review contact sheet.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {openSong,captureFrame} from './range-scene-smoke.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),url=process.argv[2]||'http://127.0.0.1:8080',output=path.resolve(process.argv[3]||'.smoke/teton-tour');
await fs.mkdir(output,{recursive:true});
const codeFiles=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','src','index.html'],{cwd:root,encoding:'utf8'}).split('\0').filter(f=>/\.(js|mjs|html)$/.test(f)).sort();
const codeHash=createHash('sha256');for(const file of codeFiles){codeHash.update(file+'\0');codeHash.update(await fs.readFile(path.join(root,file)));codeHash.update('\0');}
const report={sourceHashScope:'src JavaScript/HTML and index.html',sourceSha256:codeHash.digest('hex'),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),browser:null,songs:[],review:null};
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});report.browser=browser.version();
try{
 const fixtures=process.env.TETON_SMOKE_QUICK?[[120,96]]:[[120,96],[80,150],[150,120],[174,100],[100,180]];
 for(const [bpm,seconds]of fixtures){
  const wav=path.join('/tmp',`teton-smoke-${bpm}-${seconds}.wav`);execFileSync(process.execPath,[path.join(root,'tools/gen-test-wav.mjs'),wav,String(bpm),String(seconds)]);
  const {context,page,errors}=await openSong(browser,{url,wav,width:1280,height:720,params:{rangeTour:'tetons',seed:'315'}});
  try{
   const setup=await page.evaluate(()=>{const p=window.__SMW.sim.biomes.rangePresentation;const sections=window.__SMW.sim.biomes.sections;const longest=[...sections].sort((a,b)=>(b.endMs-b.startMs)-(a.endMs-a.startMs))[0];return{heroes:p.tour.heroes,longestMs:(longest.startMs+longest.endMs)/2,qualityRatio:p.tour.meanQualityRatio};});
   const song={bpm,seconds,qualityRatio:setup.qualityRatio,frames:[],errors};report.songs.push(song);
   const times=[...new Set([...setup.heroes.map(h=>Math.round(h.timeMs)),Math.round(setup.longestMs)])].sort((a,b)=>a-b);
   for(const timeMs of times){
    const frame=await captureFrame(page,timeMs),p=await page.evaluate(t=>{const pres=window.__SMW.sim.biomes.rangePresentation;return pres.tour.poseAt(t);},timeMs);
    assert.ok([...p.eyeM,...p.targetM,p.fovYDeg].every(Number.isFinite));assert.equal(frame.range.active,true,JSON.stringify(frame.range.failures));
    const check=await page.evaluate(t=>{const pres=window.__SMW.sim.biomes.rangePresentation,d=pres.tourData;return import('/src/world/terrain/TourPackage.js').then(({tourClearanceAt})=>{const p=pres.tour.poseAt(t),band=tourClearanceAt(d.clearance,p.eyeM[0],p.eyeM[2]);return{floor:band.floorY,ceil:band.ceilY,y:p.eyeM[1]};});},timeMs);
    assert.ok(check.y>=check.floor-.01&&check.y<=check.ceil+.01,JSON.stringify(check));
    const png=Buffer.from(frame.png,'base64'),filename=`song-${bpm}-${seconds}-${timeMs}.png`;await fs.writeFile(path.join(output,filename),png);
    const again=await captureFrame(page,timeMs);const parity=frame.png===again.png;
    // A coarse seek may refine asynchronously. Compare two fully settled draws.
    let pauseParity=parity;
    if(!pauseParity){await page.evaluate(async()=>{const scene=window.__SMW.sim.biomes.rangePresentation.scene;await Promise.allSettled([...scene.prepared.values()].flatMap(p=>[...p.windowCache?.pending.values()||[]]));});const a=await captureFrame(page,timeMs),b=await captureFrame(page,timeMs);pauseParity=a.png===b.png;}
    assert.equal(pauseParity,true,`pause parity ${bpm}/${timeMs}`);
    song.frames.push({timeMs,filename,pauseParity,pngSha256:createHash('sha256').update(png).digest('hex'),pose:p,clearance:check,range:frame.range});
    console.log(`Teton ${bpm}/${seconds} ${timeMs}ms active; pause parity ${pauseParity}`);
   }
   if(bpm===120){
    const original=await page.evaluate(()=>[...window.__SMW.sim.biomes.songTerrain._rangeTourOriginalBiomes]);
    const states=[];
    for(const enabled of [false,true]){
     await page.evaluate(enabled=>{const toggle=document.getElementById('range-tour-toggle');toggle.checked=enabled;toggle.dispatchEvent(new Event('change',{bubbles:true}));},enabled);
     const ready=await page.evaluate(()=>window.__SMW.rangeReady({timeoutMs:600000}));
     assert.deepEqual(ready.failures,{});
     states.push(await page.evaluate(()=>{const mgr=window.__SMW.sim.biomes;return{biomes:mgr.songTerrain.biomes,chapterBiomes:mgr._chapterInputs.biomes,tour:!!mgr.rangePresentation.tourMode};}));
    }
    assert.deepEqual(states[0].biomes,original);assert.deepEqual(states[0].chapterBiomes,original);assert.equal(states[0].tour,false);
    assert.deepEqual(states[1].chapterBiomes,['CONIFER']);assert.equal(states[1].tour,true);
    song.toggleRegression={original,states};
   }
   assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
 if(!process.env.TETON_SMOKE_SKIP_REVIEW){
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(new URL('/src/dev/teton-tour-review.html',url).href);await page.waitForFunction(()=>window.__tetonReview?.ready||window.__tetonReview?.error,null,{timeout:180000});
  assert.equal(await page.evaluate(()=>window.__tetonReview.error),null);
  const points=await page.evaluate(()=>window.__tetonReview.primaries),images=[],details=[];
  for(const point of points){const image=await page.evaluate(id=>window.__tetonReview.primary(id),point.id);images.push({png:image.png,label:`${point.role}: ${point.name||point.id}`});details.push({point,...image, png:undefined});}
  const map=await page.evaluate(()=>window.__tetonReview.drawMap());await fs.writeFile(path.join(output,'map.png'),Buffer.from(map.split(',')[1],'base64'));
  const sheet=await page.evaluate(images=>window.__tetonReview.contactSheet(images),images);await fs.writeFile(path.join(output,'primaries.jpg'),Buffer.from(sheet.split(',')[1],'base64'));
  assert.equal(points.length,44);assert.deepEqual(errors,[]);report.review={primaryCount:points.length,details,errors};await page.close();
 }
}finally{await browser.close();await fs.writeFile(path.join(output,'browser-smoke.json'),JSON.stringify(report,null,2)+'\n');}
