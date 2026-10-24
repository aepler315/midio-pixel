import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { collectReviews, reviewResultErrors, journalState } from '../tools/lib/scenic-review.mjs';

const identity = { schema: 'midio.scenic-review-identity', version: 1, manifestSha256: '1'.repeat(64), payloadSha256: '2'.repeat(64), decodedPayloadSha256: '3'.repeat(64), terrainManifestSha256: '4'.repeat(64) };
const provenance = { sourceDigest: '5'.repeat(64), capturePath: '/evidence/reel.json' };
const expected = new Map([['a', { shotIds: ['a1', 'a2'], identity }], ['b', { shotIds: ['b1'], identity }]]);
const shot = (id, verdict = 'good') => ({ row: 1, id, verdict, issue: '' });
const review = (region, shots, verdict = 'acceptable') => ({ region, verdict, identity: { ...identity }, provenance: { ...provenance }, railParity: 'same', shots, notes: '' });

test('a complete review counts only recognised verdicts of the expected shots', () => {
  const r = collectReviews([review('a', [shot('a1'), shot('a2', 'weak')]), review('b', [shot('b1', 'acceptable')])], expected);
  assert.equal(r.complete, true);
  assert.deepEqual(r.regions.a.counts, { good: 1, acceptable: 0, weak: 1, broken: 0 });
  assert.equal(r.regions.a.passing, 1);
  assert.equal(r.regions.b.passing, 1);
});

test('a missing region, a failed agent or a malformed result leaves the review incomplete', () => {
  const missing = collectReviews([review('a', [shot('a1'), shot('a2')])], expected);
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.problems.missingRegions, ['b']);
  const failed = collectReviews([review('a', [shot('a1'), shot('a2')]), null], expected);
  assert.equal(failed.problems.failed, 1);
  assert.equal(failed.complete, false);
  const malformed = collectReviews([review('a', [shot('a1'), shot('a2')]), review('b', undefined)], expected);
  assert.equal(malformed.complete, false);
  assert.deepEqual(malformed.problems.malformed[0].errors, ['shots']);
});

test('an unknown or misspelled verdict is a problem, never a success', () => {
  assert.deepEqual(reviewResultErrors(review('a', [shot('a1', 'Good'), { row: 2, id: 'a2', issue: '' }])), ['shot a1: verdict "Good"', 'shot a2: verdict undefined']);
  const r = collectReviews([review('a', [shot('a1', 'fine'), shot('a2')]), review('b', [shot('b1')])], expected);
  assert.equal(r.complete, false);
  assert.equal(r.regions.a, undefined, 'a malformed region result is not counted at all');
  assert.equal(r.problems.malformed[0].region, 'a');
});

test('a review of another library (stale shot IDs) is reported, and only matching shots count', () => {
  const r = collectReviews([review('a', [shot('a1'), shot('old', 'good')]), review('b', [shot('b1')])], expected);
  assert.equal(r.complete, false);
  assert.deepEqual(r.problems.missingShots.a, ['a2']);
  assert.deepEqual(r.problems.unknownShots.a, ['old']);
  assert.equal(r.regions.a.current, false);
  assert.equal(r.regions.a.passing, 1, 'the stale shot is not counted');
});

test('duplicate results: identical ones are noted, conflicting ones void the region', () => {
  const same = collectReviews([review('a', [shot('a1'), shot('a2')]), review('a', [shot('a1'), shot('a2')]), review('b', [shot('b1')])], expected);
  assert.deepEqual(same.problems.duplicates, ['a']);
  assert.equal(same.complete, true);
  const clash = collectReviews([review('a', [shot('a1'), shot('a2')]), review('a', [shot('a1', 'broken'), shot('a2')]), review('b', [shot('b1')])], expected);
  assert.deepEqual(clash.problems.conflicts, ['a']);
  assert.equal(clash.regions.a, undefined);
  assert.equal(clash.complete, false);
  const twice = collectReviews([review('a', [shot('a1'), shot('a1', 'broken'), shot('a2')]), review('b', [shot('b1')])], expected);
  assert.deepEqual(twice.problems.duplicateShots.a, ['a1']);
  assert.equal(twice.regions.a.counts.good + twice.regions.a.counts.broken, 2, 'a shot reviewed twice counts once');
});

test('the journal shows which expected agents started, finished or are still running', () => {
  const lines = [{ type: 'launched' }, { type: 'started', agentId: 'x', label: 'review:a' }, { type: 'started', agentId: 'y', label: 'review:b' },
    { type: 'result', agentId: 'x', result: { region: 'a' } }, { type: 'result', agentId: 'z', label: 'review:c', result: null }].map((e) => JSON.stringify(e)).join('\n') + '\nnot json';
  const j = journalState(lines, ['review:a', 'review:b']);
  assert.deepEqual(j.finished, ['review:a']);
  assert.deepEqual(j.running, ['review:b']);
  assert.deepEqual(j.missing, ['review:b']);
  assert.deepEqual(j.unexpected, ['review:c']);
  assert.equal(j.other[0].type, 'unparsable');
});

test('a label that reported twice in the journal keeps both answers: different ones are a conflict', () => {
  const event = (o) => JSON.stringify(o);
  const a = review('a', [shot('a1'), shot('a2')]), b = review('b', [shot('b1')]), b2 = review('b', [shot('b1', 'broken')]);
  const lines = [event({ type: 'started', agentId: 1, label: 'review:a' }), event({ type: 'started', agentId: 2, label: 'review:b' }),
    event({ type: 'result', agentId: 1, result: a }), event({ type: 'result', agentId: 2, result: b }), event({ type: 'result', agentId: 2, result: b2 })].join('\n');
  const j = journalState(lines, ['review:a', 'review:b']);
  assert.deepEqual(j.duplicates, ['review:b']);
  assert.deepEqual(j.results.get('review:b'), [b, b2]);
  const r = collectReviews(['review:a', 'review:b'].flatMap((l) => j.results.get(l)), expected);
  assert.equal(r.complete, false);
  assert.deepEqual(r.problems.conflicts, ['b']);
  // The same answer twice is reported, not a conflict.
  const same = journalState(lines.replace(JSON.stringify(b2), JSON.stringify(b)), ['review:a', 'review:b']);
  const r2 = collectReviews(['review:a', 'review:b'].flatMap((l) => same.results.get(l)), expected);
  assert.deepEqual(r2.problems.duplicates, ['b']);
  assert.equal(r2.complete, true);
});

// A camera path can change without changing a shot ID. ID-only matching must
// never certify that an older rendered review describes the current bytes.
test('same shot IDs with changed camera or payload identity invalidate a review', () => {
  for (const key of ['manifestSha256', 'payloadSha256', 'decodedPayloadSha256', 'terrainManifestSha256']) {
    const a = review('a', [shot('a1'), shot('a2')]);
    a.identity = { ...identity };
    a.identity[key] = 'f'.repeat(64);
    const r = collectReviews([a, review('b', [shot('b1')])], expected);
    assert.equal(r.complete, false, `changed ${key} cannot retain current review status`);
  }
});

test('an ID-only result cannot certify a current library', () => {
  const a = review('a', [shot('a1'), shot('a2')]);
  delete a.identity;
  const r = collectReviews([a, review('b', [shot('b1')])], expected);
  assert.equal(r.complete, false);
});

test('missing source or capture attribution leaves the review incomplete', () => {
  for (const key of ['sourceDigest', 'capturePath']) {
    const a = review('a', [shot('a1'), shot('a2')]);
    delete a.provenance[key];
    const r = collectReviews([a, review('b', [shot('b1')])], expected);
    assert.equal(r.complete, false);
  }
});

test('the legacy ID-array expectation never claims the review is current', () => {
  const r = collectReviews([review('a', [shot('a1'), shot('a2')])], new Map([['a', ['a1', 'a2']]]));
  assert.equal(r.complete, false);
  assert.equal(r.regions.a.current, false);
});

// Run the actual CLI over real temporary bytes: trusting a caller's identity
// or a manifest's declared payload hash would miss these regressions.
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function reviewFixture(t, { viewId = 'a', terrainFile = `${viewId}.terrain.json` } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scenic-review-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const libraries = path.join(dir, 'tour'), terrainDir = path.join(dir, 'terrain');
  await fs.mkdir(libraries); await fs.mkdir(terrainDir);
  const terrain = Buffer.from('{"terrain":"fixture"}\n'), decoded = Buffer.alloc(36), payload = zlib.gzipSync(decoded);
  const manifest = { schema: 'midio.shots', version: 1, viewId, terrainManifestSha256: hash(terrain),
    axes: { x: 'east', y: 'up', z: 'south', units: 'metres' },
    subjects: [{ id: 'subject', kind: 'peak', posM: [0, 0, 0], radiusM: 100 }],
    shots: [{ id: 'a1', subjectId: 'subject', move: 'rail', lengthM: 10, payoffS: 5, holdS: [4, 6], traits: { headingDeg: 0, aglM: 100, lens: 'normal' }, score: { total: 1 }, durationMs: { min: 1, max: 2 }, samples: { offset: 0, count: 2, first: [0, 0, 0, 0, 0, 0, 0] } }], links: [],
    payload: { url: 'a.shots.bin.gz', byteLength: payload.length, sha256: hash(payload), decodedByteLength: decoded.length, decodedSha256: hash(decoded) } };
  const manifestPath = path.join(libraries, `${viewId}.shots.json`), payloadPath = path.join(libraries, 'a.shots.bin.gz'), terrainPath = path.join(terrainDir, terrainFile);
  const raw = JSON.stringify(manifest) + '\n';
  await fs.writeFile(manifestPath, raw); await fs.writeFile(payloadPath, payload); await fs.writeFile(terrainPath, terrain);
  const result = review(viewId, [shot('a1')]);
  result.identity = { schema: 'midio.scenic-review-identity', version: 1, manifestSha256: hash(raw), payloadSha256: hash(payload), decodedPayloadSha256: hash(decoded), terrainManifestSha256: hash(terrain) };
  const journal = path.join(dir, 'journal.jsonl'), out = path.join(dir, 'review.json');
  await fs.writeFile(journal, JSON.stringify({ type: 'result', label: `review:${viewId}`, result }) + '\n');
  const run = (extraArgs = []) => spawnSync(process.execPath, ['tools/scenic-review-collect.mjs', '--journal', journal, '--views', viewId, '--libraries', libraries, '--terrain', terrainDir, '--out', out, ...extraArgs], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  return { manifest, manifestPath, payloadPath, terrainPath, out, run };
}

test('collector derives expected identity from current bytes, so same IDs after camera edits are stale', async (t) => {
  const f = await reviewFixture(t);
  const initial = f.run();
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  f.manifest.shots[0].samples.first[1] = 100;
  await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest) + '\n');
  const changed = f.run();
  assert.equal(changed.status, 1, changed.stderr || changed.stdout);
  const report = JSON.parse(await fs.readFile(f.out, 'utf8'));
  assert.equal(report.complete, false);
  assert.deepEqual(report.problems.identityMismatches.a, ['manifestSha256']);
});

test('collector verifies compressed and decoded payload bytes before accepting review identity', async (t) => {
  const f = await reviewFixture(t);
  await fs.writeFile(f.payloadPath, zlib.gzipSync(Buffer.from('different payload')));
  const compressed = f.run();
  assert.equal(compressed.status, 1);
  assert.match(compressed.stderr, /payload.*(hash|length|identity)/i);
  const replacement = zlib.gzipSync(Buffer.alloc(36, 1));
  f.manifest.payload.sha256 = hash(replacement); f.manifest.payload.byteLength = replacement.length;
  await fs.writeFile(f.payloadPath, replacement); await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest));
  const decoded = f.run();
  assert.equal(decoded.status, 1);
  assert.match(decoded.stderr, /decoded.*(hash|length|identity)/i);
});

test('collector checks the actual terrain manifest against the library terrain reference', async (t) => {
  const f = await reviewFixture(t);
  await fs.writeFile(f.terrainPath, '{"terrain":"changed"}\n');
  const changed = f.run();
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /terrain.*(hash|identity)/i);
});

test('a rebuilt payload with unchanged IDs cannot reuse an older review', async (t) => {
  const f = await reviewFixture(t), decoded = Buffer.alloc(36, 1), payload = zlib.gzipSync(decoded);
  Object.assign(f.manifest.payload, { byteLength: payload.length, sha256: hash(payload), decodedSha256: hash(decoded) });
  await fs.writeFile(f.payloadPath, payload); await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest));
  const changed = f.run();
  assert.equal(changed.status, 1, changed.stderr || changed.stdout);
  const report = JSON.parse(await fs.readFile(f.out, 'utf8'));
  assert.equal(report.complete, false);
  assert.deepEqual(report.problems.identityMismatches.a, ['manifestSha256', 'payloadSha256', 'decodedPayloadSha256']);
});

test('collector resolves a known catalog alias to its shared terrain filename', async (t) => {
  const f = await reviewFixture(t, { viewId: 'teton-jackson-lake-coherent', terrainFile: 'teton-jackson-lake.terrain.json' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(await fs.readFile(f.out, 'utf8'));
  assert.equal(report.complete, true);
  assert.equal(report.regions['teton-jackson-lake-coherent'].current, true);
});

test('collector permits an explicit terrain manifest for one custom view', async (t) => {
  const f = await reviewFixture(t, { viewId: 'custom-alias', terrainFile: 'shared-source.terrain.json' });
  const result = f.run(['--terrain-manifest', f.terrainPath]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(await fs.readFile(f.out, 'utf8'));
  assert.equal(report.complete, true);
});

test('an explicit terrain manifest still has to match the library terrain hash', async (t) => {
  const f = await reviewFixture(t, { viewId: 'custom-alias', terrainFile: 'shared-source.terrain.json' });
  await fs.writeFile(f.terrainPath, '{"terrain":"different"}\n');
  const result = f.run(['--terrain-manifest', f.terrainPath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /terrain.*hash mismatch/i);
});

test('a single explicit terrain manifest cannot implicitly apply to several views', async (t) => {
  const f = await reviewFixture(t);
  const result = spawnSync(process.execPath, ['tools/scenic-review-collect.mjs', '--journal', 'unused', '--views', 'a,b', '--terrain-manifest', f.terrainPath], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--terrain-manifest requires exactly one view/);
});
