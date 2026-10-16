import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/sim/Simulation.js';
import { Conductor } from '../src/core/Conductor.js';
import { ParamBus } from '../src/core/ParamBus.js';
import { Midio } from '../src/sim/Midio.js';
import { Broshi } from '../src/sim/Broshi.js';
import { Midasus } from '../src/sim/Midasus.js';
import { Renderer } from '../src/render/Renderer.js';
import { makeNoteEvent, Role } from '../src/core/NoteEvent.js';

const timeline = [0, 1000, 30000, 59900].map(tMs => makeNoteEvent({ tMs, durMs: 600, pitch: 48, vel: .8, role: Role.RHYTHM, kick: true, src: 'midi' }));
function scene(worldId = 'alpine', silent = false) {
  const conductor = new Conductor();
  conductor.load({ timeline: silent ? [] : timeline, durationMs: 60000, bpm: 120, barGrid: [] });
  const sim = new Simulation(conductor, new ParamBus(), { worldId, songSeed: 3 });
  // Offscreen raster allocation needs a browser; world logic remains real.
  sim.biomes.pumpStripPrewarm = () => {};
  return sim;
}

// Catches construction or callback ownership returning through any public start mode.
for (const world of ['alpine', 'fathom', 'farside']) {
  for (const mode of ['opening', 'silence', 'middle', 'final', 'seek', 'restart', 'export']) {
    test(`${world} ${mode} keeps transport without constructing or updating the trio`, () => {
      const sim = scene(world, mode === 'silence');
      try {
        assert.ok(!(sim.midio instanceof Midio), 'default listener must not construct Midio');
        assert.ok(!(sim.broshi instanceof Broshi), 'default listener must not construct Broshi');
        assert.ok(!(sim.midasus instanceof Midasus), 'default listener must not construct Midasus');
        assert.equal(sim.performer, undefined);
        assert.equal(sim.ensemble, undefined);
        assert.equal(sim.focus, undefined);
        assert.equal(sim.excursions, undefined);
        assert.equal(sim.conductor.aheadRegs.length, 0, 'no anticipatory actor subscriptions');
        const at = mode === 'middle' || mode === 'seek' ? 30000 : mode === 'final' ? 59990 : 0;
        if (mode === 'seek' || mode === 'restart') sim.startAt(at);
        else sim.step(0, at);
        sim.step(10, at + 10);
        assert.equal(sim.heardTimeMs, at + 10);
        assert.ok(sim.worldX > 0, 'scenic transport keeps moving');
        assert.equal(sim.stageAnchor.x, 220, 'camera origin does not roam with an actor');
        assert.equal(sim.camera._zoomTarget ?? sim.camera.zoomTarget ?? 1, 1);
        assert.deepEqual(sim.rangeNarrativeAt()?.cast, world === 'alpine' ? { midio: 0, broshi: 0, midasus: 0 } : undefined);
      } finally { sim.dispose(); }
    });
  }
}

test('shared landscape ownership suppresses decorative schedules while retaining terrain and tap timing', () => {
  const sim = scene();
  try {
    assert.equal(sim.biomes.farVignettes, null);
    assert.equal(sim.biomes.murmuration, null);
    assert.equal(sim.biomes.skyEnsemble, null);
    assert.deepEqual(sim.biomes._ships, []);
    assert.deepEqual(sim.biomes._seaLife, []);
    assert.deepEqual(sim.biomes._monsters, []);
    assert.ok(sim.biomes.nearField, 'natural foreground survives');
    for (const at of [1000, 1500, 2000, 2500]) sim.onBeatTap(at);
    assert.ok(sim.beatAnchor.confidence > 0);
    sim.step(10, 2500);
    assert.equal(sim.stageAnchor.x, 220);
    assert.ok(sim.rangeNarrativeAt().relief > .99, 'landscape is fully available from opening');
  } finally { sim.dispose(); }
});

test('renderer retires old performer capture resources even over reflective water', () => {
  const renderer = Object.create(Renderer.prototype);
  let disposed = 0;
  renderer._capture = { dispose() { disposed++; }, capture() { assert.fail('actor capture allocated'); } };
  const sim = scene();
  try {
    const result = renderer._captureCastForReflections({}, sim, {}, { _rangeV2Active: true }, {}, {});
    assert.deepEqual(result, { midio: null, broshi: null, midasus: null });
    assert.equal(disposed, 1);
    assert.equal(renderer._capture, null);
  } finally { sim.dispose(); }
});

test('actor-free listening does not delay provisional analysis until the full song', async () => {
  const { useOpeningAnalysis } = await import('../src/audio/OpeningAnalysis.js');
  assert.equal(useOpeningAnalysis({ durationSec: 600, rangeListening: true }), true);
});

test('title and loader opening paint the sky without the trio', async () => {
  const { TitleBackdrop } = await import('../src/ui/TitleBackdrop.js');
  const backdrop = new TitleBackdrop();
  let shapes = 0, actors = 0;
  const ctx = new Proxy({ save() {}, restore() {}, createRadialGradient: () => ({ addColorStop() {} }),
    fill() { shapes++; }, fillRect() { shapes++; } }, { get: (o, p) => p in o ? o[p] : () => {} });
  backdrop._drawTrio = () => { actors++; };
  backdrop.draw(ctx, 0);
  assert.ok(shapes > 100, 'star field and nebula remain');
  assert.equal(actors, 0);
});

test('the real fallback renderer paints terrain without body, shadow, brush, light or capture ownership', () => {
  let scenicPaint = 0;
  const canvas = { width: 1280, height: 720 };
  const ctx = new Proxy({ canvas, globalAlpha: 1, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() { scenicPaint++; }, fill() { scenicPaint++; }, measureText: () => ({ width: 0 }) },
  { get: (o, p) => p in o ? o[p] : () => {} });
  canvas.getContext = () => ctx;
  const renderer = new Renderer(canvas);
  const sim = scene(); const biomes = sim.biomes;
  try {
    sim.biomes = null;
    sim.perf = { particleMul: 1, heavyPostFx: false, bloomEnabled: false, fullFrameFxEnabled: false };
    sim.highlightReel = null;
    for (const method of ['_drawMidio', '_drawMidioAfterimages', '_drawGoldAfterimages', '_drawContactShadow']) {
      renderer[method] = () => assert.fail(`retired draw path ${method}`);
    }
    renderer.draw(sim, 1);
    assert.ok(scenicPaint > 0);
    assert.equal(renderer.brush, undefined);
    assert.equal(renderer._capture, null);
  } finally { sim.biomes = biomes; sim.dispose(); renderer.dispose(); }
});

for (const silent of [false, true]) test(`alpine compositor draws the inhabited shore every frame (silent=${silent})`, () => {
  const canvas = { width: 1280, height: 720 };
  const ctx = new Proxy({ canvas, globalAlpha: 1,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 0 }) }, { get: (o, p) => p in o ? o[p] : () => {} });
  canvas.getContext = () => ctx;
  const renderer = new Renderer(canvas), sim = scene('alpine', silent);
  let sceneryDraws = 0;
  // Keep the actual manager and production Renderer branch. Only the raster
  // boundary is replaced: it requires offscreen/browser surfaces.
  sim.biomes.draw = function () {
    sceneryDraws++;
    assert.equal(this.inhabitedShore, true, 'the Range scene hosts Midio, Broshi and Midasus on the shore');
  };
  sim.perf = { particleMul: 1, heavyPostFx: false, bloomEnabled: false, fullFrameFxEnabled: false };
  sim.highlightReel = null;
  try {
    for (const at of [0, 30000, 0]) {
      sim.startAt(at); renderer.draw(sim, 1);
      assert.equal(renderer.inhabitedShoreDraws, 1, `shore drawn once in the frame at ${at}ms`);
    }
    assert.equal(sceneryDraws, 3);
  } finally { sim.dispose(); renderer.dispose(); }
});

test('source lookup preserves causal lanes and confidence without a performer handoff', async () => {
  const { compileLandscapeSources } = await import('../src/world/alpine/RangeNarrative.js');
  const compiled = compileLandscapeSources({ durationMs: 60000, casting: { midio: 'lead-lane', broshi: 'bass-lane', midasus: 'clean-lane' }, timeline: [
    { tMs: 1000, durMs: 500, vel: .8, lane: 'MIDIO', src: 'midi', pitch: 60 },
    { tMs: 1000, durMs: 500, vel: .7, lane: 'BROSHI', src: 'audio', pitch: 36, pitchProvenance: 'synthetic' },
    { tMs: 2000, durMs: 500, vel: .9, lane: 'MIDASUS', src: 'midi', pitch: 72 },
  ] });
  assert.equal(compiled.sample(900).sources.midio.activity, 0);
  const early = compiled.sample(1100);
  assert.equal(early.sources.midio.activity, .8);
  assert.equal(early.sources.midio.pitchActivity, .8);
  assert.equal(early.sources.broshi.activity, .7);
  assert.equal(early.sources.broshi.pitchActivity, 0);
  assert.equal(early.sources.midasus.activity, 0, 'future note cannot enter a landscape channel');
  assert.equal(early.relief, 1);
  compiled.sample(50000);
  assert.deepEqual(compiled.sample(1100), early, 'sampling late then seeking cannot change early source state');
});
