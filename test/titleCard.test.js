import test from 'node:test';
import assert from 'node:assert/strict';
import { titleCardFor, layoutPixelTitleCard, drawPixelTitleCard, drawTitleCard } from '../src/ui/TitleCard.js';
import { TITLE_CARD_END_MS } from '../src/core/OpeningTimeline.js';
import { pixelFontText } from '../src/ui/PixelFont.js';

const CLASSIC = { width: 320, height: 180 };
const DETAILED = { width: 640, height: 360 };

function recordingContext() {
  const calls = [];
  const ctx = new Proxy({ calls, measureText: (t) => ({ width: String(t).length * 10 }) }, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => { calls.push([key, ...args]); };
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  return ctx;
}

test('the card names the song, and a file name stands in for a missing title', () => {
  assert.deepEqual({ ...titleCardFor({ title: 'Mountain Song', artist: 'The Hills' }) }, { title: 'Mountain Song', artist: 'The Hills' });
  assert.equal(titleCardFor({ fileName: 'my_new-track.flac' }).title, 'my new-track');
  assert.equal(titleCardFor({ title: 'Same', artist: 'same' }).artist, '', 'an artist that repeats the title is dropped');
  assert.equal(titleCardFor({}), null);
  assert.equal(titleCardFor({ title: '   ' }), null);
});

test('the pixel card fits its grid and keeps a big title when it can', () => {
  for (const grid of [CLASSIC, DETAILED]) {
    const layout = layoutPixelTitleCard(titleCardFor({ title: 'Proof', artist: 'Midio Pixel sample' }), { grid });
    assert.ok(layout.lines.length >= 3);
    const title = layout.lines.find(l => l.kind === 'title');
    assert.ok(title.scale > layout.unit, 'short titles draw large');
    for (const line of layout.lines) {
      assert.ok(line.x >= 0 && line.x + line.width <= grid.width, `${line.text} fits horizontally`);
      assert.ok(line.y >= 0 && line.y + 9 * line.scale <= grid.height, `${line.text} fits vertically`);
    }
  }
});

test('a long title falls back to caption size instead of being cut', () => {
  const card = titleCardFor({ title: 'An Extraordinarily Long Song Title That Keeps Going And Going' });
  const classic = layoutPixelTitleCard(card, { grid: CLASSIC });
  assert.equal(classic.lines.find(l => l.kind === 'title').scale, classic.unit);
  for (const grid of [CLASSIC, DETAILED]) {
    const titles = layoutPixelTitleCard(card, { grid }).lines.filter(l => l.kind === 'title');
    assert.ok(titles.length <= 3);
    assert.equal(titles.map(l => l.text).join(' '), pixelFontText(card.title), 'every word is kept');
    assert.ok(titles.every(l => !l.text.endsWith('...')), 'nothing is cut');
  }
});

test('a title too long for three lines is cut with an ellipsis, inside the grid', () => {
  const card = titleCardFor({ title: 'Going And '.repeat(30).trim() });
  for (const grid of [CLASSIC, DETAILED]) {
    const titles = layoutPixelTitleCard(card, { grid }).lines.filter(l => l.kind === 'title');
    assert.equal(titles.length, 3);
    assert.ok(titles.at(-1).text.endsWith('...'));
    for (const line of titles) assert.ok(line.x >= 0 && line.x + line.width <= grid.width, `${line.text} fits`);
  }
});

test('the deferred composite draws the card on the heard time snapshotted with its frame', async () => {
  const { Renderer } = await import('../src/render/Renderer.js');
  const cardDraws = (titleCardMs, timeMs) => {
    const renderer = Object.create(Renderer.prototype), ctx = recordingContext();
    ctx.canvas = {};
    renderer._deferredPostEffects = { sim: { timeMs }, viewStage: { width: 1280, height: 720 },
      titleCard: titleCardFor({ title: 'Proof' }), titleCardMs, grid: CLASSIC };
    renderer._drawBloom = () => {}; renderer._drawHeatDistortion = () => {};
    renderer.drawDeferredPostEffects(ctx, { x: 0, y: 0, width: 1280, height: 720 });
    return ctx.calls.filter(([name]) => name === 'fillRect' || name === 'fillText').length;
  };
  assert.ok(cardDraws(0, 0) > 0, 'the card opens the song');
  assert.equal(cardDraws(TITLE_CARD_END_MS + 1, TITLE_CARD_END_MS + 1), 0, 'and is gone once faded');
  // Output latency puts the transport ahead of what is heard: the replay
  // follows the heard time, the clock the opening surge runs on.
  assert.ok(cardDraws(1000, TITLE_CARD_END_MS + 300) > 0, 'still heard under the card');
  assert.equal(cardDraws(TITLE_CARD_END_MS + 1, 0), 0);
});

test('text the pixel font cannot draw uses the smooth card instead of code points', () => {
  const card = titleCardFor({ title: '山の歌' });
  assert.equal(layoutPixelTitleCard(card, { grid: CLASSIC }), null);
  const ctx = recordingContext();
  drawPixelTitleCard(ctx, card, 500, { grid: CLASSIC });
  assert.ok(ctx.calls.some(([name, text]) => name === 'fillText' && text === '山の歌'));
});

test('nothing is drawn once the card has faded', () => {
  const card = titleCardFor({ title: 'Proof' });
  const late = recordingContext();
  drawTitleCard(late, { width: 1280, height: 720 }, card, TITLE_CARD_END_MS + 1);
  drawPixelTitleCard(late, card, TITLE_CARD_END_MS + 1, { grid: CLASSIC });
  assert.equal(late.calls.length, 0);
  const early = recordingContext();
  drawTitleCard(early, { width: 1280, height: 720 }, card, 0);
  assert.ok(early.calls.some(([name, text]) => name === 'fillText' && text === 'Proof'));
});
