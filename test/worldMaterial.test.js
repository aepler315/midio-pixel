// Scenic-poster material language: landforms are colored masses, not holes;
// the ground is a different material from the ridge; rims are the world's
// own light, never moonlight cream on cardboard teeth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hexToRgb, rgbToHsl } from '../src/utils/color.js';
import {
  KIND_MATERIAL, materialFor, layerBake, groundColorFor,
  catchlightRgb, CATCHLIGHT, terrainModsForLayer,
} from '../src/world/WorldMaterial.js';
import { BIOMES } from '../src/world/BiomeProfiles.js';

function lightness(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsl(r, g, b).l;
}

test('the alpine kind has a material recipe, and an unknown kind reads it', () => {
  const mat = materialFor('alpine');
  assert.ok(mat.layers.L2 && mat.layers.L5);
  assert.ok(Number.isFinite(mat.fillLift));
  assert.ok(Number.isFinite(mat.ground.voidAlpha));
  assert.ok(Number.isFinite(mat.ground.minL));
  assert.equal(KIND_MATERIAL.alpine.aerial, true);
  assert.equal(materialFor('unregistered-kind'), KIND_MATERIAL.alpine);
  assert.equal(layerBake('unregistered-kind', 'L3'), layerBake('alpine', 'L3'));
});

test('catchlight is the world\'s own light, never ghost-cream', () => {
  const alpine = catchlightRgb('alpine');
  assert.deepEqual(alpine, CATCHLIGHT.warm);
  assert.ok(!(alpine.r === 255 && alpine.g >= 248 && alpine.b >= 230),
    'alpine catchlight must not be moonlight cream');
});

test('ground is a different material from the ridge', () => {
  const sil = '#3d3a5c';
  const ground = groundColorFor(sil, 'alpine');
  assert.notEqual(ground.toLowerCase(), sil.toLowerCase());
  assert.ok(lightness(ground) > lightness(sil), 'ground is lifted relative to the ridge');
  const dark = groundColorFor('#1c202c', 'alpine');
  assert.ok(lightness(dark) >= KIND_MATERIAL.alpine.ground.minL - 0.02);
});

test('alpine layers stand on the ground', () => {
  for (const layerKey of ['L2', 'L3', 'L4', 'L5']) {
    assert.equal(layerBake('alpine', layerKey).anchor, 'ground', layerKey);
  }
  assert.equal(layerBake('alpine', 'L2').profile, 'alpine');
  assert.equal(layerBake('alpine', 'L5').profile, 'rolling');
});

test('teethMax refuses spiky Halloween ridgelines', () => {
  const mods = terrainModsForLayer({ teethAdd: 0.08 }, { teethMax: 0.03 });
  assert.ok(mods.teethAdd < 0, 'cap is enforced by a negative add');
  const untouched = terrainModsForLayer({ teethAdd: 0.08 }, { profile: 'rolling' });
  assert.equal(untouched.teethAdd, 0.08);
});

test('chooser cards are not grape-and-pumpkin Halloween cutouts', () => {
  const css = readFileSync(new URL('../src/ui/style.css', import.meta.url), 'utf8');
  const alpineBlock = css.slice(css.indexOf('.worldCardPreview.alpine {'), css.indexOf('.worldCardPreview.trio {'));
  assert.ok(!alpineBlock.includes('#2b2145'), 'Range card silhouette is a hole');
  assert.ok(!alpineBlock.includes('#1a1a3e'), 'Range card sky is grape-Halloween');
  assert.ok(alpineBlock.includes('#4a4068'), 'Range card should be a dusk-plum mass');
  const trioBlock = css.slice(css.indexOf('.worldCardPreview.trio {'), css.indexOf('.worldCardPreview.is-rendered'));
  assert.ok(trioBlock.includes('#23354b'), 'Trio card ridge is a colored mass, not a hole');
});

test('stock silhouettes are colored masses, not holes', () => {
  const all = [...BIOMES];
  for (const p of all) {
    assert.ok(lightness(p.silhouette) >= 0.08,
      `${p.name} silhouette ${p.silhouette} is a hole (L=${lightness(p.silhouette).toFixed(3)})`);
  }
  const twilight = BIOMES.find((b) => b.name === 'TWILIGHT');
  const voidB = BIOMES.find((b) => b.name === 'VOID');
  assert.ok(lightness(twilight.silhouette) >= 0.18, 'TWILIGHT dusk mass');
  assert.ok(lightness(voidB.silhouette) >= 0.14, 'VOID is indigo, not grape-black');
  // Candy pumpkin on grape was the Halloween sky. Apricot on navy is a poster.
  assert.notEqual(twilight.sky[2].toLowerCase(), '#e8746a');
});
