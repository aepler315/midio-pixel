// Song-form recognition: sections that are the same music get the same
// structural label (SongForm.analyzeSongForm), so recurrences wear the
// same face downstream (BiomeManager).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSongForm, cosineSim, energyToleranceFor, ENERGY_TOL_MIN, ENERGY_TOL_FRAC,
} from '../src/world/SongForm.js';

test('cosineSim: identical direction is 1, orthogonal is 0, opposite is -1, zero-vector is 0', () => {
  assert.ok(Math.abs(cosineSim([1, 2, 3], [2, 4, 6]) - 1) < 1e-9, 'a scaled copy points the same way');
  assert.equal(cosineSim([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosineSim([1, 1], [-1, -1]) + 1) < 1e-9);
  assert.equal(cosineSim([0, 0], [1, 1]), 0, 'no shape to compare');
});

// Two recognizable timbres: a bass-forward "chorus" and an airy "verse".
const CHORUS = { energy: 0.8, shape: [0.9, 0.8, 0.4, 0.3, 0.2, 0.15, 0.1] };
const VERSE = { energy: 0.35, shape: [0.1, 0.15, 0.3, 0.5, 0.6, 0.7, 0.8] };
const BRIDGE = { energy: 0.55, shape: [0.2, 0.3, 0.7, 0.8, 0.5, 0.3, 0.2] };

test('an A-B-A-C-B form reads back exactly [0,1,0,2,1]', () => {
  const labels = analyzeSongForm([VERSE, CHORUS, VERSE, BRIDGE, CHORUS]);
  assert.deepEqual(labels, [0, 1, 0, 2, 1]);
});

test('a returning section matches the AVERAGE of its prior selves, not just the last', () => {
  // Slightly drifting choruses still cluster together.
  const c1 = { energy: 0.8, shape: [0.9, 0.8, 0.4, 0.3, 0.2, 0.15, 0.1] };
  const c2 = { energy: 0.78, shape: [0.88, 0.82, 0.42, 0.28, 0.22, 0.14, 0.12] };
  const c3 = { energy: 0.82, shape: [0.92, 0.78, 0.38, 0.32, 0.18, 0.16, 0.09] };
  const labels = analyzeSongForm([c1, VERSE, c2, VERSE, c3]);
  assert.deepEqual(labels, [0, 1, 0, 1, 0], 'three drifting choruses and two verses');
});

test('two sections at the same energy but different timbre stay distinct', () => {
  const bassy = { energy: 0.6, shape: [0.9, 0.8, 0.3, 0.2, 0.1, 0.1, 0.1] };
  const trebly = { energy: 0.6, shape: [0.1, 0.1, 0.1, 0.2, 0.3, 0.8, 0.9] };
  assert.deepEqual(analyzeSongForm([bassy, trebly]), [0, 1]);
});

test('two sections with identical timbre merge even across a small energy gap', () => {
  const a = { energy: 0.5, shape: [0.9, 0.8, 0.4, 0.3, 0.2, 0.15, 0.1] };
  const b = { energy: 0.6, shape: [0.9, 0.8, 0.4, 0.3, 0.2, 0.15, 0.1] };
  assert.deepEqual(analyzeSongForm([a, b]), [0, 0]);
});

test('a big energy gap keeps even identically-voiced sections apart (energy gate)', () => {
  const soft = { energy: 0.1, shape: [0.9, 0.8, 0.4, 0.3, 0.2, 0.15, 0.1] };
  const loud = { energy: 0.9, shape: [0.9, 0.8, 0.4, 0.3, 0.2, 0.15, 0.1] };
  assert.deepEqual(analyzeSongForm([soft, loud]), [0, 1], 'same shape, but > energyTol apart');
});

test('a monotonically shifting sequence yields all-distinct labels', () => {
  const secs = [];
  for (let i = 0; i < 5; i++) {
    const shape = [0, 0, 0, 0, 0, 0, 0];
    shape[i] = 1; shape[i + 1] = 0.5; // a moving spectral bump -- each unlike the last
    secs.push({ energy: 0.5, shape });
  }
  const labels = analyzeSongForm(secs);
  assert.equal(new Set(labels).size, labels.length, 'no two adjacent-ish sections merge');
});

test('deterministic: the same input always labels the same way', () => {
  const seq = [VERSE, CHORUS, BRIDGE, CHORUS, VERSE, CHORUS];
  assert.deepEqual(analyzeSongForm(seq), analyzeSongForm(seq));
});

// --- the energy gate is the SONG's, not an absolute --------------------------

test('the form a song reads as does not depend on its mastering', () => {
  // The defect this replaced: the gate was a flat 0.22 on a 0..1 energy
  // scale, so whether a returning chorus came home or founded a third label
  // was decided by how much dynamic range the master happened to have.
  //
  // One song, one form: V C V C', where C' is the same chorus returning a
  // little quieter (as a final chorus after a breakdown does) with the slight
  // voicing drift a real recurrence has. Re-master it across the whole range
  // from crushed to wide and the ANSWER must not move.
  const vShape = [0.1, 0.15, 0.3, 0.5, 0.6, 0.7, 0.8];
  const cShape = [0.9, 0.8, 0.4, 0.3, 0.2, 0.15, 0.1];
  const cShape2 = [0.86, 0.83, 0.44, 0.27, 0.23, 0.13, 0.12];
  const form = [
    { e: 0.30, shape: vShape }, { e: 0.80, shape: cShape },
    { e: 0.34, shape: vShape }, { e: 0.62, shape: cShape2 },
  ];
  const mean = form.reduce((a, s) => a + s.e, 0) / form.length;

  for (let k = 0.2; k <= 1.45; k += 0.15) {
    const secs = form.map((s) => ({
      energy: Math.max(0, Math.min(1, mean + (s.e - mean) * k)),
      shape: s.shape,
    }));
    assert.deepEqual(
      analyzeSongForm(secs), [0, 1, 0, 1],
      `the returning chorus must come home at dynamic-range x${k.toFixed(2)} `
      + `(energies ${secs.map((s) => s.energy.toFixed(2)).join(' ')})`,
    );
  }
});

test('the gate widens with the song\'s own dynamic range', () => {
  const wide = [{ energy: 0.05, shape: [1] }, { energy: 0.95, shape: [1] }];
  const narrow = [{ energy: 0.45, shape: [1] }, { energy: 0.55, shape: [1] }];
  assert.ok(energyToleranceFor(wide) > energyToleranceFor(narrow),
    'a dynamic song must tolerate a bigger loudness gap between two takes of the same material');
  assert.ok(Math.abs(energyToleranceFor(wide) - ENERGY_TOL_FRAC * 0.9) < 1e-9,
    'and that width is a fixed fraction of the range itself');
});

test('a song with no dynamics keeps an absolute gate rather than a zero-width one', () => {
  // Every section at the same level: the spread is 0, and a purely
  // proportional gate would collapse to nothing and split on rounding noise.
  const flat = [
    { energy: 0.5, shape: [1, 0] }, { energy: 0.5, shape: [1, 0] },
  ];
  assert.equal(energyToleranceFor(flat), ENERGY_TOL_MIN);
  assert.deepEqual(analyzeSongForm(flat), [0, 0], 'identical material still merges');
  assert.equal(energyToleranceFor([]), ENERGY_TOL_MIN, 'and an empty song does not divide by zero');
});

test('an explicit energyTol still overrides the song-relative one', () => {
  // Three sections, so the song's RANGE can be wider than the gap between the
  // pair under test -- with only two, the spread is that gap by definition and
  // a proportional gate can never reach past it.
  const hush = { energy: 0.05, shape: [0.1, 0.2, 0.9] };
  const soft = { energy: 0.40, shape: [0.9, 0.8, 0.4] };
  const loud = { energy: 0.60, shape: [0.9, 0.8, 0.4] };
  assert.deepEqual(analyzeSongForm([hush, soft, loud]), [0, 1, 1],
    'song-relative: 0.20 apart is well inside a song that spans 0.55');
  assert.deepEqual(analyzeSongForm([hush, soft, loud], { energyTol: 0.05 }), [0, 1, 2],
    'an explicit narrow gate still splits them');
});
