import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorldAssembly, assembleMotionU, assembleFadeAlpha, ASSEMBLE_TOTAL_MS,
} from '../src/world/WorldAssembly.js';

/** A ctx stub that records clip triangles + drawImage calls + globalAlpha,
 *  same shape as fracture.test.js's alphaRecordingCtx -- no real canvas
 *  needed since WorldAssembly.draw() never samples the backing store. */
function recordingCtx() {
  const triangles = [];
  const drawImageCalls = [];
  const alphas = [];
  let pendingTri = null;
  const ctx = {
    save() {}, restore() {}, beginPath() { pendingTri = []; },
    moveTo(x, y) { pendingTri.push({ x, y }); },
    lineTo(x, y) { pendingTri.push({ x, y }); },
    closePath() {}, clip() { triangles.push(pendingTri); },
    translate() {}, rotate() {},
    drawImage: (...a) => drawImageCalls.push(a),
    set globalAlpha(v) { alphas.push(v); }, get globalAlpha() { return alphas[alphas.length - 1]; },
  };
  return { ctx, triangles, drawImageCalls, alphas };
}

test('assembleMotionU stays at 0 through its own start delay, then eases 0->1', () => {
  assert.equal(assembleMotionU(0, 100), 0);
  assert.equal(assembleMotionU(50, 100), 0);
  assert.equal(assembleMotionU(100, 100), 0);
  assert.ok(assembleMotionU(400, 100) > 0 && assembleMotionU(400, 100) < 1);
  assert.equal(assembleMotionU(2000, 100), 1);
});

test('assembleFadeAlpha holds opaque through the burst + hold, then eases to 0', () => {
  assert.equal(assembleFadeAlpha(0), 1);
  assert.equal(assembleFadeAlpha(500), 1); // still well inside stagger+burst+hold
  assert.ok(assembleFadeAlpha(ASSEMBLE_TOTAL_MS - 50) < 1, 'should be fading by the very end');
  assert.ok(assembleFadeAlpha(ASSEMBLE_TOTAL_MS + 500) <= 1e-9, 'fully revealed well past the total');
});

test('_triangulate produces fragments that land exactly on their own tri centroid', () => {
  const wa = new WorldAssembly({ canvasWidth: 1280, canvasHeight: 720, songSeed: 7 });
  wa._triangulate();
  assert.ok(wa.fragments.count > 0, 'expected real triangulation output');
  for (const f of wa.fragments.active) {
    assert.equal(f.tri.length, 3);
    // Every home position must sit inside (or right at the edge of) the frame.
    assert.ok(f.cx >= -1 && f.cx <= 1281 && f.cy >= -1 && f.cy <= 721);
    // Scattered start must be a real displacement from home, not the same point.
    const scatterDist = Math.hypot(f.startX - f.cx, f.startY - f.cy);
    assert.ok(scatterDist > 100, `expected a real scatter offset, got ${scatterDist}`);
    assert.ok(f.delayMs >= 0 && Number.isFinite(f.delayMs));
    assert.ok(Number.isFinite(f.startRot));
  }
});

test('_triangulate is deterministic per seed and diverges across seeds', () => {
  const a = new WorldAssembly({ canvasWidth: 1280, canvasHeight: 720, songSeed: 3 });
  const b = new WorldAssembly({ canvasWidth: 1280, canvasHeight: 720, songSeed: 3 });
  const c = new WorldAssembly({ canvasWidth: 1280, canvasHeight: 720, songSeed: 9 });
  a._triangulate(); b._triangulate(); c._triangulate();
  assert.deepEqual(a.fragments.active, b.fragments.active, 'same seed reproduces the same shard layout');
  assert.notDeepEqual(a.fragments.active, c.fragments.active, 'different seeds diverge');
});

test('wantsCapture fires exactly once, after its own delay, and only while waiting', () => {
  const wa = new WorldAssembly({ canvasWidth: 1280, canvasHeight: 720, songSeed: 1 });
  assert.equal(wa.wantsCapture(0), false, 'not yet -- give the first real frame time to render');
  assert.equal(wa.wantsCapture(500), true, 'delay has elapsed');

  // Simulate what Renderer does once wantsCapture returns true: capture,
  // which flips state away from 'waiting'.
  wa.state = 'assembling';
  assert.equal(wa.wantsCapture(600), false, 'no second capture once already assembling');
});

test('update() transitions assembling -> done once the whole envelope has elapsed, and frees state', () => {
  const wa = new WorldAssembly({ canvasWidth: 1280, canvasHeight: 720, songSeed: 1 });
  wa.frame = {}; wa.startMs = 1000; wa.state = 'assembling';
  wa._triangulate();
  assert.ok(wa.active);

  wa.update(1000 + ASSEMBLE_TOTAL_MS - 10);
  assert.equal(wa.state, 'assembling', 'not done yet, just under the total');

  wa.update(1000 + ASSEMBLE_TOTAL_MS + 10);
  assert.equal(wa.state, 'done');
  assert.equal(wa.active, false);
  assert.equal(wa.frame, null, 'the captured frame is released once assembly is over');
  assert.equal(wa.fragments.count, 0);
});

test('draw() is a no-op before capture and after completion', () => {
  const wa = new WorldAssembly({ canvasWidth: 1280, canvasHeight: 720, songSeed: 1 });
  const waiting = recordingCtx();
  wa.draw(waiting.ctx, 0);
  assert.equal(waiting.drawImageCalls.length, 0, 'nothing captured yet, nothing to draw');

  wa.frame = {}; wa.startMs = 0; wa.state = 'assembling';
  wa._triangulate();
  const done = recordingCtx();
  wa.draw(done.ctx, ASSEMBLE_TOTAL_MS + 1000);
  // draw() itself doesn't flip state (update() does), but the fully-revealed
  // fade envelope at this age must already be ~0 -- nothing should render.
  assert.equal(done.drawImageCalls.length, 0, 'fully faded out, nothing left to draw');
});

test('draw() clips each shard to its own triangle and samples the captured frame through it', () => {
  const wa = new WorldAssembly({ canvasWidth: 1280, canvasHeight: 720, songSeed: 2 });
  wa.frame = { __fakeFrame: true };
  wa.startMs = 0;
  wa.state = 'assembling';
  wa._triangulate();
  const n = wa.fragments.count;

  const { ctx, triangles, drawImageCalls } = recordingCtx();
  wa.draw(ctx, 0); // t=0: every shard still fully scattered

  assert.equal(triangles.length, n, 'one clip triangle per shard');
  assert.equal(drawImageCalls.length, n, 'one drawImage per shard, sampling the same captured frame');
  for (const [src] of drawImageCalls) assert.equal(src, wa.frame, 'must sample the captured target frame, not anything live');
  for (const tri of triangles) assert.equal(tri.length, 3, 'clip path is a real triangle');
});

test('draw() eases every shard back to its home position by the end of its own burst', () => {
  const wa = new WorldAssembly({ canvasWidth: 1280, canvasHeight: 720, songSeed: 5 });
  wa.frame = { __fakeFrame: true };
  wa.startMs = 0;
  wa.state = 'assembling';
  wa._triangulate();

  // Patch translate to record the (x,y) each shard actually lands at, since
  // the stub ctx above only tracks clip triangles / drawImage args.
  const landed = [];
  const { ctx } = recordingCtx();
  ctx.translate = (x, y) => landed.push({ x, y });
  const maxDelay = Math.max(...wa.fragments.active.map((f) => f.delayMs));

  wa.draw(ctx, maxDelay + 700); // past every shard's own burst window
  assert.equal(landed.length, wa.fragments.count);
  let i = 0;
  for (const f of wa.fragments.active) {
    const l = landed[i++];
    assert.ok(Math.abs(l.x - f.cx) < 1, `shard should have landed at its home x (${l.x} vs ${f.cx})`);
    assert.ok(Math.abs(l.y - f.cy) < 1, `shard should have landed at its home y (${l.y} vs ${f.cy})`);
  }
});

for (const offscreenAvailable of [false, true]) {
  test(`capture completes and draws shards with OffscreenCanvas ${offscreenAvailable ? 'present' : 'absent'}`, () => {
    const originals = new Map(['OffscreenCanvas', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const capture = recordingCtx();
    let created;
    class CanvasStub {
      constructor(width = 300, height = 150) { this.width = width; this.height = height; created = this; }
      getContext(kind) { assert.equal(kind, '2d'); return capture.ctx; }
    }
    try {
      if (offscreenAvailable) globalThis.OffscreenCanvas = CanvasStub;
      else delete globalThis.OffscreenCanvas;
      globalThis.document = { createElement(tag) {
        assert.equal(offscreenAvailable, false, 'available OffscreenCanvas should be used');
        assert.equal(tag, 'canvas');
        return new CanvasStub();
      } };
      const wa = new WorldAssembly({ canvasWidth: 640, canvasHeight: 360, songSeed: 7 });
      const source = { width: 1280, height: 720 };
      wa.captureFrame(source, 200);
      assert.equal(created.width, 640);
      assert.equal(created.height, 360);
      assert.deepEqual(capture.drawImageCalls, [[source, 0, 0, 640, 360]]);
      assert.equal(wa.state, 'assembling');
      assert.equal(wa.wantsCapture(300), false, 'capture must not retry next frame');
      assert.ok(wa.fragments.count > 0);
      const draw = recordingCtx();
      wa.draw(draw.ctx, 300);
      assert.equal(draw.drawImageCalls.length, wa.fragments.count);
      assert.ok(draw.drawImageCalls.every(([image]) => image === created));
      wa.update(200 + ASSEMBLE_TOTAL_MS);
      assert.equal(wa.state, 'done');
      assert.equal(wa.frame, null);
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
}

// Export/seek can advance the song without drawing its opening frames.
test('a late first render never starts the opening assembly over a later scene', () => {
  const wa = new WorldAssembly({ canvasWidth: 1280, canvasHeight: 720, songSeed: 1 });
  assert.equal(wa.wantsCapture(12000), false);
  assert.equal(wa.wantsCapture(15000), false);
  assert.equal(wa.active, false);
});

test('simulation expires an uncaptured opening on the song clock', () => {
  const wa = new WorldAssembly({ canvasWidth: 1280, canvasHeight: 720, songSeed: 1 });
  wa.update(ASSEMBLE_TOTAL_MS + 200);
  assert.equal(wa.active, false);
  assert.equal(wa.wantsCapture(150000), false);
});
