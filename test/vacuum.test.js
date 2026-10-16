import test from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { sampleWorldMusic } from '../src/world/WorldMusic.js';
import {
  boundaryLift01, terminatorContrast, illumination, surfaceTrace,
} from '../src/world/farside/Vacuum.js';

const chorus = { meanEnergy: 0.82, relEnergy01: 0.95, startMs: 60000, endMs: 90000, provenance: 'detected' };
const verse = { meanEnergy: 0.48, relEnergy01: 0.5 };

test('illumination follows sustained energy, not a single kick', () => {
  const low = new EnergyCurves(4000, 50);
  const burst = new EnergyCurves(4000, 50);
  for (let i = 0; i < low.n; i++) {
    low.setFrame(i, [0.7, 0.7, 0.5, 0.4, 0.3, 0, 0]);
    burst.setFrame(i, [i === 100 ? 1 : 0, i === 100 ? 1 : 0, 0, 0, 0, 0, 0]);
  }
  const held = illumination({ energy: sampleWorldMusic({ nowMs: 2000, energyCurves: low }).energy });
  const tap = illumination({ energy: sampleWorldMusic({ nowMs: 2000, energyCurves: burst }).energy });
  assert.ok(held > tap * 1.5, `slow light ${held.toFixed(3)} vs kick ${tap.toFixed(3)}`);
});

test('an earned phrase lift brightens the primary; a decorative cut does not', () => {
  const energy = 0.4;
  const lift = boundaryLift01(chorus, verse);
  const at = (provenance) => sampleWorldMusic({
    nowMs: 62000,
    section: { ...chorus, provenance },
  }).reveal;
  const idle = illumination({ energy });
  const opened = illumination({ energy, reveal: at('detected'), lift });
  const decorative = illumination({ energy, reveal: at('decorative'), lift });
  assert.ok(opened > idle + 0.15, `phrase ${opened.toFixed(3)} vs idle ${idle.toFixed(3)}`);
  assert.equal(decorative, idle);
});

test('sparse songs let an isolated accent mark the surface; dense songs filter it', () => {
  const hit = 0.45;
  const sparse = surfaceTrace(hit, 0.05);
  const dense = surfaceTrace(hit, 0.95);
  assert.ok(sparse > 0.3, `a lone hit on quiet ground should show, got ${sparse.toFixed(3)}`);
  assert.equal(dense, 0, 'the same hit in a dense mix is not a crater field');
  assert.ok(surfaceTrace(0.95, 0.95) > 0.5, 'a strong hit still marks dense ground');
  assert.equal(surfaceTrace(0, 0.05), 0);
});

test('terminator contrast eases as energy rises, and never leaves range', () => {
  const quiet = terminatorContrast(0.05);
  const loud = terminatorContrast(0.9);
  assert.ok(quiet > loud, 'dense material must not harden the limb into a strobe');
  for (const e of [0, 0.5, 1, -1, 4, NaN]) {
    const c = terminatorContrast(e);
    assert.ok(c >= 0 && c <= 1, `contrast ${c}`);
    const i = illumination({ energy: e, reveal: 9, lift: 9 });
    assert.ok(i >= 0 && i <= 1, `illum ${i}`);
    const t = surfaceTrace(e, e);
    assert.ok(t >= 0 && t <= 1, `trace ${t}`);
  }
});

test('illumination depends on where the song is, not how it got there', () => {
  const args = { energy: 0.4, reveal: 0.8, lift: 0.9 };
  const first = illumination(args);
  for (let i = 0; i < 20; i++) illumination({ energy: 1, reveal: 1, lift: 1 });
  assert.equal(illumination(args), first);
});
