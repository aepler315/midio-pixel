import assert from 'node:assert/strict';

export function summarize(samples) {
  assert.ok(samples.length > 0 && samples.every(n => Number.isFinite(n) && n >= 0), 'finite nonnegative samples required');
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], maxMs: sorted.at(-1) };
}

/** Local 8x8 luminance SSIM, RGB changed-area and horizontal/vertical edge MAE.
 * SSIM complements the full-resolution RGB gate; it cannot waive that gate. */
export function imageMetrics(a, b, thresholds) {
  for (const [k, v] of Object.entries(thresholds)) assert.ok(Number.isFinite(v) && v >= 0 && v <= (k === 'channel' ? 255 : 1), `invalid threshold ${k}`);
  for (const key of ['channel', 'changedRatio', 'minSsim', 'edgeMae']) assert.ok(Object.hasOwn(thresholds, key), `missing threshold ${key}`);
  assert.ok(a.width === b.width && a.height === b.height && a.data.length === b.data.length && a.data.length === a.width * a.height * 4, 'image dimension mismatch');
  const count = a.width * a.height, la = new Float64Array(count), lb = new Float64Array(count);
  const difference = Buffer.alloc(count * 4); let changed = 0, mae = 0, edge = 0, edgeCount = 0;
  for (let i = 0; i < count; i++) {
    let max = 0;
    for (let c = 0; c < 4; c++) { const d = Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]); max = Math.max(max, d); mae += d; }
    if (max > thresholds.channel) changed++;
    difference.set([max, 0, max, 255], i * 4);
    la[i] = .2126 * a.data[i * 4] + .7152 * a.data[i * 4 + 1] + .0722 * a.data[i * 4 + 2];
    lb[i] = .2126 * b.data[i * 4] + .7152 * b.data[i * 4 + 1] + .0722 * b.data[i * 4 + 2];
    for (const j of [i % a.width ? i - 1 : -1, i >= a.width ? i - a.width : -1]) if (j >= 0) {
      edge += Math.abs((la[i] - la[j]) - (lb[i] - lb[j])); edgeCount++;
    }
  }
  let ssim = 0, blocks = 0;
  for (let y = 0; y < a.height; y += 8) for (let x = 0; x < a.width; x += 8) {
    let n = 0, sa = 0, sb = 0, aa = 0, bb = 0, ab = 0;
    for (let dy = y; dy < Math.min(y + 8, a.height); dy++) for (let dx = x; dx < Math.min(x + 8, a.width); dx++) {
      const i = dy * a.width + dx, u = la[i], v = lb[i]; n++; sa += u; sb += v; aa += u * u; bb += v * v; ab += u * v;
    }
    const ma = sa / n, mb = sb / n, va = Math.max(0, aa / n - ma * ma), vb = Math.max(0, bb / n - mb * mb), cov = ab / n - ma * mb;
    ssim += ((2 * ma * mb + 6.5025) * (2 * cov + 58.5225)) / ((ma * ma + mb * mb + 6.5025) * (va + vb + 58.5225)); blocks++;
  }
  const result = { changedRatio: changed / count, mae: mae / (count * 4 * 255), ssim: ssim / blocks, edgeMae: edge / Math.max(1, edgeCount) / 255 };
  return { ...result, pass: result.changedRatio <= thresholds.changedRatio && result.ssim >= thresholds.minSsim && result.edgeMae <= thresholds.edgeMae, difference };
}

export function compareCapture(baseline, candidate) {
  assert.ok(baseline.approval?.reviewer && baseline.approval?.reason, 'reference approval required');
  assert.ok(baseline.status === 'passed' && candidate.status === 'passed', 'both captures must have passed');
  for (const key of ['controlsHash', 'browser', 'renderer']) {
    assert.ok(typeof baseline[key] === 'string' && baseline[key] && typeof candidate[key] === 'string' && candidate[key], `missing ${key}`);
    assert.equal(candidate[key], baseline[key], `${key} mismatch; run a reviewed migration, never silently compare unlike captures`);
  }
  assert.ok(baseline.frames?.length > 0 && candidate.frames?.length === baseline.frames.length, 'frame count mismatch');
  for (const report of [baseline, candidate]) for (const frame of report.frames) assert.match(frame.id ?? '', /^[a-z0-9-]+$/, 'invalid frame id');
  assert.equal(new Set(candidate.frames.map(f => f.id)).size, candidate.frames.length, 'duplicate candidate frame');
  assert.equal(new Set(baseline.frames.map(f => f.id)).size, baseline.frames.length, 'duplicate baseline frame');
  return baseline.frames.map(expected => {
    const observed = candidate.frames.find(f => f.id === expected.id);
    assert.ok(observed, `missing frame ${expected.id}`);
    assert.ok(expected.width === observed.width && expected.height === observed.height, 'frame dimensions mismatch');
    return { expected, observed };
  });
}

export function compareBenchmarks(base, candidate, { relative = .5, absoluteMs = 1 } = {}) {
  assert.ok(Number.isFinite(relative) && relative >= 0 && Number.isFinite(absoluteMs) && absoluteMs >= 0, 'invalid benchmark thresholds');
  assert.equal(base.status, 'passed', 'benchmark baseline must have passed');
  for (const report of [base, candidate]) {
    assert.ok(report.environment && typeof report.environment === 'object' && Object.keys(report.environment).length, 'benchmark environment required');
    assert.ok(typeof report.workloadHash === 'string' && report.workloadHash, 'benchmark workload identity required');
    assert.ok(Array.isArray(report.results) && report.results.length > 0, 'benchmark scenarios required');
    assert.equal(new Set(report.results.map(r => r.id)).size, report.results.length, 'duplicate benchmark scenario');
    for (const row of report.results) {
      assert.ok(typeof row.id === 'string' && row.id, 'benchmark scenario id required');
      assert.ok(typeof row.checksum === 'string' && row.checksum, 'benchmark output checksum required');
    }
  }
  assert.deepEqual(candidate.environment, base.environment, 'benchmark environment mismatch');
  assert.equal(candidate.workloadHash, base.workloadHash, 'benchmark workload mismatch');
  assert.ok(base.results?.length > 0 && base.results.length === candidate.results?.length, 'benchmark scenario count mismatch');
  assert.equal(new Set(candidate.results.map(r => r.id)).size, candidate.results.length, 'duplicate benchmark scenario');
  const rows = base.results.map(before => {
    const after = candidate.results.find(r => r.id === before.id); assert.ok(after, `missing scenario ${before.id}`);
    for (const r of [before, after]) for (const key of ['medianMs', 'p95Ms', 'maxMs']) assert.ok(Number.isFinite(r[key]) && r[key] >= 0, `finite ${key} required`);
    const timing = ['medianMs', 'p95Ms', 'maxMs'].every(k => after[k] <= before[k] * (1 + relative) + absoluteMs);
    return { id: before.id, pass: timing && before.checksum === after.checksum, sameOutput: before.checksum === after.checksum,
      medianDeltaMs: after.medianMs - before.medianMs, p95DeltaMs: after.p95Ms - before.p95Ms, timing };
  });
  return { pass: rows.every(r => r.pass), relative, absoluteMs, rows };
}
