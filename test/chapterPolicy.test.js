import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { analyzeSongForm } from '../src/world/SongForm.js';
import { fuseSections } from '../src/lyrics/SectionFusion.js';
import { planChapters, chapterAt } from '../src/world/ChapterPlanner.js';
import { analyzeStructure } from '../src/audio/StructureAnalyzer.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { lithologyFromShares } from '../src/world/RidgePortrait.js';
import { Conductor } from '../src/core/Conductor.js';

const biomes = ['CONIFER', 'DESERT', 'TUNDRA'];
function section(startMs, endMs, label, overrides = {}) {
  return { startMs, endMs, label, sourceSegmentId: `detected:${startMs}`, provenance: 'detected',
    confidence: .95, shape: [1, .1], barMs: 2000,
    boundaryEvidence: { confidence: .95, groups: { timbre: .9, harmony: .9, rhythm: .7 },
      persistenceMs: endMs - startMs, beforePersistenceMs: 120000 }, ...overrides };
}
const plan = (sections, opts = {}) => planChapters({ sections, durationMs: sections.at(-1).endMs, biomes, ...opts });

test('B1 decorative padding inherits source parent by containment, never nearest future start', () => {
  const manager = Object.create(BiomeManager.prototype);
  manager.world = { realBiomes: true };
  manager.songTerrain = { biomes };
  manager._buildSchedule([], { sampleAll: t => Array(7).fill(t >= 94000 ? .8 : .1) }, 240000, 3, null,
    { boundariesMs: [0, 180000], labels: ['A', 'B'], confidence: .95 });
  const middle = manager.sections.find(s => s.startMs >= 90000 && s.startMs < 180000);
  assert.ok(middle);
  assert.equal(middle.label, 'A');
  assert.equal(middle.sourceSegmentId, manager.sections[0].sourceSegmentId);
  assert.equal(middle.provenance, 'decorative');
  assert.equal(middle.profile, biomes[0]);
});

test('nonzero detected downbeat retains a canonical home prefix in the actual constructor/update lifecycle', () => {
  const durationMs = 420000;
  const conductor = new Conductor();
  conductor.load({ durationMs, timeline: [], barGrid: Array.from({ length: 210 }, (_, i) => ({ ms: 200 + i * 2000, numerator: 4 })) });
  const manager = new BiomeManager({ conductor, durationMs, canvasWidth: 1280, canvasHeight: 720,
    groundY: 625, songSeed: 3, worldId: 'range', songTerrain: { biomes, byBiome: new Map() },
    energyCurves: { sampleAll: t => Array(7).fill(t < 60000 ? .1 : .9) },
    structure: { boundariesMs: [200, 120200, 260200], labels: ['home', 'contrast', 'final'], confidence: .95,
      segmentIds: ['opening-at-downbeat', 'contrast', 'final'], boundaryEvidence: [null,
        { confidence: .95, groups: { timbre: .9, harmony: .9 }, persistenceMs: 140000, beforePersistenceMs: 120000 },
        { confidence: .95, groups: { timbre: .9, harmony: .9 }, persistenceMs: 159800, beforePersistenceMs: 140000 }] } });
  assert.equal(manager.chapterPlan.length, 3);
  assert.equal(manager.sections[0].startMs, 0);
  assert.equal(manager.sections[0].sourceSegmentId, 'opening-at-downbeat');
  manager.update(0, 0, null);
  assert.equal(manager.currentBlend.from, biomes[0]);
  assert.equal(manager.currentBlend.to, biomes[0]);
  manager.dispose();
});

test('B2 silent and invalid SongForm vectors are unknown and inherit safe identity', () => {
  assert.deepEqual(analyzeSongForm(Array.from({ length: 3 }, () => ({ energy: 0, shape: [0, 0] }))), [0, 0, 0]);
  assert.deepEqual(analyzeSongForm([{ energy: .4, shape: [1, 0] }, { energy: NaN, shape: [NaN, 0] }]), [0, 0]);
  const manager = Object.create(BiomeManager.prototype);
  manager.world = { realBiomes: true }; manager.songTerrain = { biomes };
  manager._buildSchedule([], null, 240000, 1);
  assert.equal(new Set(manager.sections.map(s => s.label)).size, 1);
  assert.equal(new Set(manager.sections.map(s => s.profile)).size, 1);
});

test('B3 lyric splits preserve source metadata and cannot duplicate admission evidence', () => {
  const base = section(0, 120000, 'A');
  const fused = fuseSections([base], [
    { startMs: 0, endMs: 60000, confidence: .9 },
    { startMs: 60000, endMs: 120000, confidence: .9 },
  ], [], 120000);
  assert.equal(fused[0].sourceSegmentId, base.sourceSegmentId);
  assert.equal(fused[0].boundaryEvidence, base.boundaryEvidence);
  assert.equal(fused[0].confidence, base.confidence);
  assert.equal(fused[1].sourceSegmentId, base.sourceSegmentId);
  assert.equal(fused[1].provenance, 'decorative');
  assert.equal(fused[1].boundaryEvidence, null);
  assert.equal(plan(fused).length, 1);
});

test('manager consumes local boundary evidence and preserves fine variants within one place', () => {
  const manager = Object.create(BiomeManager.prototype);
  manager.world = { realBiomes: true }; manager.songTerrain = { biomes };
  const structure = { boundariesMs: [0, 120000], labels: ['verse', 'chorus'], confidence: .95,
    segmentIds: ['opening', 'regime-2'], boundaryEvidence: [null,
      { confidence: .95, groups: { timbre: .9, harmony: .9 }, persistenceMs: 120000, beforePersistenceMs: 120000 }] };
  const energy = { sampleAll: t => [t < 120000 ? .1 : .9, .1, .2, .3, .2, .1, .05] };
  manager._buildSchedule([], energy, 240000, 3, null, structure);
  assert.equal(manager.chapterPlan.length, 2);
  assert.equal(manager.sections.find(s => s.startMs === 120000).sourceSegmentId, 'regime-2');
  structure.boundaryEvidence[1] = null;
  manager._buildSchedule([], energy, 240000, 3, null, structure);
  assert.equal(manager.chapterPlan.length, 1, 'global SSM confidence alone cannot certify travel');
  assert.equal(manager._sectionVariants.size, 2);
  const verse = manager.sections.find(s => s.label === 'verse');
  const chorus = manager.sections.find(s => s.label === 'chorus');
  assert.equal(verse.profile, chorus.profile);
  assert.notEqual(verse.variant, chorus.variant);
  assert.notEqual(verse.heightMul, chorus.heightMul);
  assert.equal(verse.heightMul, verse.variant.heightMul);
  assert.equal(chorus.heightMul, chorus.variant.heightMul);
});

test('section material variants use physical power shares when normalized activity is flat', () => {
  const durationMs = 120000;
  const curves = new EnergyCurves(durationMs, 2);
  for (let i = 0; i < curves.n; i++) curves.setFrame(i, Array(7).fill(.5));
  const earlyRms = [.8, .4, .3, .2, .1, .05, .02], lateRms = [...earlyRms].reverse();
  curves.rmsBands = Array.from({ length: 7 }, (_, b) => Float32Array.from({ length: curves.n },
    (_, i) => i < 120 ? earlyRms[b] : lateRms[b]));
  const manager = Object.create(BiomeManager.prototype);
  manager.world = { realBiomes: true }; manager.songTerrain = { biomes };
  manager._buildSchedule([], curves, durationMs, 3, null,
    { boundariesMs: [0, 60000], labels: ['low', 'high'], confidence: .95 });
  const low = manager._sectionVariants.get('low'), high = manager._sectionVariants.get('high');
  const expected = lithologyFromShares(earlyRms.map(v => v ** 2));
  assert.ok(Math.abs(low.lithology.basement - expected.basement) < 1e-6);
  assert.ok(low.lithology.basement > high.lithology.basement);
  assert.ok(low.portrait.shares[0] > low.portrait.shares[6]);
  assert.ok(high.portrait.shares[6] > high.portrait.shares[0]);
  assert.deepEqual(manager.sections[0].shape, Array(7).fill(.5), 'activity remains the form/motion signal');
});

test('actual analyzer-to-manager handoff admits persistent harmonic and timbral contrast', () => {
  const durationMs = 240000;
  const frames = Array.from({ length: 240 }, (_, i) => {
    const f = new Float32Array(60);
    for (const pc of (i < 120 ? [0, 4, 7] : [1, 5, 8])) f[48 + pc - 36] = 1;
    return f;
  });
  const energy = { sampleAll: t => Array.from({ length: 7 }, (_, k) => k === (t < 120000 ? 0 : 6) ? 1 : .01) };
  const structure = analyzeStructure({ pointsMs: Array.from({ length: 121 }, (_, i) => i * 2000),
    pitchFeatures: { rate: 1, frames }, energyCurves: energy, durationMs });
  assert.ok(structure.boundaryEvidence[1].confidence >= .65);
  assert.ok(structure.boundaryEvidence[1].groups.harmony >= .3);
  assert.ok(structure.boundaryEvidence[1].groups.timbre >= .3);
  const manager = Object.create(BiomeManager.prototype);
  manager.world = { realBiomes: true }; manager.songTerrain = { biomes };
  manager._buildSchedule([], energy, durationMs, 3, null, structure);
  assert.equal(manager.chapterPlan.length, 2);
  assert.equal(manager.chapterPlan[1].startMs, 120000);
});

test('actual analyzer-to-manager rejects both a brief contrast fill and its return to the admitted home regime', () => {
  const durationMs = 300000;
  const contrast = t => t >= 120000 && t < 132000;
  const frames = Array.from({ length: 300 }, (_, i) => {
    const f = new Float32Array(60);
    for (const pc of (contrast(i * 1000) ? [1, 5, 8] : [0, 4, 7])) f[48 + pc - 36] = 1;
    return f;
  });
  const energy = { sampleAll: t => Array.from({ length: 7 }, (_, k) => k === (contrast(t) ? 6 : 0) ? 1 : .01) };
  const structure = analyzeStructure({ pointsMs: Array.from({ length: 151 }, (_, i) => i * 2000),
    pitchFeatures: { rate: 1, frames }, energyCurves: energy, durationMs });
  assert.deepEqual(structure.boundariesMs, [0, 120000, 132000]);
  assert.deepEqual(structure.labels, [0, 1, 0]);
  const manager = Object.create(BiomeManager.prototype);
  manager.world = { realBiomes: true }; manager.songTerrain = { biomes };
  manager._buildSchedule([], energy, durationMs, 3, null, structure);
  assert.equal(manager.chapterPlan.length, 1);
  assert.deepEqual([...new Set(manager.sections.map(s => s.profile))], [biomes[0]]);
});

test('a return after rejected contrast cannot travel even if local before evidence overstates persistence', () => {
  const sections = [section(0, 120000, 'A'), section(120000, 132000, 'fill'), section(132000, 300000, 'A')];
  assert.equal(plan(sections).length, 1, 'compare destination against last admitted regime, not rejected fill');
});

test('repeat-heavy pop retains chorus motifs in one place', () => {
  const sections = Array.from({ length: 8 }, (_, i) => section(i * 30000, (i + 1) * 30000, i % 2));
  assert.equal(plan(sections).length, 1);
});
test('persistent contrast earns two places, three movements earn three', () => {
  assert.equal(plan([section(0, 120000, 'A'), section(120000, 240000, 'B')]).length, 2);
  const suite = [section(0, 180000, 'A'), section(180000, 360000, 'B'), section(360000, 540000, 'C')];
  const chapters = plan(suite);
  assert.equal(chapters.length, 3);
  assert.equal(new Set(chapters.map(c => c.biome)).size, 3);
  assert.ok(Object.isFrozen(chapters) && chapters.every(Object.isFrozen));
});
test('returning macro regimes reuse place identity with a separate two-transition cap', () => {
  const sections = Array.from({ length: 5 }, (_, i) => section(i * 120000, (i + 1) * 120000, i % 2,
    { chapterIdentity: i % 2 ? 'heavy-movement' : 'clean-movement' }));
  const chapters = plan(sections);
  assert.equal(chapters.length, 3);
  assert.equal(new Set(chapters.map(c => c.biome)).size, 2);
  assert.equal(chapters[0].biome, chapters[2].biome);
});
test('long vamp, energy-only changes, low confidence, silence and brief fills cannot travel', () => {
  const home = section(0, 120000, 'A');
  for (const tail of [
    section(120000, 600000, 'A', { boundaryEvidence: { confidence: .95, groups: { timbre: 0, harmony: 0 }, persistenceMs: 480000 } }),
    section(120000, 600000, 'B', { boundaryEvidence: { confidence: .95, groups: { energy: 1, centroid: 1 }, persistenceMs: 480000 } }),
    section(120000, 600000, 'B', { confidence: .64 }),
    section(120000, 600000, 'B', { shape: [0, 0] }),
    section(120000, 130000, 'B'),
  ]) assert.equal(plan([home, tail]).length, 1);
});
test('reliable slow bars require 16 bars plus travel; free time uses seconds', () => {
  const sections = [section(0, 100000, 'A'), section(100000, 155000, 'B')];
  assert.equal(plan(sections).length, 2);
  assert.equal(plan(sections, { barGrid: Array.from({ length: 16 }, (_, i) => ({ ms: i * 5000, confidence: .9 })) }).length, 1);
  assert.equal(plan(sections, { freeTime: true }).length, 2);
  const variableBars = [
    ...Array.from({ length: 51 }, (_, i) => ({ ms: i * 2000, confidence: .9 })),
    ...Array.from({ length: 22 }, (_, i) => ({ ms: 105000 + i * 5000, confidence: .9 })),
  ];
  const shortSlowTail = [section(0, 100000, 'A'), section(100000, 170000, 'B')];
  assert.equal(plan(shortSlowTail, { barGrid: variableBars }).length, 1,
    'a slow later movement must fit 16 local bars, not the opening median');
});
test('joint optimization reserves the transition budget for stronger legal changes', () => {
  const sections = [section(0, 70000, 'A'), section(70000, 150000, 'B', {
    boundaryEvidence: { confidence: .7, groups: { timbre: .35, harmony: .35 }, persistenceMs: 80000, beforePersistenceMs: 70000 },
  }), section(150000, 280000, 'C'), section(280000, 420000, 'D')];
  assert.deepEqual(plan(sections).map(c => c.startMs), [0, 150000, 280000]);
});
test('seek selects immutable intervals; full analysis freezes home, past and active travel', () => {
  const previous = plan([section(0, 120000, 'A'), section(120000, 240000, 'B')]);
  assert.equal(chapterAt(previous, 119999).biome, biomes[0]);
  assert.equal(chapterAt(previous, 120000).biome, biomes[1]);
  assert.equal(chapterAt(previous, 220000).biome, chapterAt(previous, 125000).biome);
  const refined = plan([section(0, 60000, 'X'), section(60000, 170000, 'Y'), section(170000, 360000, 'Z')],
    { previous, committedThroughMs: 122000, biomes: ['ICEFIELD', ...biomes] });
  assert.equal(chapterAt(refined, 0).biome, previous[0].biome);
  assert.equal(chapterAt(refined, 121000).biome, previous[1].biome);
  assert.equal(refined[1].startMs, 120000);
});
