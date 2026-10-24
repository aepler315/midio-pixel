import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { extractWatchFeatures, scoreWorlds, buildWorldVariant, TIE_EPS, pickRecommended, formatFitDiagnostic, driveAfterResponse } from '../src/world/WorldScore.js';
import { getWorld, listWorlds, setCustomWorld, clearCustomWorld, DEFAULT_WORLD_ID } from '../src/world/Worlds.js';
import { castBiomes } from '../src/world/Dramaturgy.js';
import { REAL_BIOME_TEMPERATURE } from '../src/world/RealBiomes.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('world registry: Landscape default, Trio present, unknown falls back', () => {
  assert.equal(DEFAULT_WORLD_ID, 'alpine');
  assert.equal(getWorld('alpine').name, 'Landscape');
  assert.equal(getWorld('trio').kind, 'alpine');
  assert.equal(getWorld('trio').experience, 'trio');
  assert.equal(getWorld('nope').id, 'alpine');
  assert.equal(getWorld('nocturne').id, 'alpine', 'a removed world falls back to Landscape');
});

test('castBiomes accepts a world\'s own temperature map', () => {
  const names = castBiomes([0.1, 0.9], 7, REAL_BIOME_TEMPERATURE);
  assert.equal(names.length, 2);
  assert.ok(names.every((n) => REAL_BIOME_TEMPERATURE[n] != null));
  assert.notEqual(names[0], names[1]);
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

test('every registered world is listed and has the required fields', () => {
  const worlds = listWorlds();
  // Exact, not >=: the count is the guard that catches a world silently
  // dropping out of the registry. Bump it deliberately when adding one.
  assert.deepEqual(worlds.map(w => w.id), ['alpine', 'trio']);
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

// ── Per-world win/lose coverage ────────────────────────────────────
//
// scoreWorlds/comfortScore squashed toward the middle badly enough that a
// world scored nearly as well on its stated weakness as on the song it was
// tuned for. These feed a full, hand-authored feature vector straight to
// scoreWorlds (bypassing extractWatchFeatures/EnergyCurves — those are
// already exercised above), independent of whatever the audio-analysis
// pipeline happens to produce for a given synthetic curve. Landscape and
// Trio share one fit (the same comfort, prefer and affinity), so each is
// held to its own book by score, not ranked against the other.
function baseFeat(overrides = {}) {
  return {
    centroid: 0.5, bass: 0.35, air: 0.2, spread: 0.5, dyn: 0.4, energyMean: 0.4,
    phrase: 0.35, landmarks: 5, onset: 0.35, contrast: 0.4, groove: 0.45, warmth: 0.4,
    texture: 0.35, form: 0.4, arc: 0.4, drive: 0.5, bpm: 110, tempoHeat: 0.4, trend: 0,
    ...overrides,
  };
}

const RANGE_CASES = {
  win: baseFeat({ arc: 0.72, dyn: 0.65, form: 0.65, contrast: 0.58, texture: 0.4, air: 0.35, onset: 0.4, tempoHeat: 0.45, drive: 0.59 }),
  lose: baseFeat({ arc: 0.08, dyn: 0.1, onset: 0.05, contrast: 0.1, energyMean: 0.1, tempoHeat: 0.05, drive: 0.08, bass: 0.1 }),
};
const WORLD_CASES = { alpine: RANGE_CASES, trio: RANGE_CASES };

function scoreOf(feat, id) { return scoreWorlds(feat).find((r) => r.id === id).score; }

for (const [id, cases] of Object.entries(WORLD_CASES)) {
  test(`${id} scores well on its own intended song shape`, () => {
    const mine = scoreOf(cases.win, id);
    assert.ok(mine >= 60, `${id} scored only ${mine} on its own intended song shape`);
  });

  test(`${id} drops well down on its stated weakness`, () => {
    const win = scoreOf(cases.win, id);
    const lose = scoreOf(cases.lose, id);
    assert.ok(lose < 60, `${id} scored ${lose} on a song matching its stated weakness`);
    assert.ok(win - lose >= 20, `${id} barely separates its book (${win}) from its weakness (${lose})`);
  });
}

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

// World construction used to wrap DNA + palette synthesis + terrain shaping
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
    // Trio: Landscape's real biomes are never synthesized.
    result = buildWorldVariant('trio', feat, data);
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
    for (const base of listWorlds()) {
      const label = `${song.label}/${base.id}`;
      const { world, proof } = buildWorldVariant(base.id, feat);

      assert.notEqual(proof.score, 100, `${label}: adapted worlds must not construct a perfect score`);
      assert.ok(proof.score >= 1 && proof.score <= 99, `${label}: score ${proof.score} out of range`);
      assert.equal(world.kind, base.kind, `${label}: lost its kind`);
      assert.ok(world.palettes?.length >= 3, `${label}: missing palettes`);
      assert.ok(typeof world.cast === 'function', `${label}: missing cast`);
      assert.equal(world.registeredId, base.id);
      assert.ok(world.instanceId);
      assert.notEqual(world.instanceId, world.registeredId);

      setCustomWorld(world);
      assert.equal(getWorld(world.id).kind, world.kind);
      clearCustomWorld();
      assert.notEqual(getWorld('custom').id, 'custom');
    }
  }
});

test('buildWorldVariant preserves the selected world while tailoring it to the song', () => {
  const feat = baseFeat({
    onset: 0.7, energyMean: 0.7, dyn: 0.6, tempoHeat: 0.65, drive: 0.7,
  });
  const { world, proof } = buildWorldVariant('trio', feat);

  assert.equal(world.id, 'custom');
  assert.equal(world.baseId, 'trio');
  assert.equal(world.registeredId, 'trio');
  assert.equal(world.kind, 'alpine');
  assert.equal(world.name, 'Trio');
  assert.equal(world.experience, 'trio');
  assert.notEqual(proof.score, 100);
  assert.ok(world.response);
  assert.equal(world.capabilities.geometry.includes('ridge'), true);
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

test('near ties stay tied; the fit readout still names one pick', () => {
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

test('quiet input is never lifted to manufacture activity', () => {
  const feat = baseFeat({ energyMean: 0.08, dyn: 0.10, onset: 0.05, drive: 0.10, arc: 0.08 });
  // A synthetic world that wants high drive: quiet input is reported as
  // stillness there, not lifted to fit.
  const highDrive = { ...getWorld('alpine'), id: 'high-drive-fixture', name: 'High drive', comfort: { lo: 0.6, hi: 0.9 } };
  const ranked = scoreWorlds(feat, [...listWorlds(), highDrive]);
  for (const r of ranked) {
    assert.equal(r.parts.driveUsed, r.parts.drive);
  }
  const fixture = ranked.find((r) => r.id === 'high-drive-fixture');
  assert.ok(fixture.parts.problems.some((p) => p.code === 'stillness'));
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

test('manual-only worlds and explicit exclusions are never the pick', () => {
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
