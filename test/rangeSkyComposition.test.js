import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceRidge } from '../src/world/SpaceRidge.js';
import { createRangeSkyComposition, rangeMoonRadius, tourCloudBanks, MOON_MIN_ILLUMINATION } from '../src/world/alpine/RangeSkyComposition.js';
import { BiomeManager } from '../src/world/BiomeManager.js';
import * as catalogue from '../src/world/StarCatalogue.js';
import { ParticleField } from '../src/world/ParticleField.js';

test('tour lens magnifies cloud bodies along with their sky positions', () => {
  const pose = { eyeM: [0, 1000, 0], targetM: [0, 1000, -10000], fovYDeg: 35 };
  const options = { pose, width: 1280, height: 720, seed: 315 };
  const ordinary = tourCloudBanks(options);
  const zoomed = tourCloudBanks({ ...options, lensScale: .82 });
  assert.ok(ordinary.length > 0);
  for (const bank of ordinary) {
    const zoom = zoomed.find(b => b.id === bank.id);
    assert.ok(Math.abs(zoom.w * .82 - bank.w) < 1e-8);
    assert.ok(Math.abs(zoom.h * .82 - bank.h) < 1e-8);
  }
});

test('Range attenuates stars locally behind the aurora and keeps the rest of the field', () => {
  const canvas = { width: 1280, height: 720 };
  const ridge = new SpaceRidge(315);
  const plan = createRangeSkyComposition(ridge, canvas);
  const corridor = ridge.corridor(canvas)(640);
  const centerY = (corridor.top + corridor.bottom) / 2;
  assert.ok(plan.starBrightnessAt(640, centerY) > 0);
  assert.ok(plan.starBrightnessAt(640, centerY) < 0.2);
  assert.equal(plan.allowPoint(640, centerY), false);
  assert.equal(plan.starBrightnessAt(640, corridor.top - canvas.height * 0.03), 1, 'clear sky above the curtain');
  assert.equal(plan.starBrightnessAt(640, corridor.bottom + canvas.height * 0.03), 1, 'clear sky below the hem');
  assert.equal(createRangeSkyComposition(ridge, canvas).starBrightnessAt(640, centerY), plan.starBrightnessAt(640, centerY));
  assert.ok(plan.starBrightnessAt(640, corridor.top - 3) < plan.starBrightnessAt(640, corridor.top - 18));
  assert.equal(plan.weaverOptions.maxFigures, 1);
  assert.equal(plan.weaverOptions.maxRetained, 0);
});

test('authored voyage has priority over the incidental Range constellation', () => {
  const canvas = { width: 1280, height: 720 };
  const ridge = new SpaceRidge(315);
  assert.equal(createRangeSkyComposition(ridge, canvas).showWeaver, true);
  assert.equal(createRangeSkyComposition(ridge, canvas, { voyageActive: true }).showWeaver, false);
});

test('Range excludes permanent celestial shaft fans and biome ray fans', () => {
  const plan = createRangeSkyComposition(new SpaceRidge(315), { width: 1280, height: 720 });
  assert.equal(plan.celestialShafts, false);
  assert.equal(plan.biomeRays, false);
});

test('Range moon stays present without dominating the entire upper sky late in a song', () => {
  assert.equal(rangeMoonRadius(720, 1), 720 * 0.0361);
  assert.ok(rangeMoonRadius(720, 3.4) <= 52);
  assert.ok(rangeMoonRadius(720, 3.4) >= 45);
});

test('the shared star painter retains faint aurora stars and the clear sky around it', () => {
  const canvas = { width: 1280, height: 720 };
  const ridge = new SpaceRidge(315);
  const plan = createRangeSkyComposition(ridge, canvas);
  const corridor = ridge.corridor(canvas)(640);
  const skyPx = 720 * 0.3781;
  const insideYFrac = (corridor.top + corridor.bottom) / 2 / skyPx;
  const clearYFrac = (corridor.bottom + canvas.height * 0.03) / skyPx;
  const stars = Array.from({ length: 6 }, (_, i) => ({
    xFrac: 0.5, yFrac: i === 0 ? insideYFrac : clearYFrac,
    size: 1, layer: 2, bright: 1, phase: 0, ext: 1, hue: 0, varAmp: 0,
  }));
  const draws = [];
  const ctx = {
    globalAlpha: 1, save() {}, restore() {}, beginPath() {}, fill() {}, stroke() {},
    translate() {}, rotate() {}, scale() {}, arc() {}, rect() {},
    createLinearGradient() { return { addColorStop() {} }; },
    fillRect(x, y, w, h) { if (w <= 1 && h <= 1) draws.push([x, y, this.globalAlpha]); },
  };
  const manager = {
    world: { kind: 'alpine' }, tSec: 0, calmLevel: 0, openingGain: 1,
    stars, planets: [], dustLanes: [], deepSky: [], _starBuckets: new Map(),
    _rangeSky: plan,
  };
  BiomeManager.prototype._drawStarfield.call(manager, ctx, canvas, { fx: '' }, { fx: '' }, 0, 1);
  assert.equal(draws.length, 6, 'no blanket star rejection');
  assert.ok(draws[0][2] < draws[1][2] * 0.2, 'the aurora has locally reduced starlight');
  draws.length = 0;
  manager._rangeSky = null;
  BiomeManager.prototype._drawStarfield.call(manager, ctx, canvas, { fx: '' }, { fx: '' }, 0, 1);
  assert.equal(draws.length, 6, 'shared painter retains all six without a Range plan');
});

test('bright, faint and cluster members share Range sky drift in heard time', () => {
  const rects = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, fill() {},
    fillRect(x, y) { rects.push([x, y]); }, rect(x, y) { rects.push([x, y]); } };
  const m = { world: { kind: 'alpine' }, openingGain: 1, tSec: 0,
    stars: [0, 1, 2].map((layer) => ({ xFrac: .2 + layer * .2, yFrac: .1, bright: .8, layer, phase: 0, hue: 0, parallax: .007 + layer * .04 })),
    planets: [], dustLanes: [], deepSky: [], _starBuckets: new Map(),
    _rangeSky: { starBrightnessAt: () => 1 } };
  const draw = () => { rects.length = 0; BiomeManager.prototype._drawStarfield.call(m, ctx, { width: 1280, height: 720 }, { fx: '' }, { fx: '' }, 0, 1, { atmosphere: false }); return rects.map(([x]) => x).sort((a, b) => a - b); };
  const start = draw(); m.tSec = 150; const end = draw();
  const offsets = end.map((x, i) => x - start[i]);
  assert.ok(offsets[0] > 1);
  assert.ok(Math.max(...offsets) - Math.min(...offsets) < 1e-8);
  assert.deepEqual(draw(), end, 'pause/re-render holds angular positions');
});

test('granular galactic structure is deterministic, clustered and subpixel faint', () => {
  assert.equal(typeof catalogue.generateGalacticGranules, 'function');
  const points = catalogue.generateGalacticGranules(12, 800, 1280, 272);
  assert.equal(points.length, 800);
  assert.deepEqual(catalogue.generateGalacticGranules(12, 800, 1280, 272), points);
  for (const p of points) {
    assert.ok(p.x >= 0 && p.x <= 1280 && p.y >= 0 && p.y <= 272);
    assert.ok(p.sizePx < 1 && p.brightness > 0 && p.brightness < .35);
  }
  const pairs = points.slice(0, -1).filter((p, i) => Math.hypot(p.x - points[i + 1].x, p.y - points[i + 1].y) < 30);
  assert.ok(pairs.length > 200, 'correlated local groups rather than uniform scatter');
});

test('Range dims large decorative motes while retaining the true point-star catalogue', () => {
  const plan = createRangeSkyComposition(new SpaceRidge(315), { width: 1280, height: 720 });
  const draws = [], stack = [];
  const ctx = { globalAlpha: 1, save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
    beginPath() {}, arc() {}, fill() { draws.push(this.globalAlpha); } };
  const field = new ParticleField({ kind: 'pollen', color: '#ffdda0', count: 8, speed: 1 }, 1280, 720, 1);
  const profile = { name: 'TAIGA', celestial: { haloColor: '#ffdda0' } };
  const mgr = { _rangeSky: plan, openingGain: 1, currentBlend: { from: 'TAIGA', to: 'TAIGA' },
    fields: new Map([['TAIGA', field]]), _rotated: (c) => c, lerpCache: { get: (a) => a },
    swarm: { draw() {} }, murmuration: { draw() {} } };
  const draw = () => {
    draws.length = 0;
    BiomeManager.prototype._drawMidDepthLife.call(mgr, ctx, { width: 1280, height: 720 },
      { ctx, A: profile, B: profile, t: 1, particleMul: 1 },
      { worldX: 0, originX: 0, phenomenaFull: false, particleMul: 1, mandalaColor: '#ffdda0' });
    return draws.reduce((sum, a) => sum + a, 0);
  };
  const subdued = draw(); mgr._rangeSky = null; const ordinary = draw();
  assert.ok(subdued > 0 && subdued < ordinary * .25, 'large ambient dots recede from clusters');
});

test('Range moon traces a continuous lateral arc throughout long songs independently of storms', async () => {
  const sky = await import('../src/world/alpine/RangeSkyComposition.js');
  assert.equal(typeof sky.rangeMoonOrbit, 'function');
  const first = sky.rangeMoonOrbit(0, 180000), middle = sky.rangeMoonOrbit(90000, 180000), last = sky.rangeMoonOrbit(180000, 180000);
  assert.ok(first.azimuth01 < middle.azimuth01 && middle.azimuth01 < last.azimuth01);
  assert.ok(middle.altitude01 > first.altitude01 && middle.altitude01 > last.altitude01);
  assert.ok(first.altitude01 > 0 && last.altitude01 > 0, 'the finite song samples a visible part of the lunar arc');
  let previous = first;
  for (let t = 100; t <= 180000; t += 100) {
    const current = sky.rangeMoonOrbit(t, 180000);
    assert.ok(Math.abs(current.altitude01 - previous.altitude01) < .001);
    assert.ok(Math.abs(current.azimuth01 - previous.azimuth01) < .001);
    previous = current;
  }
  assert.deepEqual(sky.rangeMoonOrbit(90000, 180000), middle, 'seek reconstructs the same world direction');
});

test('tour moon projects a lateral orbit and below-horizon illumination through the resolved lens', async () => {
  const { projectRangeCelestials, tourSkyDirection } = await import('../src/world/alpine/RangeSkyComposition.js');
  const direction = tourSkyDirection(65, 3.75);
  const pose = { eyeM: [20, 2000, 30], targetM: direction.map((v, i) => [20, 2000, 30][i] + v * 10000), fovYDeg: 40, aspect: 16 / 9 };
  const state = { activeBody: 'moon', sun: { azimuth01: .5, altitude01: 0, radiusFrac: .01 },
    moon: { azimuth01: .3, altitude01: .625, radiusFrac: .01 } };
  const a = projectRangeCelestials(state, pose, 1, { xFrac: .5, altSigned: -.5 });
  const b = projectRangeCelestials({ ...state, moon: { ...state.moon, azimuth01: .7 } }, pose, 1, { xFrac: .5, altSigned: -.5 });
  assert.ok(a.moon.visible && b.moon.visible);
  assert.ok(Math.abs(a.moon.xFrac - b.moon.xFrac) > .05, 'orbit must cross the view rather than dive vertically');
  assert.ok(a.moon.illuminant.yFrac > a.moon.yFrac, 'the solar reference remains below the moon while the sun is down');
  assert.ok([...a.moon.worldDirection, a.moon.illuminant.xFrac, a.moon.illuminant.yFrac].every(Number.isFinite));
  const zoom = projectRangeCelestials(state, { ...pose, fovYDeg: 30 });
  assert.ok(Math.abs(zoom.moon.xFrac - .5) > Math.abs(a.moon.xFrac - .5), 'the moon uses the same narrowed view as the land');
  assert.deepEqual(projectRangeCelestials({ ...state, dawn01: 1, dusk01: 0 }, pose).moon.worldDirection,
    projectRangeCelestials({ ...state, dawn01: 0, dusk01: 1 }, pose).moon.worldDirection, 'twilight cannot flip compass direction');
});

test('the moon stays in the visible sky of the published Teton opening and return shots', async () => {
  const { rangeMoonOrbit, projectRangeCelestials } = await import('../src/world/alpine/RangeSkyComposition.js');
  // Measured final tour headings, pitches and lenses from the 96-second
  // generated 120 BPM baseline, before inspecting the candidate orbit.
  for (const [timeMs, heading, pitch, fovYDeg] of [[1000, 45, -5.4, 27.2], [45000, 75, -6.1, 27.1], [94000, 80, -7, 27.1]]) {
    const h = heading * Math.PI / 180, p = pitch * Math.PI / 180;
    const pose = { eyeM: [0, 0, 0], targetM: [Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p)], fovYDeg, aspect: 16 / 9 };
    const state = { sun: { azimuth01: 0, altitude01: 0, radiusFrac: .01 }, moon: { ...rangeMoonOrbit(timeMs, 96000), radiusFrac: .0175 } };
    const moon = projectRangeCelestials(state, pose).moon;
    // Position only: at midday (45 s) daylight hides the disc (discAlpha),
    // but the orbit stays framed so the moon is in place whenever it shows.
    assert.ok(moon.visible && moon.xFrac > .05 && moon.xFrac < .95 && moon.yFrac > .12 && moon.yFrac < .45,
      `the actual ${timeMs}ms camera must keep the moon's orbit position above its horizon after 64px overscan is cropped`);
  }
});

test('the moon\'s phase comes from its angle to the signed sun, in tours and rail views alike', async () => {
  const { rangeMoonOrbit, projectRangeCelestials, projectRailCelestials, rangeMoonIllumination, tourSkyDirection, MOON_MIN_ILLUMINATION } =
    await import('../src/world/alpine/RangeSkyComposition.js');
  const { resolveCelestialState } = await import('../src/world/CelestialState.js');
  const { songSkyClock, sunScreenFrac, cyclePhase01, CELESTIAL_RISE_XFRAC, CELESTIAL_SET_XFRAC } = await import('../src/world/DayNight.js');
  const durationMs = 240000, clock = songSkyClock(durationMs);
  const pose = { eyeM: [0, 0, 0], targetM: [700, 60, -700], fovYDeg: 38, aspect: 1408 / 848 };
  const rail = { referencePose: { ...pose, fovYDeg: 36 }, pose, aspect: pose.aspect };
  const at = seconds => {
    const timeMs = seconds * 1000, solar = sunScreenFrac(cyclePhase01(timeMs, clock));
    const state = resolveCelestialState({ timeMs, cycleMs: clock, viewport: { width: 1408, height: 848 }, moonOrbit: rangeMoonOrbit(timeMs, durationMs) });
    return { solar, state, tour: projectRangeCelestials(state, pose, 1, solar, 0).moon };
  };
  let previous = 1;
  for (let s = 0; s <= 20; s++) {
    const { tour } = at(s);
    assert.ok(tour.illumination >= .17 && tour.illumination <= .32, `predawn ${s}s is a crescent toward the rising sun: ${tour.illumination}`);
    assert.ok(tour.illumination < previous, 'the predawn crescent wanes toward sunrise');
    previous = tour.illumination;
  }
  for (let s = 195; s <= 240; s += 5) assert.ok(at(s).tour.illumination >= .95, `the moon opposite the setting sun is full at ${s}s`);
  for (const s of [0, 10, 120, 230]) {
    const { solar, state, tour } = at(s);
    // The signed sun that sets the lit side, not the resolved sun body,
    // which parks on the horizon all night (a false predawn full moon).
    const az = (solar.xFrac - CELESTIAL_RISE_XFRAC) / (CELESTIAL_SET_XFRAC - CELESTIAL_RISE_XFRAC);
    const sun = tourSkyDirection(100 + 150 * az, 32 * solar.altSigned);
    const expected = (1 - sun.reduce((sum, v, i) => sum + v * tour.worldDirection[i], 0)) / 2;
    assert.ok(Math.abs(tour.illumination - expected) < 1e-12);
    assert.ok(Math.abs(projectRangeCelestials(state, pose, 1, solar, 77).moon.illumination - expected) < 1e-12, 'a shot tour\'s heading turns both arcs');
    assert.ok(Math.abs(rangeMoonIllumination(solar, state.moon) - expected) < 1e-12, 'the camera-free helper agrees');
    const railMoon = projectRailCelestials(state, { from: rail, to: rail, mix: 0 }, solar).moon;
    assert.ok(Math.abs(railMoon.illumination - expected) < 1e-12, 'rail views share the tours\' phase');
  }
  const parked = at(10);
  const parkedElongation = parked.tour.worldDirection.reduce((sum, v, i) => sum + v * projectRangeCelestials(parked.state, pose).sun.worldDirection[i], 0);
  assert.ok((1 - parkedElongation) / 2 > .9 && parked.tour.illumination < .3, 'the parked sun would have drawn a predawn full moon');
  assert.equal('illumination' in projectRangeCelestials(parked.state, pose).moon, false, 'without a solar reference the painter keeps its fallback');
  assert.equal(MOON_MIN_ILLUMINATION, .16);
});

test('sun and moon subtend one angle that zooms with the tour and rail lenses', async () => {
  const { projectRangeCelestials, projectRailCelestials, rangeV2MoonRadius, BODY_RADIUS_BOUNDS } = await import('../src/world/alpine/RangeSkyComposition.js');
  const W = 1408, H = 848, aspect = W / H;
  const state = { sun: { azimuth01: .5, altitude01: .5, radiusFrac: .01, scale: 1 }, moon: { azimuth01: .3, altitude01: .6, radiusFrac: .01, scale: 1 } };
  const pose = fovYDeg => ({ eyeM: [0, 0, 0], targetM: [0, .1, -1], fovYDeg, aspect });
  const px = (p, lensScale = 1) => { const s = projectRangeCelestials(state, p, lensScale); assert.equal(s.sun.radiusFrac, s.moon.radiusFrac); return s.moon.radiusFrac * W; };
  // The median runtime tour lens (hfov 55 over the 848 px logical stage)
  // keeps the moon's established 3.5%-of-width size.
  assert.ok(Math.abs(px(pose(38)) - rangeV2MoonRadius(W)) < .5, `median lens radius ${px(pose(38))}`);
  const tan = f => Math.tan(f * Math.PI / 360);
  assert.ok(Math.abs(px(pose(23.1)) / px(pose(42.9)) - tan(42.9) / tan(23.1)) < 1e-9, 'the discs magnify with the land');
  assert.equal(px(pose(38), .7), px(pose(38)), 'the pose already carries the lens pulse');
  assert.ok(Math.abs(px({ ...pose(38), viewOffset: { fx: .2, rx: 0, uy: 0 } }) - px(pose(38)) / .8) < 1e-9, 'a pointer crop magnifies the disc');
  assert.ok(Math.abs(px(pose(4)) - BODY_RADIUS_BOUNDS[1] * H) < 1e-9 && Math.abs(px(pose(120)) - BODY_RADIUS_BOUNDS[0] * H) < 1e-9, 'bounded at extreme lenses');
  assert.ok(Math.abs(px(pose(38)) * 1.25 - projectRangeCelestials({ ...state, moon: { ...state.moon, scale: 2 } }, pose(38)).moon.radiusFrac * W) < 1e-9,
    'the approach still grows the discs, within its bound');
  const camera = fovYDeg => ({ referencePose: pose(30), pose: pose(fovYDeg), aspect });
  const rail = (from, to, mix) => projectRailCelestials(state, { from: camera(from), to: camera(to), mix });
  assert.ok(Math.abs(rail(23.1, 23.1, 0).moon.radiusFrac - px(pose(23.1)) / W) < 1e-12, 'a rail view uses its own lens');
  assert.ok(Math.abs(rail(23.1, 42.9, .25).moon.radiusFrac * W - (px(pose(23.1)) * .75 + px(pose(42.9)) * .25)) < 1e-9, 'and blends across a travel');
});

test('the native moon painter takes the geometric phase and the shared crescent floor', () => {
  const halfWidths = [];
  const ctx = new Proxy({}, { get: (target, key) => key in target ? target[key]
    : key === 'ellipse' ? (x, y, rx) => halfWidths.push(rx)
      : /^create(Linear|Radial)Gradient$/.test(key) ? () => ({ addColorStop() {} }) : () => {},
  set: (target, key, value) => { target[key] = value; return true; } });
  const manager = Object.assign(Object.create(BiomeManager.prototype), { world: { kind: 'alpine' }, _night01: 1 });
  const moon = illumination => ({ xFrac: .5, yFrac: .3, radiusFrac: .02, scale: 1, visible: true, illumination });
  for (const [illumination, f] of [[.9, .9], [.05, MOON_MIN_ILLUMINATION], [.5, .5]]) {
    halfWidths.length = 0;
    manager._drawMoon(ctx, { width: 1000, height: 600 }, .3, 1, 0, .5, .2, .9, .5, moon(illumination));
    assert.ok(Math.abs(halfWidths[0] - 20 * Math.abs(1 - 2 * f)) < 1e-9, `terminator for a ${illumination} lit moon`);
  }
});
