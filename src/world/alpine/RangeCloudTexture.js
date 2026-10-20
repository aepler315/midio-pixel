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
  // An overlapping, irregular bank with a broad base. No isolated tall
  // updraft or evenly spaced row of round lobes shared by every cloud.
  const span = .52 + hash(2, 17, seed) * .3;
  const centre = .44 + hash(3, 17, seed) * .12;
  const lobes = [{ x: centre, y: .67, z: .5, rx: span * .48, ry: .12, rz: .28 }];
  const count = 3 + Math.floor(hash(1, 19, seed) * 4);
  const crest = .3 + hash(2, 19, seed) * .15;
  for (let i = 0; i < count; i++) {
    const x = centre - span * .3 + i / (count - 1) * span * .6;
    const ry = .12 + hash(i, 5, seed) * .12;
    lobes.push({ x: x + (hash(i, 1, seed) - .5) * .1,
      y: crest + noise(x * 5, .5, seed + 3) * .18 + ry,
      z: .35 + hash(i, 3, seed) * .3,
      rx: .18 + hash(i, 4, seed) * .15, ry,
      rz: .18 + hash(i, 6, seed) * .16 });
  }
  return lobes;
}

function densityAt(u, v, z, seed, lobes) {
  if (u <= .01 || u >= .99 || v <= .01 || v >= .87 || z <= 0 || z >= 1) return 0;
  const warpedU = u + (noise3(u * 6, v * 6, z * 4, seed + 79) - .5) * .1;
  const warpedV = v + (noise3(u * 8, v * 5, z * 4, seed + 83) - .5) * .07;
  let envelope = 0;
  for (const lobe of lobes) {
    const x = (warpedU - lobe.x) / lobe.rx, y = (warpedV - lobe.y) / lobe.ry, depth = (z - lobe.z) / lobe.rz;
    const q = Math.max(0, 1 - (x * x + y * y + depth * depth) * .75);
    envelope = Math.max(envelope, q * q);
  }
  if (!envelope) return 0;
  // Three-dimensional turbulence erodes the volume, not just its outline.
  // Large clear pockets and finer billows share the same optical field.
  const broad = noise3(u * 7, v * 7, z * 6, seed + 31);
  const fine = noise3(u * 19, v * 19, z * 17, seed + 47);
  const turbulent = Math.max(0, envelope * (.9 + broad * .8) - .12 - (1 - fine) * .18);
  return turbulent * smooth((.855 - v) / .115)
    * smooth((u - .015) / .085) * smooth((.985 - u) / .085);
}

/** Twelve bounded front-to-back samples integrate optical thickness and
 * broad overhead illumination. density is final optical coverage (the same alpha
 * written to RGBA), not a surface mask or an unintegrated extinction value. */
function sample(u, v, seed, lobes) {
  if (!(u > 0 && u < 1 && v > 0 && v < 1)) return { density: 0, light: 0 };
  let transmittance = 1, radiance = 0;
  for (let i = 0; i < 12; i++) {
    const z = (i + .5) / 12;
    const density = densityAt(u, v, z, seed, lobes);
    if (!density) continue;
    const extinction = 1 - Math.exp(-density * .9);
    // Broad top-to-base illumination avoids bright rims around circular
    // dark centres, which read as holes in a repeated billboard.
    const light = .26 + .6 * (1 - smooth((v - .25) / .55))
      + .1 * noise3(u * 5, v * 4, z * 3, seed + 91);
    const contribution = transmittance * extinction;
    radiance += contribution * light;
    transmittance *= 1 - extinction;
  }
  const density = 1 - transmittance;
  return { density, light: density > 0 ? clamp(radiance / density) : 0 };
}

export function cloudDensity(u, v, seed) { return sample(u, v, seed, volume(seed)).density; }
export function cloudSample(u, v, seed) { return sample(u, v, seed, volume(seed)); }

/** World banks reuse these small RGBA sprites through a bounded cache; this pure builder retains no
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
