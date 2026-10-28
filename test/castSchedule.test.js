// The cast's per-view jobs over a song (CastSchedule.js): when each view's
// work happens, when it finishes, and when its lights kindle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileCastSchedule, CAST_STEP_MS } from '../src/world/alpine/CastSchedule.js';

// A-B-A-B-C-B, 30 s each, one view per label; C is the climax.
const FORM = 'ABABCB';
const sections = FORM.split('').map((label, i) => ({ label, startMs: i * 30000, endMs: (i + 1) * 30000, barMs: 2000 }));
const VIEW = { A: 'va', B: 'vb', C: 'vc' };
const viewForSection = (s) => VIEW[s.label];
const phrases = sections.map((s) => ({ startMs: s.startMs, endMs: s.endMs, relEnergy01: { A: 0.3, B: 0.6, C: 0.9 }[s.label] }));
const lanes = { at: (t) => ({ midio: { glow: 0.5 + 0.5 * Math.sin(t / 3000) }, broshi: { glow: (t / 7000) % 1 }, midasus: { glow: 0.3 } }) };
// Broshi plays on every beat, offset by 120 ms.
const onsets = { midio: [], midasus: [], broshi: Array.from({ length: 360 }, (_, i) => i * 500 + 120) };
const base = { sections, viewForSection, phrases, lanes, onsets, durationMs: 180000 };
// The no-phrase fallback's energy: one loud stretch at 100-104 s.
const energyAt = (t) => (t > 100000 && t < 104000 ? 1 : 0.2);

test('each view finishes on its structural milestone, monotonically', () => {
  const s = compileCastSchedule(base);
  assert.equal(s.climaxViewId, 'vc');
  // Climax: the phrase start plus min(4 s, 25% of the phrase).
  assert.equal(s.views.vc.finishMs, 124000);
  // Others: 85% through their last stay.
  assert.equal(s.views.va.finishMs, 60000 + 0.85 * 30000);
  assert.equal(s.views.vb.finishMs, 150000 + 0.85 * 30000);
  for (const v of ['va', 'vb', 'vc']) {
    const F = s.views[v].finishMs;
    let last = 0;
    for (let t = 0; t <= 180000; t += 250) {
      const p = s.stateOf(v, t).p;
      assert.ok(p >= last - 1e-9, `${v} monotone at ${t}`);
      last = p;
    }
    assert.ok(s.stateOf(v, F - 200).p < 1, `${v} not done before its finish`);
    assert.equal(s.stateOf(v, F).p, 1);
  }
});

test('progress holds outside a view and resumes from its camp on return', () => {
  const s = compileCastSchedule(base);
  const camp = s.stateOf('va', 30000).p;
  assert.ok(camp > 0.2 && camp < 0.8, `first camp at ${camp}`);
  assert.deepEqual(s.views.va.camps.map((k) => k.atMs), [30000, 90000]);
  assert.ok(Math.abs(s.views.va.camps[0].p - camp) < 1e-9);
  for (const t of [35000, 45000, 59990]) assert.equal(s.stateOf('va', t).p, camp, `frozen at ${t}`);
  assert.ok(s.stateOf('va', 61000).p > camp);
  // The team close up into the camp at the end of a stay and set out from
  // it on return.
  assert.equal(s.stateOf('va', 30000).gather01, 1);
  assert.equal(s.stateOf('va', 60000).gather01, 1);
  assert.equal(s.stateOf('va', 63000).gather01, 0);
  // A frozen view keeps its gaps: the outgoing side holds still.
  assert.deepEqual(s.stateOf('va', 40000).offsets, s.stateOf('va', 50000).offsets);
  assert.equal(s.stateOf('va', 40000).camps, 1);
});

test('storms slow the work, except on the climax push', () => {
  const calm = compileCastSchedule(base);
  const stormy = compileCastSchedule({ ...base, episodes: [{ startMs: 98000, endMs: 112000 }, { startMs: 121000, endMs: 140000 }] });
  // vb's second stay (90-120 s) is slowed by its storm, but still finishes
  // on time later.
  const at = (s) => s.stateOf('vb', 112000).p - s.stateOf('vb', 98000).p;
  assert.ok(at(stormy) < at(calm) * 0.5, `${at(stormy)} vs ${at(calm)}`);
  assert.ok(stormy.stateOf('vb', 105000).shelter01 > 0.99);
  assert.equal(stormy.stateOf('vb', stormy.views.vb.finishMs).p, 1);
  // vc's climax stay pushes on through its storm.
  for (const t of [121000, 122000, 123500]) assert.ok(Math.abs(stormy.stateOf('vc', t).p - calm.stateOf('vc', t).p) < 1e-9);
  assert.equal(stormy.stateOf('vc', 125000).weather, 1);
});

test('lights kindle on the lane within one beat of when the follower reaches them', () => {
  const s = compileCastSchedule(base);
  const marks = Array.from({ length: 12 }, (_, k) => ({ p: (k + 1) / 13, follow: 'broshi', lane: 'broshi' }));
  const times = s.kindleTimes('vb', marks);
  assert.equal(s.kindleTimes('vb', marks), times, 'memoized');
  let before = -Infinity;
  marks.forEach((m, k) => {
    assert.ok(Number.isFinite(times[k]), `mark ${k} lit`);
    // Scheduled: the first time Broshi's position reaches the mark.
    let due = null;
    for (let t = 0; t <= 180000 && due == null; t += CAST_STEP_MS) {
      const st = s.stateOf('vb', t);
      if (st.p - st.offsets.broshi >= m.p - 1e-6) due = t;
    }
    assert.ok(Math.abs(times[k] - due) <= 500 + CAST_STEP_MS, `mark ${k}: ${times[k]} vs ${due}`);
    assert.equal((times[k] - 120) % 500, 0, `mark ${k} on an onset`);
    assert.ok(times[k] >= before);
    before = times[k];
  });
  // A thread is lit once both its ends are, never before.
  const net = [...marks.slice(0, 2), { after: [0, 1], lane: 'broshi' }];
  const t = s.kindleTimes('vb', net);
  assert.ok(t[2] >= Math.max(t[0], t[1]) && t[2] - Math.max(t[0], t[1]) <= 500);
});

test('a refreshed analysis never moves or removes a light already heard', () => {
  const first = compileCastSchedule(base);
  const marks = Array.from({ length: 16 }, (_, k) => ({ p: (k + 1) / 17, follow: 'broshi', lane: 'broshi' }));
  const old = first.kindleTimes('va', marks);
  const committedThroughMs = 70000;
  // The full analysis retimes the song: different lanes and onsets.
  const refreshed = compileCastSchedule({ ...base, previous: first, committedThroughMs,
    lanes: { at: () => ({ midio: { glow: 1 }, broshi: { glow: 1 }, midasus: { glow: 1 } }) },
    onsets: { ...onsets, broshi: onsets.broshi.map((t) => t + 60) } });
  const now = refreshed.kindleTimes('va', marks);
  let kept = 0;
  marks.forEach((_, k) => {
    if (old[k] <= committedThroughMs) { assert.equal(now[k], old[k]); kept++; } else assert.ok(now[k] > committedThroughMs);
  });
  assert.ok(kept >= 3, `${kept} lights were already lit`);
  for (const t of [10000, 30000, 65000, 70000]) assert.deepEqual(refreshed.stateOf('va', t), first.stateOf('va', t));
  // The future still finishes on time.
  assert.equal(refreshed.stateOf('va', refreshed.views.va.finishMs).p, 1);
  assert.ok(refreshed.stateOf('va', 70100).p >= first.stateOf('va', 70000).p);
});

test('seeking forward or back reads the same state', () => {
  const s = compileCastSchedule(base);
  const times = [5000, 140000, 31000, 95000, 179000, 0, 124000];
  const once = times.map((t) => s.at(t));
  const again = [...times].reverse().map((t) => s.at(t)).reverse();
  assert.deepEqual(again, once);
  assert.deepEqual(compileCastSchedule(base).at(95000), s.at(95000));
});

test('fallbacks: one view and short songs are each one job; no phrases keeps the section stays', () => {
  const one = compileCastSchedule({ ...base, viewForSection: () => 'solo' });
  assert.equal(one.climaxViewId, 'solo');
  assert.equal(one.views.solo.finishMs, 124000);
  assert.deepEqual(one.views.solo.stays, [{ startMs: 0, endMs: 180000 }]);
  // No trusted phrases: the same stays as the phrased song; only the climax
  // moves, to the loudest 3 s after the first quarter.
  const loose = compileCastSchedule({ ...base, phrases: [], energyAt });
  const phrased = compileCastSchedule(base);
  for (const v of ['va', 'vb', 'vc']) assert.deepEqual(loose.views[v].stays, phrased.views[v].stays);
  // One climax view: the view of the section holding the ~103 s peak (B, 90-120 s).
  assert.equal(loose.climaxViewId, 'vb');
  assert.deepEqual(Object.keys(loose.views).filter((v) => loose.views[v].climax), ['vb']);
  assert.ok(Math.abs(loose.views.vb.finishMs - 103000) <= 1000, `${loose.views.vb.finishMs}`);
  // Every other view finishes late in its last stay, and camps between stays.
  for (const v of ['va', 'vc']) {
    const last = loose.views[v].stays.at(-1);
    assert.equal(loose.views[v].finishMs, last.startMs + 0.85 * (last.endMs - last.startMs));
  }
  for (const v of ['va', 'vb', 'vc']) {
    const early = loose.views[v].stays.filter((s) => s.endMs < 180000).length;
    assert.ok(early > 0 && loose.views[v].camps.length === early, `${v} camps ${loose.views[v].camps.length}`);
  }
  // Progress holds across the gap between va's stays (30-60 s).
  const camp = loose.stateOf('va', 30000).p;
  assert.ok(camp > 0 && camp < 1);
  for (const t of [35000, 45000, 59990]) assert.equal(loose.stateOf('va', t).p, camp, `frozen at ${t}`);
  assert.equal(loose.stateOf('va', 30000).gather01, 1);
  // Only the climax view runs its fuse.
  assert.ok(loose.stateOf('vb', loose.views.vb.finishMs + 2500).fuse01 > 0.4);
  assert.equal(loose.stateOf('va', 179000).fuse01, 0);
  // Seeking either way reads the same state.
  const times = [5000, 140000, 31000, 95000, 179000, 0, 103000];
  assert.deepEqual([...times].reverse().map((t) => loose.at(t)).reverse(), times.map((t) => loose.at(t)));
  const short = compileCastSchedule({ ...base, durationMs: 24000, sections: sections.map((s) => ({ ...s, startMs: s.startMs / 10, endMs: s.endMs / 10 })) });
  for (const v of Object.keys(short.views)) {
    assert.equal(short.views[v].finishMs, 24000 * 0.85);
    assert.equal(short.views[v].camps.length, 0);
    assert.equal(short.views[v].climax, false);
  }
  // A payoff swells after the finish, and the climax runs its fuse.
  assert.equal(one.stateOf('solo', 124000 + 1500).payoff01, 1);
  assert.ok(one.stateOf('solo', 124000 + 2500).fuse01 > 0.4);
});

test('no phrases: an energy peak in an unviewed section goes to the nearest viewed section before it, then after', () => {
  // C (120-150 s) has no view; B either side of it is one bridged stay.
  const gapView = (s) => (s.label === 'C' ? null : VIEW[s.label]);
  const peak = (t) => (t > 132000 && t < 136000 ? 1 : 0.2);
  const s = compileCastSchedule({ ...base, viewForSection: gapView, phrases: [], energyAt: peak });
  assert.deepEqual(Object.keys(s.views).sort(), ['va', 'vb']);
  assert.deepEqual(s.views.vb.stays, [{ startMs: 30000, endMs: 60000 }, { startMs: 90000, endMs: 180000 }]);
  assert.equal(s.climaxViewId, 'vb');
  assert.deepEqual(Object.keys(s.views).filter((v) => s.views[v].climax), ['vb']);
  assert.ok(Math.abs(s.views.vb.finishMs - 135000) <= 1000, `${s.views.vb.finishMs}`);
  assert.equal(s.stateOf('vb', s.views.vb.finishMs).p, 1);
  // No viewed section before the peak: the next one after it.
  const late = [{ startMs: 0, endMs: 90000 }, { startMs: 90000, endMs: 150000, label: 'A' }, { startMs: 150000, endMs: 180000, label: 'B' }];
  const early = compileCastSchedule({ ...base, sections: late, viewForSection: (x) => VIEW[x.label] || null, phrases: [],
    energyAt: (t) => (t > 50000 && t < 54000 ? 1 : 0.2) });
  assert.equal(early.climaxViewId, 'va');
  assert.deepEqual(Object.keys(early.views).filter((v) => early.views[v].climax), ['va']);
  // The peak is before va's only stay, so its finish clamps to that stay's start.
  assert.equal(early.views.va.finishMs, 90000);
});

test('no phrases: a borrowed climax view finishes in the stay it was borrowed from, not its last one', () => {
  const pick = (x) => VIEW[x.label] || null;
  // Before: A 0-90 s, no view 90-120 s, B 120-160 s, A 160-240 s, peak near 105 s.
  const before = [{ label: 'A', startMs: 0, endMs: 90000 }, { startMs: 90000, endMs: 120000 },
    { label: 'B', startMs: 120000, endMs: 160000 }, { label: 'A', startMs: 160000, endMs: 240000 }];
  const b = compileCastSchedule({ ...base, sections: before, viewForSection: pick, phrases: [], durationMs: 240000,
    energyAt: (t) => (t > 103000 && t < 107000 ? 1 : 0.2) });
  assert.equal(b.climaxViewId, 'va');
  assert.deepEqual(b.views.va.stays, [{ startMs: 0, endMs: 90000 }, { startMs: 160000, endMs: 240000 }]);
  assert.equal(b.views.va.finishMs, 90000);
  assert.equal(b.stateOf('va', 90000).p, 1);
  // After: no view 0-100 s, then B has two stays after the peak near 80 s;
  // the finish is the start of the first one.
  const after = [{ startMs: 0, endMs: 100000 }, { label: 'B', startMs: 100000, endMs: 130000 },
    { label: 'A', startMs: 130000, endMs: 160000 }, { label: 'B', startMs: 160000, endMs: 200000 },
    { label: 'A', startMs: 200000, endMs: 240000 }];
  const a = compileCastSchedule({ ...base, sections: after, viewForSection: pick, phrases: [], durationMs: 240000,
    energyAt: (t) => (t > 78000 && t < 82000 ? 1 : 0.2) });
  assert.equal(a.climaxViewId, 'vb');
  assert.equal(a.views.vb.stays.length, 2);
  assert.equal(a.views.vb.finishMs, 100000);
});

test('no phrases: a section shorter than two camps compiles with bounded camps', () => {
  const brief = [
    { label: 'A', startMs: 0, endMs: 60000 }, { label: 'B', startMs: 60000, endMs: 63000 },
    { label: 'A', startMs: 63000, endMs: 120000 }, { label: 'C', startMs: 120000, endMs: 180000 },
  ];
  const s = compileCastSchedule({ ...base, sections: brief, phrases: [], energyAt });
  assert.deepEqual(s.views.vb.stays, [{ startMs: 60000, endMs: 63000 }]);
  for (const [v, view] of Object.entries(s.views)) {
    assert.ok(view.camps.length <= view.stays.length, `${v} camps`);
    for (const k of view.camps) assert.ok(k.atMs < 180000 && k.p >= 0 && k.p <= 1);
    let last = 0;
    for (let t = 0; t <= 180000; t += 250) {
      const st = s.stateOf(v, t);
      assert.ok(st.p >= last - 1e-9 && st.p <= 1 && st.gather01 >= 0 && st.gather01 <= 1, `${v} at ${t}`);
      last = st.p;
    }
    assert.equal(s.stateOf(v, view.finishMs).p, 1);
  }
  assert.equal(s.climaxViewId, 'va');
});

test('a refresh from a no-phrase schedule to a phrased one keeps state through committedThroughMs', () => {
  const loose = compileCastSchedule({ ...base, phrases: [], energyAt });
  const committedThroughMs = 70000;
  const refreshed = compileCastSchedule({ ...base, previous: loose, committedThroughMs });
  for (const t of [10000, 30000, 45000, 65000, 70000]) assert.deepEqual(refreshed.stateOf('va', t), loose.stateOf('va', t));
  for (const v of ['va', 'vb', 'vc']) {
    assert.deepEqual(refreshed.views[v].stays, loose.views[v].stays);
    assert.ok(refreshed.stateOf(v, committedThroughMs + CAST_STEP_MS).p >= loose.stateOf(v, committedThroughMs).p - 1e-9, v);
    assert.equal(refreshed.stateOf(v, refreshed.views[v].finishMs).p, 1);
  }
  assert.equal(refreshed.climaxViewId, 'vc');
});

test('no phrases in a one-view song is still one whole-song job finishing at the energy climax', () => {
  const s = compileCastSchedule({ ...base, viewForSection: () => 'solo', phrases: [], energyAt });
  assert.equal(s.climaxViewId, 'solo');
  assert.deepEqual(s.views.solo.stays, [{ startMs: 0, endMs: 180000 }]);
  assert.ok(Math.abs(s.views.solo.finishMs - 103000) <= 1000);
  assert.equal(s.views.solo.climax, true);
  assert.equal(s.views.solo.camps.length, 0);
});
