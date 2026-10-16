function rgbDifference(data, a, b) {
  return Math.max(Math.abs(data[a] - data[b]), Math.abs(data[a + 1] - data[b + 1]), Math.abs(data[a + 2] - data[b + 2]));
}
/** Fill admitted storage from the ORIGINAL RGB frame. No allocation/history. */
export function buildDitherWeights({ data, width, height }, output) {
  const pixels = width * height;
  if (!(output instanceof Uint8Array) || output.length < pixels || data.length < pixels * 4) throw new RangeError('Dither storage must cover the frame');
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = y * width + x, i = pixel * 4;
    let difference = 0;
    if (x > 0) difference = Math.max(difference, rgbDifference(data, i, i - 4));
    if (x + 1 < width) difference = Math.max(difference, rgbDifference(data, i, i + 4));
    if (y > 0) difference = Math.max(difference, rgbDifference(data, i, i - width * 4));
    if (y + 1 < height) difference = Math.max(difference, rgbDifference(data, i, i + width * 4));
    output[pixel] = difference <= 16 ? 255 : difference >= 48 ? 0 : Math.round((48 - difference) * 255 / 32);
  }
  return output;
}
