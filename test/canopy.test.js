import test from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { sampleWorldMusic } from '../src/world/WorldMusic.js';
import {
  boundaryLift01, canopyGrowth, shaftOpen, sporeBurst,
} from '../src/world/understory/Canopy.js';

const chorus = { meanEnergy: 0.82, relEnergy01: 0.95, startMs: 60000, endMs: 90000, provenance: 'detected' };
const verse = { meanEnergy: 0.48, relEnergy01: 0.5 };

test('growth follows sustained energy and the arc, not a kick', () => {
  const low = new EnergyCurves(4000, 50);
  const burst = new EnergyCurves(4000, 50);
  for (let i = 0; i < low.n; i++) {
    low.setFrame(i, [0.7, 0.7, 0.6, 0.5, 0.3, 0, 0]);
    burst.setFrame(i, [i === 100 ? 1 : 0, i === 100 ? 1 : 0, 0, 0, 0, 0, 0]);
  }
  const held = canopyGrowth({ energy: sampleWorldMusic({ nowMs: 2000, energyCurves: low }).energy, orogeny: 0.4 });
  const tap = canopyGrowth({ energy: sampleWorldMusic({ nowMs: 2000, energyCurves: burst }).energy, orogeny: 0.4 });
  assert.ok(held > tap, `growth ${held.toFixed(3)} vs kick ${tap.toFixed(3)}`);
  const early = canopyGrowth({ energy: 0.4, orogeny: 0.1 });
  const late = canopyGrowth({ energy: 0.4, orogeny: 0.9 });
  assert.ok(late > early, 'the arc fills the canopy over the song');
});

test('earned phrases open the shafts; decorative cuts do not', () => {
  const growth = canopyGrowth({ energy: 0.4, orogeny: 0.4 });
  const lift = boundaryLift01(chorus, verse);
  const at = (provenance) => sampleWorldMusic({
    nowMs: 62000,
    section: { ...chorus, provenance },
  }).reveal;
  const idle = shaftOpen({ growth });
  const opened = shaftOpen({ growth, reveal: at('detected'), lift });
  const decorative = shaftOpen({ growth, reveal: at('decorative'), lift });
  assert.ok(opened > idle + 0.4, `phrase ${opened.toFixed(3)} vs idle ${idle.toFixed(3)}`);
  assert.equal(decorative, idle);
  assert.ok(idle > 0.05, 'quiet canopy still admits some light');
});

test('one spore colony answers the accent; the others keep ambient', () => {
  const bursts = [0, 1, 2, 3].map((colony) => sporeBurst(0.9, 2, colony));
  assert.equal(bursts.filter((b) => b > 0.5).length, 1);
  assert.equal(bursts.filter((b) => b === 0).length, 3);
  assert.equal(sporeBurst(0.9, 2, 2), 0.9);
});

test('growth does not jump when percussion is dense', () => {
  const curves = new EnergyCurves(4000, 100);
  for (let i = 0; i < curves.n; i++) {
    const hit = i % 15 === 0 ? 1 : 0;
    curves.setFrame(i, [hit, hit, 0.3, 0.3, 0, 0, 0]);
  }
  const a = sampleWorldMusic({ nowMs: 2400, energyCurves: curves, rhythm: { tMs: 2400, vel: 1 } });
  const b = sampleWorldMusic({ nowMs: 2400, energyCurves: curves, rhythm: { tMs: 2000, vel: 0.2 } });
  assert.equal(canopyGrowth({ energy: a.energy, orogeny: 0.3 }), canopyGrowth({ energy: b.energy, orogeny: 0.3 }));
  assert.ok(a.accent > b.accent);
});

test('every output stays in range for junk input', () => {
  for (const v of [0, 0.5, 1, -1, 4, NaN]) {
    const g = canopyGrowth({ energy: v, orogeny: v });
    assert.ok(g >= 0 && g <= 1, `growth ${g}`);
    const s = shaftOpen({ growth: v, reveal: v, lift: v });
    assert.ok(s >= 0 && s <= 1, `shaft ${s}`);
    const sp = sporeBurst(v, 9, -2);
    assert.ok(sp >= 0 && sp <= 1, `spore ${sp}`);
  }
});
