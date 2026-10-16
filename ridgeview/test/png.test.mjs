import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng, terrariumToHeights } from '../src/core/png.js';

// Build a PNG by hand with every filter type to exercise the unfilterer.
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    let c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const nd = Buffer.concat([Buffer.from(name, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(nd));
  return Buffer.concat([len, nd, crc]);
}
function encode(width, height, rgb, filters) {
  const stride = width * 3, rows = [];
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length], row = Buffer.alloc(stride + 1);
    row[0] = f;
    for (let x = 0; x < stride; x++) {
      const v = rgb[y * stride + x], a = x >= 3 ? rgb[y * stride + x - 3] : 0;
      const up = y ? rgb[(y - 1) * stride + x] : 0, c = x >= 3 && y ? rgb[(y - 1) * stride + x - 3] : 0;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = up;
      else if (f === 3) p = (a + up) >> 1;
      else if (f === 4) {
        const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      row[x + 1] = (v - p) & 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('decodes every PNG filter type exactly', async () => {
  const w = 7, h = 10, rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37 + (i >> 3) * 11) & 255;
  const png = encode(w, h, rgb, [0, 1, 2, 3, 4]);
  const img = await decodePng(png, (z) => zlib.inflateSync(z));
  assert.equal(img.width, w);
  assert.equal(img.height, h);
  assert.equal(img.channels, 3);
  assert.deepEqual([...img.data], [...rgb]);
});

test('rejects non-PNG input', async () => {
  await assert.rejects(decodePng(new Uint8Array(16), (z) => z), /not a PNG/);
});

test('terrarium decoding', () => {
  // 128,0,0 = 0 m; 129,2,128 = 258.5 m; 127,255,0 = -1 m
  const hs = terrariumToHeights({ width: 3, height: 1, channels: 3, data: new Uint8Array([128, 0, 0, 129, 2, 128, 127, 255, 0]) });
  assert.deepEqual([...hs], [0, 258.5, -1]);
});
