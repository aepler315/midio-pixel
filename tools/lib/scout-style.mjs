// A cheap appearance study using the current Landscape's material inputs.
// This deliberately omits texture-map normals, cast shadows, real water
// masks, tree geometry and music. Habitat tint is the runtime's procedural
// elevation/slope treatment, not a survey of vegetation or snow coverage.
import { REAL_BIOMES } from '../../src/world/RealBiomes.js';
import { rangeSkyState } from '../../src/world/alpine/RangeFrame.js';
import { resolveCelestialState } from '../../src/world/CelestialState.js';
import { LerpCache } from '../../src/utils/color.js';
import { PALETTE_KEYS, RULE_KEYS, RULE_DEFAULTS } from '../../src/world/alpine/MaterialPackage.js';
import { cinematicLightingProfile, cinematicAirAmount, cinematicGrade } from '../../src/world/alpine/CinematicLighting.js';

const unit = value => Math.max(0, Math.min(1, value));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, value) => { const t = unit((value - a) / Math.max(1e-6, b - a)); return t * t * (3 - 2 * t); };
const mixColor = (a, b, t) => a.map((v, i) => mix(v, b[i], t));
const linear = hex => [1, 3, 5].map(offset => Math.pow(parseInt(hex.slice(offset, offset + 2), 16) / 255, 2.2));
const srgb = color => color.map(v => Math.round(255 * Math.pow(unit(v), 1 / 2.2)));
const filmic = x => unit(x * (2.51 * x + .03) / (x * (2.43 * x + .59) + .14));
// This still has no cast-shadow field or fine texture occlusion. Full runtime
// daylight/exposure washed out its broad surfaces, so these preview-only
// radiance controls retain the production material's colour and slope contrast.
// They are not a change to Landscape's lighting or exposure defaults.
export const SCOUT_DAYLIGHT = Object.freeze({ keyBudget: .65, ambientScale: 1.25, exposure: 1.5 });

/** Resolve actual palette, placement rules, Range sky and Cinematic response.
 * Light is a fixed front-side daylight study for readable relief in every
 * candidate orientation. No song phase or runtime camera pose is implied. */
export function createScoutStyle(material, { biome = 'CONIFER', cameraHeadingDeg = 0, materialRules = {} } = {}) {
  for (const key of PALETTE_KEYS) if (!/^#[0-9a-f]{6}$/i.test(material?.palette?.[key] || '')) throw new Error(`Invalid scout material palette: ${key}`);
  const rules = { ...RULE_DEFAULTS, ...material.rules, ...materialRules };
  for (const key of RULE_KEYS) if (!Number.isFinite(rules[key])) throw new Error(`Invalid scout material rules: ${key}`);
  for (const [key, value] of Object.entries(rules)) if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Invalid scout material rules: ${key}`);
  if (!(rules.airScale > 0)) throw new Error('Invalid scout material rules: airScale');
  if (!Number.isFinite(cameraHeadingDeg)) throw new Error('Invalid scout camera heading');
  const profile = REAL_BIOMES.find(row => row.name === biome) || REAL_BIOMES.find(row => row.name === 'CONIFER');
  const celestial = resolveCelestialState({ timeMs: 21000, cycleMs: 100000, viewport: { width: 320, height: 180 } });
  const manager = { celestialState: celestial, lerpCache: new LerpCache(), _rotated: color => color };
  const skyHex = rangeSkyState(manager, profile, profile, 0, 0, { skyDark: 1 });
  const sky = Object.fromEntries(Object.entries(skyHex).map(([key, value]) => [key, linear(value)]));
  const az = (cameraHeadingDeg + 225) * Math.PI / 180, altitude = 36 * Math.PI / 180;
  return {
    schema: 'midio.scout-style', version: 1, materialId: material.id, biome: profile.name,
    palette: Object.fromEntries(PALETTE_KEYS.map(key => [key, linear(material.palette[key])])), rules,
    skyHex, sky, cinematic: cinematicLightingProfile({ enabled: true, night01: 0, storm01: 0 }),
    lightDirection: [Math.sin(az) * Math.cos(altitude), Math.sin(altitude), -Math.cos(az) * Math.cos(altitude)],
    lightColor: linear(celestial.sun.colorHex).map(value => value * celestial.sun.directGain * SCOUT_DAYLIGHT.keyBudget),
    exposure: SCOUT_DAYLIGHT.exposure, ambientScale: SCOUT_DAYLIGHT.ambientScale, airDensity: rules.airScale / 55000,
    description: 'Current Landscape palette and elevation/slope rules; fixed daylight with preview exposure, simplified materials and atmosphere on coarse real terrain',
  };
}

/** Three-stop sky from RangeFrame, interpolated in linear light. */
export function scoutSkyColor(style, t) {
  const at = unit(t);
  return srgb(at < .55 ? mixColor(style.sky.top, style.sky.mid, at / .55) : mixColor(style.sky.mid, style.sky.horizon, (at - .55) / .45));
}

const fract = value => value - Math.floor(value);
const hash = (x, y) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453123);
function noise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), a = smooth(0, 1, fract(x)), b = smooth(0, 1, fract(y));
  return mix(mix(hash(ix, iy), hash(ix + 1, iy), a), mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), a), b);
}

/** Simplified CPU twin of TerrainMaterial's surface masks and lighting.
 * normal uses the production east/up/south convention. No height is changed. */
export function shadeScoutSurface(style, { heightM, distanceM, eyeHeightM, normal, lon, lat }) {
  const r = style.rules, p = style.palette, slope = Math.acos(unit(normal[1])) * 180 / Math.PI;
  const x = lon * 111320 * Math.cos(lat * Math.PI / 180), z = -lat * 110540;
  const variation = .62 * noise(x / 137, z / 137) + .38 * noise(x / 431, z / 431);
  const treeLine = r.treelineM + (variation - .5) * 220;
  const alpine = smooth(treeLine - 50, treeLine + 350, heightM);
  const cliff0 = Math.max(40, r.forestMaxSlopeDeg - 6);
  const rockMask = Math.max(smooth(cliff0, Math.max(cliff0 + 8, r.forestMaxSlopeDeg + 10), slope), alpine * smooth(20, 38, slope));
  const forest = (1 - smooth(treeLine - 90, treeLine + 60, heightM))
    * (1 - smooth(r.forestMaxSlopeDeg - 6, r.forestMaxSlopeDeg + 4, slope))
    * smooth(r.forestFloorM - 60, r.forestFloorM + 60, heightM) * unit(r.forestDensity);
  const snowLine = r.snowlineM + (variation - .5) * 260;
  const snow = smooth(snowLine, Math.max(snowLine + 1, snowLine + r.snowFullM - r.snowlineM), heightM)
    * (1 - smooth(r.snowMaxSlopeDeg - 10, r.snowMaxSlopeDeg + 6, slope));
  const ground = mixColor(p.meadow, p.soil, smooth(18, 34, slope));
  const rock = mixColor(mixColor(p.rockShade, p.rockLit, .58 + .25 * variation), p.rockWarm, unit(r.strata) * .18 * variation);
  let albedo = mixColor(ground, rock, rockMask);
  const forestColor = mixColor(p.forestNear, p.forestFar, smooth(1500, 12000, distanceM));
  albedo = mixColor(albedo, forestColor, forest);
  albedo = mixColor(albedo, mixColor(p.snowShade, p.snow, .7 + .3 * variation), snow);
  // The variation is colour only. It substitutes for fine material maps;
  // the terrain silhouette and every sample elevation remain unchanged.
  albedo = albedo.map(value => value * (.92 + .16 * variation));
  const dot = normal.reduce((sum, value, i) => sum + value * style.lightDirection[i], 0);
  const wrap = style.cinematic.light[3], key = Math.max(0, (dot + wrap) / (1 + wrap));
  const hemisphere = mixColor(style.sky.horizon.map(value => value * .55), style.sky.top, .5 + .5 * normal[1]);
  const cool = [.91, .98, 1.06], warm = [1.025, 1.005, .98];
  const lit = albedo.map((value, i) => value * (
    hemisphere[i] * .9 * style.ambientScale * style.cinematic.light[1] * mix(cool[i], 1, unit(key))
    + style.lightColor[i] * warm[i] * key));
  const physical = cinematicGrade(lit.map(value => filmic(value * style.exposure)));
  const heightTerm = Math.exp(-Math.max(0, heightM - eyeHeightM * .25) / 2500);
  const air = cinematicAirAmount({ distanceM, density: style.airDensity, heightTerm, scale: style.cinematic.air[0], startM: style.cinematic.air[2] });
  return srgb(mixColor(physical, style.sky.air, air));
}
