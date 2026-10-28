import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager, rangeSkyTwilight } from '../src/world/BiomeManager.js';
import { TWILIGHT, twilightAt, dayNight, sunScreenFrac, CELESTIAL_RISE_XFRAC, CELESTIAL_SET_XFRAC } from '../src/world/DayNight.js';
import { RangeSkyRenderer, skyProjector } from '../src/world/alpine/RangeSkyRenderer.js';
import { tourSkyDirection, projectRangeCelestials } from '../src/world/alpine/RangeSkyComposition.js';
import { sampleSkyPerformance } from '../src/world/alpine/SkyPerformance.js';

const camera = { tourPose: { eyeM: [0, 0, 0], targetM: [0, .22, -1], fovYDeg: 50, aspect: 16 / 9 } };
const project = skyProjector(camera);
const W = 1280, H = 720;

// The same recording context as skyPerformance.test.js, also recording
// which gradients were created.
function recordingContext() {
  const ops = [], stack = [], created = [];
  const gradient = kind => (...args) => {
    const g = { kind, args, stops: [], addColorStop(at, color) { this.stops.push([at, color]); } };
    created.push(g);
    return g;
  };
  const styleOf = style => typeof style === 'string' ? style : { args: style.args, stops: style.stops };
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1,
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.lineWidth]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation, this.lineWidth] = stack.pop(); },
    createLinearGradient: gradient('linear'), createRadialGradient: gradient('radial'),
    getTransform: () => ({ a: 1, b: 0 }),
    beginPath() { this.path = []; },
    arc(...args) { this.path.push(['arc', ...args]); },
    moveTo(...args) { this.path.push(['move', ...args]); },
    lineTo(...args) { this.path.push(['line', ...args]); },
    rect() {}, clip() {}, translate() {}, scale() {},
    fill() { ops.push({ kind: 'fill', path: this.path, style: styleOf(this.fillStyle) }); },
    stroke() { ops.push({ kind: 'stroke', path: this.path, style: styleOf(this.strokeStyle), width: this.lineWidth, alpha: this.globalAlpha }); },
    fillRect(...rect) {
      ops.push({ kind: 'rect', rect, style: styleOf(this.fillStyle), alpha: this.globalAlpha, op: this.globalCompositeOperation });
    },
  };
  return { ctx, ops, created };
}

const DUSK = rangeSkyTwilight({ amount01: .8, rising: false, xFrac: .3, colors: TWILIGHT.dusk });
const sunAt = (azDeg, altDeg, altitude01 = 0) => Object.freeze({ xFrac: .5, yFrac: .7, altitude01, visibility: 1,
  worldDirection: Object.freeze(tourSkyDirection(azDeg, altDeg)) });
const baseFrame = Object.freeze({ seed: 315, camera, sourceWidth: W, sourceHeight: H, timeSec: 12, night: .2,
  colors: Object.freeze({ top: '#273060', mid: '#8a4a70', horizon: '#ff7a3a' }) });

function glow(frame) {
  const sky = new RangeSkyRenderer(), { ctx, ops, created } = recordingContext();
  sky._twilightGlow(ctx, project, W, H, { ...baseFrame, ...frame });
  return { ops, radial: created.filter(g => g.kind === 'radial'), linear: created.filter(g => g.kind === 'linear') };
}
function drawFull(frame) {
  const sky = new RangeSkyRenderer();
  for (const method of ['_milkyWay', '_stars', '_aurora', '_bodies', '_clouds']) sky[method] = () => {};
  const { ctx, ops } = recordingContext();
  assert.equal(sky.draw(ctx, { ...baseFrame, ...frame }), true);
  sky.dispose();
  return ops;
}

test('the frozen twilight copies strings and is null when faint', () => {
  assert.equal(rangeSkyTwilight(null), null);
  assert.equal(rangeSkyTwilight(undefined), null);
  assert.equal(rangeSkyTwilight({ amount01: .01, colors: TWILIGHT.dawn }), null);
  assert.equal(rangeSkyTwilight({ amount01: NaN, colors: TWILIGHT.dawn }), null);
  const live = { amount01: .6, rising: 1, xFrac: Infinity, colors: { glow: '#ff7a2a', horizon: '#ff4a1c' } };
  const copy = rangeSkyTwilight(live);
  assert.ok(Object.isFrozen(copy));
  assert.deepEqual(copy, { amount01: .6, rising: true, xFrac: null, glow: '#ff7a2a', horizon: '#ff4a1c', mid: '#ff4a1c' });
  live.colors.glow = '#000000';
  assert.equal(copy.glow, '#ff7a2a', 'no reference to a mutable palette');
  assert.ok(!Object.values(copy).some(value => typeof value === 'object' && value), 'only primitives');
  const real = twilightAt(.5 * .97);
  if (real.amount01 > .01) assert.equal(rangeSkyTwilight(real).glow, real.colors.glow);
});

test('the snapshot carries a frozen twilight copy into the high-resolution sky', () => {
  const manager = Object.assign(Object.create(BiomeManager.prototype), {
    rangePresentation: { skyPan: camera, frame: {} }, _pass: () => false,
    _rotated: value => value, lerpCache: { get: value => value },
    _moonPhase01: () => .5, tSec: 12, highResolutionSky: true,
  });
  const ctx = { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  const profile = { sky: ['#123456', '#345678', '#789abc'] };
  manager._prepareHighResolutionSky(ctx, { width: W, height: H }, profile, profile, 0, 0);
  assert.equal(manager.rangeSkyLayer.twilight, null, 'no twilight state, no field');
  manager._twilight = { amount01: .7, rising: false, xFrac: .4, colors: TWILIGHT.dusk };
  manager._prepareHighResolutionSky(ctx, { width: W, height: H }, profile, profile, 0, 0);
  const { twilight } = manager.rangeSkyLayer;
  assert.ok(Object.isFrozen(manager.rangeSkyLayer) && Object.isFrozen(twilight));
  assert.notEqual(twilight, TWILIGHT.dusk);
  assert.deepEqual(twilight, { amount01: .7, rising: false, xFrac: .4,
    glow: TWILIGHT.dusk.glow, horizon: TWILIGHT.dusk.horizon, mid: TWILIGHT.dusk.mid });
  manager._twilight = { amount01: .005, rising: false, xFrac: .4, colors: TWILIGHT.dusk };
  manager._prepareHighResolutionSky(ctx, { width: W, height: H }, profile, profile, 0, 0);
  assert.equal(manager.rangeSkyLayer.twilight, null);
});

test('(a) absent or faint twilight paints exactly what the sky painted before', () => {
  const sun = sunAt(10, -3);
  const without = drawFull({ sun });
  assert.equal(without.length, 1, 'the established grade only');
  assert.deepEqual(drawFull({ sun, twilight: null }), without);
  assert.deepEqual(drawFull({ sun, twilight: { ...DUSK, amount01: 0 } }), without);
  assert.deepEqual(drawFull({ sun, twilight: { ...DUSK, amount01: .01 } }), without);
});

test('(b) the glow centres on the sun azimuth, also while the sun is below the horizon', () => {
  for (const [az, alt, altitude01] of [[10, -3, 0], [-15, 4, .2], [0, -8, 0]]) {
    const { radial, ops } = glow({ twilight: DUSK, sun: sunAt(az, alt, altitude01) });
    assert.equal(radial.length, 1, `az ${az}: exactly one radial glow`);
    const expected = project(tourSkyDirection(az, 2));
    assert.ok(Math.abs(radial[0].args[0] - expected.xFrac * W) < 1e-6, "centre x is the projected sun azimuth");
    assert.ok(Math.abs(radial[0].args[1] - expected.yFrac * H) < 1e-6);
    assert.deepEqual(radial[0].stops, [[0, DUSK.glow], [.35, DUSK.horizon], [1, 'rgba(0,0,0,0)']]);
    const fill = ops.find(op => op.style.args === radial[0].args);
    assert.equal(fill.op, 'lighter');
    assert.ok(fill.rect[0] >= 0 && fill.rect[1] >= 0 && fill.rect[0] + fill.rect[2] <= W + 1e-9
      && fill.rect[1] + fill.rect[3] <= H + 1e-9, 'clamped to the frame');
    assert.ok(fill.alpha > 0 && fill.alpha <= .55 * DUSK.amount01 + 1e-12);
  }
  const low = glow({ twilight: DUSK, sun: sunAt(10, -3, 0) }).ops[0].alpha;
  const high = glow({ twilight: DUSK, sun: sunAt(10, 10, .5) }).ops[0].alpha;
  assert.ok(Math.abs(high - low * .4) < 1e-12, 'drawSun\'s glare takes over as the sun climbs');
  const cinematic = glow({ twilight: DUSK, sun: sunAt(10, -3, 0), cinematicPixel: true }).ops[0].alpha;
  assert.ok(Math.abs(cinematic - low * .7) < 1e-12);
});

test('(c) facing away from the sun shows the Belt of Venus, not a glow', () => {
  const { radial, linear, ops } = glow({ twilight: DUSK, sun: sunAt(180, -3, 0) });
  assert.equal(radial.length, 0, 'the sun behind the camera has no glow');
  assert.equal(linear.length, 1);
  assert.equal(ops.length, 1);
  const [band] = ops;
  assert.notEqual(band.op, 'lighter');
  assert.match(band.style.stops[1][1], /^rgba\(232,170,190,/);
  assert.match(band.style.stops[2][1], /^rgba\(120,130,160,/);
  assert.ok(Math.abs(Number(/,([^,]+)\)$/.exec(band.style.stops[2][1])[1]) - .22 * DUSK.amount01) < 1e-12);
  assert.equal(band.rect[0], 0, 'no left edge inside the frame');
  assert.equal(band.rect[2], W, 'no right edge inside the frame');
  assert.ok(band.rect[3] <= H * .12 + 1e-9, 'a horizon strip, not a wash');
  // Without the tour's world direction there is no antisolar point.
  const rail = glow({ twilight: DUSK, sun: { xFrac: .5, yFrac: .7, altitude01: 0 } });
  assert.equal(rail.linear.length, 0);
  assert.equal(rail.radial.length, 1, 'the rail sky falls back to the twilight x');
  assert.equal(rail.radial[0].args[0], DUSK.xFrac * W);
  const clamped = glow({ twilight: { ...DUSK, xFrac: 3 }, sun: null });
  assert.equal(clamped.radial[0].args[0], 1.2 * W);
  const none = glow({ twilight: { ...DUSK, xFrac: null }, sun: { altitude01: 0 } });
  assert.deepEqual(none.ops, [], 'no position, no glow');
});

const beltAlpha = offDeg => {
  const band = glow({ twilight: DUSK, sun: sunAt(180 + offDeg, -3, 0) }).ops.find(op => op.op === 'screen');
  if (!band) return 0;
  assert.equal(band.rect[0], 0);
  assert.equal(band.rect[2], W);
  return Number(/,([^,]+)\)$/.exec(band.style.stops[2][1])[1]);
};

test('(c) the band fades as the heading turns from the antisolar point, never cut', () => {
  let previous = Infinity;
  for (let off = 0; off <= 80; off += 5) {
    const alpha = beltAlpha(off);
    assert.ok(alpha <= previous + 1e-15, `${off} deg off: ${alpha} after ${previous}`);
    previous = alpha;
  }
  assert.ok(Math.abs(beltAlpha(0) - .22 * DUSK.amount01) < 1e-12);
  assert.ok(beltAlpha(60) > 0 && beltAlpha(60) < beltAlpha(30), 'still there, fainter, at 60 deg');
  assert.equal(beltAlpha(80), 0, 'gone before it would face across the sun');
  assert.ok(Math.abs(beltAlpha(-45) - beltAlpha(45)) < 1e-12, 'symmetric about the antisolar heading');
});

// The tour bodies as RangePresentation projects them at cycle phase p:
// the resolved (parked) sun body, and the signed sun for the moon.
const CYCLE = 600000, POSE = camera.tourPose;
const tourSun = (p, offsetDeg) => {
  const dn = dayNight(p * CYCLE, CYCLE), moon = { azimuth01: .5, altitude01: .3, scale: 1 };
  return projectRangeCelestials({ sun: { azimuth01: dn.sunAz01, altitude01: dn.sunAlt, scale: 1 }, moon },
    POSE, 1, sunScreenFrac(p), offsetDeg).sun;
};
// The signed sun's compass azimuth, from the same arc mapping.
const solarAzimuth = (p, offsetDeg) => {
  const solar01 = (sunScreenFrac(p).xFrac - CELESTIAL_RISE_XFRAC) / (CELESTIAL_SET_XFRAC - CELESTIAL_RISE_XFRAC);
  const dir = projectRangeCelestials({ sun: { azimuth01: solar01, altitude01: 0, scale: 1 },
    moon: { azimuth01: .5, altitude01: .3, scale: 1 } }, POSE, 1, null, offsetDeg).sun.worldDirection;
  return Math.atan2(dir[0], -dir[2]) * 180 / Math.PI;
};

test('predawn twilight glows at the sunrise azimuth, not where the sun body parked at sunset', () => {
  const offset = -100; // the sunrise end of the arc straight ahead
  for (const p of [.97, .98, .99]) {
    const sun = tourSun(p, offset), twilight = rangeSkyTwilight(twilightAt(p));
    assert.equal(sun.azimuth01, 1, 'the resolved body is parked at its set azimuth');
    assert.ok(twilight && twilight.rising);
    const { radial } = glow({ twilight, sun });
    assert.equal(radial.length, 1, `p ${p}: a predawn glow`);
    const expected = project(tourSkyDirection(solarAzimuth(p, offset), 2));
    assert.ok(Math.abs(radial[0].args[0] - expected.xFrac * W) < 1e-6, `p ${p}: centred on the signed sun`);
    assert.ok(Math.abs(radial[0].args[1] - expected.yFrac * H) < 1e-6);
  }
  // Across the sunrise wrap (sunAz01 1 -> 0) the glow does not jump.
  const centre = p => glow({ twilight: rangeSkyTwilight(twilightAt(p)), sun: tourSun(p, offset) }).radial[0].args[0];
  assert.ok(Math.abs(centre(.999) - centre(.001)) < .02 * W, `${centre(.999)} -> ${centre(.001)}`);
  // Dusk: the band sits opposite the signed sun, so it faces away from sunrise.
  const dawnBand = glow({ twilight: rangeSkyTwilight(twilightAt(.98)), sun: tourSun(.98, offset) });
  assert.equal(dawnBand.linear.length, 0, 'the antisolar band is behind a view facing the sunrise');
});

test('a published signed solar direction is used as is', () => {
  const sun = Object.freeze({ ...sunAt(170, -3, 0), azimuth01: 1, solarDirection: Object.freeze(tourSkyDirection(12, -5)) });
  const { radial } = glow({ twilight: DUSK, sun });
  assert.equal(radial.length, 1);
  assert.ok(Math.abs(radial[0].args[0] - project(tourSkyDirection(12, 2)).xFrac * W) < 1e-6);
});

test('the renderer\'s sun arc sweep matches the tour projection', () => {
  // Offset so that mid-arc lies straight ahead.
  const az = a01 => {
    const dir = projectRangeCelestials({ sun: { azimuth01: a01, altitude01: 0, scale: 1 },
      moon: { azimuth01: .5, altitude01: .3, scale: 1 } }, POSE, 1, null, -175).sun.worldDirection;
    return Math.atan2(dir[0], -dir[2]) * 180 / Math.PI;
  };
  // Mid-arc twilight x moves a parked body by exactly the arc's sweep.
  const sun = Object.freeze({ altitude01: 0, azimuth01: 1, worldDirection: Object.freeze(tourSkyDirection(az(1), 0)) });
  const mid = (CELESTIAL_RISE_XFRAC + CELESTIAL_SET_XFRAC) / 2; // half way along the arc
  const { radial } = glow({ twilight: { ...DUSK, xFrac: mid }, sun });
  const expected = project(tourSkyDirection(az(.5), 2));
  assert.ok(Math.abs(radial[0].args[0] - expected.xFrac * W) < 1e-6);
});

test('(d) a frozen frame paints identically every time', () => {
  const frame = Object.freeze({ twilight: DUSK, sun: sunAt(20, -2, 0) });
  assert.deepEqual(drawFull(frame), drawFull(frame));
  assert.equal(drawFull(frame).length, 2, 'grade plus one glow');
  assert.deepEqual(glow({ twilight: DUSK, sun: sunAt(180, -3, 0) }).ops, glow({ twilight: DUSK, sun: sunAt(180, -3, 0) }).ops);
});

test('(e) a full storm deck takes the glow and the band away', () => {
  assert.deepEqual(glow({ twilight: DUSK, sun: sunAt(10, -3), storm: { amount: 1 } }).ops, []);
  assert.deepEqual(glow({ twilight: DUSK, sun: sunAt(180, -3), storm: { amount: 1 } }).ops, []);
  const half = glow({ twilight: DUSK, sun: sunAt(10, -3), storm: { amount: .5 } }).ops[0].alpha;
  assert.ok(Math.abs(half - glow({ twilight: DUSK, sun: sunAt(10, -3) }).ops[0].alpha * .5) < 1e-12);
});

test('the glow lies under the music sweeps, and the bodies get the one sampled score', () => {
  const sky = new RangeSkyRenderer(), order = [];
  for (const method of ['_milkyWay', '_stars', '_aurora', '_clouds']) sky[method] = () => {};
  sky._twilightGlow = () => order.push('twilight');
  sky._musicAtmosphere = () => order.push('sweeps');
  const seen = [];
  sky.celestial.drawSun = (ctx, sun, w, h, storm, options) => seen.push(['sun', options.music, options.quiet]);
  sky.celestial.drawMoon = (...args) => seen.push(['moon', args[9].music]);
  const effects = Object.freeze({ energy: .6, bass: .5, accents: Object.freeze([]) });
  const { ctx } = recordingContext();
  sky.draw(ctx, { ...baseFrame, twilight: DUSK, sun: sunAt(10, -3), effects });
  assert.deepEqual(order, ['twilight', 'sweeps']);
  assert.deepEqual(seen[0][1], sampleSkyPerformance(effects));
  assert.equal(seen[1][1], seen[0][1], 'one score object for both bodies');
  assert.equal(seen[0][2], false);
  seen.length = 0;
  sky.draw(recordingContext().ctx, { ...baseFrame });
  assert.deepEqual(seen, [['sun', null, false], ['moon', null]], 'no score, no music');
  sky.dispose();
});
