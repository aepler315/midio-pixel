import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleSkyPerformance } from '../src/world/alpine/SkyPerformance.js';
import { RangeSkyRenderer, createSkyCatalogue, skyProjector } from '../src/world/alpine/RangeSkyRenderer.js';

const accent = (ageSec = .04, kind = 'melody', seed = 9) => ({ ageSec, kind, seed, strength: 1 });
const music = (overrides = {}) => ({ energy: .8, bass: .9, treble: .7, kick: .8, snare: .6, melody: .9, lift: .7, accents: [accent()], ...overrides });
const camera = { tourPose: { eyeM: [0, 0, 0], targetM: [0, .22, -1], fovYDeg: 50, aspect: 16 / 9 } };
const project = skyProjector(camera);

function recordingContext() {
  const ops = [], stack = [];
  const gradient = (...args) => ({ args, stops: [], addColorStop(at, color) { this.stops.push([at, color]); } });
  const styleOf = style => typeof style === 'string' ? style : { args: style.args, stops: style.stops };
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1,
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.lineWidth]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation, this.lineWidth] = stack.pop(); },
    createLinearGradient: gradient, createRadialGradient: gradient,
    getTransform: () => ({ a: 1, b: 0 }),
    beginPath() { this.path = []; },
    arc(...args) { this.path.push(['arc', ...args]); },
    moveTo(...args) { this.path.push(['move', ...args]); },
    lineTo(...args) { this.path.push(['line', ...args]); },
    rect() {}, clip() {}, translate() {}, scale() {},
    fill() { ops.push({ kind: 'fill', path: this.path, style: styleOf(this.fillStyle) }); },
    stroke() { ops.push({ kind: 'stroke', path: this.path, style: styleOf(this.strokeStyle), width: this.lineWidth, alpha: this.globalAlpha }); },
    fillRect(...rect) { ops.push({ kind: 'rect', rect, style: styleOf(this.fillStyle), alpha: this.globalAlpha }); },
  };
  return { ctx, ops };
}

test('sky performance is causal, finite and quiet when the score is missing or silent', () => {
  assert.equal(sampleSkyPerformance(), null);
  assert.equal(sampleSkyPerformance({}), null);
  assert.equal(sampleSkyPerformance({ accents: [null, undefined, {}] }), null, 'malformed optional notes are ignored');
  assert.equal(sampleSkyPerformance(music({ energy: 0, bass: 0, treble: 0, kick: 0, snare: 0, melody: 0, lift: 0, accents: [] })), null);
  const hit = sampleSkyPerformance({ accents: [accent(.04)] });
  const tail = sampleSkyPerformance({ accents: [accent(1.2)] });
  assert.ok(Math.max(...hit.glints) > Math.max(...tail.glints) * 3);
  assert.equal(sampleSkyPerformance({ accents: [accent(-.01)] }), null, 'future notes cannot appear early');
  assert.equal(sampleSkyPerformance({ accents: [accent(4)] }), null, 'no effect survives its finite event');
  assert.deepEqual(sampleSkyPerformance(music()), sampleSkyPerformance(music()), 'pause and direct seek reconstruct the same score');
});

test('dense scores remain sparse and quality shedding bounds the optional atmosphere', () => {
  const notes = Array.from({ length: 1000 }, (_, i) => accent(.02, i % 2 ? 'snare' : 'melody', i));
  const rich = sampleSkyPerformance(music({ accents: notes }));
  assert.equal(rich.glints.length, 32);
  assert.ok(rich.glints.filter(v => v > 0).length <= 12, 'at most two fixed star families per admitted accent');
  assert.ok(rich.glints.every(v => v >= 0 && v <= 1));
  assert.ok(rich.sweeps.length <= 2);
  assert.ok(sampleSkyPerformance(music(), 2).sweeps.length <= 1);
  assert.equal(sampleSkyPerformance(music(), 3).sweeps.length, 1, "q3 keeps one musical sweep");
  assert.equal(sampleSkyPerformance(music(), 6).sweeps.length, 1, "so does the manual low preset");
});

test('the actual star paint responds selectively, preserves anchors and releases exactly', () => {
  const sky = new RangeSkyRenderer();
  sky.stars = createSkyCatalogue(315);
  const paint = effects => {
    const { ctx, ops } = recordingContext();
    sky._stars(ctx, project, 1280, 720, 1, 12, false, null, sampleSkyPerformance(effects));
    return ops.filter(op => op.kind === 'fill');
  };
  const quiet = paint(), hit = paint({ accents: [accent(.02, 'snare')] }), released = paint({ accents: [accent(3, 'snare')] });
  assert.equal(hit.length, quiet.length, 'the same fixed catalogue is painted');
  const changed = hit.filter((op, i) => op.style !== quiet[i].style);
  assert.ok(changed.length > 0 && changed.length < hit.length * .2, 'a percussion hit reaches a spatially sparse family');
  assert.deepEqual(hit.map(op => op.path[0].slice(1, 3)), quiet.map(op => op.path[0].slice(1, 3)));
  assert.deepEqual(released, quiet, 'released notes leave no frame-history residue');
  assert.deepEqual(paint({ accents: [accent(.02, 'snare')] }), hit);
});

test('bass and melody reshape real aurora rays; daylight has localized event light', () => {
  const sky = new RangeSkyRenderer();
  sky.seed = 315;
  const paintAurora = performance => {
    const { ctx, ops } = recordingContext();
    sky._aurora(ctx, project, 1280, 720, 1, 12, 1, false, performance);
    return ops;
  };
  const quiet = paintAurora(null), loud = paintAurora(sampleSkyPerformance(music()));
  assert.ok(quiet.length > 0 && loud.length > 0);
  assert.notDeepEqual(loud.map(op => op.path), quiet.map(op => op.path), 'bass opens and melody folds the actual curtains');
  assert.notDeepEqual(loud.map(op => op.style.stops), quiet.map(op => op.style.stops));
  assert.ok(loud.length < 5000, 'adaptive ray subdivision remains bounded');
  const atmosphere = effects => {
    const { ctx, ops } = recordingContext();
    sky._musicAtmosphere(ctx, project, 1280, 720, 0, sampleSkyPerformance(effects));
    return ops;
  };
  assert.deepEqual(atmosphere(), []);
  const day = atmosphere(music());
  assert.ok(day.length > 0 && day.length <= 24, 'daytime music produces a few local patches');
  assert.ok(day.every(op => op.rect[2] < 1280 && op.rect[3] < 720), 'never a whole-frame flash');
  assert.deepEqual(atmosphere(music()), day);
  assert.notDeepEqual(atmosphere(music({ accents: [accent(.5)] })), day, 'the daylight sweep actually travels with event age');
});

test('daylight sweep peaks stay in a narrow lake view through the first beat', () => {
  const lakeProject = skyProjector({ tourPose: {
    eyeM: [4078.8, 2416.8, -2783.4], targetM: [-7588.1, 2371, 4102.3], fovYDeg: 29.9, aspect: 16 / 9,
  } });
  const sky = new RangeSkyRenderer();
  for (const ageSec of [.02, .3, .8]) {
    const { ctx, ops } = recordingContext();
    sky._musicAtmosphere(ctx, lakeProject, 1280, 720, 0, sampleSkyPerformance(music({ accents: [accent(ageSec, 'kick')] })));
    assert.ok(ops.some(op => {
      const [x, y] = op.style.args;
      return x > 0 && x < 1280 && y > 720 * .03 && y < 720 * .5;
    }), `age ${ageSec}: a light peak must remain in the sky, not escape above the narrow lens`);
    assert.ok(ops.length <= 12, 'visibility does not require more compass echoes or sweeps');
  }
  sky.dispose();
});

test('the complete sky draw dispatches its music score without allocating another canvas', () => {
  const sky = new RangeSkyRenderer({ makeCanvas: () => assert.fail('music cannot allocate a canvas') });
  for (const method of ['_milkyWay', '_bodies', '_clouds']) sky[method] = () => {};
  const frame = { seed: 315, camera, sourceWidth: 1280, sourceHeight: 720, timeSec: 12, night: 0,
    colors: { top: '#345678', mid: '#789abc', horizon: '#abcdee' } };
  const draw = effects => {
    const { ctx, ops } = recordingContext();
    assert.equal(sky.draw(ctx, { ...frame, effects }), true);
    assert.equal(ctx.imageSmoothingEnabled, true);
    return ops;
  };
  const quiet = draw(), loud = draw(music());
  assert.equal(quiet.length, 1, 'the established sky grade only');
  assert.ok(loud.length > quiet.length, 'daytime accents actually reach the main sky painter');
  assert.deepEqual(draw({}), quiet);
  assert.deepEqual(draw(music()), loud, 'intervening silent draws cannot alter a repeated heard-time frame');
  sky.dispose();
});

const lakeProject = skyProjector({ tourPose: {
  eyeM: [4078.8, 2416.8, -2783.4], targetM: [-7588.1, 2371, 4102.3], fovYDeg: 29.9, aspect: 16 / 9,
} });

test('reduced rungs keep one bounded daylight sweep, on the default and the narrow lake lens', () => {
  const sky = new RangeSkyRenderer();
  for (const lens of [project, lakeProject]) {
    for (const ageSec of [.02, .3, .8]) {
      const performance = sampleSkyPerformance(music({ accents: [accent(ageSec, 'kick')] }), 3);
      assert.equal(performance.sweeps.length, 1);
      assert.equal(performance.detail, .7, 'detail is unchanged at reduced rungs');
      const { ctx, ops } = recordingContext();
      sky._musicAtmosphere(ctx, lens, 1280, 720, 0, performance);
      const fills = ops.filter(op => op.kind === 'rect');
      assert.ok(fills.length > 0, `age ${ageSec}: q3 daylight still hears the note`);
      assert.ok(fills.length <= 6, 'one sweep is at most six culled gradient fills');
      assert.ok(fills.every(op => op.rect[2] < 1280 && op.rect[3] < 720), 'never a whole-frame flash');
    }
  }
  const q3 = effects => {
    const { ctx, ops } = recordingContext();
    sky._musicAtmosphere(ctx, project, 1280, 720, 0, sampleSkyPerformance(effects, 3));
    return ops;
  };
  assert.deepEqual(q3(music()), q3(music()), 'q3 sweeps are a pure function of the score');
  assert.equal(sampleSkyPerformance({ accents: [accent(-.01)] }, 3), null, 'future notes cannot appear early at q3');
  sky.dispose();
});

// fract(0 * 31.7 + .13) = .13 passes the melody gate; seed 9 (.43) does not.
const STREAK_SEED = 0;
const melody = (ageSec, seed = STREAK_SEED, strength = 1) => ({ ageSec, kind: 'melody', seed, strength });

test('night melody streaks are rare, bounded, causal and released exactly', () => {
  assert.equal(sampleSkyPerformance(null), null, 'preview has no score');
  assert.equal(sampleSkyPerformance({ energy: 0, bass: 0, treble: 0, kick: 0, snare: 0, melody: 0, lift: 0, accents: [] }), null);
  assert.equal(sampleSkyPerformance({ accents: [melody(-.01)] }), null, 'a future note cannot streak early');
  const lone = sampleSkyPerformance({ accents: [melody(.1)] });
  assert.equal(lone.streaks.length, 1, 'a lone streak survives the silence cull');
  assert.equal(lone.streaks[0].seed, STREAK_SEED);
  assert.equal(sampleSkyPerformance({ accents: [melody(.1)] }, 3).streaks.length, 0, 'optional at q3');
  assert.equal(sampleSkyPerformance({ accents: [melody(.45)] }).streaks.length, 0, 'gone at the end of its life');
  assert.equal(sampleSkyPerformance({ accents: [melody(.1, STREAK_SEED, .5)] }).streaks.length, 0, 'weak melody notes do not streak');
  assert.equal(sampleSkyPerformance({ accents: [{ ...melody(.1), kind: 'kick' }] }).streaks.length, 0, 'percussion streaks only in a lift');
  assert.equal(sampleSkyPerformance({ lift: .5, accents: [{ ...melody(.1), kind: 'kick' }] }).streaks.length, 1);
  assert.ok(Object.isFrozen(sampleSkyPerformance(music()).streaks), 'no streak shares one frozen empty list');
  const maxed = Array.from({ length: 6 }, (_, i) => melody(.05 + i * .02, STREAK_SEED + i * 1e-4));
  assert.equal(sampleSkyPerformance({ lift: 1, accents: maxed }).streaks.length, 1, 'at most one streak');
  let passed = 0;
  for (let i = 0; i < 1000; i++) {
    const seed = (i * .6180339887 + .1) % 1;
    if (sampleSkyPerformance({ accents: [melody(.1, seed)] }).streaks.length) passed++;
  }
  assert.ok(passed > 0 && passed < 300, `${passed}/1000 seeds streak`);
  // EffectsMusic keeps the two youngest notes per kind: two newer melody
  // notes evict the streaking one, which then simply ends.
  const keepTwo = notes => { const counts = {}; return notes.slice().sort((a, b) => a.ageSec - b.ageSec)
    .filter(n => (counts[n.kind] = (counts[n.kind] || 0) + 1) <= 2); };
  const evicted = keepTwo([melody(.2), melody(.1, .3), melody(.05, .31)]);
  assert.equal(evicted.length, 2);
  assert.equal(sampleSkyPerformance({ accents: evicted }).streaks.length, 0);
});

test('the streak paints one hairline at night only, deterministically, under the moon', () => {
  const sky = new RangeSkyRenderer();
  const paint = (effects, night = 1, scale = 1) => {
    const { ctx, ops } = recordingContext();
    sky._streaks(ctx, project, 1280, 720, night, sampleSkyPerformance(effects), scale);
    return ops;
  };
  const night = paint({ accents: [melody(.15)] });
  assert.equal(night.length, 1);
  assert.equal(night[0].kind, 'stroke');
  assert.equal(night[0].style.stops.length, 2);
  assert.match(night[0].style.stops[0][1], /^rgba\(235,240,255,/);
  assert.ok(night[0].width >= .5);
  assert.deepEqual(paint({ accents: [melody(.15)] }), night, 'a pure function of heard age');
  assert.deepEqual(paint({ accents: [melody(.15)] }, 0), [], 'no streak in daylight');
  assert.deepEqual(paint({ accents: [melody(.45)] }), [], 'released exactly');
  assert.deepEqual(paint({ accents: [melody(.1, .3)] }), [], 'an ungated note paints nothing');
  const early = paint({ accents: [melody(.05)] })[0].path, late = paint({ accents: [melody(.3)] })[0].path;
  assert.notDeepEqual(early, late, 'the streak travels');
  assert.equal(paint({ accents: [melody(.15)] }, 1, 4)[0].width, 720 * .0016, 'hairline floor follows output scale');
  // In the full draw the streak follows the stars and precedes the bodies.
  const order = [];
  for (const method of ['_milkyWay', '_clouds', '_aurora']) sky[method] = () => {};
  sky._stars = () => order.push('stars');
  sky._streaks = () => order.push('streaks');
  sky._bodies = () => order.push('bodies');
  const { ctx } = recordingContext();
  sky.draw(ctx, { seed: 315, camera, sourceWidth: 1280, sourceHeight: 720, timeSec: 12, night: 1,
    colors: { top: '#000', mid: '#000', horizon: '#000' }, effects: { accents: [melody(.15)] } });
  assert.deepEqual(order, ['stars', 'streaks', 'bodies']);
  sky.dispose();
});

test('the Milky Way eases across the q3 rung, holds when paused and snaps on a seek', () => {
  const sky = new RangeSkyRenderer();
  const alphas = [];
  for (const method of ['_stars', '_aurora', '_bodies', '_clouds']) sky[method] = () => {};
  sky._milkyWay = ctx => alphas.push(ctx.globalAlpha);
  const frame = { seed: 315, camera, sourceWidth: 1280, sourceHeight: 720, night: 1,
    colors: { top: '#000', mid: '#000', horizon: '#000' } };
  const draw = (timeSec, qualityLevel) => {
    alphas.length = 0;
    const { ctx } = recordingContext();
    sky.draw(ctx, { ...frame, timeSec, qualityLevel });
    return alphas.length ? alphas[0] : 0;
  };
  assert.equal(draw(10, 2), 1, 'the first frame snaps');
  const faded = [];
  for (let i = 1; i <= 100; i++) faded.push([i / 60, draw(10 + i / 60, 3)]);
  for (const [dt, value] of faded.filter(([dt]) => dt < 1.49)) assert.ok(value > 0 && value < 1, `dt=${dt}: ${value}`);
  assert.equal(faded.at(-1)[1], 0, 'fully shed after 1.5 s');
  assert.equal(draw(20, 2), 1, 'a seek snaps to the target');
  const mid = draw(20 + 1 / 60, 3);
  assert.ok(mid > 0 && mid < 1);
  assert.equal(draw(20 + 1 / 60, 3), mid, 'the same heard time (pause, the water mirror) holds');
  assert.equal(draw(19, 3), 0, 'a backwards seek snaps');
  sky.dispose();
});
