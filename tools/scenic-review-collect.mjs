// Collect a rendered review of scenic shot libraries from its workflow
// journal and check it against the libraries it is meant to describe
// (tools/lib/scenic-review.mjs): every expected region reviewed once, every
// shot of the library and no other, only recognised verdicts counted.
//
//   node tools/scenic-review-collect.mjs --journal <run>/journal.jsonl --views a,b,c
//        [--libraries src/assets/range/v2/tour] [--wait-ms 900000] [--out review.json]
//
// Waits (bounded) for the expected review agents to finish; on timeout it
// prints which started, finished or never reported, and exits 2. Exits 1
// when the review is incomplete or does not match the libraries.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReviews, journalState } from './lib/scenic-review.mjs';

async function main() {
  const args = process.argv.slice(2), opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const journal = opt('--journal'), views = (opt('--views') || '').split(',').filter(Boolean);
  if (!journal || !views.length) throw new Error('usage: node tools/scenic-review-collect.mjs --journal FILE --views a,b [--libraries DIR] [--wait-ms N] [--out FILE]');
  const libraries = opt('--libraries', 'src/assets/range/v2/tour'), waitMs = Number(opt('--wait-ms', 0)), labels = views.map((v) => `review:${v}`);
  const deadline = Date.now() + waitMs;
  let state;
  for (;;) {
    state = journalState(await fs.readFile(journal, 'utf8'), labels);
    if (!state.missing.length || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (state.missing.length) {
    const { mtime } = await fs.stat(journal);
    console.log(`review not finished: ${state.finished.length}/${labels.length} reported; running ${state.running.join(', ') || 'none'}; never started ${state.missing.filter((l) => !state.started.includes(l)).join(', ') || 'none'}; journal last written ${Math.round((Date.now() - mtime) / 1000)} s ago`);
    process.exitCode = 2;
    return;
  }
  const expected = new Map();
  for (const v of views) expected.set(v, JSON.parse(await fs.readFile(path.join(libraries, `${v}.shots.json`), 'utf8')).shots.map((s) => s.id));
  const results = labels.map((l) => state.results.get(l));
  const r = collectReviews(results, expected);
  for (const v of views) {
    const x = r.regions[v];
    console.log(x ? `${v.padEnd(24)} ${x.verdict.padEnd(10)} ${x.passing}/${x.expected} good or acceptable, ${x.counts.weak} weak, ${x.counts.broken} broken${x.current ? '' : ` -- NOT THE CURRENT LIBRARY (${(r.problems.missingShots[v] || []).length} shots unseen, ${(r.problems.unknownShots[v] || []).length} reviewed shots gone)`}`
      : `${v.padEnd(24)} no usable result`);
  }
  const p = r.problems, listed = Object.entries(p).filter(([, v]) => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : Object.keys(v).length));
  console.log(r.complete ? 'review complete and current for every region' : `review INCOMPLETE: ${listed.map(([k, v]) => `${k} ${JSON.stringify(v)}`).join('; ')}`);
  if (state.unexpected.length || state.duplicates.length || state.other.length) console.log(`journal: unexpected ${state.unexpected.join(', ') || 'none'}, duplicate results ${state.duplicates.join(', ') || 'none'}, other events ${state.other.length}`);
  if (opt('--out')) await fs.writeFile(opt('--out'), JSON.stringify({ journal, libraries, ...r }, null, 1));
  if (!r.complete) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
