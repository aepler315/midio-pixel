import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShotTour } from '../src/world/terrain/ShotPlanner.js';
import { rangeShotLibraryFixture, shotLibraryFixture, dropSong, anthemSong } from './fixtures/shot-library-fixture.mjs';

const withOutro = (library, song, outro) => planShotTour(library, { ...song, tunables: { weights: { outro } } });

// Regression: crediting an entire outro for a short entry into a pullback
// can displace a reachable musical payoff. The reward should track the
// actual pre-payoff move that reaches the viewer, with full credit at payoff.
test('a partial final pullback earns only its completed share of the outro reward', () => {
  const library = rangeShotLibraryFixture({ seed: 2 });
  const a = withOutro(library, dropSong(), 20), b = withOutro(library, dropSong(), 21);
  assert.equal(a.fallback, null);
  assert.deepEqual(a.items, b.items, 'a unit of reward changes cost without selecting a different route');
  const last = a.items.at(-1), shot = library.shotById.get(last.id);
  assert.equal(last.kind, 'shot');
  assert.equal(shot.move, 'pullback');
  assert.equal(last.payoffMs, null, "the ending has not reached this shot's payoff");
  const climax = a.items.find(item => item.moment >= 0 && a.moments[item.moment]?.climax);
  assert.ok(climax && library.subjectById.get(library.shotById.get(climax.id).subjectId).hero);
  const share = (last.sTo - last.sFrom) / shot.payoffS;
  assert.ok(share > 0 && share < .5, 'the viewer sees less than half of the pullback head');
  assert.ok(Math.abs((a.cost - b.cost) - share) < 1e-8,
    `unit reward should credit the visible move share ${share}, received ${a.cost - b.cost}`);
});

test('an ending after its final payoff retains the full hero outro reward', () => {
  const library = shotLibraryFixture();
  const a = withOutro(library, anthemSong(), 20), b = withOutro(library, anthemSong(), 21);
  assert.equal(a.fallback, null);
  assert.deepEqual(a.items, b.items);
  const last = a.items.at(-1), shot = library.shotById.get(last.id);
  assert.ok(Number.isFinite(last.payoffMs) && last.sTo >= shot.payoffS);
  assert.ok(Math.abs(a.cost - b.cost - 1) < 1e-8, 'a completed hero outro retains its full reward');
});
