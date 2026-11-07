import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mistParams, mistLocalOccupancy, mistBankPulse, mistAmount, seaSubmersion, actorLightShown, emitterVisibility, MIST_GLSL, MIST_FLOW_SPEED_MPS, MIST_BANK_HEIGHT_MAX_M } from '../src/world/alpine/RangeAtmosphere.js';

// A low source at x=0 climbs a valley to x=4000; z=1000 is a ridge.
function flowFixture() {
  const width = 5, height = 2, texture = new Uint8Array(width * height * 4);
  for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) {
    const i = (z * width + x) * 4;
    texture.set([Math.round((z ? 800 : x * 80) / 1000 * 255), z ? 0 : 255, Math.round(x / 4 * 255), 255], i);
  }
  return { width, height, texture, originM: [0, 0], extentM: [4000, 1000], heightRange: [0, 1000], distanceM: 4000 };
}
const state = (fill, extra = {}) => mistParams({ rules: { wetness: .7 }, waterLevelM: 0, sea01: fill, flow: flowFixture(), ...extra });

test('formation starts at low drainage sources and reaches upstream ground gradually', () => {
  const source = [0, 12, 0], upper = [4000, 332, 0];
  assert.equal(mistLocalOccupancy(source, state(0)), 0);
  assert.ok(mistLocalOccupancy(source, state(.2)) > .01, 'a low bank forms first');
  assert.equal(mistLocalOccupancy(upper, state(.2)), 0, 'upper valley waits for arrival');
  assert.ok(mistLocalOccupancy(upper, state(1)) > .02, 'formation travels uphill');
  let previous = 0;
  for (let k = 0; k <= 100; k++) {
    const value = mistLocalOccupancy(source, state(k / 100));
    assert.ok(Math.abs(value - previous) < .08, 'no spawn jump'); previous = value;
  }
});

test('local banks stay below ridges and remain low above rising valley ground', () => {
  const full = state(1);
  assert.ok(mistLocalOccupancy([2000, 172, 0], full) > .02);
  assert.equal(mistLocalOccupancy([2000, 812, 1000], full), 0, 'ridge has no cloud-sea occupancy');
  assert.equal(mistLocalOccupancy([2000, 160 + MIST_BANK_HEIGHT_MAX_M + 1, 0], full), 0);
  assert.equal(mistLocalOccupancy([4000, 320 + 200, 0], full), 0, 'no world-height flood plane');
  const risen = state(1, { riseSink: .6, riseBaseM: -100 });
  const drawn = 160 - .6 * (160 + 100);
  assert.ok(mistLocalOccupancy([2000, drawn + 12, 0], risen) > .02, 'bank follows drawn ground during song rise');
});

test('bank phase travels upstream and pause/seek reconstruct the same shape', () => {
  for (const time of [0, 12, 96, 212]) {
    assert.ok(Math.abs(mistBankPulse(840, time) - mistBankPulse(840 + MIST_FLOW_SPEED_MPS * 8, time + 8)) < 1e-12);
  }
  const full = state(1, { tSec: 42 });
  assert.equal(mistLocalOccupancy([2000, 172, 0], full), mistLocalOccupancy([2000, 172, 0], full));
  assert.notEqual(mistLocalOccupancy([2000, 172, 0], full), mistLocalOccupancy([2000, 172, 0], { ...full, tSec: 180 }));
});

test('missing-field banks and ordinary haze follow the song rise exactly once', () => {
  const m = mistParams({ sea01: 1, waterLevelM: 800, riseSink: .5, riseBaseM: 100, rules: { wetness: .7 } });
  assert.equal(m.baseM, 450);
  assert.ok(mistLocalOccupancy([0, 462, 0], m) > .02, 'fallback bank sits on drawn floor');
  assert.equal(mistLocalOccupancy([0, 287, 0], m), 0, 'the fallback never applies the rise a second time');
  let last = m.baseM;
  for (let k = 1; k <= 100; k++) {
    const next = mistParams({ waterLevelM: 800, riseSink: .5 + k / 200, riseBaseM: 100 }).baseM;
    assert.ok(next <= last && last - next < 4, 'base moves continuously'); last = next;
  }
});

test('camera altitude never changes formation or its height', () => {
  const low = state(.6, { cameraY: -1000 }), high = state(.6, { cameraY: 20000 });
  assert.deepEqual(low, high);
});

test('emitter and its light share local occupancy without a floor-wide blackout', () => {
  const full = state(1), p = [2000, 172, 0], ridge = [2000, 812, 1000];
  const occupied = seaSubmersion(p, full);
  assert.ok(occupied > 0 && occupied < 1);
  assert.equal(seaSubmersion(ridge, full), 0);
  assert.equal(actorLightShown(ridge, full), 1);
  assert.ok(actorLightShown(p, full) > 0 && actorLightShown(p, full) < 1);
  const eye = [2000, 300, -100];
  assert.ok(Math.abs(emitterVisibility(eye, p, full) - (1 - mistAmount(eye, p, full)) * actorLightShown(p, full)) < 1e-12);
  assert.equal(emitterVisibility(eye, p, { ...full, density: 0 }), 1, 'zero density clears the bank and its emitters together');
});

test('missing fields produce irregular low banks and density fades continuously', () => {
  const full = mistParams({ sea01: 1, waterLevelM: 100, rules: { wetness: .7 } });
  const values = Array.from({ length: 20 }, (_, k) => mistLocalOccupancy([k * 170, 112, -k * 61], full));
  assert.ok(Math.max(...values) - Math.min(...values) > .1);
  assert.equal(mistLocalOccupancy([0, 100 + MIST_BANK_HEIGHT_MAX_M + 1, 0], full), 0);
  const eye = [0, 112, -1000], p = [1000, 112, 0];
  let last = 0, lastLight = 1;
  for (let k = 0; k <= 50; k++) {
    const fade = { ...full, density: full.density * k / 50 };
    const value = mistAmount(eye, p, fade), light = actorLightShown(p, fade);
    assert.ok(value >= last && value - last < .1); last = value;
    assert.ok(light <= lastLight && lastLight - light < .03, 'local emitter fade is continuous at zero');
    lastLight = light;
  }
});

test('the ray samples one packed terrain field and one bank mask at each quality endpoint', () => {
  const body = MIST_GLSL.slice(MIST_GLSL.indexOf('float mistBanks('), MIST_GLSL.indexOf('float mistAmount('));
  assert.equal((body.match(/mistMaskAt\(/g) || []).length, 1);
  assert.equal((body.match(/mistFlowAt\(/g) || []).length, 1);
  assert.equal((MIST_GLSL.match(/texture\(uMistFlow,/g) || []).length, 1);
  assert.doesNotMatch(MIST_GLSL, /mistSlabInt|cam\.y - uMistTop|mistSubmersion\(float/);
  assert.match(MIST_GLSL, /textureSize\(uMistFlow, 0\)/);
});

test('steep views retain shallow banks across the two-to-six sample ladder', () => {
  const width = 32, height = 32, texture = new Uint8Array(width * height * 4);
  for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) {
    texture.set([Math.round(z / (height - 1) * .8 * 255), Math.round((1 - Math.abs(x / (width - 1) * 2 - 1)) * 255),
      Math.round(z / (height - 1) * 255), 255], (z * width + x) * 4);
  }
  const flow = { width, height, texture, originM: [-2000, 0], extentM: [4000, 10000], heightRange: [0, 100], distanceM: 10000 };
  const full = mistParams({ sea01: 1, waterLevelM: 0, rules: { wetness: .7 }, flow, tSec: 43 });
  for (const eyeY of [160, 500, 1200, 2400]) {
    const mean = steps => {
      let total = 0, count = 0;
      for (let x = -1800; x <= 1800; x += 400) for (let z = 1000; z <= 9500; z += 1000) {
        total += mistAmount([0, eyeY, -100], [x, 80 * z / 10000 + 8, z], { ...full, steps }); count++;
      }
      return total / count;
    };
    const reference = mean(6);
    for (const steps of [2, 3, 4]) assert.ok(Math.abs(mean(steps) / reference - 1) < .1,
      `${steps} samples preserve the shallow layer from ${eyeY}m`);
  }
});

test('rays following uphill ground retain the same bank depth at every quality endpoint', () => {
  const options = rise => ({ width: 2, height: 2, texture: new Uint8Array([0,255,0,255,255,255,0,255,0,255,0,255,255,255,0,255]),
    originM: [0, -100], extentM: [20000, 200], heightRange: [0, Math.max(1, rise)], distanceM: 20000 });
  const bankDepth = (rise, steps) => {
    const flow = options(rise);
    if (rise === 0) for (let i = 0; i < flow.texture.length; i += 4) flow.texture[i] = 0;
    const m = mistParams({ sea01: 1, waterLevelM: 0, rules: { wetness: .05 }, flow });
    const cam = [0, 10, 0], p = [20000, rise + 10, 0];
    const all = mistAmount(cam, p, { ...m, steps }), ordinary = mistAmount(cam, p, { ...m, fill: 0, steps });
    return (-Math.log1p(-all) + Math.log1p(-ordinary)) / Math.hypot(20000, rise);
  };
  const horizontal = bankDepth(0, 6);
  for (const rise of [0, 500, 2000]) for (const steps of [2, 3, 4, 6]) {
    assert.ok(Math.abs(bankDepth(rise, steps) / horizontal - 1) < .001, `${rise}m climb, ${steps} samples`);
  }
});
