import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import {
  BUILD_KIND, classifyBuildSection, analyzeBuildCharacter, attachBuildCharacter,
  sampleBuildCharacter, glowTameFor, glowMulFromTame,
} from '../src/audio/BuildCharacter.js';

function paint({ durationMs = 120000, energyAt, bandsAt } = {}) {
  const ec = new EnergyCurves(durationMs, 50);
  for (let i = 0; i < ec.n; i++) {
    const t01 = ec.n > 1 ? i / (ec.n - 1) : 0;
    const e = energyAt ? energyAt(t01) : 0.4;
    const shares = bandsAt ? bandsAt(t01) : [1, 1, 1, 1, 1, 1, 1];
    let sum = 0;
    for (const s of shares) sum += s;
    ec.setFrame(i, shares.map((s) => Math.max(0, e * s / (sum || 1))));
  }
  return ec;
}

// Dark mid-heavy spectrum that gets darker as it gets louder.
function tensionBands(t01) {
  const darken = 0.35 + 0.65 * t01;
  return [0.9 * darken, 1.1 * darken, 1.4, 1.3, 0.8, 0.25, 0.12];
}

// Opening spectrum: air and presence arrive with the climb.
function driveBands(t01) {
  const open = 0.4 + 0.6 * t01;
  return [0.55, 0.65, 0.5, 0.45, 0.85, 1.35 * open, 1.6 * open];
}

test('a quiet section stays calm and does not tame glow', () => {
  const curves = paint({ energyAt: () => 0.22 });
  const climate = classifyBuildSection({
    startMs: 0, endMs: 30000, energyCurves: curves,
  });
  assert.equal(climate.kind, BUILD_KIND.CALM);
  assert.equal(climate.isHighEnergy, false);
  assert.equal(climate.glowTame01, 0);
});

test('a dark rising swell with few onsets is melancholic tension', () => {
  const curves = paint({
    durationMs: 60000,
    energyAt: (t) => 0.35 + 0.55 * t,
    bandsAt: tensionBands,
  });
  const climate = classifyBuildSection({
    startMs: 0, endMs: 60000, energyCurves: curves,
    onsets: [{ tMs: 8000, vel: 0.4 }, { tMs: 24000, vel: 0.4 }, { tMs: 42000, vel: 0.4 }],
    analysis: { mode: 'minor', majorness: -0.7, tonalConfidence: 0.8 },
  });
  assert.equal(climate.kind, BUILD_KIND.TENSION);
  assert.ok(climate.isHighEnergy, 'the climb crosses the high-energy knee');
  assert.ok(climate.isBuild, 'last third is louder than first third');
  assert.ok(climate.tension01 > climate.drive01 + 0.08, `tension ${climate.tension01} vs drive ${climate.drive01}`);
  assert.ok(climate.glowTame01 >= 0.35, `tension must lid the glow, got ${climate.glowTame01}`);
});

test('a bright rising swell with kicks is a clean drive', () => {
  const curves = paint({
    durationMs: 60000,
    energyAt: (t) => 0.35 + 0.55 * t,
    bandsAt: driveBands,
  });
  const onsets = [];
  for (let t = 0; t < 60000; t += 240) onsets.push({ tMs: t, vel: 0.85, kick: true });
  const climate = classifyBuildSection({
    startMs: 0, endMs: 60000, energyCurves: curves, onsets,
    analysis: { mode: 'major', majorness: 0.75, tonalConfidence: 0.85 },
  });
  assert.equal(climate.kind, BUILD_KIND.DRIVE);
  assert.ok(climate.drive01 > climate.tension01 + 0.08, `drive ${climate.drive01} vs tension ${climate.tension01}`);
  assert.ok(climate.glowTame01 > 0 && climate.glowTame01 <= 0.22, `drive tames modestly, got ${climate.glowTame01}`);
  assert.ok(climate.glowTame01 < 0.35, 'drive must not use the tension lid');
});

test('the same energy envelope classifies differently when the spectrum and hits change', () => {
  const rise = (t) => 0.4 + 0.5 * t;
  const dark = classifyBuildSection({
    startMs: 0, endMs: 45000,
    energyCurves: paint({ durationMs: 45000, energyAt: rise, bandsAt: tensionBands }),
    onsets: [{ tMs: 10000, vel: 0.3 }],
    analysis: { mode: 'minor', majorness: -0.6, tonalConfidence: 0.7 },
  });
  const onsets = [];
  for (let t = 0; t < 45000; t += 250) onsets.push({ tMs: t, vel: 0.85, kick: true });
  const bright = classifyBuildSection({
    startMs: 0, endMs: 45000,
    energyCurves: paint({ durationMs: 45000, energyAt: rise, bandsAt: driveBands }),
    onsets,
    analysis: { mode: 'major', majorness: 0.7, tonalConfidence: 0.7 },
  });
  assert.equal(dark.kind, BUILD_KIND.TENSION);
  assert.equal(bright.kind, BUILD_KIND.DRIVE);
  assert.ok(dark.glowTame01 > bright.glowTame01 + 0.15, 'tension lids glow harder than drive');
});

test('glow tame is 0 for calm and never kills the multiplier', () => {
  assert.equal(glowTameFor({ kind: BUILD_KIND.CALM, isHighEnergy: false }), 0);
  const tension = glowTameFor({ kind: BUILD_KIND.TENSION, tension01: 1, energy01: 1, isHighEnergy: true });
  const drive = glowTameFor({ kind: BUILD_KIND.DRIVE, drive01: 1, energy01: 1, isHighEnergy: true });
  assert.ok(tension > drive);
  assert.ok(glowMulFromTame(1) >= 0.12);
  assert.equal(glowMulFromTame(0), 1);
});

test('glow tame weights stay locked to the published mix', () => {
  assert.equal(
    glowTameFor({ kind: BUILD_KIND.TENSION, tension01: 0.8, isHighEnergy: true }),
    0.35 + 0.50 * 0.8,
  );
  assert.equal(
    glowTameFor({ kind: BUILD_KIND.DRIVE, energy01: 0.78, isHighEnergy: true }),
    0.08 + 0.12 * 1,
  );
  assert.equal(
    glowTameFor({ kind: BUILD_KIND.MIXED, tension01: 0.4, isHighEnergy: true }),
    0.20 + 0.25 * 0.4,
  );
});

test('analyze + attach writes climate onto the section records', () => {
  const sections = [
    { startMs: 0, endMs: 30000 },
    { startMs: 30000, endMs: 90000 },
  ];
  const curves = paint({
    energyAt: (t) => (t < 0.25 ? 0.2 : 0.4 + 0.5 * ((t - 0.25) / 0.75)),
    bandsAt: (t) => (t < 0.25 ? [1, 1, 1, 1, 1, 1, 1] : tensionBands((t - 0.25) / 0.75)),
  });
  const climates = analyzeBuildCharacter({
    sections, energyCurves: curves,
    analysis: { mode: 'minor', majorness: -0.65, tonalConfidence: 0.8 },
  });
  attachBuildCharacter(sections, climates);
  assert.equal(sections[0].buildKind, BUILD_KIND.CALM);
  assert.equal(sections[0].glowTame01, 0);
  assert.equal(sections[1].buildKind, BUILD_KIND.TENSION);
  assert.ok(sections[1].glowTame01 > 0.3);
  assert.equal(sections[0].kind, undefined);
  assert.equal(sections[1].kind, undefined);
});

test('sampleBuildCharacter follows the section that contains the clock', () => {
  const sections = [
    { startMs: 0, endMs: 10000, kind: BUILD_KIND.CALM, glowTame01: 0, tension01: 0, drive01: 0 },
    { startMs: 10000, endMs: 40000, kind: BUILD_KIND.TENSION, glowTame01: 0.7, tension01: 0.8, drive01: 0.2 },
  ];
  const quiet = sampleBuildCharacter(sections, 500);
  const loud = sampleBuildCharacter({ sections }, 20000);
  assert.equal(quiet.kind, BUILD_KIND.CALM);
  assert.equal(quiet.glowTame01, 0);
  assert.equal(loud.kind, BUILD_KIND.TENSION);
  assert.equal(loud.glowTame01, 0.7);
  assert.ok(loud.glowMul < 0.5);
  assert.equal(sampleBuildCharacter(null, 0).glowTame01, 0);
});

test('an unstable minor key timeline raises roughness and tension', () => {
  const curves = paint({ durationMs: 40000, energyAt: (t) => 0.5 + 0.4 * t, bandsAt: tensionBands });
  const stable = classifyBuildSection({
    startMs: 0, endMs: 40000, energyCurves: curves,
    analysis: { mode: 'minor', majorness: -0.5, tonalConfidence: 0.9 },
    tonalityTimeline: [
      { tMs: 0, tonic: 9, mode: 'minor', majorness: -0.5, confidence: 0.9 },
      { tMs: 20000, tonic: 9, mode: 'minor', majorness: -0.5, confidence: 0.9 },
      { tMs: 40000, tonic: 9, mode: 'minor', majorness: -0.5, confidence: 0.9 },
    ],
  });
  const rough = classifyBuildSection({
    startMs: 0, endMs: 40000, energyCurves: curves,
    analysis: { mode: 'minor', majorness: -0.5, tonalConfidence: 0.4 },
    tonalityTimeline: [
      { tMs: 0, tonic: 9, mode: 'minor', majorness: -0.4, confidence: 0.3 },
      { tMs: 10000, tonic: 2, mode: 'minor', majorness: -0.2, confidence: 0.25 },
      { tMs: 20000, tonic: 7, mode: 'major', majorness: 0.1, confidence: 0.2 },
      { tMs: 30000, tonic: 4, mode: 'minor', majorness: -0.5, confidence: 0.3 },
      { tMs: 40000, tonic: 9, mode: 'minor', majorness: -0.6, confidence: 0.25 },
    ],
  });
  assert.ok(rough.roughness01 > stable.roughness01 + 0.2);
  assert.ok(rough.tension01 >= stable.tension01);
});
