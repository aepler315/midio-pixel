import { copySongprintSkyline } from '../../audio/SongprintData.js';
import { clamp01 } from '../../utils/math.js';

export const INLAND_TERRAIN_VERSION = 1;
const FLOOR_OFFSET_M = 96;
const REGION_WIDTH_M = 89600;
const smooth = t => t * t * (3 - 2 * t);
const mix = (a, b, t) => a + (b - a) * t;

/** The recording's measured outline lays out the region. The seed makes
 * smaller landforms repeatable at any world coordinate or tile size. */
export function makeInlandTerrain(seed, songprint) {
  const print = copySongprintSkyline(songprint);
  if (!print) return null;

  const { skyline } = print;
  const last = skyline.length - 1;
  let mean = 0, variation = 0, balance = 0;
  for (const [i, height] of skyline.entries()) {
    mean += height / skyline.length;
    balance += height * (2 * i / last - 1) / skyline.length;
    if (i) variation += Math.abs(height - skyline[i - 1]) / last;
  }
  const spread = Math.max(...skyline) - Math.min(...skyline);
  const direction = .33 * Math.PI + 2.8 * balance + .72 * (skyline[last] - skyline[0]);

  return Object.freeze({
    version: INLAND_TERRAIN_VERSION,
    seed: seed >>> 0,
    skyline: Object.freeze(skyline),
    east: Math.cos(direction),
    north: Math.sin(direction),
    spacingM: 11200 - 5800 * clamp01(variation * 3.1),
    reliefM: 880 + 450 * spread + 500 * mean,
  });
}

function corner(seed, x, z) {
  let bits = seed ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(z, 0x85ebca77);
  bits = Math.imul(bits ^ bits >>> 16, 0x7feb352d);
  bits = Math.imul(bits ^ bits >>> 15, 0x846ca68b);
  return ((bits ^ bits >>> 16) >>> 0) / 0xffffffff;
}

function plane(seed, x, z) {
  const i = Math.floor(x), j = Math.floor(z);
  const u = smooth(x - i), v = smooth(z - j);
  return mix(mix(corner(seed, i, j), corner(seed, i + 1, j), u),
    mix(corner(seed, i, j + 1), corner(seed, i + 1, j + 1), u), v);
}

function contour(skyline, alongM) {
  const last = skyline.length - 1;
  const p = last * clamp01(.5 + alongM / REGION_WIDTH_M);
  const i = Math.floor(p);
  return mix(skyline[i], skyline[Math.min(last, i + 1)], smooth(p - i));
}

/** Continuous dry ground in local stage metres. Warped parallel belts set
 * the large terrain. Passes break those belts along the song's outline,
 * and smaller foothills give the slopes depth between measured massifs. */
export function inlandHeightAt(field, baseM, x, z) {
  const { seed, skyline, east, north, spacingM, reliefM } = field;
  const along = x * east + z * north;
  const across = z * east - x * north;
  const outline = contour(skyline, along);
  const region = plane(seed ^ 0x67e55c19, along / 15000, across / 9800);
  const saddle = plane(seed ^ 0xf3c2770d, along / 7300, across / 17000);
  const phase = across / spacingM + .73 * (saddle - .5) + .76 * (region - .5) + .28 * (outline - .5);
  const crest = 1 - 2 * Math.abs(phase - Math.floor(phase + .5));
  const connection = smooth(clamp01((saddle + .4 * region - .38) / .67));
  const ridge = smooth(crest) * (.12 + .88 * connection) * (.45 + .55 * outline);
  const spur = plane(seed ^ 0x149f663d, (along + .31 * across) / 8200, (across - .37 * along) / 6900);
  const shoulder = plane(seed ^ 0x39ad6ec2, along / 3300, across / 2300);
  const foothills = plane(seed ^ 0xcafab27b, x / 1080, z / 930);
  const grain = plane(seed ^ 0x5bc98932, x / 510, z / 430);
  const height01 = .49 * ridge + .18 * smooth(region) + .13 * smooth(spur) + .17 * smooth(shoulder) + .022 * foothills + .008 * grain;
  return baseM + FLOOR_OFFSET_M + reliefM * height01;
}

/** Conservative full-field bounds for shared height quantization. */
export function inlandHeightBounds(field, baseM) {
  return [baseM + FLOOR_OFFSET_M, baseM + FLOOR_OFFSET_M + field.reliefM];
}
