import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraStudioPanelState,
  readCameraStudioSettings,
  writeCameraStudioSettings,
} from '../src/ui/CameraStudioPanel.js';

const storage = value => {
  const data = new Map(value === undefined ? [] : [['midio.cameraStudio.v1', value]]);
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, next) => data.set(key, next) };
};

test('camera studio stays opt-in and preserves controls across reloads', () => {
  const store = storage();
  assert.equal(readCameraStudioSettings(store).enabled, false);
  assert.equal(writeCameraStudioSettings(store, {
    enabled: true, preset: 'orbit', distance: 1.2, direction: 'ccw', orbitSeconds: 120,
  }), true);
  const restored = readCameraStudioSettings(store);
  assert.equal(restored.enabled, true);
  assert.equal(restored.preset, 'orbit');
  assert.equal(restored.distance, 1.2);
  assert.equal(restored.direction, 'ccw');
  assert.equal(restored.orbitSeconds, 120);
  assert.deepEqual([...store.data.keys()], ['midio.cameraStudio.v1']);
});

test('camera studio reads malformed or blocked storage without breaking playback', () => {
  for (const value of ['{bad', 'null', '[]', 'false', '12', '"orbit"']) {
    const store = storage(value);
    assert.equal(readCameraStudioSettings(store).enabled, false, value);
    assert.equal(store.data.get('midio.cameraStudio.v1'), value);
  }
  const blocked = { getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); } };
  for (const store of [null, undefined, {}, blocked]) {
    assert.equal(readCameraStudioSettings(store).enabled, false);
    assert.equal(writeCameraStudioSettings(store, { enabled: true }), false);
  }
});

test('camera studio persistence validates saved controls and drops unknown values', () => {
  const store = storage(JSON.stringify({ enabled: true, distance: 900, unexpected: 'discard' }));
  assert.equal(readCameraStudioSettings(store).distance, 1.8);
  const settings = Object.freeze({ enabled: false, distance: 1.3, unexpected: 'discard' });
  assert.equal(writeCameraStudioSettings(store, settings), true);
  const saved = JSON.parse(store.data.get('midio.cameraStudio.v1'));
  assert.equal(saved.enabled, false);
  assert.equal(saved.distance, 1.3);
  assert.equal('unexpected' in saved, false);
  assert.equal(settings.unexpected, 'discard');
});

test('camera studio overlay only appears for enabled live landscapes', () => {
  const cases = [
    [{ enabled: false }, { running: true, available: true }, false],
    [{ enabled: true }, { running: false, available: true }, false],
    [{ enabled: true }, { running: true, available: false }, false],
    [{ enabled: true }, { running: true, available: true }, true],
  ];
  for (const [settings, state, visible] of cases) {
    assert.equal(cameraStudioPanelState(settings, state).visible, visible);
  }
});

test('snapshot work locks all camera controls while crop views lock position only', () => {
  const live = { running: true, available: true };
  assert.equal(cameraStudioPanelState({ enabled: true }, live).disabled, false);
  const crop = cameraStudioPanelState({ enabled: true }, { ...live, positionEnabled: false });
  assert.equal(crop.disabled, false);
  assert.equal(crop.positionDisabled, true);
  const busy = cameraStudioPanelState({ enabled: true }, { ...live, busy: true });
  assert.equal(busy.visible, true);
  assert.equal(busy.disabled, true);
  assert.equal(busy.positionDisabled, true);
});
