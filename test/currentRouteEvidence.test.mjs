import test from 'node:test';
import assert from 'node:assert/strict';

const { validateRoutePlayback, summarizeRouteRun } = await import('../tools/lib/current-route-evidence.mjs')
  .catch(error => assert.fail(`current-route evidence gate is missing: ${error.message}`));

function sample(time = 1000, frameId = 10) {
  return { audioMs: time, bufferDurationMs: 30000, contextTime: time / 1000, simMs: time, heardMs: time,
    audioState: 'running', playing: true, hasBuffer: true, paused: false, preparing: false,
    hidden: false, generation: 1, experience: 'landscape', worldKind: 'alpine', trio: false, pickerOpen: false,
    frame: { presented: true, generation: 2, frameId },
    capture: { presented: true, generation: 2, frameId }, colors: 25,
    range: { mode: 'v2', requestedMode: 'v2', resolvedMode: 'v2', active: true,
      runtime: 'ready', runtimeReady: true, viewId: 'teton-jackson-lake', tourMode: null,
      tourPreparation: { state: 'off' } } };
}

test('current Landscape requires advancing decoded audio and distinct completed composed frames', () => {
  assert.doesNotThrow(() => validateRoutePlayback('landscape', [sample(), sample(2000, 12)]));
  const frozen = sample(2000, 10);
  assert.throws(() => validateRoutePlayback('landscape', [sample(), frozen]), /completed frame.*advance/i);
  assert.throws(() => validateRoutePlayback('landscape', [sample(), sample(1000, 12)]), /audio.*advance/i);
});

test('failed or mismatched final captures cannot be credited as completed playback', () => {
  for (const change of [s => { s.frame.presented = false; }, s => { s.capture = null; },
    s => { s.capture.frameId = 8; }, s => { s.capture.generation = 5; },
    s => { s.colors = 1; }, s => { s.hidden = true; }, s => { s.preparing = true; },
    s => { s.hasBuffer = false; }, s => { s.audioState = 'suspended'; }, s => { s.paused = true; },
    s => { s.contextTime = NaN; }, s => { s.colors = Infinity; },
    s => { delete s.frame.generation; delete s.capture.generation; },
    s => { s.bufferDurationMs = 1500; }, s => { s.bufferDurationMs = NaN; }]) {
    const after = sample(2000, 12); change(after);
    assert.throws(() => validateRoutePlayback('landscape', [sample(), after]));
  }
  const replacement = sample(2000, 12); replacement.generation = 2;
  assert.throws(() => validateRoutePlayback('landscape', [sample(), replacement]), /generation/i);
});

test('ordinary playback cannot pass behind a world-picker modal', () => {
  const after = sample(2000, 12); after.pickerOpen = true;
  assert.throws(() => validateRoutePlayback('landscape', [sample(), after]), /picker/i);
});

test('default Landscape cannot pass through legacy fallback or an enabled tour', () => {
  for (const change of [s => { s.range.mode = 'legacy'; }, s => { s.range.resolvedMode = 'legacy'; },
    s => { s.range.active = false; }, s => { s.range.tourMode = 'tetons'; }]) {
    const after = sample(2000, 12); change(after);
    assert.throws(() => validateRoutePlayback('landscape', [sample(), after]), /Landscape|v2|tour/i);
  }
});

test('selected and persisted tours require the active ready Tetons provider', () => {
  const tourSample = (time, id) => {
    const value = sample(time, id);
    Object.assign(value.range, { tourMode: 'tetons', viewId: 'teton-range-tour',
      selectedViewId: 'teton-range-tour', tourPreparation: { state: 'ready' } });
    return value;
  };
  for (const route of ['tour-selected', 'tour-persisted']) {
    assert.doesNotThrow(() => validateRoutePlayback(route, [tourSample(1000, 10), tourSample(2000, 12)]));
    const failed = tourSample(2000, 12); failed.range.tourPreparation.state = 'failed';
    assert.throws(() => validateRoutePlayback(route, [tourSample(1000, 10), failed]), /tour/i);
  }
});

test('Trio requires real actors and completed output without active scenic terrain', () => {
  const trio = (time, id) => ({ ...sample(time, id), experience: 'trio', trio: true,
    range: { mode: 'legacy', active: false } });
  assert.doesNotThrow(() => validateRoutePlayback('trio', [trio(1000, 10), trio(2000, 12)]));
  const terrain = trio(2000, 12); terrain.range.active = true;
  assert.throws(() => validateRoutePlayback('trio', [trio(1000, 10), terrain]), /Trio/i);
});

test('partial route runs and known failures remain failed acceptance results', () => {
  const complete = ['landscape', 'tour-selected', 'tour-persisted', 'trio'].map(id => ({ id, status: 'passed', errors: [], events: [] }));
  assert.equal(summarizeRouteRun(complete), 'passed');
  assert.equal(summarizeRouteRun(complete.slice(0, 1)), 'failed');
  assert.equal(summarizeRouteRun([...complete.slice(0, 3), { id: 'trio', status: 'known-failure' }]), 'failed');
  assert.equal(summarizeRouteRun([...complete, { id: 'trio', status: 'passed' }]), 'failed');
  assert.throws(() => validateRoutePlayback('unknown', [sample(), sample(2000, 12)]), /unknown/i);
  complete[3].errors.push('late graphics failure');
  assert.equal(summarizeRouteRun(complete), 'failed', 'late diagnostics cannot preserve a passed result');
});
