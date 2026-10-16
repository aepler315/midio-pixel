// Build a three-layer skyline profile from a north-up lat/lon elevation
// grid (Float32, row 0 = north). The grid is an argument, not fetched here.
//
//   node tools/build-terrain-profile.mjs grid.json out.json [guides.geojson]
//
// grid.json: { west, south, east, north, width, height, elevB64 }
// guides.geojson: FeatureCollection of LineStrings, properties.layer = far|mid|near,
// coordinates [lon, lat]. Without a guide file the crest is the highest cell per row.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { demFromLatLon, crestGuideTraced } from '../src/world/terrain/LatLonDem.js';
import { rangeLayerProfiles, compositeLayerProfiles, profilesToJSON } from '../src/world/terrain/TerrainProfile.js';
import { scanCorridor, smoothBaseline, pointAlong } from '../src/world/terrain/SkylineScan.js';
import { guidesFromGeoJSON } from '../src/world/terrain/GuideGeoJSON.js';

const args = process.argv.slice(2);
const [gridPath, outPath] = args;
const guidePath = args.slice(2).find((arg) => !arg.startsWith('--')) || null;
const moduleArg = args.find((arg) => arg.startsWith('--module='));
const modulePath = moduleArg ? moduleArg.slice('--module='.length) : null;
if (!gridPath || !outPath) {
  console.error('usage: node tools/build-terrain-profile.mjs grid.json out.json [guides.geojson] [--module=out.js]');
  process.exit(1);
}
const gridBytes = readFileSync(gridPath);
const src = JSON.parse(gridBytes.toString('utf8'));
const buf = Buffer.from(src.elevB64, 'base64');
const elev = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const dem = demFromLatLon({ ...src, elev }, src.cellM || 200);
// Traced, not per-row max: the per-row max hops between parallel ridges
// (see crestGuideTraced), which broke every skyline built without
// hand-authored guides.
const guide = crestGuideTraced(dem, 500);
// Which side the camera stands on decides whether the main crest is what
// you see at all. From the wrong side, nearer and lower terrain gets in the
// way: the automated Teton build viewed from the west had its skyline sit
// 400-1,300m below the crest for most of the range. Unless the grid names a
// side, scan from both and keep the one whose skyline IS the crest most.
function crestAgreement(side) {
  const probe = scanCorridor(dem, guide, { ...baseScanOpts, side });
  let agree = 0;
  for (let i = 0; i < probe.skylineElevM.length; i++) {
    const sky = probe.skylineElevM[i], crest = probe.crestElevM[i];
    if (Number.isFinite(sky) && Number.isFinite(crest) && Math.abs(sky - crest) <= 150) agree++;
  }
  return agree / Math.max(1, probe.skylineElevM.length);
}
const baseScanOpts = {
  distanceM: src.distanceM || 45000,
  cameraElevM: src.cameraElevM || 2200,
  spacingM: src.spacingM || 400,
  pastM: src.pastM || 6000,
  curvature: src.curvature !== false,
  smoothWindowM: src.smoothWindowM || 8000,
  minGapM: src.minGapM || 8000,
  // Ground this close to the camera is at its feet, not in the view: a
  // 1,559m knoll 1.6km away out-angled Mount Hayes (4,216m) and drew as a
  // needle nine times the height of the range. Only the automated builds
  // read this; the Tetons are authored.
  corridorMinM: src.corridorMinM || 4000,
};
const side = src.side ?? (crestAgreement(1) > crestAgreement(-1) ? 1 : -1);
const scanOpts = { ...baseScanOpts, side };
const scan = scanCorridor(dem, guide, scanOpts);
let differ = 0;
let skyMax = -Infinity;
let skyAt = 0;
for (let i = 0; i < scan.skylineElevM.length; i++) {
  const sky = scan.skylineElevM[i];
  const crest = scan.crestElevM[i];
  if (Number.isFinite(sky) && Number.isFinite(crest) && Math.abs(sky - crest) > 150) differ++;
  if (Number.isFinite(sky) && sky > skyMax) {
    skyMax = sky;
    skyAt = i;
  }
}
const baseline = smoothBaseline(guide, scanOpts.smoothWindowM);
const summitPt = pointAlong(baseline, scan.alongM[skyAt]);
const summitLat = src.south + summitPt.y / 110540;
const lat0 = ((src.south + src.north) / 2) * Math.PI / 180;
const summitLon = src.west + summitPt.x / (111320 * Math.cos(lat0));
const frame = { west: src.west, south: src.south, north: src.north };
const authored = guidePath
  ? guidesFromGeoJSON(JSON.parse(readFileSync(guidePath, 'utf8')), frame)
  : null;
const sharedMeta = {
  source: src.source || 'unverified',
  provider: src.provider || 'unverified',
  product: src.product || 'unverified',
  tileIds: Array.isArray(src.tileIds) ? src.tileIds : [],
  sourceChecksum: createHash('sha256').update(gridBytes).digest('hex'),
  guideChecksum: guidePath
    ? createHash('sha256').update(readFileSync(guidePath)).digest('hex')
    : null,
  horizontalReference: src.horizontalReference || 'unverified',
  verticalReference: src.verticalReference || 'unverified',
  elevationUnits: src.elevationUnits || 'meters',
  noData: src.noData ?? 'non-finite samples omitted',
  bbox: [src.west, src.south, src.east, src.north],
  distanceM: scanOpts.distanceM,
  side: scanOpts.side,
  cameraElevM: scanOpts.cameraElevM,
  cellM: dem.cellM,
  crestSkylineDisagree: differ,
  stations: scan.skylineElevM.length,
  summitElevM: skyMax,
  summitLat,
  summitLon,
};
const profiles = authored
  ? compositeLayerProfiles(dem, authored, { ...scanOpts, isolateBandM: 3500 }, {
    ...sharedMeta,
    guide: 'authored-polylines',
    composite: true,
  })
  : rangeLayerProfiles(dem, guide, scanOpts, { ...sharedMeta, guide: 'traced-ridge' });
const layerElevM = {};
for (const [key, profile] of Object.entries(profiles)) {
  let hi = -Infinity;
  for (const v of profile.skylineElevM) if (Number.isFinite(v) && v > hi) hi = v;
  layerElevM[key] = hi;
}
const json = profilesToJSON(profiles, {
  name: src.name || 'terrain',
  ...sharedMeta,
  layerElevM,
  layersFound: Object.keys(profiles),
  guide: guidePath || (authored ? 'authored-polylines' : 'max-elevation-per-row'),
  note: authored
    ? 'Far is the Teton crest and near is the range east of Jackson Hole, each scanned on its own. They are stacked, not one view. No third range runs the length of this tile.'
    : (Object.keys(profiles).length < 3
      ? 'The gap between ridge distances never opened. This view is one range, so nearer layers were not invented.'
      : ''),
});
// Seven significant figures: a tenth of a millimetre on a 4,000m summit,
// and half the bytes of full doubles -- which matters now that a skyline is
// sampled every 30m and the bundled Tetons ship in the page itself.
const text = JSON.stringify(json, (_, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(7)) : v));
writeFileSync(outPath, text);
if (modulePath) {
  writeFileSync(path.resolve(modulePath), `// Generated by tools/build-terrain-profile.mjs. Do not edit.\nexport default ${text};\n`);
}
const counts = Object.fromEntries(Object.entries(profiles).map(([k, p]) => [k, p.angles.length]));
console.log(JSON.stringify({ layers: Object.keys(profiles), samples: counts, dem: [dem.width, dem.height] }));
