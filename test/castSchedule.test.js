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

test('fallbacks: one view, no phrases, and short songs are each one job', () => {
  const one = compileCastSchedule({ ...base, viewForSection: () => 'solo' });
  assert.equal(one.climaxViewId, 'solo');
  assert.equal(one.views.solo.finishMs, 124000);
  assert.deepEqual(one.views.solo.stays, [{ startMs: 0, endMs: 180000 }]);
  // No trusted phrases: the loudest 3 s after the first quarter.
  const energyAt = (t) => (t > 100000 && t < 104000 ? 1 : 0.2);
  const loose = compileCastSchedule({ ...base, phrases: [], energyAt });
  for (const v of ['va', 'vb', 'vc']) {
    assert.deepEqual(loose.views[v].stays, [{ startMs: 0, endMs: 180000 }]);
    assert.ok(Math.abs(loose.views[v].finishMs - 103000) <= 1000, `${loose.views[v].finishMs}`);
  }
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
