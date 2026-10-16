import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Broshi, keepOutTarget, cheerBumpY } from '../src/sim/Broshi.js';
import { Role } from '../src/core/NoteEvent.js';

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

function fakeMidio() { return { screenX: 200 }; }

function fakeCtx() {
  const translates = [];
  return {
    translates,
    save() {}, restore() {}, scale() {}, rotate() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, stroke() {}, fill() {}, fillRect() {}, arc() {}, ellipse() {},
    quadraticCurveTo() {}, drawImage() {}, clearRect() {}, roundRect() {},
    createRadialGradient(cx, cy) { translates.push({ cx, cy }); return { addColorStop() {} }; },
    createLinearGradient() { return { addColorStop() {} }; },
    translate(x, y) { translates.push({ x, y }); },
    set globalAlpha(v) {}, set globalCompositeOperation(v) {}, set fillStyle(v) {},
    set strokeStyle(v) {}, set lineWidth(v) {}, set lineCap(v) {}, set filter(v) {},
  };
}

test('tail sway widens under sustained calm compared to energetic', () => {
  const conductorA = fakeConductor();
  const a = new Broshi(conductorA, {}, { seed: 1 });
  const conductorB = fakeConductor();
  const b = new Broshi(conductorB, {}, { seed: 1 }); // same seed -> same tail phase

  let maxA = 0, maxB = 0;
  for (let i = 0; i < 400; i++) {
    const t = i * 20;
    a.update(t, 1 / 60, fakeMidio(), null, 0, 480, 0);
    b.update(t, 1 / 60, fakeMidio(), null, 0, 480, 1);
    maxA = Math.max(maxA, Math.abs(a.tailAngle));
    maxB = Math.max(maxB, Math.abs(b.tailAngle));
  }
  assert.ok(maxB > maxA, `expected calm tail sway (${maxB}) to be wider than energetic (${maxA})`);
});

test('mini-hop height is softened during calm ("relaxed lope")', () => {
  const conductorA = fakeConductor();
  const a = new Broshi(conductorA, {}, { seed: 2 });
  const conductorB = fakeConductor();
  const b = new Broshi(conductorB, {}, { seed: 2 });

  conductorA.fireEvent(Role.MELODY, { kick: false, vel: 0.8, pitch: 64 });
  conductorB.fireEvent(Role.MELODY, { kick: false, vel: 0.8, pitch: 64 });
  a.update(0, 1 / 60, fakeMidio(), null, 0, 480, 0);
  b.update(0, 1 / 60, fakeMidio(), null, 0, 480, 1);

  let peakA = 0, peakB = 0;
  for (let t = 10; t <= 170; t += 10) {
    a.update(t, 1 / 60, fakeMidio(), null, 0, 480, 0);
    b.update(t, 1 / 60, fakeMidio(), null, 0, 480, 1);
    peakA = Math.max(peakA, a.hopY);
    peakB = Math.max(peakB, b.hopY);
  }
  assert.ok(peakA > 0, 'expected a non-trivial hop at full energy');
  assert.ok(peakB < peakA, `expected calm hop (${peakB}) to be softer than energetic (${peakA})`);
});

test('a sustained calm streak eventually triggers a yawn (slow jaw open, not the fast kick-snap)', () => {
  const conductor = fakeConductor();
  const broshi = new Broshi(conductor, {}, { seed: 3 });
  let t = 0;
  let sawYawn = false;
  for (let bar = 0; bar < 60 && !sawYawn; bar++) {
    broshi.update(t, 1 / 60, fakeMidio(), null, 0, 480, 1);
    conductor.fireBar(t);
    // Sample jawOpen across the bar for a slow (not instantaneous) rise typical of a yawn.
    for (let i = 1; i <= 20; i++) {
      const sampleT = t + i * 20;
      broshi.update(sampleT, 1 / 60, fakeMidio(), null, 0, 480, 1);
      if (broshi.jawOpen > 0.3) { sawYawn = true; break; }
    }
    t += 500;
  }
  assert.ok(sawYawn, 'expected a yawn to eventually trigger under a long sustained calm streak');
});

test('apex-on-beat: the hop peak lands exactly on the triggering note\'s tMs', () => {
  const conductor = fakeConductor();
  const b = new Broshi(conductor, {}, { seed: 7 });
  // The anticipation channel delivers the note early with its true onset.
  conductor.fireEvent(Role.MELODY, { vel: 0.8, pitch: 64, tMs: 1000 });
  let peakT = null, peak = -1;
  for (let t = 800; t <= 1200; t += 4) {
    b.update(t, 1 / 240, fakeMidio(), null, 0, 480, 0);
    if (b.hopY > peak) { peak = b.hopY; peakT = t; }
  }
  assert.ok(peak > 0, 'the hop must fire');
  assert.ok(Math.abs(peakT - 1000) <= 8, `apex must land ON the note (got peak at ${peakT})`);
});

test('output latency shifts the hop apex onto the HEARD beat', () => {
  const conductor = fakeConductor();
  const b = new Broshi(conductor, {}, { seed: 7 });
  b.visualLagMs = 120;
  conductor.fireEvent(Role.MELODY, { vel: 0.8, pitch: 64, tMs: 1000 });
  let peakT = null, peak = -1;
  for (let t = 800; t <= 1400; t += 4) {
    b.update(t, 1 / 240, fakeMidio(), null, 0, 480, 0);
    if (b.hopY > peak) { peak = b.hopY; peakT = t; }
  }
  assert.ok(Math.abs(peakT - 1120) <= 8, `with 120ms output lag the apex waits for the ear (got ${peakT})`);
});

test('casting: a hopFilter routes his body to HIS lane only', () => {
  const conductor = fakeConductor();
  const b = new Broshi(conductor, {}, { seed: 8, hopFilter: (e) => e.lane === 'BROSHI' });
  // A melody note that is NOT his lane: head may bob, body must not hop.
  conductor.fireEvent(Role.MELODY, { vel: 0.9, pitch: 70, tMs: 500, lane: 'MIDASUS' });
  let hopped = 0;
  for (let t = 300; t <= 700; t += 10) {
    b.update(t, 1 / 100, fakeMidio(), null, 0, 480, 0);
    if (b.hopY > 0) hopped++;
  }
  assert.equal(hopped, 0, 'not his line, no hop');
  // His bass lane note: the hop fires (and learns the bass register).
  conductor.fireEvent(Role.BASS, { vel: 0.9, pitch: 38, tMs: 1000, lane: 'BROSHI' });
  let peak = 0;
  for (let t = 850; t <= 1150; t += 10) {
    b.update(t, 1 / 100, fakeMidio(), null, 0, 480, 0);
    peak = Math.max(peak, b.hopY);
  }
  assert.ok(peak > 0, 'his bass line hops him');
});

test('lost traction (snow) makes the trailing spring visibly overshoot more', () => {
  const run = (traction) => {
    const conductor = fakeConductor();
    const b = new Broshi(conductor, {}, { seed: 9 });
    b.traction = traction;
    // Midio stands mid-frame here rather than at the default 200: a -300
    // displacement from screenX=200 is screen x=-100, which Broshi now
    // refuses to occupy (he is kept on frame). This test is about the
    // SPRING's behavior under traction, so give it room to swing in
    // legal space instead of measuring against the edge clamp.
    b._stageW = 1280;
    // Displaced from the set-point (now +200, since he runs point) but on
    // the same side of Midio as the target, so the spring's own damping is
    // what is being measured -- crossing Midio's column would drag the
    // render keep-out ease into the result and flatten both readings.
    b.xRel = 120;
    let overshoot = 0;
    for (let t = 0; t <= 6000; t += 16) {
      b.update(t, 16 / 1000, { screenX: 640 }, null, 0, 480, 0);
      overshoot = Math.max(overshoot, b.xRel - b._trailTarget);
    }
    return overshoot;
  };
  const icy = run(0.3), dry = run(1);
  assert.ok(icy > dry + 5, `icy overshoot (${icy}) must exceed dry (${dry})`);
});

test('kick flash queue: rapid kicks under Bluetooth-class latency still light every flash', () => {
  const conductor = fakeConductor();
  const b = new Broshi(conductor, {}, { seed: 11 });
  b.visualLagMs = 250;
  // Kicks every 200ms -- FASTER than the output latency. The old
  // overwrite-the-anchor scheme kept the anchor perpetually unheard and the
  // flash stayed at 0 forever; the queue promotes each at its heard moment.
  for (const t of [1000, 1200, 1400, 1600]) conductor.fireEvent(Role.RHYTHM, { kick: true, vel: 0.9, tMs: t });
  let peak = 0;
  for (let t = 1000; t <= 2200; t += 8) {
    b.update(t, 8 / 1000, fakeMidio(), null, 0, 480, 0);
    peak = Math.max(peak, b.beatFlash);
  }
  assert.ok(peak > 0.95, `expected full flashes despite latency >= kick interval, got peak ${peak}`);
});

test('dense runs: the busy guard finishes the current hop instead of flattening every hop', () => {
  const conductor = fakeConductor();
  const b = new Broshi(conductor, {}, { seed: 12 });
  // 16th-note spacing (100ms) -- denser than the 220ms anticipation lead.
  // Without the guard, note B's early delivery replaced note A's hop before
  // its window even opened and hopY stayed ~0 through the whole run.
  conductor.fireEvent(Role.MELODY, { vel: 0.8, pitch: 64, tMs: 1000 });
  conductor.fireEvent(Role.MELODY, { vel: 0.8, pitch: 66, tMs: 1100 });
  let peakAtA = 0;
  for (let t = 900; t <= 1080; t += 4) {
    b.update(t, 4 / 1000, fakeMidio(), null, 0, 480, 0);
    peakAtA = Math.max(peakAtA, b.hopY);
  }
  assert.ok(peakAtA > 10, `note A's hop must reach a real apex, got ${peakAtA}`);
});

test('bar density buckets by each note\'s own tMs, not by early delivery time', () => {
  const conductor = fakeConductor();
  const b = new Broshi(conductor, {}, { seed: 13 });
  // Three notes inside the bar, two anticipated notes belonging to the NEXT
  // bar (tMs past the boundary) delivered early by the lookahead channel.
  for (const t of [100, 200, 300]) conductor.fireEvent(Role.MELODY, { vel: 0.5, pitch: 60, tMs: t });
  for (const t of [520, 640]) conductor.fireEvent(Role.MELODY, { vel: 0.5, pitch: 60, tMs: t });
  conductor.fireBar(500);
  assert.equal(b._laneOnsetTimes.length, 2, 'the next bar\'s anticipated notes stay queued for it');
  assert.equal(b._barMelodyHistory.at(-1), 3, 'the closing bar counts only its own notes');
});

// --- Regression: draw() before the first update() must not crash ---
// A fresh restart (Play again / video export -- both now possible without a
// full page reload) can render the very first frame before any sim.step()
// has run, interpolating the just-constructed state. renderX/screenX/
// groundY used to be set only inside update() (they need `midio`'s live
// position), so that first draw() translated to NaN/NaN and threw inside
// ctx.createRadialGradient (drawGlowHalo), killing the whole render loop.

test('draw() before any update() renders at finite coordinates instead of throwing', () => {
  const conductor = fakeConductor();
  const b = new Broshi(conductor, {}, { seed: 21 });
  const ctx = fakeCtx();
  assert.doesNotThrow(() => b.draw(ctx));
  assert.ok(ctx.translates.length > 0, 'draw should have issued at least one canvas call');
  for (const t of ctx.translates) {
    for (const v of Object.values(t)) assert.ok(Number.isFinite(v), `non-finite coordinate: ${JSON.stringify(t)}`);
  }
});

// --- Keep-out: Midio must never land on Broshi ---

test('keepOutTarget: pushes a target inside the band to the last-held side, leaves clear targets alone', () => {
  // Default half is 165 (wide enough that the two draw-scaled silhouettes,
  // not just the physics hitboxes, clear each other).
  assert.equal(keepOutTarget(0, -1), -165);
  assert.equal(keepOutTarget(0, 1), 165);
  assert.equal(keepOutTarget(40, -1), -165, 'inside the band snaps to lastSide regardless of the target\'s own sign');
  assert.equal(keepOutTarget(-40, 1), 165);
  assert.equal(keepOutTarget(200, -1), 200, 'clear of the band, passes through unchanged');
  assert.equal(keepOutTarget(-220, 1), -220);
  assert.equal(keepOutTarget(165, -1), 165, 'exactly at the edge counts as clear');
  assert.equal(keepOutTarget(164.9, 1), 165);
});

test('cheerBumpY produces two bounded bumps and is zero outside them', () => {
  assert.equal(cheerBumpY(-5), 0);
  assert.ok(cheerBumpY(45) > 5, 'first bump peak');
  assert.equal(cheerBumpY(120), 0, 'the gap between bumps is flat');
  assert.ok(cheerBumpY(205) > 5, 'second bump peak');
  assert.equal(cheerBumpY(400), 0);
  for (let t = -10; t < 300; t += 5) assert.ok(Number.isFinite(cheerBumpY(t)) && cheerBumpY(t) >= -1e-9);
});

test('Broshi has no PANIC state -- obstacles are ambient only, his locomotion FSM is just TRAIL/SURGE', () => {
  const conductor = fakeConductor();
  const b = new Broshi(conductor, {}, { seed: 7 });
  const midio = fakeMidio();
  for (let t = 0; t < 5000; t += 16) {
    b.update(t, 1 / 60, midio, null, 0, 480, 0);
    assert.ok(b.state === 'TRAIL' || b.state === 'SURGE', `unexpected state ${b.state}`);
  }
});

test('Broshi shivers in snow and stays neutral without weather', () => {
  const conductor = fakeConductor();
  const midio = fakeMidio();
  const noWeather = new Broshi(conductor, {}, { seed: 3 });
  const snowy = new Broshi(conductor, {}, { seed: 3 });
  for (let t = 0; t < 500; t += 16) {
    noWeather.update(t, 1 / 60, midio, null, 0, 480, 0);
    snowy.update(t, 1 / 60, midio, null, 0, 480, 0, { weatherKind: 'snow', weatherIntensity: 0.8 });
  }
  assert.notEqual(snowy.squashX, noWeather.squashX, 'a shiver must perturb squashX away from the calm baseline');
});

test('Broshi shakes off periodically in rain', () => {
  const conductor = fakeConductor();
  const midio = fakeMidio();
  const b = new Broshi(conductor, {}, { seed: 11 });
  let sawShake = false;
  for (let t = 0; t < 6000; t += 16) {
    b.update(t, 1 / 60, midio, null, 0, 480, 0, { weatherKind: 'rain', weatherIntensity: 0.8 });
    if (Math.abs(b.squashX - 1) > 0.05) sawShake = true;
  }
  assert.ok(sawShake, 'a shake-off wobble must fire at least once over 6s of steady rain');
});

test('Broshi never renders inside Midio\'s landing column, across a scripted surge/trail/airborne stress sequence', () => {
  const conductor = fakeConductor();
  const b = new Broshi(conductor, {}, { seed: 42 });
  const midio = { screenX: 220 };
  let airborne = false;
  let worst = Infinity;
  for (let ms = 0; ms < 20000; ms += 16) {
    // Flip airborne state on a short cycle, and fire surge-triggering bar
    // energy spikes, to stress exactly the transition path the keep-out
    // logic has to defend.
    if (ms % 900 < 40) airborne = !airborne;
    if (ms % 1500 < 16) conductor.fireBar(ms);
    const ensemble = {
      trailX: midio.screenX + (Math.sin(ms / 733) > 0 ? -140 : 300), // sweeps across the danger zone
      phase: ms * 0.01, melt: 0,
      midioAirborne: airborne, midioY: airborne ? 150 : 0,
      justLanded: false, justClean: false, worldSpeed: 180,
    };
    b.update(ms, 0.016, midio, null, ms * 3, 540, 0.2, ensemble, null);
    worst = Math.min(worst, Math.abs(b.renderX - midio.screenX));
  }
  assert.ok(worst >= 55 - 1e-6, `renderX came within ${worst}px of the landing column`);
});

// Range v2 Task 1: drawing is render-only; it must never advance behaviour.
test('Broshi.draw does not consume the behavioural RNG', () => {
  const make = () => {
    const b = new Broshi(fakeConductor(), { get: () => 0 }, { seed: 4242 });
    b.rho = 0.8; // the serrated rho ring is the draw path that used to call rand()
    return b;
  };
  const drawn = make();
  const control = make();
  const pose = { x: 200, y: 400 };
  drawn.draw(fakeCtx(), pose);
  drawn.draw(fakeCtx(), pose);
  assert.equal(drawn.rand(), control.rand(), 'draw advanced the behaviour RNG');
  assert.equal(drawn.rho, control.rho);
});

test('Broshi rho ring shape is stable for one frame time and seed', () => {
  const pts = (b) => {
    const out = [];
    const ctx = fakeCtx();
    ctx.lineTo = (x, y) => out.push([x, y]);
    b.draw(ctx, { x: 0, y: 0 });
    return out;
  };
  const a = new Broshi(fakeConductor(), { get: () => 0 }, { seed: 7 });
  const b = new Broshi(fakeConductor(), { get: () => 0 }, { seed: 7 });
  a.rho = b.rho = 0.9;
  assert.deepEqual(pts(a), pts(a));
  assert.deepEqual(pts(a), pts(b));
});
