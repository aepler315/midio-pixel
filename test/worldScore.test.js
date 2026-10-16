import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { extractWatchFeatures, scoreWorlds, buildCustomWorld, buildWorldVariant, TIE_EPS, pickRecommended, formatFitDiagnostic, driveAfterResponse } from '../src/world/WorldScore.js';
import { getWorld, listWorlds, setCustomWorld, clearCustomWorld, DEFAULT_WORLD_ID } from '../src/world/Worlds.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildingProfile, cityHeightField, windowOccupancy } from '../src/world/city/CitySilhouette.js';
import { extractRidgePortrait } from '../src/world/RidgePortrait.js';
import { castBiomes } from '../src/world/Dramaturgy.js';
import { CITY_TEMPERATURE } from '../src/world/city/CityPalettes.js';
import { clamp01, spread01 } from '../src/utils/math.js';

function makeCurves({ durationMs = 120000, rateHz = 50, energyAt, bandsAt } = {}) {
  const ec = new EnergyCurves(durationMs, rateHz);
  for (let i = 0; i < ec.n; i++) {
    const t01 = ec.n > 1 ? i / (ec.n - 1) : 0;
    const e = energyAt ? energyAt(t01) : 0.4;
    const shares = bandsAt ? bandsAt(t01) : [1, 1, 1, 1, 1, 1, 1];
    let sum = 0;
    for (const s of shares) sum += s;
    const frame = shares.map((s) => Math.max(0, e * s / (sum || 1)));
    ec.setFrame(i, frame);
  }
  return { ec, durationMs };
}

const bump = (t, at, w, h) => h * Math.exp(-(((t - at) / w) ** 2) * 4);

function metal() {
  return makeCurves({
    energyAt: (t) => 0.08 + bump(t, 0.22, 0.07, 0.82) + bump(t, 0.48, 0.06, 0.9) + bump(t, 0.75, 0.08, 0.85),
    bandsAt: () => [0.35, 0.55, 0.9, 1.25, 1.45, 1.35, 1.2],
  });
}

function lofi() {
  return makeCurves({
    energyAt: (t) => 0.28 + bump(t, 0.35, 0.18, 0.22) + bump(t, 0.7, 0.16, 0.18),
    bandsAt: () => [1.4, 1.3, 0.8, 0.55, 0.28, 0.16, 0.08],
  });
}

test('world registry: alpine default, nocturne present, unknown falls back', () => {
  assert.equal(DEFAULT_WORLD_ID, 'alpine');
  assert.equal(getWorld('nocturne').kind, 'city');
  assert.equal(getWorld('nope').id, 'alpine');
  assert.ok(listWorlds().length >= 2);
});

test('castBiomes accepts a city temperature map', () => {
  const names = castBiomes([0.1, 0.9], 7, CITY_TEMPERATURE);
  assert.equal(names.length, 2);
  assert.ok(names.every((n) => CITY_TEMPERATURE[n] != null));
  assert.notEqual(names[0], names[1]);
});

test('a wall-of-sound mix prefers The Range; a warm mid-tempo mix prefers After Hours', () => {
  const loud = metal();
  const quiet = lofi();
  const loudF = extractWatchFeatures({ energyCurves: loud.ec, durationMs: loud.durationMs, bpm: 160 });
  const quietF = extractWatchFeatures({ energyCurves: quiet.ec, durationMs: quiet.durationMs, bpm: 86 });
  const loudR = scoreWorlds(loudF);
  const quietR = scoreWorlds(quietF);
  const pick = (ranked, id) => ranked.find((r) => r.id === id).score;
  assert.ok(pick(loudR, 'alpine') > pick(loudR, 'nocturne'),
    `metal alpine ${pick(loudR, 'alpine')} vs city ${pick(loudR, 'nocturne')}`);
  assert.ok(pick(quietR, 'nocturne') > pick(quietR, 'alpine'),
    `lofi city ${pick(quietR, 'nocturne')} vs alpine ${pick(quietR, 'alpine')}`);
  assert.ok(loudR[0].recommended);
  assert.ok(loudR.every((r) => r.score >= 1 && r.score <= 99));
});

test('a confident rhythm profile supplies onset density and pulse to world scoring', () => {
  const source = { durationMs: 60000, bpm: 96 };
  const withoutRhythm = extractWatchFeatures(source);
  const withRhythm = extractWatchFeatures({
    ...source,
    analysis: {
      rhythm: {
        eventDensity: 0.8,
        pulseRegularity: 0.9,
        confidence: 0.95,
      },
    },
  });

  assert.equal(withRhythm.onset, 0.8);
  assert.equal(withRhythm.pulse, 0.9);
  assert.ok(withRhythm.groove > withoutRhythm.groove,
    `expected beat-aligned rhythm to improve groove: ${withRhythm.groove} <= ${withoutRhythm.groove}`);
});

test('buildingProfile is rectangular with setbacks, not a mountain cone', () => {
  assert.equal(buildingProfile(0), 1);
  assert.equal(buildingProfile(0.4), 1);
  assert.ok(buildingProfile(0.7) < 1 && buildingProfile(0.7) > 0.7);
  assert.equal(buildingProfile(1), 0);
  // A cone would be ~0.5 at d=0.5; a building is still full height.
  assert.equal(buildingProfile(0.5), 1);
});

test('cityHeightField stays in 0..1, has flat-topped mass, and is deterministic', () => {
  const { ec, durationMs } = lofi();
  const portrait = extractRidgePortrait(ec, durationMs);
  const n = 256, step = 8, width = n * step;
  const a = cityHeightField(n, step, 42, width, portrait, 'L2');
  const b = cityHeightField(n, step, 42, width, portrait, 'L2');
  for (let i = 0; i < n; i++) {
    assert.equal(a[i], b[i]);
    assert.ok(a[i] >= 0 && a[i] <= 1);
  }
  // Flat roofs: a run of nearly-equal samples should exist (a building top).
  let longest = 1, run = 1;
  for (let i = 1; i < n; i++) {
    run = Math.abs(a[i] - a[i - 1]) < 0.02 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  assert.ok(longest >= 4, `expected a flat roof run, got ${longest}`);
});

test('generateSilhouette city profile returns a window strip', async () => {
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') return;
  const { generateSilhouette } = await import('../src/world/SilhouetteGenerator.js');
  const strip = generateSilhouette({
    seed: 9, width: 512, height: 160, color: '#101018', profile: 'city', step: 4,
  });
  assert.ok(strip.windows);
  assert.equal(strip.ridge.profile, 'city');
});

test('every registered world is listed and has the required fields', () => {
  const worlds = listWorlds();
  // Exact, not >=: the count is the guard that catches a world silently
  // dropping out of the registry. Bump it deliberately when adding one.
  assert.deepEqual(worlds.map(w => w.id), ['alpine', 'nocturne', 'farside', 'fathom', 'redline', 'foundry', 'understory', 'nave']);
  for (const w of worlds) {
    assert.ok(w.id, `missing id`);
    assert.ok(w.name, `${w.id} missing name`);
    assert.ok(w.kind, `${w.id} missing kind`);
    assert.ok(w.comfort && typeof w.comfort.lo === 'number', `${w.id} missing comfort`);
    assert.ok(w.channels?.length >= 4, `${w.id} channels too few`);
    assert.ok(w.affinity && Object.keys(w.affinity).length >= 2, `${w.id} missing affinity`);
    assert.ok(w.palettes?.length >= 3, `${w.id} missing palettes`);
    assert.ok(typeof w.cast === 'function', `${w.id} missing cast`);
  }
});

test('farside wins for sparse, bright, cold songs', () => {
  const { ec, durationMs } = makeCurves({
    energyAt: () => 0.12,
    bandsAt: () => [0.1, 0.2, 0.4, 0.8, 1.3, 1.5, 1.4],
  });
  const feat = extractWatchFeatures({ energyCurves: ec, durationMs, bpm: 72 });
  const ranked = scoreWorlds(feat);
  const farside = ranked.find((r) => r.id === 'farside');
  assert.ok(farside, 'farside should be in rankings');
  assert.ok(farside.score >= 50, `farside score ${farside.score} too low for sparse bright song`);
});

test('redline scores well for a fast, driving, groovy song', () => {
  const { ec, durationMs } = makeCurves({
    energyAt: (t) => 0.5 + 0.4 * Math.sin(t * Math.PI),
    bandsAt: () => [0.6, 0.8, 1.2, 1.4, 1.3, 1.0, 0.7],
  });
  const feat = extractWatchFeatures({ energyCurves: ec, durationMs, bpm: 155 });
  const ranked = scoreWorlds(feat);
  const redline = ranked.find((r) => r.id === 'redline');
  assert.ok(redline.score >= 55, `redline score ${redline.score} too low for fast song`);
});

// ── Per-world win/lose coverage ────────────────────────────────────
//
// scoreWorlds/comfortScore squashed toward the middle badly enough that a
// world could sit in the registry and still lose every pickup, even one
// tuned to its own book. These feed a full, hand-authored feature vector
// straight to scoreWorlds (bypassing extractWatchFeatures/EnergyCurves —
// those are already exercised above) so each case targets exactly the
// "wins on" / "loses on" columns from docs/worlds.md §2, independent of
// whatever the audio-analysis pipeline happens to produce for a given
// synthetic curve.
function baseFeat(overrides = {}) {
  return {
    centroid: 0.5, bass: 0.35, air: 0.2, spread: 0.5, dyn: 0.4, energyMean: 0.4,
    phrase: 0.35, landmarks: 5, onset: 0.35, contrast: 0.4, groove: 0.45, warmth: 0.4,
    texture: 0.35, form: 0.4, arc: 0.4, drive: 0.5, bpm: 110, tempoHeat: 0.4, trend: 0,
    ...overrides,
  };
}

function topId(feat) { return scoreWorlds(feat)[0].id; }
function rankOf(feat, id) { return scoreWorlds(feat).findIndex((r) => r.id === id); }

const WORLD_CASES = {
  alpine: {
    win: baseFeat({ arc: 0.72, dyn: 0.65, form: 0.65, contrast: 0.58, texture: 0.4, air: 0.35, onset: 0.4, tempoHeat: 0.45, drive: 0.59 }),
    lose: baseFeat({ arc: 0.08, dyn: 0.1, onset: 0.05, contrast: 0.1, energyMean: 0.1, tempoHeat: 0.05, drive: 0.08, bass: 0.1 }),
  },
  nocturne: {
    win: baseFeat({ warmth: 0.62, groove: 0.6, phrase: 0.55, tempoHeat: 0.42, drive: 0.42, centroid: 0.45, onset: 0.3 }),
    lose: baseFeat({ air: 0.85, centroid: 0.85, warmth: 0.05, bass: 0.05, drive: 0.1, onset: 0.05 }),
  },
  farside: {
    win: baseFeat({ air: 0.85, centroid: 0.8, warmth: 0.05, onset: 0.06, spread: 0.75, bass: 0.05, drive: 0.1 }),
    lose: baseFeat({ groove: 0.85, bass: 0.8, onset: 0.75, drive: 0.75, tempoHeat: 0.8, warmth: 0.75 }),
  },
  fathom: {
    win: baseFeat({ bass: 0.75, warmth: 0.78, phrase: 0.68, onset: 0.08, centroid: 0.15, contrast: 0.2, drive: 0.15 }),
    lose: baseFeat({ onset: 0.85, centroid: 0.85, contrast: 0.8, drive: 0.72, warmth: 0.1 }),
  },
  redline: {
    win: baseFeat({ tempoHeat: 0.85, groove: 0.75, onset: 0.65, centroid: 0.65, drive: 0.72, arc: 0.55 }),
    lose: baseFeat({ tempoHeat: 0.05, groove: 0.1, onset: 0.05, drive: 0.08, arc: 0.1 }),
  },
  foundry: {
    win: baseFeat({ onset: 0.78, energyMean: 0.78, dyn: 0.65, tempoHeat: 0.7, warmth: 0.62, bass: 0.6, drive: 0.85 }),
    lose: baseFeat({ onset: 0.05, energyMean: 0.08, dyn: 0.08, tempoHeat: 0.1, drive: 0.08 }),
  },
  understory: {
    win: baseFeat({ texture: 0.75, spread: 0.72, contrast: 0.18, air: 0.5, onset: 0.25, centroid: 0.5, drive: 0.32 }),
    lose: baseFeat({ contrast: 0.85, onset: 0.8, texture: 0.1, spread: 0.15, drive: 0.75 }),
  },
  nave: {
    win: baseFeat({ contrast: 0.72, form: 0.68, phrase: 0.7, bass: 0.5, arc: 0.5, centroid: 0.5, drive: 0.5 }),
    lose: baseFeat({ form: 0.05, phrase: 0.05, contrast: 0.1, drive: 0.5, landmarks: 1 }),
  },
};

for (const [id, cases] of Object.entries(WORLD_CASES)) {
  test(`${id} wins (or is a clear top pick) on its own intended song shape`, () => {
    const ranked = scoreWorlds(cases.win);
    const idx = rankOf(cases.win, id);
    const top = ranked[0];
    assert.ok(idx <= 1, `${id} ranked #${idx + 1} (${top.id} won) on its own dead-center song: ${ranked.map((r) => `${r.id}:${r.score}`).join(' ')}`);
    const mine = ranked.find((r) => r.id === id);
    assert.ok(mine.score >= 60, `${id} scored only ${mine.score} on its own intended song shape`);
  });

  test(`${id} loses (drops well down the ranking) on its stated weakness`, () => {
    const ranked = scoreWorlds(cases.lose);
    const idx = rankOf(cases.lose, id);
    assert.ok(idx >= 3, `${id} ranked #${idx + 1} on a song matching its stated weakness — should sit well off the top: ${ranked.map((r) => `${r.id}:${r.score}`).join(' ')}`);
  });
}

test('understory wins for textured, spread, low-contrast songs', () => {
  const { ec, durationMs } = makeCurves({
    energyAt: () => 0.32,
    bandsAt: () => [0.8, 0.9, 1.0, 1.1, 1.1, 1.0, 0.9],
  });
  const feat = extractWatchFeatures({ energyCurves: ec, durationMs, bpm: 96 });
  const ranked = scoreWorlds(feat);
  const understory = ranked.find((r) => r.id === 'understory');
  assert.ok(understory, 'understory should be in rankings');
  assert.ok(understory.score >= 50, `understory score ${understory.score} too low for textured song`);
});

test('drive is actually spread01-corrected in the real pipeline, not just in isolation', () => {
  // extractWatchFeatures' `drive` is a 5-term weighted sum of arc/onset/
  // contrast/energyMean/tempoHeat, which collapses toward 0.5 by the
  // central limit theorem far more than the world comfort bands (authored
  // assuming rough 0..1 coverage) expect -- see spread01's own comment and
  // the dedicated reachability proof in test/spread01.test.js. That proof
  // is against the formula in isolation; this confirms the real production
  // code path actually applies it, by reconstructing the pre-spread raw
  // value from extractWatchFeatures' own returned sub-features and checking
  // `drive` is the spread01 of that, not the raw sum itself, across a real
  // spread of song shapes (so this doesn't just pin one lucky sample).
  const songs = [
    metal(), lofi(),
    makeCurves({ energyAt: (t) => 0.15 + bump(t, 0.5, 0.2, 0.4), bandsAt: () => [0.6, 0.7, 0.8, 0.9, 0.8, 0.7, 0.6] }),
    makeCurves({ energyAt: (t) => 0.05 + bump(t, 0.3, 0.08, 0.15), bandsAt: () => [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3] }),
  ];
  const bpms = [140, 72, 128, 90];
  let sawRealDivergence = false;
  songs.forEach(({ ec, durationMs }, i) => {
    const feat = extractWatchFeatures({ energyCurves: ec, durationMs, bpm: bpms[i] });
    const raw = clamp01(0.28 * feat.arc + 0.18 * feat.onset + 0.16 * feat.contrast + 0.14 * feat.energyMean + 0.24 * feat.tempoHeat);
    const expected = spread01(raw);
    assert.ok(Math.abs(feat.drive - expected) < 1e-9,
      `drive (${feat.drive}) should equal spread01 of its own raw sub-features (${expected}), raw=${raw}`);
    if (Math.abs(feat.drive - raw) > 0.01) sawRealDivergence = true;
  });
  assert.ok(sawRealDivergence, 'spread01 should visibly move drive away from the raw sum for at least one real song shape');
});

test('comfort bands partition drive space — no world covers full range', () => {
  const worlds = listWorlds();
  for (const w of worlds) {
    const span = w.comfort.hi - w.comfort.lo;
    assert.ok(span < 0.7, `${w.id} comfort range ${span} too wide`);
    assert.ok(span > 0.15, `${w.id} comfort range ${span} too narrow`);
  }
});

test('window occupancy sits down on a quiet open and up on a fevered drop', () => {
  const quiet = windowOccupancy({ energy: 0.1, openingGain: 0.4, orogeny: 0.1, fever: 0 });
  const drop = windowOccupancy({ energy: 0.85, openingGain: 1, orogeny: 0.8, fever: 0.6 });
  assert.ok(drop > quiet * 1.5, `drop ${drop} vs quiet ${quiet}`);
  assert.ok(quiet > 0.05 && drop < 1);
});

// buildCustomWorld used to wrap DNA + palette synthesis + terrain shaping
// in ONE shared try/catch: any failure, even one confined to palette color
// synthesis, silently discarded terrainMods/characterScheme too, even
// though deriveTerrainParams/pickCharacterScheme never depend on palette
// synthesis having succeeded. A song could quietly lose its entire
// generated identity (both color AND terrain shape) over a failure in only
// one of the two -- and the error was recorded in proof.dna.error, which
// nothing ever read or logged, so the failure was invisible even to
// someone looking for it.
test('a palette-synthesis-only failure still leaves terrain shaping intact, and is now logged', () => {
  // A "label" that throws when coerced to a string -- hashOfLabel in
  // PaletteSynth.js does exactly that (String(label)) but ShapeGrammar.js's
  // buildShapeGrammar/deriveTerrainParams/pickCharacterScheme never touch
  // sectionLabels at all, so this reaches ONLY the palette path.
  const poison = {
    [Symbol.toPrimitive]() { throw new Error('poisoned label'); },
    toString() { throw new Error('poisoned label'); },
  };
  const feat = {
    centroid: 0.5, bass: 0.4, air: 0.3, spread: 0.5, dyn: 0.5, energyMean: 0.5,
    phrase: 0.4, landmarks: 5, onset: 0.4, contrast: 0.4, groove: 0.5, warmth: 0.5,
    texture: 0.4, form: 0.5, arc: 0.5, drive: 0.5, bpm: 120, tempoHeat: 0.5, trend: 0,
  };
  const data = { durationMs: 180000, bpm: 120, structure: { labels: [poison, 'B', poison, 'B'] } };

  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  let result;
  try {
    // Far Side: The Range's real biomes are never synthesized.
    result = buildWorldVariant('farside', feat, data);
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(result.proof.dna?.error, 'the failure should still be recorded');
  assert.ok(result.world.terrainMods, 'terrain shaping must survive a palette-only failure');
  assert.ok(result.world.characterScheme, 'character scheme must survive a palette-only failure');
  assert.ok(warnCalls.length > 0, 'the captured error must actually be logged, not just recorded and ignored');
  assert.ok(warnCalls.some((args) => String(args[0]).includes('palette')),
    'the warning should identify which stage failed');
});

test('an adapted world keeps the base identity instead of constructing a 100 score', () => {
  const songs = [
    { label: 'ambient', energyAt: () => 0.12, bands: () => [1.4, 1.0, 0.6, 0.3, 0.1, 0.05, 0.02], bpm: 68 },
    { label: 'metal', energyAt: (t) => 0.08 + bump(t, 0.5, 0.1, 0.85), bands: () => [0.3, 0.5, 0.9, 1.3, 1.5, 1.3, 1.1], bpm: 175 },
    { label: 'groove', energyAt: () => 0.45, bands: () => [0.9, 1.1, 1.2, 1.0, 0.8, 0.5, 0.3], bpm: 96 },
    { label: 'sparse', energyAt: () => 0.08, bands: () => [0.1, 0.1, 0.3, 0.6, 1.2, 1.5, 1.6], bpm: 60 },
  ];

  for (const song of songs) {
    const { ec, durationMs } = makeCurves({
      energyAt: song.energyAt,
      bandsAt: song.bands,
    });
    const feat = extractWatchFeatures({ energyCurves: ec, durationMs, bpm: song.bpm });
    const { world, proof } = buildCustomWorld(feat);

    assert.notEqual(proof.score, 100, `${song.label}: adapted worlds must not construct a perfect score`);
    assert.ok(proof.score >= 1 && proof.score <= 99, `${song.label}: score ${proof.score} out of range`);
    assert.ok(world.kind, `${song.label}: missing kind`);
    assert.ok(world.palettes?.length >= 3, `${song.label}: missing palettes`);
    assert.ok(typeof world.cast === 'function', `${song.label}: missing cast`);
    assert.ok(world.registeredId);
    assert.ok(world.instanceId);
    assert.notEqual(world.instanceId, world.registeredId);

    setCustomWorld(world);
    assert.equal(getWorld(world.id).kind, world.kind);
    clearCustomWorld();
    assert.notEqual(getWorld('custom').id, 'custom');
  }
});

test('custom world inherits best base world kind', () => {
  // A loud, fast song should inherit a high-energy base world.
  const { ec, durationMs } = makeCurves({
    energyAt: (t) => 0.5 + 0.4 * Math.sin(t * Math.PI),
    bandsAt: () => [0.6, 0.8, 1.2, 1.4, 1.3, 1.0, 0.7],
  });
  const feat = extractWatchFeatures({ energyCurves: ec, durationMs, bpm: 155 });
  const ranked = scoreWorlds(feat);
  const { world } = buildCustomWorld(feat);
  assert.equal(world.baseId, ranked[0].id,
    `custom base ${world.baseId} !== top ranked ${ranked[0].id}`);
  assert.equal(world.kind, ranked[0].kind);
});

test('buildWorldVariant preserves the selected world while tailoring it to the song', () => {
  const feat = baseFeat({
    onset: 0.7, energyMean: 0.7, dyn: 0.6, tempoHeat: 0.65, drive: 0.7,
  });
  const { world, proof } = buildWorldVariant('nocturne', feat);

  assert.equal(world.id, 'custom');
  assert.equal(world.baseId, 'nocturne');
  assert.equal(world.registeredId, 'nocturne');
  assert.equal(world.kind, 'city');
  assert.equal(world.name, 'After Hours');
  assert.notEqual(proof.score, 100);
  assert.ok(world.response);
  assert.equal(world.capabilities.geometry.includes('skyline'), true);
  assert.equal(world.capabilities.geometry.includes('ridge'), false);
});

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every scored channel cites a real renderer consumer', () => {
  const missing = [];
  for (const w of listWorlds()) {
    for (const ch of w.channels || []) {
      if (!ch.consumer) {
        missing.push(`${w.id}.${ch.id} has no consumer`);
        continue;
      }
      const [file, sym] = ch.consumer.split('#');
      const path = join(REPO_ROOT, file);
      if (!existsSync(path)) {
        missing.push(`${w.id}.${ch.id} missing file ${file}`);
        continue;
      }
      if (sym) {
        const src = readFileSync(path, 'utf8');
        if (!src.includes(sym)) missing.push(`${w.id}.${ch.id} missing ${sym} in ${file}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('ranking uses continuous fit, not the rounded display score', () => {
  const loud = metal();
  const feat = extractWatchFeatures({ energyCurves: loud.ec, durationMs: loud.durationMs, bpm: 160 });
  const ranked = scoreWorlds(feat);
  for (let i = 1; i < ranked.length; i++) {
    if (ranked[i - 1].eligible === ranked[i].eligible) {
      assert.ok(ranked[i - 1].fit >= ranked[i].fit - 1e-12,
        `fit out of order at ${i}: ${ranked[i - 1].id}=${ranked[i - 1].fit} then ${ranked[i].id}=${ranked[i].fit}`);
    }
  }
  for (const row of ranked) {
    assert.equal(row.score, Math.max(1, Math.min(99, Math.round(40 + 58 * row.fit))));
  }

  const low = {
    id: 'low', name: 'Aaa', kind: 'alpine',
    comfort: { lo: 0.40, hi: 0.60 },
    channels: [{ id: 'x', reads: 'arc', weight: 1 }],
    prefer: { arc: [0.10, 0.20] },
    affinity: { groove: 1 },
  };
  const high = {
    id: 'high', name: 'Zed', kind: 'alpine',
    comfort: { lo: 0.30, hi: 0.80 },
    channels: [{ id: 'x', reads: 'onset', weight: 1 }],
    prefer: { onset: [0.30, 0.40] },
    affinity: { onset: 1 },
  };
  const pair = scoreWorlds(baseFeat({ drive: 0.50, onset: 0.35, arc: 0.42, groove: 0.20 }), [low, high]);
  assert.ok(pair[0].fit >= pair[1].fit);
  if (pair[0].score === pair[1].score && pair[0].fit !== pair[1].fit) {
    const byScoreThenName = [...pair].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    assert.equal(byScoreThenName[0].name, 'Aaa');
    assert.notEqual(pair[0].id, byScoreThenName[0].id);
  }
});

test('near ties stay tied; Choose-for-me still returns one pick', () => {
  const feat = baseFeat({ drive: 0.5, onset: 0.4, arc: 0.5, groove: 0.5 });
  const clone = (id, name) => ({
    id, name, kind: 'alpine',
    comfort: { lo: 0.3, hi: 0.8 },
    channels: [{ id: 'x', reads: 'arc', weight: 1 }],
    prefer: { arc: [0.4, 0.6] },
    affinity: { arc: 1 },
  });
  const ranked = scoreWorlds(feat, [clone('one', 'One'), clone('two', 'Two')]);
  assert.ok(Math.abs(ranked[0].fit - ranked[1].fit) <= TIE_EPS);
  assert.equal(ranked[0].tied, true);
  assert.equal(ranked[1].tied, true);
  assert.equal(ranked.filter((r) => r.recommended).length, 1);
  assert.equal(ranked[0].pickReason, 'near-tie');
  const pick = pickRecommended(ranked);
  assert.ok(pick.recommended);
  assert.equal(pick.id, ranked[0].id);
});

test('a unique winner exposes split diagnostic fields', () => {
  const loud = metal();
  const feat = extractWatchFeatures({ energyCurves: loud.ec, durationMs: loud.durationMs, bpm: 160 });
  const ranked = scoreWorlds(feat);
  const pick = pickRecommended(ranked);
  const next = ranked.find((r) => r.id !== pick.id);
  if (Math.abs(pick.fit - next.fit) > TIE_EPS) {
    assert.equal(pick.pickReason, 'unique');
    assert.equal(ranked.filter((r) => r.tied).length, 1);
  }
  assert.ok(pick.parts.styleAffinity != null);
  assert.ok(Array.isArray(pick.parts.problems));
  assert.ok('driveUsed' in pick.parts);
  assert.ok(pick.parts.responseBand);
});

test('dense response does not invert metal: The Range still beats After Hours', () => {
  const loud = metal();
  const feat = extractWatchFeatures({ energyCurves: loud.ec, durationMs: loud.durationMs, bpm: 160 });
  const ranked = scoreWorlds(feat);
  const alpine = ranked.find((r) => r.id === 'alpine');
  const city = ranked.find((r) => r.id === 'nocturne');
  assert.ok(alpine.fit > city.fit, `metal alpine fit ${alpine.fit} vs city ${city.fit}`);
  assert.ok(alpine.parts.driveUsed <= alpine.parts.drive + 1e-9, 'dense absorb must not lift drive');
  assert.ok(city.parts.driveUsed <= city.parts.drive + 1e-9, 'dense absorb must not lift drive');
  const cityHi = getWorld('nocturne').comfort.hi;
  if (city.parts.drive > cityHi) {
    assert.ok(city.parts.driveUsed > cityHi, 'city is not teleported into its comfort band');
  }
});

test('quiet input is never lifted to manufacture activity', () => {
  const feat = baseFeat({ energyMean: 0.08, dyn: 0.10, onset: 0.05, drive: 0.10, arc: 0.08 });
  const ranked = scoreWorlds(feat);
  for (const r of ranked) {
    assert.equal(r.parts.driveUsed, r.parts.drive);
  }
  const foundry = ranked.find((r) => r.id === 'foundry');
  assert.ok(foundry.parts.problems.some((p) => p.code === 'stillness'));
});

test('diagnostics separate style affinity, analysis confidence, and predicted problems', () => {
  const feat = baseFeat({ onset: 0.8, drive: 0.7 });
  const ranked = scoreWorlds(feat, undefined, { confidence: 0.12 });
  const pick = pickRecommended(ranked);
  assert.equal(pick.parts.analysisConfidence, 0.12);
  assert.equal(pick.parts.styleAffinity, pick.parts.affinity);
  assert.ok(pick.parts.problems.some((p) => p.code === 'low-confidence'));
  const lines = formatFitDiagnostic(ranked, { confidence: 0.12 });
  assert.ok(lines[0].includes('heuristic, not quality'));
  assert.ok(lines.some((l) => l.startsWith('pick:')));
  assert.ok(lines.some((l) => l.includes('analysis confidence')));
  assert.ok(lines.some((l) => l.startsWith('style affinity:')));
  assert.ok(lines.some((l) => l.startsWith('problems:')));
});

test('manual-only worlds and explicit exclusions stay out of Choose-for-me', () => {
  const feat = baseFeat();
  const withManualOnly = scoreWorlds(feat, [...listWorlds(), { ...getWorld('alpine'), id: 'manual-fixture', manualOnly: true }]);
  const manualOnly = withManualOnly.find((r) => r.id === 'manual-fixture');
  assert.equal(manualOnly.eligible, false);
  assert.ok(manualOnly.parts.problems.some((p) => p.code === 'manual-only'));
  assert.notEqual(pickRecommended(withManualOnly).id, 'manual-fixture');

  const excluded = scoreWorlds(feat, undefined, { exclude: ['alpine'] });
  assert.equal(excluded.find((r) => r.id === 'alpine').eligible, false);
  assert.notEqual(pickRecommended(excluded).id, 'alpine');
});

test('driveAfterResponse absorbs dense overshoot toward the comfort ceiling', () => {
  const world = { comfort: { lo: 0.2, hi: 0.6 } };
  const feat = { drive: 0.9 };
  const dense = { band: 'dense', accentGain: 0.42, quiet: false };
  const used = driveAfterResponse(feat, world, dense);
  assert.ok(used < feat.drive);
  assert.ok(used > world.comfort.hi);
  assert.equal(driveAfterResponse(feat, world, { band: 'mid', accentGain: 0.42, quiet: false }), 0.9);
  assert.equal(driveAfterResponse({ drive: 0.1 }, world, { band: 'dense', accentGain: 0.42, quiet: true }), 0.1);
});
