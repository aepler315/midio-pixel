import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';

function recordingCtx() {
  const blits = [];
  const ctx = {
    blits,
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    drawImage(surface) { blits.push({ slot: surface.slot, alpha: ctx.globalAlpha }); },
  };
  return ctx;
}

let made = 0;
globalThis.document = {
  createElement() {
    const slot = ['A', 'B', 'mix'][made++];
    const sctx = {
      blits: [],
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      setTransform() {},
      clearRect() {},
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      drawImage(surface) {
        this.blits.push({ slot: surface.slot, alpha: this.globalAlpha,
          composite: this.globalCompositeOperation });
      },
    };
    return {
      slot,
      width: 0,
      height: 0,
      getContext: () => sctx,
    };
  },
};

function manager() {
  const mgr = Object.create(BiomeManager.prototype);
  const counts = { strip: 0, volume: 0, crest: 0 };
  mgr.counts = counts;
  mgr.h = 720;
  mgr.groundY = 600;
  mgr.floatTilt = 0;
  mgr._crestTints = { L3: ['#111', '#222', '#fff'] };
  mgr._zoomedGroundY = () => 600;
  mgr._drawDancingStrip = () => { counts.strip += 1; };
  mgr._drawRidgeVolume = () => { counts.volume += 1; };
  mgr._drawCrest = () => { counts.crest += 1; };
  mgr.stripsFor = () => ({ L3: { width: 2048 } });
  return mgr;
}

const A = { name: 'Out', edgeLight: '#fff', terrainEnergy: 1, fx: null };
const B = { name: 'In', edgeLight: '#fff', terrainEnergy: 1, fx: null };

test('a settled ridge paints strip, volume and crest once', () => {
  const mgr = manager();
  mgr.currentBlend = { from: 'Out', to: 'Out', t: 1 };
  mgr._drawLayer(recordingCtx(), { width: 1280, height: 720 }, 'L3', 10, '#333', 1, A, A);
  assert.deepEqual(mgr.counts, { strip: 1, volume: 1, crest: 1 });
});

test('biome travel paints each side once and sends one mixed surface to the scene', () => {
  made = 0;
  const mgr = manager();
  mgr.currentBlend = { travel: true, travelP: 0.5, from: 'Out', to: 'In' };
  const ctx = recordingCtx();
  mgr._drawLayer(ctx, { width: 1000, height: 600 }, 'L3', 10, '#333', 0.5, A, B);
  assert.deepEqual(mgr.counts, { strip: 2, volume: 2, crest: 2 });
  const bands = [0.125, 0.375, 0.625, 0.875];
  assert.deepEqual(ctx.blits, [{ slot: 'mix', alpha: 1 }]);
  const mixBlits = mgr._travelSurfaces.mix.getContext('2d').blits;
  const expected = [{ slot: 'A', alpha: 1, composite: 'source-over' },
    ...bands.flatMap((a) => [
      { slot: 'A', alpha: 1 - a, composite: 'source-over' },
      { slot: 'B', alpha: a, composite: 'lighter' },
    ]),
    { slot: 'B', alpha: 1, composite: 'source-over' }];
  assert.equal(mixBlits.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(mixBlits[i].slot, expected[i].slot, `blit ${i} side`);
    assert.equal(mixBlits[i].composite, expected[i].composite, `blit ${i} operation`);
    assert.ok(Math.abs(mixBlits[i].alpha - expected[i].alpha) < 1e-9,
      `blit ${i} alpha ${mixBlits[i].alpha}`);
  }
});
