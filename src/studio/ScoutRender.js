// Browser extraction of tools/lib/scout-preview.mjs and scout-style.mjs.
// Retains their real DEM sampling and Landscape appearance study; no Node APIs.
// A cheap appearance study using the current Landscape's material inputs.
// This deliberately omits texture-map normals, cast shadows, real water
// masks, tree geometry and music. Habitat tint is the runtime's procedural
// elevation/slope treatment, not a survey of vegetation or snow coverage.
import { REAL_BIOMES } from '../world/RealBiomes.js';
import { rangeSkyState } from '../world/alpine/RangeFrame.js';
import { resolveCelestialState } from '../world/CelestialState.js';
import { LerpCache } from '../utils/color.js';
import { PALETTE_KEYS, RULE_KEYS, RULE_DEFAULTS } from '../world/alpine/MaterialPackage.js';
import { cinematicLightingProfile, cinematicAirAmount, cinematicGrade } from '../world/alpine/CinematicLighting.js';

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

// Cheap first-pass terrain stills. This heightfield column renderer offers a
// neutral shape study or optional Landscape-derived palette/placement/lighting
// treatment. Neither mode runs the full Landscape shader, texture maps, water,
// tree geometry or camera-motion tests. Heights and occlusion come from the DEM.
// Columns use perspective horizontal rays and pitched vertical projection;
// modest pitch is appropriate for scouting. Pixel-column ray paths are an
// approximation at large pitch, so this is not production-framing evidence.
const DEG = Math.PI / 180;
const LAT_M = 110540;
const LON_M = 111320;
const EARTH_RADIUS_M = 6371000;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Bilinear north-up cell-centre sampling; missing weighted data stays missing. */
export function sampleScoutHeight(grid, lon, lat) {
  if (!(lon >= grid.west && lon <= grid.east && lat >= grid.south && lat <= grid.north)) return NaN;
  const x = clamp((lon - grid.west) / (grid.east - grid.west) * grid.width - 0.5, 0, grid.width - 1);
  const y = clamp((grid.north - lat) / (grid.north - grid.south) * grid.height - 0.5, 0, grid.height - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, grid.width - 1), y1 = Math.min(y0 + 1, grid.height - 1);
  const ax = x - x0, ay = y - y0;
  let value = 0;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const weight = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay);
      if (!weight) continue;
      const h = grid.heightsM[(dy ? y1 : y0) * grid.width + (dx ? x1 : x0)];
      if (!Number.isFinite(h)) return NaN;
      value += weight * h;
    }
  }
  return value;
}

function validate(grid, camera, width, height, maxDistanceM) {
  if (!grid || !Number.isInteger(grid.width) || !Number.isInteger(grid.height)
    || grid.width < 2 || grid.height < 2 || grid.width * grid.height > 4_194_304
    || grid.heightsM?.length !== grid.width * grid.height
    || ![grid.west, grid.south, grid.east, grid.north].every(Number.isFinite)
    || !(grid.west < grid.east && grid.south < grid.north)
    || grid.west < -180 || grid.east > 180 || grid.south < -85 || grid.north > 85) {
    throw new Error('Invalid scout grid: bounded north-up real DEM required');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 960 || height > 540) {
    throw new Error('Invalid preview size: use 16–960 columns and 16–540 rows');
  }
  if (!Number.isFinite(maxDistanceM) || maxDistanceM < 100 || maxDistanceM > 120000) {
    throw new Error('Invalid preview distance: use 100–120000 metres');
  }
  const eye = camera?.eye;
  if (!eye || ![eye.lon, eye.lat, camera.headingDeg, camera.pitchDeg, camera.hfovDeg].every(Number.isFinite)
    || Math.abs(camera.pitchDeg) > 60 || camera.hfovDeg < 10 || camera.hfovDeg > 120
    || (eye.heightM != null ? !Number.isFinite(eye.heightM) : !Number.isFinite(eye.aboveGroundM))) {
    throw new Error('Invalid scout camera: finite eye, heading, pitch and 10–120 degree horizontal FOV required');
  }
}

function colorAt(grid, lon, lat, heightM, distanceM, stepLon, stepLat, cellXM, cellYM, style, eyeHeightM) {
  const west = sampleScoutHeight(grid, lon - stepLon, lat), east = sampleScoutHeight(grid, lon + stepLon, lat);
  const south = sampleScoutHeight(grid, lon, lat - stepLat), north = sampleScoutHeight(grid, lon, lat + stepLat);
  const nx = Number.isFinite(west + east) ? -(east - west) / (2 * cellXM) : 0;
  const nn = Number.isFinite(south + north) ? -(north - south) / (2 * cellYM) : 0;
  if (style) {
    const length = Math.hypot(nx, nn, 1);
    return shadeScoutSurface(style, { heightM, distanceM, eyeHeightM, normal: [nx / length, 1 / length, -nn / length], lon, lat });
  }
  const light = 0.43 + 0.57 * Math.max(0, (-0.57 * nx + 0.57 * nn + 0.59) / Math.hypot(nx, nn, 1));
  // Neutral relief tint only: elevation is not a snow/vegetation classifier.
  const rock = clamp(heightM / 4200, 0, 1);
  const haze = clamp(Math.pow(distanceM / 70000, 0.75), 0, 0.76);
  return [
    (90 + 73 * rock) * light * (1 - haze) + 113 * haze,
    (117 + 34 * rock) * light * (1 - haze) + 141 * haze,
    (102 + 29 * rock) * light * (1 - haze) + 158 * haze,
  ];
}

/**
 * Produce an opaque RGBA scouting still with bounded CPU work. Coverage is
 * the fraction of requested ray distance traversed before the first missing
 * sample/source boundary, averaged across columns. No-data terminates a ray;
 * terrain never resumes on the far side of a hole or extrapolates off-grid.
 * Eye ground must exist even with absolute height, to avoid a false preview.
 */
export function renderScoutPreview(grid, camera, { width = 320, height = 180, maxDistanceM = 60000, style = null } = {}) {
  validate(grid, camera, width, height, maxDistanceM);
  if (style && style.schema !== 'midio.scout-style') throw new Error('Invalid scout appearance style');
  const ground = sampleScoutHeight(grid, camera.eye.lon, camera.eye.lat);
  if (!Number.isFinite(ground)) throw new Error('Scout camera ground is outside available terrain or missing');
  const eyeHeight = camera.eye.heightM ?? ground + camera.eye.aboveGroundM;
  if (!(eyeHeight > ground)) throw new Error('Scout camera must be above the sampled ground');
  const rgba = new Uint8Array(width * height * 4);
  const focal = width / (2 * Math.tan(camera.hfovDeg * DEG / 2));
  const horizonY = Math.max(height * .25, height / 2 + focal * Math.tan(camera.pitchDeg * DEG));
  for (let y = 0; y < height; y++) {
    const gradient = Math.pow(y / (height - 1), 0.65);
    const [r, g, b] = style ? scoutSkyColor(style, y / horizonY) : [Math.round(28 + 142 * gradient), Math.round(65 + 126 * gradient), Math.round(88 + 108 * gradient)];
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      rgba[offset] = r; rgba[offset + 1] = g; rgba[offset + 2] = b; rgba[offset + 3] = 255;
    }
  }
  const lonScale = LON_M * Math.cos(camera.eye.lat * DEG);
  const stepLon = (grid.east - grid.west) / grid.width, stepLat = (grid.north - grid.south) / grid.height;
  const cellXM = stepLon * lonScale, cellYM = stepLat * LAT_M;
  const stepM = Math.max(50, Math.min(cellXM, cellYM) * 0.6);
  const pitchCos = Math.cos(camera.pitchDeg * DEG), pitchSin = Math.sin(camera.pitchDeg * DEG);
  const skylineY = new Uint16Array(width);
  let coverageSum = 0, missingColumns = 0, boundaryColumns = 0;
  for (let x = 0; x < width; x++) {
    const offsetAngle = Math.atan((x + 0.5 - width / 2) / focal);
    const angle = camera.headingDeg * DEG + offsetAngle;
    const eastPerM = Math.sin(angle) / lonScale, northPerM = Math.cos(angle) / LAT_M;
    const forwardScale = Math.cos(offsetAngle);
    let yLimit = height, distanceM = Math.min(30, maxDistanceM), lastValid = 0;
    // stepM >= 50 and distanceM <= 120km bound this loop below 600 samples.
    while (distanceM <= maxDistanceM) {
      const lon = camera.eye.lon + eastPerM * distanceM, lat = camera.eye.lat + northPerM * distanceM;
      if (lon < grid.west || lon > grid.east || lat < grid.south || lat > grid.north) { boundaryColumns++; break; }
      const h = sampleScoutHeight(grid, lon, lat);
      if (!Number.isFinite(h)) { missingColumns++; break; }
      lastValid = distanceM;
      // Effective Earth radius (7/6) includes ordinary terrestrial refraction.
      const upM = h - eyeHeight - distanceM * distanceM / (2 * EARTH_RADIUS_M * 7 / 6);
      const forwardM = distanceM * forwardScale;
      const depthM = forwardM * pitchCos + upM * pitchSin;
      if (depthM > 1) {
        const screenY = Math.ceil(height / 2 - focal * (upM * pitchCos - forwardM * pitchSin) / depthM);
        const top = clamp(screenY, 0, height);
        if (top < yLimit) {
          const rgb = colorAt(grid, lon, lat, h, distanceM, stepLon, stepLat, cellXM, cellYM, style, eyeHeight);
          for (let y = top; y < yLimit; y++) {
            const offset = (y * width + x) * 4;
            rgba[offset] = Math.round(rgb[0]); rgba[offset + 1] = Math.round(rgb[1]); rgba[offset + 2] = Math.round(rgb[2]);
          }
          yLimit = top;
        }
      }
      if (distanceM === maxDistanceM) break;
      distanceM = Math.min(maxDistanceM, distanceM + Math.max(stepM, distanceM * 0.025));
    }
    coverageSum += lastValid / maxDistanceM;
    skylineY[x] = yLimit;
  }
  const warnings = [];
  if (missingColumns) warnings.push(`Missing terrain stops ${missingColumns} of ${width} sight lines`);
  if (boundaryColumns) warnings.push(`Source boundary truncates ${boundaryColumns} of ${width} sight lines`);
  return { rgba, width, height, skylineY, coverage: coverageSum / width, ...(warnings.length ? { warning: warnings.join('; ') } : {}) };
}
