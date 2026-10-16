// Exercise the actual audio bootstrap functions with Web Audio substituted
// only because Node has no browser context. Real network/UI checks live in
// tools/entry-font-smoke.mjs; prose is reviewed rather than snapshot-tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SimpleSynth } from '../src/audio/SimpleSynth.js';
import { SynthRouter } from '../src/audio/SoundfontLibrary.js';
import { Conductor } from '../src/core/Conductor.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const source = main.slice(main.indexOf('let bootAudioInFlight = null;'), main.indexOf('function applySynthMutePolicy('));
const activeFontSource = main.slice(main.indexOf('function applyActiveFont('), main.indexOf('function escapeHtml('));
function harness() {
  let engines = 0;
  let discoveries = 0;
  let sf2Engines = 0;
  let releaseDiscovery;
  const discovery = new Promise(resolve => { releaseDiscovery = resolve; });
  const context = vm.createContext({
    audioEngine: null, synth: null, sf2Engine: null, fontLibrary: null, fontRecommender: null,
    loadShow: null, auditionCanvasEl: null, auditionTextEl: null, auditionBarFillEl: null,
    window: { __SMW: {} }, conductor: new Conductor(), SimpleSynth, SynthRouter,
    AudioEngine: class { constructor() { engines++; this.ctx = {}; } async resume() { return true; } },
    Sf2Synth: class { constructor() { sf2Engines++; } loadSf2(data) { this.sf2 = data; } },
    SoundfontLibrary: class {
      async autoLoadFromServer() { discoveries++; await discovery; return 0; }
    },
    FontRecommender: class { auditionFont() {} },
    LoadingShow: class {}, applyBtLatencyToAudioEngine() {}, renderFontModal() {},
  });
  vm.runInContext(source + '\n' + activeFontSource, context);
  return { context, releaseDiscovery, get engines() { return engines; },
    get discoveries() { return discoveries; }, get sf2Engines() { return sf2Engines; } };
}

test('normal audio unlock creates the live fallback once and makes no optional font discovery', async () => {
  const h = harness();
  await Promise.all([h.context.bootAudio(), h.context.bootAudio()]);
  await h.context.bootAudio();
  assert.ok(h.context.synth.fallback instanceof SimpleSynth);
  assert.equal(h.context.synth.current, h.context.synth.fallback);
  assert.equal(h.engines, 1);
  assert.equal(h.discoveries, 0, 'first and repeated unlock must not request /soundfonts/');
  assert.equal(h.sf2Engines, 0, 'no optional font engine without a consumer');
  assert.equal(h.context.conductor.listeners.get('*').size, 1, 'one persistent synth connection');
});

test('an explicit font consumer shares one setup/discovery and still applies its active font', async () => {
  const h = harness();
  assert.equal(typeof h.context.ensureSoundfonts, 'function', 'optional setup has an explicit owner');
  const first = h.context.ensureSoundfonts();
  const second = h.context.ensureSoundfonts();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.engines, 1);
  assert.equal(h.sf2Engines, 1);
  assert.equal(h.discoveries, 1);
  h.releaseDiscovery();
  const library = await first;
  assert.equal(await second, library);
  assert.equal(await h.context.ensureSoundfonts(), library);
  assert.equal(h.discoveries, 1);
  library.onChange({ data: { presets: new Map() } });
  assert.equal(h.context.synth.current, h.context.sf2Engine);
  library.onChange(null);
  assert.equal(h.context.synth.current, h.context.synth.fallback);
  assert.equal(h.context.window.__SMW.fontLibrary, library);
});
