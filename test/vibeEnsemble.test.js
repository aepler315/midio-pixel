import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VibeDirector } from '../src/sim/VibeDirector.js';
import { meltMesh } from '../src/render/MeshDrawer.js';
import { radialMesh } from '../src/render/meshes.js';
import { Role } from '../src/core/NoteEvent.js';

const STEP = 1 / 120;

function loopedTimeline(pitches, gapMs, reps, vel = 0.7) {
  const out = [];
  for (let r = 0; r < reps; r++) {
    pitches.forEach((p, i) => out.push({ tMs: (r * pitches.length + i) * gapMs, pitch: p, vel, role: Role.MELODY }));
  }
  return out;
}

function runVibe(timeline, seconds, energy = null) {
  const vibe = new VibeDirector(timeline);
  const curves = energy == null ? null
    : { globalEnergy: () => energy, globalEnergyNorm: () => energy, sample: () => energy * 0.5 };
  let t = 0;
  for (let i = 0; i < seconds * 120; i++) { vibe.update(t, STEP, curves); t += 8.33; }
  return vibe;
}

test('a looping major arpeggio reads happy; the minor version reads sad', () => {
  const major = runVibe(loopedTimeline([60, 64, 67, 72], 250, 40), 8);
  const minor = runVibe(loopedTimeline([60, 63, 67, 72], 250, 40), 8);
  assert.ok(major.valence > 0.15, `major should read happy, got ${major.valence.toFixed(2)}`);
  assert.ok(minor.valence < -0.05, `minor should read sad, got ${minor.valence.toFixed(2)}`);
  assert.ok(major.valence > minor.valence + 0.3, 'the two modes must clearly separate');
});

test('a looping C arpeggio settles the exposed tonic at pitch-class 0 with real confidence', () => {
  const v = runVibe(loopedTimeline([60, 64, 67, 72], 250, 40), 8);
  assert.equal(v.tonic, 0);
  assert.ok(v.tonicConfidence > 0.3, `expected real confidence, got ${v.tonicConfidence.toFixed(2)}`);
});

test('a looping G arpeggio settles the exposed tonic at pitch-class 7', () => {
  const v = runVibe(loopedTimeline([67, 71, 74, 79], 250, 40), 8);
  assert.equal(v.tonic, 7);
});

test('tonic/tonicConfidence hold their defaults when there is not yet enough evidence (count<3)', () => {
  const vibe = new VibeDirector([{ tMs: 0, pitch: 60, vel: 0.7, role: Role.MELODY }]);
  vibe.update(0, STEP, null);
  assert.equal(vibe.tonic, 0);
  assert.equal(vibe.tonicConfidence, 0);
});

test('a confident spectral key timeline takes precedence over a misleading note-event argmax', () => {
  // Raw-audio pitch events are sparse/onset-biased; they can over-count one
  // melodic note even while the spectral chroma correctly hears the harmony.
  const notes = loopedTimeline([62, 62, 62, 62], 200, 8);
  const vibe = new VibeDirector(notes, [
    { tMs: 0, tonic: 0, mode: 'major', majorness: 0.8, confidence: 0.9 },
  ]);
  vibe.update(1000, STEP, null);
  assert.equal(vibe.tonic, 0);
  assert.ok(vibe.tonicConfidence > 0.8);
  assert.ok(vibe.valence > 0, 'the timeline major third balance should inform valence');
});

test('dense, loud, wide-register writing reads epic; sparse quiet writing reads trivial', () => {
  const epicNotes = loopedTimeline([36, 48, 60, 72, 84, 96], 120, 80);
  const trivialNotes = loopedTimeline([60, 62], 1800, 6, 0.3);
  const epic = runVibe(epicNotes, 8, 0.9);
  const trivial = runVibe(trivialNotes, 8, 0.1);
  assert.ok(epic.epic > 0.6, `expected epic, got ${epic.epic.toFixed(2)}`);
  assert.ok(trivial.epic < 0.35, `expected trivial, got ${trivial.epic.toFixed(2)}`);
});

test('meltMesh flows every rim vertex, holds the hub, and stays bounded', () => {
  const mesh = radialMesh(20, 20, 8, 0, -20);
  const melted = meltMesh(mesh, 0, -20, 3.7, 5, 1);
  assert.notEqual(melted, mesh);
  assert.deepEqual(melted.vertices[0], mesh.vertices[0], 'the hub must hold still');
  let moved = 0;
  for (let i = 1; i < mesh.vertices.length; i++) {
    const d = Math.hypot(melted.vertices[i].x - mesh.vertices[i].x, melted.vertices[i].y - mesh.vertices[i].y);
    assert.ok(d < 5 * 8, `vertex ${i} melted too far: ${d}`);
    if (d > 0.3) moved++;
  }
  assert.ok(moved >= 5, `most rim vertices should be in flow, only ${moved} moved`);
  // Time-varying: the same call at another instant gives a different pose.
  const melted2 = meltMesh(mesh, 0, -20, 4.9, 5, 1);
  const delta = Math.hypot(
    melted2.vertices[1].x - melted.vertices[1].x,
    melted2.vertices[1].y - melted.vertices[1].y,
  );
  assert.ok(delta > 0.05, 'the melt must keep flowing over time');
  // Zero melt is the identity.
  assert.equal(meltMesh(mesh, 0, -20, 3.7, 0, 1), mesh);
});
