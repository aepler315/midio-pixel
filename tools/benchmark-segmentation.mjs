#!/usr/bin/env node
// Score a held-out, human-annotated section corpus without coupling the
// evaluator to a browser decoder or any particular annotation dataset.
//
// Usage:
//   npm run bench:sections -- path/to/corpus.json
//
// `corpus.json` may be an array, or `{ "tracks": [...] }`, where each track
// is `{ id, durationMs, reference, estimate }`. See docs/analysis-evaluation.md.
import { readFile } from 'node:fs/promises';
import { runBenchmark } from '../src/eval/BenchmarkRunner.js';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('Usage: npm run bench:sections -- path/to/corpus.json');
  process.exitCode = 2;
} else {
  try {
    const parsed = JSON.parse(await readFile(corpusPath, 'utf8'));
    const corpus = Array.isArray(parsed) ? parsed : parsed?.tracks;
    const result = runBenchmark(corpus);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    console.error(`Could not benchmark section corpus: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
