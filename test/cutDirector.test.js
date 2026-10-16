import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CutDirector } from '../src/sim/CutDirector.js';

function fakeSim(overrides = {}) {
  const shakes = [];
  const hits = [];
  return {
    hype: { dropCount: 0, ...overrides.hype },
    apotheosis: { justTriggered: false, ...overrides.apotheosis },
    camera: { shake: (amp) => shakes.push(amp) },
    filmFinish: { hit: (kind) => hits.push(kind) },
    _shakes: shakes,
    _hits: hits,
  };
}

test('no drop, no apotheosis -> nothing fires, timestamps stay unset', () => {
  const cut = new CutDirector();
  const sim = fakeSim();
  cut.update(sim, 0.016, 1000);
  assert.equal(cut.dropJustCut, false);
  assert.equal(cut.apotheosisJustCut, false);
  assert.equal(cut.dropCutAtMs, -Infinity);
  assert.equal(cut.apotheosisCutAtMs, -Infinity);
  assert.deepEqual(sim._shakes, []);
  assert.deepEqual(sim._hits, []);
});

test('a drop fires the cut exactly once, even across many later steps with dropCount already >=1', () => {
  const cut = new CutDirector();
  const sim = fakeSim({ hype: { dropCount: 1 } });
  cut.update(sim, 0.016, 1000);
  assert.equal(cut.dropJustCut, true);
  assert.equal(cut.dropCutAtMs, 1000);
  assert.deepEqual(sim._shakes, [4]);
  assert.deepEqual(sim._hits, ['drop']);

  // Later steps (more drops, more calls): must not re-fire.
  sim.hype.dropCount = 3;
  cut.update(sim, 0.016, 2000);
  assert.equal(cut.dropJustCut, false);
  assert.equal(cut.dropCutAtMs, 1000, 'timestamp must not move on a later drop');
  assert.equal(sim._shakes.length, 1);
  assert.equal(sim._hits.length, 1);
});

test('apotheosis.justTriggered fires the cut exactly once, ignoring later re-triggers (up to 8/song)', () => {
  const cut = new CutDirector();
  const sim = fakeSim({ apotheosis: { justTriggered: true } });
  cut.update(sim, 0.016, 5000);
  assert.equal(cut.apotheosisJustCut, true);
  assert.equal(cut.apotheosisCutAtMs, 5000);
  assert.deepEqual(sim._shakes, [3.5]);
  assert.deepEqual(sim._hits, ['apotheosis']);

  sim.apotheosis.justTriggered = true; // a later trigger this same song
  cut.update(sim, 0.016, 9000);
  assert.equal(cut.apotheosisJustCut, false);
  assert.equal(cut.apotheosisCutAtMs, 5000);
  assert.equal(sim._shakes.length, 1);
});

test('justCut flags are true for exactly one update() call', () => {
  const cut = new CutDirector();
  const sim = fakeSim({ hype: { dropCount: 1 } });
  cut.update(sim, 0.016, 1000);
  assert.equal(cut.dropJustCut, true);
  cut.update(sim, 0.016, 1016);
  assert.equal(cut.dropJustCut, false);
});

test('drop and apotheosis cuts are independent', () => {
  const cut = new CutDirector();
  const sim = fakeSim({ hype: { dropCount: 1 } });
  cut.update(sim, 0.016, 1000);
  assert.equal(cut.dropJustCut, true);
  assert.equal(cut.apotheosisJustCut, false);

  sim.apotheosis.justTriggered = true;
  cut.update(sim, 0.016, 4000);
  assert.equal(cut.dropJustCut, false, 'drop already fired earlier');
  assert.equal(cut.apotheosisJustCut, true);
});

test('stillnessMul is 0 immediately after a cut, 1 long before/after, and recovers monotonically in between', () => {
  const cut = new CutDirector();
  assert.equal(cut.stillnessMul(500), 1, 'no cut yet -> no dampening');

  const sim = fakeSim({ hype: { dropCount: 1 } });
  cut.update(sim, 0.016, 1000);

  assert.equal(cut.stillnessMul(1000), 0, 'fully stilled right on the hit frame');
  assert.equal(cut.stillnessMul(1050), 0, 'still held mid-hold window');

  const midway = cut.stillnessMul(1150);
  assert.ok(midway > 0 && midway < 1, 'recovering partway through the recover window');

  assert.equal(cut.stillnessMul(1500), 1, 'fully open well after the cut');

  let prev = cut.stillnessMul(1090);
  for (let ms = 1090; ms <= 1400; ms += 10) {
    const v = cut.stillnessMul(ms);
    assert.ok(v >= prev - 1e-9, `stillnessMul must not go backwards (t=${ms})`);
    prev = v;
  }
});

test('stillnessMul takes the more-dampened of the two cuts when both are recent', () => {
  const cut = new CutDirector();
  const sim = fakeSim({ hype: { dropCount: 1 } });
  cut.update(sim, 0.016, 1000); // drop cut at 1000

  sim.apotheosis.justTriggered = true;
  cut.update(sim, 0.016, 1200); // apotheosis cut at 1200, while drop is still recovering

  // At t=1200, the fresh apotheosis cut should dominate (fully stilled again).
  assert.equal(cut.stillnessMul(1200), 0);
});

test('a missing camera/filmFinish on the sim does not throw (defensive read, matches sim.focus/sim.gaze idiom)', () => {
  const cut = new CutDirector();
  assert.doesNotThrow(() => {
    cut.update({ hype: { dropCount: 1 }, apotheosis: { justTriggered: false } }, 0.016, 1000);
  });
});
