import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHistoryRequest, portableHistoryText, historyMime } from '../src/ui/HistoryFiles.js';
const id = 'v-0123456789ab';
test('virtual historical paths resolve under root and project hosting', () => {
  for (const root of ['https://example.com/', 'https://example.com/Midio-5/']) {
    assert.deepEqual(parseHistoryRequest(`${root}versions/run/${id}/src/main.js`, root), { id, file: 'src/main.js' });
    assert.deepEqual(parseHistoryRequest(`${root}versions/run/${id}/`, root), { id, file: 'index.html' });
    assert.equal(parseHistoryRequest(`${root}versions/run/${id}/src/%2e%2e%2fkey`, root), null);
    assert.equal(parseHistoryRequest(`${root}versions/run/${id}/src/%5csecret`, root), null);
    assert.equal(parseHistoryRequest(`https://other.com/versions/run/${id}/`, root), null);
  }
});
test('early root URLs point to the original version without changing relative imports', () => {
  const base = `/project/versions/run/${id}/`;
  assert.equal(portableHistoryText("import '/src/world.js'; import './audio.js'; fetch('/soundfonts/a.sf2')", 'src/other.js', base, id), `import '${base}src/world.js'; import './audio.js'; fetch('${base}soundfonts/a.sf2')`);
  const html = portableHistoryText('<head><script type="module" src="./src/ui/VersionBootstrap.js"></script></head>', 'index.html', base, id);
  assert.ok(!html.includes('VersionBootstrap')); assert.ok(html.includes('midio-history:'));
  assert.equal(historyMime('src/terrain.bin.gz'), 'application/gzip');
  assert.equal(historyMime('src/module.js'), 'text/javascript; charset=utf-8');
});

test('historical title screens expose lifecycle state before their audio engine exists', async () => {
  const { HISTORY_ENGINE_BRIDGE } = await import('../src/ui/HistoryFiles.js');
  const { runInNewContext } = await import('node:vm');
  const context = { window: {}, audioEngine: null, sim: null, conductor: null, running: false, choreographyOutputLatencyMs() { throw new Error('Original old clock assumes a live audio engine'); } };
  runInNewContext(HISTORY_ENGINE_BRIDGE, context);
  const state = context.window.__MIDIO_HISTORY_ENGINE.getState();
  assert.equal(state.ready, false); assert.equal(state.positionMs, 0);
  assert.equal(context.window.__MIDIO_HISTORY_ENGINE.seek, null);
  context.audioEngine = { nowMs: 1000, ctx: { state: 'running' } }; context.sim = { songSeed: 7 }; context.running = true; context.choreographyOutputLatencyMs = () => 20;
  assert.equal(context.window.__MIDIO_HISTORY_ENGINE.getState().positionMs, 980);
  context.sim.worldId = 'custom'; context.getCustomWorld = () => ({ baseId: 'alpine' });
  assert.equal(context.window.__MIDIO_HISTORY_ENGINE.getState().settings.worldBaseId, 'alpine');
});
