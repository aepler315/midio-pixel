import test from 'node:test';
import assert from 'node:assert/strict';
import { rendererFixture } from './helpers/highlightRendererFixture.js';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';

function finaleFixture() {
  const f = rendererFixture({ cues: [], durationMs: 8000, lastImpactMs: 5220 });
  f.seekTo(5000);
  const assemblySources = [];
  f.sim.assembly = { wantsCapture: () => true, captureFrame: source => assemblySources.push(source) };
  const output = document.createElement('canvas');
  output.width = 1280; output.height = 720; output.frame = 9876;
  return { ...f, output, assemblySources };
}

test('hybrid assembly, finale and highlight captures consume the completed output exactly once', () => {
  const f = finaleFixture();
  try {
    f.renderer.deferSceneCaptures = true;
    f.drawAt(5000);
    assert.equal(f.assemblySources.length, 0, 'native terrain is not a completed hybrid frame');
    assert.equal(f.sim.fracture.isAboutToFreeze, true);
    assert.equal(f.sim.highlightReel.frames.length, 0);
    f.renderer.completeFrameCaptures(f.output);
    assert.deepEqual(f.assemblySources, [f.output]);
    assert.equal(f.sim.fracture.freezeFrame.frame, f.output.frame);
    assert.equal(f.sim.fracture.freezeFrame.width, f.output.width);
    assert.equal(f.sim.highlightReel.frames.length, 1);
    assert.equal(f.sim.highlightReel.frames[0].dataUrl, f.output.toDataURL());
    f.renderer.completeFrameCaptures(f.output);
    assert.equal(f.assemblySources.length, 1);
    assert.equal(f.sim.highlightReel.frames.length, 1);
  } finally { f.dispose(); }
});

test('a rejected hybrid frame discards every deferred capture instead of capturing stale output later', () => {
  const f = finaleFixture();
  try {
    f.renderer.deferSceneCaptures = true;
    f.drawAt(5000);
    f.renderer.discardFrameCaptures();
    f.renderer.completeFrameCaptures(f.output);
    assert.equal(f.assemblySources.length, 0);
    assert.equal(f.sim.fracture.isAboutToFreeze, true);
    assert.equal(f.sim.highlightReel.frames.length, 0);
  } finally { f.dispose(); }
});

test('the next draw supersedes an undrained hybrid frame and direct callers retain immediate captures', () => {
  const f = finaleFixture();
  try {
    f.renderer.deferSceneCaptures = true;
    f.drawAt(5000);
    f.renderer.deferSceneCaptures = false;
    f.drawAt(5000);
    assert.deepEqual(f.assemblySources, [f.canvas]);
    assert.equal(f.sim.fracture.freezeFrame.frame, f.canvas.frame);
    assert.equal(f.sim.highlightReel.frames.length, 1);
    f.renderer.completeFrameCaptures(f.output);
    assert.deepEqual(f.assemblySources, [f.canvas], 'the old queue cannot capture the next completed output');
    assert.equal(f.sim.fracture.freezeFrame.frame, f.canvas.frame);
  } finally { f.dispose(); }
});

test('readiness primes cannot consume semantic captures before the admitted destination draw', () => {
  const f = finaleFixture();
  const adapter = createPresentingRenderer({ canvas: f.output,
    presentation: { grid: { id: 'classic' }, paletteId: 'none' }, rendererFactory: () => f.renderer });
  try {
    assert.equal(adapter.draw(f.sim, 1, { preparing: true }).presented, true);
    assert.equal(adapter.draw(f.sim, 1, { preparing: true }).presented, true);
    assert.equal(f.assemblySources.length, 0);
    assert.equal(f.sim.fracture.isAboutToFreeze, true);
    assert.equal(f.sim.highlightReel.frames.length, 0);
    assert.equal(adapter.draw(f.sim, 1, { preparing: false }).presented, true);
    assert.equal(f.assemblySources.length, 1);
    assert.equal(f.sim.fracture.isAboutToFreeze, false);
    assert.equal(f.sim.highlightReel.frames.length, 1);
  } finally { adapter.dispose(); f.dispose(); }
});
