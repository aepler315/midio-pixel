import assert from 'node:assert/strict';

export const CURRENT_ROUTES = ['landscape', 'tour-selected', 'tour-persisted', 'trio'];

// Acceptance uses the final presentation contract, rather than draw attempts,
// changed pixels alone, or an audio clock running behind a failed renderer.
export function validateRoutePlayback(route, samples) {
  assert.ok(CURRENT_ROUTES.includes(route), `unknown current route: ${route}`);
  assert.ok(Array.isArray(samples) && samples.length >= 2, 'missing playback samples');
  for (const s of samples) {
    for (const field of ['audioMs', 'bufferDurationMs', 'contextTime', 'simMs', 'heardMs', 'generation']) {
      assert.ok(Number.isFinite(s[field]), `invalid ${field}`);
    }
    assert.ok(s.playing && s.hasBuffer && s.audioState === 'running', 'decoded audio is not playing');
    assert.ok(s.audioMs >= 0 && s.audioMs < s.bufferDurationMs, 'decoded audio buffer has ended');
    assert.ok(!s.paused && !s.preparing && !s.hidden, 'playback is paused, preparing or hidden');
    assert.equal(s.pickerOpen, false, 'ordinary playback is behind the world picker');
    assert.ok(s.frame?.presented && Number.isSafeInteger(s.frame.frameId) && s.frame.frameId > 0
      && Number.isSafeInteger(s.frame.generation), 'no completed frame with valid identity');
    assert.ok(s.capture?.presented && s.capture.frameId === s.frame.frameId
      && s.capture.generation === s.frame.generation, 'final capture does not match the completed frame');
    assert.ok(Number.isSafeInteger(s.colors) && s.colors > 16, 'completed frame is blank or lacks a composed scene');
    if (route === 'trio') {
      assert.ok(s.experience === 'trio' && s.trio && !s.range?.active, 'Trio actors or terrain ownership are incorrect');
    } else {
      assert.ok(s.experience === 'landscape' && s.worldKind === 'alpine', 'Landscape world is not active');
      const r = s.range;
      assert.ok(r?.mode === 'v2' && r.requestedMode === 'v2' && r.resolvedMode === 'v2'
        && r.active && r.runtime === 'ready' && r.runtimeReady, 'Landscape v2 is not active and ready');
      if (route === 'landscape') {
        assert.ok(!r.tourMode && r.viewId !== 'teton-range-tour', 'default Landscape unexpectedly uses a tour');
      } else {
        assert.ok(r.tourMode === 'tetons' && r.viewId === 'teton-range-tour'
          && r.selectedViewId === 'teton-range-tour' && r.tourPreparation?.state === 'ready', 'Tetons tour is not active and ready');
      }
    }
  }
  const first = samples[0], last = samples.at(-1);
  assert.equal(last.generation, first.generation, 'song generation changed during playback');
  assert.ok(last.audioMs > first.audioMs + 200 && last.contextTime > first.contextTime + .2,
    'decoded audio clocks did not advance');
  assert.ok(last.simMs > first.simMs && last.heardMs > first.heardMs, 'simulation clocks did not advance');
  assert.equal(last.frame.generation, first.frame.generation, 'presentation generation changed during playback');
  assert.ok(last.frame.frameId > first.frame.frameId, 'completed frame identifiers did not advance');
}

export function summarizeRouteRun(routes) {
  return routes.length === CURRENT_ROUTES.length
    && new Set(routes.map(row => row.id)).size === CURRENT_ROUTES.length
    && CURRENT_ROUTES.every(id => routes.some(row => row.id === id && row.status === 'passed'
      && Array.isArray(row.errors) && row.errors.length === 0 && !row.events?.some(event => event.fatal)))
    ? 'passed' : 'failed';
}
