import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDualSummitsMusic, ds182EvidenceFor, dualSummitsSelection } from '../src/world/alpine/DualSummitsMusic.js';
import { DS182_EVIDENCE } from '../src/assets/performance/ds182.js';

const request = { signature: 'dual-summits', durationMs: 513762.789, sourceSha256: DS182_EVIDENCE.sources.mix.sha256 };

test('only the canonical upload auto-selects; explicit off overrides it', () => {
  const sourceSha256 = ds182EvidenceFor(request).sources.mix.sha256;
  assert.equal(dualSummitsSelection({ ...request, sourceSha256 }), 'dual-summits');
  assert.equal(dualSummitsSelection({ ...request, sourceSha256, search: '?performance=off' }), 'off');
  assert.equal(dualSummitsSelection({ ...request, sourceSha256: null }), undefined, 'duration alone never activates the signature');
  assert.equal(dualSummitsSelection({ ...request, sourceSha256: 'f'.repeat(64) }), undefined);
  assert.equal(dualSummitsSelection({ durationMs: 509138, sourceSha256 }), undefined);
  assert.equal(dualSummitsSelection({ durationMs: 1000, search: '?performance=dual-summits' }), 'dual-summits');
});

test('measured stem roles require the explicit signature and matching canonical recording', () => {
  const evidence = ds182EvidenceFor(request);
  assert.notEqual(evidence, null, 'canonical recording receives measured stem evidence');
  assert.equal(evidence.durationMs, request.durationMs);
  assert.match(evidence.sources.mix.sha256, /^[a-f0-9]{64}$/);
  assert.equal(ds182EvidenceFor({ ...request, signature: null }), null);
  assert.equal(ds182EvidenceFor({ ...request, sourceSha256: null }), null);
  assert.equal(ds182EvidenceFor({ ...request, durationMs: 509138 }), null);
  assert.equal(ds182EvidenceFor({ ...request, sourceSha256: 'f'.repeat(64) }), null);
  assert.equal(ds182EvidenceFor({ ...request, sourceSha256: evidence.sources.mix.sha256 }), evidence);
});

test('real recording evidence separates the distorted riff from the clean summit block', () => {
  const music = compileDualSummitsMusic(request);
  assert.equal(music.roleSource, 'measured-stems');
  const riff = music.at(60000), cleanBlock = music.at(320000);
  assert.ok(riff.distortionShare > riff.cleanShare + .3, JSON.stringify(riff));
  assert.ok(cleanBlock.cleanShare > cleanBlock.distortionShare + .15, JSON.stringify(cleanBlock));
  assert.equal(riff.foreground, 'distortion');
  assert.equal(cleanBlock.foreground, 'clean');
});

test('role emphasis settles over seconds and is identical after direct seeks', () => {
  const music = compileDualSummitsMusic(request);
  assert.equal(music.at(7500).distortion, 0, 'the future first distorted window cannot anticipate its entry');
  const saved = music.at(370000);
  music.at(400000); music.at(10000);
  assert.deepEqual(music.at(370000), saved);
  let largest = 0;
  for (let t = 100; t < request.durationMs; t += 100) {
    const a = music.at(t - 100), b = music.at(t);
    largest = Math.max(largest, Math.abs(a.clean - b.clean), Math.abs(a.distortion - b.distortion));
  }
  assert.ok(largest < .04, `100ms role jump ${largest}`);
  assert.equal(music.at(-1).energy, 0);
  assert.equal(music.at(request.durationMs + 1).energy, 0);
});

test('an unmatched recording exposes measured mix energy without fabricated stem roles', () => {
  const music = compileDualSummitsMusic({ ...request, durationMs: 509138,
    energyCurves: { globalEnergyNorm: t => t === 12345 ? .37 : 0 } });
  assert.equal(music.roleSource, 'unavailable');
  assert.equal(music.evidence, null);
  assert.deepEqual(music.at(12345), { energy: .37, clean: 0, distortion: 0, other: 0,
    cleanShare: 0, distortionShare: 0, foreground: 'unavailable' });
});
