// Two structural mistakes a class body can make in total silence.
//
// A class body keeps only the LAST definition of a method name. Define the
// same name twice and the earlier one is not an error, not a warning, and
// not reachable -- it is simply gone, along with every call that meant to
// reach it. BiomeManager carried two `_drawMirage` methods for a week: the
// ocean fata morgana added by #185 and the older DUNE ground mirage. The
// ground one won, so the call meant for the fata morgana ran the wrong body
// with a biome profile where a y-coordinate belonged. Every argument past
// the fourth was dropped, `canvas.height - profile` was NaN, and the whole
// effect drew exactly zero pixels for its entire life. All 2305 tests
// passed the whole time, including the ones covering FataMorgana.js's math,
// because the math was never wrong -- it was never called.
//
// The second mistake is the same failure seen from the call site: passing
// more arguments than a method declares. JS drops the surplus silently, so
// a signature that drifts away from its callers reports nothing.
//
// Both are cheap to check from source and neither is checkable any other
// way -- once the module is evaluated the duplicate has already collapsed
// and the surplus arguments are already gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classBodies, classMethods, thisCalls } from './helpers/classShape.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Generated third-party bundles (src/vendor, see tools/build-range-runtime.mjs)
// are minified library code, not this project's classes.
const GENERATED = new Set([path.join(SRC, 'vendor')]);

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    // serve.test.js creates and removes these request fixtures concurrently.
    // They are not application classes and may disappear during this scan.
    if (entry.isDirectory()) { if (!GENERATED.has(p) && !entry.name.startsWith('server-test-')) sourceFiles(p, out); }
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Every class in src/, paired with its parsed methods. */
function allClasses() {
  const out = [];
  for (const file of sourceFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.join(SRC, '..'), file);
    for (const body of classBodies(src)) {
      out.push({ file: rel, src, ...body, methods: classMethods(body.body, body.offset, src) });
    }
  }
  return out;
}

test('the scanner still finds the class bodies it is meant to guard', () => {
  // A parser that silently matched nothing would make both tests below pass
  // forever, which is the exact failure mode they exist to catch.
  const classes = allClasses();
  const methods = classes.reduce((n, c) => n + c.methods.length, 0);
  assert.ok(classes.length > 80, `expected the whole src tree, saw ${classes.length} classes`);
  assert.ok(methods > 600, `expected the whole src tree, saw ${methods} methods`);
  const biomes = classes.find((c) => c.name === 'BiomeManager');
  assert.ok(biomes, 'BiomeManager not found');
  assert.ok(
    biomes.methods.some((m) => m.name === '_drawFataMorgana'),
    'BiomeManager methods did not parse',
  );
});

test('no class defines the same method name twice', () => {
  const collisions = [];
  for (const cls of allClasses()) {
    const seen = new Map();
    for (const m of cls.methods) {
      if (m.name === 'constructor') continue;
      // A get/set pair legitimately shares a name; nothing else does.
      const key = m.name;
      if (seen.has(key)) {
        collisions.push(`${cls.file}:${m.line} ${cls.name}.${key} (also ${cls.file}:${seen.get(key)})`);
      }
      seen.set(key, m.line);
    }
  }
  assert.deepEqual(collisions, [], `duplicate method names shadow the earlier definition:\n  ${collisions.join('\n  ')}`);
});

test('no this.method() call passes more arguments than the method declares', () => {
  const overflows = [];
  for (const cls of allClasses()) {
    const byName = new Map(cls.methods.map((m) => [m.name, m]));
    for (const call of thisCalls(cls.body, cls.offset, cls.src)) {
      const def = byName.get(call.name);
      if (!def) continue; // inherited or assigned elsewhere -- not this test's business
      if (call.args > def.params) {
        overflows.push(
          `${cls.file}:${call.line} this.${call.name}() passes ${call.args} args; `
          + `${cls.name}.${call.name} takes ${def.params} (defined at ${cls.file}:${def.line})`,
        );
      }
    }
  }
  assert.deepEqual(overflows, [], `surplus arguments are dropped silently:\n  ${overflows.join('\n  ')}`);
});
