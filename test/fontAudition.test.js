import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuditionPlan, analyzeAudition, scoreAudition,
  estimatePitch, spectralCentroid, AUDITION,
} from '../src/audio/FontAudition.js';
import { Role, makeNoteEvent } from '../src/core/NoteEvent.js';
import { parseSf2 } from '../src/audio/Sf2Parser.js';
import { buildAuditionSf2 } from './helpers/sf2Fixture.js';

const SR = 22050;

// --- timeline fixtures -------------------------------------------------

/** Small song: one sustained melody voice + one drum voice, 6 s long —
 *  shorter than the excerpt window, so the whole song IS the excerpt. */
function smallTimeline() {
  const timeline = [];
  for (let i = 0; i < 6; i++) {
    timeline.push(makeNoteEvent({
      tMs: i * 900, durMs: 800, pitch: 60, vel: 0.8,
      role: Role.MELODY, src: 'midi', channel: 0, program: 0,
    }));
  }
  for (let i = 0; i < 10; i++) {
    timeline.push(makeNoteEvent({
      tMs: i * 550, durMs: 90, pitch: 36, vel: 0.9,
      role: Role.RHYTHM, src: 'midi', channel: 9, program: -1,
    }));
  }
  timeline.sort((a, b) => a.tMs - b.tMs);
  return { timeline, durationMs: 6000, bpm: 120 };
}

// --- rendered-PCM synthesis helpers ------------------------------------

function buffers(plan) {
  return {
    excerptData: new Float32Array(Math.ceil(plan.excerpt.renderDurationSec * SR)),
    probeData: new Float32Array(Math.ceil(plan.probes.renderDurationSec * SR)),
    sampleRate: SR,
  };
}

function addSine(data, startSec, durSec, hz, amp) {
  const a = Math.max(0, Math.round(startSec * SR));
  const b = Math.min(data.length, Math.round((startSec + durSec) * SR));
  for (let i = a; i < b; i++) {
    data[i] += amp * Math.sin((2 * Math.PI * hz * (i - a)) / SR);
  }
}

function addClick(data, startSec, amp = 0.6, durSec = 0.02) {
  const a = Math.max(0, Math.round(startSec * SR));
  const b = Math.min(data.length, Math.round((startSec + durSec) * SR));
  for (let i = a; i < b; i++) {
    const t = (i - a) / Math.max(1, b - a);
    data[i] += amp * (1 - t) * Math.sin((2 * Math.PI * 3000 * (i - a)) / SR);
  }
}

/** Renders what a HEALTHY font would do to this plan: sines through every
 *  pitched note's full duration (at `detuneOct` from the asked pitch),
 *  clicks on drums, correct loud/soft probe levels. */
function renderHealthy(plan, { detuneOct = 0, melodyAmp = 0.22 } = {}) {
  const r = buffers(plan);
  const hzOf = (pitch) => 440 * Math.pow(2, (pitch - 69) / 12) * Math.pow(2, detuneOct);
  for (const e of plan.excerpt.events) {
    if (e.role === Role.RHYTHM) addClick(r.excerptData, e.tMs / 1000, 0.5);
    else addSine(r.excerptData, e.tMs / 1000, e.durMs / 1000, hzOf(e.pitch), melodyAmp);
  }
  for (const p of plan.probes.probes) {
    for (const [start, amp] of [[p.loudStartSec, 0.28], [p.softStartSec, 0.09]]) {
      if (p.pitched) addSine(r.probeData, start, p.noteDurSec, hzOf(p.pitch), amp);
      else addClick(r.probeData, start, amp * 2);
    }
  }
  return r;
}

/** Renders the percussion-only failure: every note, pitched or not, comes
 *  out as a decaying onset click and nothing sustains. */
function renderSpikesOnly(plan) {
  const r = buffers(plan);
  for (const e of plan.excerpt.events) addClick(r.excerptData, e.tMs / 1000, 0.55);
  for (const p of plan.probes.probes) {
    addClick(r.probeData, p.loudStartSec, 0.55);
    addClick(r.probeData, p.softStartSec, 0.3);
  }
  return r;
}

// --- plan building ------------------------------------------------------

test('plan: one probe group per distinct (role, program, channel) voice', () => {
  const plan = buildAuditionPlan(smallTimeline());
  assert.ok(plan);
  assert.equal(plan.groups.length, 2);
  const melody = plan.groups.find((g) => g.role === Role.MELODY);
  const rhythm = plan.groups.find((g) => g.role === Role.RHYTHM);
  assert.ok(melody && rhythm);
  assert.equal(melody.pitched, true);
  assert.equal(melody.pitch, 60); // the register the song actually uses
  assert.equal(rhythm.pitched, false);
  // Two probe notes (loud + soft) per group
  assert.equal(plan.probes.events.length, 4);
  assert.equal(plan.probes.probes.length, 2);
});

test('plan: probes are isolated — consecutive probe notes never overlap', () => {
  const plan = buildAuditionPlan(smallTimeline());
  const starts = plan.probes.events.map((e) => e.tMs).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= AUDITION.PROBE_NOTE_SEC * 1000,
      `probe notes ${i - 1}/${i} overlap: ${starts[i - 1]} -> ${starts[i]}`);
  }
});

test('plan: excerpt slides to the densest, most voice-diverse window', () => {
  // Sparse lonely note at t=0; the real ensemble lives at 30–40 s.
  const timeline = [makeNoteEvent({
    tMs: 0, durMs: 200, pitch: 50, vel: 0.5, role: Role.BASS, src: 'midi', channel: 1, program: 33,
  })];
  for (let i = 0; i < 40; i++) {
    timeline.push(makeNoteEvent({
      tMs: 30000 + i * 240, durMs: 500, pitch: 62, vel: 0.8, role: Role.MELODY, src: 'midi', channel: 0, program: 0,
    }));
    timeline.push(makeNoteEvent({
      tMs: 30000 + i * 240, durMs: 90, pitch: 36, vel: 0.9, role: Role.RHYTHM, src: 'midi', channel: 9, program: -1,
    }));
  }
  const plan = buildAuditionPlan({ timeline, durationMs: 60000 });
  assert.ok(plan.excerpt.startMs >= 28000 && plan.excerpt.startMs <= 32000,
    `excerpt window landed at ${plan.excerpt.startMs}`);
  assert.ok(plan.excerpt.events.length > 40);
  assert.ok(plan.excerpt.sustainWindows.length > 0);
});

test('plan: dense voices are thinned, sparse voices survive intact', () => {
  const timeline = [];
  for (let i = 0; i < 4000; i++) {
    timeline.push(makeNoteEvent({
      tMs: i * 2, durMs: 40, pitch: 42, vel: 0.7, role: Role.RHYTHM, src: 'midi', channel: 9, program: -1,
    }));
  }
  for (let i = 0; i < 12; i++) {
    timeline.push(makeNoteEvent({
      tMs: i * 700, durMs: 600, pitch: 64, vel: 0.8, role: Role.MELODY, src: 'midi', channel: 0, program: 0,
    }));
  }
  timeline.sort((a, b) => a.tMs - b.tMs);
  const plan = buildAuditionPlan({ timeline, durationMs: 9000 });
  const melodyKept = plan.excerpt.events.filter((e) => e.role === Role.MELODY).length;
  assert.equal(melodyKept, 12, 'sparse melody voice must not be thinned away');
  assert.ok(plan.excerpt.events.length <= AUDITION.MAX_EXCERPT_EVENTS + 2 * 24 + 1,
    `excerpt still too dense: ${plan.excerpt.events.length}`);
});

test('plan: empty timeline -> no plan', () => {
  assert.equal(buildAuditionPlan({ timeline: [], durationMs: 0 }), null);
  assert.equal(buildAuditionPlan(null), null);
});

// --- DSP primitives -----------------------------------------------------

test('estimatePitch nails a clean sine within a few cents', () => {
  const data = new Float32Array(SR);
  addSine(data, 0, 1, 440, 0.5);
  const { f0, clarity } = estimatePitch(data, 1000, 8000, SR);
  assert.ok(clarity > 0.8, `clarity ${clarity}`);
  assert.ok(Math.abs(Math.log2(f0 / 440)) < 0.01, `f0 ${f0}`);
});

test('spectralCentroid sits near a pure tone', () => {
  const data = new Float32Array(SR);
  addSine(data, 0, 1, 1000, 0.5);
  const c = spectralCentroid(data, 2000, 4096, SR);
  assert.ok(c > 700 && c < 1400, `centroid ${c}`);
});

// --- verdicts on synthetic renders --------------------------------------

test('healthy render qualifies with a solid score', () => {
  const plan = buildAuditionPlan(smallTimeline());
  const verdict = scoreAudition(analyzeAudition(renderHealthy(plan), plan));
  assert.equal(verdict.disqualified, null, `DQ'd as ${verdict.disqualified}`);
  assert.ok(verdict.score >= 55, `score only ${verdict.score}`);
  assert.ok(verdict.parts.coverage > 0.95, `coverage ${verdict.parts.coverage}`);
});

test('hard rule: silence disqualifies', () => {
  const plan = buildAuditionPlan(smallTimeline());
  const verdict = scoreAudition(analyzeAudition(buffers(plan), plan));
  assert.equal(verdict.disqualified, 'silent');
});

test('hard rule: onset-aligned spikes with dead sustains disqualify', () => {
  const plan = buildAuditionPlan(smallTimeline());
  const verdict = scoreAudition(analyzeAudition(renderSpikesOnly(plan), plan));
  assert.equal(verdict.disqualified, 'spikes');
});

test('hard rule: pitched content octaves below the score disqualifies', () => {
  const plan = buildAuditionPlan(smallTimeline());
  const rendered = renderHealthy(plan, { detuneOct: -2 });
  const verdict = scoreAudition(analyzeAudition(rendered, plan));
  assert.equal(verdict.disqualified, 'register');
});

test('hard rule: heavy clipping disqualifies', () => {
  const plan = buildAuditionPlan(smallTimeline());
  const rendered = renderHealthy(plan);
  // Slam the whole excerpt into a full-scale square wave
  for (let i = 0; i < rendered.excerptData.length; i++) {
    const v = rendered.excerptData[i];
    if (Math.abs(v) > 0.01) rendered.excerptData[i] = v > 0 ? 1.0 : -1.0;
  }
  const verdict = scoreAudition(analyzeAudition(rendered, plan));
  assert.equal(verdict.disqualified, 'clipping');
});

test('a slightly detuned font is penalized but NOT disqualified', () => {
  const plan = buildAuditionPlan(smallTimeline());
  const clean = scoreAudition(analyzeAudition(renderHealthy(plan), plan));
  const detuned = scoreAudition(analyzeAudition(renderHealthy(plan, { detuneOct: 0.5 }), plan));
  assert.equal(detuned.disqualified, null);
  assert.ok(detuned.score < clean.score,
    `detuned (${detuned.score}) should rank below clean (${clean.score})`);
});

test('drums-only MIDI: clicks are the CORRECT sound, no spikes DQ', () => {
  const timeline = [];
  for (let i = 0; i < 30; i++) {
    timeline.push(makeNoteEvent({
      tMs: i * 250, durMs: 90, pitch: i % 2 ? 38 : 36, vel: 0.9,
      role: Role.RHYTHM, src: 'midi', channel: 9, program: -1,
    }));
  }
  const plan = buildAuditionPlan({ timeline, durationMs: 8000 });
  const r = buffers(plan);
  for (const e of plan.excerpt.events) addClick(r.excerptData, e.tMs / 1000, 0.5);
  for (const p of plan.probes.probes) {
    addClick(r.probeData, p.loudStartSec, 0.5);
    addClick(r.probeData, p.softStartSec, 0.25);
  }
  const verdict = scoreAudition(analyzeAudition(r, plan));
  assert.equal(verdict.disqualified, null,
    `a drum font on a drum MIDI got DQ'd as ${verdict.disqualified}`);
});

test('quieter-but-complete beats louder-but-half-missing', () => {
  const plan = buildAuditionPlan(smallTimeline());
  const complete = renderHealthy(plan, { melodyAmp: 0.08 });
  // "Half missing": drums render, melody (the heavier voice) is silent.
  const missing = buffers(plan);
  for (const e of plan.excerpt.events) {
    if (e.role === Role.RHYTHM) addClick(missing.excerptData, e.tMs / 1000, 0.5);
  }
  for (const p of plan.probes.probes) {
    if (!p.pitched) {
      addClick(missing.probeData, p.loudStartSec, 0.5);
      addClick(missing.probeData, p.softStartSec, 0.25);
    }
  }
  const vComplete = scoreAudition(analyzeAudition(complete, plan));
  const vMissing = scoreAudition(analyzeAudition(missing, plan));
  if (vMissing.disqualified === null) {
    assert.ok(vComplete.score > vMissing.score,
      `complete-quiet (${vComplete.score}) must outrank half-missing (${vMissing.score})`);
  }
  assert.equal(vComplete.disqualified, null);
});

// --- fixture sanity: the parameterized SF2 the smoke test leans on ------

test('buildAuditionSf2 parses into the expected single preset/zone', () => {
  const parsed = parseSf2(buildAuditionSf2({ name: 'FixtureCheck', rootKey: 72, bank: 0, program: 5 }));
  assert.equal(parsed.name, 'FixtureCheck');
  const preset = parsed.presets.get(5);
  assert.ok(preset, 'preset (bank 0, program 5) exists');
  assert.equal(preset.zones.length, 1);
  assert.equal(parsed.samples[preset.zones[0].sampleIndex].rootKey, 72);
  assert.equal(preset.zones[0].loopMode, 1);
});

test('buildAuditionSf2 silent variant really is all-zero PCM', () => {
  const parsed = parseSf2(buildAuditionSf2({ silent: true }));
  let peak = 0;
  for (const v of parsed.sampleData) peak = Math.max(peak, Math.abs(v));
  assert.equal(peak, 0);
});
