import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as detail from '../src/ui/DetailSnapshots.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('minus and equals step pixel density, including plus and numpad equivalents', () => {
  for (const event of [{ key: '-' }, { key: '_' }, { code: 'NumpadSubtract' }]) assert.equal(detail.detailKeyDelta(event), -1);
  for (const event of [{ key: '=' }, { key: '+' }, { code: 'NumpadAdd' }]) assert.equal(detail.detailKeyDelta(event), 1);
  assert.equal(detail.detailKeyDelta({ key: 'f' }), 0);
});

test('browser zoom and modifier shortcuts retain their native behavior', () => {
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) {
    for (const key of ['-', '=', '+']) assert.equal(detail.detailKeyDelta({ key, [modifier]: true }), 0);
  }
});

test('holding a density key stops at either edge instead of wrapping', () => {
  let level = 'medium';
  for (let i = 0; i < 20; i++) level = detail.stepDetail(level, detail.detailKeyDelta({ key: '-', repeat: true }));
  assert.equal(level, 'classic');
  for (let i = 0; i < 20; i++) level = detail.stepDetail(level, detail.detailKeyDelta({ key: '=', repeat: true }));
  assert.equal(level, 'detailed');
});

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function pageKeys({ level = 'classic', modal = false, snapshotBusy = false, experience = 'landscape' } = {}) {
  let keydown, taps = 0;
  const changes = [];
  const state = vm.createContext({
    window: { addEventListener(_, callback) { keydown = callback; } },
    document: { getElementById: () => modal ? { open: true } : null },
    worldSelectEl: null, running: false, snapshotBusy, experience, wakeHud() {},
    displayPrefs: { pixelGrid: level }, stepDetail: detail.stepDetail, detailKeyDelta: detail.detailKeyDelta,
    applyDisplayPref(_, value) { changes.push(value); state.displayPrefs.pixelGrid = value; },
    beatTap() { taps++; }, DEV_MODE: false, INERT_KEYS: new Set(),
    NON_TEXT_INPUT_TYPES: new Set(['range', 'checkbox']), CONTROL_NAV_KEYS: new Set(['ArrowLeft', 'ArrowRight']),
  });
  for (const name of ['isTextEntry', 'stepPixelDetail']) {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}\n', start) + 3;
    assert.ok(start >= 0 && end > start);
    vm.runInContext(source.slice(start, end), state);
  }
  const start = source.indexOf("window.addEventListener('keydown', (e) => {"), end = source.indexOf('\n});', start) + 4;
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), state);
  return { changes, state, get taps() { return taps; }, press(key, options = {}) {
    let prevented = false;
    keydown({ key, preventDefault() { prevented = true; }, ...options });
    return prevented;
  } };
}

test('production keyboard handler consumes density keys at both endpoints without resizing or beat taps', () => {
  const page = pageKeys();
  assert.equal(page.press('-'), true);
  assert.equal(page.changes.length, 0);
  for (let i = 0; i < 12; i++) assert.equal(page.press('='), true);
  assert.deepEqual(page.changes, ['classicPlus', 'medium', 'mediumPlus', 'detailed']);
  assert.equal(page.taps, 0);
  assert.equal(page.press('-', { repeat: true }), true);
  assert.equal(page.state.displayPrefs.pixelGrid, 'mediumPlus');
});

test('production shortcuts respect text, modals, browser modifiers and snapshot ownership', () => {
  const page = pageKeys();
  for (const target of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }, { tagName: 'SELECT' }]) {
    assert.equal(page.press('=', { target }), false);
  }
  for (const flag of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(page.press('=', { [flag]: true }), false);
  assert.equal(page.changes.length, 0);
  assert.equal(page.taps, 0);
  const modal = pageKeys({ modal: true });
  assert.equal(modal.press('='), false);
  assert.equal(modal.changes.length, 0);
  const snapshot = pageKeys({ snapshotBusy: true });
  assert.equal(snapshot.press('='), true);
  assert.equal(snapshot.changes.length, 0);
});

test('Trio ignores detail shortcuts without changing the saved Landscape grid', () => {
  const page = pageKeys({ experience: 'trio', level: 'medium' });
  page.press('='); page.press('-');
  assert.deepEqual(page.changes, []);
  assert.equal(page.state.displayPrefs.pixelGrid, 'medium');
});
