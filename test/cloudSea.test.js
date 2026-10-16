// The Range's cloud sea: the valley fills with cloud in quiet passages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileCloudSea, cloudSeaAt, SEA_OPENING_MS, SEA_RISE_MS, SEA_FALL_MS, SEA_HOLD_MS, SEA_RELEASE_MS, SEA_WINDOW_MS,
} from '../src/world/alpine/CloudSea.js';
import { SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';
import { TREE_COMMON, createForest } from '../src/world/alpine/ForestGL.js';

// A song as song-relative energy over time (ms -> 0..1).
const curves = (fn) => ({ globalEnergyNorm: fn });
// Loud, a 20 s breakdown from 60 s, loud again from 80 s.
const breakdown = (t) => (t >= 60000 && t < 80000 ? 0.15 : 0.7);

test('a song with no quiet passages never fills the valley', () => {
  for (const level of [0.7, 0.1]) {
    const r = compileCloudSea({ energyCurves: curves(() => level), durationMs: 120000 });
    for (let t = 0; t <= 120000; t += 500) assert.equal(r.at(t), 0);
  }
  // A beat on every half second is not a breakdown either.
  const beat = compileCloudSea({ energyCurves: curves((t) => (t % 500 < 100 ? 0.95 : 0.3)), durationMs: 120000 });
  for (let t = 0; t <= 120000; t += 500) assert.equal(beat.at(t), 0);
});

test('a breakdown fills the valley gradually, and the song lifting drains it slowly', () => {
  const r = compileCloudSea({ energyCurves: curves(breakdown), durationMs: 120000 });
  assert.equal(r.at(59000), 0, 'nothing before the breakdown');
  assert.equal(r.at(60000 + SEA_HOLD_MS), 0, 'the first seconds of quiet are not yet a breakdown');
  // It wells up over many seconds: no step from one second to the next.
  for (let t = 60000; t < 80000; t += 1000) {
    assert.ok(r.at(t + 1000) - r.at(t) < 0.15, `rise ${t}..${t + 1000}: ${r.at(t).toFixed(3)} -> ${r.at(t + 1000).toFixed(3)}`);
  }
  assert.ok(r.at(60000 + SEA_HOLD_MS + SEA_WINDOW_MS + SEA_RISE_MS) > 0.99, 'fully up once the quiet holds');
  assert.ok(r.at(80000 + SEA_RELEASE_MS) > 0.9, 'the first loud seconds do not tear it open');
  for (let t = 80000; t < 100000; t += 1000) {
    assert.ok(r.at(t) - r.at(t + 1000) < 0.2, `drain ${t}..${t + 1000}: ${r.at(t).toFixed(3)} -> ${r.at(t + 1000).toFixed(3)}`);
  }
  assert.ok(r.at(80000 + SEA_RELEASE_MS + SEA_FALL_MS / 2) > 0.2, 'still draining halfway through the fall');
  assert.equal(r.at(80000 + SEA_WINDOW_MS + SEA_RELEASE_MS + SEA_FALL_MS), 0);
});

test('a single hit inside a breakdown leaves the cloud whole', () => {
  const r = compileCloudSea({ energyCurves: curves((t) => (t >= 60000 && t < 100000 && !(t >= 80000 && t < 82000) ? 0.15 : 0.7)), durationMs: 140000 });
  for (let t = 80000; t <= 96000; t += 500) assert.ok(r.at(t) > 0.99, `${t}: ${r.at(t)}`);
});

test('a short lull, or soft and loud sections in quick turns, do not pump the cloud in and out', () => {
  // A 10 s dip in a steady song is a lull, not a breakdown.
  const lull = compileCloudSea({ energyCurves: curves((t) => (t >= 100000 && t < 110000 ? 0.1 : 0.8)), durationMs: 240000 });
  for (let t = 0; t <= 240000; t += 500) assert.equal(lull.at(t), 0);
  // 15 s soft / 15 s loud: the valley fills at most every other turn, and
  // never starts a rise it cannot carry (no small flickers).
  const alt = compileCloudSea({ energyCurves: curves((t) => (Math.floor(t / 15000) % 2 ? 0.7 : 0.15)), durationMs: 180000 });
  let rises = 0, peak = 0, up = false;
  for (let t = 0; t <= 180000; t += 100) {
    const v = alt.at(t);
    if (!up && v > 0) { up = true; rises++; peak = 0; }
    peak = Math.max(peak, v);
    if (up && v === 0) { assert.ok(peak > 0.4, `a rise that only reached ${peak.toFixed(2)}`); up = false; }
  }
  assert.ok(rises >= 2 && rises <= 3, `${rises} fills in three minutes`);
});

test('a longer breakdown in an otherwise steady song still fills the valley', () => {
  // 20 s at 0.1 inside 240 s at 0.8: p10 sits on the loud level.
  const r = compileCloudSea({ energyCurves: curves((t) => (t >= 100000 && t < 120000 ? 0.1 : 0.8)), durationMs: 240000 });
  assert.equal(r.at(90000), 0);
  assert.ok(r.at(119000) > 0.9, `up by the end of the dip (${r.at(119000)})`);
  assert.equal(r.at(150000), 0);
});

test('the opening belongs to the arrival, not the cloud', () => {
  // A soft intro, then the song proper.
  const r = compileCloudSea({ energyCurves: curves((t) => (t < 30000 ? 0.1 : 0.7)), durationMs: 120000 });
  assert.equal(r.at(SEA_OPENING_MS - 100), 0);
  assert.ok(r.at(SEA_OPENING_MS + SEA_RISE_MS + 500) > 0.99);
});

test('the cloud sea is a pure function of heard time (seek either way)', () => {
  const r = compileCloudSea({ energyCurves: curves(breakdown), durationMs: 120000 });
  const forward = [70000, 82000, 65000, 70000].map((t) => r.at(t));
  assert.equal(forward[0], forward[3]);
  for (const v of forward) assert.ok(v >= 0 && v <= 1);
});

test('without an energy curve, or with an override, the cloud sea is well defined', () => {
  assert.equal(compileCloudSea({}).at(5000), 0);
  assert.equal(cloudSeaAt({ energyCurves: null }, 5000), 0);
  assert.equal(cloudSeaAt({ cloudSeaOverride: 0.4 }, 5000), 0.4);
  assert.equal(cloudSeaAt({ terrainPreview: true, energyCurves: curves(() => 0.1), durationMs: 60000 }, 30000), 0);
});

test('terrain and forest share the cloud sea through the mist, and no map is left', () => {
  for (const src of [SCENE_FRAG, TREE_COMMON]) assert.doesNotMatch(src, /topo/i);
  assert.match(SCENE_FRAG, /mistColorAt\(uCameraPos, vRenderedWorld\)/);
  // Under the cloud the lake's mirror and glints are hidden with it.
  assert.match(SCENE_FRAG, /float clear = 1\.0 - mist \* uMistFill;/);
  assert.equal(typeof createForest, 'function');
});
