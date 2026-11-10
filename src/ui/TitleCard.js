// The song's title card: the first thing every song shows.
//
// Drawn on the stage canvas (Renderer, beside the place caption), not laid
// over it as page text, so recordings, bulk exports and highlights carry it
// too. Its fade runs on song time (OpeningTimeline.titleCardAlpha), so an
// export frame at 1 s shows exactly what live play showed at 1 s. It covers
// the flat ground the range rises from, then fades to reveal the surge.
import { titleCardAlpha } from '../core/OpeningTimeline.js';
import { pixelGrid, pixelUnit } from '../render/PixelRenderPolicy.js';
import { pixelFontText, measurePixelText, drawPixelText, PIXEL_ADVANCE, PIXEL_LINE_ADVANCE } from './PixelFont.js';

const EYEBROW = 'MIDIO PIXEL';
const AUDIO_EXTENSION = /\.(wav|wave|mp3|m4a|aac|ogg|oga|opus|flac|webm|aif|aiff|mp4)$/i;

const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '');

/** What the card says, or null when there is nothing worth showing. A file
 *  name stands in for a missing title, without its audio extension. */
export function titleCardFor({ title = '', artist = '', fileName = '' } = {}) {
  const name = clean(title) || clean(fileName).replace(AUDIO_EXTENSION, '').replace(/[_]+/gu, ' ').trim();
  if (!name) return null;
  const by = clean(artist);
  return Object.freeze({ title: name, artist: by && by.toLowerCase() !== name.toLowerCase() ? by : '' });
}

const FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';

function fitFont(ctx, text, weight, sizePx, maxWidth, minPx = 18) {
  let size = sizePx;
  for (; size > minPx; size -= 2) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) break;
  }
  ctx.font = `${weight} ${size}px ${FONT}`;
  return size;
}

function backdrop(ctx, width, height, alpha) {
  ctx.globalAlpha = alpha * 0.94;
  ctx.fillStyle = '#07080d';
  ctx.fillRect(0, 0, width, height);
}

/** Smooth path: a 2D context whose transform maps `stage` (the nominal
 *  1280x720 stage) onto the canvas. */
export function drawTitleCard(ctx, stage, card, songMs) {
  if (!card) return;
  const alpha = titleCardAlpha(songMs);
  if (!(alpha > 0)) return;
  const w = stage.width, h = stage.height, cx = w / 2;
  const lift = (1 - alpha) * -10;
  ctx.save();
  backdrop(ctx, w, h, alpha);
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const maxWidth = w * 0.86;
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = 'rgba(242, 240, 248, 0.5)';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '6px';
  ctx.fillText(EYEBROW, cx, h * 0.5 - 70 + lift);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.fillStyle = '#f6f4fb';
  fitFont(ctx, card.title, 600, 54, maxWidth);
  ctx.fillText(card.title, cx, h * 0.5 + 6 + lift);
  ctx.fillStyle = 'rgba(255, 215, 106, 0.6)';
  ctx.fillRect(cx - 28, h * 0.5 + 26 + lift, 56, 2);
  if (card.artist) {
    ctx.fillStyle = 'rgba(255, 215, 106, 0.92)';
    fitFont(ctx, card.artist, 400, 24, maxWidth, 14);
    ctx.fillText(card.artist, cx, h * 0.5 + 62 + lift);
  }
  ctx.restore();
}

/** Word-wrap in pixel-font characters. `fits` is false when the text had
 *  to be cut (a word longer than a line, or more lines than allowed). */
function wrapPixel(text, maxChars, maxLines = Infinity) {
  const words = pixelFontText(text).split(' ').filter(Boolean);
  const lines = [];
  let line = '', fits = true;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if ([...next].length <= maxChars) { line = next; continue; }
    if (line) lines.push(line);
    if ([...word].length > maxChars) { fits = false; line = [...word].slice(0, maxChars).join(''); } else line = word;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    fits = false;
    lines.length = maxLines;
    const last = [...lines[maxLines - 1]];
    lines[maxLines - 1] = `${last.slice(0, Math.max(1, maxChars - 3)).join('')}...`;
  }
  return { lines, fits };
}

/** True when every character has a pixel glyph (pixelFontText would
 *  otherwise spell it out as a code point). */
const pixelReadable = (text) => !pixelFontText(text).includes('[U+');

/** Layout in native pixel-grid space (pure: testable without a canvas).
 *  Null when the card has text the pixel font cannot draw. */
export function layoutPixelTitleCard(card, { grid = pixelGrid() } = {}) {
  if (!card || !pixelReadable(card.title) || (card.artist && !pixelReadable(card.artist))) return null;
  const unit = pixelUnit(grid), margin = 8 * unit, maxWidth = grid.width - 2 * margin;
  const charsAt = (scale) => Math.max(1, Math.floor((maxWidth / scale + 1) / PIXEL_ADVANCE));
  // A big title when it fits in two lines, else the caption size.
  let titleScale = 2 * unit, title = wrapPixel(card.title, charsAt(titleScale), 2);
  if (!title.fits) {
    titleScale = unit;
    title = wrapPixel(card.title, charsAt(titleScale), 3);
  }
  const artist = card.artist ? wrapPixel(card.artist, charsAt(unit), 1).lines : [];
  const rows = [
    { text: EYEBROW, scale: unit, kind: 'eyebrow' },
    ...title.lines.map(text => ({ text, scale: titleScale, kind: 'title' })),
    ...artist.map(text => ({ text, scale: unit, kind: 'artist' })),
  ];
  const gap = 3 * unit;
  const heights = rows.map(r => PIXEL_LINE_ADVANCE * r.scale);
  const total = heights.reduce((sum, height) => sum + height, 0) + gap * (artist.length ? 2 : 1);
  let y = Math.round((grid.height - total) / 2);
  const lines = rows.map((row, i) => {
    if (i === 1 || (row.kind === 'artist' && rows[i - 1]?.kind === 'title')) y += gap;
    const width = measurePixelText(row.text, row.scale);
    const line = { ...row, width, x: Math.round((grid.width - width) / 2), y };
    y += heights[i];
    return line;
  });
  return { unit, lines };
}

const PIXEL_COLORS = { eyebrow: '#8d8a99', title: '#f6f4fb', artist: '#ffd76a' };

/** Pixel path: called on the captured composition before quantization,
 *  like drawPixelCaption, in native grid coordinates. */
export function drawPixelTitleCard(ctx, card, songMs, { grid = pixelGrid() } = {}) {
  if (!card) return null;
  const alpha = titleCardAlpha(songMs);
  if (!(alpha > 0)) return null;
  const layout = layoutPixelTitleCard(card, { grid });
  if (!layout) {
    // Glyphs the pixel font lacks: the smooth card, scaled onto the grid.
    ctx.save();
    ctx.scale(grid.width / 1280, grid.height / 720);
    drawTitleCard(ctx, { width: 1280, height: 720 }, card, songMs);
    ctx.restore();
    return null;
  }
  ctx.save();
  backdrop(ctx, grid.width, grid.height, alpha);
  ctx.globalAlpha = alpha;
  for (const line of layout.lines) {
    ctx.fillStyle = PIXEL_COLORS[line.kind];
    drawPixelText(ctx, line.text, line.x, line.y, line.scale);
  }
  ctx.restore();
  return layout;
}
