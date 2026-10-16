// Section boundaries land on the RELEASE, not on the build-up to it.
//
// The detectors answer "where does the material change?" and answer it well
// -- Foote novelty is exactly unbiased on a clean boundary, and the
// band-energy fallback's trailing window lands a few steps late. But that is
// a different question from "where does the tension release", and in produced
// music the two are reliably a bar apart: a drop is preceded by a build, the
// energy vector changes when the BUILD starts, and the detector marks the
// build. The show then fires its release early, over material still winding
// up. These pin the correction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  releaseStep, snapToRelease, snapCutsToReleases, SNAP_SEARCH,
} from '../src/world/BoundarySnap.js';

/** A build ramping over `buildBars` into a drop that holds. */
function buildThenDrop({ n = 32, dropAt = 16, buildBars = 2, quiet = 0.2, loud = 0.9 }) {
  const e = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i >= dropAt) e[i] = loud;
    else if (i >= dropAt - buildBars) {
      const t = (i - (dropAt - buildBars) + 1) / (buildBars + 1);
      e[i] = quiet + (loud - quiet) * t * 0.6; // a ramp, not a step
    } else e[i] = quiet;
  }
  return e;
}

test('releaseStep sees a level change, not a single loud bar', () => {
  const sustained = [0.2, 0.2, 0.2, 0.9, 0.9, 0.9];
  const spike = [0.2, 0.2, 0.2, 0.9, 0.2, 0.2];
  assert.ok(releaseStep(sustained, 3) > releaseStep(spike, 3),
    'a drop is a change in level; one loud bar is a hit');
  assert.equal(releaseStep([1, 2, 3], 0), 0, 'no backward window at the start');
  assert.equal(releaseStep(null, 1), 0);
});

test('a boundary sitting on the build moves forward onto the drop', () => {
  // The reported symptom: about a bar early, over material still winding up.
  const e = buildThenDrop({ dropAt: 16, buildBars: 2 });
  assert.equal(snapToRelease(15, e), 16, 'one bar early should land on the drop');
  assert.equal(snapToRelease(14, e), 16, 'two bars early too');
});

test('a boundary sitting late moves back onto the drop', () => {
  // The band-energy fallback's trailing window lands its peak late; the same
  // correction handles both directions.
  const e = buildThenDrop({ dropAt: 16, buildBars: 2 });
  assert.equal(snapToRelease(17, e), 16);
  assert.equal(snapToRelease(18, e), 16);
});

test('a boundary already on the drop is left exactly where it is', () => {
  const e = buildThenDrop({ dropAt: 16 });
  assert.equal(snapToRelease(16, e), 16);
});

test('it will not drag a boundary further than its search window', () => {
  const e = buildThenDrop({ dropAt: 16 });
  const far = snapToRelease(16 - (SNAP_SEARCH + 3), e);
  assert.ok(Math.abs(far - (16 - (SNAP_SEARCH + 3))) <= SNAP_SEARCH,
    'must not teleport a boundary across a section');
});

test('no clear release means the detector keeps its answer', () => {
  // A texture or key change with no energy step is a real boundary this pass
  // has no opinion about -- it must not be moved onto a nearby wobble.
  const steady = new Array(32).fill(0.5).map((v, i) => v + (i % 3) * 0.01);
  assert.equal(snapToRelease(16, steady), 16);
  // ...and a fade-down is not a release either.
  const decay = Array.from({ length: 32 }, (_, i) => 0.9 - i * 0.02);
  assert.equal(snapToRelease(16, decay), 16);
});

test('the threshold scales to the passage, not to an absolute loudness', () => {
  // A quiet song's drop is a drop. Judging it against a fixed number would
  // only ever correct loud music.
  const loudSong = buildThenDrop({ dropAt: 16, quiet: 0.40, loud: 0.95 });
  const quietSong = buildThenDrop({ dropAt: 16, quiet: 0.04, loud: 0.14 });
  assert.equal(snapToRelease(15, loudSong), 16);
  assert.equal(snapToRelease(15, quietSong), 16, 'a quiet drop must correct too');
});

test('degenerate input never throws or invents a boundary', () => {
  assert.equal(snapToRelease(5, []), 5);
  assert.equal(snapToRelease(5, null), 5);
  assert.equal(snapToRelease(NaN, [1, 2, 3]), NaN);
  // Index 0 has no backward window of its own, but the SEARCH around it does:
  // a candidate at the very start with a real drop one step in should move
  // onto it. (The song-start cut is pinned by the caller, not here -- see
  // snapCutsToReleases' `pinned` option.)
  assert.equal(snapToRelease(0, [0.2, 0.9, 0.9]), 1);
});

test('pinned candidates are never moved', () => {
  // The song's first and last cuts are structural: moving them leaves a gap
  // at one end of the schedule.
  const e = buildThenDrop({ dropAt: 16, buildBars: 2 });
  assert.deepEqual(snapCutsToReleases([0, 15, 31], e, { pinned: [0, 31] }), [0, 16, 31]);
});

test('two candidates describing the same release collapse to one', () => {
  const e = buildThenDrop({ dropAt: 16, buildBars: 2 });
  const out = snapCutsToReleases([15, 16, 17], e);
  assert.deepEqual(out, [16], 'they were all describing the same moment');
});

test('separate releases stay separate, and order is preserved', () => {
  const e = new Array(48).fill(0.2);
  for (let i = 12; i < 24; i++) e[i] = 0.9;
  for (let i = 36; i < 48; i++) e[i] = 0.95;
  const out = snapCutsToReleases([11, 35], e);
  assert.deepEqual(out, [12, 36]);
  assert.deepEqual([...out].sort((a, b) => a - b), out, 'must come back in order');
});

test('an empty or absent cut list passes straight through', () => {
  assert.deepEqual(snapCutsToReleases([], [1, 2, 3]), []);
  assert.equal(snapCutsToReleases(null, [1, 2, 3]), null);
});
