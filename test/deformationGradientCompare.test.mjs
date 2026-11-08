import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGradientArgs, assertGradientFrameMatch, summarizeGradientFrames, assessGradientExercise,
  assertGradientWasExercised } from '../tools/deformation-gradient-compare.mjs';

test('gradient benchmark accepts bounded defaults and rejects malformed inputs', () => {
  const args = parseGradientArgs(['--out', '.smoke/new', '--times', '24000,12000', '--frames', '24', '--hardware-gpu']);
  assert.deepEqual(args.times, [12000, 24000]);
  assert.equal(args.frames, 24); assert.equal(args.hardware, true);
  assert.equal(args.view, 'teton-jackson-lake');
  for (const argv of [[], ['--out'], ['--out', 'x', '--frames', '0'], ['--out', 'x', '--times', 'NaN'],
    ['--out', 'x', '--times', '3,3'], ['--out', 'x', '--view', '../x'], ['--out', 'x', '--wrong', 'yes']]) {
    assert.throws(() => parseGradientArgs(argv));
  }
});

const frame = mode => ({ timeMs: 12000, actualTimeMs: 12000, seed: 315, quality: 0,
  audio: { heardTimeMs: 12000, energy: .7 }, controls: { land: { amplitudeM: 5 } },
  render: { qualityLevel: 0, scene: { size: { width: 320, height: 180 } } },
  output: { width: 1280, height: 720 }, dpr: 1, camera: { eyeM: [1, 2, 3] },
  presentation: { requestedLook: 'pixel', effectiveLook: 'pixel', effectiveGrid: { id: 'classic' },
    pixelScale: 'original', effectivePalette: 'none', effectiveDitherMode: 'selective',
    output: { width: 1280, height: 720 }, working: { width: 320, height: 180 }, qualityLevel: 0 },
  gradientExercise: { exercised: true, riseSink: .2, nonFlat: true, nonzeroStrengths: true, channels: ['uDeformAmp'],
    reason: 'non-flat rise and nonzero deformation/dance inputs' },
  gradientState: { activation: { mode, verified: true }, uniforms: { uDeformAmp: 5, uDeformKick: 0, uDeformStructural: 0,
    uDeformMelodic: 0, uDeformGesture: 0, uLandRise: [.2, 1000], uLandDance: [0, 0, 0, 0] },
    geometry: { near: { position: { count: 30, sha256: 'abc' } } }, vertexShaderSha256: 'abc',
    camera: { position: [1, 2, 3], projection: Array(16).fill(0) } },
  range: { viewId: 'teton-jackson-lake', active: true, narrative: { section: 2 },
    scene: { pending: [], deformationGradient: { requested: mode, drawn: { 'teton-jackson-lake': { terrain: mode, river: null } } } } },
});

test('gradient A/B gates reject scene, geometry, music, quality and shader activation drift', () => {
  assert.doesNotThrow(() => assertGradientFrameMatch(frame('reference'), frame('factored')));
  const changes = [
    f => { f.camera.eyeM[0]++; }, f => { f.gradientState.camera.projection[0]++; },
    f => { f.gradientState.geometry.near.position.sha256 = 'other'; },
    f => { f.gradientState.uniforms.uDeformAmp++; }, f => { f.controls.land.amplitudeM++; },
    f => { f.audio.heardTimeMs++; }, f => { f.render.qualityLevel++; },
    f => { f.presentation.effectiveGrid.id = 'detailed'; }, f => { f.seed++; },
    f => { f.gradientState.activation.verified = false; },
    f => { f.range.scene.deformationGradient.drawn[f.range.viewId].terrain = 'reference'; },
    f => { f.range.scene.deformationGradient.drawn[f.range.viewId].river = 'reference'; },
    f => { f.gradientState.activation.river = { mode: 'reference', verified: true }; },
    f => { f.range.scene.pending.push('asset'); }, f => { f.range.active = false; },
    f => { delete f.gradientState.uniforms; }, f => { delete f.camera; },
  ];
  for (const change of changes) {
    const candidate = frame('factored'); change(candidate);
    assert.throws(() => assertGradientFrameMatch(frame('reference'), candidate));
  }
  assert.throws(() => assertGradientFrameMatch(frame('reference'), frame('reference')), /candidate mode/);
});

test('gradient A/B gates require linked river activation and matching river presence', () => {
  const reference = frame('reference'), candidate = frame('factored');
  for (const f of [reference, candidate]) {
    const mode = f.gradientState.activation.mode;
    f.gradientState.activation.river = { mode, verified: true };
    f.range.scene.deformationGradient.drawn[f.range.viewId].river = mode;
  }
  assert.doesNotThrow(() => assertGradientFrameMatch(reference, candidate));
  candidate.gradientState.activation.river.verified = false;
  assert.throws(() => assertGradientFrameMatch(reference, candidate), /unverified river/);
  candidate.gradientState.activation.river = null;
  candidate.range.scene.deformationGradient.drawn[candidate.range.viewId].river = null;
  assert.throws(() => assertGradientFrameMatch(reference, candidate), /river material presence/);
});

test('unsupported, disjoint and unresolved GPU samples stay out of timing summaries', () => {
  const sample = (gpuComplete, value) => ({ gpuComplete, gpu: { terrain: value, other: value },
    cpu: { terrain: 2, other: 1 }, calls: { terrain: 3 }, triangles: { terrain: 10 }, frameMs: 4 });
  const valid = sample(true, 5), invalid = sample(false, 999);
  const summary = summarizeGradientFrames([valid, invalid, invalid]);
  assert.equal(summary.validGpuSamples, 1);
  assert.equal(summary.gpuTerrainMs.p50, 5);
  assert.equal(summary.frameSubmissionMs.n, 3);
  assert.equal(summarizeGradientFrames([invalid]).gpuTerrainMs, null);
  assert.equal(summarizeGradientFrames([]).frameSubmissionMs, null);
});

test('silent and fully flat captures cannot establish exercised gradient evidence', () => {
  const uniforms = { uDeformAmp: 0, uDeformKick: 0, uDeformStructural: 0, uDeformMelodic: 0,
    uDeformGesture: 0, uLandRise: [.2, 1000], uLandDance: [0, .7, 0, 1] };
  const silent = assessGradientExercise(uniforms);
  assert.equal(silent.exercised, false, 'dance order/phase alone do not displace land');
  const flat = assessGradientExercise({ ...uniforms, uDeformAmp: 20, uLandRise: [1, 1000] });
  assert.equal(flat.exercised, false, 'opening bypasses the fragment gradient even with active music');
  assert.throws(() => assertGradientWasExercised([silent, flat].map(f => ({ gradientExercised: f.exercised }))), /gradient was not exercised/);
  for (const key of ['uDeformAmp', 'uDeformKick', 'uDeformStructural', 'uDeformMelodic', 'uDeformGesture']) {
    assert.equal(assessGradientExercise({ ...uniforms, [key]: -2 }).exercised, true, `${key} exercises gradient inputs`);
  }
  for (const index of [0, 2]) {
    const dance = [...uniforms.uLandDance]; dance[index] = 2;
    assert.equal(assessGradientExercise({ ...uniforms, uLandDance: dance }).exercised, true);
  }
  assert.doesNotThrow(() => assertGradientWasExercised([{ gradientExercised: false }, { gradientExercised: true }]));
});

test('gradient exercise evidence rejects missing and nonfinite uniforms', () => {
  const uniforms = frame('reference').gradientState.uniforms;
  for (const key of Object.keys(uniforms)) {
    const missing = { ...uniforms }; delete missing[key];
    assert.throws(() => assessGradientExercise(missing), /missing or invalid/);
  }
  for (const invalid of [{ ...uniforms, uDeformAmp: NaN }, { ...uniforms, uLandDance: [0, 0, Infinity, 0] },
    { ...uniforms, uLandRise: [1.1, 0] }, { ...uniforms, uLandRise: [0] }]) {
    assert.throws(() => assessGradientExercise(invalid), /missing or invalid/);
  }
});
