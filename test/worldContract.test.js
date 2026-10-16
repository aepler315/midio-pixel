// The world contract, enforced.
//
// BiomeManager is 7,000 lines, 256 fields and 100 methods. Its seven world
// draw modules use 40 of those members. Before WorldRegistry.js there was
// nothing written down that said which 40, so the honest answer to "may a
// world read this?" was "read the other worlds and guess" -- and every field
// added to the manager silently widened the surface a world could couple to.
//
// These tests are what makes WORLD_CONTRACT a contract rather than a comment.
// They read the module sources rather than executing them, because the thing
// under test is the shape of the coupling, and a draw call needs a canvas, a
// palette pair and a populated manager to run at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripNonCode } from './helpers/classShape.js';
import { WORLDS } from '../src/world/Worlds.js';
import {
  WORLD_RENDERERS, WORLD_CONTRACT, WORLD_CONTRACT_MEMBERS,
} from '../src/world/WorldRegistry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The two kinds that are deliberately not in the registry, and why. Spelled
// out here so that removing a renderer can never quietly look intentional.
const UNREGISTERED_KINDS = {
  alpine: 'the original path, still inline in BiomeManager.draw()',
};

function worldModuleSources(includeShared = true) {
  const dir = path.join(ROOT, 'src', 'world');
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, entry.name))) {
      if (!/^draw[A-Z]/.test(f)) continue;
      const rel = path.join('src', 'world', entry.name, f);
      out.push({ rel, code: stripNonCode(fs.readFileSync(path.join(ROOT, rel), 'utf8')) });
    }
  }
  if (includeShared) {
    const rel = 'src/world/WorldDraw.js';
    out.push({ rel, code: stripNonCode(fs.readFileSync(path.join(ROOT, rel), 'utf8')) });
  }
  return out;
}

// Guards the two tests below: if the file discovery or the comment stripper
// ever breaks, they would pass by finding nothing at all.
test('the scan finds every world module and the members they touch', () => {
  const mods = worldModuleSources(false);
  assert.equal(mods.length, WORLD_RENDERERS.size,
    `expected one draw module per registered kind, saw ${mods.map((m) => m.rel).join(', ')}`);
  for (const { rel, code } of mods) {
    const hits = code.match(/\bmgr\.[_a-zA-Z0-9]+/g) || [];
    assert.ok(hits.length >= 15, `${rel}: only ${hits.length} mgr.* references found`);
  }
});

test('every world kind either has a renderer or a stated reason not to', () => {
  for (const world of WORLDS) {
    const { kind } = world;
    if (WORLD_RENDERERS.has(kind)) continue;
    assert.ok(UNREGISTERED_KINDS[kind],
      `world '${world.id}' has kind '${kind}' with no renderer and no stated reason`);
  }
  for (const kind of WORLD_RENDERERS.keys()) {
    assert.ok(WORLDS.some((w) => w.kind === kind),
      `WORLD_RENDERERS has '${kind}', which no world in WORLDS declares`);
  }
});

test('no world module reaches outside WORLD_CONTRACT', () => {
  const violations = [];
  for (const { rel, code } of worldModuleSources()) {
    for (const hit of new Set(code.match(/\bmgr\.[_a-zA-Z0-9]+/g) || [])) {
      const member = hit.slice('mgr.'.length);
      if (!WORLD_CONTRACT_MEMBERS.has(member)) violations.push(`${rel} -> mgr.${member}`);
    }
  }
  assert.deepEqual(violations, [],
    'world modules may only touch members listed in WORLD_CONTRACT. Either use an '
    + 'existing member, or add this one to the contract deliberately:\n  '
    + violations.join('\n  '));
});

test('no contract member has rotted out of use', () => {
  const used = new Set();
  for (const { code } of worldModuleSources()) {
    for (const hit of code.match(/\bmgr\.[_a-zA-Z0-9]+/g) || []) used.add(hit.slice(4));
  }
  const dead = [...WORLD_CONTRACT_MEMBERS].filter((m) => !used.has(m));
  assert.deepEqual(dead, [],
    `WORLD_CONTRACT lists members no world uses: ${dead.join(', ')}. A contract that `
    + 'outgrows its users stops describing anything.');
});

test('the contract groups are disjoint', () => {
  const seen = new Set();
  for (const [group, members] of Object.entries(WORLD_CONTRACT)) {
    for (const m of members) {
      assert.ok(!seen.has(m), `'${m}' is listed in more than one group (again in '${group}')`);
      seen.add(m);
    }
  }
  assert.equal(seen.size, WORLD_CONTRACT_MEMBERS.size);
});
