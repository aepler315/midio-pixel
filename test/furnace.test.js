import test from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { sampleWorldMusic } from '../src/world/WorldMusic.js';
import {
  boundaryLift01, furnaceHeat, pourGlow, operationIndex, machineStroke, millActivity,
} from '../src/world/foundry/Furnace.js';

const chorus = { meanEnergy: 0.82, relEnergy01: 0.95, startMs: 60000, endMs: 90000, provenance: 'detected' };
const verse = { meanEnergy: 0.48, relEnergy01: 0.5 };

test('heat follows sustained energy, not a single kick', () => {
  const low = new EnergyCurves(4000, 50);
  const burst = new EnergyCurves(4000, 50);
  for (let i = 0; i < low.n; i++) {
    low.setFrame(i, [0.8, 0.8, 0.6, 0.4, 0, 0, 0]);
    burst.setFrame(i, [i === 100 ? 1 : 0, i === 100 ? 1 : 0, 0, 0, 0, 0, 0]);
  }
  const sustained = furnaceHeat(sampleWorldMusic({ nowMs: 2000, energyCurves: low }).energy);
  const tap = furnaceHeat(sampleWorldMusic({ nowMs: 2000, energyCurves: burst }).energy);
  const idle = furnaceHeat(0.02);
  assert.ok(sustained > tap * 2, `sustained ${sustained.toFixed(3)} vs tap ${tap.toFixed(3)}`);
  assert.ok(sustained > idle * 2, `a working mill should outrun cold iron (${sustained.toFixed(3)} vs ${idle.toFixed(3)})`);
  assert.ok(tap < 0.25, `a single kick is not a pour, got ${tap.toFixed(3)}`);
  assert.ok(idle < 0.12, 'quiet input stays as low embers');
});

test('rapid periodic energy cannot alias into a full-strength pour', () => {
  const curves = new EnergyCurves(4000, 100);
  for (let i = 0; i < curves.n; i++) {
    const hit = i % 15 === 0 ? 1 : 0;
    curves.setFrame(i, [hit, hit, hit, 0, 0, 0, 0]);
  }
  const heats = Array.from({ length: 15 }, (_, i) => (
    furnaceHeat(sampleWorldMusic({ nowMs: 2400 + i * 10, energyCurves: curves }).energy)
  ));
  assert.ok(Math.max(...heats) < 0.3, 'heat follows the average, not aligned bins');
  assert.ok(Math.max(...heats) - Math.min(...heats) < 0.05, 'dense drums retain slow heat');
});

test('only an earned step-up becomes a pour; decorative cuts do not', () => {
  const heat = furnaceHeat(0.55);
  const lift = boundaryLift01(chorus, verse);
  const at = (provenance) => sampleWorldMusic({
    nowMs: 62000,
    section: { ...chorus, provenance },
  }).reveal;
  const poured = pourGlow({ heat, reveal: at('detected'), lift });
  const inferred = pourGlow({ heat, reveal: at('inferred'), lift });
  const decorative = pourGlow({ heat, reveal: at('decorative'), lift });
  const idle = pourGlow({ heat });
  assert.ok(poured > idle + 0.3, `pour ${poured.toFixed(3)} vs idle ${idle.toFixed(3)}`);
  assert.ok(inferred > idle && inferred < poured);
  assert.equal(decorative, idle);
  assert.ok(pourGlow({ heat, reveal: 1, lift: 1, reducedFlash: true }) < poured);
});

test('sections pick a mill; percussion drops one hammer in that mill', () => {
  assert.equal(operationIndex(0), 0);
  assert.equal(operationIndex(5), 1);
  assert.equal(operationIndex(-1), 0);
  const hit = { accent: 0.9, group: 1, operation: 1, machine: 1 };
  const otherHammer = { ...hit, machine: 2, operation: 1 };
  const otherMill = { ...hit, machine: 0, operation: 1 };
  assert.equal(machineStroke(hit), 0.9);
  assert.ok(machineStroke(otherHammer) < 0.15);
  assert.equal(machineStroke(otherMill), 0);
  assert.ok(millActivity(0.6, 1, 1) > millActivity(0.6, 1, 0) * 2,
    'idle mills stay at embers while the current one runs');
});

test('dense percussion does not light every mill', () => {
  const strokes = [0, 1, 2, 3].map((machine) => machineStroke({
    accent: 1, group: 2, operation: 2, machine,
  }));
  const lit = strokes.filter((s) => s > 0.5).length;
  assert.equal(lit, 1, 'only the matching hammer takes the hit');
  assert.equal(strokes.filter((s) => s === 0).length, 3);
});

test('seeking cannot leave a pour hanging, and junk input stays in range', () => {
  const args = { heat: 0.4, reveal: 0.8, lift: 0.9 };
  const first = pourGlow(args);
  for (let i = 0; i < 20; i++) pourGlow({ heat: 1, reveal: 1, lift: 1 });
  assert.equal(pourGlow(args), first);
  for (const energy of [0, 1, -1, 4, NaN]) {
    const h = furnaceHeat(energy);
    assert.ok(h >= 0 && h <= 1, `heat ${h}`);
    const p = pourGlow({ heat: energy, reveal: 9, lift: 9 });
    assert.ok(p >= 0 && p <= 1, `pour ${p}`);
  }
});
