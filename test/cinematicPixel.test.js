import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import * as module from '../src/render/CinematicPixel.js';

test('cell reconstruction follows a continuous ramp within each discrete owner', () => {
  assert.equal(typeof module.cinematicCellColor, 'function');
  const c = n => [n,n,n,1];
  assert.deepEqual(module.cinematicCellColor(c(.4), c(.39), c(.41), c(.4), c(.4), [.5,0]), [.404,.404,.404,1]);
  assert.deepEqual(module.cinematicCellColor(c(.4), c(.39), c(.41), c(.4), c(.4), [-.5,0]), [.396,.396,.396,1]);
});
test('the slope gain holds the validated boundary residual at every cell width', () => {
  // Classic+ on 720p (cells 3.2 output px) is the validated look: gain .8.
  assert.equal(module.cellStrength(3.2), module.CINEMATIC_CELLS.strength);
  assert.ok(Math.abs(module.CELL_RESIDUAL - 1.8) < 1e-12);
  // On an accepted ramp the boundary step over the in-cell step stays the
  // residual for any integer cell width k (Detailed at 720p/1080p/1440p/4K).
  const c = n => [n, n, n, 1], slope = .01;
  for (const k of [2, 3, 4, 6, 12]) {
    const g = module.cellStrength(k);
    const at = (cell, i) => module.cinematicCellColor(c(.5 + cell * slope), c(.5 + (cell - 1) * slope), c(.5 + (cell + 1) * slope), c(.5), c(.5), [(i + .5) / k - .5, 0], g)[0];
    const inside = at(0, 1) - at(0, 0), boundary = at(1, 0) - at(0, k - 1);
    assert.ok(Math.abs(boundary / inside - module.CELL_RESIDUAL) < 1e-9, `k ${k}: ${boundary / inside}`);
  }
  assert.ok(module.cellStrength(6) > module.cellStrength(3) && module.cellStrength(2) < module.CINEMATIC_CELLS.strength, 'wider cells take more slope');
});
test('contrasting boundaries, isolated detail and partial coverage retain their nearest color', () => {
  assert.equal(typeof module.cinematicCellColor, 'function');
  const c = [.08,.12,.16,1], bright = [.9,.95,1,1];
  assert.deepEqual(module.cinematicCellColor(c, c, bright, c, c, [.5,0]), c);
  const alpha = [...c.slice(0,3),.5];
  assert.deepEqual(module.cinematicCellColor(alpha, c, bright, c, c, [.5,.5]), alpha);
  assert.deepEqual(module.cinematicCellColor(bright, c, c, c, c, [.5,.5]), bright);
});
test('optional gradient pass refuses allocation before making a context, and failure releases its charge', () => {
  assert.equal(typeof module.CinematicPixelRenderer, 'function');
  let allocations=0;
  const source = { width:400,height:225 };
  const residency = new GraphicsResidency({budgetBytes:1});
  const pass = new module.CinematicPixelRenderer({residency,makeCanvas:()=>{allocations++; return {getContext:()=>null};}});
  assert.equal(pass.draw({},source,{width:1280,height:720}),false);
  assert.equal(allocations,0);
  assert.equal(residency.usedBytes,0);
  pass.dispose();
  const roomy = new GraphicsResidency();
  const failed = new module.CinematicPixelRenderer({residency:roomy,makeCanvas:()=>({getContext:()=>null})});
  assert.equal(failed.draw({},source,{width:1280,height:720}),false);
  assert.equal(failed.reason,'webgl-unavailable');
  assert.equal(roomy.usedBytes,0);
  failed.dispose(); failed.dispose();
});

// A WebGL/canvas stub that records what the pass asks of the drawing buffer.
function stubPass({ residency = new GraphicsResidency() } = {}) {
  const log = { reserves: 0, resizes: 0, viewports: [], deleted: 0, contexts: 0 };
  const reserve = residency.reserve.bind(residency);
  residency.reserve = options => { log.reserves++; return reserve(options); };
  const gl = new Proxy({ NO_ERROR: 0 }, { get(target, name) {
    if (name in target) return target[name];
    if (typeof name === 'string' && /^[A-Z_0-9]+$/.test(name)) return name;
    if (name === 'getError') return () => 0;
    if (name === 'isContextLost') return () => false;
    if (name === 'viewport') return (...args) => log.viewports.push(args);
    if (/^get(Shader|Program)Parameter$/.test(name)) return () => true;
    if (/^create/.test(name)) return () => ({});
    if (/^delete/.test(name)) return () => { log.deleted++; };
    return () => {};
  } });
  const makeCanvas = () => {
    let width = 300, height = 150;
    return { getContext: () => { log.contexts++; return gl; },
      get width() { return width; }, set width(v) { width = v; log.resizes++; },
      get height() { return height; }, set height(v) { height = v; } };
  };
  const pass = new module.CinematicPixelRenderer({ residency, makeCanvas });
  const draws = [];
  const ctx = { drawImage: (...args) => draws.push(args) };
  return { pass, residency, log, draws, ctx };
}
const fitOf = (width, height) => ({ x: 0, y: 0, width, height });

test('display and capture at different sizes share one union buffer instead of resizing it each draw', () => {
  const source = { width: 640, height: 360 };
  for (const order of [[fitOf(1920, 1080), fitOf(1280, 720)], [fitOf(1280, 720), fitOf(1920, 1080)]]) {
    const { pass, residency, log, draws, ctx } = stubPass();
    for (const fit of order) assert.equal(pass.draw(ctx, source, fit), true);
    const afterPair = { reserves: log.reserves, resizes: log.resizes };
    assert.equal(log.contexts, 1, 'one WebGL context serves both sizes');
    for (let frame = 0; frame < 30; frame++) for (const fit of order) {
      log.viewports.length = 0; draws.length = 0;
      assert.equal(pass.draw(ctx, source, fit), true);
      // The viewport and blit use the requested size, never the shared buffer's.
      assert.deepEqual(log.viewports, [[0, 0, fit.width, fit.height]]);
      assert.deepEqual(draws[0].slice(1, 5), [0, 1080 - fit.height, fit.width, fit.height]);
      assert.deepEqual(draws[0].slice(5), [fit.x, fit.y, fit.width, fit.height]);
      assert.equal(pass.strength, module.cellStrength(fit.width / source.width));
    }
    assert.ok(log.reserves - afterPair.reserves <= 1 && log.resizes - afterPair.resizes <= 1,
      `reallocations after the first pair: ${log.reserves - afterPair.reserves} reserves, ${log.resizes - afterPair.resizes} resizes`);
    assert.deepEqual([pass.canvas.width, pass.canvas.height], [1920, 1080]);
    assert.equal(pass.bytes, 1920 * 1080 * 12 + 640 * 360 * 4 + 4096);
    assert.equal(residency.usedBytes, pass.bytes);
    pass.dispose();
    assert.equal(residency.usedBytes, 0);
  }
});
test('a mixed-aspect recording keeps its union; a display-only run shrinks it after a bounded number of draws', () => {
  const source = { width: 640, height: 360 };
  const { pass, residency, log, ctx } = stubPass();
  // Different aspects: neither request alone fills the union.
  for (let frame = 0; frame < 200; frame++) { pass.draw(ctx, source, fitOf(1920, 1080)); pass.draw(ctx, source, fitOf(1280, 2160)); }
  assert.deepEqual([pass.canvas.width, pass.canvas.height], [1920, 2160]);
  assert.equal(log.reserves, 2);
  pass.draw(ctx, source, fitOf(3840, 2160));
  const before = log.reserves;
  for (let i = 1; i < module.CINEMATIC_BUFFER_SHRINK_DRAWS; i++) {
    assert.equal(pass.draw(ctx, source, fitOf(1920, 1080)), true);
    assert.deepEqual([pass.canvas.width, pass.canvas.height], [3840, 2160], `still the union after ${i} display draws`);
  }
  assert.equal(log.reserves, before);
  assert.equal(pass.draw(ctx, source, fitOf(1920, 1080)), true);
  assert.deepEqual([pass.canvas.width, pass.canvas.height], [1920, 1080]);
  assert.equal(log.reserves, before + 1);
  assert.equal(residency.usedBytes, 1920 * 1080 * 12 + 640 * 360 * 4 + 4096);
  pass.dispose();
});
test('a new source size reallocates; suspend releases the key and zeroes the canvas', () => {
  const { pass, residency, log, ctx } = stubPass();
  assert.equal(pass.draw(ctx, { width: 640, height: 360 }, fitOf(1920, 1080)), true);
  assert.equal(pass.draw(ctx, { width: 400, height: 225 }, fitOf(1920, 1080)), true);
  assert.equal(log.reserves, 2);
  assert.equal(pass.bytes, 1920 * 1080 * 12 + 400 * 225 * 4 + 4096);
  pass.suspend();
  assert.equal(residency.has(pass.key), false);
  assert.equal(residency.usedBytes, 0);
  assert.equal(pass.bytes, 0);
  assert.deepEqual([pass.canvas.width, pass.canvas.height], [0, 0]);
  assert.equal(pass.draw(ctx, { width: 400, height: 225 }, fitOf(1280, 720)), true, 'the next draw re-admits its buffer');
  assert.deepEqual([pass.canvas.width, pass.canvas.height], [1280, 720]);
  assert.equal(log.contexts, 1, 'suspension keeps the one context');
  pass.dispose();
  assert.equal(residency.usedBytes, 0);
});
test('denied growth falls back for that draw without thrashing the buffer the display still uses', () => {
  const source = { width: 640, height: 360 };
  const display = 1920 * 1080 * 12 + 640 * 360 * 4 + 4096;
  const { pass, residency, log, draws, ctx } = stubPass({ residency: new GraphicsResidency({ budgetBytes: display + 1000 }) });
  assert.equal(pass.draw(ctx, source, fitOf(1920, 1080)), true);
  // The first denied growth releases its charge and GPU objects, as a denied
  // resize always has (test/cinematicPixelGpu.test.mjs).
  assert.equal(pass.draw(ctx, source, fitOf(3840, 2160)), false);
  assert.equal(pass.reason, 'allocation-denied');
  assert.equal(residency.usedBytes, 0);
  assert.equal(pass.bytes, 0);
  assert.ok(log.deleted > 0);
  assert.equal(pass.draw(ctx, source, fitOf(1920, 1080)), true);
  assert.equal(pass.reason, null);
  const reserves = log.reserves, resizes = log.resizes, drawn = draws.length;
  // The same growth is not retried for a while: the capture size falls back
  // at once and the display keeps its buffer.
  for (let frame = 0; frame < 30; frame++) {
    assert.equal(pass.draw(ctx, source, fitOf(3840, 2160)), false);
    assert.equal(pass.reason, 'allocation-denied');
    assert.equal(pass.draw(ctx, source, fitOf(1920, 1080)), true);
  }
  assert.equal(log.reserves, reserves);
  assert.equal(log.resizes, resizes);
  assert.equal(draws.length, drawn + 30);
  assert.equal(residency.usedBytes, display);
  // A smaller capture the held buffer covers still draws.
  assert.equal(pass.draw(ctx, source, fitOf(1280, 720)), true);
  // A shrink denied by a tightened budget keeps the buffer that is big enough.
  residency.budgetBytes = 1;
  for (let i = 0; i < module.CINEMATIC_BUFFER_SHRINK_DRAWS + 2; i++) assert.equal(pass.draw(ctx, source, fitOf(1280, 720)), true);
  assert.deepEqual([pass.canvas.width, pass.canvas.height], [1920, 1080]);
  assert.equal(residency.usedBytes, display);
  pass.dispose();
  assert.equal(residency.usedBytes, 0);
});
