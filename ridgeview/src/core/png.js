// Minimal PNG decoder for elevation tiles: 8-bit greyscale/RGB/RGBA,
// non-interlaced. Decoding the bytes ourselves (instead of drawing to a 2D
// canvas) keeps the exact RGB values; canvas readback can apply colour
// management or premultiplication and corrupt encoded heights.
// `inflate` is injected: zlib.inflateSync in Node, DecompressionStream in the
// browser. It takes zlib bytes and returns (a promise of) raw bytes.

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

export async function decodePng(bytes, inflate) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) throw new Error('not a PNG');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  let idatLen = 0;
  while (pos + 8 <= b.length) {
    const len = view.getUint32(pos);
    const name = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      width = view.getUint32(pos + 8); height = view.getUint32(pos + 12);
      depth = b[pos + 16]; type = b[pos + 17]; interlace = b[pos + 20];
    } else if (name === 'IDAT') { idat.push(data); idatLen += len; } else if (name === 'IEND') break;
    pos += 12 + len;
  }
  const channels = CHANNELS[type];
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const z = new Uint8Array(idatLen);
  let o = 0;
  for (const c of idat) { z.set(c, o); o += c.length; }
  const raw = await inflate(z);
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('truncated PNG data');
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[dst + x - channels] : 0;
      const up = y ? out[prev + x] : 0;
      const c = x >= channels && y ? out[prev + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      } else if (f !== 0) throw new Error(`bad PNG filter ${f}`);
      out[dst + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

/** Terrarium encoding: height = R * 256 + G + B / 256 - 32768 (metres). */
export function terrariumToHeights({ width, height, channels, data }) {
  if (channels < 3) throw new Error('terrarium tiles are RGB');
  const h = new Float32Array(width * height);
  for (let i = 0, j = 0; i < h.length; i++, j += channels) {
    h[i] = data[j] * 256 + data[j + 1] + data[j + 2] / 256 - 32768;
  }
  return h;
}

/** Browser inflate for zlib streams. */
export async function inflateBrowser(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
