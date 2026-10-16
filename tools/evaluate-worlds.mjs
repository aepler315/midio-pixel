#!/usr/bin/env node
// Private world-quality evaluation. Heuristic scores are recorded but never
// used as a gallery ranking. Ratings stay empty until a human fills them.
//
// Usage:
//   npm run eval:worlds
//   npm run eval:worlds -- --split holdout
//   npm run eval:worlds -- path/to/corpus.json --split tune
//   npm run eval:worlds -- --split holdout --reviews filled-book.json
//
// It generates review plans and summaries; it captures nothing. Reviews are
// imported only with an explicit --reviews book.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCorpus, mergeReviewBook, summarizeAcceptance } from '../src/eval/WorldQuality.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CORPUS = join(root, 'test/fixtures/world-evaluation.json');

function parseArgs(argv) {
  let corpusPath = DEFAULT_CORPUS;
  let split = 'all';
  let reviews = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--split') split = argv[++i] || 'all';
    else if (a === '--reviews') {
      reviews = argv[++i];
      if (!reviews) throw new Error('--reviews needs a review-book path');
    }
    else if (a === '--help' || a === '-h') return { help: true };
    else if (!a.startsWith('-')) corpusPath = a;
  }
  if (!['all', 'tune', 'holdout'].includes(split)) {
    throw new Error(`--split must be all, tune, or holdout (got ${split})`);
  }
  return { corpusPath, split, reviews };
}

const HELP = `Usage: npm run eval:worlds -- [--split all|tune|holdout] [--reviews book.json] [corpus.json]

Emits a JSON review book (a review plan and summary; it captures nothing).
Viewing order is authored, not ranked. Heuristic scores are private.
Ratings are empty unless --reviews names a filled book in this command's own
output format; only its review fields are imported, after checking its
protocol, track/split/world ids and uniqueness. Any invalid review exits
nonzero. Only holdout reviews can meet the target, and it is never claimed.
`;

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
  } else {
    const parsed = JSON.parse(await readFile(args.corpusPath, 'utf8'));
    const report = evaluateCorpus(parsed, { split: args.split });
    if (args.reviews) {
      const book = JSON.parse(await readFile(args.reviews, 'utf8'));
      const merged = mergeReviewBook(report.sheets, book);
      if (merged.errors.length) throw new Error(`review book rejected:\n  ${merged.errors.join('\n  ')}`);
      report.sheets = merged.sheets;
      report.summary = summarizeAcceptance(report.sheets, { split: args.split });
      report.reviewsFrom = args.reviews;
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.validation.ok) {
      process.stderr.write(`Corpus warnings:\n${report.validation.errors.map((e) => `  - ${e}`).join('\n')}\n`);
      process.exitCode = 2;
    }
  }
} catch (err) {
  console.error(`Could not evaluate world corpus: ${err?.message || err}`);
  process.exitCode = 1;
}
