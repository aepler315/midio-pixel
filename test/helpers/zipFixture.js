// Builds minimal ZIP files in memory for unit tests.
// Supports stored (method 0) and deflate (method 8) compression.

import zlib from 'node:zlib';

function crc32(data) {
  // Standard CRC-32 (same as PKZIP)
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP with stored (uncompressed) entries.
 * @param {{name:string, data:Uint8Array}[]} entries
 * @returns {ArrayBuffer}
 */
export function buildStoredZip(entries) {
  const parts = [];
  const centralEntries = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);

    // Local file header
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);   // signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // method (stored)
    lv.setUint16(10, 0, true);           // mod time
    lv.setUint16(12, 0, true);           // mod date
    lv.setUint32(14, crc, true);         // CRC-32
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // extra length
    lfh.set(nameBytes, 30);

    parts.push(lfh, data);
    centralEntries.push({ nameBytes, crc, size: data.length, offset });
    offset += lfh.length + data.length;
  }

  // Central directory
  const cdParts = [];
  let cdSize = 0;
  for (const e of centralEntries) {
    const cdh = new Uint8Array(46 + e.nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);   // signature
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0, true);            // flags
    cv.setUint16(10, 0, true);           // method (stored)
    cv.setUint16(12, 0, true);           // mod time
    cv.setUint16(14, 0, true);           // mod date
    cv.setUint32(16, e.crc, true);       // CRC-32
    cv.setUint32(20, e.size, true);      // compressed size
    cv.setUint32(24, e.size, true);      // uncompressed size
    cv.setUint16(28, e.nameBytes.length, true);
    cv.setUint16(30, 0, true);           // extra length
    cv.setUint16(32, 0, true);           // comment length
    cv.setUint16(34, 0, true);           // disk number
    cv.setUint16(36, 0, true);           // internal attrs
    cv.setUint32(38, 0, true);           // external attrs
    cv.setUint32(42, e.offset, true);    // local header offset
    cdh.set(e.nameBytes, 46);
    cdParts.push(cdh);
    cdSize += cdh.length;
  }
  const cdOffset = offset;

  // End of central directory
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);     // signature
  ev.setUint16(4, 0, true);              // disk number
  ev.setUint16(6, 0, true);              // disk with CD
  ev.setUint16(8, centralEntries.length, true); // entries on this disk
  ev.setUint16(10, centralEntries.length, true); // total entries
  ev.setUint32(12, cdSize, true);        // CD size
  ev.setUint32(16, cdOffset, true);      // CD offset
  ev.setUint16(20, 0, true);             // comment length

  // Assemble
  const total = [...parts, ...cdParts, eocd].reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of [...parts, ...cdParts, eocd]) {
    result.set(p, pos);
    pos += p.length;
  }
  return result.buffer;
}

/**
 * Build a ZIP with deflate (method 8) entries.
 * @param {{name:string, data:Uint8Array}[]} entries
 * @returns {ArrayBuffer}
 */
export function buildDeflateZip(entries) {
  const parts = [];
  const centralEntries = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data);

    // Local file header
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 8, true);            // method (deflate)
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lfh.set(nameBytes, 30);

    parts.push(lfh, compressed);
    centralEntries.push({ nameBytes, crc, compSize: compressed.length, size: data.length, offset });
    offset += lfh.length + compressed.length;
  }

  // Central directory
  const cdParts = [];
  let cdSize = 0;
  for (const e of centralEntries) {
    const cdh = new Uint8Array(46 + e.nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 8, true);           // method (deflate)
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.compSize, true);
    cv.setUint32(24, e.size, true);
    cv.setUint16(28, e.nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, e.offset, true);
    cdh.set(e.nameBytes, 46);
    cdParts.push(cdh);
    cdSize += cdh.length;
  }
  const cdOffset = offset;

  // EOCD
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, centralEntries.length, true);
  ev.setUint16(10, centralEntries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);

  const total = [...parts, ...cdParts, eocd].reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of [...parts, ...cdParts, eocd]) {
    result.set(p, pos);
    pos += p.length;
  }
  return result.buffer;
}