#!/usr/bin/env python3
"""Normalize real elevation into a north-up local metric grid (Range v2).

Output contract (schema ``midio.demgrid`` version 1), written as three files
sharing one prefix:

  <prefix>.json       metadata (below)
  <prefix>.f32        little-endian Float32 heights, row-major, row 0 = north
  <prefix>.valid.u8   one byte per cell: 1 valid, 0 no-data

Local scene axes are right-handed: X east, Y up, Z south (metres). The
normalized grid lives in a transverse Mercator CRS centred on the view
(``horizontalCrs``); its easting E and northing N map to local X/Z by

    X = E,  Z = -N                           (``sourceToLocal``)

and cell (col, row) sits at X = originM[0] + col * cellSizeM,
Z = originM[1] + row * cellSizeM (cell centres). No-data stays NaN with
valid = 0; it is never filled with zero or sea level.

Sources:
  --source 3dep13     USGS 3DEP 1/3 arc-second (~10 m) Cloud Optimized
                      GeoTIFF tiles, read by window over HTTPS. Vertical
                      reference NAVD88 metres (USGS product specification).
  --source terrarium  AWS Terrain Tiles (Terrarium PNG, EPSG:3857); mixed
                      source data, vertical reference unverified.
  --input PATH        any GDAL-readable raster (fixtures, local GeoTIFFs).

Run with a Python that has the GDAL bindings (``/usr/bin/python3.12`` on the
reference machine; see docs/range-v2-assets.md).
"""
import argparse
import datetime
import hashlib
import io
import json
import math
import os
import sys
import urllib.parse
import urllib.request

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
osr.UseExceptions()

SCHEMA = 'midio.demgrid'
VERSION = 1
THREEDEP_BASE = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF'
TNM_API = 'https://tnmaccess.nationalmap.gov/api/v1/products'
THREEDEP_DATASET = 'National Elevation Dataset (NED) 1/3 arc-second'
TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
WEB_MERCATOR_HALF = 20037508.342789244


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def local_tmerc(lon0, lat0, datum):
    """A transverse Mercator CRS centred on the view, scale 1 at the centre."""
    srs = osr.SpatialReference()
    geog = 'NAD83' if datum == 'NAD83' else 'WGS84'
    proj4 = (f'+proj=tmerc +lat_0={lat0:.9f} +lon_0={lon0:.9f} +k=1 +x_0=0 +y_0=0 '
             f'+datum={geog} +units=m +no_defs')
    srs.ImportFromProj4(proj4)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return srs, proj4


def geographic(datum):
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4269 if datum == 'NAD83' else 4326)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return srs


def local_bounds(args):
    """Projected (E, N) bounds of the requested cell-centre grid, and its size."""
    w_m, h_m = args.extent
    cell = args.cell
    cols = int(round(w_m / cell)) + 1
    rows = int(round(h_m / cell)) + 1
    # Cell centres run from -w/2 .. +w/2; the raster edges sit half a cell out.
    e0 = args.offset[0] - (cols - 1) * cell / 2
    n1 = -args.offset[1] + (rows - 1) * cell / 2
    return {
        'cols': cols, 'rows': rows,
        'west': e0 - cell / 2, 'east': e0 + (cols - 0.5) * cell,
        'north': n1 + cell / 2, 'south': n1 - (rows - 0.5) * cell,
        'e0': e0, 'n0': n1,
    }


def lonlat_envelope(tm, bounds, datum, pad_deg=0.002):
    """Geographic envelope of the projected box, sampled along its edges."""
    geo = geographic(datum)
    tr = osr.CoordinateTransformation(tm, geo)
    lons, lats = [], []
    for i in range(33):
        f = i / 32
        for e, n in ((bounds['west'] + f * (bounds['east'] - bounds['west']), bounds['north']),
                     (bounds['west'] + f * (bounds['east'] - bounds['west']), bounds['south']),
                     (bounds['west'], bounds['south'] + f * (bounds['north'] - bounds['south'])),
                     (bounds['east'], bounds['south'] + f * (bounds['north'] - bounds['south']))):
            lon, lat, _ = tr.TransformPoint(e, n)
            lons.append(lon)
            lats.append(lat)
    return min(lons) - pad_deg, min(lats) - pad_deg, max(lons) + pad_deg, max(lats) + pad_deg


def head(url):
    req = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(req, timeout=60) as res:
        return {k: res.headers.get(k) for k in ('ETag', 'Last-Modified', 'Content-Length')}


def threedep_tiles(env, pinned=None):
    """1x1 degree 3DEP tiles (named by their NW corner) covering the envelope,
    each resolved to an immutable dated file through the TNM products API
    (the newest publication unless `pinned` names one)."""
    w, s, e, n = env
    out = []
    for lat in range(math.floor(s) + 1, math.ceil(n) + 1):
        for lon in range(math.floor(w), math.ceil(e)):
            tile = f'n{lat:02d}w{abs(lon):03d}' if lon < 0 else f'n{lat:02d}e{lon:03d}'
            out.append(tile)
    resolved = []
    for tile in out:
        if pinned and tile in pinned:
            url = pinned[tile]
        else:
            lat = int(tile[1:3])
            lon = -int(tile[4:7]) if tile[3] == 'w' else int(tile[4:7])
            q = urllib.parse.urlencode({
                'datasets': THREEDEP_DATASET, 'outputFormat': 'JSON', 'max': 50,
                'bbox': f'{lon + 0.4},{lat - 0.6},{lon + 0.6},{lat - 0.4}',
            })
            with urllib.request.urlopen(f'{TNM_API}?{q}', timeout=120) as res:
                items = json.load(res)['items']
            dated = sorted((i for i in items
                            if f'/historical/{tile}/' in i['downloadURL'] and i['downloadURL'].endswith('.tif')),
                           key=lambda i: i['publicationDate'])
            if not dated:
                raise SystemExit(f'no 3DEP 1/3 arc-second publication found for {tile}')
            url = dated[-1]['downloadURL']
        resolved.append({'tile': tile, 'url': url})
    return resolved


def read_window_hash(path, env):
    """Hash the native pixels of the source window actually used."""
    ds = gdal.Open(path)
    gt = ds.GetGeoTransform()
    if gt[2] != 0 or gt[4] != 0:
        return None, None
    w, s, e, n = env
    x0 = max(0, int(math.floor((w - gt[0]) / gt[1])))
    x1 = min(ds.RasterXSize, int(math.ceil((e - gt[0]) / gt[1])))
    y0 = max(0, int(math.floor((n - gt[3]) / gt[5])))
    y1 = min(ds.RasterYSize, int(math.ceil((s - gt[3]) / gt[5])))
    if x1 <= x0 or y1 <= y0:
        return None, None
    arr = ds.GetRasterBand(1).ReadAsArray(x0, y0, x1 - x0, y1 - y0)
    data = np.ascontiguousarray(arr.astype('<f4')).tobytes()
    return sha256_bytes(data), [x0, y0, x1 - x0, y1 - y0]


def cached_window(keep):
    """The provenance record of a kept 3DEP window, or None when it is absent
    or its file no longer matches the hash recorded at acquisition."""
    if not keep or not os.path.exists(keep) or not os.path.exists(keep + '.json'):
        return None
    with open(keep + '.json') as fh:
        record = json.load(fh)
    with open(keep, 'rb') as fh:
        if sha256_bytes(fh.read()) != record.get('cacheSha256'):
            return None
    return record


def source_3dep(env, cache_dir, pinned=None):
    tiles = threedep_tiles(env, pinned)
    paths, prov = [], []
    for t in tiles:
        vsi = f'/vsicurl/{t["url"]}'
        # The native window is kept outside the runtime tree, named by tile
        # and requested envelope, with its acquisition provenance and a file
        # hash beside it. A later normalization of the same envelope verifies
        # that hash and warps from the local copy: no network, same pixels.
        keep = None
        if cache_dir:
            env_key = sha256_bytes(json.dumps([round(v, 7) for v in env]).encode())[:12]
            keep = os.path.join(cache_dir, f'{t["tile"]}-{env_key}.tif')
        record = cached_window(keep)
        if record is None:
            meta = head(t['url'])
            digest, window = read_window_hash(vsi, env)
            record = {'tile': t['tile'], 'url': t['url'], 'etag': meta.get('ETag'),
                      'lastModified': meta.get('Last-Modified'),
                      'contentLength': int(meta['Content-Length']) if meta.get('Content-Length') else None,
                      'windowPixels': window, 'windowSha256': digest}
            if keep:
                os.makedirs(cache_dir, exist_ok=True)
                gdal.Translate(keep, vsi, projWin=[env[0], env[3], env[2], env[1]],
                               creationOptions=['COMPRESS=DEFLATE', 'PREDICTOR=3', 'TILED=YES'])
                with open(keep, 'rb') as fh:
                    record['cacheSha256'] = sha256_bytes(fh.read())
                with open(keep + '.json', 'w') as fh:
                    json.dump(record, fh, indent=1)
        paths.append(keep if keep and os.path.exists(keep) else vsi)
        prov.append({k: v for k, v in record.items() if k != 'cacheSha256'} | {'readFrom': 'cache' if paths[-1] == keep else 'remote'})
    ds = gdal.Open(paths[0])
    gt = ds.GetGeoTransform()
    lat_mid = (env[1] + env[3]) / 2
    res_n = abs(gt[5]) * 111320.0
    res_e = abs(gt[1]) * 111320.0 * math.cos(math.radians(lat_mid))
    return {
        'paths': paths, 'datum': 'NAD83', 'nodata': ds.GetRasterBand(1).GetNoDataValue(),
        'sourceResolutionM': round(max(res_n, res_e), 3),
        'provenance': {
            'provider': 'U.S. Geological Survey, 3D Elevation Program',
            'product': '3DEP 1/3 arc-second DEM (seamless, bare earth), Cloud Optimized GeoTIFF',
            'urls': [p['url'] for p in prov], 'tileIds': [p['tile'] for p in prov],
            'sha256': [p['windowSha256'] for p in prov], 'files': prov,
            'hashScope': 'SHA-256 of the native Float32 pixels of each tile window read',
            'license': 'Public domain (U.S. Government work); credit U.S. Geological Survey',
        },
        'horizontalSourceCrs': 'EPSG:4269 (NAD83 geographic)',
        'verticalReference': 'NAVD88 orthometric height, metres (USGS 3DEP product specification)',
    }


def terrarium_tile(z, x, y, cache_dir):
    path = os.path.join(cache_dir, f'{z}-{x}-{y}.png') if cache_dir else None
    if path and os.path.exists(path):
        with open(path, 'rb') as fh:
            data = fh.read()
    else:
        with urllib.request.urlopen(f'{TERRARIUM_URL}/{z}/{x}/{y}.png', timeout=60) as res:
            data = res.read()
        if path:
            os.makedirs(cache_dir, exist_ok=True)
            with open(path, 'wb') as fh:
                fh.write(data)
    return data


def source_terrarium(env, zoom, cache_dir, scratch):
    from PIL import Image
    n = 2 ** zoom

    def tile_xy(lon, lat):
        x = (lon + 180) / 360 * n
        s = math.sin(math.radians(lat))
        y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
        return x, y
    xa, ya = tile_xy(env[0], env[3])
    xb, yb = tile_xy(env[2], env[1])
    tx0, tx1, ty0, ty1 = int(xa), int(xb), int(ya), int(yb)
    count = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
    if count > 400:
        raise SystemExit(f'{count} Terrarium tiles is too many; shrink the extent or lower --zoom')
    mosaic = np.full(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.nan, dtype=np.float32)
    urls, ids, hashes = [], [], []
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            raw = terrarium_tile(zoom, tx, ty, cache_dir)
            rgb = np.asarray(Image.open(io.BytesIO(raw)).convert('RGB'), dtype=np.float64)
            elev = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = elev
            urls.append(f'{TERRARIUM_URL}/{zoom}/{tx}/{ty}.png')
            ids.append(f'terrarium/{zoom}/{tx}/{ty}')
            hashes.append(sha256_bytes(raw))
    size = 2 * WEB_MERCATOR_HALF / n
    gt = (-WEB_MERCATOR_HALF + tx0 * size, size / 256, 0, WEB_MERCATOR_HALF - ty0 * size, 0, -size / 256)
    path = os.path.join(scratch, 'terrarium-mosaic.tif')
    drv = gdal.GetDriverByName('GTiff')
    ds = drv.Create(path, mosaic.shape[1], mosaic.shape[0], 1, gdal.GDT_Float32)
    ds.SetGeoTransform(gt)
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    ds.SetProjection(srs.ExportToWkt())
    ds.GetRasterBand(1).SetNoDataValue(float('nan'))
    ds.GetRasterBand(1).WriteArray(mosaic)
    ds = None
    lat_mid = (env[1] + env[3]) / 2
    return {
        'paths': [path], 'datum': 'WGS84', 'nodata': None,
        'sourceResolutionM': round(size / 256 * math.cos(math.radians(lat_mid)), 3),
        'provenance': {
            'provider': 'AWS Open Data Terrain Tiles (Mapzen/Tilezen)',
            'product': f'Terrarium PNG tiles, zoom {zoom} (mixed SRTM/3DEP/GMTED/ETOPO sources)',
            'urls': urls, 'tileIds': ids, 'sha256': hashes,
            'hashScope': 'SHA-256 of each PNG tile as downloaded',
            'license': 'Terrain Tiles terms (attribution per https://github.com/tilezen/joerd/blob/master/docs/attribution.md)',
        },
        'horizontalSourceCrs': 'EPSG:3857 (WGS84 Web Mercator)',
        'verticalReference': 'unverified (mixed-source Terrain Tiles; nominally metres above mean sea level)',
    }


def source_input(paths):
    ds = gdal.Open(paths[0])
    srs = osr.SpatialReference(wkt=ds.GetProjection()) if ds.GetProjection() else None
    gt = ds.GetGeoTransform()
    band = ds.GetRasterBand(1)
    if srs and srs.IsGeographic():
        # Degrees of longitude shrink with latitude: measure both pixel
        # vectors in metres at the raster's own centre latitude.
        lat = gt[3] + gt[4] * ds.RasterXSize / 2 + gt[5] * ds.RasterYSize / 2
        k_lon = 111320.0 * math.cos(math.radians(lat))
        col = math.hypot(gt[1] * k_lon, gt[4] * 111320.0)
        row = math.hypot(gt[2] * k_lon, gt[5] * 111320.0)
        res = max(col, row)
    else:
        res = max(math.hypot(gt[1], gt[4]), math.hypot(gt[2], gt[5]))
    md = ds.GetMetadata() or {}
    hashes = []
    for p in paths:
        with open(p, 'rb') as fh:
            hashes.append(sha256_bytes(fh.read()))
    datum = 'NAD83' if srs and 'NAD83' in (srs.GetAttrValue('DATUM') or '') + (srs.GetAttrValue('GEOGCS') or '') else 'WGS84'
    return {
        'paths': paths, 'datum': datum, 'nodata': band.GetNoDataValue(),
        'sourceResolutionM': round(res, 3),
        'provenance': {
            'provider': md.get('MIDIO_PROVIDER', 'local file'),
            'product': md.get('MIDIO_PRODUCT', 'unverified'),
            'urls': [], 'tileIds': [os.path.basename(p) for p in paths], 'sha256': hashes,
            'hashScope': 'SHA-256 of each input file',
            'license': md.get('MIDIO_LICENSE', 'unverified'),
        },
        'horizontalSourceCrs': (srs.GetAuthorityName(None) or '') + ':' + (srs.GetAuthorityCode(None) or '') if srs else 'unverified',
        'verticalReference': md.get('MIDIO_VERTICAL', 'unverified'),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True, help='output prefix')
    ap.add_argument('--center', required=True, help='LON,LAT of the local origin')
    ap.add_argument('--extent', required=True, help='WIDTH_M,HEIGHT_M of the cell-centre grid')
    ap.add_argument('--offset', default='0,0', help='X_M,Z_M of the grid centre from the origin')
    ap.add_argument('--cell', type=float, required=True, help='output spacing in metres')
    ap.add_argument('--source', choices=['3dep13', 'terrarium'])
    ap.add_argument('--input', nargs='*', default=[])
    ap.add_argument('--zoom', type=int, default=12)
    ap.add_argument('--resampling', default='auto', choices=['auto', 'average', 'bilinear', 'cubic'])
    ap.add_argument('--cache', default='.terrain-cache')
    ap.add_argument('--pin', default=None, help='JSON file mapping 3DEP tile -> dated URL')
    ap.add_argument('--retrieved-at', default=None, help='override the recorded retrieval date')
    ap.add_argument('--fill', choices=['terrarium'], default=None,
                    help='fill cells the primary source leaves invalid (e.g. 3DEP beyond the U.S. border)')
    ap.add_argument('--fill-zoom', type=int, default=12)
    ap.add_argument('--feather-cells', type=int, default=15,
                    help='width of the blend from fill to primary inside primary coverage')
    ap.add_argument('--points', default=None,
                    help='JSON object name -> [lon, lat]; each is reported in local metres with the grid height there')
    args = ap.parse_args(argv)
    args.center = [float(v) for v in args.center.split(',')]
    args.extent = [float(v) for v in args.extent.split(',')]
    args.offset = [float(v) for v in args.offset.split(',')]
    if bool(args.source) == bool(args.input):
        ap.error('give exactly one of --source or --input')
    if args.cell <= 0 or min(args.extent) <= 0:
        ap.error('cell and extent must be positive')
    lon0, lat0 = args.center
    datum_hint = 'NAD83' if args.source == '3dep13' else 'WGS84'
    tm, tm_proj4 = local_tmerc(lon0, lat0, datum_hint)
    bounds = local_bounds(args)
    env = lonlat_envelope(tm, bounds, datum_hint)
    scratch = os.path.dirname(os.path.abspath(args.out)) or '.'
    os.makedirs(scratch, exist_ok=True)
    if args.source == '3dep13':
        pinned = json.load(open(args.pin)) if args.pin else None
        src = source_3dep(env, os.path.join(args.cache, '3dep13'), pinned)
    elif args.source == 'terrarium':
        src = source_terrarium(env, args.zoom, os.path.join(args.cache, 'terrarium'), scratch)
    else:
        src = source_input(args.input)
    if src['datum'] != datum_hint:
        tm, tm_proj4 = local_tmerc(lon0, lat0, src['datum'])
    resampling = args.resampling
    if resampling == 'auto':
        # Averaging when the output is coarser than the source prevents
        # aliasing; bilinear otherwise. Neither adds measured resolution.
        resampling = 'average' if args.cell > 1.25 * src['sourceResolutionM'] else 'bilinear'
    warp_opts = gdal.WarpOptions(
        format='MEM', dstSRS=tm.ExportToWkt(),
        outputBounds=[bounds['west'], bounds['south'], bounds['east'], bounds['north']],
        width=bounds['cols'], height=bounds['rows'], resampleAlg=resampling,
        srcNodata=src['nodata'] if src['nodata'] is not None else None,
        dstNodata=float('nan'), outputType=gdal.GDT_Float32, multithread=True,
        errorThreshold=0,
    )
    out_ds = gdal.Warp('', src['paths'], options=warp_opts)
    heights = out_ds.GetRasterBand(1).ReadAsArray().astype('<f4')
    primary_valid = np.isfinite(heights)
    fill_meta = None
    source_mask = primary_valid.astype(np.uint8)  # 1 primary, 2 fill, 0 none
    if args.fill and not primary_valid.all():
        fsrc = source_terrarium(env, args.fill_zoom, os.path.join(args.cache, 'terrarium'), scratch)
        fwarp = gdal.WarpOptions(
            format='MEM', dstSRS=tm.ExportToWkt(),
            outputBounds=[bounds['west'], bounds['south'], bounds['east'], bounds['north']],
            width=bounds['cols'], height=bounds['rows'],
            resampleAlg='bilinear' if args.cell < 1.25 * fsrc['sourceResolutionM'] else 'average',
            dstNodata=float('nan'), outputType=gdal.GDT_Float32, errorThreshold=0)
        fill_ds = gdal.Warp('', fsrc['paths'], options=fwarp)  # keep the dataset alive while reading
        fill = fill_ds.GetRasterBand(1).ReadAsArray().astype('<f4')
        fill_ds = None
        # Blend weight: 0 at the primary coverage edge rising to 1 after
        # `feather` cells inside it, so the two sources meet without a step.
        feather = max(1, args.feather_cells)
        inside = primary_valid.copy()
        weight = np.zeros(heights.shape, dtype=np.float32)
        for k in range(feather):
            weight += inside
            er = inside.copy()
            er[1:, :] &= inside[:-1, :]; er[:-1, :] &= inside[1:, :]
            er[:, 1:] &= inside[:, :-1]; er[:, :-1] &= inside[:, 1:]
            inside = er
        weight /= feather
        both = primary_valid & np.isfinite(fill)
        blended = heights.copy()
        blended[both] = weight[both] * heights[both] + (1 - weight[both]) * fill[both]
        only_fill = ~primary_valid & np.isfinite(fill)
        blended[only_fill] = fill[only_fill]
        heights = blended.astype('<f4')
        source_mask[only_fill] = 2
        fill_meta = {
            'source': 'terrarium', 'zoom': args.fill_zoom,
            'sourceResolutionM': fsrc['sourceResolutionM'],
            'verticalReference': fsrc['verticalReference'],
            'cells': int(only_fill.sum()), 'featherCells': feather,
            'rule': 'fill only where the primary source has no data; linear blend over featherCells inside primary coverage',
            'provenance': fsrc['provenance'],
        }
    valid = np.isfinite(heights).astype(np.uint8)
    heights[valid == 0] = np.nan
    prefix = args.out
    with open(prefix + '.f32', 'wb') as fh:
        fh.write(heights.tobytes())
    with open(prefix + '.valid.u8', 'wb') as fh:
        fh.write(valid.tobytes())
    source_mask[valid == 0] = 0
    with open(prefix + '.source.u8', 'wb') as fh:
        fh.write(source_mask.tobytes())
    finite = heights[valid == 1]
    meta = {
        'schema': SCHEMA, 'version': VERSION,
        'width': bounds['cols'], 'height': bounds['rows'], 'cellSizeM': args.cell,
        'originM': [bounds['e0'], -bounds['n0']],
        'axes': 'X east, Y up, Z south (metres); row 0 is north',
        'centerLonLat': [lon0, lat0],
        'horizontalCrs': tm_proj4,
        'horizontalSourceCrs': src['horizontalSourceCrs'],
        'sourceToLocal': [1, 0, 0, 0, -1, 0],
        'localToSource': [1, 0, 0, 0, -1, 0],
        'transformNote': 'affine [a,b,c,d,e,f]: X = a*E + b*N + c, Z = d*E + e*N + f, from horizontalCrs easting/northing',
        'verticalReference': src['verticalReference'],
        'heightUnits': 'metre',
        'sourceResolutionM': src['sourceResolutionM'],
        'outputSpacingM': args.cell,
        'upsampled': args.cell < 0.8 * src['sourceResolutionM'],
        'resampling': resampling,
        'validCount': int(valid.sum()),
        'heightRangeM': [float(finite.min()), float(finite.max())] if finite.size else None,
        'provenance': {**src['provenance'],
                       'retrievedAt': args.retrieved_at or datetime.date.today().isoformat()},
        'fill': fill_meta,
        'tools': {'gdal': gdal.__version__, 'numpy': np.__version__, 'python': sys.version.split()[0]},
        'payload': {
            'heights': {'file': os.path.basename(prefix) + '.f32', 'type': 'float32', 'endian': 'little',
                        'byteLength': heights.nbytes, 'sha256': sha256_bytes(heights.tobytes())},
            'valid': {'file': os.path.basename(prefix) + '.valid.u8', 'type': 'uint8',
                      'byteLength': valid.nbytes, 'sha256': sha256_bytes(valid.tobytes())},
            'source': {'file': os.path.basename(prefix) + '.source.u8', 'type': 'uint8',
                       'values': '0 none, 1 primary, 2 fill',
                       'byteLength': source_mask.nbytes, 'sha256': sha256_bytes(source_mask.tobytes())},
        },
    }
    if args.points:
        pts = json.loads(args.points) if args.points.strip().startswith('{') else json.load(open(args.points))
        geo = geographic(src['datum'])
        to_local = osr.CoordinateTransformation(geo, tm)
        out_pts = {}
        radius = max(1, int(round(200 / args.cell)))
        for name, (lon, lat) in pts.items():
            e, n, _ = to_local.TransformPoint(lon, lat)
            x, z = e, -n
            c = (x - meta['originM'][0]) / args.cell
            r = (z - meta['originM'][1]) / args.cell
            ci, ri = int(round(c)), int(round(r))
            ground = peak = None
            if 0 <= ci < meta['width'] and 0 <= ri < meta['height'] and valid[ri, ci]:
                ground = float(heights[ri, ci])
                win = heights[max(0, ri - radius):ri + radius + 1, max(0, ci - radius):ci + radius + 1]
                peak = float(np.nanmax(win))
            out_pts[name] = {'lonLat': [lon, lat], 'localM': [x, z], 'groundM': ground, 'peakWithin200mM': peak}
        meta['points'] = out_pts
    with open(prefix + '.json', 'w') as fh:
        json.dump(meta, fh, indent=1)
    print(json.dumps({'ok': True, 'out': prefix, 'width': meta['width'], 'height': meta['height'],
                      'valid': meta['validCount'], 'range': meta['heightRangeM']}))


if __name__ == '__main__':
    main()
