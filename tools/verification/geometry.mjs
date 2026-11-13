import { hash } from './io.mjs';
// Include every returned band field: draw ranges, culling and seam metadata
// affect the visible result even when vertex/index buffers stay unchanged.
export function geometryChecksum(geometry) {
  const encode = value => {
    if (ArrayBuffer.isView(value)) return { type: value.constructor.name, bytes: value.byteLength,
      sha256: hash(Buffer.from(value.buffer, value.byteOffset, value.byteLength)) };
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, encode(value[key])]));
    return value;
  };
  return hash(encode(geometry));
}
