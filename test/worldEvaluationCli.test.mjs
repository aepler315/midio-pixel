// E1/D1: `npm run eval:worlds` imports reviews only from an explicit,
// validated --reviews book in its own output format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cli = path.resolve('tools/evaluate-worlds.mjs');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const dir = await mkdtemp(path.join(tmpdir(), 'eval-worlds-'));
test.after(() => rm(dir, { recursive: true, force: true }));
const write = async (name, value) => { const p = path.join(dir, name); await writeFile(p, typeof value === 'string' ? value : JSON.stringify(value)); return p; };

const plain = run('--split', 'holdout');
const book = JSON.parse(plain.stdout);
const good = { appeal: 5, musicalTiming: 5, identity: 4, quietInterest: 4, climaxHeadroom: 4, clutter: 4, blockingDefect: false, notes: 'ok' };
const filled = (edit = (r) => r) => ({ ...book, sheets: book.sheets.map((s) => ({ ...s, reviews: s.reviews.map((r) => (r.worldId === s.heuristic.recommendedId ? edit({ ...r, ...good }) : r)) })) });

test('without --reviews the checked-in book stays unknown', () => {
  assert.equal(plain.status, 0);
  assert.deepEqual([book.summary.met, book.summary.calibration, book.summary.claimed], [null, 'empty-holdout', false]);
});

test('a valid filled book is merged by review fields only and can meet the holdout target', async () => {
  const tampered = filled();
  tampered.sheets[0].heuristic = { recommendedId: 'not-a-world', scores: {} };
  tampered.sheets[0].viewingOrder = ['reversed'];
  const out = run('--split', 'holdout', '--reviews', await write('good.json', tampered));
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.equal(report.summary.met, true);
  assert.equal(report.summary.claimed, false);
  assert.deepEqual(report.sheets[0].heuristic, book.sheets[0].heuristic, 'imported heuristics are ignored');
  assert.deepEqual(report.sheets[0].viewingOrder, book.sheets[0].viewingOrder);
  const rec = report.sheets[0].reviews.find((r) => r.worldId === book.sheets[0].heuristic.recommendedId);
  assert.equal(rec.notes, 'ok');
});

test('partial books (null axes) are accepted as incomplete reviews', async () => {
  const partial = filled((r) => ({ ...r, identity: null }));
  const out = run('--split', 'holdout', '--reviews', await write('partial.json', partial));
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).summary.met, null);
});

const rejects = {
  'wrong protocol': () => ({ ...filled(), protocol: 99 }),
  'unknown track': () => { const b = filled(); b.sheets[0] = { ...b.sheets[0], track: { ...b.sheets[0].track, id: 'nope' } }; return b; },
  'wrong split': () => { const b = filled(); b.sheets[0] = { ...b.sheets[0], track: { ...b.sheets[0].track, split: 'tune' } }; return b; },
  'duplicate track': () => { const b = filled(); b.sheets.push(b.sheets[0]); return b; },
  'unknown world': () => { const b = filled(); b.sheets[0].reviews.push({ ...good, worldId: 'nowhere' }); return b; },
  'duplicate world': () => { const b = filled(); b.sheets[0].reviews.push({ ...b.sheets[0].reviews[0] }); return b; },
  'rating 6': () => filled((r) => ({ ...r, appeal: 6 })),
  'fractional rating': () => filled((r) => ({ ...r, musicalTiming: 4.5 })),
  'string blocker': () => filled((r) => ({ ...r, blockingDefect: 'no' })),
  'numeric notes': () => filled((r) => ({ ...r, notes: 3 })),
};
for (const [name, make] of Object.entries(rejects)) {
  test(`a book with ${name} exits nonzero without a report`, async () => {
    const out = run('--split', 'holdout', '--reviews', await write(`${name.replace(/\W/g, '-')}.json`, make()));
    assert.equal(out.status, 1);
    assert.equal(out.stdout, '');
    assert.match(out.stderr, /review book rejected|protocol/);
  });
}

test('a missing --reviews path or unreadable book exits nonzero', async () => {
  assert.equal(run('--reviews').status, 1);
  assert.equal(run('--reviews', path.join(dir, 'missing.json')).status, 1);
  assert.equal(run('--reviews', await write('broken.json', '{')).status, 1);
});
