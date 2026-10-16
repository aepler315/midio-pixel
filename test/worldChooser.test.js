import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorldChoices } from '../src/ui/WorldChooser.js';

const WORLDS = [
  { id: 'alpine', name: 'The Range', tagline: 'Mountains that breathe with the mix.', kind: 'alpine' },
  { id: 'nocturne', name: 'After Hours', tagline: 'A city that glows with the groove.', kind: 'city' },
  { id: 'manual-fixture', name: 'Manual fixture', tagline: 'Synthetic manual-only choice.', kind: 'manual-fixture', manualOnly: true },
];

function ids(choices) {
  return choices.map(({ worldId, playWorldId, name, tagline, kind }) => ({
    worldId, playWorldId, name, tagline, kind,
  }));
}

test('chooser replaces a tailored base world instead of adding a duplicate card', () => {
  const choices = buildWorldChoices(WORLDS, {
    id: 'custom', baseId: 'alpine', name: 'The Range',
    tagline: 'Mountains that breathe with the mix.', kind: 'alpine',
  });

  assert.deepEqual(ids(choices), [
    { worldId: 'alpine', playWorldId: 'custom', name: 'The Range', tagline: 'Mountains that breathe with the mix.', kind: 'alpine' },
    { worldId: 'nocturne', playWorldId: 'nocturne', name: 'After Hours', tagline: 'A city that glows with the groove.', kind: 'city' },
    { worldId: 'manual-fixture', playWorldId: 'manual-fixture', name: 'Manual fixture', tagline: 'Synthetic manual-only choice.', kind: 'manual-fixture' },
  ]);
  assert.equal(choices.every((c) => typeof c.description === 'string' && c.description.length > 0), true);
  assert.equal(choices[2].manualOnly, true);
});

test('chooser uses each registered world directly when there is no tailored variant', () => {
  const choices = buildWorldChoices(WORLDS);

  assert.deepEqual(choices.map(({ worldId, playWorldId }) => ({ worldId, playWorldId })), [
    { worldId: 'alpine', playWorldId: 'alpine' },
    { worldId: 'nocturne', playWorldId: 'nocturne' },
    { worldId: 'manual-fixture', playWorldId: 'manual-fixture' },
  ]);
});

test('chooser copy never ranks worlds or mentions a score', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
  const start = html.indexOf('id="worldSelect"');
  const end = html.indexOf('id="hud"');
  assert.ok(start >= 0 && end > start);
  const chooser = html.slice(start, end);
  assert.match(chooser, /Choose how your song looks/);
  assert.match(chooser, /Choose for me/);
  assert.match(chooser, /not a ranking/i);
  assert.equal(chooser.includes('Cathode'), false);
  assert.equal(/%|\bscore\b|\bbest match\b|\bwinner\b/i.test(chooser), false);
});
