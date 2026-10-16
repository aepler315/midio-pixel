import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer, applyFixedGroundTransform } from '../src/render/Renderer.js';
import { displayLimitedSize } from '../src/render/StagePresets.js';

// Replace only the Canvas boundary: production Renderer owns every transform,
// viewport, clip and post-processing call exercised below.
function canvasFixture(width, height) {
  let matrix = [1, 0, 0, 1, 0, 0], clip = null;
  const stack = [], events = [], circles = [], text = [];
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#fff',
    setTransform(...m) { matrix = m; },
    getTransform() { const [a, b, c, d, e, f] = matrix; return { a, b, c, d, e, f }; },
    save() { stack.push({ matrix: [...matrix], clip, alpha: this.globalAlpha, fill: this.fillStyle }); },
    restore() { const s = stack.pop(); matrix = s.matrix; clip = s.clip; this.globalAlpha = s.alpha; this.fillStyle = s.fill; },
    translate(x, y) { matrix[4] += matrix[0] * x + matrix[2] * y; matrix[5] += matrix[1] * x + matrix[3] * y; },
    rotate(angle) { const [a, b, c, d] = matrix, cos = Math.cos(angle), sin = Math.sin(angle); matrix.splice(0, 4, a * cos + c * sin, b * cos + d * sin, c * cos - a * sin, d * cos - b * sin); },
    clearRect() {}, beginPath() {}, rect(x, y, w, h) { this.path = [x, y, w, h]; },
    clip() { clip = this.path; events.push({ kind: 'clip', rect: clip }); },
    arc(x, y, r) { circles.push({ x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5], rx: r * Math.hypot(matrix[0], matrix[1]), ry: r * Math.hypot(matrix[2], matrix[3]), matrix: [...matrix] }); },
    fillRect(x, y, w, h) { events.push({ kind: 'fill', color: this.fillStyle, rect: [x, y, w, h], matrix: [...matrix], clip }); },
    fillText(value) { text.push({ value, matrix: [...matrix] }); },
    measureText(value) { return { width: value.length * 8 }; },
    getImageData() { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData() { events.push({ kind: 'pixels' }); },
  };
  const canvas = { width, height, getContext: () => ctx };
  return { canvas, ctx, events, circles, text };
}

function renderFixture(width, height, { zoom = 1, retro = false } = {}) {
  const fixture = canvasFixture(width, height), renderer = new Renderer(fixture.canvas);
  let frameInputs;
  renderer.rangePresentation = { enabled: true, setFrameInputs(inputs) { frameInputs = inputs; } };
  renderer.hudInFrame = true;
  renderer.composer = { draw(ctx) { ctx.arc(640, 360, 40, 0, Math.PI * 2); } };
  renderer._drawFilmFinish = ctx => ctx.arc(640 / zoom, 360 / zoom, 40, 0, Math.PI * 2);
  const sim = {
    stageW: 1280, stageH: 720, timeMs: 4000,
    camera: { zoom, roll: 0, shakeX: 0, shakeY: 0 },
    lerpState: () => ({ worldX: 0, midioX: 220, midioDrawX: 220 }),
    perf: { particleMul: 1, heavyPostFx: true, bloomEnabled: false, retroPalette: retro },
    conductor: { timeline: [], barGrid: [], durationMs: 12000 }, filmFinish: {},
    rangeCaption: { rows: [{ name: 'Teton', region: '', label: '' }] },
    biomes: { world: { kind: 'alpine' },
      draw(ctx, stage, worldX, originX, sky, particles, perf, ground) {
        ctx.arc(640 / zoom + 64, 360 / zoom + 64, 40, 0, Math.PI * 2);
        ground.apply(); ctx.arc(704, 424, 40, 0, Math.PI * 2);
      }, drawForeground() {}, _pass: () => false,
    },
  };
  renderer.draw(sim, 1);
  return { ...fixture, renderer, frameInputs };
}

for (const [width, height, x, y, scale] of [[540, 960, 0, 328.125, .421875], [1000, 400, 144.44444444444446, 0, 5 / 9], [960, 540, 0, 0, .75]]) {
  test(`all compositor layers preserve circles in ${width}x${height} output`, () => {
    const f = renderFixture(width, height);
    assert.equal(f.circles.length, 4, 'scenic, ground, film and HUD circles');
    for (const p of f.circles) {
      assert.ok(Math.abs(p.rx - p.ry) < 1e-9, 'one scale for both circle axes');
      assert.ok(Math.abs(p.rx - 40 * scale) < 1e-9);
      assert.ok(Math.abs(p.x - width / 2) < 1e-9);
      assert.ok(Math.abs(p.y - height / 2) < 1e-9);
    }
    assert.deepEqual(f.text[0].matrix, [scale, 0, 0, scale, x, y], 'caption shares fixed-stage fitting');
    assert.deepEqual(f.events.find(e => e.kind === 'clip')?.rect, [x, y, 1280 * scale, 720 * scale]);
    assert.equal(f.frameInputs.scenicViewport.backingWidth, Math.round(1408 * scale));
    assert.equal(f.frameInputs.scenicViewport.backingHeight, Math.round(848 * scale));
  });
}

test('natural compositor restores opaque output bars without a palette readback', () => {
  const f = renderFixture(540, 960);
  assert.equal(f.events.some(e => e.kind === 'pixels'), false);
  const bars = f.events.filter(e => e.kind === 'fill' && e.color === '#000000').slice(-2);
  assert.deepEqual(bars.map(e => e.rect), [[0, 0, 540, 328.125], [0, 631.875, 540, 328.125]]);
});

test('camera zoom preserves fitting while fixed ground and HUD remain at nominal scale', () => {
  const f = renderFixture(540, 960, { zoom: .8 });
  assert.ok(Math.abs(f.circles[0].rx - 13.5) < 1e-9);
  assert.ok(Math.abs(f.circles[1].rx - 16.875) < 1e-9);
  assert.ok(Math.abs(f.circles[3].rx - 16.875) < 1e-9);
  for (const p of f.circles) assert.ok(Math.abs(p.rx - p.ry) < 1e-9);
});

test('fixed-ground output offsets remain in device space with shake, roll and ledge offset', () => {
  const f = canvasFixture(540, 960);
  applyFixedGroundTransform(f.ctx, { sx: .421875, sy: .421875, width: 1280, height: 720,
    camera: { roll: .1, shakeX: -12, shakeY: 8 }, offsetY: 100, outputX: 0, outputY: 328.125 });
  const shifted = f.ctx.getTransform();
  const ordinary = canvasFixture(540, 960);
  applyFixedGroundTransform(ordinary.ctx, { sx: .421875, sy: .421875, width: 1280, height: 720,
    camera: { roll: .1, shakeX: -12, shakeY: 8 }, offsetY: 100 });
  assert.ok(Math.abs(shifted.f - ordinary.ctx.getTransform().f - 328.125) < 1e-9);
});

test('portrait phone uses a landscape backing store, distinct from portrait output', () => {
  const phone = displayLimitedSize(1920, 1080, 390, 844, 3);
  assert.deepEqual(phone, { w: 780, h: 439 });
  const f = renderFixture(phone.w, phone.h);
  const contentClip = f.events.find(e => e.kind === 'clip');
  assert.ok(contentClip, 'phone backing uses the output fit clip');
  assert.ok(contentClip.rect[3] > 438);
  assert.ok(f.circles[0].ry > 24, 'phone renders its landscape strip, not 540x960 export framing');
});
