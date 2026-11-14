// Display settings and the frame-rate cap both change how much work a frame is. The perf ladder
// keeps per-rung evidence about which quality levels this machine can
// afford, with an exponential backoff on retrying one that failed, so that
// evidence has to be discarded when the player changes the workload under
// it. Otherwise someone who reaches for these menus BECAUSE the frame rate
// fell apart is made to wait out a backoff earned at the old settings --
// up to the capped ten minutes -- with quality held down the whole time.
//
// Execute display registration with small DOM boundaries and the production
// applyDisplayPref function. Unrelated controls may share a local variable
// name; the display's own registration block identifies the actual wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { CAMERA_STUDIO_SETTING_IDS } from '../src/config/settingsRegistry.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'src/main.js'), 'utf8');


// Display settings and the frame rate arrive through the settings store
// (src/config/appSettings.js): store.set -> applySettingChange -> applier.
const END = '\n}\n';
const slice = (from, to = END) => { const i = main.indexOf(from); assert.ok(i >= 0, from); return main.slice(i, main.indexOf(to, i) + to.length); };

test("control: an explicit display change clears the perf ladder's recovery history exactly once", async () => {
  const { SettingsStore } = await import('../src/config/appSettings.js');
  let resets = 0, fits = 0;
  const context = vm.createContext({
    CAMERA_STUDIO_SETTING_IDS,
    displayPrefs: { pixelGrid: 'classic', scaling: 'fit', buildPixelDetail: true },
    snapshotBusy: false, presentation: {}, resolvePresentation: prefs => prefs,
    syncDisplayControls() {}, perfGovernor: { forgetRecoveryHistory() { resets++; } }, fitCanvas() { fits++; }, paused: false, running: false, console,
  });
  vm.runInContext([slice('function applyDisplayPref('), slice('let landscapeRendererDirty = false;', '\n};\n'), slice('function applySettingChange(')].join('\n'), context);
  const store = new SettingsStore({ storage: null });
  store.subscribe(context.applySettingChange);
  for (const [id, value] of [['pixelGrid', 'medium'], ['scaling', 'integer'], ['buildPixelDetail', true]]) {
    const before = { resets, fits };
    assert.equal(store.set(id, value).changed, true, id);
    assert.equal(resets, before.resets + 1, `${id} must clear old workload evidence exactly once`);
    assert.equal(fits, before.fits + 1, `${id} is re-presented once`);
  }
});

test("fpsCap: an explicit frame-rate change clears the perf ladder's recovery history", () => {
  assert.match(
    slice('function applyFpsCap('), /forgetRecoveryHistory\(\)/,
    'the frame-rate applier must clear the recovery history -- the player has just changed '
    + 'how much work a frame is, so the backoff earned at the old setting no longer describes '
    + 'anything, and leaving it in place holds quality down for minutes after they fixed it',
  );
});

test("the governor's own resizing must NOT clear it", () => {
  // fitCanvas runs on window resize and on every governor-driven level
  // change. Clearing there would erase the evidence the backoff is built on
  // and put the oscillation straight back.
  const start = main.indexOf('function fitCanvas()');
  assert.notEqual(start, -1);
  const end = main.indexOf('\nfunction ', start + 1);
  const body = main.slice(start, end === -1 ? undefined : end);
  assert.doesNotMatch(
    body, /forgetRecoveryHistory/,
    'fitCanvas must not clear the recovery history: it runs on every level change, '
    + 'so clearing there would erase the very evidence that stops the ladder oscillating',
  );
});
