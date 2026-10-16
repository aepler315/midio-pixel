import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawFoundryWorld, drawMachinery } from '../src/world/foundry/drawFoundry.js';
import { drawFathomWorld } from '../src/world/fathom/drawFathom.js';
import { drawUnderstoryWorld } from '../src/world/understory/drawUnderstory.js';

function render(draw, { reducedMotion, reducedFlash, tSec, accent = 0.9, energy = 0.6 }) {
  const geometry = [], light = [];
  const ctx = { globalAlpha: 1, createLinearGradient: () => ({ addColorStop() {} }) };
  for (const name of ['save', 'restore', 'beginPath', 'closePath', 'fill', 'stroke']) ctx[name] = () => {};
  for (const name of ['moveTo', 'lineTo', 'arc', 'rect', 'fillRect']) ctx[name] = (...args) => geometry.push([name, ...args]);
  Object.defineProperty(ctx, 'globalAlpha', { get: () => 1, set: value => { light.push(value); } });
  const mgr = { tSec, reducedMotion, reducedFlash, groundY: 290, openingGain: 1, fields: new Map(),
    sections: [], _lastSectionIdx: 0, worldRhythm: { tMs: tSec * 1000, vel: accent },
    energyCurves: { sample: () => energy, globalEnergyNorm: () => energy },
    _rotated: value => value, lerpCache: { get: value => value }, stripsFor: () => null };
  for (const name of ['_drawSky', '_drawCelestial', '_drawMoon', '_drawGround', '_drawTerrainFooting', '_drawFlood', '_drawTransitionOverlays', '_drawSignature']) mgr[name] = () => {};
  const A = { name: 'fixture', silhouette: '#18302b', sky: ['#112233', '#112233', '#223344'], celestial: { haloColor: '#80c8ef' } };
  const frame = { ctx, canvas: { width: 640, height: 360 }, A, B: A, worldX: 400, originX: 0, t: 0,
    dn: { sunAlt: 0.6, moonAlt: 0.4 }, phenomenaFull: true, particleMul: 1 };
  if (draw === drawMachinery) draw(mgr, frame, { energy, accent, group: 0 });
  else draw(mgr, frame);
  return { geometry, light };
}

for (const [name, draw] of [['Foundry mills', drawFoundryWorld], ['Foundry rams', drawMachinery], ['Fathom', drawFathomWorld], ['Understory spores', drawUnderstoryWorld]]) {
  for (const reducedFlash of [false, true]) {
    test(`WP04 ${name} motion preference fixes musical displacement independently of flash=${reducedFlash}`, () => {
      const args = { reducedMotion: true, reducedFlash, tSec: 4 };
      const a = render(draw, args), b = render(draw, { ...args, tSec: 8, accent: 0, energy: 0.2 });
      assert.deepEqual(a.geometry, b.geometry, 'musical displacement is held at its neutral geometry');
      assert.notDeepEqual(a.light, b.light, 'brightness still carries musical evidence');
    });
  }
}
