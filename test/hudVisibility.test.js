import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = main.indexOf('const HUD_FADE_MS =');
const binding = main.slice(start, main.indexOf('// Mountain seekbar:', start));

function hud({ open = false, hidden = false, focused = false } = {}) {
  const element = () => {
    const classes = new Set(), events = new Map();
    return { classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      addEventListener(name, handler) { events.set(name, handler); }, events };
  };
  const right = element(), left = element(), details = { ...element(), open, hidden, contains: target => target === details };
  let now = 0;
  const context = vm.createContext({ hudRightEl: right, hudLeftEl: left, rangeCaptionDetailsEl: details,
    songRecorder: null, recalibration: { active: false }, btLatencyPopoverEl: null,
    document: { activeElement: focused ? details : null }, performance: { now: () => now } });
  vm.runInContext(binding, context);
  return { right, details, document: context.document,
    tick(at) { now = at; context.hudIdleTick(at); },
    emit(target, event, at) { now = at; target.events.get(event)?.(); } };
}

test('Landscape details remain visible throughout idle reading and fade again after closing', () => {
  const state = hud({ open: true });
  state.tick(3000); state.tick(9000);
  assert.equal(state.right.classList.contains('hud-faded'), false);
  state.details.open = false;
  state.emit(state.details, 'toggle', 10000);
  state.tick(12999);
  assert.equal(state.right.classList.contains('hud-faded'), false);
  state.tick(13000);
  assert.equal(state.right.classList.contains('hud-faded'), true);
});

test('keyboard focus wakes Landscape details and keeps its summary reachable', () => {
  const state = hud();
  state.tick(3000);
  assert.equal(state.right.classList.contains('hud-faded'), true);
  state.document.activeElement = state.details;
  state.emit(state.right, 'focusin', 4000);
  assert.equal(state.right.classList.contains('hud-faded'), false);
  state.tick(10000);
  assert.equal(state.right.classList.contains('hud-faded'), false);
});

test('a hidden details view and an unfocused closed summary preserve normal HUD fading', () => {
  for (const options of [{ hidden: true, open: true }, {}]) {
    const state = hud(options);
    state.tick(3000);
    assert.equal(state.right.classList.contains('hud-faded'), true);
  }
});
