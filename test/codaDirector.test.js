import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodaDirector, DESATURATE_MAX } from '../src/sim/CodaDirector.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { smoothstep } from '../src/utils/math.js';

const DURATION = 120000; // 2 minutes

test('unravel is 0 well before the ending arc starts, and stays 0 up to exactly durationMs-18000', () => {
  const coda = new CodaDirector(DURATION);
  coda.update(0);
  assert.equal(coda.unravel, 0);
  assert.equal(coda.active, false);
  coda.update(DURATION - 20000);
  assert.equal(coda.unravel, 0);
  coda.update(DURATION - 18000);
  assert.equal(coda.unravel, 0);
});

test('unravel reaches (and holds at) 1 by durationMs-4000 when the music plays to the end of the file', () => {
  const coda = new CodaDirector(DURATION);
  coda.update(DURATION - 4000);
  assert.equal(coda.unravel, 1);
  coda.update(DURATION - 1000);
  assert.equal(coda.unravel, 1, 'unravel must hold at 1 through novae/freeze/shatter, never drop back');
  coda.update(DURATION);
  assert.equal(coda.unravel, 1);
});

test('unravel is a monotonically non-decreasing curve across the full ending arc', () => {
  const coda = new CodaDirector(DURATION);
  let prev = -1;
  for (let ms = DURATION - 19000; ms <= DURATION; ms += 50) {
    coda.update(ms);
    assert.ok(coda.unravel >= prev - 1e-12, `unravel dipped at ${ms}: ${coda.unravel} < ${prev}`);
    prev = coda.unravel;
  }
});

test('active flips true early in the ramp, and the transition through the arc is smooth (no jump)', () => {
  const coda = new CodaDirector(DURATION);
  coda.update(DURATION - 18000);
  assert.equal(coda.active, false);
  // Smoothstep grows quadratically near its start, so "active" (unravel
  // crosses a small epsilon) takes on the order of a few hundred ms into
  // the 14s ramp, not the very first millisecond -- confirm it does flip
  // well before the ramp is meaningfully underway.
  coda.update(DURATION - 17000);
  assert.equal(coda.active, true);
  // Smoothstep continuity: a 1ms step must not jump the curve far.
  const a = coda.unravel;
  coda.update(DURATION - 16999);
  assert.ok(coda.unravel - a < 0.01, 'unravel must ease in smoothly, not jump');
});

test('free-time audio (durationMs<=0) is a clean no-op: unravel stays 0 and active stays false at any nowMs', () => {
  const coda = new CodaDirector(0);
  for (const t of [0, 1000, 50000, 999999]) {
    coda.update(t);
    assert.equal(coda.unravel, 0);
    assert.equal(coda.active, false);
  }
  const coda2 = new CodaDirector(); // default durationMs
  coda2.update(100000);
  assert.equal(coda2.unravel, 0);
});

// --- Cadence: the music's last audible moment, not the file clock ---

/** Real analysis curves: music (normalized bands and physical RMS) until
 *  `audibleUntilMs`, then digital silence for the rest of the file. */
function songCurves(durationMs, audibleUntilMs, { rms = true, fill = .6 } = {}) {
  const c = new EnergyCurves(durationMs);
  for (let i = 0; i < c.n; i++) c.setFrame(i, Array(7).fill(i * 20 < audibleUntilMs ? fill : 0));
  if (rms) c.rmsBands = Array.from({ length: 7 }, () => Float32Array.from({ length: c.n }, (_, i) => i * 20 < audibleUntilMs ? .05 : 0));
  return c;
}
const legacy = t => smoothstep(DURATION - 18000, DURATION - 4000, t);

test('a long silent tail moves the whole unraveling onto the cadence', () => {
  const cadence = DURATION - 20000;
  const coda = new CodaDirector(DURATION, songCurves(DURATION, cadence));
  assert.equal(coda.cadenceMs, cadence);
  coda.update(cadence - 15000);
  assert.equal(coda.unravel, 0, 'the world is still whole 15 s before the music stops');
  coda.update(cadence);
  assert.ok(coda.unravel > .95, `nearly unravelled as the music stops: ${coda.unravel}`);
  coda.update(cadence + 1500);
  assert.equal(coda.unravel, 1);
  for (const t of [cadence + 5000, DURATION - 4000, DURATION]) { coda.update(t); assert.equal(coda.unravel, 1, `holds through the tail at ${t}`); }
  let prev = -1;
  for (let ms = cadence - 16000; ms <= DURATION; ms += 50) {
    coda.update(ms);
    assert.ok(coda.unravel >= prev - 1e-12, `unravel dipped at ${ms}`);
    prev = coda.unravel;
  }
});

test('a song that plays to the end of the file keeps the file-clock arc', () => {
  for (const curves of [songCurves(DURATION, Infinity), songCurves(DURATION, Infinity, { rms: false }), null,
    songCurves(DURATION, DURATION - 2000)]) {
    const coda = new CodaDirector(DURATION, curves);
    for (let ms = DURATION - 20000; ms <= DURATION; ms += 100) {
      coda.update(ms);
      assert.ok(Math.abs(coda.unravel - legacy(ms)) < 1e-12, `${ms}: ${coda.unravel} vs ${legacy(ms)}`);
    }
  }
});

test('curves without physical RMS find the cadence through the normalized-band gate', () => {
  const cadence = DURATION - 30000;
  const coda = new CodaDirector(DURATION, songCurves(DURATION, cadence, { rms: false }));
  assert.equal(coda.cadenceMs, cadence);
  coda.update(cadence + 1500);
  assert.equal(coda.unravel, 1);
  coda.update(cadence - 13000);
  assert.equal(coda.unravel, 0);
});

test('recording hiss below the physical floor is not music', () => {
  const c = songCurves(DURATION, DURATION - 20000);
  // Normalized bands amplify the tail's hiss; the physical RMS shows it is noise.
  for (let i = 0; i < c.n; i++) if (i * 20 >= DURATION - 20000) c.setFrame(i, Array(7).fill(.4));
  c.rmsBands.forEach(band => band.fill(1e-6, Math.ceil((DURATION - 20000) / 20)));
  assert.equal(new CodaDirector(DURATION, c).cadenceMs, DURATION - 20000);
});

test('curves that stop short of the song (an opening analysis) leave the file clock in charge', () => {
  const opening = songCurves(30000, 30000);
  const coda = new CodaDirector(DURATION, opening);
  assert.equal(coda.cadenceMs, DURATION);
  coda.update(30000);
  assert.equal(coda.unravel, 0);
  coda.update(DURATION - 4000);
  assert.equal(coda.unravel, 1);
});

test('a fresh coda at any heard time equals continuous updates', () => {
  const curves = songCurves(DURATION, DURATION - 12000);
  const played = new CodaDirector(DURATION, curves);
  for (let ms = 0; ms <= DURATION; ms += 37) {
    played.update(ms);
    const seeked = new CodaDirector(DURATION, curves);
    seeked.update(ms);
    assert.equal(seeked.unravel, played.unravel, `${ms}`);
    assert.equal(seeked.active, played.active);
  }
});

test('free time stays a no-op even with curves', () => {
  const coda = new CodaDirector(0, songCurves(DURATION, DURATION - 20000));
  for (const t of [0, 90000, DURATION]) { coda.update(t); assert.equal(coda.unravel, 0); assert.equal(coda.active, false); }
});

// --- Desaturation ---

test('desaturation ramps 0 -> DESATURATE_MAX in lockstep with unravel, and never exceeds the cap', () => {
  const coda = new CodaDirector(DURATION);
  coda.update(DURATION - 18000);
  assert.equal(coda.desaturation, 0);
  coda.update(DURATION - 4000);
  assert.ok(Math.abs(coda.desaturation - DESATURATE_MAX) < 1e-9);
  for (let ms = DURATION - 18000; ms <= DURATION; ms += 200) {
    coda.update(ms);
    assert.ok(coda.desaturation >= -1e-9 && coda.desaturation <= DESATURATE_MAX + 1e-9);
  }
});

// --- Parallax delamination ---

test('delaminateRatio(base, 0) is an exact no-op', () => {
  for (const base of [0.05, 0.10, 0.18, 0.30, 0.65, 1.00, 1.20]) {
    assert.equal(CodaDirector.delaminateRatio(base, 0), base);
  }
});

test('delaminateRatio spreads farther layers less than nearer ones, and never shrinks a ratio', () => {
  const far = CodaDirector.delaminateRatio(0.05, 1);   // L1-ish
  const near = CodaDirector.delaminateRatio(1.20, 1);  // L7-ish
  assert.ok(far >= 0.05, 'a layer ratio must never shrink under unravel');
  assert.ok(near > 1.20, 'the nearest layer must visibly race ahead at full unravel');
  const farSpread = (far - 0.05) / 0.05;
  const nearSpread = (near - 1.20) / 1.20;
  assert.ok(nearSpread > farSpread, `expected the near layer to spread proportionally more: far=${farSpread}, near=${nearSpread}`);
});

test('delaminateRatio is monotonically increasing in unravel for a fixed base ratio', () => {
  const base = 0.65;
  let prev = CodaDirector.delaminateRatio(base, 0);
  for (let u = 0.1; u <= 1; u += 0.1) {
    const r = CodaDirector.delaminateRatio(base, u);
    assert.ok(r >= prev, 'ratio must not decrease as unravel increases');
    prev = r;
  }
});

test('delaminateRatio stays within a sane bound (spec: up to 1 + 0.25*unravel, spread by depth)', () => {
  // The nearest real layer ratio in the stack is 1.20 (L7); even there,
  // full unravel should not multiply the ratio by more than ~1.4x.
  const r = CodaDirector.delaminateRatio(1.20, 1);
  assert.ok(r / 1.20 < 1.4, `L7 spread too aggressive: x${(r / 1.20).toFixed(3)}`);
});
