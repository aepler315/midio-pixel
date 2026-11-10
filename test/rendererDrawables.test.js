// Screen-space effects must be handed a real drawable, not the logical view.
//
// Renderer.draw builds a `stage` object -- a plain `{ width, height }` in
// LOGICAL units -- and passes it to every subsystem as `canvas`. That is
// correct for anything that draws shapes, because the context is already
// under the sx/sy transform. But it is not a drawable, so any effect that
// samples the composed frame has to reach for the real backing store
// (`ctx.canvas`) instead.
//
// Effects that got this wrong threw on every invocation. Because main.js
// wraps the whole draw in a try/catch, the throw was swallowed -- and took
// the entire remainder of that frame with it: bloom, the film finish and the
// HUD strip.
//
// These tests need no canvas: they record what reaches drawImage.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const STAGE_W = 1280, STAGE_H = 720;
const DEVICE_W = 2560, DEVICE_H = 1440; // a 2x backing store

/** A context stub that records drawImage and tolerates everything else. */
function recordingCtx() {
  const calls = [];
  const backing = { width: DEVICE_W, height: DEVICE_H, __isCanvas: true };
  const ctx = {
    canvas: backing,
    drawImage: (...args) => calls.push(args),
    save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {},
    roundRect() {}, rect() {}, arc() {}, moveTo() {}, lineTo() {},
    fillRect() {}, closePath() {}, translate() {}, rotate() {}, setTransform() {},
    clip() {}, scale() {}, quadraticCurveTo() {}, ellipse() {}, setLineDash() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: '', lineJoin: '', filter: '',
  };
  return { ctx, calls, backing };
}

/** The logical view draw() hands around -- deliberately NOT a drawable. */
function stageView() {
  return { width: STAGE_W, height: STAGE_H };
}

// --- The same bug class in BiomeManager ----------------------------------
//
// Renderer's old hype echo and drop shock were two of FIVE sites that passed
// draw()'s logical stage view to drawImage. Two more live in _drawLakeReflection,
// which MIRROR -- a stock biome -- reaches on every frame via _drawGround.
// Because _drawGround runs near the end of the world draw, that throw took
// every character, the HUD, bloom and the film finish with it for the whole
// duration of a MIRROR section.

test('the lake reflection samples the real canvas, not the logical view', async () => {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  const bm = Object.create(BiomeManager.prototype);
  bm.lakeRing = { displacementAt: () => 1 }; // force the ripple blits to run
  const { ctx, calls, backing } = recordingCtx();
  const stage = stageView();

  bm._drawLakeReflection(ctx, stage, 400);

  assert.ok(calls.length > 0, 'the reflection should draw');
  for (const [src] of calls) {
    assert.notEqual(src, stage, 'the logical stage view is not a drawable');
    assert.equal(src, backing, 'must sample the real backing store');
  }
});

test('the lake reflection blits back in logical units at every stage resolution', async () => {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  const bm = Object.create(BiomeManager.prototype);
  bm.lakeRing = { displacementAt: () => 1 };
  const { ctx, calls } = recordingCtx();
  bm._drawLakeReflection(ctx, stageView(), 400);

  const mirror = calls.find((c) => c.length === 5);
  assert.ok(mirror, 'the mirrored pass should specify a destination size');
  assert.equal(mirror[3], STAGE_W, 'destination width is logical');
  assert.equal(mirror[4], STAGE_H, 'destination height is logical');

  // The ripple pass takes a source rect, which must index the DEVICE buffer
  // (2x here) while its destination stays logical -- getting that backwards
  // samples the wrong strip on any non-1x stage preset.
  for (const c of calls.filter((x) => x.length === 9)) {
    const [, , , sw, , , , dw] = c;
    assert.equal(sw, DEVICE_W, 'source rect indexes the backing store');
    assert.equal(dw, STAGE_W, 'destination rect stays logical');
  }
});

// --- Character reflections in the Mirror lake -----------------------------
//
// _drawLakeReflection runs during the world pass, before the trio is drawn,
// so it can never pick up their live screen positions the way it does the
// sky/terrain already on the backing store. drawCharacterReflections is the
// separate call Renderer makes right after they draw, gated on whatever
// _drawGround decided about the lake THIS frame.

function fillRecordingCtx() {
  const ellipses = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, closePath() {}, rect() {}, clip() {},
    ellipse: (...a) => ellipses.push(a),
    fill() {}, createLinearGradient: () => ({ addColorStop() {} }),
    set fillStyle(v) {}, set globalCompositeOperation(v) {},
  };
  return { ctx, ellipses };
}

test('drawCharacterReflections draws nothing outside a Mirror lake section', async () => {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  const bm = Object.create(BiomeManager.prototype);
  bm.lakeRing = { displacementAt: () => 0 };
  bm._lakeReflectGroundY = null; // set by _drawGround only when the active biome is MIRROR
  const { ctx, ellipses } = fillRecordingCtx();

  bm.drawCharacterReflections(ctx, stageView(), [{ x: 300, hue: 40, active: true }]);
  assert.equal(ellipses.length, 0, 'no lake this frame, no reflection to draw');
});

test('drawCharacterReflections skips inactive entries (burrowed/voyaging) and non-finite positions', async () => {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  const bm = Object.create(BiomeManager.prototype);
  bm.lakeRing = { displacementAt: () => 0 };
  bm._lakeReflectGroundY = 400;
  const { ctx, ellipses } = fillRecordingCtx();

  bm.drawCharacterReflections(ctx, stageView(), [
    { x: 300, hue: 40, active: true },
    { x: 500, hue: 200, active: false }, // e.g. Broshi underground
    { x: NaN, hue: 90, active: true },   // e.g. Midasus mid-voyage, no real position
  ]);

  assert.equal(ellipses.length, 1, 'only the one present, positioned character reflects');
  assert.equal(ellipses[0][0], 300, 'reflection is anchored at that character\'s own x (plus ripple)');
});

test('drawCharacterReflections offsets each reflection by that character\'s own ripple sample', async () => {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  const bm = Object.create(BiomeManager.prototype);
  bm._lakeReflectGroundY = 400;
  const seen = [];
  bm.lakeRing = { displacementAt: (theta) => { seen.push(theta); return 7; } };
  const { ctx, ellipses } = fillRecordingCtx();

  bm.drawCharacterReflections(ctx, stageView(), [{ x: 300, hue: 40, active: true }]);

  assert.equal(ellipses[0][0], 321, 'ripple displacement (x3, matching the water\'s own ripple scale) nudges the reflection x');
  assert.ok(seen.length > 0 && Number.isFinite(seen[0]), 'sampled the ring at a real angle');
});

test('no drawImage anywhere is handed a plain {width,height}', async () => {
  // A guard for the whole class rather than the five known sites.
  const { readFileSync } = await import('node:fs');
  const { globSync } = await import('node:fs');
  const files = globSync('src/**/*.js');
  const offenders = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      // `canvas` is the logical view in BiomeManager/Renderer draw helpers;
      // the real backing store is always reached as ctx.canvas.
      if (/drawImage\(\s*canvas\b/.test(line) && !/ctx\.canvas/.test(line)) {
        offenders.push(`${f}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  // Three survivors legitimately receive the real canvas as a PARAMETER named
  // `canvas` (HighlightReel.capture, Renderer._drawBloom, Renderer.
  // _drawHeatDistortion -- draw() hands each of them the backing store, not
  // the stage view).
  // Matched on the call text rather than file or line so the exemption covers
  // exactly these: a new offender in the same file still fails, and
  // unrelated edits shifting the line numbers don't.
  const allowed = [
    'ctx.drawImage(canvas, 0, 0, THUMB_W, THUMB_H);',
    'actx.drawImage(canvas, 0, 0, wSmall, hSmall);',
    'srcCtx.drawImage(canvas, 0, 0);',
  ];
  const bad = offenders.filter((o) => !allowed.some((a) => o.endsWith(a)));
  assert.deepEqual(bad, [], `logical stage view reaching drawImage:\n${bad.join('\n')}`);
});
