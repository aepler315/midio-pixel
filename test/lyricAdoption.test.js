import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { Conductor } from '../src/core/Conductor.js';

const lines = [{ tMs: 0, text: 'old star' }, { tMs: 4000, text: 'heart' }, { tMs: 8000, text: 'moon' }];
const revision = { generation: 7, revision: 1, heardTimeMs: 5000,
  lyricSections: [{ startMs: 0, endMs: 12000, kind: 'verse', text: 'heart', confidence: 1 }], syncedLyrics: lines };
function make(session = { generation: 7, admissions: [] }) {
  const conductor = new Conductor();
  conductor.load({ durationMs: 12000, timeline: [], barGrid: Array.from({ length: 6 }, (_, i) => ({ ms: i * 2000, numerator: 4 })) });
  return new BiomeManager({ conductor, durationMs: 12000, canvasWidth: 1280, canvasHeight: 720,
    groundY: 625, songSeed: 3, worldId: 'range', lyricSession: session });
}

test('live lyrics adopt once for their owning generation, keeping committed geography and transitions', () => {
  const m = make();
  m.update(5000, 0, null);
  const sections = m.sections.map(s => ({ ...s }));
  const chapterPlan = m.chapterPlan;
  const previousIndex = m._lastSectionIdx;
  assert.equal(m.adoptLyrics({ ...revision, generation: 8 }), false);
  assert.equal(m._syncedLyrics, null);
  assert.equal(m.adoptLyrics(revision), true);
  assert.equal(m.adoptLyrics(revision), false);
  assert.equal(m._syncedLyrics, lines);
  assert.equal(m.chapterPlan, chapterPlan);
  assert.equal(m._lastSectionIdx, previousIndex);
  for (const s of sections.filter(s => s.startMs <= 5000)) {
    const adopted = m.sections.find(a => a.startMs === s.startMs);
    for (const key of ['startMs', 'endMs', 'profile', 'transition', 'chapterId']) assert.equal(adopted[key], s[key]);
  }
  assert.equal(m._lyricLineCursor, 1, 'active line may be admitted once; expired line is skipped');
  m.update(5000, 0, null);
  assert.equal(m._lyricLineCursor, 2);
  assert.equal(m.weaver._pendingGlyph?.glyphId, 'heart');
  m.dispose();
});

test('seek/replay/export reconstruct lyric admissions at the recorded heard-time boundary', () => {
  const session = { generation: 7, admissions: [revision] };
  const m = make(session);
  m.update(4999, 0, null);
  assert.equal(m._syncedLyrics, null, 'future evidence must not leak into the opening');
  m.update(5000, 0, null);
  assert.equal(m._syncedLyrics, lines);
  assert.equal(m._lyricRevision, 1);
  const late = make(session);
  late.update(11000, 0, null);
  assert.equal(late._lyricLineCursor, 3);
  assert.notEqual(late.weaver._pendingGlyph?.glyphId, 'star');
  assert.deepEqual(late.sections, m.sections);
  m.dispose(); late.dispose();
});

test('startup admission and lyrics-disabled empty session preserve existing behavior', () => {
  const m = make({ generation: 7, admissions: [{ ...revision, heardTimeMs: 0 }] });
  m.update(0, 0, null);
  assert.equal(m._syncedLyrics, lines);
  const disabled = make();
  disabled.update(10000, 0, null);
  assert.equal(disabled._syncedLyrics, null);
  m.dispose(); disabled.dispose();
});

test('late fusion refines future sections but cannot move the current section end or replay a past cut', () => {
  const m = make();
  m.durationMs = 60000;
  m.conductor.barGrid = Array.from({ length: 30 }, (_, i) => ({ ms: i * 2000, numerator: 4 }));
  m.sections = [
    { startMs: 0, endMs: 20000, profile: 'home', transition: 'fade' },
    { startMs: 20000, endMs: 40000, profile: 'next', transition: 'cut' },
    { startMs: 40000, endMs: 60000, profile: 'last', transition: 'fade' },
  ];
  const futureRevision = { ...revision, lyricSections: [
    { startMs: 0, endMs: 12000, kind: 'verse', confidence: 1 },
    { startMs: 12000, endMs: 32000, kind: 'chorus', confidence: 1 },
    { startMs: 32000, endMs: 60000, kind: 'bridge', confidence: 1 },
  ] };
  assert.equal(m.adoptLyrics(futureRevision), true);
  assert.equal(m.sections[0].endMs, 20000);
  assert.ok(!m.sections.some(s => s.startMs === 12000), 'active section remains intact');
  assert.equal(m.sections.find(s => s.startMs === 32000)?.profile, 'next');
  for (let i = 1; i < m.sections.length; i++) assert.equal(m.sections[i].startMs, m.sections[i - 1].endMs);
  assert.equal(m.sections.at(-1).endMs, 60000);
  m.dispose();
});
