// AudioEngine's own logic is a thin wrapper around real Web Audio nodes, so
// these tests fake just enough of AudioContext to exercise the wiring and
// clamping AudioEngine itself is responsible for -- not real audio behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../src/audio/AudioEngine.js';

function audioParam() {
  return {
    value: 0,
    setValueAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; },
    cancelScheduledValues() {},
  };
}

function fakeCtx() {
  const nodes = { gains: [], delays: [] };
  return {
    currentTime: 0,
    state: 'running',
    destination: { __isDestination: true },
    resume: async () => {},
    createGain() {
      const node = { gain: audioParam(), _connections: [], connect(dest) { this._connections.push(dest); } };
      nodes.gains.push(node);
      return node;
    },
    createDelay(max) {
      const node = { max, delayTime: audioParam(), _connections: [], connect(dest) { this._connections.push(dest); } };
      nodes.delays.push(node);
      return node;
    },
    _nodes: nodes,
  };
}

function withFakeAudioContext(fn) {
  const prevWindow = globalThis.window;
  const ctx = fakeCtx();
  globalThis.window = { AudioContext: function AudioContext() { return ctx; } };
  try {
    return fn(ctx);
  } finally {
    globalThis.window = prevWindow;
  }
}

test('constructor wires master -> delay -> destination, not master straight to destination', () => {
  withFakeAudioContext((ctx) => {
    const ae = new AudioEngine();
    assert.equal(ae.master._connections[0], ae._delay, 'master must connect into the delay node');
    assert.equal(ae._delay._connections[0], ctx.destination, 'the delay node must connect to destination');
  });
});

test('setAudioDelayMs sets the delay node to the requested seconds', () => {
  withFakeAudioContext(() => {
    const ae = new AudioEngine();
    ae.setAudioDelayMs(250);
    assert.equal(ae._delay.delayTime.value, 0.25);
  });
});

test('setAudioDelayMs clamps a negative request to 0 -- audio can be held back, never advanced', () => {
  withFakeAudioContext(() => {
    const ae = new AudioEngine();
    ae.setAudioDelayMs(-50);
    assert.equal(ae._delay.delayTime.value, 0);
  });
});

test('setAudioDelayMs treats non-finite input as 0', () => {
  withFakeAudioContext(() => {
    const ae = new AudioEngine();
    ae.setAudioDelayMs(NaN);
    assert.equal(ae._delay.delayTime.value, 0);
    ae.setAudioDelayMs(undefined);
    assert.equal(ae._delay.delayTime.value, 0);
  });
});

test('resume returns a blocked result when the browser leaves its promise pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withFakeAudioContext(async (ctx) => {
    ctx.state = 'suspended';
    ctx.resume = () => new Promise(() => {});
    const ae = new AudioEngine();
    let result = 'pending';
    const resumed = ae.resume().then(value => { result = value; });
    t.mock.timers.tick(10000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result, false, 'a blocked browser cannot hold file loading indefinitely');
    await resumed;
  });
});

test('a later gesture can resume after an earlier attempt timed out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withFakeAudioContext(async (ctx) => {
    ctx.state = 'suspended';
    ctx.resume = () => new Promise(() => {});
    const ae = new AudioEngine();
    let firstResult = 'pending';
    const first = ae.resume().then(value => { firstResult = value; });
    t.mock.timers.tick(10000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(firstResult, false);
    await first;

    ctx.resume = async () => { ctx.state = 'running'; };
    assert.equal(await ae.resume(), true, 'the expired attempt cannot prevent a new user activation');
  });
});
