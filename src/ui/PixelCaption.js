import { captionAt, captionAlpha, CAPTION_DELAY_MS, CAPTION_FADE_MS, CAPTION_HOLD_MS } from './RangeCaption.js';
import { pixelGrid } from '../render/PixelRenderPolicy.js';
import { pixelFontText, measurePixelText, drawPixelText, PIXEL_ADVANCE, PIXEL_LINE_ADVANCE } from './PixelFont.js';

export function captionAccessibleText(caption) {
  if (!caption) return '';
  return [caption.biome?.title, caption.biome?.ecoregion,
    ...(caption.rows || []).map(row => [row.label, row.name, row.region].filter(Boolean).join(' · ')),
    caption.stats, caption.credit].filter(Boolean).join('\n');
}
function wrap(text, maxChars) {
  const words = pixelFontText(String(text).trim().replace(/\s+/gu, ' ')).split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!word) continue;
    if (line && [...`${line} ${word}`].length <= maxChars) { line += ` ${word}`; continue; }
    if (line) lines.push(line);
    const chars = [...word];
    while (chars.length > maxChars) lines.push(chars.splice(0, maxChars).join(''));
    line = chars.join('');
  }
  if (line) lines.push(line);
  return lines;
}
// Whole grid pixels per glyph pixel: Medium's 1.5x would put glyph edges on
// half pixels, so it rounds up to Detailed's 2x.
function captionUnit(grid) { return Math.max(1, Math.round(grid.width / pixelGrid().width)); }
/** Layout in native grid space. All required names/credits survive pagination. */
export function layoutPixelCaption(caption, { grid = pixelGrid(), localMs = 0 } = {}) {
  if (!caption) return null;
  const unit = captionUnit(grid), padding = 6 * unit;
  const maxWidth = grid.width - padding * 2;
  const maxChars = Math.floor((maxWidth / unit + 1) / PIXEL_ADVANCE);
  const required = [...(caption.rows || []).filter(row => row.name).map(row => [row.label, row.name].filter(Boolean).join(': ')), caption.credit].filter(Boolean);
  const textLines = required.flatMap(text => wrap(text, maxChars));
  if (!textLines.length) return null;
  if (caption.biome?.title) {
    const title = wrap(caption.biome.title, maxChars);
    if (textLines.length + title.length <= 6) textLines.unshift(...title);
  }
  const pageCount = Math.ceil(textLines.length / 6);
  const holdStart = CAPTION_DELAY_MS + CAPTION_FADE_MS;
  const progress = Math.max(0, Math.min(1, (localMs - holdStart) / CAPTION_HOLD_MS));
  const pageIndex = Math.min(pageCount - 1, Math.floor(progress * pageCount));
  const visible = textLines.slice(pageIndex * 6, (pageIndex + 1) * 6);
  const width = Math.max(...textLines.map(line => measurePixelText(line, unit)));
  const height = visible.length * PIXEL_LINE_ADVANCE * unit;
  const bounds = { x: grid.width - padding - width, y: grid.height - padding - height, width, height };
  const lines = visible.map((text, i) => ({ text, x: bounds.x, y: bounds.y + unit + i * PIXEL_LINE_ADVANCE * unit, width: measurePixelText(text, unit) }));
  return { lines, pageIndex, pageCount, bounds, accessibleText: captionAccessibleText(caption) };
}
/** Called after effects, on the captured composition, before quantization. */
export function drawPixelCaption(ctx, captions, songMs, { grid = pixelGrid() } = {}) {
  const up = captionAt(captions, songMs);
  if (!up) return null;
  const alpha = captionAlpha(up.localMs);
  if (!(alpha > 0)) return null;
  const layout = layoutPixelCaption(up.caption, { grid, localMs: up.localMs });
  if (!layout) return null;
  const unit = captionUnit(grid);
  ctx.save();
  ctx.globalAlpha = alpha * .72;
  ctx.fillStyle = '#000000';
  const b = layout.bounds;
  ctx.fillRect(b.x, b.y, b.width, b.height);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#f2f0f8';
  for (const line of layout.lines) drawPixelText(ctx, line.text, line.x, line.y, unit);
  ctx.restore();
  return layout;
}
const detailsCaptions = new WeakMap();
export function setCaptionDetails(element, caption) {
  if (!element || detailsCaptions.has(element) && detailsCaptions.get(element) === caption) return;
  detailsCaptions.set(element, caption);
  element.hidden = !caption;
  const body = element.querySelector('p');
  if (body) body.textContent = captionAccessibleText(caption);
}
