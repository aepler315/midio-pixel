import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryLift01, breathSigned, cityGlow, windowGlowAlpha } from '../src/world/city/CityGlow.js';
import { windowOccupancy } from '../src/world/city/CitySilhouette.js';
import { sampleWorldMusic } from '../src/world/WorldMusic.js';

// A plausible song trajectory for After Hours: energy wanders, the orogeny arc
// only grows. This is the shape that made the old mapping flat.
function trajectory() {
  const out = [];
  for (let i = 0; i <= 40; i++) {
    const p = i / 40;
    const energy = Math.max(0, 0.35 + 0.35 * Math.sin(p * Math.PI * 3.1) + 0.2 * p);
    out.push({
      p,
      tSec: p * 200,
      occupancy: windowOccupancy({ energy, orogeny: 0.1 + 0.9 * p, openingGain: 1, fever: 0.1 * p }),
    });
  }
  return out;
}

const chorus = { meanEnergy: 0.82, relEnergy01: 0.95 };
const verse = { meanEnergy: 0.48, relEnergy01: 0.5 };
const bridge = { meanEnergy: 0.22, relEnergy01: 0.1 };

test('an unmarked passage stays well below a bloomed boundary', () => {
  const idle = trajectory().map((s) => cityGlow({ occupancy: s.occupancy, tSec: s.tSec }));
  const idleMax = Math.max(...idle);
  const bloom = cityGlow({
    occupancy: 0.85, tSec: 0, reveal: 1, lift: boundaryLift01(chorus, verse),
  });
  // The old mapping's whole song lived inside a 0.22-wide alpha band, which is
  // why nothing read as an event. The headroom above the idle ceiling is the
  // entire point of the split.
  assert.ok(bloom - idleMax > 0.4, `bloom ${bloom.toFixed(3)} vs idle ceiling ${idleMax.toFixed(3)}`);
  assert.ok(bloom > 0.9, `a full lift into the loudest section should blaze, got ${bloom.toFixed(3)}`);
});

test('the glow falls as well as rises over a song', () => {
  const idle = trajectory().map((s) => cityGlow({ occupancy: s.occupancy, tSec: s.tSec }));
  let falls = 0, rises = 0;
  for (let i = 1; i < idle.length; i++) {
    if (idle[i] < idle[i - 1] - 1e-6) falls++;
    if (idle[i] > idle[i - 1] + 1e-6) rises++;
  }
  assert.ok(falls > 8 && rises > 8, `breathing needs both directions, got ${rises} up / ${falls} down`);
  const alphas = idle.map(windowGlowAlpha);
  assert.ok(Math.min(...alphas) < 0.22, `quiet passages must go genuinely dark, floor ${Math.min(...alphas).toFixed(3)}`);
});

test('only a real step up earns a bloom', () => {
  assert.equal(boundaryLift01(verse, chorus), 0, 'dropping into a quieter section is not a lift');
  assert.equal(boundaryLift01(verse, { meanEnergy: 0.46, relEnergy01: 0.5 }), 0, 'a continuation is not a lift');
  assert.ok(boundaryLift01(chorus, verse) > 0.9, 'the chorus arriving is the whole move');
  assert.equal(boundaryLift01(chorus, null), 0, 'the first section has nothing to lift from');
});

test('a lift into a section that is quiet for this song stays modest', () => {
  const intoQuiet = boundaryLift01({ meanEnergy: 0.5, relEnergy01: 0.05 }, bridge);
  const intoLoud = boundaryLift01({ meanEnergy: 0.5, relEnergy01: 0.95 }, bridge);
  assert.ok(intoQuiet < intoLoud * 0.6, `${intoQuiet.toFixed(3)} should sit well under ${intoLoud.toFixed(3)}`);
  assert.ok(intoQuiet > 0, 'still a lift, just not the chorus');
});

test('decorative pacing cuts get no bloom at all, detected ones get the whole one', () => {
  const at = (provenance) => sampleWorldMusic({
    nowMs: 62000,
    section: { startMs: 60000, endMs: 90000, provenance },
  }).reveal;
  const lift = boundaryLift01(chorus, verse);
  const glowFor = (provenance) => cityGlow({ occupancy: 0.8, tSec: 0, reveal: at(provenance), lift });
  const plain = cityGlow({ occupancy: 0.8, tSec: 0 });
  assert.equal(glowFor('decorative'), plain, 'a pacing cut is not a musical event');
  assert.ok(glowFor('inferred') > plain, 'a novelty peak is worth something');
  assert.ok(glowFor('detected') > glowFor('inferred'), 'a measured boundary is worth more');
});

test('the breath is bounded, moves, and stops under reduced flash', () => {
  const samples = [];
  for (let tSec = 0; tSec < 40; tSec += 0.5) samples.push(breathSigned(tSec));
  assert.ok(Math.max(...samples) > 0.95 && Math.min(...samples) < -0.95, 'a full cycle within a phrase');
  for (const s of samples) assert.ok(s >= -1 && s <= 1);
  assert.equal(breathSigned(7.5, true), 0);
  assert.equal(breathSigned(NaN), 0);
  const held = { occupancy: 0.6, reducedFlash: true };
  assert.equal(cityGlow({ ...held, tSec: 0 }), cityGlow({ ...held, tSec: 17 }),
    'reduced flash gets a steady field, not a drifting one');
});

test('glow depends on where the song is, not how it got there (seeking stays sane)', () => {
  const args = { occupancy: 0.7, tSec: 91.3, reveal: 0.8, lift: 0.9 };
  const first = cityGlow(args);
  for (let i = 0; i < 20; i++) cityGlow({ occupancy: 1, tSec: i * 13, reveal: 1, lift: 1 });
  assert.equal(cityGlow(args), first, 'no frame-to-frame accumulation anywhere in the envelope');
});

test('the composed glow and its blit alpha stay in range for any input', () => {
  for (const occupancy of [0, 0.5, 1, -1, 2, NaN]) {
    for (const reveal of [0, 0.5, 1, 9]) {
      for (const lift of [0, 1, 9]) {
        const g = cityGlow({ occupancy, tSec: 3, reveal, lift });
        assert.ok(g >= 0 && g <= 1, `glow ${g} out of range`);
        const a = windowGlowAlpha(g);
        assert.ok(a >= 0 && a <= 1, `alpha ${a} out of range`);
      }
    }
  }
  assert.equal(cityGlow({}), cityGlow({ occupancy: 0, tSec: 0, reveal: 0, lift: 0 }));
});
