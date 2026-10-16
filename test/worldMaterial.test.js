// Scenic-poster material language: landforms are colored masses, not holes;
// the ground is a different material from the ridge; rims are the world's
// own light, never moonlight cream on cardboard teeth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hexToRgb, rgbToHsl } from '../src/utils/color.js';
import {
  KIND_MATERIAL, materialFor, layerBake, layerColor, groundColorFor,
  catchlightRgb, CATCHLIGHT, terrainModsForLayer,
} from '../src/world/WorldMaterial.js';
import { BIOMES } from '../src/world/BiomeProfiles.js';
import { FARSIDE_PALETTES } from '../src/world/farside/FarsidePalettes.js';
import { FATHOM_PALETTES } from '../src/world/fathom/FathomPalettes.js';
import { FOUNDRY_PALETTES } from '../src/world/foundry/FoundryPalettes.js';

function lightness(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsl(r, g, b).l;
}

test('every painterly kind has a material recipe', () => {
  for (const kind of ['alpine', 'city', 'airless', 'abyssal', 'strip', 'foundry', 'overgrowth', 'nave']) {
    const mat = materialFor(kind);
    assert.ok(mat.layers.L2 && mat.layers.L5, kind);
    assert.ok(Number.isFinite(mat.fillLift), kind);
    assert.ok(Number.isFinite(mat.ground.voidAlpha), kind);
    assert.ok(Number.isFinite(mat.ground.minL), kind);
  }
  assert.equal(KIND_MATERIAL.airless.aerial, false);
  assert.equal(KIND_MATERIAL.abyssal.aerial, 'invert');
  assert.equal(KIND_MATERIAL.airless.aerial, false);
});

test('catchlight is the world\'s own light, never ghost-cream', () => {
  const alpine = catchlightRgb('alpine');
  assert.deepEqual(alpine, CATCHLIGHT.warm);
  assert.ok(!(alpine.r === 255 && alpine.g >= 248 && alpine.b >= 230),
    'alpine catchlight must not be moonlight cream');
  assert.equal(catchlightRgb('airless'), null);
  assert.deepEqual(catchlightRgb('foundry'), CATCHLIGHT.ember);
  assert.deepEqual(catchlightRgb('nave'), CATCHLIGHT.glass);
  assert.deepEqual(catchlightRgb('abyssal'), CATCHLIGHT.cool);
});

test('ground is a different material from the ridge', () => {
  const sil = '#3d3a5c';
  const ground = groundColorFor(sil, 'alpine');
  assert.notEqual(ground.toLowerCase(), sil.toLowerCase());
  assert.ok(lightness(ground) > lightness(sil), 'ground is lifted relative to the ridge');
  const vacuum = groundColorFor('#1c202c', 'airless');
  assert.ok(lightness(vacuum) >= KIND_MATERIAL.airless.ground.minL - 0.02);
});

test('fathom far layers mix toward the water column', () => {
  const near = layerColor('#144850', 'abyssal', 'L5');
  const far = layerColor('#144850', 'abyssal', 'L2');
  assert.equal(near, '#144850');
  assert.notEqual(far, near);
  assert.ok(lightness(far) < lightness(near), 'far water is deeper, not hazed toward sky');
});

test('nave and understory hang something; foundry stands columns', () => {
  assert.equal(layerBake('nave', 'L2').anchor, 'ceiling');
  assert.equal(layerBake('nave', 'L2').profile, 'columnar');
  assert.equal(layerBake('overgrowth', 'L2').anchor, 'ceiling');
  assert.equal(layerBake('abyssal', 'L2').anchor, 'ceiling');
  assert.equal(layerBake('foundry', 'L2').profile, 'columnar');
  assert.equal(layerBake('foundry', 'L2').anchor, 'ground');
  assert.equal(layerBake('alpine', 'L2').anchor, 'ground');
});

test('teethMax refuses spiky Halloween ridgelines', () => {
  const mods = terrainModsForLayer({ teethAdd: 0.08 }, { teethMax: 0.03 });
  assert.ok(mods.teethAdd < 0, 'cap is enforced by a negative add');
  const untouched = terrainModsForLayer({ teethAdd: 0.08 }, { profile: 'rolling' });
  assert.equal(untouched.teethAdd, 0.08);
});

test('chooser cards are not grape-and-pumpkin Halloween cutouts', () => {
  const css = readFileSync(new URL('../src/ui/style.css', import.meta.url), 'utf8');
  const alpineBlock = css.slice(css.indexOf('.worldCardPreview.alpine {'), css.indexOf('.worldCardPreview.city {'));
  assert.ok(!alpineBlock.includes('#2b2145'), 'Range card silhouette is a hole');
  assert.ok(!alpineBlock.includes('#1a1a3e'), 'Range card sky is grape-Halloween');
  assert.ok(alpineBlock.includes('#4a4068'), 'Range card should be a dusk-plum mass');
  const foundryBlock = css.slice(css.indexOf('.worldCardPreview.foundry {'), css.indexOf('.worldCardPreview.overgrowth {'));
  assert.ok(foundryBlock.includes('7% 16%'), 'Foundry card should read as stacks, not alpine teeth');
});

test('stock silhouettes are colored masses, not holes', () => {
  const all = [
    ...BIOMES,
    ...FARSIDE_PALETTES,
    ...FATHOM_PALETTES,
    ...FOUNDRY_PALETTES,
  ];
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
