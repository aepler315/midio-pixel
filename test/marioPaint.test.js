import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ComposerStrip, iconFor, popBump, stratifyCap, STAFF_ROWS, diatonicIndex, estimateTonicPc,
  buildSongMountain, formLetter,
} from '../src/render/ComposerStrip.js';
import { RainbowBrush } from '../src/render/RainbowBrush.js';
import { ImpactFX } from '../src/sim/ImpactFX.js';
import { Role } from '../src/core/NoteEvent.js';

function note(tMs, role, pitch = 60, vel = 0.7, kick = false) {
  return { tMs, role, pitch, vel, kick };
}

const BAR_GRID = Array.from({ length: 16 }, (_, i) => ({ ms: i * 2000 }));
const STAGE = { width: 1280, height: 720 };

test('ComposerStrip builds a full-song mountain and reports playhead frac', () => {
  const timeline = [note(100, Role.MELODY), note(7900, Role.BASS), note(8100, Role.PAD)];
  const strip = new ComposerStrip(timeline, BAR_GRID, 32000);
  assert.equal(strip.durationMs, 32000);
  assert.ok(strip.mountain.length >= 8);
  assert.equal(strip.pageIndexAt(7999), 0);
  assert.equal(strip.pageIndexAt(8000), 1);
  assert.ok(Math.abs(strip.playheadFrac(16000) - 0.5) < 1e-9);
  assert.ok(Math.abs(strip.playheadFrac(0)) < 1e-9);
  assert.ok(Math.abs(strip.playheadFrac(32000) - 1) < 1e-9);
});

test('buildSongMountain normalizes to 0..1 and peaks where energy is densest', () => {
  const timeline = [];
  // Dense cluster mid-song
  for (let i = 0; i < 40; i++) timeline.push(note(16000 + i * 20, Role.MELODY, 60, 1));
  // Sparse notes elsewhere
  timeline.push(note(1000, Role.MELODY, 60, 0.3));
  timeline.push(note(30000, Role.MELODY, 60, 0.3));
  const h = buildSongMountain(timeline, 32000, 64);
  assert.equal(h.length, 64);
  let max = 0, maxI = 0;
  for (let i = 0; i < h.length; i++) {
    assert.ok(h[i] >= 0 && h[i] <= 1);
    if (h[i] > max) { max = h[i]; maxI = i; }
  }
  assert.ok(max > 0.5, 'peak should be strong');
  // Mid-song cluster around sample 32
  assert.ok(maxI > 20 && maxI < 45, `peak index ${maxI} should sit mid-song`);
});

test('buildSongMountain empty timeline still returns a soft silhouette', () => {
  const h = buildSongMountain([], 10000, 32);
  assert.equal(h.length, 32);
  for (const v of h) assert.ok(v > 0 && v < 0.5);
});

test('formLetter maps 0,1,25,26 → A,B,Z,AA', () => {
  assert.equal(formLetter(0), 'A');
  assert.equal(formLetter(1), 'B');
  assert.equal(formLetter(25), 'Z');
  assert.equal(formLetter(26), 'AA');
  assert.equal(formLetter(-1), '?');
});

test('stratifyCap still prefers the loudest notes within each time slot', () => {
  const events = [];
  for (let i = 0; i < 128; i++) {
    events.push(note(i * 62.5, Role.MELODY, 60, i % 2 ? 0.9 : 0.3));
  }
  const kept = stratifyCap(events, 32, 0, 8000);
  assert.equal(kept.length, 32);
  const loudShare = kept.filter((e) => e.vel > 0.5).length / kept.length;
  assert.ok(loudShare >= 0.9, `loud notes should dominate the kept set, got ${loudShare}`);
});

test('hitTest maps strip x to song time and section index', () => {
  const sections = [
    { startMs: 0, endMs: 10000, label: 0, profile: 'meadow', transition: 'fade' },
    { startMs: 10000, endMs: 32000, label: 1, profile: 'alpine', transition: 'cut', kind: 'chorus' },
  ];
  const strip = new ComposerStrip([note(0, Role.MELODY)], BAR_GRID, 32000, [], sections);
  const L = strip.layout(STAGE);
  // Left edge of strip → near t=0, section 0
  const left = strip.hitTest(L.x0 + 8, L.y0 + L.h / 2, STAGE);
  assert.equal(left.type, 'strip');
  assert.ok(left.tMs < 2000, `left tMs=${left.tMs}`);
  assert.equal(left.sectionIndex, 0);
  // Past midpoint → second section
  const mid = strip.hitTest(L.x0 + L.w * 0.75, L.y0 + L.h / 2, STAGE);
  assert.equal(mid.type, 'strip');
  assert.ok(mid.tMs > 20000, `mid tMs=${mid.tMs}`);
  assert.equal(mid.sectionIndex, 1);
  // Above strip, no selection → null
  assert.equal(strip.hitTest(L.x0 + 10, L.y0 - 40, STAGE), null);
});

test('toggleLabels and selectedSection are independent', () => {
  const sections = [
    { startMs: 0, endMs: 16000, label: 0, profile: 'meadow', transition: 'fade' },
    { startMs: 16000, endMs: 32000, label: 1, profile: 'ocean', transition: 'shutter' },
  ];
  const strip = new ComposerStrip([], BAR_GRID, 32000, [], sections);
  assert.equal(strip.showLabels, false);
  assert.equal(strip.toggleLabels(), true);
  assert.equal(strip.showLabels, true);
  strip.selectedSection = 1;
  assert.equal(strip.toggleLabels(), false);
  // Labels off does not clear a debug section selection.
  assert.equal(strip.selectedSection, 1);
});

test('diatonicIndex: ascending pitch never decreases in diatonic step (C4 < D4 < E4)', () => {
  const tonicPc = 0; // C
  const c4 = diatonicIndex(60, tonicPc);
  const d4 = diatonicIndex(62, tonicPc);
  const e4 = diatonicIndex(64, tonicPc);
  assert.ok(c4.step < d4.step && d4.step < e4.step, `expected ascending steps, got ${c4.step}, ${d4.step}, ${e4.step}`);
  assert.equal(c4.accidental, false);
  assert.equal(d4.accidental, false);
  assert.equal(e4.accidental, false);
  const c5 = diatonicIndex(72, tonicPc);
  assert.equal(c5.step - c4.step, 7);
});

test('diatonicIndex: accidentals flagged relative to the tonic\'s major scale', () => {
  assert.equal(diatonicIndex(60, 0).accidental, false); // C
  assert.equal(diatonicIndex(61, 0).accidental, true);  // C#
  assert.equal(diatonicIndex(62, 0).accidental, false); // D
  assert.equal(diatonicIndex(65, 0).accidental, false); // F
  assert.equal(diatonicIndex(66, 0).accidental, true);  // F#
});

test('diatonicIndex: step is monotone non-decreasing across a full chromatic run', () => {
  let prevStep = -Infinity;
  for (let p = 40; p <= 100; p++) {
    const { step } = diatonicIndex(p, 3);
    assert.ok(step >= prevStep, `step decreased at pitch ${p}`);
    prevStep = step;
  }
});

test('estimateTonicPc: weighted by duration*velocity, ignores RHYTHM, empty -> C', () => {
  assert.equal(estimateTonicPc([]), 0);
  assert.equal(estimateTonicPc([{ role: Role.RHYTHM, pitch: 36, durMs: 90, vel: 1 }]), 0);
  const timeline = [
    { role: Role.MELODY, pitch: 60, durMs: 4000, vel: 0.9 },
    { role: Role.MELODY, pitch: 67, durMs: 50, vel: 0.2 },
    { role: Role.RHYTHM, pitch: 42, durMs: 4000, vel: 1 },
  ];
  assert.equal(estimateTonicPc(timeline), 0);
});

test('ComposerStrip constructor stays DOM-free', () => {
  assert.doesNotThrow(() => new ComposerStrip(
    [note(0, Role.MELODY, 60), note(10, Role.RHYTHM, 36, 0.8, true)], BAR_GRID, 32000,
  ));
});

test('icon language maps every role, with the kick getting the wheel', () => {
  assert.equal(iconFor({ role: Role.RHYTHM, kick: true }), 'wheel');
  assert.equal(iconFor({ role: Role.RHYTHM, kick: false }), 'drum');
  assert.equal(iconFor({ role: Role.MELODY }), 'star');
  assert.equal(iconFor({ role: Role.BASS }), 'heart');
  assert.equal(iconFor({ role: Role.PAD }), 'flower');
});

test('popBump peaks right at the onset and dies away outside the pop window', () => {
  assert.ok(popBump(30) > 0.95);
  assert.ok(popBump(30) > popBump(120));
  assert.equal(popBump(-200), 0);
  assert.equal(popBump(400), 0);
});

test('RainbowBrush paints only while airborne, respects stroke spacing, caps and expires dabs', () => {
  const brush = new RainbowBrush();
  brush.update(0, false, 0, 400);
  assert.equal(brush.dabs.length, 0);

  for (let i = 0; i <= 90; i++) brush.update(i * 10, true, i * 3, 400 - i);
  const afterSweep = brush.dabs.length;
  assert.ok(afterSweep > 10 && afterSweep < 91, `spacing should thin the stroke, got ${afterSweep}`);

  for (let i = 0; i < 50; i++) brush.update(1000 + i, true, 270, 310);
  assert.equal(brush.dabs.length, afterSweep);

  for (let i = 0; i < 5000; i++) brush.update(2000 + i, true, 300 + i * 10, 400);
  assert.ok(brush.dabs.length <= 320);
});

test('paint splats spawn chunky blobs and age out through the pool', () => {
  const fx = new ImpactFX(3);
  fx.splat(1000, 480);
  assert.equal(fx.splats.active.length, 1);
  const splat = fx.splats.active[0];
  assert.ok(splat.blobs.length >= 6);
  for (const b of splat.blobs) assert.ok(Number.isFinite(b.dx + b.dy + b.s));

  for (let i = 0; i < 400; i++) fx.step(1 / 120);
  assert.equal(fx.splats.active.length, 0);
});

// Keep STAFF_ROWS exported for any remaining consumers.
test('STAFF_ROWS is a positive odd staff height', () => {
  assert.ok(STAFF_ROWS >= 5 && STAFF_ROWS % 2 === 1);
});
