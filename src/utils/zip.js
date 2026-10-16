// Minimal ZIP extractor: EOCD scan → central-directory walk; stored (method 0)
// and deflate (method 8) via DecompressionStream('deflate-raw'). Returns a
// Map<filename, Uint8Array> of every regular file in the archive.
// Works in the browser (from SoundfontLibrary .zip upload) and in Node 18+
// (for unit tests) — both provide DecompressionStream, Blob, and Response
// as globals.

const EOCD_SIG = 0x06054b50; // "PK\x05\x06"
const CDH_SIG = 0x02014b50;  // "PK\x01\x02"
const LFH_SIG = 0x04034b50;  // "PK\x03\x04"

const MIB = 1024 * 1024;

/** Safety budgets for user-supplied soundfont archives. */
export const ZIP_LIMITS = Object.freeze({
  maxInputBytes: 128 * MIB,
  maxEntries: 256,
  maxNameBytes: 1024,
  maxEntryBytes: 64 * MIB,
  maxTotalBytes: 128 * MIB,
  maxCompressionRatio: 1000,
});

function zipLimits(options = {}) {
  const limits = { ...ZIP_LIMITS, ...options };
  for (const key of Object.keys(ZIP_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
      throw new RangeError(`zip: ${key} must be a positive safe integer`);
    }
  }
  if (limits.maxCompressionRatio < 1) {
    throw new RangeError('zip: maxCompressionRatio must be at least 1');
  }
  return limits;
}

function requireRange(offset, length, total, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length < 0 || offset > total - length) {
    throw new Error(`zip: ${label} is outside the archive`);
  }
}

function limitedDecompressionStream(stream, maxBytes) {
  let produced = 0;
  const limiter = new TransformStream({
    transform(chunk, controller) {
      produced += chunk.byteLength;
      if (produced > maxBytes) {
        controller.error(new Error('zip: decompressed output exceeds budget'));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return stream.pipeThrough(limiter);
}

function findEocd(buf) {
  // The EOCD record is at least 22 bytes, but a comment of up to 65535 bytes
  // may follow it, so scan backwards from the very end.
  const minEocd = 22;
  const maxComment = 0xffff;
  const scanStart = Math.max(0, buf.byteLength - minEocd - maxComment);
  for (let i = buf.byteLength - minEocd; i >= scanStart; i--) {
    if (
      buf[i] === 0x50 && buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 && buf[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Extract all regular files from a ZIP archive.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<Map<string, Uint8Array>>} filename → decompressed bytes
 */
export async function extractZip(arrayBuffer, options = {}) {
  const limits = zipLimits(options);
  const buf = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  if (buf.byteLength > limits.maxInputBytes) {
    throw new Error(`zip: archive exceeds ${limits.maxInputBytes} byte input budget`);
  }
  const eocdOff = findEocd(buf);
  if (eocdOff < 0) throw new Error('zip: EOCD signature not found');
  requireRange(eocdOff, 22, buf.byteLength, 'EOCD');

  const cdCount = dv.getUint16(eocdOff + 10, true);
  const cdOff = dv.getUint32(eocdOff + 16, true);
  if (cdCount === 0xffff || cdOff === 0xffffffff) {
    throw new Error('zip: ZIP64 archives are not supported');
  }
  if (cdCount > limits.maxEntries) {
    throw new Error(`zip: entry count exceeds ${limits.maxEntries}`);
  }
  requireRange(cdOff, 0, buf.byteLength, 'central directory');

  const files = new Map();
  let ptr = cdOff;
  let totalBytes = 0;

  for (let i = 0; i < cdCount; i++) {
    requireRange(ptr, 46, buf.byteLength, 'central-directory header');
    if (dv.getUint32(ptr, true) !== CDH_SIG) {
      throw new Error('zip: malformed central-directory header');
    }

    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const uncompSize = dv.getUint32(ptr + 24, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOff = dv.getUint32(ptr + 42, true);

    if (nameLen > limits.maxNameBytes) {
      throw new Error(`zip: filename exceeds ${limits.maxNameBytes} bytes`);
    }
    requireRange(ptr + 46, nameLen + extraLen + commentLen, buf.byteLength, 'central-directory record');
    const name = new TextDecoder().decode(
      buf.subarray(ptr + 46, ptr + 46 + nameLen),
    );

    const entryEnd = ptr + 46 + nameLen + extraLen + commentLen;

    if (uncompSize > limits.maxEntryBytes) {
      throw new Error(`zip: uncompressed size exceeds ${limits.maxEntryBytes} bytes`);
    }
    if (totalBytes > limits.maxTotalBytes - uncompSize) {
      throw new Error(`zip: total uncompressed size exceeds ${limits.maxTotalBytes} bytes`);
    }
    if (method === 8 && (compSize === 0 || uncompSize / compSize > limits.maxCompressionRatio)) {
      throw new Error(`zip: compression ratio exceeds ${limits.maxCompressionRatio}`);
    }
    totalBytes += uncompSize;

    // Skip directory entries (name ends with /)
    if (name.endsWith('/')) {
      ptr = entryEnd;
      continue;
    }

    // Read local header to find actual data offset
    requireRange(localOff, 30, buf.byteLength, 'local file header');
    if (dv.getUint32(localOff, true) !== LFH_SIG) {
      throw new Error('zip: malformed local file header');
    }
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    requireRange(dataOff, compSize, buf.byteLength, 'compressed entry');
    const compressed = buf.subarray(dataOff, dataOff + compSize);

    if (method === 0) {
      // Stored — no compression
      if (compSize !== uncompSize) {
        throw new Error('zip: stored entry size mismatch');
      }
      files.set(name, new Uint8Array(compressed));
    } else if (method === 8) {
      // Deflate via Web Streams API (browser + Node 18+)
      const ds = new DecompressionStream('deflate-raw');
      const blob = new Blob([compressed]);
      const stream = limitedDecompressionStream(blob.stream().pipeThrough(ds), limits.maxEntryBytes);
      const decompressed = await new Response(stream).arrayBuffer();
      if (decompressed.byteLength !== uncompSize) {
        throw new Error('zip: decompressed size does not match central directory');
      }
      files.set(name, new Uint8Array(decompressed));
    } else {
      // Unsupported compression is rejected rather than silently bypassing
      // archive accounting and leaving callers with an incomplete font set.
      throw new Error(`zip: unsupported compression method ${method}`);
    }

    ptr = entryEnd;
  }

  return files;
}
