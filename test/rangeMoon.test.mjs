import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import * as sky from '../src/world/alpine/RangeSkyRenderer.js';

test('lunar phase covers new, quarter and full without an invented crescent floor', () => {
  assert.equal(typeof sky.moonIllumination, 'function');
  assert.equal(sky.moonIllumination(0), 0);
  assert.ok(Math.abs(sky.moonIllumination(.25) - .5) < 1e-12);
  assert.equal(sky.moonIllumination(.5), 1);
  assert.ok(Math.abs(sky.moonIllumination(.75) - .5) < 1e-12);
  for (const phase of [undefined, NaN, Infinity]) assert.equal(sky.moonIllumination(phase), 0);
});

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
test('actual Canvas moon has clean phases and no dark daytime backing disk', {
  skip: !existsSync(executablePath) && 'Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH', timeout: 30000,
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--mute-audio'] });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Moon phase regression</title>' });
      if (!pathname.startsWith('/src/') || pathname.includes('..')) return route.abort();
      return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL('../' + pathname.slice(1), import.meta.url), 'utf8') });
    });
    await page.goto('http://moon-fixture.test/');
    const result = await page.evaluate(async () => {
      const { RangeSkyRenderer } = await import('/src/world/alpine/RangeSkyRenderer.js');
      const { GraphicsResidency } = await import('/src/render/GraphicsResidency.js');
      const residency = new GraphicsResidency(), renderer = new RangeSkyRenderer({ residency });
      renderer._seed(315);
      const phases = [0, .1, .25, .4, .5, .75, .9];
      const board = document.createElement('canvas'); board.width = 7 * 192; board.height = 2 * 220;
      const boardContext = board.getContext('2d'), cases = [];
      for (const night of [0, 1]) for (const [i, phase] of phases.entries()) {
        const canvas = document.createElement('canvas');canvas.width = canvas.height = 192;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const background = night ? [14, 27, 47] : [82, 128, 173];
        ctx.fillStyle = `rgb(${background})`;ctx.fillRect(0, 0, 192, 192);
        renderer._bodies(ctx, { phase, moon: { xFrac: .5, yFrac: .5, radiusFrac: 60/192, altitude01: .8, visibility: 1,
          illuminant: {xFrac:1,yFrac:.5} } }, 192, 192, night);
        const pixels = ctx.getImageData(0,0,192,192).data;
        let lit=0, interior=0, blackened=0, minimum=255, maximum=0;
        for (let y=0;y<192;y++)for(let x=0;x<192;x++) {
          if(Math.hypot(x+.5-96,y+.5-96)>57)continue;
          const j=(y*192+x)*4, delta=(pixels[j]-background[0])+(pixels[j+1]-background[1])+(pixels[j+2]-background[2]);
          interior++;if(delta>65)lit++;if(delta < -9)blackened++;
          if(delta>65){minimum=Math.min(minimum,pixels[j]);maximum=Math.max(maximum,pixels[j]);}
        }
        cases.push({night,phase,fraction:lit/interior,blackened,minimum,maximum});
        boardContext.drawImage(canvas,i*192,night*220+28);
        boardContext.fillStyle='white';boardContext.font='15px sans-serif';boardContext.fillText(`${night?'Night':'Day'} / ${phase}`,i*192+8,night*220+19);
      }
      // A quarter lit toward the left must have its bright half on the left.
      const directionCanvas=document.createElement('canvas');directionCanvas.width=directionCanvas.height=192;
      const directionContext=directionCanvas.getContext('2d');
      renderer._bodies(directionContext,{phase:.25,moon:{xFrac:.5,yFrac:.5,radiusFrac:60/192,altitude01:1,visibility:1,illuminant:{xFrac:0,yFrac:.5}}},192,192,0);
      const left=[...directionContext.getImageData(65,96,1,1).data],right=[...directionContext.getImageData(125,96,1,1).data];
      const deniedResidency=new GraphicsResidency({budgetBytes:1});
      const denied=new RangeSkyRenderer({residency:deniedResidency});
      const fallbackCanvas=document.createElement('canvas');fallbackCanvas.width=fallbackCanvas.height=192;
      const fallbackContext=fallbackCanvas.getContext('2d');
      denied._bodies(fallbackContext,{phase:.25,moon:{xFrac:.5,yFrac:.5,radiusFrac:60/192,altitude01:1,visibility:1,illuminant:{xFrac:1,yFrac:.5}}},192,192,0);
      const fallback={left:[...fallbackContext.getImageData(65,96,1,1).data],right:[...fallbackContext.getImageData(125,96,1,1).data],bytes:deniedResidency.usedBytes};
      denied.dispose();
      const bytesBefore=residency.usedBytes;renderer.dispose();
      return {cases,left,right,fallback,bytesBefore,bytesAfter:residency.usedBytes,png:board.toDataURL().split(',')[1]};
    });
    if(process.env.MOON_EVIDENCE_DIR){
      await mkdir(process.env.MOON_EVIDENCE_DIR,{recursive:true});
      const label=process.env.MOON_EVIDENCE_LABEL||'after';
      await writeFile(path.join(process.env.MOON_EVIDENCE_DIR,`${label}-phases.png`),Buffer.from(result.png,'base64'));
      await writeFile(path.join(process.env.MOON_EVIDENCE_DIR,`${label}-phases.json`),JSON.stringify({...result,png:undefined},null,2));
    }
    assert.deepEqual(errors,[]);
    for(const c of result.cases){
      assert.equal(c.blackened,0,`no black backing disk at day/night=${c.night}, phase=${c.phase}`);
      const expected=.5-.5*Math.cos(Math.PI*2*c.phase);
      assert.ok(Math.abs(c.fraction-expected)<.055,`phase ${c.phase} rendered ${c.fraction}, expected ${expected}`);
      if(c.phase===.5)assert.ok(c.maximum-c.minimum<48,'full moon detail remains subtle, not giant dark maria blobs');
    }
    assert.ok(result.left[3]>128 && result.right[3]<8,'lit side follows the projected solar direction');
    assert.equal(result.fallback.left[3],0);assert.ok(result.fallback.right[3]>128,'budget refusal still paints the correctly phased moon');
    assert.equal(result.fallback.bytes,0);
    assert.equal(result.bytesAfter,0);
    assert.ok(result.bytesBefore<=192*192*4*2,'one albedo and one bounded light scratch');
  } finally { await browser.close(); }
});
