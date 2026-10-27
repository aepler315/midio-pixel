import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { skyProjector, createSkyCatalogue, createGalacticClouds, cloudDensity, RangeSkyRenderer } from '../src/world/alpine/RangeSkyRenderer.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { TWILIGHT } from '../src/world/DayNight.js';

test('sky directions use the terrain perspective including its off-axis camera crop', () => {
  const pose = { eyeM: [400, 1000, 1200], targetM: [100, 1200, 0], fovYDeg: 42,
    viewOffset: { fx: .3, rx: .08, uy: -.04 }, aspect: 16 / 9 };
  const project = skyProjector({ tourPose: pose });
  const camera = new THREE.PerspectiveCamera(pose.fovYDeg, pose.aspect, 20, 150000);
  camera.position.fromArray(pose.eyeM); camera.lookAt(...pose.targetM);
  const tan = Math.tan(pose.fovYDeg * Math.PI / 360), { fx, rx, uy } = pose.viewOffset;
  camera.setViewOffset(1600, 900, (fx + rx / (tan * pose.aspect)) * 800,
    (fx - uy / tan) * 450, (1 - fx) * 1600, (1 - fx) * 900);
  camera.updateMatrixWorld();
  for (const direction of [[0, .2, -1], [-.3, .4, -1], [.2, -.1, -1]]) {
    const expected = new THREE.Vector3(...direction).multiplyScalar(20000).add(camera.position).project(camera);
    const actual = project(direction);
    assert.ok(Math.abs(actual.xFrac - (expected.x + 1) / 2) < 1e-10);
    assert.ok(Math.abs(actual.yFrac - (1 - expected.y) / 2) < 1e-10);
  }
});

test('world sky anchors turn with the camera but do not acquire terrain translation parallax', () => {
  const pose = { eyeM: [0, 0, 0], targetM: [0, 0, -1000], fovYDeg: 50, aspect: 16 / 9 };
  const a = skyProjector({ tourPose: pose })([0, .2, -1]);
  const translated = skyProjector({ tourPose: { ...pose, eyeM: [200, 50, 100], targetM: [200, 50, -900] } })([0, .2, -1]);
  assert.deepEqual(translated, a);
  const turned = skyProjector({ tourPose: { ...pose, targetM: [400, 0, -1000] } })([0, .2, -1]);
  assert.ok(turned.xFrac < a.xFrac - .1);
});

test('extended sky shapes retain offscreen endpoints that remain in front of the lens', () => {
  const pose = { eyeM: [0, 0, 0], targetM: [0, 0, -1000], fovYDeg: 50, aspect: 16 / 9 };
  const project = skyProjector({ tourPose: pose });
  const outside = project([2, .2, -1]);
  assert.equal(outside.visible, false);
  assert.equal(outside.inFront, true);
  assert.equal(project([0, .2, 1]).inFront, false);
  const rail = skyProjector({ skyCamera: { from: { pose, aspect: pose.aspect },
    to: { pose: { ...pose, targetM: [400, 0, -1000] }, aspect: pose.aspect }, mix: .4 } });
  const a = project([2, .2, -1]);
  const b = skyProjector({ tourPose: { ...pose, targetM: [400, 0, -1000] } })([2, .2, -1]);
  assert.ok(Math.abs(rail([2, .2, -1]).xFrac - (a.xFrac * .6 + b.xFrac * .4)) < 1e-10);
});

test('sky textures use smooth sampling even after native pixel terrain presentation', () => {
  const sky = new RangeSkyRenderer();
  const stack = [];
  const ctx = {
    imageSmoothingEnabled: false, imageSmoothingQuality: 'low',
    save() { stack.push([this.imageSmoothingEnabled, this.imageSmoothingQuality]); },
    restore() { [this.imageSmoothingEnabled, this.imageSmoothingQuality] = stack.pop(); },
    createLinearGradient() { return { addColorStop() {} }; }, fillRect() {},
  };
  let inspected = 0;
  for (const method of ['_milkyWay', '_stars', '_aurora', '_bodies', '_clouds']) sky[method] = c => {
    assert.equal(c.imageSmoothingEnabled, true);
    assert.equal(c.imageSmoothingQuality, 'high');
    inspected++;
  };
  sky.draw(ctx, { camera: { tourPose: { eyeM: [0, 0, 0], targetM: [0, 0, -1], fovYDeg: 50, aspect: 16 / 9 } },
    seed: 3, sourceWidth: 1280, sourceHeight: 720, night: 1, timeSec: 1, colors: { top: '#000', mid: '#123', horizon: '#456' } });
  assert.equal(inspected, 5);
  assert.equal(ctx.imageSmoothingEnabled, false, 'the caller retains its native terrain sampling policy');
  sky.dispose();
});

test('finite cloud sprites have distinct stable shapes and scale smoothly with the destination', () => {
  const sky = new RangeSkyRenderer();
  sky.seed = 4;
  const indices = [], matrices = [];
  sky._cloud = index => { indices.push(index); return {}; };
  const ctx = { save() {}, restore() {}, transform(...matrix) { matrices.push(matrix); }, drawImage() {} };
  const camera = { tourPose: { eyeM: [0, 2500, 0], targetM: [0, 3500, -40000], fovYDeg: 50, aspect: 16 / 9 } };
  try {
    sky._clouds(ctx, camera, 1280, 720, 1, 0);
    const first = structuredClone(matrices), firstIndices = [...indices];
    assert.ok(first.length > 0);
    assert.ok(indices.every(Number.isInteger));
    assert.equal(new Set(indices).size, indices.length, 'visible world banks must not repeat a six-sprite catalogue');
    indices.length = matrices.length = 0;
    sky._clouds(ctx, camera, 2560, 1440, 1, 0);
    assert.deepEqual(indices, firstIndices, 'resizing cannot change the world cloud catalogue');
    assert.deepEqual(matrices, first.map(matrix => matrix.map(value => value * 2)));
  } finally { sky.dispose(); }
});

test('aurora paints bounded emission rays through the narrowest tour lens', () => {
  const sky = new RangeSkyRenderer();
  const project = skyProjector({ tourPose: { eyeM: [0, 0, 0], targetM: [0, Math.tan(20 * Math.PI / 180), -1],
    fovYDeg: 5, aspect: 16 / 9 } });
  const pieces = [];
  let points = [];
  const ctx = {
    save() {}, restore() {}, createLinearGradient() { return { addColorStop() {} }; },
    beginPath() { points = []; }, moveTo(x, y) { points.push([x, y]); },
    lineTo(x, y) { points.push([x, y]); }, stroke() { pieces.push(points); },
  };
  sky._aurora(ctx, project, 1280, 720, 1, 0, 1);
  assert.ok(pieces.length > 100 && pieces.length < 2000, `bounded smooth visible rays: ${pieces.length}`);
  assert.ok(pieces.every(p => p.flat().every(Number.isFinite)));
  assert.ok(pieces.every(p => p.length === 2), 'the sky has vertical ray strokes rather than filled ribbon panels');
  assert.ok(pieces.some(p => Math.min(...p.map(v => v[1])) < 0 && Math.max(...p.map(v => v[1])) > 720),
    'a curtain crossing both viewport edges remains drawable');
  sky.dispose();
});

test('the star catalogue and cloud density reconstruct after seeks without frame history', () => {
  assert.deepEqual(createSkyCatalogue(41), createSkyCatalogue(41));
  assert.notDeepEqual(createSkyCatalogue(41), createSkyCatalogue(42));
  const stars = createSkyCatalogue(41);
  assert.ok(stars.length >= 1500);
  for (const star of stars) assert.ok(Math.abs(Math.hypot(...star.direction) - 1) < 1e-10);
  assert.deepEqual(createGalacticClouds(41), createGalacticClouds(41));
  assert.notDeepEqual(createGalacticClouds(41), createGalacticClouds(42));
  assert.equal(createGalacticClouds(41).length, 432);
  const density = Array.from({ length: 64 }, (_, i) => cloudDensity(i % 8 / 7, Math.floor(i / 8) / 7, 41));
  assert.ok(density.every(Number.isFinite));
  assert.ok(density.some(d => d > .25) && density.some(d => d === 0), 'clouds contain opaque structure and open gaps');
  const reflected = Array.from({ length: 64 }, (_, i) => cloudDensity(i % 8 / 7, 1 - Math.floor(i / 8) / 7, 41));
  assert.notDeepEqual(density, reflected, 'the cloud has an upper silhouette and a distinct lower base');
});

/** A 2D context that records every paint with its effective state. */
function recordingContext() {
  const ops = [], stack = [];
  const gradient = kind => { const stops = []; return { kind, stops, addColorStop: (offset, color) => stops.push([offset, color]) }; };
  const paint = (ctx, op, extra = {}) => ops.push({ op, alpha: ctx.globalAlpha, mode: ctx.globalCompositeOperation, style: ctx.fillStyle, ...extra });
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000000',
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.fillStyle]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation, this.fillStyle] = stack.pop(); },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createRadialGradient: (...args) => Object.assign(gradient('radial'), { args }), createLinearGradient: () => gradient('linear'),
    translate() {}, scale() {}, rotate() {}, beginPath() {}, rect() {}, arc() {}, ellipse() {}, closePath() {}, clip() {},
    fillRect(...rect) { paint(this, 'fillRect', { rect }); },
    fill() { paint(this, 'fill'); },
    drawImage(image, ...rect) { paint(this, 'drawImage', { image, rect }); },
  };
  return { ctx, ops };
}
const alphaOf = color => { const m = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(color); return m ? Number(m[1]) : 1; };
/** The strongest opacity a recorded paint can reach. */
const peakAlpha = op => op.alpha * (typeof op.style === 'string' || op.op === 'drawImage' ? (op.op === 'drawImage' ? 1 : alphaOf(op.style))
  : Math.max(...op.style.stops.map(([, color]) => alphaOf(color))));
function bakingCanvas() {
  const canvas = { width: 0, height: 0, bakes: 0 };
  canvas.getContext = () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(image) { canvas.bakes++; canvas.pixels = image.data.slice(); },
  });
  return canvas;
}

test('a Landscape moon hidden by daylight paints nothing; the sun\'s glare fades with its horizon visibility, its disc stays solid', () => {
  const sky = new RangeSkyRenderer({ makeCanvas: bakingCanvas });
  sky._seed(7);
  const moon = { xFrac: .6, yFrac: .3, altitude01: .6, radiusFrac: .02, visibility: 1, visible: true };
  const sun = { xFrac: .3, yFrac: .4, altitude01: .5, radiusFrac: .02, visibility: 1, visible: true, colorHex: '#fff3df' };
  const paints = frame => { const { ctx, ops } = recordingContext(); sky._bodies(ctx, { phase: .5, ...frame }, 1408, 848, 0); return ops; };
  const glow = ops => Math.max(...ops.filter(op => op.mode === 'screen').map(peakAlpha));
  const disc = ops => ops.find(op => op.op === 'fill')?.alpha ?? 0;
  try {
    assert.deepEqual(paints({ moon: { ...moon, discAlpha: 0 } }), [], 'no disc, backing or glow from a gated moon');
    assert.ok(paints({ moon: { ...moon, discAlpha: 1 } }).length > 0);
    assert.deepEqual(paints({ sun: { ...sun, visibility: 0 } }), [], 'a sun on the waterline has faded out');
    const full = paints({ sun }), half = paints({ sun: { ...sun, visibility: .5 } });
    assert.ok(glow(full) > .5 && Math.abs(glow(half) - glow(full) / 2) < 1e-9, `the glare fades with visibility: ${glow(half)} of ${glow(full)}`);
    // The land in front hides a setting sun; a see-through disc behind a
    // ridge read as a pale moon.
    assert.equal(disc(full), 1);
    assert.equal(disc(half), 1, 'half way down its horizon band the disc is still solid');
    assert.equal(disc(paints({ sun: { ...sun, visibility: .2 } })), 1);
    const last = disc(paints({ sun: { ...sun, visibility: .05 } }));
    assert.ok(last > 0 && last < .5, `only the last of the fade thins it: ${last}`);
    // Sinking, it dims the way a setting sun does instead.
    const centre = ops => ops.find(op => op.op === 'fill').style.stops[0][1].match(/[\d.]+/g).slice(0, 3).map(Number);
    const lit = centre(full), dimmed = centre(paints({ sun: { ...sun, visibility: .2 } }));
    assert.ok(dimmed.every((v, i) => v < lit[i]) && dimmed[0] > .5 * lit[0], `dimmer, not gone: ${dimmed} of ${lit}`);
  } finally { sky.dispose(); }
});

test('the sun\'s bloom falls from its centre, with no bright ring at the limb', () => {
  const sky = new RangeSkyRenderer({ makeCanvas: bakingCanvas });
  try {
    for (const altitude01 of [.6, .02]) {
      const { ctx, ops } = recordingContext();
      sky._bodies(ctx, { sun: { xFrac: .4, yFrac: .4, radiusFrac: .02, visibility: 1, visible: true, altitude01, colorHex: '#ff9a5a' } }, 1408, 848, 0);
      const glows = ops.filter(op => op.mode === 'screen' && op.style.kind === 'radial');
      assert.equal(glows.length, 2, 'glare and bloom');
      for (const op of glows) {
        assert.equal(op.style.args[2], 0, 'every glow starts at the centre, never at a ring');
        const alphas = op.style.stops.map(([, color]) => alphaOf(color));
        assert.ok(alphas.every((a, i) => !i || a <= alphas[i - 1]), `altitude ${altitude01}: monotonic falloff ${alphas}`);
      }
    }
  } finally { sky.dispose(); }
});

test('a storm deck veils the sun and moon: no hard disc under it, a soft glow over it, nothing through the full deck', () => {
  const sky = new RangeSkyRenderer({ makeCanvas: bakingCanvas });
  sky._seed(7);
  const sun = { xFrac: .4, yFrac: .3, altitude01: .5, radiusFrac: .02, visibility: 1, visible: true, colorHex: '#fff3df' };
  const moon = { xFrac: .6, yFrac: .3, altitude01: .6, radiusFrac: .02, visibility: 1, visible: true, illumination: .9, illuminant: { xFrac: .1, yFrac: .5 } };
  const under = (frame, night = 0) => { const { ctx, ops } = recordingContext(); sky._bodies(ctx, { phase: .5, ...frame }, 1408, 848, night); return ops; };
  const over = (frame, night = 0) => { const { ctx, ops } = recordingContext(); sky._veiledBodies(ctx, { phase: .5, ...frame }, 1408, 848, night); return ops; };
  const storm = amount => ({ amount, flash: 0, break01: 0, wet01: 0 });
  try {
    assert.ok(under({ sun, storm: storm(0) }).some(op => op.op === 'fill'), 'clear sky: the solid disc');
    assert.deepEqual(over({ sun, storm: storm(0) }), [], 'nothing over a clear sky');
    assert.deepEqual(over({ sun, storm: { amount: 0, break01: 1 } }), [], 'a broken storm is clear sky again');
    const thin = storm(.6);
    assert.deepEqual(under({ sun, storm: thin }), [], 'under a half-dense deck the hard disc is gone');
    const veiled = over({ sun, storm: thin });
    assert.ok(veiled.length === 2 && veiled.every(op => op.mode === 'screen' && op.op === 'fillRect'), 'a soft patch and a soft disc, screened over the deck');
    const soft = veiled.at(-1).style.stops.map(([, color]) => alphaOf(color));
    assert.ok(soft[0] > .6 && soft.at(-1) === 0, `a bright watery disc that blurs out: ${soft}`);
    const full = over({ sun, storm: storm(1) });
    assert.equal(full.length, 1, 'the full deck shows only a patch of light');
    assert.ok(peakAlpha(full[0]) < .15, `and a faint one: ${peakAlpha(full[0])}`);
    const between = storm(.3);
    assert.ok(under({ sun, storm: between }).some(op => op.op === 'fill') && over({ sun, storm: between }).length, 'a hazy deck crossfades the two');
    // The moon follows the same deck.
    assert.ok(!under({ moon, storm: storm(.7) }, 1).length, 'no lit face under the deck');
    assert.ok(over({ moon, storm: storm(.7) }, 1).length === 1, 'a soft glow through it');
    assert.deepEqual(over({ moon, storm: storm(1) }, 1), [], 'nothing through the full deck');
  } finally { sky.dispose(); }
});

test('the moon screens its lit face onto the sky with no opaque backing, day or night', () => {
  const sky = new RangeSkyRenderer({ makeCanvas: bakingCanvas });
  sky._seed(7);
  const moon = { xFrac: .6, yFrac: .3, altitude01: .6, radiusFrac: .02, visibility: 1, visible: true, illumination: .6,
    illuminant: { xFrac: .2, yFrac: .3 } };
  try {
    for (const night of [0, 1]) {
      const { ctx, ops } = recordingContext();
      sky._bodies(ctx, { moon, phase: .5 }, 1408, 848, night);
      assert.ok(ops.some(op => op.op === 'drawImage'), 'the textured face draws');
      assert.ok(ops.every(op => op.mode === 'screen'), `night ${night}: the dark side shows the sky instead of a disc darker than it`);
      assert.equal(ops.some(op => op.op === 'fillRect'), night === 1, 'the aureole is a night glow');
    }
  } finally { sky.dispose(); }
});

test('the lit moon bakes once for the main sky and its smaller water mirror, and rebakes for a new phase', () => {
  const residency = new GraphicsResidency({ budgetBytes: 8 * 1024 ** 2 });
  const sky = new RangeSkyRenderer({ residency, makeCanvas: bakingCanvas });
  sky._seed(7);
  const moon = { xFrac: .6, yFrac: .3, altitude01: .6, radiusFrac: .0175, visibility: 1, visible: true, illumination: .3,
    illuminant: { xFrac: .9, yFrac: .8 } };
  const textures = (frame, outputScale) => {
    const { ctx, ops } = recordingContext();
    sky._bodies(ctx, { phase: .5, ...frame }, 1408, 848, 1, outputScale);
    return ops.filter(op => op.op === 'drawImage').map(op => op.image);
  };
  try {
    const [main] = textures({ moon }, 1.5), [mirror] = textures({ moon }, .4);
    assert.equal(mirror, main, 'the mirror reuses the main texture at its sticky size');
    assert.equal(main.bakes, 1);
    assert.equal(main.width, 128, 'a 1080p moon (49 logical px, 74 output px across) takes the next power of two');
    textures({ moon: { ...moon, illumination: .3001 } }, 1.5);
    assert.equal(main.bakes, 1, 'a change inside one quantum reuses the texture');
    textures({ moon: { ...moon, illumination: .45 } }, 1.5);
    assert.equal(main.bakes, 2, 'a new phase rebakes into the same storage');
    const [big] = textures({ moon }, 3);
    assert.equal(big.width, 256, 'only a 4K-scale output earns a 256 px face');
    assert.equal(residency.usedBytes, 256 * 256 * 4, 'one accounted texture');
    sky._seed(8);
    assert.equal(residency.usedBytes, 0, 'a new song releases it');
  } finally { sky.dispose(); }
});

test('the lit face follows the geometric phase, the crescent floor and night-only earthshine', () => {
  const sky = new RangeSkyRenderer({ makeCanvas: bakingCanvas });
  sky._seed(7);
  // Light from the right: the left (anti-solar) limb is the dark side.
  const moon = { xFrac: .5, yFrac: .3, altitude01: .6, radiusFrac: .02, visibility: 1, visible: true, illuminant: { xFrac: .9, yFrac: .3 } };
  const face = (illumination, night) => {
    const { ctx, ops } = recordingContext();
    sky._bodies(ctx, { moon: { ...moon, illumination }, phase: .5 }, 1408, 848, night);
    const image = ops.find(op => op.op === 'drawImage').image, n = image.width;
    const red = (x, y) => image.pixels[(y * n + x) * 4];
    let lit = 0;
    for (let i = 0; i < n * n; i++) if (image.pixels[i * 4] > 60) lit++;
    return { lit, dark: red(Math.round(n * .2), n / 2) };
  };
  try {
    const gibbous = face(.9, 1), crescent = face(.2, 1);
    assert.ok(gibbous.lit > crescent.lit * 2.5, `lit area follows illumination: ${gibbous.lit} vs ${crescent.lit}`);
    assert.equal(face(.02, 1).lit, face(.16, 1).lit, 'the phase never thins past the shared floor');
    assert.ok(face(.2, 1).dark > 0, 'earthshine shows the dark side at night');
    assert.equal(face(.2, 0).dark, 0, 'by day the dark side is pure sky');
  } finally { sky.dispose(); }
});

test('the sun takes its colour from colorHex, warms at the horizon and keeps its glare bounded', () => {
  const sky = new RangeSkyRenderer({ makeCanvas: bakingCanvas });
  const stopsOf = sun => {
    const { ctx, ops } = recordingContext();
    sky._bodies(ctx, { sun: { xFrac: .4, yFrac: .4, radiusFrac: .02, visibility: 1, visible: true, ...sun } }, 1408, 848, 0);
    for (const op of ops) if (op.op === 'fillRect') assert.ok(op.rect[2] <= 848 * .8 + 1e-9 && op.rect[3] <= 848 * .8 + 1e-9, 'no frame-sized fill');
    const disc = ops.find(op => op.op === 'fill');
    assert.equal(disc.mode, 'source-over');
    return disc.style.stops.map(([, color]) => color.match(/[\d.]+/g).slice(0, 3).map(Number));
  };
  try {
    const high = stopsOf({ altitude01: .6, colorHex: '#3366ff' });
    assert.deepEqual(high.at(-1), [153, 178, 251], 'the high sun\'s limb leans half way to the biome\'s sun colour, never a ring of it');
    assert.deepEqual(high[0], [255, 255, 252], 'with a white-hot centre');
    const low = stopsOf({ altitude01: .02, colorHex: '#3366ff' }).at(-1);
    const fromWhite = c => c.reduce((s, v, i) => s + Math.abs([255, 253, 246][i] - v), 0);
    assert.ok(fromWhite(low) > 1.5 * fromWhite(high.at(-1)), `low down the limb is deep in colour, not leaning: ${low}`);
    const setting = stopsOf({ altitude01: .02, colorHex: '#ff7136' });
    assert.ok(setting[0][0] > 250 && setting[0][1] < 215 && setting[0][2] < 165, `a low sun is warm through its core, no white centre: ${setting[0]}`);
    // ...yet a warm white-hot heart: a setting sun outshines the twilight it
    // sets into, even dimmed in its horizon band (an all-tint disc was a flat
    // plate no brighter than the glow behind it).
    const lum = ([r, g, b]) => .2126 * r + .7152 * g + .0722 * b;
    const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const sinking = stopsOf({ altitude01: .02, colorHex: '#ff5f24', visibility: .2 })[0];
    for (const [name, sky] of [['dawn horizon', TWILIGHT.dawn.horizon], ['dusk glow', TWILIGHT.dusk.glow], ['dusk horizon', TWILIGHT.dusk.horizon]])
      assert.ok(lum(sinking) > 1.15 * lum(hex(sky)), `brighter than the ${name}: ${lum(sinking).toFixed(0)} vs ${lum(hex(sky)).toFixed(0)}`);
    assert.notDeepEqual(stopsOf({ altitude01: .02, colorHex: '#ffffff' }), setting, 'the warm colour comes from colorHex');
  } finally { sky.dispose(); }
});

test('stars behind the moon are cut out, and fade with a fading disc', () => {
  const sky = new RangeSkyRenderer();
  const behind = [0, 0, -1], beside = [1, 0, 0];
  sky.stars = [behind, beside].map(direction => ({ direction, brightness: .5, radius: .5, phase: 0, color: 0 }));
  const project = direction => direction === behind ? { xFrac: .5, yFrac: .5, visible: true } : { xFrac: .1, yFrac: .1, visible: true };
  const alphas = disc => {
    const { ctx, ops } = recordingContext();
    sky._stars(ctx, project, 1408, 848, 1, 0, false, disc);
    return ops.filter(op => op.op === 'fill').map(op => alphaOf(op.style));
  };
  const disc = cover => ({ visible: true, x: 704, y: 424, r: 20, cover });
  const [open, other] = alphas(null);
  assert.deepEqual(alphas(disc(1)), [other], 'a whole moon hides the star behind it');
  const [half] = alphas(disc(.5));
  assert.ok(Math.abs(half - open / 2) < 1e-12, 'a half-faded moon lets half of it through');
  assert.deepEqual(alphas({ ...disc(1), visible: false }), [open, other]);
});

test('stars fade in through twilight and are absent in daylight', () => {
  const sky = new RangeSkyRenderer();
  sky.stars = [{ direction: [0, .5, -1], brightness: .5, radius: .5, phase: 0, color: 0 }];
  const project = () => ({ xFrac: .4, yFrac: .2, visible: true });
  const alpha = night => {
    const { ctx, ops } = recordingContext();
    sky._stars(ctx, project, 1280, 720, night, 0, true, null);
    return ops.filter(op => op.op === 'fill').reduce((sum, op) => sum + alphaOf(op.style), 0);
  };
  assert.equal(alpha(0), 0);
  assert.ok(alpha(.5) > 0);
  assert.ok(alpha(1) > alpha(.5));
  sky.dispose();
});

test('star footprints have the same output size across native pixel grids', () => {
  const sky = new RangeSkyRenderer();
  sky.stars = [{ direction: [0, .5, -1], brightness: .5, radius: .35, phase: 0, color: 0 }];
  const project = () => ({ xFrac: .4, yFrac: .2, visible: true });
  const outputRadius = (height, scale) => {
    const { ctx } = recordingContext();
    ctx.getTransform = () => ({ a: scale, b: 0 });
    let radius = null;
    ctx.arc = (x, y, r) => { radius = r; };
    sky._stars(ctx, project, height * 16 / 9, height, 1, 0, true, null);
    return radius * scale;
  };
  assert.ok(Math.abs(outputRadius(180, 4) - outputRadius(360, 2)) < 1e-12);
  sky.dispose();
});

test('galactic clouds fade with daylight and storm and respect the moon mask', () => {
  const sky = new RangeSkyRenderer();
  sky.galacticClouds = [{ direction: [0, .5, -1], opacity: 1, radius: .1, warm: false }];
  const project = () => ({ xFrac: .5, yFrac: .3, inFront: true });
  project.focal = 1;
  const render = (night, storm, moon) => {
    const { ctx, ops } = recordingContext();
    let clipped = false;
    ctx.clip = rule => { assert.equal(rule, 'evenodd'); clipped = true; };
    sky._milkyWay(ctx, project, 1280, 720, night, storm, moon);
    return { clipped, opacity: ops.filter(op => op.op === 'fillRect').reduce((sum, op) => sum + peakAlpha(op), 0) };
  };
  assert.equal(render(0, null, null).opacity, 0);
  const clear = render(1, null, null);
  assert.ok(clear.opacity > 0);
  assert.ok(render(1, { amount: 1 }, null).opacity < clear.opacity);
  const covered = render(1, null, { visible: true, x: 100, y: 100, r: 20, cover: 1 });
  assert.ok(covered.clipped);
  assert.equal(covered.opacity, clear.opacity);
  sky.dispose();
});

test('the sky passes its output scale to the bodies', () => {
  const sky = new RangeSkyRenderer();
  let scale = null;
  for (const method of ['_milkyWay', '_stars', '_aurora', '_clouds']) sky[method] = () => {};
  sky._bodies = (ctx, frame, width, height, night, outputScale) => { scale = outputScale; };
  const { ctx } = recordingContext();
  ctx.getTransform = () => ({ a: 0, b: 2, c: -2, d: 0, e: 5, f: 5 });
  sky.draw(ctx, { camera: { tourPose: { eyeM: [0, 0, 0], targetM: [0, 0, -1], fovYDeg: 50, aspect: 16 / 9 } },
    seed: 3, sourceWidth: 1280, sourceHeight: 720, night: 1, timeSec: 1, colors: { top: '#000', mid: '#123', horizon: '#456' } });
  assert.equal(scale, 2, 'rotation-safe output pixels per sky unit');
  sky.dispose();
});

test('sky image caches reserve bounded canvas storage and release it on disposal', () => {
  const residency = new GraphicsResidency({ budgetBytes: 2 * 1024 ** 2 });
  const sky = new RangeSkyRenderer({ residency, makeCanvas: () => ({ width: 0, height: 0 }) });
  sky.buffers.ensure('cloud-0', 192, 128);
  sky.buffers.ensure('moon-lit', 128, 128);
  assert.equal(residency.usedBytes, (192 * 128 + 128 * 128) * 4);
  sky.dispose();
  assert.equal(residency.usedBytes, 0);
});

test('individual cloud textures reuse, evict with their tint, and reconstruct deterministically', () => {
  const residency = new GraphicsResidency({ budgetBytes: 8 * 1024 ** 2 });
  let paints = 0;
  const sky = new RangeSkyRenderer({ residency, makeCanvas: () => {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData(image) { paints++; canvas.pixels = image.data.slice(); },
    });
    return canvas;
  } });
  sky._seed(315);
  const first = sky._cloud(103), pixels = first.pixels.slice();
  assert.equal(sky._cloud(103), first);
  assert.equal(paints, 1, 'unchanged bank does not rebake during playback');
  sky.buffers.ensure('storm-cloud-103', 192, 128);
  for (let i = 0; i < 56; i++) sky._cloud(i + 500);
  assert.equal(sky.cloudCache.size, 48);
  assert.equal(sky.buffers.buffers.has('storm-cloud-103'), false);
  assert.equal(residency.usedBytes, 48 * 192 * 128 * 4);
  assert.deepEqual(sky._cloud(103).pixels, pixels, 'returning to a world bank restores exactly its shape');
  sky._seed(316);
  assert.equal(sky.cloudCache.size, 0);
  assert.equal(residency.usedBytes, 0);
  sky.dispose();
});
