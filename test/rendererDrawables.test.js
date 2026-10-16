// Screen-space effects must be handed a real drawable, not the logical view.
//
// Renderer.draw builds a `stage` object -- a plain `{ width, height }` in
// LOGICAL units -- and passes it to every subsystem as `canvas`. That is
// correct for anything that draws shapes, because the context is already
// under the sx/sy transform. But it is not a drawable, so any effect that
// samples the composed frame has to reach for the real backing store
// (`ctx.canvas`) instead.
//
// Two effects got this wrong and threw on every invocation. Because main.js
// wraps the whole draw in a try/catch, the throw was swallowed -- and took
// the entire remainder of that frame with it: the drop-impact pack, bloom,
// the film finish and the HUD strip. On hard hits, which is exactly when the
// hype echo fires. Neither effect had ever rendered.
//
// These tests need no canvas: they record what reaches drawImage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render/Renderer.js';

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

/** A sim with the hype hard enough that the echo branch runs. */
function hypeSim({ reducedFlash = false, particleMul = 1 } = {}) {
  return {
    timeMs: 10000,
    // surge > 0.45 is what opens the echo branch (see hypeFrameStyle).
    hype: { slam: 1, surge: 1, fast: 1, dropAtMs: 10000 },
    calm: { level: 0 },
    fever: { level: 0 },
    reducedFlash,
    perf: { particleMul, heavyPostFx: true, fullFrameFxEnabled: true },
    biomes: { currentHaloColor: () => '#ffdca0' },
    midio: { groundY: 540, screenX: 300, renderY: 400 },
  };
}

test('the hype echo samples the real backing store, never the logical view', () => {
  const r = Object.create(Renderer.prototype);
  const { ctx, calls, backing } = recordingCtx();
  const stage = stageView();

  r._drawHypeFrame(ctx, stage, hypeSim());

  assert.ok(calls.length > 0, 'a hard hit should draw an echo at all');
  for (const [src] of calls) {
    assert.notEqual(src, stage, 'the logical stage view is not a drawable');
    assert.equal(src, backing, 'the echo must sample the real canvas');
  }
});

test('...and lands in logical units, so it looks the same at every resolution', () => {
  const r = Object.create(Renderer.prototype);
  const { ctx, calls } = recordingCtx();
  r._drawHypeFrame(ctx, stageView(), hypeSim());

  const [src, dx, dy, dw, dh] = calls[0];
  void src; void dy;
  assert.equal(dw, STAGE_W, 'destination width must be logical, not device');
  assert.equal(dh, STAGE_H, 'destination height must be logical, not device');
  // The offset is a small logical-space nudge, not a device-pixel one.
  assert.ok(Math.abs(dx) > 0 && Math.abs(dx) < 20, `echo offset looks wrong: ${dx}`);
});

test('reduced-flash removes the echo entirely rather than shrinking it', () => {
  const r = Object.create(Renderer.prototype);
  const { ctx, calls } = recordingCtx();
  r._drawHypeFrame(ctx, stageView(), hypeSim({ reducedFlash: true }));
  assert.equal(calls.length, 0, 'a rapid self-blit ghost is exactly what the toggle removes');
});

test('a calm frame never echoes, however the transform is set up', () => {
  const r = Object.create(Renderer.prototype);
  const { ctx, calls } = recordingCtx();
  const sim = hypeSim();
  sim.hype = { slam: 0, surge: 0, fast: 0, dropAtMs: -Infinity };
  sim.calm.level = 1;
  r._drawHypeFrame(ctx, stageView(), sim);
  assert.equal(calls.length, 0);
});

test('the drop shock copies the real canvas and blits back in logical units', () => {
  const r = Object.create(Renderer.prototype);
  // The offscreen buffer the shock composites through. In Node there is no
  // document, so hand it one shaped like the canvas it would create.
  const offCalls = [];
  r._shockCanvas = {
    width: 0, height: 0,
    getContext: () => ({
      drawImage: (...a) => offCalls.push(a),
      fillRect() {}, globalCompositeOperation: '', fillStyle: '',
    }),
  };
  const { ctx, calls, backing } = recordingCtx();
  const stage = stageView();
  const pose = { midioDrawX: 300, midioX: 300 };

  r._drawDropImpact(ctx, stage, hypeSim(), pose);

  assert.ok(offCalls.length > 0, 'the shock should copy the frame');
  for (const [src] of offCalls) {
    assert.equal(src, backing, 'the copy must come from the real canvas');
    assert.notEqual(src, stage, 'not from the logical view');
  }
  // The offscreen buffer is half-res at >1920px for performance.
  const shockScale = DEVICE_W > 1920 ? 2 : 1;
  assert.equal(r._shockCanvas.width, Math.round(DEVICE_W / shockScale));
  assert.equal(r._shockCanvas.height, Math.round(DEVICE_H / shockScale));

  const blits = calls.filter((c) => c.length >= 5);
  assert.ok(blits.length > 0, 'and it must be blitted back');
  for (const [, , , dw, dh] of blits) {
    assert.equal(dw, STAGE_W, 'blitted back into logical space');
    assert.equal(dh, STAGE_H);
  }
});

test('no drop in flight means no shock at all', () => {
  const r = Object.create(Renderer.prototype);
  const { ctx, calls } = recordingCtx();
  const sim = hypeSim();
  sim.hype.dropAtMs = -Infinity; // HypeDirector's initial state
  r._drawDropImpact(ctx, stageView(), sim, { midioDrawX: 300 });
  assert.equal(calls.length, 0);
});

// --- The same bug class in BiomeManager ----------------------------------
//
// The hype echo and drop shock were two of FIVE sites that passed draw()'s
// logical stage view to drawImage. Two more live in _drawLakeReflection,
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

// The drop motion-blur ring: reported live as 2-3fps on a flagship Android
// phone at 1080p60. Profiling the real draw path (not a synthetic proxy)
// found this pass's own frame-capture -- `drawImage(canvasEl, 0, 0)`, a full
// backing-store-sized copy issued on EVERY frame of the whole song, not just
// the ~320ms window the ghosts it captures are ever visible in -- dwarfing
// every other pass in the frame at 1080p+. Unlike the drop shock (a single-
// frame effect gated to only run near a drop, where a full-res copy at
// <=1920px was cheap enough to leave alone), this capture is unconditional
// for as long as heavyPostFx is on, so its cost is paid continuously. Fixed
// to capture at postFxDownscale's reduced resolution, the same technique
// bloom already uses one pass over.
function motionBlurSim({ reducedFlash = false, dropAtMs = 10000, timeMs = 10000 } = {}) {
  return {
    timeMs,
    hype: { dropAtMs },
    reducedFlash,
    perf: { heavyPostFx: true, fullFrameFxEnabled: true },
    focus: null,
  };
}

function camera(shakeX = 0, shakeY = 0) {
  return { shakeX, shakeY };
}

/** A fake canvas-like ring slot, sized as the code would size a real one. */
function fakeRingSlot(w, h) {
  const calls = [];
  return {
    width: w, height: h,
    getContext: () => ({
      setTransform() {}, clearRect() {},
      drawImage: (...a) => calls.push(a),
    }),
    _calls: calls,
  };
}

test('the frame capture downsamples instead of copying the backing store 1:1', () => {
  const r = Object.create(Renderer.prototype);
  const { ctx } = recordingCtx();
  // Pre-seed the ring at the size the code should already be using for a
  // DEVICE_W x DEVICE_H (2560x1440) backing store, so no document.createElement
  // branch needs stubbing -- same technique the shock test above uses.
  const scale = DEVICE_W > 2560 ? 5 : DEVICE_W > 1920 ? 4 : 3; // postFxDownscale
  const expectW = Math.round(DEVICE_W / scale), expectH = Math.round(DEVICE_H / scale);
  const slots = [fakeRingSlot(expectW, expectH), fakeRingSlot(expectW, expectH), fakeRingSlot(expectW, expectH)];
  r._motionHistory = slots;
  r._motionRing = 0;

  r._drawDropMotionBlur(ctx, { width: DEVICE_W, height: DEVICE_H }, motionBlurSim(), camera(), 1, 1);

  const captureCalls = slots[0]._calls;
  assert.equal(captureCalls.length, 1, 'exactly one capture per frame');
  const [src, dx, dy, dw, dh] = captureCalls[0];
  assert.equal(src.width, DEVICE_W, 'captures from the real backing store');
  assert.equal(dx, 0); assert.equal(dy, 0);
  assert.equal(dw, expectW, `capture should downsample to ${expectW}, not copy ${DEVICE_W} 1:1`);
  assert.equal(dh, expectH);
  assert.ok(dw * dh < DEVICE_W * DEVICE_H / 5, 'the whole point: meaningfully fewer pixels than a 1:1 copy');
});

test('a resolution change reallocates the ring at the new downscaled size, not the old one', () => {
  const r = Object.create(Renderer.prototype);
  const { ctx } = recordingCtx();
  // Ring left at a stale size from a previous (different) backing store.
  r._motionHistory = [fakeRingSlot(100, 60), fakeRingSlot(100, 60), fakeRingSlot(100, 60)];
  r._motionRing = 1;

  const seen = [];
  const realCreate = globalThis.document?.createElement;
  globalThis.document = {
    createElement: () => {
      const c = fakeRingSlot(0, 0);
      seen.push(c);
      return c;
    },
  };
  try {
    r._drawDropMotionBlur(ctx, { width: DEVICE_W, height: DEVICE_H }, motionBlurSim(), camera(), 1, 1);
  } finally {
    if (realCreate) globalThis.document.createElement = realCreate; else delete globalThis.document;
  }

  const scale = DEVICE_W > 2560 ? 5 : DEVICE_W > 1920 ? 4 : 3;
  assert.equal(seen.length, 3, 'the ring reallocates all three slots on a size mismatch');
  for (const c of seen) {
    assert.equal(c.width, Math.round(DEVICE_W / scale));
    assert.equal(c.height, Math.round(DEVICE_H / scale));
  }
  // Resets to 0 internally on reallocation, then advances by 1 like every
  // call does -- so from the outside, one call after a reallocation lands
  // on 1, not 0.
  assert.equal(r._motionRing, 1, 'ring index resets (then advances once) alongside a reallocation');
});

test('ghosts upscale from the small ring back to full backing-store size on composite', () => {
  const r = Object.create(Renderer.prototype);
  const { ctx, calls } = recordingCtx();
  const scale = DEVICE_W > 2560 ? 5 : DEVICE_W > 1920 ? 4 : 3;
  const smallW = Math.round(DEVICE_W / scale), smallH = Math.round(DEVICE_H / scale);
  const slots = [fakeRingSlot(smallW, smallH), fakeRingSlot(smallW, smallH), fakeRingSlot(smallW, smallH)];
  r._motionHistory = slots;
  r._motionRing = 0;

  // Squarely inside the drop's impact window with real camera travel, so
  // strength is high and both ghost passes fire.
  r._drawDropMotionBlur(
    ctx, { width: DEVICE_W, height: DEVICE_H },
    motionBlurSim({ dropAtMs: 10000, timeMs: 10010 }), camera(4, -2), 1, 1,
  );

  const ghostCalls = calls.filter((c) => c.length === 9); // the 9-arg drawImage overload
  assert.ok(ghostCalls.length > 0, 'expected at least one ghost composite in the impact window');
  for (const [src, sx, sy, sw, sh, , , dw, dh] of ghostCalls) {
    assert.equal(sw, smallW, 'reads the ghost at its own small size');
    assert.equal(sh, smallH);
    assert.equal(dw, DEVICE_W, 'but draws it upscaled to the full backing store');
    assert.equal(dh, DEVICE_H);
    assert.ok(slots.includes(src), 'the source is one of the ring slots');
    void sx; void sy;
  }
});

test('no drop in flight still captures (keeping the ring warm) but composites nothing', () => {
  const r = Object.create(Renderer.prototype);
  const { ctx, calls } = recordingCtx();
  const scale = DEVICE_W > 2560 ? 5 : DEVICE_W > 1920 ? 4 : 3;
  const w = Math.round(DEVICE_W / scale), h = Math.round(DEVICE_H / scale);
  const slots = [fakeRingSlot(w, h), fakeRingSlot(w, h), fakeRingSlot(w, h)];
  r._motionHistory = slots;
  r._motionRing = 0;

  r._drawDropMotionBlur(
    ctx, { width: DEVICE_W, height: DEVICE_H },
    motionBlurSim({ dropAtMs: -Infinity }), camera(), 1, 1,
  );

  assert.equal(slots[0]._calls.length, 1, 'still captures every frame');
  assert.equal(calls.length, 0, 'but nothing composites onto the live frame without a drop');
});

test('shedding the pass drops the ring entirely, not just skips a frame', () => {
  const r = Object.create(Renderer.prototype);
  const { ctx } = recordingCtx();
  r._motionHistory = [fakeRingSlot(10, 10), fakeRingSlot(10, 10), fakeRingSlot(10, 10)];
  const sim = motionBlurSim();
  sim.perf.fullFrameFxEnabled = false;
  r._drawDropMotionBlur(ctx, { width: DEVICE_W, height: DEVICE_H }, sim, camera(), 1, 1);
  assert.equal(r._motionHistory, null, 'the (now-cheaper, but still real) buffers are freed, not just idled');
});

// The gate moved from heavyPostFx to fullFrameFxEnabled deliberately. This
// pass copies the WHOLE composed frame every frame of the song, so its cost
// scales with the backing store while the rest of the ladder sheds draw
// calls. Profiled at a 3840x2160 stage it was 23% of wall time -- the single
// most expensive thing in the frame -- and it was gated on the ladder's LAST
// rung, so a 4K machine shed its vision loop, particles, rim light, bloom,
// the veil and the whole phenomena layer before reaching it.
test('the ring reads the resolution-aware gate, not the generic heavy-post-fx one', () => {
  const r = Object.create(Renderer.prototype);
  const { ctx } = recordingCtx();
  r._motionHistory = [fakeRingSlot(10, 10), fakeRingSlot(10, 10), fakeRingSlot(10, 10)];
  const sim = motionBlurSim();
  // Everything else still allowed; only the whole-frame copies are shed.
  sim.perf.heavyPostFx = true;
  sim.perf.fullFrameFxEnabled = false;
  r._drawDropMotionBlur(ctx, { width: DEVICE_W, height: DEVICE_H }, sim, camera(), 1, 1);
  assert.equal(r._motionHistory, null, 'a shed whole-frame pass must not survive on heavyPostFx alone');
});
