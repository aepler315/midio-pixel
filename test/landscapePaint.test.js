import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceRidge } from '../src/world/SpaceRidge.js';
import { ConstellationWeaver } from '../src/world/ConstellationWeaver.js';
import { LightRig } from '../src/world/LightRig.js';
import { SkyEnsemble } from '../src/world/SkyEnsemble.js';

function stub() {
  const ops = [];
  const stack = [];
  const ctx = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    save() { stack.push(this.globalAlpha); },
    restore() { this.globalAlpha = stack.pop(); },
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    ellipse() {},
    rect() {},
    fillRect() {},
    clip() {},
    translate() {},
    scale() {},
    stroke() { ops.push(this.globalAlpha); },
    fill() { ops.push(this.globalAlpha); },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
  };
  return { ctx, ops };
}

test('space ridge honors inherited opacity on every stroke', () => {
  const ridge = new SpaceRidge(315);
  const full = stub();
  full.ctx.globalAlpha = 1;
  ridge.draw(full.ctx, { width: 1280, height: 720 }, '#88aacc', 1, false, 1);
  const dim = stub();
  dim.ctx.globalAlpha = 0.25;
  ridge.draw(dim.ctx, { width: 1280, height: 720 }, '#88aacc', 1, false, 1);
  const none = stub();
  none.ctx.globalAlpha = 0;
  ridge.draw(none.ctx, { width: 1280, height: 720 }, '#88aacc', 1, false, 1);
  assert.ok(full.ops.length > 0);
  assert.equal(dim.ops.length, full.ops.length);
  assert.ok(dim.ops.every((alpha, i) => Math.abs(alpha - full.ops[i] * 0.25) < 1e-9));
  assert.ok(none.ops.every((alpha) => alpha === 0));
  assert.equal(dim.ctx.globalAlpha, 0.25);
});

test('active and retained constellations both take the system opacity', () => {
  const weaver = new ConstellationWeaver(315, 1280, 720);
  weaver.stars.push({ dots: [{ x: 100, y: 80, phase: 0 }, { x: 140, y: 90, phase: 1 }], hue: 200 });
  weaver.figures.push({
    phase: 'holding', dots: [{ x: 200, y: 80 }, { x: 240, y: 100 }], hue: 40,
    holdStartMs: 0, edgeStartMs: 0, edgeRevealedCount: 1, targetCount: 2,
  });
  const full = stub();
  weaver.draw(full.ctx, { width: 1280, height: 720 }, false, 1, 1, 0);
  const dim = stub();
  dim.ctx.globalAlpha = 0.25;
  weaver.draw(dim.ctx, { width: 1280, height: 720 }, false, 1, 1, 0);
  assert.ok(full.ops.length > 2);
  assert.equal(dim.ops.length, full.ops.length);
  assert.ok(dim.ops.every((alpha) => Math.abs(alpha - 0.25) < 1e-9));
  assert.equal(dim.ctx.globalAlpha, 0.25);
});

test('Range keeps a steady readable core when reduced flash is enabled', () => {
  const ridge = new SpaceRidge(315);
  const view = stub();
  const strokes = [];
  view.ctx.stroke = () => strokes.push({ alpha: view.ctx.globalAlpha, blend: view.ctx.globalCompositeOperation });
  ridge.draw(view.ctx, { width: 1280, height: 720 }, '#88aacc', 1, true);
  assert.ok(strokes.some(({ alpha }) => alpha >= 0.39), 'the steady contour should survive the flash cap');
  assert.ok(strokes.every(({ blend }) => blend === 'source-over'),
    'reduced flash should not accumulate multiple capped strokes additively');
  assert.equal(view.ctx.globalAlpha, 1);
});

test('SpaceRidge has only a few bright structural joints, not a bead at every sample', () => {
  const ridge = new SpaceRidge(315);
  const view = stub();
  let circles = 0;
  view.ctx.arc = () => { circles++; };
  ridge.draw(view.ctx, { width: 1280, height: 720 }, '#88aacc', 1);
  assert.ok(circles <= 16, `too many bright nodes: ${circles} circles`);
});

test('Range can show one incidental figure and exclude the ridge corridor', () => {
  const weaver = new ConstellationWeaver(315, 1280, 720);
  weaver._lastNowMs = 1000;
  for (let i = 0; i < 3; i++) weaver.figures.push({
    phase: 'holding', dots: [{ x: 100 + i * 100, y: 80 }, { x: 140 + i * 100, y: 100 }], hue: 40,
    holdStartMs: 0, edgeStartMs: 0, edgeRevealedCount: 1, targetCount: 2,
  });
  weaver.stars.push({ dots: [{ x: 100, y: 80 }, { x: 140, y: 100 }], hue: 200 });
  const all = stub();
  weaver.draw(all.ctx, { width: 1280, height: 720 });
  const one = stub();
  weaver.draw(one.ctx, { width: 1280, height: 720 }, false, 1, 1, 0,
    { maxFigures: 1, maxRetained: 0, allowPoint: () => true });
  assert.ok(one.ops.length > 0 && one.ops.length < all.ops.length / 2,
    `one figure should be far simpler than all figures and stars (${one.ops.length}/${all.ops.length})`);
  const excluded = stub();
  weaver.draw(excluded.ctx, { width: 1280, height: 720 }, false, 1, 1, 0,
    { maxFigures: 1, maxRetained: 0, allowPoint: () => false });
  assert.equal(excluded.ops.length, 0, 'no incidental dot or line may enter the signature corridor');
});

test('light rig opacity changes without changing beam count', () => {
  const rig = new LightRig(315);
  for (let i = 0; i < 60; i++) rig.update(i * 16.7, 1 / 60, 500, 0, 1);
  const count = (presentation) => {
    const view = stub();
    let paths = 0;
    const orig = view.ctx.beginPath;
    view.ctx.beginPath = () => { paths += 1; orig.call(view.ctx); };
    rig.draw(view.ctx, { width: 1280, height: 720 }, 900, 120, '#ffaa55', 1, false, presentation);
    return { paths, alpha: view.ops[0], restored: view.ctx.globalAlpha };
  };
  const bright = count(1);
  const dim = count(0.4);
  assert.equal(bright.paths, dim.paths);
  assert.ok(bright.paths > 0);
  assert.ok(Math.abs(dim.alpha - bright.alpha * 0.4) < 1e-9);
  assert.equal(dim.restored, 1);
});

test('ensemble planets and nested artifacts honor presentation and restore', () => {
  const sky = new SkyEnsemble(315, 120000);
  const view = stub();
  view.ctx.globalAlpha = 0.5;
  sky.draw(view.ctx, { width: 800, height: 450 }, 20000, {
    fromName: 'RAINFOREST', toName: 'STEPPE', t: 0.5,
    colors: { skyMid: '#6688aa', silhouette: '#334433', halo: '#ffe0b0' },
    presentation: 0.5, maxPlanets: 1,
  });
  assert.ok(view.ops.length > 0);
  assert.ok(view.ops.every((alpha) => alpha <= 0.25 + 1e-9));
  assert.equal(view.ctx.globalAlpha, 0.5);
});
