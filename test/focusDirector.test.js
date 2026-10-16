import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FocusDirector, FOCUS_KEYS } from '../src/sim/FocusDirector.js';

function idleSim() {
  return {
    hype: { surge: 0, slam: 0 },
    midasus: { voyage: { active: false, depth: 0 } },
    broshi: { burrow: { active: false, depth: 0 } },
    apotheosis: { progress: 0 },
  };
}

test('no dramatic state -> no subject, every mul is 1 (ordinary-play no-op)', () => {
  const f = new FocusDirector();
  f.update(idleSim(), 0.016, 1000);
  assert.equal(f.subject, null);
  for (const key of FOCUS_KEYS) assert.equal(f.mul(key), 1);
  assert.equal(f.mul('anything-unregistered'), 1);
});

test('a strong drop surge alone wins drop', () => {
  const f = new FocusDirector();
  const sim = idleSim();
  sim.hype.surge = 1;
  f.update(sim, 0.016, 1000);
  assert.equal(f.subject, 'drop');
  assert.equal(f.mul('drop'), 1);
  assert.ok(f.mul('sky') < 1 && f.mul('sky') >= 0.3);
});

test('an active voyage alone wins voyage', () => {
  const f = new FocusDirector();
  const sim = idleSim();
  sim.midasus.voyage = { active: true, depth: 1 }; // deep space -- full presence
  f.update(sim, 0.016, 1000);
  assert.equal(f.subject, 'voyage');
});

test('an active burrow alone wins burrow', () => {
  const f = new FocusDirector();
  const sim = idleSim();
  sim.broshi.burrow = { active: true, depth: 1 };
  f.update(sim, 0.016, 1000);
  assert.equal(f.subject, 'burrow');
});

test('apotheosis progress alone wins midio', () => {
  const f = new FocusDirector();
  const sim = idleSim();
  sim.apotheosis.progress = 1;
  f.update(sim, 0.016, 1000);
  assert.equal(f.subject, 'midio');
});

test('sky is the fallback subject once nothing else is happening but the baseline still clears the floor is false by default', () => {
  // Sky's baseline (0.05) sits BELOW MIN_BID (0.25) by design, so ordinary
  // idle play resolves to no subject at all, not a stuck "sky" winner.
  const f = new FocusDirector();
  f.update(idleSim(), 0.016, 1000);
  assert.equal(f.subject, null);
});

test('mul(subject) is always 1; mul(anyOtherKey) is in [0.3, 0.5] whenever a subject holds', () => {
  const f = new FocusDirector();
  const sim = idleSim();
  sim.hype.surge = 0.6; // a marginal, not maxed, win
  f.update(sim, 0.016, 1000);
  assert.equal(f.subject, 'drop');
  assert.equal(f.mul('drop'), 1);
  for (const key of FOCUS_KEYS) {
    if (key === 'drop') continue;
    const m = f.mul(key);
    assert.ok(m >= 0.3 && m <= 0.5, `${key}: ${m} not in [0.3, 0.5]`);
  }
});

test('a decisive win dampens harder than a marginal win', () => {
  const marginal = new FocusDirector();
  const simMarginal = idleSim();
  simMarginal.hype.surge = 0.3; // just clears MIN_BID
  marginal.update(simMarginal, 0.016, 1000);

  const decisive = new FocusDirector();
  const simDecisive = idleSim();
  simDecisive.hype.surge = 1; // maxed
  decisive.update(simDecisive, 0.016, 1000);

  assert.ok(decisive.mul('sky') < marginal.mul('sky'));
});

test('hysteresis: a marginally higher bid does not displace the held subject before the minimum hold', () => {
  const f = new FocusDirector();
  const sim = idleSim();
  sim.hype.surge = 0.5;
  f.update(sim, 0.016, 1000); // drop wins at t=1000ms
  assert.equal(f.subject, 'drop');

  // A slightly higher voyage bid arrives almost immediately -- inside the
  // minimum hold window (600ms) -- and should NOT take over.
  sim.midasus.voyage = { active: true, depth: 1 }; // bids ~0.85, well above drop's 0.5
  f.update(sim, 0.016, 1100);
  assert.equal(f.subject, 'drop', 'should still be held despite a higher challenger, inside the hold window');
});

test('hysteresis: a decisively higher bid CAN displace the held subject once the hold has elapsed', () => {
  const f = new FocusDirector();
  const sim = idleSim();
  sim.hype.surge = 0.5;
  f.update(sim, 0.016, 1000); // drop wins at t=1000ms
  assert.equal(f.subject, 'drop');

  sim.midasus.voyage = { active: true, depth: 1 };
  f.update(sim, 0.016, 1000 + 700); // 700ms later -- past MIN_HOLD_SEC (0.6s)
  assert.equal(f.subject, 'voyage');
});

test('a subject that decays below the floor releases focus even mid-hold', () => {
  const f = new FocusDirector();
  const sim = idleSim();
  sim.hype.surge = 1;
  f.update(sim, 0.016, 1000);
  assert.equal(f.subject, 'drop');

  // The surge decays to nothing almost immediately, and nothing else is
  // bidding -- focus should release, not artificially hold a dead subject.
  sim.hype.surge = 0;
  f.update(sim, 0.016, 1050);
  assert.equal(f.subject, null);
});

test('an equal bid does not displace the held subject (must beat by SWITCH_MARGIN, not just tie)', () => {
  const f = new FocusDirector();
  const sim = idleSim();
  sim.midasus.voyage = { active: true, depth: 1 };
  f.update(sim, 0.016, 1000);
  const held = f.subject;
  assert.ok(held);

  sim.broshi.burrow = { active: true, depth: 1 }; // same shape of bid, not a decisive beat
  f.update(sim, 0.016, 1000 + 700);
  // Whichever of the two originally won stays held unless burrow's bid
  // cleared held's bid by the full SWITCH_MARGIN.
  assert.equal(f.subject, held);
});
