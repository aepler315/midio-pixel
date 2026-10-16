// The demo song is a choreography oracle: we wrote the notes, so we know
// when Midio should jump, when a lead stab should pop a double-jump, when
// the trio should become a disc, and when nobody should leave the ground.
// runChoreo steps the same character path Simulation uses; expectedChoreography
// is the score's intent. When they disagree, the song is right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoSong, expectedChoreography, DEMO_BPM, DEMO_DURATION_MS, SECTIONS, BAR_MS } from '../src/core/DemoSong.js';
import { runChoreo, STEP_MS } from '../src/sim/ChoreoHarness.js';
import { renderDemoSongPcm } from '../src/audio/DemoSongRender.js';
import { HypeDirector } from '../src/sim/HypeDirector.js';
import { Lane } from '../src/core/Casting.js';
import { Role } from '../src/core/NoteEvent.js';

const SLACK = STEP_MS + 1; // one sim step of dispatch quantization

function nearest(times, t) {
  if (!times.length) return Infinity;
  let best = Math.abs(times[0] - t);
  for (let i = 1; i < times.length; i++) best = Math.min(best, Math.abs(times[i] - t));
  return best;
}

function inWindow(t, fromMs, toMs) { return t >= fromMs && t < toMs; }

const song = buildDemoSong();
const expect = expectedChoreography(song);
const { log, chart, energy } = runChoreo(song);

test('the score is a real song: 48 bars at 120, with every named section', () => {
  assert.equal(song.bpm, DEMO_BPM);
  assert.equal(song.durationMs, DEMO_DURATION_MS);
  assert.equal(song.barGrid.length, 48);
  assert.ok(SECTIONS.length >= 8);
  assert.ok(song.timeline.length > 200, `sparse score? ${song.timeline.length} events`);
  const lanes = new Set(song.timeline.map((e) => e.lane).filter(Boolean));
  assert.ok(lanes.has(Lane.BROSHI) && lanes.has(Lane.MIDASUS) && lanes.has(Lane.MIDIO),
    'the trio must each own a lane so hops / melody / double-jumps route');
});

test('every kick is a chart tap (or a landing-tie relaunch) — none are swallowed', () => {
  const taps = chart.notes.filter((n) => n.type === 'tap').map((n) => n.tMs);
  for (const k of expect.kicks) {
    assert.ok(nearest(taps, k.tMs) <= SLACK,
      `kick at ${k.tMs}ms never became a chart tap — Midio would skip the beat`);
  }
});

test('Midio leaves the ground on every chart tap, within one sim step', () => {
  assert.ok(log.takeoffs.length >= 20, `too few takeoffs: ${log.takeoffs.length}`);
  for (const tap of chart.notes.filter((n) => n.type === 'tap')) {
    // A tap that lands exactly on a landing-tie still relaunches; the
    // takeoff log fires on the grounded→airborne edge, which is this tap.
    assert.ok(nearest(log.takeoffs, tap.tMs) <= SLACK * 2,
      `chart tap at ${tap.tMs}ms had no takeoff nearby (nearest ${nearest(log.takeoffs, tap.tMs).toFixed(1)}ms)`);
  }
});

test('the rest / break has no kicks and Midio does not jump through it', () => {
  assert.ok(expect.restWindows.length >= 1);
  for (const w of expect.restWindows) {
    const kicksInside = expect.kicks.filter((k) => inWindow(k.tMs, w.fromMs, w.toMs));
    assert.equal(kicksInside.length, 0, `${w.id} should be kickless`);
    const jumpsInside = log.takeoffs.filter((t) => inWindow(t, w.fromMs + 50, w.toMs - 50));
    assert.equal(jumpsInside.length, 0,
      `${w.id} should be still; takeoffs at ${jumpsInside}`);
  }
});

test('each authored lead stab double-jumps — that is the fill', () => {
  assert.ok(expect.airJumpOnsets.length >= 2, 'the fill must author at least two stabs');
  assert.ok(log.airJumps.length >= expect.airJumpOnsets.length,
    `expected ${expect.airJumpOnsets.length} air jumps, got ${log.airJumps.length} at ${log.airJumps}`);
  for (const t of expect.airJumpOnsets) {
    assert.ok(nearest(log.airJumps, t) <= SLACK * 2,
      `lead stab at ${t}ms did not air-jump (nearest ${nearest(log.airJumps, t).toFixed(1)}ms). ` +
      `Airborne accent notes are Simulation's double-jump path.`);
  }
});

test('the trio becomes a disc on the drop AND the chorus-2 flourish, not before', () => {
  assert.equal(expect.discs.length, 2);
  assert.ok(log.discs.length >= 2, `disc fires: ${JSON.stringify(log.discs)}`);
  for (const d of expect.discs) {
    const times = log.discs.map((x) => x.tMs);
    assert.ok(nearest(times, d.tMs) <= SLACK * 2,
      `${d.kind} at ${d.tMs}ms never spun the trio (discs at ${times})`);
  }
  // Intro + verse (first 16s) must not spin — there is nothing to punctuate.
  const early = log.discs.filter((d) => d.tMs < 16 * 1000);
  assert.equal(early.length, 0, `disc during intro/verse: ${JSON.stringify(early)}`);
  // And never inside the rest window.
  for (const w of expect.restWindows) {
    const inside = log.discs.filter((d) => inWindow(d.tMs, w.fromMs, w.toMs));
    assert.equal(inside.length, 0, `disc during ${w.id}: ${JSON.stringify(inside)}`);
  }
});

test('disc spins are at least the 6s floor apart so the 420ms move always resolves', () => {
  const times = log.discs.map((d) => d.tMs).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] - times[i - 1] >= 6000,
      `discs ${times[i - 1]} and ${times[i]} are only ${times[i] - times[i - 1]}ms apart`);
  }
});

test('Broshi and Midasus both catch the disc cue', () => {
  assert.ok(log.midasusDisc.length >= 1, 'Midasus never started a disc');
  for (const d of expect.discs) {
    assert.ok(nearest(log.midasusDisc, d.tMs) <= SLACK * 2,
      `Midasus missed the ${d.kind} disc at ${d.tMs}`);
  }
});

test('hot chorus takeoffs pull a trick from the book', () => {
  assert.ok(log.tricks.length >= 4, `only ${log.tricks.length} tricks in a song with two choruses`);
  const hotTricks = log.tricks.filter((tr) => expect.hotWindows.some((w) => inWindow(tr.tMs, w.fromMs, w.toMs)));
  assert.ok(hotTricks.length >= 3, `chorus tricks: ${hotTricks.length}`);
  const types = new Set(log.tricks.map((tr) => tr.type));
  assert.ok(types.size >= 2, `trick book too thin: ${[...types]}`);
});

test('Broshi hops his bass line — not every kick, the actual bass notes', () => {
  assert.ok(log.hops.length >= 10, `Broshi barely hopped (${log.hops.length})`);
  // Apex-on-beat: hops peak ON the bass note, so the hopY-rising edge is
  // a rise-time early. Accept a 250ms lead.
  let matched = 0;
  for (const t of expect.bassNotes) {
    if (nearest(log.hops, t) <= 260) matched++;
  }
  assert.ok(matched >= expect.bassNotes.length * 0.5,
    `only ${matched}/${expect.bassNotes.length} bass notes produced a hop`);
});

test('the authored drop is visible to HypeDirector from energy, not only from the cue', () => {
  // A second director, no conductor cues — this is what a raw-audio drop
  // of the same mix has to look like.
  const h = new HypeDirector();
  const dropAt = expect.drops[0];
  const dt = 1 / 120;
  for (let t = 0; t <= dropAt + 1500; t += 1000 / 120) h.update(t, dt, energy);
  assert.ok(h.dropCount >= 1, 'quiet-then-loud mix never registered as a drop');
  assert.ok(Math.abs(h.dropAtMs - dropAt) < 1500,
    `energy drop at ${h.dropAtMs}ms, authored drop at ${dropAt}ms`);
});

test('the coda calm cue actually raises calm', () => {
  assert.ok(expect.calms.length >= 1);
  const cueAt = expect.calms[0];
  const calmAfter = log.calmAt.filter((t) => t >= cueAt && t <= cueAt + 3000);
  assert.ok(calmAfter.length > 50, `calm never rose after the coda cue at ${cueAt}`);
});

test('the rendered audio peaks on kicks and is quiet in the break', () => {
  const pcm = renderDemoSongPcm(song, { sampleRate: 22050, stereo: false });
  const sr = pcm.sampleRate;
  const rms = (fromMs, toMs) => {
    const a = Math.floor(fromMs / 1000 * sr);
    const b = Math.min(pcm.length, Math.floor(toMs / 1000 * sr));
    let s = 0, n = 0;
    for (let i = a; i < b; i++) { s += pcm.left[i] * pcm.left[i]; n++; }
    return n ? Math.sqrt(s / n) : 0;
  };
  const kick = expect.kicks.find((k) => k.tMs > 32000 && k.tMs < 34000);
  assert.ok(kick, 'expected a drop-bar kick');
  const kickRms = rms(kick.tMs, kick.tMs + 80);
  const breakWin = expect.restWindows[0];
  const breakRms = rms(breakWin.fromMs + 400, breakWin.fromMs + 1600);
  assert.ok(kickRms > 0.05, `kick is inaudible (rms ${kickRms})`);
  assert.ok(kickRms > breakRms * 2,
    `drop kick (${kickRms.toFixed(3)}) should dwarf the break (${breakRms.toFixed(3)})`);
});

test('casting: Midio lead notes exist only in the fill, so verse bass cannot steal air-jumps', () => {
  const lead = song.timeline.filter((e) => e.lane === Lane.MIDIO);
  assert.ok(lead.every((e) => e.tMs >= 28 * BAR_MS && e.tMs < 32 * BAR_MS),
    `lead stabs leaked out of the fill: ${lead.map((e) => e.tMs)}`);
  const verseBassOffbeat = song.timeline.filter((e) =>
    e.role === Role.BASS && e.tMs < 16 * BAR_MS && Math.round((e.tMs % BAR_MS) / (BAR_MS / 4)) % 2 === 1);
  assert.equal(verseBassOffbeat.length, 0, 'off-beat bass would double-jump the verse');
});
