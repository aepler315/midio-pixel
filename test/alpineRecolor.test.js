import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';

test('alpine body recolor preserves a baked landmark above the crest', () => {
  const previousPath = globalThis.Path2D;
  globalThis.Path2D = class {
    constructor() { this.ys = []; }
    moveTo(x, y) { this.ys.push(y); }
    lineTo(x, y) { this.ys.push(y); }
    closePath() {}
  };
  try {
    const pixels = { landmark: '#d7b46a', body: '#536158' };
    const stack = [];
    const sideCtx = {
      globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', clipMinY: -Infinity,
      setTransform() {}, clearRect() {},
      save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.clipMinY]); },
      restore() { [this.globalAlpha, this.globalCompositeOperation, this.clipMinY] = stack.pop(); },
      clip(path) { this.clipMinY = Math.min(...path.ys); },
      fillRect() {
        if (this.clipMinY <= 50) pixels.landmark = this.fillStyle;
        if (this.clipMinY <= 150) pixels.body = this.fillStyle;
      },
    };
    const surface = { width: 200, height: 300, getContext: () => sideCtx };
    const mainCtx = { save() {}, restore() {}, drawImage() {}, globalAlpha: 1 };
    const mgr = Object.create(BiomeManager.prototype);
    mgr.world = { kind: 'alpine' };
    mgr.h = 300;
    mgr.groundY = 250;
    mgr.currentBlend = { travel: false };
    mgr._airColor = '#9baaa7';
    mgr._zoomedGroundY = () => 250;
    mgr._pass = () => true;
    mgr._acquireTravelSurface = () => surface;
    mgr._drawDancingStrip = () => {};
    mgr._drawRidgeVolume = () => {};
    mgr._crestPoints = () => ({ bottomY: 280, pts: [
      { x: 0, y: 100 }, { x: 200, y: 100 },
    ] });
    mgr.stripsFor = () => ({ L3: { width: 200 } });
    const profile = { name: 'RAINFOREST', silhouette: '#536158', terrainEnergy: 1 };
    mgr._drawLayer(mainCtx, { width: 200, height: 300 }, 'L3', 0, '#536158', 1,
      profile, profile);
    assert.equal(pixels.landmark, '#d7b46a');
    assert.notEqual(pixels.body, '#536158');
  } finally {
    globalThis.Path2D = previousPath;
  }
});
