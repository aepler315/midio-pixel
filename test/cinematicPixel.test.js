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
