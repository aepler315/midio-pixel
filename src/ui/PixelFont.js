// Bundled 5×7 bodies, six-pixel advance, nine-pixel line advance. Lowercase
// uses capitals. Latin accents stay visible; other Unicode prints [U+XXXX].
export const PIXEL_GLYPH_HEIGHT = 7;
export const PIXEL_ADVANCE = 6;
export const PIXEL_LINE_ADVANCE = 9;
const BODIES = {
  ' ': '00 00 00 00 00 00 00',
  A: '0e 11 11 1f 11 11 11', B: '1e 11 11 1e 11 11 1e',
  C: '0f 10 10 10 10 10 0f', D: '1e 11 11 11 11 11 1e',
  E: '1f 10 10 1e 10 10 1f', F: '1f 10 10 1e 10 10 10',
  G: '0f 10 10 17 11 11 0f', H: '11 11 11 1f 11 11 11',
  I: '0e 04 04 04 04 04 0e', J: '07 02 02 02 12 12 0c',
  K: '11 12 14 18 14 12 11', L: '10 10 10 10 10 10 1f',
  M: '11 1b 15 15 11 11 11', N: '11 19 15 13 11 11 11',
  O: '0e 11 11 11 11 11 0e', P: '1e 11 11 1e 10 10 10',
  Q: '0e 11 11 11 15 12 0d', R: '1e 11 11 1e 14 12 11',
  S: '0f 10 10 0e 01 01 1e', T: '1f 04 04 04 04 04 04',
  U: '11 11 11 11 11 11 0e', V: '11 11 11 11 11 0a 04',
  W: '11 11 11 15 15 15 0a', X: '11 11 0a 04 0a 11 11',
  Y: '11 11 0a 04 04 04 04', Z: '1f 01 02 04 08 10 1f',
  0: '0e 11 13 15 19 11 0e', 1: '04 0c 04 04 04 04 0e',
  2: '0e 11 01 02 04 08 1f', 3: '1e 01 01 0e 01 01 1e',
  4: '02 06 0a 12 1f 02 02', 5: '1f 10 10 1e 01 01 1e',
  6: '0e 10 10 1e 11 11 0e', 7: '1f 01 02 04 08 08 08',
  8: '0e 11 11 0e 11 11 0e', 9: '0e 11 11 0f 01 01 0e',
  '.': '00 00 00 00 00 06 06', ',': '00 00 00 00 06 06 04',
  ':': '00 06 06 00 06 06 00', ';': '00 06 06 00 06 06 04',
  '-': '00 00 00 1f 00 00 00', '_': '00 00 00 00 00 00 1f',
  '+': '00 04 04 1f 04 04 00', '=': '00 00 1f 00 1f 00 00',
  '/': '01 02 02 04 08 08 10', '\\': '10 08 08 04 02 02 01',
  '(': '02 04 08 08 08 04 02', ')': '08 04 02 02 02 04 08',
  '[': '0e 08 08 08 08 08 0e', ']': '0e 02 02 02 02 02 0e',
  '{': '03 04 04 08 04 04 03', '}': '18 04 04 02 04 04 18',
  '!': '04 04 04 04 04 00 04', '?': '0e 11 01 02 04 00 04',
  "'": '04 04 02 00 00 00 00', '"': '0a 0a 0a 00 00 00 00',
  '&': '0c 12 14 08 15 12 0d', '*': '00 15 0e 1f 0e 15 00',
  '#': '0a 0a 1f 0a 1f 0a 0a', '%': '19 1a 02 04 08 0b 13',
  '@': '0e 11 17 15 17 10 0f', '$': '04 0f 14 0e 05 1e 04',
  '<': '02 04 08 10 08 04 02', '>': '08 04 02 01 02 04 08',
  '|': '04 04 04 04 04 04 04', '^': '04 0a 11 00 00 00 00',
  '~': '00 00 09 16 00 00 00', '`': '08 04 00 00 00 00 00',
  '·': '00 00 00 04 00 00 00', '°': '0c 12 12 0c 00 00 00',
  '©': '0e 11 15 19 15 11 0e', 'Ø': '0f 13 15 15 19 11 1e',
  'Æ': '0f 14 14 1f 14 14 17', 'Œ': '0f 14 14 17 14 14 0f',
  'Ł': '10 10 14 18 10 10 1f',
};
const rows = Object.fromEntries(Object.entries(BODIES).map(([c, body]) => [c, Object.freeze(body.split(' ').map(r => parseInt(r, 16)))]));
for (const c of ['–', '—', '−']) rows[c] = rows['-'];
for (const c of ['’', '‘']) rows[c] = rows["'"];
for (const c of ['“', '”']) rows[c] = rows['"'];
const ACCENTS = { '\u0300': 12, '\u0301': 6, '\u0302': 10, '\u0303': 21, '\u0308': 10, '\u030a': 4, '\u0327': 4 };
function glyph(c) {
  const upper = c.toUpperCase();
  if (rows[upper]) return { body: rows[upper] };
  const parts = [...upper.normalize('NFD')];
  if (parts.length === 2 && rows[parts[0]] && ACCENTS[parts[1]]) return { body: rows[parts[0]], accent: ACCENTS[parts[1]], below: parts[1] === '\u0327' };
  return null;
}
export function pixelFontText(text) {
  return [...String(text ?? '').normalize('NFC')].map(c => {
    if (glyph(c)) return c;
    if (c === 'ß') return 'SS';
    return `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`;
  }).join('');
}
export function measurePixelText(text, unit = 1) { return Math.max(0, [...pixelFontText(text)].length * PIXEL_ADVANCE - 1) * unit; }
export function drawPixelText(ctx, text, x, y, unit = 1) {
  for (const c of pixelFontText(text)) {
    const g = glyph(c);
    for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) {
      if (g.body[row] & (1 << (4 - col))) ctx.fillRect(x + col * unit, y + row * unit, unit, unit);
    }
    if (g.accent) for (let col = 0; col < 5; col++) {
      if (g.accent & (1 << (4 - col))) ctx.fillRect(x + col * unit, y + (g.below ? 7 : -1) * unit, unit, unit);
    }
    x += PIXEL_ADVANCE * unit;
  }
}
