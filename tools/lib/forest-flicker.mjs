import assert from 'node:assert/strict';

export function flickerStats(values) {
  assert.ok(values.length >= 2 && values.every(Number.isFinite), 'at least two finite crop brightness samples required');
  const changes = values.slice(1).map((v, i) => Math.abs(v - values[i]));
  const meanBrightness = values.reduce((a, b) => a + b, 0) / values.length;
  const meanStepChange = changes.reduce((a, b) => a + b, 0) / changes.length;
  return { meanBrightness, meanStepChange, maxStepChange: Math.max(...changes),
    brightnessRange: Math.max(...values) - Math.min(...values), relativeMeanStepChange: meanStepChange / Math.max(meanBrightness, 1e-12) };
}

export function compareFlickerReports(baseline, candidate) {
  for (const key of ['audioSha256', 'params', 'constructionSeed', 'width', 'height', 'browser', 'environment'])
    assert.deepEqual(candidate[key], baseline[key], `unmatched ${key}`);
  const crop = { x: 94, y: 144, width: 512, height: 512 };
  assert.equal(candidate.frames[0].quality, baseline.frames[0].quality, 'unmatched render quality');
  for (const r of [baseline, candidate]) {
    assert.ok(!r.failure, r.failure);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.frames[0].crop, crop, 'retain the original 40s crop');
    assert.equal(r.flicker.timeMs, 40000);
    assert.equal(r.flicker.steps, 16);
    assert.equal(r.flicker.referenceDepthM, 6000);
    assert.equal(r.flicker.frames.length, 17);
    assert.equal(r.flicker.pauseParity, true);
    const first = r.flicker.frames[0];
    r.flicker.frames.forEach((f, i) => {
      assert.equal(f.offsetPx, i / 16);
      for (const key of ['actualMs', 'heardMs', 'windowIndex']) assert.equal(f[key], first[key], `advancing ${key}`);
      for (const key of ['forward', 'fovYDeg', 'aspect']) assert.deepEqual(f.renderedCamera[key], first.renderedCamera[key], `moving ${key}`);
      assert.notEqual(f.coarse, true);
    });
  }
  candidate.flicker.frames.forEach((f, i) => {
    for (const key of ['offsetPx', 'offsetM', 'actualMs', 'heardMs', 'windowIndex', 'renderedCamera'])
      assert.deepEqual(f[key], baseline.flicker.frames[i][key], `unmatched sample ${i} ${key}`);
  });
  const b = flickerStats(baseline.flicker.frames.map(f => f.meanBrightness));
  const c = flickerStats(candidate.flicker.frames.map(f => f.meanBrightness));
  return { pass: c.meanStepChange <= b.meanStepChange + 1e-12, baseline: b, candidate: c,
    changePercent: b.meanStepChange ? 100 * (c.meanStepChange / b.meanStepChange - 1) : null };
}
