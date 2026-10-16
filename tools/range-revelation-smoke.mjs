// Compatibility entry point: old revelation URLs must now show the same
// immediate landscape. Full assembled coverage lives in landscape-performance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { openSong, captureFrame, landscapeOwnership, assertLandscapeOwnership } from './range-scene-smoke.mjs';
import { seedBrowserConstruction } from './lib/landscape-browser.mjs';
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
assert.ok(args.url && args.wav && args.output, '--url, --wav and --output required');
await fs.mkdir(args.output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
});
const report = { classification: 'Compatibility and correctness; no hardware timing claim', cases: [] };
try {
  for (const mode of [null, 'revelation', 'gameplay']) {
    const wrapper = { async newContext(options) {
      const c = await browser.newContext(options);
      await c.addInitScript(seedBrowserConstruction, 315);
      return c;
    } };
    const opened = await openSong(wrapper, { url: args.url, wav: args.wav,
      width: Number(args.width || 960), height: Number(args.height || 540),
      params: { rangeExperience: mode, rangeView: 'teton-jackson-lake', seed: '2917029651' } });
    const rows = [];
    for (const time of [0, 50000, 80000]) {
      const frame = await captureFrame(opened.page, time);
      const ownership = await landscapeOwnership(opened.page);
      assertLandscapeOwnership(ownership);
      assert.ok(frame.range.active);
      assert.equal(frame.seed, 2917029651);
      const narrative = await opened.page.evaluate(() => window.__SMW.sim.rangeNarrativeAt());
      assert.equal(narrative.revelation, 1);
      assert.deepEqual(narrative.cast, { midio: 0, broshi: 0, midasus: 0 });
      if (!time) await fs.writeFile(path.join(args.output, `${mode || 'default'}-opening.png`), Buffer.from(frame.png, 'base64'));
      delete frame.png;
      rows.push({ ...frame, ownership, narrative });
    }
    assert.deepEqual(opened.errors, []);
    report.cases.push({ mode: mode || 'default', rows, errors: opened.errors });
    await opened.context.close();
  }
} finally {
  await browser.close();
  await fs.writeFile(path.join(args.output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log('Default and historical revelation/gameplay URLs all retain actor-free landscapes.');
