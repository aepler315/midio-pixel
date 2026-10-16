// Offline projection only; the shipped tour stores metric coordinates.
import { execFileSync } from 'node:child_process';
import { findGdalPython } from './terrain-source.mjs';

/** Same NAD83 transverse Mercator and east/south axes as normalize-dem.py. */
export async function transformTourCoordinates(coords, { centerLonLat, inverse = false }) {
  if (!coords.length) return [];
  const python = await findGdalPython();
  if (!python) throw new Error('tour coordinates need Python with GDAL bindings');
  const script = `
import sys,json
from osgeo import osr
request=json.load(sys.stdin)
lon,lat=request['center']
geo=osr.SpatialReference(); geo.ImportFromEPSG(4269)
local=osr.SpatialReference()
local.ImportFromProj4(f'+proj=tmerc +lat_0={lat:.9f} +lon_0={lon:.9f} +k=1 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs')
for srs in (geo,local): srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
inverse=request['inverse']
tr=osr.CoordinateTransformation(local if inverse else geo,geo if inverse else local)
result=[]
for x,z in request['coords']:
    a,b,_=tr.TransformPoint(x,-z if inverse else z)
    result.append([a,b if inverse else -b])
json.dump(result,sys.stdout)
`;
  const result = JSON.parse(execFileSync(python, ['-c', script], {
    input: JSON.stringify({ coords, center: centerLonLat, inverse }), encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024, timeout: 20000,
  }));
  return result.map(point => point.map(n => n === 0 ? 0 : n));
}
