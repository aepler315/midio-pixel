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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'src/main.js'), 'utf8');

/** The body of the first `change` listener registered on `el`. */
function changeHandlerBody(source, el) {
  const start = source.indexOf(`${el}.addEventListener('change'`);
  assert.notEqual(start, -1, `no change listener found for ${el}`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '{') { depth++; seen = true; }
    else if (c === '}') { depth--; if (seen && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced listener body for ${el}`);
}

test("control: an explicit quality change clears the perf ladder's recovery history", () => {
  const callbacks = new Map(); let resets = 0, fits = 0;
  const displayControls = Object.fromEntries(['look', 'palette', 'dither', 'ditherMode', 'pixelGrid', 'scaling'].map(key => [key, {
    value: '', addEventListener(type, callback) { assert.equal(type, 'change'); callbacks.set(key, callback); },
  }]));
  const context = vm.createContext({ displayControls,
    displayPrefs: { look: 'palette', palette: 'rgb332', dither: 0, ditherMode: 'ordered', pixelGrid: 'classic', scaling: 'fill' },
    snapshotBusy: false, presentation: {}, resolvePresentation: prefs => prefs, writeDisplayPrefs() {}, displayStorage: () => null,
    syncDisplayControls() {}, perfGovernor: { forgetRecoveryHistory() { resets++; } }, fitCanvas() { fits++; }, paused: false,
  });
  const functionStart = main.indexOf('function applyDisplayPref(');
  assert.notEqual(functionStart, -1);
  const functionEnd = main.indexOf('\n}\n', functionStart) + 3;
  vm.runInContext(main.slice(functionStart, functionEnd), context);
  const registrationStart = main.indexOf('  for (const [key, control] of Object.entries(displayControls)) {');
  const registrationEnd = main.indexOf('\n  syncDisplayControls();', registrationStart);
  assert.ok(registrationStart >= 0 && registrationEnd > registrationStart);
  vm.runInContext(main.slice(registrationStart, registrationEnd), context);
  assert.equal(callbacks.size, Object.keys(displayControls).length);
  for (const callback of callbacks.values()) {
    const before = resets;
    callback();
    assert.equal(resets, before + 1, 'every display control must clear old workload evidence exactly once');
  }
  assert.equal(fits, callbacks.size, 'each actual setting change is re-presented');
});

for (const el of ['stageFpsEl']) {
  test(`${el}: an explicit quality change clears the perf ladder's recovery history`, () => {
    const body = changeHandlerBody(main, el);
    assert.match(
      body, /forgetRecoveryHistory\(\)/,
      `${el}'s change handler must clear the recovery history -- the player has just changed `
      + 'how much work a frame is, so the backoff earned at the old setting no longer describes '
      + 'anything, and leaving it in place holds quality down for minutes after they fixed it',
    );
  });
}

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
