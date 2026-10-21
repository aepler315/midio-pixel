import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorldChoices } from '../src/ui/WorldChooser.js';

const WORLDS = [
  { id: 'alpine', name: 'Landscape', tagline: 'Real mountains that breathe with the mix.', kind: 'alpine', experience: 'landscape', realBiomes: true },
  { id: 'trio', name: 'Trio', tagline: 'Midio, Midasus and Broshi on the dancing range.', kind: 'alpine', experience: 'trio' },
  { id: 'manual-fixture', name: 'Manual fixture', tagline: 'Synthetic manual-only choice.', kind: 'manual-fixture', manualOnly: true },
];

function ids(choices) {
  return choices.map(({ worldId, playWorldId, name, tagline, kind }) => ({
    worldId, playWorldId, name, tagline, kind,
  }));
}

test('chooser replaces a tailored base world instead of adding a duplicate card', () => {
  const choices = buildWorldChoices(WORLDS, {
    id: 'custom', baseId: 'alpine', name: 'Landscape',
    tagline: 'Real mountains that breathe with the mix.', kind: 'alpine',
  });

  assert.deepEqual(ids(choices), [
    { worldId: 'alpine', playWorldId: 'custom', name: 'Landscape', tagline: 'Real mountains that breathe with the mix.', kind: 'alpine' },
    { worldId: 'trio', playWorldId: 'trio', name: 'Trio', tagline: 'Midio, Midasus and Broshi on the dancing range.', kind: 'alpine' },
    { worldId: 'manual-fixture', playWorldId: 'manual-fixture', name: 'Manual fixture', tagline: 'Synthetic manual-only choice.', kind: 'manual-fixture' },
  ]);
  assert.equal(choices.every((c) => typeof c.description === 'string' && c.description.length > 0), true);
  assert.equal(choices[2].manualOnly, true);
});

test('chooser uses each registered world directly when there is no tailored variant', () => {
  const choices = buildWorldChoices(WORLDS);

  assert.deepEqual(choices.map(({ worldId, playWorldId }) => ({ worldId, playWorldId })), [
    { worldId: 'alpine', playWorldId: 'alpine' },
    { worldId: 'trio', playWorldId: 'trio' },
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
  assert.match(chooser, /two worlds/);
  assert.equal(chooser.includes('Choose for me'), false, 'two worlds need no recommendation');
  assert.equal(chooser.includes('Cathode'), false);
  assert.equal(/%|\bscore\b|\bbest match\b|\bwinner\b/i.test(chooser), false);
});

test('the two cards are Landscape and Trio, and only Trio is labeled as the cast performing', () => {
  const [landscape, trio] = buildWorldChoices(WORLDS.slice(0, 2), null, { groove: 0.6 });
  assert.equal(landscape.experience, 'landscape');
  assert.match(landscape.previewLabel, /3D landscape/);
  assert.equal(trio.experience, 'trio');
  assert.equal(trio.previewLabel, null);
  assert.match(trio.description, /Midasus/);
  assert.doesNotMatch(landscape.description, /Midasus/);
});
