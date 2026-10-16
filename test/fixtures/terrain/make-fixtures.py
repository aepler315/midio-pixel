#!/usr/bin/env python3
"""Tiny synthetic rasters for the DEM contract tests. They are test inputs,
not terrain: every surface is an explicit formula so orientation and
round-trip checks have exact expectations. Regenerate with
  /usr/bin/python3.12 test/fixtures/terrain/make-fixtures.py
"""
import math
import os

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
HERE = os.path.dirname(os.path.abspath(__file__))
# UTM zone 10N (NAD83), near 48.5N 121W: a real projected CRS for the fixtures.
UTM = 26910
E0, N0 = 640000.0, 5374000.0  # upper-left corner


def srs(code):
    s = osr.SpatialReference()
    s.ImportFromEPSG(code)
    return s.ExportToWkt()


def write(name, arr, gt, wkt, nodata=None, meta=None):
    drv = gdal.GetDriverByName('GTiff')
    ds = drv.Create(os.path.join(HERE, name), arr.shape[1], arr.shape[0], 1, gdal.GDT_Float32,
                    options=['COMPRESS=DEFLATE'])
    ds.SetGeoTransform(gt)
    ds.SetProjection(wkt)
    band = ds.GetRasterBand(1)
    if nodata is not None:
        band.SetNoDataValue(nodata)
    band.WriteArray(arr.astype(np.float32))
    md = {'MIDIO_PROVIDER': 'synthetic test fixture', 'MIDIO_PRODUCT': name,
          'MIDIO_LICENSE': 'test data (repository license)', 'MIDIO_VERTICAL': 'synthetic metres'}
    md.update(meta or {})
    ds.SetMetadata(md)
    ds = None


def grid(n, cell):
    cols = np.arange(n) * cell + cell / 2
    rows = np.arange(n) * cell + cell / 2
    e = E0 + cols[None, :]
    nn = N0 - rows[:, None]
    return e + 0 * nn, nn + 0 * e


# 1. Plane rising 0.2 m/m to the east and 0.1 m/m to the north.
e, n = grid(64, 10.0)
plane = 1000 + 0.2 * (e - E0) + 0.1 * (n - (N0 - 640))
write('plane.tif', plane, (E0, 10, 0, N0, 0, -10), srs(UTM))

# 2. A ridge running north-south with a branching spur to the east and a
#    valley between, on a 5 m grid.
e, n = grid(96, 5.0)
x = (e - E0) / 480.0
y = (N0 - n) / 480.0
main = 900 * np.exp(-((x - 0.35) / 0.08) ** 2)
spur = 500 * np.exp(-((y - 0.55 + 0.6 * (x - 0.35)) / 0.06) ** 2) * (x > 0.35) * np.exp(-((x - 0.35) / 0.4) ** 2)
valley = -150 * np.exp(-((y - 0.25) / 0.05) ** 2) * (x > 0.45)
branched = 1200 + main + spur + valley
write('branched.tif', branched, (E0, 5, 0, N0, 0, -5), srs(UTM))

# 3. The plane with a no-data hole in the middle.
hole = plane.copy()
hole[24:40, 24:40] = -9999
write('hole.tif', hole, (E0, 10, 0, N0, 0, -10), srs(UTM), nodata=-9999)

# 4. Geographic (NAD83) pixels that are not square in degrees or metres:
#    0.0002 deg of longitude by 0.0001 deg of latitude near 48.5N.
lon0, lat0 = -121.2, 48.52
cols = np.arange(80) * 0.0002 + 0.0001
rows = np.arange(80) * 0.0001 + 0.00005
lon = lon0 + cols[None, :] + 0 * rows[:, None]
lat = lat0 - rows[:, None] + 0 * cols[None, :]
# 1 m per 0.00001 deg latitude north, flat east-west: pure north slope.
geo = 500 + (lat - (lat0 - 0.008)) * 100000
write('geographic.tif', geo, (lon0, 0.0002, 0, lat0, 0, -0.0001), srs(4269))

# 5. A rotated grid: columns run 30 degrees north of east. Heights follow the
#    same plane formula in true map coordinates, so a correct warp recovers it.
theta = math.radians(30)
c, s_ = math.cos(theta), math.sin(theta)
cell = 10.0
gt = (E0, cell * c, cell * s_, N0, cell * s_, -cell * c)
cc, rr = np.meshgrid(np.arange(64) + 0.5, np.arange(64) + 0.5)
ee = gt[0] + cc * gt[1] + rr * gt[2]
nn = gt[3] + cc * gt[4] + rr * gt[5]
rot = 1000 + 0.2 * (ee - E0) + 0.1 * (nn - (N0 - 640))
write('rotated.tif', rot, gt, srs(UTM))
print('fixtures written')


# Labeled points for the contract test: for each fixture, a local-origin
# centre (lon, lat) and points given as (lon, lat, expected height), plus
# the same points' local X/Z under the normalizer's tmerc definition,
# computed here independently with OSR.
import json


def to_lonlat(code, e, n):
    src = osr.SpatialReference(); src.ImportFromEPSG(code)
    dst = osr.SpatialReference(); dst.ImportFromEPSG(4269)
    for s_ in (src, dst):
        s_.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    lon, lat, _ = osr.CoordinateTransformation(src, dst).TransformPoint(e, n)
    return lon, lat


def to_local(lon0, lat0, lon, lat):
    tm = osr.SpatialReference()
    tm.ImportFromProj4(f'+proj=tmerc +lat_0={lat0:.9f} +lon_0={lon0:.9f} +k=1 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs')
    geo = osr.SpatialReference(); geo.ImportFromEPSG(4269)
    for s_ in (tm, geo):
        s_.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    e, n, _ = osr.CoordinateTransformation(geo, tm).TransformPoint(lon, lat)
    return e, -n


def plane_h(e, n):
    return 1000 + 0.2 * (e - E0) + 0.1 * (n - (N0 - 640))


labels = {}
for name, ce, cn, pts in (
    ('plane', E0 + 320, N0 - 320, [(E0 + 200, N0 - 200), (E0 + 450, N0 - 300), (E0 + 320, N0 - 500)]),
    ('rotated', *(lambda a, b: (E0 + a * c + b * s_, N0 + a * s_ - b * c))(320, 320),
     [(lambda a, b: (E0 + a * c + b * s_, N0 + a * s_ - b * c))(a, b) for a, b in ((250, 250), (400, 300), (300, 390))]),
):
    lon0, lat0 = to_lonlat(UTM, ce, cn)
    out = []
    for (e, n) in pts:
        lon, lat = to_lonlat(UTM, e, n)
        x, z = to_local(lon0, lat0, lon, lat)
        out.append({'lon': lon, 'lat': lat, 'x': x, 'z': z, 'h': plane_h(e, n)})
    labels[name] = {'center': [lon0, lat0], 'points': out}
lon0, lat0 = to_lonlat(UTM, E0 + 240, N0 - 240)
labels['branched'] = {'center': [lon0, lat0], 'ridgeEastingOffsetM': 0.35 * 480 - 240}
lon0, lat0 = to_lonlat(UTM, E0 + 320, N0 - 320)
labels['hole'] = {'center': [lon0, lat0], 'holeCenterLocal': [0.0, 0.0]}
labels['geographic'] = {'center': [-121.2 + 0.008, 48.52 - 0.004]}
with open(os.path.join(HERE, 'fixtures.json'), 'w') as fh:
    json.dump(labels, fh, indent=1)
print('labels written')
