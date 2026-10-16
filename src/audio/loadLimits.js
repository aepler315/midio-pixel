const MIB = 1024 * 1024;

/** Resource budgets for user-selected audio before expensive Web Audio work. */
export const AUDIO_LOAD_LIMITS = Object.freeze({
  maxFiles: 8,
  maxFileBytes: 256 * MIB,
  maxTotalFileBytes: 512 * MIB,
  maxDecodedBytes: 512 * MIB,
  maxTotalDecodedBytes: 768 * MIB,
  maxDurationSeconds: 20 * 60,
  maxChannels: 2,
});

export function audioAbortError(message = 'Audio analysis cancelled') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw audioAbortError();
}

export function validateAudioFiles(files, limits = AUDIO_LOAD_LIMITS) {
  const list = [...(files || [])].filter(Boolean);
  if (list.length > limits.maxFiles) {
    throw new Error(`Audio load accepts at most ${limits.maxFiles} files at once`);
  }
  let declaredTotal = 0;
  for (const file of list) {
    const size = Number(file.size);
    if (!Number.isFinite(size) || size < 0) continue;
    if (size > limits.maxFileBytes) {
      throw new Error(`Audio file ${file.name || '(unnamed)'} exceeds the ${limits.maxFileBytes} byte limit`);
    }
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalFileBytes) {
      throw new Error(`Selected audio exceeds the ${limits.maxTotalFileBytes} byte total limit`);
    }
  }
  return list;
}

export function validateAudioBytes(byteLength, name = 'audio file', limits = AUDIO_LOAD_LIMITS) {
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    throw new Error(`${name} has an invalid byte length`);
  }
  if (byteLength > limits.maxFileBytes) {
    throw new Error(`${name} exceeds the ${limits.maxFileBytes} byte limit`);
  }
}

export function accumulateEncodedAudioBytes(
  currentBytes,
  byteLength,
  name = 'audio file',
  limits = AUDIO_LOAD_LIMITS,
) {
  validateAudioBytes(byteLength, name, limits);
  const total = Number(currentBytes) + byteLength;
  if (!Number.isSafeInteger(total) || total > limits.maxTotalFileBytes) {
    throw new Error(`Selected audio exceeds the ${limits.maxTotalFileBytes} byte total limit`);
  }
  return total;
}

export function decodedAudioByteLength(buffer) {
  const length = Number(buffer?.length);
  const channels = Number(buffer?.numberOfChannels);
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(channels) || channels < 1) return NaN;
  return length * channels * Float32Array.BYTES_PER_ELEMENT;
}

export function validateDecodedByteLength(byteLength, limits = AUDIO_LOAD_LIMITS) {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new Error('Decoded audio has an invalid sample buffer');
  }
  if (byteLength > limits.maxDecodedBytes) {
    throw new Error(`Decoded audio exceeds the ${limits.maxDecodedBytes} byte memory limit`);
  }
  return byteLength;
}

export function accumulateDecodedByteLength(currentBytes, byteLength, limits = AUDIO_LOAD_LIMITS) {
  validateDecodedByteLength(byteLength, limits);
  const total = Number(currentBytes) + byteLength;
  if (!Number.isSafeInteger(total) || total > limits.maxTotalDecodedBytes) {
    throw new Error(`Selected audio exceeds the ${limits.maxTotalDecodedBytes} byte decoded-memory limit`);
  }
  return total;
}

/** Add one decoded buffer to the process-wide memory budget. */
export function accumulateDecodedAudioBytes(currentBytes, buffer, limits = AUDIO_LOAD_LIMITS) {
  return accumulateDecodedByteLength(currentBytes, decodedAudioByteLength(buffer), limits);
}

export function validateDecodedAudioBuffer(buffer, limits = AUDIO_LOAD_LIMITS) {
  const duration = Number(buffer?.duration);
  const channels = Number(buffer?.numberOfChannels);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Decoded audio has no usable duration');
  }
  if (duration > limits.maxDurationSeconds) {
    throw new Error(`Audio duration exceeds the ${limits.maxDurationSeconds} second limit`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > limits.maxChannels) {
    throw new Error(`Audio must contain between 1 and ${limits.maxChannels} channels`);
  }
  const decodedBytes = decodedAudioByteLength(buffer);
  validateDecodedByteLength(decodedBytes, limits);
  return buffer;
}
