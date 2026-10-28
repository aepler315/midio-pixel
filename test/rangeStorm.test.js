import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileStorm, stormAt, rainCurtain, rainCurtainAz, rainSeed01, skyColumnAzimuth, flashScreenPoint, STORM_KINDS, stormKind, STORM_GLSL, arrivingStorm, drawStormSky } from '../src/world/alpine/RangeStorm.js';
const energyCurves = { globalEnergyNorm: t => t >= 40000 && t < 60000 ? .95 : .25 };
const sections = [{ startMs: 0, endMs: 40000 }, { startMs: 40000, endMs: 60000 }, { startMs: 60000, endMs: 120000 }];
const timeline = [{ tMs: 45000, pitch: 38, role: 'RHYTHM', vel: .9 }, { tMs: 45100, pitch: 40, channel: 9, vel: 1 }, { tMs: 47000, pitch: 36, role: 'RHYTHM', vel: 1 }];
test('storm selects the measured loudest section and breaks into wet sunlight after it', () => {
  const score = compileStorm({ energyCurves, sections, timeline, durationMs: 120000 });
  assert.deepEqual(score.section, { startMs: 40000, endMs: 60000 });
  assert.equal(score.at(20000).amount, 0);
  assert.equal(score.at(45000).amount, 1);
  assert.equal(score.at(70000).amount, 0);
  assert.ok(score.at(70000).break01 > .6);
  assert.ok(score.at(70000).wet01 > .6);
  assert.equal(score.at(120000).break01, 0);
});
test('a sustained early climax wins after the opening guard, including its snare flashes', () => {
  const score = compileStorm({
    energyCurves: { globalEnergyNorm: t => t < 40000 ? .95 : .2 },
    sections: [{ startMs: 0, endMs: 40000 }, { startMs: 40000, endMs: 80000 }, { startMs: 80000, endMs: 120000 }],
    timeline: [{ tMs: 30000, pitch: 38, channel: 9, vel: .9 }],
    durationMs: 120000,
  });
  assert.deepEqual(score.section, { startMs: 8000, endMs: 40000 });
  assert.ok(score.at(30000).flash > .5);
  assert.equal(score.at(60000).amount, 0);
});
test('a measured late climax is eligible even when its section starts near the ending', () => {
  const score = compileStorm({
    energyCurves: { globalEnergyNorm: t => t >= 110000 ? .95 : .2 },
    sections: [{ startMs: 0, endMs: 110000 }, { startMs: 110000, endMs: 120000 }],
    durationMs: 120000,
  });
  assert.deepEqual(score.section, { startMs: 110000, endMs: 120000 });
});
test('unsegmented songs can climax early or late after the arrival', () => {
  for (const startMs of [8000, 100000]) {
    const score = compileStorm({
      energyCurves: { globalEnergyNorm: t => t >= startMs && t < startMs + 20000 ? .95 : .2 },
      durationMs: 120000,
    });
    assert.equal(score.section.startMs, startMs);
  }
});
test('lightning follows actual percussion timing, is seek safe and rate limited', () => {
  const score = compileStorm({ energyCurves, sections, timeline, durationMs: 120000 });
  assert.ok(score.at(45020).flash > .5);
  assert.equal(score.at(45100).flash, score.at(45100).flash);
  assert.ok(score.at(47000).flash > .5, 'a kick is also an authored rhythmic attack');
  assert.ok(score.at(45020).flash > score.at(45120).flash);
});
test('songs without structural sections use their loudest sustained window; no audio evidence means no flashes', () => {
  const score = compileStorm({ energyCurves, durationMs: 120000 });
  assert.ok(score.section.startMs >= 35000 && score.section.startMs < 60000);
  assert.equal(score.at(45000).flash, 0);
  const mgr = { energyCurves, durationMs: 120000, sections, conductor: { timeline } };
  assert.deepEqual(stormAt(mgr, 45020), stormAt(mgr, 45020));
});

test('a pitched D2/E2 line never creates lightning and snare velocity is respected', () => {
  const song = { energyCurves, sections, durationMs: 120000 };
  assert.equal(compileStorm({ ...song, timeline: [{ tMs: 45000, pitch: 38, role: 'BASS', vel: 1 }] }).at(45000).flash, 0);
  const soft = compileStorm({ ...song, timeline: [{ tMs: 45000, pitch: 40, role: 'RHYTHM', vel: .2 }] }).at(45000).flash;
  assert.ok(soft > 0 && soft < .1, 'soft percussion stays dim');
});

test('missing measurements do not invent a climax', () => {
  const score = compileStorm({ durationMs: 60000, sections: [{startMs:0,endMs:20000}] });
  assert.equal(score.section,null);
  assert.equal(score.at(12000).amount,0);
});

test('each lightning hit lights a different place in the deck, held through its restrike', () => {
  const score = compileStorm({ energyCurves, sections, durationMs: 120000,
    timeline: [{ tMs: 45000, pitch: 38, channel: 9, vel: 1 }, { tMs: 46000, pitch: 38, channel: 9, vel: 1 }] });
  const a = score.at(45020), restrike = score.at(45150), b = score.at(46020);
  assert.ok(a.flashU >= .18 && a.flashU <= .82);
  assert.equal(restrike.flashU, a.flashU);
  assert.ok(restrike.flash > .3 && restrike.flash < a.flash);
  assert.notEqual(b.flashU, a.flashU);
  assert.equal(score.at(45400).flash, 0);
});

test('rain curtains leave gaps between them and drift slowly on the wind', () => {
  const samples = Array.from({ length: 200 }, (_, i) => rainCurtain(i / 200, 0));
  assert.ok(samples.some(v => v > .9) && samples.some(v => v < .05));
  assert.ok(samples.every(v => v >= 0 && v <= 1));
  const drift = Math.max(...Array.from({ length: 200 }, (_, i) => Math.abs(rainCurtain(i / 200, 1) - rainCurtain(i / 200, 0))));
  assert.ok(drift > 0 && drift < .1);
});

test('the land veil carries no screen-space curtain or pan uniform', () => {
  // The world-anchored rainCurtainAz replaced them; a dead uniform costs
  // terrain budget on mobile.
  assert.ok(!STORM_GLSL.includes('uRainShift'));
  assert.ok(!/float rainCurtain\(/.test(STORM_GLSL));
  assert.ok(STORM_GLSL.includes('smoothstep(0.32, 0.86, a * 0.65 + b * 0.35)'), 'same curtain shape as the JS twins');
});

test('an arriving scene brings its storm sky in at its own alpha', () => {
  const storm = { amount: 1, flash: .8, flashU: .3, break01: .5, wet01: 1 };
  assert.equal(arrivingStorm(storm, 1), storm);
  assert.deepEqual(arrivingStorm(storm, .25), { amount: .25, flash: .2, flashU: .3, break01: .125, wet01: 1 });
  assert.equal(arrivingStorm(null, .5), null);
});

test('no sun-shaft passes run under the full squall deck', async () => {
  const { shaftSource } = await import('../src/world/alpine/SunShaftGL.js');
  const light = { celestial: { body: 'sun', visibility: 1, intensity: 1, xFrac: .5, yFrac: .2 } };
  assert.equal(shaftSource({ light, storm: { amount: 1, break01: 0 } }), null);
  assert.ok(shaftSource({ light, storm: { amount: 0, break01: 1 } }).stormGain > 1);
});


test('kick and crash accents drive lightning without depending on snare classification', () => {
  for (const pitch of [36, 49, 57]) {
    const score = compileStorm({ energyCurves, sections, durationMs: 120000,
      timeline: [{ tMs: 45000, pitch, role: 'RHYTHM', vel: .95 }] });
    assert.ok(score.at(45000).flash > .5, `accent ${pitch} must reach the scene`);
    assert.equal(score.at(45400).flash, 0);
  }
});
test('lightning strength and duration distinguish soft hits from musical accents', () => {
  const score = compileStorm({ energyCurves, sections, durationMs: 120000,
    timeline: [{ tMs: 45000, pitch: 38, role: 'RHYTHM', vel: .25 },
      { tMs: 47000, pitch: 38, role: 'RHYTHM', vel: 1 }] });
  assert.ok(score.at(47000).flash > score.at(45000).flash * 6, 'nonlinear intensity follows the attack');
  assert.ok(score.at(47150).flash > score.at(45150).flash * 6, 'a strong attack sustains the cloud restrike');
});

test('weak detected percussion cannot consume the cooldown immediately before a strong kick', () => {
  const score = compileStorm({ energyCurves, sections, durationMs: 120000,
    timeline: [{ tMs: 45000, pitch: 36, role: 'RHYTHM', vel: .25 },
      { tMs: 45400, pitch: 36, role: 'RHYTHM', vel: .9 },
      { tMs: 45600, pitch: 36, role: 'RHYTHM', vel: .2 }] });
  assert.equal(score.at(45000).flash, 0, 'buried activity does not steal the musical accent');
  assert.ok(score.at(45400).flash > .5, 'the actual kick owns its flash');
  assert.equal(score.at(46000).flash, 0);
});

test('projected cloud banks retain world placement and weather identity when camera culling changes their order', () => {
  const bank = (id, x) => ({ id, x, y: 110, w: 300, h: 190, alpha: .6 });
  const all = [bank('world:12:3', 200), bank('world:13:3', 650)];
  const draw = source => {
    let output;
    const ctx = { save() {}, restore() {}, fillRect() {},
      createLinearGradient: () => ({ addColorStop() {} }) };
    drawStormSky(ctx, { width: 1280, height: 720 }, { amount: 1, flash: 0, break01: 0 }, {
      seed: 315, cloudBankFactory: () => structuredClone(source), cloudPainter: (_, banks) => { output = banks; },
    });
    return output;
  };
  const full = draw(all), onlySecond = draw([all[1]]), reversed = draw([...all].reverse());
  assert.deepEqual(onlySecond[0], full[1], 'a cloud does not change opacity when another cloud leaves the camera');
  assert.deepEqual(reversed, [...full].reverse());
  for (const [i, projected] of full.entries()) {
    for (const key of ['x', 'y', 'w', 'h']) assert.equal(projected[key], all[i][key], 'no fixed screen-height deck override');
    assert.ok(projected.alpha > 0 && projected.alpha <= all[i].alpha, 'projected distance fade survives weather grading');
  }
});

test('world rain curtains close seamlessly around the eye and keep the song seed', () => {
  for (const t of [0, 13.5, 240]) for (const seed of [0, 315, 99991]) {
    assert.ok(Math.abs(rainCurtainAz(0, t, seed) - rainCurtainAz(1, t, seed)) < 1e-9, 'no seam at the atan wrap');
  }
  const ring = seed => Array.from({ length: 360 }, (_, i) => rainCurtainAz(i / 360, 42, seed));
  assert.deepEqual(ring(315), ring(315));
  assert.notDeepEqual(ring(315), ring(316), 'neighbouring songs hang different curtains');
  const samples = ring(7);
  assert.ok(samples.some(v => v > .9) && samples.some(v => v < .05) && samples.every(v => v >= 0 && v <= 1));
  assert.equal(rainSeed01(-1), 9972 / 9973);
  assert.equal(rainSeed01(9973 + 5), 5 / 9973);
});

test('the GLSL world curtain is the twin of the sky\'s, keyed by the eye and uRainSeed', () => {
  for (const term of ['uniform float uRainSeed;', 'az01 * 8.0 + t * 0.003', 'az01 * 19.0 - t * 0.005',
    'k * 0.6180339887', 'k * 0.7548776662 + 0.5', 'atan(d.x, -d.y)', 'world.xz - uCameraPos.xz',
    'rainCurtainAz(az01, uTime, uRainSeed)']) assert.ok(STORM_GLSL.includes(term), term);
});

test('the sky\'s rain curtains turn with a tour yaw as the world does', () => {
  const pose = deg => { const a = deg * Math.PI / 180; return { eyeM: [0, 1000, 0], targetM: [Math.sin(a) * 5000, 1000, -Math.cos(a) * 5000], fovYDeg: 40, aspect: 16 / 9 }; };
  const record = (camera) => {
    const cols = [];
    const ctx = { globalAlpha: 1, save() {}, restore() {}, createLinearGradient: () => ({ addColorStop() {} }),
      fillRect(x, y, w) { if (y > 0 && w <= 8) cols.push([x, this.globalAlpha]); } };
    drawStormSky(ctx, { width: 1280, height: 720 }, { amount: 1, flash: 0, break01: 0 }, {
      tSec: 30, seed: 315, pan: { x: 0, y: 0, tourPose: camera }, cloudBankFactory: () => [], cloudPainter() {} });
    return new Map(cols);
  };
  const delta = 6, a = record(pose(20)), b = record(pose(20 + delta));
  const shift = Math.tan(delta * Math.PI / 180) / (Math.tan(20 * Math.PI / 180) * 16 / 9) * 640;
  const peak = m => [...m].filter(([x]) => x > 300 && x < 980).sort((p, q) => q[1] - p[1])[0];
  const pa = peak(a);
  assert.ok(pa[1] > .1, 'a curtain hangs in view');
  // The same world curtain: B shows A's peak shifted left by the projected yaw.
  const window = [...b].filter(([x]) => Math.abs(x - (pa[0] - shift)) < 40).sort((p, q) => q[1] - p[1])[0];
  assert.ok(Math.abs(window[0] - (pa[0] - shift)) <= 12, `peak ${pa[0]} -> ${window[0]}, expected ${pa[0] - shift}`);
  assert.ok(Math.abs(window[1] - pa[1]) < .05);
  // Without a camera (fixtures) the frame-width curtain remains.
  assert.equal(skyColumnAzimuth(null), null);
});

test('a rail sky camera blend turns the columns between its two poses', () => {
  const pose = deg => { const a = deg * Math.PI / 180; return { eyeM: [0, 0, 0], targetM: [Math.sin(a), 0, -Math.cos(a)], fovYDeg: 40 }; };
  const from = { pose: pose(0), aspect: 2 }, to = { pose: pose(10), aspect: 2 };
  const az = mix => skyColumnAzimuth({ skyCamera: { from, to, mix } })(.5);
  assert.ok(Math.abs(az(0) - .5) < 1e-9);
  assert.ok(Math.abs(az(1) - (.5 + 10 / 360)) < 1e-9);
  assert.ok(Math.abs(az(.5) - (.5 + 5 / 360)) < 1e-9);
});

test('the sky glow, the land flash and the stage key share one lightning point', () => {
  const storm = { flashU: .3 }, pan = { x: .4 };
  assert.deepEqual(flashScreenPoint(storm, pan, 1000, 500), { x: 500, y: 75 });
  assert.deepEqual(flashScreenPoint({}, null, 2, 2), { x: 1, y: .3 });
  let flashOptions;
  const ctx = { save() {}, restore() {}, fillRect() {}, createLinearGradient: () => ({ addColorStop() {} }) };
  drawStormSky(ctx, { width: 1000, height: 500 }, { amount: 1, flash: .8, flashU: .3, break01: 0 }, { pan,
    cloudBankFactory: () => [{ id: 'world:1:1', x: 500, y: 75, w: 100, h: 50, alpha: 1 }],
    cloudPainter: (_, banks, options) => { if (options.variant) flashOptions = options; } });
  assert.equal(flashOptions.variant, 'flash', 'contract C1: the flash repaint names its variant');
  assert.deepEqual(flashOptions.light, { x: 500, y: 75 });
});

// Two loud sections: 10-55 s carries (almost) no percussion, 70-90 s a dense kit.
const twoStorms = (extra = []) => ({
  energyCurves: { globalEnergyNorm: t => (t >= 10000 && t < 55000) || (t >= 70000 && t < 90000) ? .95 : .2 },
  sections: [0, 10000, 55000, 70000, 90000].map((startMs, i, a) => ({ startMs, endMs: a[i + 1] ?? 120000 })),
  durationMs: 120000,
  timeline: [...Array.from({ length: 20 }, (_, i) => ({ tMs: 70500 + i * 900, pitch: 38, role: 'RHYTHM', vel: 1 })), ...extra],
});
test('each weather episode has its own character from its percussion and energy', () => {
  const score = compileStorm(twoStorms());
  assert.deepEqual([...score.kinds], [0, 2], 'a percussion-free shower, then a lightning-dense thunderstorm');
  assert.ok(Object.isFrozen(score.kinds));
  assert.equal(score.at(30000).kind, 0);
  assert.equal(score.at(80000).kind, 2);
  assert.equal(stormKind({ startMs: 0, endMs: 60000, energy01: .9, strikes: [{ tMs: 1 }, { tMs: 2 }] }), 1, 'a downpour between');
  assert.equal(stormKind({ startMs: 0, endMs: 60000, energy01: .6, strikes: Array.from({ length: 8 }, (_, i) => ({ tMs: i })) }), 1,
    'dense strikes in moderate weather stay a downpour');
});
test('a shower never exceeds .6 and never flashes, even when a later storm has strikes', () => {
  // A stray hit inside the shower must not light it.
  const score = compileStorm(twoStorms([{ tMs: 30000, pitch: 36, role: 'RHYTHM', vel: 1 }]));
  assert.equal(score.kinds[0], 0);
  for (let t = 5000; t < 62000; t += 250) {
    const s = score.at(t);
    assert.ok(s.amount <= .6 + 1e-12, `shower at ${t}`);
    assert.equal(s.flash, 0, `no flash at ${t}`);
  }
  assert.ok(score.at(30000).amount > .55);
  assert.ok(Math.max(...Array.from({ length: 400 }, (_, i) => score.at(70500 + i * 45).flash)) > .5, 'the thunderstorm still flashes');
  assert.deepEqual(score.at(80123), compileStorm(twoStorms([{ tMs: 30000, pitch: 36, role: 'RHYTHM', vel: 1 }])).at(80123), 'seek determinism');
});
test('songs without percussion evidence keep today\'s downpour, and empty weather defaults to it', () => {
  const score = compileStorm({ ...twoStorms(), timeline: [] });
  assert.deepEqual([...score.kinds], [1, 1]);
  assert.equal(score.at(30000).amount, 1);
  assert.equal(stormAt(null, 0).kind, 1);
});
test('adopted episodes keep their kind when later analysis arrives', () => {
  const previous = compileStorm(twoStorms());
  const next = compileStorm({ ...twoStorms(), timeline: [], previous: previous.landscape, committedThroughMs: 30000 });
  assert.equal(next.kinds[0], previous.kinds[0], 'the heard shower stays a shower');
  for (const t of [25000, 30000, 38000]) assert.deepEqual(next.at(t), previous.at(t));
});
test('the downpour row is the original squall exactly; every row stays slate', () => {
  const row = STORM_KINDS[1];
  assert.deepEqual(row.skyTop, [30, 36, 45]); assert.deepEqual(row.skyBottom, [78, 88, 98]);
  assert.deepEqual(row.deckDark, [26, 31, 39]); assert.deepEqual(row.deckLit, [70, 76, 86]);
  assert.deepEqual(row.zenith, { r: .02, g: .026, b: .036 });
  assert.deepEqual(row.horizon, { r: .03, g: .038, b: .05 });
  assert.deepEqual(row.air, { r: .028, g: .036, b: .048 });
  assert.ok(Object.isFrozen(STORM_KINDS) && STORM_KINDS.every(Object.isFrozen));
  const lum = c => c[0] + c[1] + c[2];
  assert.ok(lum(STORM_KINDS[0].skyTop) > lum(row.skyTop) && lum(row.skyTop) > lum(STORM_KINDS[2].skyTop), 'shower lighter, thunderstorm darker');
  const hue = ([r, g, b]) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (const k of STORM_KINDS) for (const c of [k.skyTop, k.skyBottom, k.deckDark, k.deckLit,
    ...[k.zenith, k.horizon, k.air].map(v => [v.r, v.g, v.b])]) {
    const h = hue(c);
    assert.ok(h > 200 && h < 230, `${k.name} ${c} hue ${h} stays slate, away from 178deg, #ff4d4d and #ffd75e`);
  }
});
test('the sky paints each kind\'s own overcast', () => {
  const stops = kind => {
    const colors = [];
    const ctx = { save() {}, restore() {}, fillRect() {}, createLinearGradient: () => ({ addColorStop: (_, c) => colors.push(c) }) };
    drawStormSky(ctx, { width: 100, height: 100 }, { amount: 1, flash: 0, break01: 0, kind }, { cloudBankFactory: () => [], cloudPainter() {} });
    return colors.slice(0, 2);
  };
  assert.deepEqual(stops(1), ['rgba(30,36,45,0.96)', 'rgba(78,88,98,0.9)']);
  assert.deepEqual(stops(undefined), stops(1));
  assert.notDeepEqual(stops(0), stops(2));
});
