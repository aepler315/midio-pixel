const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
function hash(x, y, seed) {
  let value = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967296;
}
function noise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
  const top = hash(ix, iy, seed) * (1 - fx) + hash(ix + 1, iy, seed) * fx;
  const bottom = hash(ix, iy + 1, seed) * (1 - fx) + hash(ix + 1, iy + 1, seed) * fx;
  return top * (1 - fy) + bottom * fy;
}

function noise3(x, y, z, seed) {
  const iz = Math.floor(z), fz = smooth(z - iz);
  return noise(x, y, seed + Math.imul(iz, 1013)) * (1 - fz)
    + noise(x, y, seed + Math.imul(iz + 1, 1013)) * fz;
}
function volume(seed) {
  const lobes = [{ x: .5, y: .64, z: .5, rx: .46, ry: .23, rz: .34 }];
  const updraft = Math.floor(hash(1, 19, seed) * 4);
  for (let i = 0; i < 4; i++) {
    const ry = .17 + hash(i, 5, seed) * .1;
    lobes.push({ x: .2 + i * .2 + (hash(i, 1, seed) - .5) * .07,
      y: (i === updraft ? .08 : .26) + hash(i, 2, seed) * .07 + ry, z: .4 + hash(i, 3, seed) * .2,
      rx: .19 + hash(i, 4, seed) * .065, ry,
      rz: .22 + hash(i, 6, seed) * .1 });
  }
  return lobes;
}

function densityAt(u, v, z, seed, lobes) {
  if (u <= .01 || u >= .99 || v <= .01 || v >= .87 || z <= 0 || z >= 1) return 0;
  let envelope = 0;
  for (const lobe of lobes) {
    const x = (u - lobe.x) / lobe.rx, y = (v - lobe.y) / lobe.ry, depth = (z - lobe.z) / lobe.rz;
    const q = Math.max(0, 1 - (x * x + y * y + depth * depth) * .75);
    envelope += q * q;
  }
  if (!envelope) return 0;
  // Three-dimensional turbulence erodes the volume, not just its outline.
  // Large clear pockets and finer billows share the same optical field.
  const broad = noise3(u * 7, v * 7, z * 6, seed + 31);
  const fine = noise3(u * 19, v * 19, z * 17, seed + 47);
  const turbulent = Math.max(0, envelope * (.65 + broad * .8) - .12 - (1 - fine) * .2);
  return turbulent * smooth((.855 - v) / .115)
    * smooth((u - .015) / .085) * smooth((.985 - u) / .085);
}

/** Twelve bounded front-to-back samples integrate optical thickness and
 * sunward attenuation. density is final optical coverage (the same alpha
 * written to RGBA), not a surface mask or an unintegrated extinction value. */
function sample(u, v, seed, lobes) {
  if (!(u > 0 && u < 1 && v > 0 && v < 1)) return { density: 0, light: 0 };
  let transmittance = 1, radiance = 0;
  for (let i = 0; i < 12; i++) {
    const z = (i + .5) / 12;
    const density = densityAt(u, v, z, seed, lobes);
    if (!density) continue;
    const extinction = 1 - Math.exp(-density * .65);
    const sunDepth = densityAt(u - .065, v - .09, z - .07, seed, lobes) * 1.1
      + densityAt(u - .15, v - .22, z - .17, seed, lobes) * 1.5;
    const sunlight = Math.exp(-sunDepth);
    const light = .23 + .69 * sunlight + .16 * (1 - smooth((v - .3) / .5));
    const contribution = transmittance * extinction;
    radiance += contribution * light;
    transmittance *= 1 - extinction;
  }
  const density = 1 - transmittance;
  return { density, light: density > 0 ? clamp(radiance / density) : 0 };
}

export function cloudDensity(u, v, seed) { return sample(u, v, seed, volume(seed)).density; }
export function cloudSample(u, v, seed) { return sample(u, v, seed, volume(seed)); }

/** Six callers reuse these small RGBA sprites; this pure builder retains no
 * image/cache. Refuse accidental full-frame allocations at this boundary. */
export function buildCloudTexture(seed, width = 192, height = 128) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || width > 192 || height < 2 || height > 128) {
    throw new RangeError('Cloud texture dimensions must be integers within 2..192 by 2..128');
  }
  const pixels = new Uint8ClampedArray(width * height * 4);
  const lobes = volume(seed);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const { density, light } = sample(x / (width - 1), y / (height - 1), seed, lobes);
    if (!density) continue;
    const i = (y * width + x) * 4;
    pixels[i] = 105 + 150 * light;
    pixels[i + 1] = 122 + 133 * light;
    pixels[i + 2] = 145 + 110 * light;
    pixels[i + 3] = Math.round(density * 255);
  }
  return pixels;
}
