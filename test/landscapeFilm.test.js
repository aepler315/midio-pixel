import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render/Renderer.js';
import { LerpCache } from '../src/utils/color.js';

test('film diagnostic suppression removes grade, space wash and vignette together', () => {
  let operations = 0;
  const ctx = { save() {}, restore() {}, fillRect() { operations++; },
    createRadialGradient() { return { addColorStop() {} }; } };
  Renderer.prototype._drawFilmFinish.call({ _filmLerpCache: { get: () => '#8899aa' } }, ctx,
    { width: 1280, height: 720 }, { filmFinish: { warmth: 0.5, vignetteDepth: 0.3 },
      biomes: { _pass: () => false } });
  assert.equal(operations, 0);
});

// --- Landscape vignette on the shared score ---------------------------------

const STAGE = { width: 1280, height: 720 };
const NARRATIVE = Object.freeze({ skyDark: 1, materials: 1 });

/** Records the vignette: the edge alpha of its outer stop and its onset. */
function vignetteCtx() {
  const ctx = { stops: [], radii: [], save() {}, restore() {}, fillRect() {},
    createRadialGradient(_x0, _y0, r0, _x1, _y1, r1) {
      ctx.radii.push(r0 / r1);
      return { addColorStop: (offset, color) => { if (offset === 1) ctx.stops.push(color); } };
    } };
  return ctx;
}
const edgeOf = ctx => Number(/rgba\(0,0,0,([\d.]+)\)/.exec(ctx.stops.at(-1))[1]);

function landscapeRenderer(effects = {}, { timeMs = 10000, storm = null } = {}) {
  const r = Object.create(Renderer.prototype);
  r._filmLerpCache = new LerpCache();
  r.rangePresentation = { frame: { effects, timeMs, storm } };
  return r;
}

function landscapeSim(overrides = {}) {
  return { timeMs: 10200, heardTimeMs: 10000, rangeNarrativeAt: () => NARRATIVE,
    filmFinish: { warmth: 0.4, vignetteDepth: 0.5 }, ...overrides };
}

/** One film pass with the score snapshot draw() would take this frame. */
function filmEdge(r, sim) {
  const ctx = vignetteCtx();
  r._drawFilmFinish(ctx, STAGE, sim, r._landscapeFinishInputs(sim));
  return { edge: edgeOf(ctx), onset: ctx.radii.at(-1) };
}

test('a section lift on the shared score opens the Landscape vignette', () => {
  const closed = filmEdge(landscapeRenderer({ lift: 0 }), landscapeSim());
  const open = filmEdge(landscapeRenderer({ lift: 1 }), landscapeSim());
  assert.ok(open.edge < closed.edge, `lift opens the edge: ${open.edge} < ${closed.edge}`);
  assert.ok(closed.edge < 0.4, 'no longer pinned at the narrative cap');
});

test('a timeline kick the score did not report leaves the Landscape vignette unchanged', () => {
  const kickTimeline = { timeline: [{ tMs: 9990, kick: true, vel: 1, src: 'audio' }] };
  const baseline = filmEdge(landscapeRenderer({ kick: 0 }), landscapeSim());
  const withKick = filmEdge(landscapeRenderer({ kick: 0 }), landscapeSim({ conductor: kickTimeline }));
  assert.deepEqual(withKick, baseline);
  // The score's own kick widens the onset and never darkens the edge.
  const scored = filmEdge(landscapeRenderer({ kick: 1 }), landscapeSim());
  assert.equal(scored.edge, baseline.edge);
  assert.ok(scored.onset > baseline.onset);
  // A stale frame (no score this frame) keeps the narrative pressure path,
  // which is the one that still reads the timeline kick.
  const stale = landscapeRenderer({ kick: 0 }, { timeMs: 5000 });
  assert.equal(stale._landscapeFinishInputs(landscapeSim()), null, 'frames over 250 ms from heard time are stale');
  const open = { filmFinish: { warmth: 0.4, vignetteDepth: 0 } }; // below the .40 cap
  const staleBase = filmEdge(stale, landscapeSim(open));
  const staleKick = filmEdge(stale, landscapeSim({ ...open, conductor: kickTimeline }));
  assert.ok(staleKick.edge > staleBase.edge, 'the legacy path is unchanged');
});

test('the Landscape vignette holds no history: prior FilmFinish depth does not matter (seek)', () => {
  const r = landscapeRenderer({ energy: 0.4, lift: 0.2 }, { storm: { amount: 0.5, flash: 1 } });
  const calm = filmEdge(r, landscapeSim({ filmFinish: { warmth: 0.4, vignetteDepth: 1 } }));
  const opened = filmEdge(r, landscapeSim({ filmFinish: { warmth: 0.4, vignetteDepth: 0 } }));
  assert.deepEqual(opened, calm);
});

/** A canvas context that tolerates every call draw() makes. */
function anyCtx(record = null) {
  const noop = () => {};
  let transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'getTransform') return () => ({ ...transform, transformPoint: p => p, inverse: () => null });
      if (key === 'setTransform') return (a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) => {
        transform = typeof a === 'object' ? { ...a } : { a, b, c, d, e, f };
      };
      if (key === 'createRadialGradient') return () => ({ addColorStop: (offset, color) => { if (offset === 1) record?.push(color); } });
      if (key === 'createLinearGradient') return () => ({ addColorStop: noop });
      return noop;
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

test('a deferred capture replay uses the frame\'s score snapshot, not live state', () => {
  const canvas = { width: 1280, height: 720, getContext: () => anyCtx() };
  const r = new Renderer(canvas);
  try {
    r.deferPostEffects = true;
    r.rangePresentation = { frame: { effects: { energy: 0.2, lift: 1 }, timeMs: 10000, storm: null } };
    const sim = { ...landscapeSim(), stageW: 1280, stageH: 720, midio: { groundY: 625 },
      camera: { zoom: 1, shakeX: 0, shakeY: 0, roll: 0 },
      lerpState: () => ({ worldX: 0, midioX: 400, midioDrawX: 400, midioY: 625, scaleX: 1, scaleY: 1, leanDeg: 0 }) };
    r.draw(sim, 1);
    assert.ok(r._deferredPostEffects?.finish, 'the score was snapshotted with the deferred frame');
    r._drawBloom = () => {};
    r._drawHeatDistortion = () => {};
    const replay = () => {
      const stops = [];
      r.drawDeferredPostEffects(anyCtx(stops), { x: 0, y: 0, width: 1280, height: 720 });
      return stops.at(-1);
    };
    const first = replay();
    // Live state moves on before the recorder replays the frame.
    sim.heardTimeMs = 20000;
    sim.filmFinish = { warmth: 0.4, vignetteDepth: 1 };
    r.rangePresentation = { frame: { effects: { energy: 0, lift: 0, kick: 1 }, timeMs: 20000, storm: { amount: 1 } } };
    assert.equal(replay(), first);
    // A fresh draw does take the new score.
    r.draw(sim, 1);
    assert.notEqual(replay(), first);
  } finally { r.dispose(); }
});
