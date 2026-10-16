import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HighlightReel, buildHighlightCandidates, selectHighlightCandidates } from '../src/render/HighlightReel.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { HypeDirector } from '../src/sim/HypeDirector.js';

const canvases = [];
globalThis.document = { createElement: () => {
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }),
    toDataURL: () => 'data:image/jpeg;base64,fake' };
  canvases.push(canvas);
  return canvas;
} };
const source = { width: 1280, height: 720 };
const candidate = (id, eventAtMs, category = 'drop') => ({
  id, eventAtMs, category, label: category === 'finale' ? 'Finale' : 'Drop',
  visibleStartMs: eventAtMs, visibleEndMs: eventAtMs + 100,
});

test('event-time gap is independent of captured-frame delay at 4999/5000/5001 ms', () => {
  const reel = new HighlightReel();
  const events = [candidate('first', 0), candidate('too-close', 4999),
    candidate('at-gap', 5000), candidate('later', 5001)];
  reel.notify(events, source, 90, { frameTimeMs: 140 });
  reel.notify(events, source, 5000, { frameTimeMs: 5050 });
  assert.deepEqual(reel.selections.map(e => e.id), ['first', 'at-gap']);
  assert.deepEqual(reel.frames.map(e => e.eventAtMs), [0, 5000]);
  assert.deepEqual(reel.frames.map(e => e.atMs), [90, 5000]);
  assert.deepEqual(reel.frames.map(e => e.capturedAtMs), [140, 5050]);
});

test('coincident events use Finale priority, then event ID, regardless of input order', () => {
  const events = [candidate('drop', 5000), candidate('z-final', 5000, 'finale'),
    candidate('a-final', 5000, 'finale')];
  for (const order of [events, [...events].reverse()]) {
    const reel = new HighlightReel();
    reel.notify(order, source, 5000);
    assert.deepEqual(reel.selections.map(e => e.id), ['a-final']);
    assert.equal(reel.frames[0].label, 'Finale');
  }
});

test('a stalled visible window is recorded as missed and cannot be revived by a backseek', () => {
  const reel = new HighlightReel(), events = [candidate('drop', 5000)];
  reel.notify(events, source, 4900);
  reel.notify(events, source, 5200);
  assert.equal(reel.frames.length, 0);
  assert.equal(reel.selections[0].status, 'missed');
  assert.equal(reel.selections[0].observedAtMs, 5200);
  reel.notify(events, source, 5000);
  assert.equal(reel.selections[0].status, 'missed');
  assert.equal(reel.frames.length, 0);
});

test('an event observed while its producer is hidden is rejected without a thumbnail', () => {
  const reel = new HighlightReel(), events = [candidate('hidden', 0)];
  reel.notify(events, source, 20, { isVisible: () => false });
  reel.notify(events, source, 100, { isVisible: () => false });
  assert.equal(reel.frames.length, 0);
  assert.equal(reel.selections[0].status, 'rejected');
});

test('candidate snapshot is immutable and repeated draws/seeks do not duplicate events', () => {
  const reel = new HighlightReel(), events = [candidate('first', 0), candidate('second', 6000)];
  reel.notify(events, source, 0);
  events[1].id = 'mutated'; events[1].eventAtMs = 20000;
  for (const time of [10, 6000, 6010, 0, 6000]) reel.notify(events, source, time);
  assert.deepEqual(reel.selections.map(e => e.id), ['first', 'second']);
  assert.deepEqual(reel.frames.map(e => e.eventAtMs), [0, 6000]);
  assert.ok(reel.selections.every(Object.isFrozen));
});

test('eight selected frames reuse and release one bounded thumbnail canvas', () => {
  const before = canvases.length, reel = new HighlightReel();
  const events = Array.from({ length: 12 }, (_, i) => candidate(`drop:${i}`, i * 5000));
  for (const event of events) reel.notify(events, source, event.eventAtMs);
  assert.equal(reel.selections.length, 8);
  assert.equal(reel.frames.length, 8);
  assert.equal(canvases.length - before, 1);
  assert.equal(canvases.at(-1).width, 0);
  assert.equal(canvases.at(-1).height, 0);
  assert.equal(reel._thumbCanvas, null);
  assert.ok(reel.frames.every(frame => typeof frame.dataUrl === 'string'));
});

test('unsupported retired categories do not create semantic candidates', () => {
  const reel = new HighlightReel();
  reel.notify([candidate('retired', 0, 'voyage')], source, 0);
  assert.deepEqual(reel.selections, []);
  assert.deepEqual(reel.frames, []);
});

test('direct capture preserves its bounded public gate', () => {
  const reel = new HighlightReel();
  assert.equal(reel.capture(source, 0, 'Drop'), true);
  assert.equal(reel.capture(source, 4999, 'Drop'), false);
  assert.equal(reel.capture(source, 5000, 'Drop'), true);
});

test('candidate-only calibration/index caching preserves every normalized number and detector event', () => {
  const stepMs = 1000 / 120, durationMs = 12000;
  for (const profile of ['flat', 'small-spread', 'contrast']) {
    const curves = new EnergyCurves(durationMs, 47);
    for (let frame = 0; frame < curves.n; frame++) {
      const timeMs = frame * 1000 / curves.rateHz;
      for (let band = 0; band < curves.bands.length; band++) {
        curves.bands[band][frame] = profile === 'flat' ? .73 : timeMs < 3000 ? .1
          : profile === 'small-spread' ? .13 + band * .001 : .75 + band * .02;
      }
    }
    const cues = [{ id: 'fractional', tMs: 7001, kind: 'drop', value: .8 }];
    const events = [{ ...candidate('drop:cue:fractional', 7001), source: 'cue' }];
    const numbers = [], original = curves.globalEnergyNorm;
    curves.globalEnergyNorm = function (...args) { const value = original.apply(this, args); numbers.push(value); return value; };
    const detector = new HypeDirector();
    let cued = false;
    for (let tick = 0; tick <= Math.ceil(durationMs / stepMs); tick++) {
      const timeMs = tick * stepMs;
      if (!cued && timeMs >= 7001) { detector.cueDrop(timeMs, .8); cued = true; }
      const before = detector.dropCount;
      detector.update(timeMs, tick === 0 ? 0 : stepMs / 1000, curves);
      if (detector.dropCount > before) events.push({ ...candidate(`drop:energy:${tick}`, timeMs), source: 'energy' });
    }
    const expectedNumbers = [...numbers]; numbers.length = 0;
    const actual = buildHighlightCandidates({ durationMs, energyCurves: curves, cues });
    assert.deepEqual(numbers, expectedNumbers, `${profile}: exact normalized numbers at every 120 Hz tick`);
    const signature = events => events.map(({ id, eventAtMs }) => ({ id, eventAtMs }));
    assert.deepEqual(signature(actual), signature(selectHighlightCandidates(events)), `${profile}: shared detector events`);
  }
});

test('candidate replay stops once eight event-time winners are fixed', () => {
  const stats = {};
  const cues = Array.from({ length: 8 }, (_, i) => ({ id: String(i), tMs: 5000 + i * 6000, kind: 'drop', value: 1 }));
  const events = buildHighlightCandidates({ durationMs: 1200000, cues,
    energyCurves: { globalEnergyNorm: () => .1 } }, stats);
  assert.equal(events.length, 8);
  assert.equal(stats.replaySteps, 5641);
});
