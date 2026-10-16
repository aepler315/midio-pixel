import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSurfacePoint, surfaceCopies, drawRidgeSurface, resolveFacetTone, selectVisibleSurface } from '../src/world/alpine/RidgeSurfaceDraw.js';

test('a centered or absent key light does not erase matte face differences', () => {
  const palette = {
    base: '#5c6255', faceLight: '#788071', faceShade: '#343d3a',
    gully: '#26332f', intrinsicContrast: 1,
  };
  const a = { normal: { x: -.6, y: -.2, z: .77 }, intrinsicTone: .55 };
  const b = { normal: { x: .6, y: -.2, z: .77 }, intrinsicTone: -.55 };
  for (const lightDirection of [null, { x: 0, y: -1, z: .3, intensity: 1 }]) {
    const left = resolveFacetTone({ facet: a, palette, lightDirection });
    const right = resolveFacetTone({ facet: b, palette, lightDirection });
    assert.notEqual(left.baseColor, right.baseColor);
    assert.ok(Number.isFinite(left.directionalAlpha));
    assert.ok(Number.isFinite(right.directionalAlpha));
    if (lightDirection === null) {
      assert.equal(left.directionalAlpha, 0);
      assert.equal(right.directionalAlpha, 0);
    }
  }
});

test('directional lighting leaves the intrinsic material tone unchanged', () => {
  const palette = { base: '#879990', faceLight: '#a0b1a7', faceShade: '#617569', intrinsicContrast: 1 };
  const facet = { normal: { x: .6, y: -.2, z: .77 }, intrinsicTone: .55 };
  const unlit = resolveFacetTone({ facet, palette, lightDirection: null });
  const lit = resolveFacetTone({ facet, palette, lightDirection: { x: 0, y: -1, z: .3, intensity: 1 } });
  assert.equal(lit.baseColor, unlit.baseColor,
    'the separately painted directional accent must own the lighting adjustment');
  assert.ok(lit.directionalAlpha > 0 && lit.directionalAlpha <= .08);
});

test('structural faces stay distributed across a handoff', () => {
  const facet = (id, sx) => ({
    id, structural: true, importance: 1,
    vertices: [{ sx, depth01: 0 }, { sx: sx + 20, depth01: 0.5 }, { sx: sx + 10, depth01: 0.8 }],
  });
  const left = [facet('L1', 20), facet('L2', 40), facet('L3', 60), facet('L4', 80)];
  const right = [facet('R1', 900)];
  const surface = { facets: [...left, ...right], gullies: [], stands: [] };
  const picked = selectVisibleSurface({
    sides: [{ sideId: 'A', surface, seamWeight: 1 }],
    sourceWindows: { A: { min: 0, max: 1000 } },
    budget: { facetsPerLayer: 6, gulliesPerLayer: 0, standsPerLayer: 0 },
  });
  assert.ok(picked.facets.some((item) => item.id === 'R1'));
  const pair = {
    sides: [
      { sideId: 'A', surface, seamWeight: 0.49 },
      { sideId: 'B', surface: { ...surface, facets: [facet('B1', 100)] }, seamWeight: 0.51 },
    ],
    sourceWindows: { A: { min: 0, max: 1000 }, B: { min: 0, max: 1000 } },
    budget: { facetsPerLayer: 6, gulliesPerLayer: 0, standsPerLayer: 0 },
  };
  const ids = [];
  for (let step = 1; step <= 99; step++) {
    pair.sides[0].seamWeight = step / 100;
    pair.sides[1].seamWeight = 1 - step / 100;
    const next = selectVisibleSurface(pair);
    assert.ok(next.facets.length <= 6);
    ids.push(next.facets.map((item) => `${item.sideId}:${item.id}`).join(','));
  }
  assert.equal(new Set(ids).size, 1);
});

test('features project onto the exact live crest and local foot', () => {
  const geom = { bottomY: 300, dh: 200, pts: [
    { stripX: 0, x: 10, y: 80, dy: 0 }, { stripX: 100, x: 110, y: 120, dy: 0 },
  ] };
  assert.deepEqual(projectSurfacePoint({ sx: 50, depth01: 0 }, { geom, stripWidth: 100, terrain: true }), { x: 60, y: 100 });
  assert.deepEqual(projectSurfacePoint({ sx: 50, depth01: 1 }, { geom, stripWidth: 100, terrain: true }), { x: 60, y: 300 });
  assert.equal(projectSurfacePoint({ sx: -1, depth01: .5 }, { geom, stripWidth: 100, terrain: true }), null);
  assert.deepEqual(surfaceCopies(2048, 100, 700, true), [0]);
  assert.ok(surfaceCopies(2048, 100, 700, false).length >= 1);
});

test('late source-window cover paints when earlier strip features are off screen', () => {
  const painted = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, fill() {}, stroke() {}, ellipse(x) { painted.push(x); } };
  const surface = { width: 8192, facets: [], gullies: [], stands: [
    { sx: 100, depth01: .3, widthPx: 30, heightPx: 12 },
    { sx: 7100, depth01: .3, widthPx: 30, heightPx: 12 },
  ] };
  const geom = { bottomY: 300, pts: [
    { stripX: 7000, x: 0, y: 100 }, { stripX: 7200, x: 200, y: 110 },
  ] };
  drawRidgeSurface(ctx, { surface, geom, terrain: true, policy: { canopy: .9 },
    budget: { facetsPerLayer: 6, gulliesPerLayer: 0, standsPerLayer: 1 }, alpha: 1 });
  assert.equal(painted.length, 1);
  assert.equal(painted[0], 100);
});

test('face illumination follows screen-space celestial position smoothly', () => {
  const render = x => {
    const colors = [];
    const ctx = { save() {}, restore() {}, beginPath() {}, closePath() {},
      moveTo() {}, lineTo() {}, fill() { colors.push(this.fillStyle); }, stroke() {} };
    const surface = { width: 200, facets: [{ normalX: .8, vertices: [
      { sx: 40, depth01: 0 }, { sx: 100, depth01: .6 }, { sx: 160, depth01: .4 },
    ] }], gullies: [], stands: [] };
    const geom = { bottomY: 300, pts: [
      { stripX: 0, x: 0, y: 100 }, { stripX: 200, x: 200, y: 100 },
    ] };
    drawRidgeSurface(ctx, { surface, geom, terrain: true, budget: {
      facetsPerLayer: 6, gulliesPerLayer: 0, standsPerLayer: 0 }, light: { x, intensity: 1 } });
    return colors.at(-1);
  };
  assert.notEqual(render(20), render(180));
  assert.notEqual(render(180), render(200), 'sun movement should not saturate at ordinary screen x');
});

function paintProbe() {
  const fills = [];
  const stack = [];
  const ctx = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '',
    save() { stack.push(this.globalAlpha); },
    restore() { this.globalAlpha = stack.pop(); },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {},
    fill() { fills.push({ color: this.fillStyle, alpha: this.globalAlpha }); },
  };
  return { ctx, fills };
}

const flatGeom = { bottomY: 300, pts: [
  { stripX: 0, x: 0, y: 100 }, { stripX: 200, x: 200, y: 100 },
] };
const paintBudget = { facetsPerLayer: 6, gulliesPerLayer: 4, standsPerLayer: 0 };
const paintPalette = { base: '#5c6255', faceLight: '#788071', faceShade: '#343d3a',
  gully: '#26332f', intrinsicContrast: 1 };

test('centered light keeps the bounded directional accent and intrinsic face contrast', () => {
  const probe = paintProbe();
  const surface = { width: 200, facets: [-1, 1].map((sign) => ({
    id: `face:${sign}`, intrinsicTone: sign * .55,
    normal: { x: sign * .62, y: -.22, z: .75 }, structural: true,
    vertices: [{ sx: 20 + sign * 10, depth01: 0 }, { sx: 60 + sign * 10, depth01: .6 },
      { sx: 40 + sign * 10, depth01: .8 }],
  })), gullies: [], stands: [] };
  drawRidgeSurface(probe.ctx, { surface, geom: flatGeom, terrain: true,
    budget: paintBudget, palette: paintPalette, light: { x: 100, intensity: 1 } });
  assert.equal(probe.fills.length, 4);
  assert.ok(probe.fills[1].alpha <= .08, `left accent painted at ${probe.fills[1].alpha}`);
  assert.ok(probe.fills[3].alpha <= .08, `right accent painted at ${probe.fills[3].alpha}`);
  const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const painted = (base, accent) => rgb(base.color).map((v, i) =>
    Math.round(v * (1 - accent.alpha) + rgb(accent.color)[i] * accent.alpha));
  const left = painted(probe.fills[0], probe.fills[1]);
  const right = painted(probe.fills[2], probe.fills[3]);
  assert.ok(left.every((v, i) => Math.abs(v - right[i]) >= 25),
    `painted face separation collapsed: ${left} vs ${right}`);
});

test('gully opacity does not inherit the last facet accent', () => {
  const probe = paintProbe();
  const surface = { width: 200, facets: [{ id: 'face', structural: true, intrinsicTone: .5,
    normal: { x: .62, y: -.22, z: .75 }, vertices: [
      { sx: 20, depth01: 0 }, { sx: 60, depth01: .5 }, { sx: 40, depth01: .8 },
    ] }], gullies: [{ id: 'g', points: [
      { sx: 100, depth01: .1 }, { sx: 110, depth01: .4 }, { sx: 105, depth01: .8 },
    ], widthsSource: [2, 1, .5] }], stands: [] };
  drawRidgeSurface(probe.ctx, { surface, geom: flatGeom, terrain: true,
    budget: paintBudget, palette: paintPalette, light: { x: 100, intensity: 1 } });
  const gully = probe.fills.at(-1);
  assert.match(gully.color, /^rgba\(/);
  const colorAlpha = Number(gully.color.match(/,([\d.]+)\)$/)[1]);
  assert.ok(Math.abs(gully.alpha * colorAlpha - .45) < .001,
    `effective gully alpha ${gully.alpha * colorAlpha}`);
  const dim = paintProbe();
  dim.ctx.globalAlpha = .5;
  drawRidgeSurface(dim.ctx, { surface, geom: flatGeom, terrain: true, alpha: .5,
    budget: paintBudget, palette: paintPalette, light: { x: 100, intensity: 1 } });
  const dimGully = dim.fills.at(-1);
  const dimColorAlpha = Number(dimGully.color.match(/,([\d.]+)\)$/)[1]);
  assert.ok(Math.abs(dimGully.alpha * dimColorAlpha - .1125) < .001);
});

test('procedural material selection follows every visible tile copy', () => {
  const surface = { width: 200, facets: [{ id: 'f', structural: true,
    vertices: [{ sx: 20, depth01: 0 }, { sx: 80, depth01: .6 },
      { sx: 40, depth01: .8 }] }], gullies: [], stands: [] };
  const probe = paintProbe();
  const secondTile = { bottomY: 300, pts: [
    { stripX: 200, x: 0, y: 100 }, { stripX: 400, x: 200, y: 100 },
  ] };
  drawRidgeSurface(probe.ctx, { surface, geom: secondTile, budget: paintBudget,
    palette: paintPalette, light: null });
  assert.ok(probe.fills.length > 0, 'second copy lost its material');
});

test('vegetation follows the active biome palette', () => {
  const surface = { width: 200, facets: [], gullies: [], stands: [{ id: 's', structural: true,
    kind: 'broadleaf', vertices: [
      { sx: 20, depth01: .05 }, { sx: 80, depth01: .05 }, { sx: 70, depth01: .4 },
    ] }] };
  const render = (coverColor) => {
    const probe = paintProbe();
    drawRidgeSurface(probe.ctx, { surface, geom: flatGeom, terrain: true,
      policy: { canopy: .9 }, budget: { ...paintBudget, standsPerLayer: 1 },
      palette: paintPalette, coverColor });
    return probe.fills[0]?.color;
  };
  assert.equal(render('#28432b'), '#28432b');
  assert.equal(render('#716b3e'), '#716b3e');
});

test('a viewport straddling tiled copies respects one facet budget', () => {
  const surface = { width: 200, facets: [{ id: 'f', structural: true,
    vertices: [{ sx: 20, depth01: 0 }, { sx: 180, depth01: .5 },
      { sx: 40, depth01: .8 }] }], gullies: [], stands: [] };
  const probe = paintProbe();
  drawRidgeSurface(probe.ctx, { surface, geom: { bottomY: 300, pts: [
    { stripX: 150, x: 0, y: 100 }, { stripX: 250, x: 100, y: 100 },
  ] }, budget: { facetsPerLayer: 1, gulliesPerLayer: 0, standsPerLayer: 0 },
  palette: paintPalette, light: null });
  assert.equal(probe.fills.length, 1);
});
