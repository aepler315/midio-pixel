// The linter this repo went without until a duplicate method name cost it a
// whole visual effect.
//
// BiomeManager defined `_drawMirage` twice. A class body keeps only the last
// definition, so the ocean fata morgana added by #185 was unreachable from
// the day it merged and drew zero pixels for a week -- with all 2305 tests
// green, because the tests covering its math were right and the math was
// simply never called. `no-dupe-class-members` is in eslint:recommended and
// catches it in milliseconds. So does `no-unused-private-class-members` for
// the `_mirageRecipe` field orphaned alongside it.
//
// ABOUT THE BASELINE. Turning a linter on over 55k lines of code written
// without one surfaces 129 pre-existing findings, none of them urgent and
// none of them what this config is here for. Rewriting all 129 in the same
// change as the fix would bury it and risk regressions in files nobody was
// auditing. So every rule is a real error, and the existing findings are
// recorded in eslint-suppressions.json instead: new violations fail, old
// ones are visible and countable, and `--prune-suppressions` shrinks the
// file as they get paid off. It is a debt ledger, not a set of rules turned
// off.
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.browser },
  },
  {
    // An AudioWorklet runs on the audio thread, which has its own global
    // scope -- no window, no DOM, but AudioWorkletProcessor/registerProcessor.
    files: ['src/audio/*-worklet.js'],
    languageOptions: { globals: globals.audioWorklet },
  },
  {
    // Ridgeview (ridgeview/README.md) is a separate browser app with its own
    // package; same split: page code in src/, Node harnesses beside it.
    files: ['ridgeview/src/**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.browser },
  },
  {
    // Node harnesses that also evaluate code inside a page.
    files: ['tools/**/*.{js,mjs}', 'test/**/*.{js,mjs}', 'ridgeview/tools/**/*.{js,mjs}', 'ridgeview/test/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    rules: {
      // Unused parameters are frequently part of a signature a caller
      // supplies positionally (every drawXWorld takes the same twelve), so
      // flagging them would report shape, not dead code. Unused *variables*
      // and imports are dead code and stay an error.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      // Constructing an object purely for its side effects leaves it
      // unreachable, so whatever it was meant to do happened in the
      // constructor or not at all. Not in recommended, but the tree is
      // already clean of it and a directive in FontRecommender.js expects it.
      'no-new': 'error',
    },
  },
  {
    ignores: [
      'node_modules/**', '.smoke/**', 'slskd/**', 'data/**', '_site/**',
      // Generated, minified Three.js subset (tools/build-range-runtime.mjs).
      'src/vendor/**',
      // Ridgeview's vendored Three.js copy (ridgeview/tools/vendor-three.mjs).
      'ridgeview/vendor/**',
      // Generated range profiles (tools/build-ranges.mjs): one JSON.stringify
      // blob each, so the same "data, not code" call as data/** above.
      // JSON writes shortest round-trip floats, and for a float32 sample
      // whose exact decimal ends in a 5 (780.50567626953125 -> "...312")
      // no-loss-of-precision re-rounds the tie up and reports a value that
      // is in fact exact -- which failed CI on every PR after #306. The
      // loader index is code, so it stays linted.
      'src/world/terrain/ranges/*.js',
      '!src/world/terrain/ranges/index.js',
    ],
  },
];
