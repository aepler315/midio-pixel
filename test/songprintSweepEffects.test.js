import test from 'node:test';
import assert from 'node:assert/strict';
import { drawSweepEffect } from '../src/render/SongprintSweepEffects.js';
import { roomRegistration } from '../src/render/SongprintPaperRoom.js';

const view = { x: 8, y: 11, w: 793, h: 432 };

function recordingContext() {
  const commands = [];
  const stack = [];
  const ctx = { commands, globalAlpha: 1 };
  for (const name of ['beginPath', 'moveTo', 'lineTo', 'closePath', 'arc', 'bezierCurveTo', 'rect',
    'translate', 'rotate', 'scale', 'transform', 'clip', 'stroke', 'fill']) {
    ctx[name] = (...args) => {
      assert.ok(args.every(Number.isFinite), name + ' received a non-finite argument');
      commands.push([name, ...args, ctx.globalAlpha]);
    };
  }
  ctx.save = () => stack.push(ctx.globalAlpha);
  ctx.restore = () => { ctx.globalAlpha = stack.pop(); };
  ctx.createLinearGradient = () => ({addColorStop() {}});
  return ctx;
}

function field(t, overrides) {
  const phase = (t % 12) * Math.PI / 6;
  const rows = Array.from({ length: 64 }, (_, i) => ({
    i, r0: i / 70, r1: (i + 1) / 70, gap: 1.1, bend: 0.15 * Math.sin(phase),
    color: [90 + i, 135, 195], focus: 0.1,
  }));
  return { phase, periodSec: 12, rows, activeIndex: 7, audible: 0.9, energy: 0.6, attack: 0.2,
    withAudio: true, beatPosition: 4, beatConfidence: 0.8, ...overrides };
}

function frame(effect, t, overrides = {}, entities = true) {
  const ctx = recordingContext();
  const sampled = [];
  drawSweepEffect(ctx, view, time => {
    sampled.push(time);
    return field(time, overrides);
  }, t, { effect, entities });
  assert.equal(ctx.globalAlpha, 1);
  return { commands: ctx.commands, sampled };
}

test('both impressions carry the room and its ink sideways and return at the cadence', () => {
  const held = { sustained: .7, songPosition: .54 };
  for (const effect of ['apertures', 'fold']) {
    const draw = overrides => frame(effect, 5, { ...held, ...overrides }, false).commands;
    const resting = draw({sustained: 0});
    const pulling = draw({});
    assert.deepEqual(draw({songPosition: 0}), resting);
    assert.deepEqual(draw({songPosition: 1}), resting);
    const transform = pulling.find(([kind]) => kind === 'transform');
    assert.ok(Math.abs(transform[3]) > .08 && transform[4] < .9, 'the entire sheet shears and flattens');
    assert.notDeepEqual(pulling, resting);
    assert.deepEqual(draw({}), pulling, 'scrubbing back restores the same room and ink');
    const raw = {withAudio: false, sustained: .99};
    assert.deepEqual(draw({...raw, songPosition: .1}), draw({...raw, songPosition: .7}));
  }
  assert.equal(roomRegistration(field(5, {...held, withAudio: false})).load, 0);
  // The aperture boundary and its cut edges stay polygonal at both extremes.
  for (const sustained of [0, 1]) {
    const { commands } = frame('apertures', 5, {...held, sustained}, false);
    assert.equal(commands.some(([kind]) => kind === 'bezierCurveTo' || kind === 'arc'), false);
  }
});

for (const effect of ['fold', 'apertures']) {
  test(effect + ' entities visibly travel on three material paths and turn off cleanly', () => {
    const on = frame(effect, 6);
    const off = frame(effect, 6, {}, false);
    const placements = on.commands.filter(([op]) => op === 'rotate');
    assert.equal(placements.length, 3);
    assert.equal(off.commands.filter(([op]) => op === 'rotate').length, 0);
    assert.equal(new Set(placements.map(([, angle]) => angle)).size, 3);
    assert.deepEqual(frame(effect, 6).commands, on.commands, 'replay returns the same paths');
    assert.ok(on.sampled.length <= 3, 'drawing cost in full scan samples is bounded');
    assert.notDeepEqual(frame(effect, 6, {beatPosition: 5.2}).commands, on.commands);
    assert.deepEqual(frame(effect, 6, {beatPosition: 5.2}, false).commands, off.commands);
    // Even before the first entity is drawn, the occupied fold or shutter is displaced.
    const firstActor = on.commands.findIndex(([op]) => op === 'rotate');
    assert.notDeepEqual(on.commands.slice(0, firstActor - 2), off.commands.slice(0, firstActor - 2));
  });

  test(effect + ' keeps sweep-only independent of musical time and skips untrusted beats', () => {
    const raw = {withAudio: false, beatPosition: 14, attack: 0, energy: 0.5, focus: 0};
    assert.deepEqual(frame(effect, 1, raw).commands, frame(effect, 1, raw, false).commands);
    assert.deepEqual(frame(effect, 1, {...raw, beatPosition: 75}).commands, frame(effect, 1, raw).commands);
    for (const quiet of [{beatConfidence: 0}, {audible: 0}]) {
      assert.deepEqual(frame(effect, 1, {...quiet, beatPosition: 497}).commands,
        frame(effect, 1, {...quiet, beatPosition: null}).commands);
    }
  });

  test(effect + ' samples bounded detail on long tracks and can render one slice', () => {
    for (const length of [1, 86400]) {
      let reads = 0;
      const source = field(0, {});
      const rows = new Proxy({length}, {
        get(target, property) {
          if (property === 'length') return target.length;
          const i = Number(property);
          assert.ok(Number.isInteger(i) && i >= 0 && i < length);
          reads++;
          return {...source.rows[0], i, r0: i / length, r1: (i + 1) / length};
        },
      });
      const ctx = recordingContext();
      drawSweepEffect(ctx, view, () => ({...source, rows}), 9, {effect});
      assert.ok(reads < 5000, 'read ' + reads + ' rows from the ' + length + '-slice scan');
      assert.equal(ctx.commands.filter(([command]) => command === 'rotate').length, Math.min(3, length));
      assert.ok(ctx.commands.some(([command]) => command === 'fill'));
    }
  });
}
