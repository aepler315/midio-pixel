import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimpleSynth } from '../src/audio/SimpleSynth.js';
import { SynthRouter } from '../src/audio/SoundfontLibrary.js';
import { Role } from '../src/core/NoteEvent.js';
import { buildDemoSong } from '../src/core/DemoSong.js';

// Graph scheduling/ownership tests; tools/synth-release-smoke.mjs exercises
// actual Web Audio output, where these fakes cannot establish click behavior.
function audioGraph() {
  const nodes = [];
  const param = () => ({
    value: 0, events: [],
    setValueAtTime(value, at) { this.events.push(['set', value, at]); },
    linearRampToValueAtTime(value, at) { this.events.push(['linear', value, at]); },
    exponentialRampToValueAtTime(value, at) { this.events.push(['exponential', value, at]); },
    cancelScheduledValues(at) { this.events.push(['cancel', at]); },
  });
  function node(kind) {
    const result = {
      kind, disconnected: false, connections: [],
      connect(dest) { this.connections.push(dest); return dest; },
      disconnect() { this.disconnected = true; },
    };
    if (kind === 'oscillator' || kind === 'noise') Object.assign(result, {
      frequency: param(), detune: param(), stops: [],
      start(at) { this.startedAt = at; },
      stop(at) { this.stops.push(at); },
      end() { this.onended?.(); },
    });
    nodes.push(result);
    return result;
  }
  const ctx = {
    currentTime: 10, sampleRate: 48000,
    createOscillator: () => node('oscillator'),
    createBufferSource: () => node('noise'),
    createGain: () => Object.assign(node('gain'), { gain: param() }),
    createBiquadFilter: () => Object.assign(node('filter'), { frequency: param(), Q: param() }),
    createStereoPanner: () => Object.assign(node('panner'), { pan: param() }),
    createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length) }),
  };
  const master = Object.assign(node('master'), { gain: param() });
  return { ctx, nodes, master };
}

const samplePad = buildDemoSong().timeline.find(evt => evt.role === Role.PAD && evt.durMs === 1920);
const patch = {
  type: 'sawtooth', attack: 0.02, release: 0.3, cutoffHz: 3000, resonanceQ: 1,
  unisonGain: 0.3, unisonDetuneCents: 7, vibratoDepthCents: 12, vibratoRateHz: 5, peakGain: 0.15,
};

test('router releases the actual 1920 ms sample PAD within 30 ms without master automation', () => {
  assert.ok(samplePad, 'exercise an authored sample PAD, not a shortened fixture');
  const graph = audioGraph();
  const synth = new SimpleSynth(graph);
  const router = new SynthRouter(synth);
  router.noteOn(samplePad);
  const osc = graph.nodes.find(node => node.kind === 'oscillator');
  assert.equal(osc.stops[0], 11.97);
  graph.ctx.currentTime = 10.2;
  router.stopAll();
  assert.ok(Math.abs(osc.stops.at(-1) - 10.23) < 1e-10, 'replace the long natural stop with the release stop');
  const release = graph.nodes.filter(node => node.kind === 'gain').at(-1);
  assert.deepEqual(release.gain.events.slice(-2), [['set', 1, 10.2], ['linear', 0, graph.ctx.currentTime + 0.03]]);
  assert.deepEqual(graph.master.gain.events, []);
});

test('repeated stopAll is idempotent and natural ended cleanup empties owned voices', () => {
  const graph = audioGraph();
  const synth = new SimpleSynth(graph);
  synth.noteOn(samplePad);
  assert.equal(synth._voices.size, 1);
  const osc = graph.nodes.find(node => node.kind === 'oscillator');
  synth.stopAll();
  synth.stopAll();
  assert.equal(osc.stops.length, 2, 'natural scheduling plus one teardown stop');
  osc.end();
  assert.equal(synth._voices.size, 0);
  assert.ok(graph.nodes.filter(node => node !== graph.master).every(node => node.disconnected));
  assert.doesNotThrow(() => synth.stopAll());
});

test('patched unison and LFO are owned until every source naturally ends', () => {
  const graph = audioGraph();
  const synth = new SimpleSynth(graph);
  synth.setPatches({ 2: patch });
  synth.noteOn({ ...samplePad, pan: 0.5 });
  const sources = graph.nodes.filter(node => node.kind === 'oscillator');
  assert.equal(sources.length, 3, 'primary, LFO and unison');
  assert.equal(synth._voices.size, 1);
  sources[0].end();
  assert.equal(synth._voices.size, 1, 'do not disconnect a live sibling');
  sources[1].end();
  sources[2].end();
  assert.equal(synth._voices.size, 0);
  assert.ok(graph.nodes.filter(node => node !== graph.master).every(node => node.disconnected));
});

test('stopAll releases every patched source and old repeated ended callbacks preserve a new voice', () => {
  const graph = audioGraph();
  const synth = new SimpleSynth(graph);
  synth.setPatches({ 2: patch });
  synth.noteOn(samplePad);
  const outgoing = graph.nodes.filter(node => node.kind === 'oscillator');
  synth.stopAll();
  assert.ok(outgoing.every(source => source.stops.at(-1) === 10.03));
  const oldNodes = new Set(graph.nodes);
  graph.ctx.currentTime = 10.01;
  synth.noteOn(samplePad);
  const incoming = graph.nodes.filter(node => !oldNodes.has(node));
  outgoing.forEach(source => { source.end(); source.end(); });
  assert.equal(synth._voices.size, 1);
  assert.ok(incoming.every(node => !node.disconnected));
  assert.ok(incoming.filter(node => node.kind === 'oscillator').every(source => source.stops.length === 1));
});

test('kick, snare noise and hat noise all release and naturally clean their owned nodes', () => {
  const graph = audioGraph();
  const synth = new SimpleSynth(graph);
  for (const pitch of [36, 38, 42]) synth.noteOn({ ...samplePad, role: Role.RHYTHM, pitch, pan: -0.4 });
  assert.equal(synth._voices.size, 3);
  const sources = graph.nodes.filter(node => ['oscillator', 'noise'].includes(node.kind));
  assert.equal(sources.length, 3);
  synth.stopAll();
  assert.ok(sources.every(source => source.stops.at(-1) === 10.03));
  sources.forEach(source => source.end());
  assert.equal(synth._voices.size, 0);
});

test('disabled recording router creates no timeline voices but still releases an outgoing sample', () => {
  const graph = audioGraph();
  const synth = new SimpleSynth(graph);
  const router = new SynthRouter(synth);
  router.noteOn(samplePad);
  router.enabled = false;
  router.stopAll();
  router.noteOn(samplePad);
  assert.equal(graph.nodes.filter(node => node.kind === 'oscillator').length, 1);
  assert.equal(graph.nodes.find(node => node.kind === 'oscillator').stops.at(-1), 10.03);
  router.enabled = true;
  router.noteOn(samplePad);
  assert.equal(graph.nodes.filter(node => node.kind === 'oscillator').length, 2);
});

test('switching between loaded SF2 and fallback still releases outgoing fallback voices', () => {
  const graph = audioGraph();
  const synth = new SimpleSynth(graph);
  const router = new SynthRouter(synth);
  router.noteOn(samplePad);
  let sf2Stops = 0;
  let sf2Notes = 0;
  const sf2 = { sf2: {}, noteOn() { sf2Notes++; }, stopAll() { sf2Stops++; } };
  router.setSf2Engine(sf2);
  router.noteOn(samplePad);
  assert.equal(sf2Notes, 1);
  router.stopAll();
  assert.equal(sf2Stops, 1);
  const outgoing = graph.nodes.find(node => node.kind === 'oscillator');
  assert.equal(outgoing.stops.at(-1), 10.03);
  sf2.sf2 = null;
  graph.ctx.currentTime = 10.01;
  router.noteOn(samplePad);
  outgoing.end();
  assert.equal(synth._voices.size, 1, 'the incoming fallback survives outgoing cleanup');
});
