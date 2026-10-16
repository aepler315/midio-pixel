// Load one viewpoint, wait for full detail, then capture every look.
//   node tools/gallery.mjs "<query>" outDir [--looks light:alpenglow,style:ink,...] [--w --h --wait]
import fs from 'node:fs';
import path from 'node:path';
import { shoot } from './shot.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const query = args[0] ?? 'range=tetons&view=0';
const outDir = args[1] ?? '.smoke/gallery';
const W = Number(opt('w', 960)), H = Number(opt('h', 540)), waitS = Number(opt('wait', 400));
const ALL = 'light:alpenglow,light:golden,light:midday,light:raking,light:backlit,light:bluehour,light:moonlight,'
  + 'weather:autumn,weather:winter,weather:storm,weather:cloudsea,'
  + 'style:contours,style:ink,style:hypsometric,style:hologram,style:pixel,'
  + 'overlay:slope,overlay:aspect,overlay:bands';
const looks = opt('looks', ALL).split(',').map((x) => x.split(':'));
fs.mkdirSync(outDir, { recursive: true });

const r = await shoot({ query: `${query}&labels=0`, out: path.join(outDir, 'base.png'), W, H, waitS, keepOpen: true });
console.log('base', JSON.stringify(r.info), r.seconds.toFixed(0), 's');
for (const [group, id] of looks) {
  const reset = { light: 'golden', weather: 'summer', style: 'natural', overlay: 'none' };
  await r.page.evaluate(({ group, id, reset }) => {
    const rv = window.__rv, L = rv.engine.looks;
    for (const [g, v] of Object.entries(reset)) if (g !== group) rv.setLook(g, v, { quiet: true });
    rv.setLook(group, id, { quiet: true });
    L.cur = L._target(); L.tweens = [];
    rv.state.flight = null;
    rv.engine.trans = null;
    rv.engine.post.uniforms.uHasSnap.value = 0;
    rv.engine.post.uniforms.uTrans.value = -1;
  }, { group, id, reset });
  // A few frames so exposure, sky light and reflections settle.
  await r.page.evaluate(async () => {
    const rv = window.__rv;
    rv.paused = true;
    for (let i = 0; i < 4; i++) { rv.engine.exposure = rv.engine.exposureTarget ?? rv.engine.exposure; rv.still(); await new Promise((res) => setTimeout(res, 50)); }
    rv.engine.exposure = rv.engine.exposureTarget ?? rv.engine.exposure;
    rv.still();
  });
  await r.page.screenshot({ path: path.join(outDir, `${group}-${id}.png`), timeout: 180000 });
  console.log(group, id);
}
for (const l of r.logs.slice(0, 20)) console.log(l.slice(0, 300));
await r.browser.close();
r.server.close();
