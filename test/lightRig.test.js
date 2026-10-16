import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LightRig, snapEnvelope, sweepOmega, beamAngle, beamTrianglePoints, beamAlpha,
} from '../src/world/LightRig.js';
import { FLASH_CAP } from '../src/ui/Accessibility.js';

const CANVAS = { width: 1280, height: 720 };

test('snapEnvelope: 0 before/at trigger, rises to ~1 by the attack boundary, decays afterward', () => {
  assert.equal(snapEnvelope(-10), 0);
  assert.equal(snapEnvelope(0), 0);
  assert.ok(snapEnvelope(90) > 0.99);
  let prev = snapEnvelope(90);
  for (let age = 100; age <= 2000; age += 100) {
    const v = snapEnvelope(age);
    assert.ok(v <= prev + 1e-9, `must decay monotonically past the attack, age=${age}`);
    prev = v;
  }
  assert.ok(snapEnvelope(5000) < 0.01);
});

test('sweepOmega: calm ignores tempo; hot sweeps faster for faster songs; monotonic in heat', () => {
  assert.equal(sweepOmega(300, 0), sweepOmega(900, 0), 'calm (heat=0) must ignore beatMs entirely');
  const fastHot = sweepOmega(300, 1), slowHot = sweepOmega(900, 1);
  assert.ok(fastHot > slowHot, 'a faster song must sweep faster at full heat');
  let prev = sweepOmega(500, 0);
  for (let h = 0.1; h <= 1; h += 0.1) {
    const v = sweepOmega(500, h);
    assert.ok(v >= prev - 1e-9, 'sweepOmega must not decrease as heat rises (fixed beatMs)');
    prev = v;
  }
  assert.ok(Number.isFinite(sweepOmega(0, 0.5)) && sweepOmega(0, 0.5) > 0);
  assert.ok(Number.isFinite(sweepOmega(undefined, 0.5)) && sweepOmega(undefined, 0.5) > 0);
});

test('beamAngle stays within its bounded sway/sweep envelope', () => {
  const base = 0.3, spread = 0.17, amp = 0.5, ampMul = 1;
  for (let phase = 0; phase < Math.PI * 4; phase += 0.3) {
    const a = beamAngle(base, spread, amp, ampMul, phase, 0.7);
    assert.ok(a >= base + spread - amp - 1e-9 && a <= base + spread + amp + 1e-9);
  }
  assert.equal(beamAngle(base, spread, 0, ampMul, 1.23, 0.4), base + spread);
});

test('beamTrianglePoints: tip is the anchor, both edges are exactly `length` away, angle between them is 2*halfAngle', () => {
  const { tip, left, right } = beamTrianglePoints(100, 50, 0.4, 0.2, 900);
  assert.deepEqual(tip, { x: 100, y: 50 });
  assert.ok(Math.abs(Math.hypot(left.x - 100, left.y - 50) - 900) < 1e-6);
  assert.ok(Math.abs(Math.hypot(right.x - 100, right.y - 50) - 900) < 1e-6);
  const angLeft = Math.atan2(left.y - 50, left.x - 100);
  const angRight = Math.atan2(right.y - 50, right.x - 100);
  let delta = angRight - angLeft;
  while (delta < 0) delta += Math.PI * 2;
  assert.ok(Math.abs(delta - 0.4) < 1e-6, `expected angle-between of 2*halfAngle=0.4, got ${delta}`);
});

test('beamAlpha respects FLASH_CAP under reducedFlash even at max snap/presence/budget', () => {
  const capped = beamAlpha(0.26, 1, 1, 1, true);
  assert.ok(capped <= FLASH_CAP + 1e-9);
  const uncapped = beamAlpha(0.26, 1, 1, 1, false);
  assert.ok(uncapped > FLASH_CAP, 'the snap boost should genuinely exceed FLASH_CAP unbounded');
  assert.ok(Number.isFinite(uncapped) && uncapped >= 0);
});

test('LightRig.update: sustained calm fades beams 1..N toward 0 and keeps beam 0 near 1', () => {
  const rig = new LightRig(1);
  for (let i = 0; i < 600; i++) rig.update(i * 16.7, 1 / 60, 500, 1, 1); // calmLevel=1 sustained
  assert.ok(rig.beams[0].presence > 0.9);
  for (let i = 1; i < rig.hotBeamCount; i++) assert.ok(rig.beams[i].presence < 0.1, `beam ${i} should have faded`);
});

test('LightRig.update: sustained energy brings every beam up to hotBeamCount, none beyond', () => {
  const rig = new LightRig(2);
  for (let i = 0; i < 600; i++) rig.update(i * 16.7, 1 / 60, 500, 0, 1); // calmLevel=0 sustained
  for (let i = 0; i < rig.hotBeamCount; i++) assert.ok(rig.beams[i].presence > 0.9, `beam ${i} should be present`);
  for (let i = rig.hotBeamCount; i < rig.beams.length; i++) assert.equal(rig.beams[i].presence, 0);
});

test('trigger() + update() reproduces the snapEnvelope shape and never exceeds 1', () => {
  const rig = new LightRig(3);
  rig.trigger(1000, 200, 480);
  let peak = 0;
  for (let t = 1000; t <= 3000; t += 16.7) {
    rig.update(t, 1 / 60, 500, 0.5, 1);
    peak = Math.max(peak, rig.snap);
    assert.ok(rig.snap <= 1 + 1e-6);
  }
  assert.ok(peak > 0.9, `expected the snap to peak near 1, got ${peak}`);
});

test('LightRig.update: omitted fever param is back-compat (defaults to 0, matches explicit 0)', () => {
  const a = new LightRig(5), b = new LightRig(5);
  for (let i = 0; i < 120; i++) {
    a.update(i * 16.7, 1 / 60, 500, 0.6, 1);
    b.update(i * 16.7, 1 / 60, 500, 0.6, 1, 0);
  }
  assert.ok(Math.abs(a.heat - b.heat) < 1e-9);
});

test('LightRig.update: fever pushes heat up even through a calm section', () => {
  const calm = new LightRig(6), calmHot = new LightRig(6);
  for (let i = 0; i < 600; i++) {
    calm.update(i * 16.7, 1 / 60, 500, 1, 1, 0);       // fully calm, no fever
    calmHot.update(i * 16.7, 1 / 60, 500, 1, 1, 1);     // fully calm, max fever
  }
  assert.ok(calmHot.heat > calm.heat + 0.1, `fever should raise heat despite calmLevel=1, got calm=${calm.heat} vs calmHot=${calmHot.heat}`);
});

test('LightRig.draw never throws with degenerate canvas dims, and scales beam count with particleMul', () => {
  const rig = new LightRig(4);
  for (let i = 0; i < 60; i++) rig.update(i * 16.7, 1 / 60, 500, 0, 1); // hot: full beam count present
  let fills = 0;
  const fakeCtx = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() { fills++; }, createLinearGradient() { return { addColorStop() {} }; },
    set fillStyle(_v) {}, set globalCompositeOperation(_v) {},
  };
  rig.draw(fakeCtx, CANVAS, 1000, 100, '#ffaa55', 1, false);
  const fullFills = fills;
  fills = 0;
  rig.draw(fakeCtx, CANVAS, 1000, 100, '#ffaa55', 0.6, false);
  assert.ok(fills < fullFills, `expected fewer fills at particleMul=0.6 (${fills}) than 1 (${fullFills})`);

  assert.doesNotThrow(() => rig.draw(fakeCtx, { width: 0, height: 0 }, 0, 0, '#ffffff', 1, false));
});
