// Interaction smoke test in headless Chromium (software WebGL).
//   node tools/smoke.mjs
// Loads the viewer, then checks: no console errors, a range jump flies to
// and lands on the next viewpoint, scrolling moves toward the cursor,
// dragging turns the view, keys switch looks, the range search jumps.
import fs from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from './serve.mjs';

const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const rv = (fn, arg) => page.evaluate(fn, arg);

await page.goto(`http://127.0.0.1:${server.address().port}/?proxy=1&test=1&quality=low&range=tetons&labels=1`);
await page.waitForFunction(() => window.__rv?.engine?.tiles.stats.drawn > 0, null, { timeout: 120000 });
// Let the near terrain arrive.
await page.waitForFunction(() => window.__rv.engine.tiles.stats.maxZ >= 12, null, { timeout: 240000 }).catch(() => {});
check('loads and draws terrain', true, `maxZ ${await rv(() => window.__rv.engine.tiles.stats.maxZ)}`);

// Scroll toward the centre of the view.
const before = await rv(() => { const e = window.__rv.engine; const p = e.pick(0, 0); return { pos: [...e.rig.pos], hit: p?.point ?? null }; });
await page.mouse.move(400, 225);
for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
await page.waitForTimeout(4000);
const after = await rv(() => [...window.__rv.engine.rig.pos]);
if (before.hit) {
  const d0 = Math.hypot(...before.hit.map((v, i) => v - before.pos[i])), d1 = Math.hypot(...before.hit.map((v, i) => v - after[i]));
  check('scroll flies toward the cursor', d1 < d0 * 0.9, `${(d0 / 1000).toFixed(2)} km -> ${(d1 / 1000).toFixed(2)} km`);
} else check('scroll flies toward the cursor', false, 'no terrain under the cursor');

// Drag to look.
const h0 = await rv(() => window.__rv.engine.rig.headingPitch().heading);
await page.mouse.move(400, 225);
await page.mouse.down();
await page.mouse.move(250, 225, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(1500);
const h1 = await rv(() => window.__rv.engine.rig.headingPitch().heading);
const turned = Math.abs(((h1 - h0 + 540) % 360) - 180);
check('drag turns the view', turned > 3, `${turned.toFixed(1)} deg`);

// Keys: light, style cycle.
await page.keyboard.press('3');
await page.keyboard.press('t');
await page.waitForTimeout(1500);
const looks = await rv(() => ({ light: window.__rv.engine.looks.light, style: window.__rv.engine.looks.style }));
check('keys switch light and style', looks.light === 'midday' && looks.style === 'contours', JSON.stringify(looks));

// Next range: fly and land exactly on its first viewpoint.
await page.keyboard.press(']');
await page.waitForTimeout(500);
const flying = await rv(() => !!window.__rv.state.flight);
await rv(() => { const f = window.__rv.state.flight; if (f) f.t = f.duration - 0.05; });
await page.waitForFunction(() => !window.__rv.state.flight, null, { timeout: 60000 });
const landed = await rv(() => {
  const s = window.__rv.state, r = window.__rv.ranges[s.index], v = r.views[s.view], e = window.__rv.engine;
  const ll = e.rig.lonLatH, hp = e.rig.headingPitch();
  return { id: r.id, dLon: Math.abs(ll.lon - v.eye.lon), dLat: Math.abs(ll.lat - v.eye.lat), dHead: Math.abs(((hp.heading - v.heading + 540) % 360) - 180) };
});
check('range jump flies and lands on the viewpoint', flying && landed.id !== 'tetons' && landed.dLon < 1e-4 && landed.dLat < 1e-4 && landed.dHead < 0.5, JSON.stringify(landed));

// Search the list and jump.
await page.click('.rangebtn');
await page.fill('#list input', 'denali');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const target = await rv(() => window.__rv.ranges[window.__rv.state.index].id);
check('range search jumps to the match', target === 'alaska-range', target);

const real = errors.filter((e) => !/favicon/.test(e));
check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));
await browser.close();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
