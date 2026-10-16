import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPercussionPattern, PATTERN_SPAN_MS, LoadingShow } from '../src/ui/LoadingShow.js';
import { Role } from '../src/core/NoteEvent.js';

const kick = (tMs, vel = 0.8) => ({ role: Role.RHYTHM, kick: true, tMs, vel });
const melody = (tMs) => ({ role: Role.MELODY, kick: false, tMs, vel: 0.6, pitch: 60 });

test('keeps on-pulse kicks as thumps and demotes crowded ones to hats', () => {
  const bpm = 120; // beat = 500ms
  const timeline = [
    kick(0), kick(120), kick(500), kick(1000), melody(750), kick(1120),
  ];
  const { hits } = buildPercussionPattern(timeline, bpm);
  const kinds = hits.map((h) => `${h.tMs}:${h.kind}`);
  assert.deepEqual(kinds, ['0:thump', '120:hat', '500:thump', '1000:thump', '1120:hat']);
  const hat = hits.find((h) => h.kind === 'hat');
  assert.ok(hat.vel < 0.8, 'hats are quieter than the kick they came from');
});

test('ignores non-rhythm events and everything past the span', () => {
  const timeline = [melody(0), kick(PATTERN_SPAN_MS + 100), kick(200)];
  const { hits } = buildPercussionPattern(timeline, 120);
  assert.deepEqual(hits.map((h) => h.tMs), [200]);
});

test('a kickless song still gets a four-on-the-floor pulse', () => {
  const { hits, loopMs } = buildPercussionPattern([melody(0), melody(400)], 120);
  assert.equal(hits.length, 16);
  assert.ok(hits.every((h) => h.kind === 'thump'));
  assert.equal(hits[1].tMs - hits[0].tMs, 500);
  assert.ok(loopMs >= hits[hits.length - 1].tMs, 'loop covers the pattern');
});

test('loop length is a whole number of bars and covers the last hit', () => {
  const { loopMs } = buildPercussionPattern([kick(0), kick(500), kick(6100)], 120);
  const barMs = 2000;
  assert.equal(loopMs % barMs, 0);
  assert.ok(loopMs >= 6100);
});

// --- LoadingShow: null-data (visual-only) mode, used while an audio file
// is still separating/analyzing, before any timeline exists. ---

function fakeCtx2d() {
  const noop = () => {};
  return {
    clearRect: noop, save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
    fill: noop, stroke: noop, arc: noop, ellipse: noop, translate: noop, rotate: noop, scale: noop,
    set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set globalAlpha(v) {},
  };
}

function fakeLoadingShowDeps() {
  const canvasEl = { width: 420, height: 220, getContext: () => fakeCtx2d() };
  const textEl = { textContent: '' };
  const barFillEl = { style: { width: '' } };
  const audioEngine = {
    ctx: {
      currentTime: 0,
      createOscillator: () => ({ type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} }),
      createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }),
      createBuffer: () => ({ getChannelData: () => new Float32Array(4) }),
      createBufferSource: () => ({ buffer: null, connect: () => ({ connect() {} }), start() {} }),
      createBiquadFilter: () => ({ type: '', frequency: { value: 0 }, connect: () => ({ connect() {} }) }),
    },
    master: {},
  };
  return { canvasEl, textEl, barFillEl, audioEngine };
}

test('LoadingShow: start(null) runs visual-only, with no percussion timer', () => {
  const savedRAF = globalThis.requestAnimationFrame, savedCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  try {
    const show = new LoadingShow(fakeLoadingShowDeps());
    assert.equal(show.active, false);
    const session = show.start(null);
    assert.equal(show.active, true);
    assert.equal(show._timer, null, 'no timeline yet -- nothing to schedule a percussion loop from');
    assert.doesNotThrow(() => show._draw(0));
    show.stop(session);
    assert.equal(show.active, false);
  } finally {
    globalThis.requestAnimationFrame = savedRAF;
    globalThis.cancelAnimationFrame = savedCAF;
  }
});

test('LoadingShow: start(timelineData) schedules the visual pulse without voicing clicks', () => {
  const savedRAF = globalThis.requestAnimationFrame, savedCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  try {
    const deps = fakeLoadingShowDeps();
    let osc = 0, src = 0;
    const ctx = deps.audioEngine.ctx;
    const origOsc = ctx.createOscillator;
    const origSrc = ctx.createBufferSource;
    ctx.createOscillator = (...args) => { osc++; return origOsc(...args); };
    ctx.createBufferSource = (...args) => { src++; return origSrc(...args); };
    const show = new LoadingShow(deps);
    const session = show.start({ timeline: [kick(0), kick(500)], bpm: 120 });
    assert.equal(show.active, true);
    assert.notEqual(show._timer, null);
    assert.equal(osc, 0, 'loader percussion must not voice oscillator thumps');
    assert.equal(src, 0, 'loader percussion must not voice hat bursts');
    show.stop(session);
  } finally {
    globalThis.requestAnimationFrame = savedRAF;
    globalThis.cancelAnimationFrame = savedCAF;
  }
});

test('LoadingShow.setStage sets a plain status line and an optional fill fraction', () => {
  const deps = fakeLoadingShowDeps();
  const show = new LoadingShow(deps);
  show.setStage('Separating the stems…', 0.42);
  assert.equal(deps.textEl.textContent, 'Separating the stems…');
  assert.equal(deps.barFillEl.style.width, '42%');
  show.setStage('Almost there…');
  assert.equal(deps.barFillEl.style.width, '10%', 'no fraction given falls back to a hint sliver');
});
