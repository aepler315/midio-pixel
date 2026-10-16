import { test } from 'node:test';
import assert from 'node:assert/strict';

// DebugOverlay's vision-config form is plain DOM glue with no framework, so
// a hand-rolled element stub (just enough of the API surface it touches) is
// cheaper and more deterministic here than a full browser, and it is the
// only automated coverage the form's interactive logic gets.
function fakeElement() {
  const el = {
    style: {},
    children: [],
    listeners: {},
    value: '',
    disabled: false,
    appendChild(child) { this.children.push(child); return child; },
    append(...items) { for (const it of items) if (typeof it !== 'string') this.children.push(it); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    fire(type) { for (const fn of this.listeners[type] || []) fn(); },
    getContext() { return {}; },
    toBlob() {},
    classList: { toggle() {}, add() {}, contains() { return false; } },
  };
  return el;
}

async function loadWithFakeDom() {
  global.document = {
    createElement: () => fakeElement(),
  };
  const { DebugOverlay } = await import('../src/ui/DebugOverlay.js?t=' + Math.random());
  const { VisionLoop } = await import('../src/vision/VisionLoop.js?t=' + Math.random());
  return { DebugOverlay, VisionLoop };
}

function fakeSim() {
  return { energyCurves: null, biomes: null, calm: { level: 0 }, vibe: { epic: 0, valence: 0 }, hype: { fast: 0, slow: 0, buildUp: 0, dropCount: 0 }, broshi: { rabid: false, rho: 0 }, ensemble: null, groove: null };
}

test('vision config form: defaults reflect the VisionLoop it was built with', async () => {
  const { DebugOverlay, VisionLoop } = await loadWithFakeDom();
  const canvas = fakeElement();
  const visionLoop = new VisionLoop(canvas, { live: {}, target: {} }, fakeSim(), { provider: 'anthropic', apiKey: 'sk-abc' });
  const overlay = new DebugOverlay(fakeElement(), fakeSim(), { live: {}, target: {} }, visionLoop);

  const [select, keyInput] = overlay.el.children[1].children; // [0]=canvas,[1]=form wrap,[2]=pre
  assert.equal(select.value, 'anthropic');
  assert.equal(keyInput.value, 'sk-abc');
});

test('vision config form: switching providers clears a stale model/endpoint override instead of carrying it over', async () => {
  const { DebugOverlay, VisionLoop } = await loadWithFakeDom();
  const canvas = fakeElement();
  const visionLoop = new VisionLoop(canvas, { live: {}, target: {} }, fakeSim(), { provider: 'ollama', model: 'llava:34b' });
  const overlay = new DebugOverlay(fakeElement(), fakeSim(), { live: {}, target: {} }, visionLoop);

  const [select, , modelInput] = overlay.el.children[1].children;
  assert.equal(modelInput.value, 'llava:34b'); // shown because it differs from ollama's default

  select.value = 'openai';
  select.fire('change');

  assert.equal(visionLoop.provider, 'openai');
  assert.equal(visionLoop.model, 'gpt-4o-mini'); // openai's own default, not the stale ollama model string
  assert.equal(modelInput.value, '');
});

test('vision config form: editing the API key alone does not reset a model override back to the provider default', async () => {
  const { DebugOverlay, VisionLoop } = await loadWithFakeDom();
  const canvas = fakeElement();
  const visionLoop = new VisionLoop(canvas, { live: {}, target: {} }, fakeSim(), { provider: 'openai', apiKey: 'sk-1', model: 'gpt-4o' });
  const overlay = new DebugOverlay(fakeElement(), fakeSim(), { live: {}, target: {} }, visionLoop);

  const [, keyInput] = overlay.el.children[1].children;
  assert.equal(visionLoop.model, 'gpt-4o');

  keyInput.value = 'sk-2';
  keyInput.fire('change');

  assert.equal(visionLoop.apiKey, 'sk-2');
  assert.equal(visionLoop.model, 'gpt-4o'); // unchanged -- the override survived an unrelated edit
});

test('vision config form: onVisionConfigChange fires with the applied config for main.js to persist', async () => {
  const { DebugOverlay, VisionLoop } = await loadWithFakeDom();
  const canvas = fakeElement();
  const visionLoop = new VisionLoop(canvas, { live: {}, target: {} }, fakeSim(), { provider: 'ollama' });
  const overlay = new DebugOverlay(fakeElement(), fakeSim(), { live: {}, target: {} }, visionLoop);

  let seen = null;
  overlay.onVisionConfigChange = (cfg) => { seen = cfg; };

  const [, keyInput] = overlay.el.children[1].children;
  keyInput.value = 'sk-persisted';
  keyInput.fire('change');

  assert.equal(seen.provider, 'ollama');
  assert.equal(seen.apiKey, 'sk-persisted');
});
