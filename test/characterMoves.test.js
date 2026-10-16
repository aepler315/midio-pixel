// The variety/energy pass: Midio's expanded trick book + victory dance +
// ground pirouette, Broshi's barrel rolls + pounce crouch, and Midasus's
// rest-flight repertoire + accent pirouettes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidioPerformer } from '../src/sim/MidioPerformer.js';
import { Broshi } from '../src/sim/Broshi.js';
import { Midasus } from '../src/sim/Midasus.js';
import { Role } from '../src/core/NoteEvent.js';

const DT = 1 / 120;

function fakeMidio() {
  return { leanDeg: 0, scaleX: 1, scaleY: 1, y: 0, renderY: 400, screenX: 200, groundY: 480 };
}
function fakeJump({ airborne, lastLaunchVel = 0.9, jumpStartMs = 0, D = 500, beatPeriodMs = 0 }) {
  return { airborne, lastLaunchVel, jumpStartMs, D, beatPeriodMs };
}
function fakeCombo(displayM = 1, streak = 0) {
  return { displayM, streak };
}
function fakeConductor() {
  const barHandlers = [];
  const roleHandlers = {};
  const aheadHandlers = {};
  return {
    onBar(fn) { barHandlers.push(fn); },
    on(role, fn) { (roleHandlers[role] ||= []).push(fn); },
    // Anticipation channel (ChoreoClock): the fake delivers immediately --
    // lead time is a dispatch detail these tests don't exercise.
    subscribeAhead(role, leadMs, fn) { (aheadHandlers[role] ||= []).push(fn); },
    fireBar(ms) { for (const fn of barHandlers) fn({ ms }); },
    fireEvent(role, evt) {
      const e = { role, ...evt }; // real NoteEvents always carry their role
      for (const fn of (aheadHandlers[role] || [])) fn(e);
      for (const fn of (aheadHandlers['*'] || [])) fn(e);
      for (const fn of (roleHandlers[role] || [])) fn(e);
    },
  };
}

// --- Midio ---------------------------------------------------------------

test('blazing runs reach deep into the trick book; every serve is from the vocabulary', () => {
  const perf = new MidioPerformer(7);
  const vocab = new Set(['spin', 'backflip', 'corkscrew', 'tuckpop', 'helicopter', 'doubleflip']);
  const seen = new Set();
  let t = 0;
  for (let i = 0; i < 60; i++) {
    perf.update(t - 1, DT, fakeMidio(), fakeJump({ airborne: false }), fakeCombo(8));
    perf.update(t, DT, fakeMidio(), fakeJump({ airborne: true, lastLaunchVel: 0.95, jumpStartMs: t, D: 400 }), fakeCombo(8));
    assert.ok(vocab.has(perf.trick.type), `unknown trick ${perf.trick.type}`);
    seen.add(perf.trick.type);
    t += 400;
  }
  assert.ok(seen.size >= 4, `expected a varied book across 60 hot jumps, got only ${[...seen]}`);
});

test('cool, low-combo launches stay on the classic spin/backflip', () => {
  const perf = new MidioPerformer(9);
  let t = 0;
  for (let i = 0; i < 20; i++) {
    perf.update(t - 1, DT, fakeMidio(), fakeJump({ airborne: false }), fakeCombo(1), 1);
    perf.update(t, DT, fakeMidio(), fakeJump({ airborne: true, lastLaunchVel: 0.85, jumpStartMs: t, D: 400 }), fakeCombo(1), 1);
    assert.ok(['spin', 'backflip'].includes(perf.trick.type),
      `calm launch escalated to ${perf.trick.type}`);
    t += 400;
  }
});

test('a landing-tie relaunch (never un-airs) still starts a new trick', () => {
  // Four-on-the-floor never returns to GROUND: each kick force-relaunches
  // while still airborne. Tricks used to key off grounded→air, so a whole
  // chorus of jumps served none. The jumpStartMs change is the launch.
  const perf = new MidioPerformer(4);
  const combo = fakeCombo(8);
  perf.update(0, DT, fakeMidio(), fakeJump({ airborne: true, lastLaunchVel: 0.95, jumpStartMs: 0, D: 500 }), combo);
  assert.ok(perf.trick, 'first launch tricks');
  const first = perf.trick.type;
  perf.update(500, DT, fakeMidio(), fakeJump({ airborne: true, lastLaunchVel: 0.95, jumpStartMs: 500, D: 500 }), combo);
  assert.ok(perf.trick, 'relaunch must trick too');
  assert.equal(perf.trick.jumpStartMs, 500);
  assert.notEqual(perf.trick.type, first, 'never the same trick twice in a row');
});

test('a combo milestone triggers a grounded victory dance that dies back out', () => {
  const perf = new MidioPerformer(3);
  perf.onStreak(5, 1000);
  const mid = fakeMidio();
  perf.update(1100, DT, mid, fakeJump({ airborne: false }), fakeCombo());
  assert.ok(Math.abs(mid.leanDeg) > 1, `expected a shimmy lean, got ${mid.leanDeg}`);
  const later = fakeMidio();
  perf.update(2100, DT, later, fakeJump({ airborne: false }), fakeCombo());
  assert.ok(Math.abs(later.leanDeg) < 0.01, 'dance must be over 1.1s after the milestone');
});

test('a hot clean landing can stick a full pirouette that ends facing front', () => {
  const perf = new MidioPerformer(1);
  let startMs = -1;
  for (let i = 0; i < 40 && startMs < 0; i++) {
    const t = 1000 + i * 1000;
    perf.onLanding(t, true, 5);
    if (Number.isFinite(perf._pirouetteStartMs) && perf._pirouetteStartMs === t) startMs = t;
  }
  assert.ok(startMs > 0, 'expected at least one pirouette in 40 hot clean landings');
  const mid = fakeMidio();
  perf.update(startMs + 150, DT, mid, fakeJump({ airborne: false }), fakeCombo());
  assert.ok(mid.leanDeg > 30, `mid-pirouette lean should be large, got ${mid.leanDeg}`);
  const done = fakeMidio();
  perf.update(startMs + 320, DT, done, fakeJump({ airborne: false }), fakeCombo());
  assert.ok(Math.abs(done.leanDeg % 360) < 1, 'pirouette must end facing front');
});

// --- Broshi --------------------------------------------------------------

test('hard mini-hops barrel-roll sometimes, bounded, and always settle back to zero', () => {
  const conductor = fakeConductor();
  const b = new Broshi(conductor, {}, { seed: 3 });
  let sawRoll = 0, maxRoll = 0;
  let t = 0;
  for (let i = 0; i < 60; i++) {
    conductor.fireEvent(Role.MELODY, { kick: false, vel: 0.9, pitch: 60 + (i % 12) });
    for (let s = 0; s < 4; s++) {
      t += 40;
      b.update(t, 1 / 60, fakeMidio(), null, null, 0, 480, 0);
      if (Math.abs(b.bodyRoll) > 0.05) sawRoll++;
      maxRoll = Math.max(maxRoll, Math.abs(b.bodyRoll));
    }
  }
  assert.ok(sawRoll > 0, 'expected at least one barrel roll across 60 hard hops');
  assert.ok(maxRoll <= Math.PI * 4 + 1e-9, `roll exceeded two turns: ${maxRoll}`);
  b.update(t + 3000, 1 / 60, fakeMidio(), null, null, 0, 480, 0);
  assert.equal(b.bodyRoll, 0);
});

test('a surge onset coils Broshi into a pounce crouch that releases', () => {
  const conductor = fakeConductor();
  const b = new Broshi(conductor, {}, { seed: 4 });
  for (let i = 0; i < 8; i++) conductor.fireBar(i * 500); // 8 quiet bars force a surge
  b.update(3600, 1 / 60, fakeMidio(), null, null, 0, 480, 0);
  assert.equal(b.state, 'SURGE');
  b.update(3690, 1 / 60, fakeMidio(), null, null, 0, 480, 0);
  assert.ok(b.squashY < 0.9 && b.squashX > 1.05,
    `expected a crouch mid-pounce, got squashY=${b.squashY} squashX=${b.squashX}`);
  b.update(3900, 1 / 60, fakeMidio(), null, null, 0, 480, 0);
  assert.ok(Math.abs(b.squashY - 1) < 0.01 && Math.abs(b.squashX - 1) < 0.01,
    'crouch must fully release after the pounce window');
});

// --- Midasus -------------------------------------------------------------

function melodyNote(tMs, pitch, vel) {
  return { tMs, durMs: 200, pitch, vel, role: Role.MELODY, kick: false, src: 'midi', channel: 0, pan: 0, program: 0 };
}

test('settling into a rest picks a fresh flight figure, never repeating', () => {
  const timeline = [melodyNote(0, 64, 0.5)];
  const m = new Midasus(timeline, fakeMidio(), { groundY: 480, seed: 11 });
  const styles = [m.orbitStyle];
  // Long silence after the single note: she enters rest and picks a figure.
  for (let t = 0; t <= 3000; t += 50) m.update(t, 0.05, 0, null, 1, null);
  assert.notEqual(m.orbitStyle, 'lissajous', 'rest entry must pick a fresh figure');
  assert.ok(['figure8', 'loop', 'petal', 'lissajous', 'harmonograph', 'spirograph'].includes(m.orbitStyle));
  styles.push(m.orbitStyle);
  assert.notEqual(styles[1], styles[0]);
});

test('hard melody accents spin her into a pirouette that fully unwinds', () => {
  const timeline = [melodyNote(500, 70, 0.95)];
  const m = new Midasus(timeline, fakeMidio(), { groundY: 480, seed: 12 });
  m.update(500, 0.016, 0, null, 1, null);  // consumes the accent
  m.update(650, 0.016, 0, null, 1, null);  // mid-pirouette
  assert.ok(m.rollExtra > 0.5, `expected a strong mid-pirouette roll, got ${m.rollExtra}`);
  m.update(900, 0.016, 0, null, 1, null);  // past the 320ms window
  assert.equal(m.rollExtra, 0);
});

test('a note impact bursts in ITS OWN pitch color, not the hue of a note she is already darting toward', () => {
  const midio = { screenX: 200, groundY: 540, y: 0 };
  // Pitch 60 -> hue 0, pitch 64 -> hue 120: 100ms apart, both inside the
  // anticipation window at once, so the dart loop advances this.hue to the
  // second note before the first note's impact drains.
  const timeline = [melodyNote(1000, 60, 0.6), melodyNote(1100, 64, 0.6)];
  const m = new Midasus(timeline, midio, { groundY: 540 });
  m.update(1005, 1 / 120, 0, null, 1, null); // darts both; impacts note A only
  // Bursts spawn at size 4; her ambient trail streaks (size 3) legitimately
  // ride the current dart hue, so only the bursts are under test.
  const burstHues = new Set(m.particles.active.filter((p) => p.size === 4).map((p) => p.hue));
  assert.ok(burstHues.has(0), 'note A\'s burst carries note A\'s hue');
  assert.ok(!burstHues.has(120), 'note B has not been heard yet -- its hue must not appear in a burst');
});
