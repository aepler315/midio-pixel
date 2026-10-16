#!/usr/bin/env python3
"""Range v2 material data textures (plan §3.4, Task 9).

Two kinds of source, both producing DATA textures (never colour):

  cc0 <zip> <out.webp>        Pack an ambientCG CC0 scan into one RGBA
                              texture: R,G = tangent-space normal X,Y (OpenGL
                              convention), B = roughness, A = height. The
                              scan's colour map is deliberately not used:
                              colour comes from each biome's palette.
  proc <kind> <out.webp> --seed N
                              Tileable procedural maps generated here:
                                cliff   fractured, jointed and bedded rock
                                canopy  conifer crowns seen from above
                                snow    wind-packed snow ripples
                              Same channel layout (for canopy, B = crown
                              coverage instead of roughness).

Generated at 1024x1024 and shipped at --size (default 512), lossless WebP, tileable, with a JSON sidecar
recording its channels, colour space ("data"), source and SHA-256.
Run with the GDAL/numpy/Pillow Python (see docs/range-v2-assets.md).
"""
import argparse
import hashlib
import io
import json
import os
import sys
import zipfile

import numpy as np
from PIL import Image

SIZE = 1024


def sha256_file(path):
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def read_png_any(data):
    """8- or 16-bit PNG bytes -> float array 0..1 (H, W[, C])."""
    try:
        from osgeo import gdal
        gdal.UseExceptions()
        name = '/vsimem/mat.png'
        gdal.FileFromMemBuffer(name, data)
        ds = gdal.Open(name)
        arr = ds.ReadAsArray().astype(np.float64)
        bits = 16 if ds.GetRasterBand(1).DataType == gdal.GDT_UInt16 else 8
        ds = None
        gdal.Unlink(name)
        if arr.ndim == 3:
            arr = np.moveaxis(arr, 0, -1)
        return arr / (65535.0 if bits == 16 else 255.0)
    except ImportError:
        return np.asarray(Image.open(io.BytesIO(data))).astype(np.float64) / 255.0


def box_down(a, factor):
    h, w = a.shape[:2]
    return a.reshape(h // factor, factor, w // factor, factor, *a.shape[2:]).mean(axis=(1, 3))


def resample_to(a, size=SIZE):
    f = a.shape[0] // size
    return box_down(a, f) if f > 1 else a


def normal_from_height(h, strength):
    """Tangent-space normal (x, y, z) from a tileable height field."""
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * strength
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5 * strength
    # OpenGL convention: +Y up the image, so image rows grow downward.
    n = np.stack([-gx, gy, np.ones_like(h)], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def pack(normal, b, height):
    n = normal / np.linalg.norm(normal, axis=-1, keepdims=True)
    rgba = np.stack([n[..., 0] * 0.5 + 0.5, n[..., 1] * 0.5 + 0.5, np.clip(b, 0, 1), np.clip(height, 0, 1)], -1)
    return (np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8)


def write(out, rgba, meta, size=SIZE):
    if rgba.shape[0] != size:
        # Downsample the 1024 master: average normals as vectors, the
        # scalar channels as values.
        f = rgba.shape[0] // size
        a = rgba.astype(np.float64) / 255.0
        n = box_down(np.stack([a[..., 0] * 2 - 1, a[..., 1] * 2 - 1], -1), f)
        z = np.sqrt(np.clip(1 - (n ** 2).sum(-1), 0, 1))
        nn = np.concatenate([n, z[..., None]], -1)
        rgba = pack(nn, box_down(a[..., 2], f), box_down(a[..., 3], f))
    Image.fromarray(rgba, 'RGBA').save(out, 'WEBP', lossless=True, quality=100, method=6, exact=True)
    meta.update({'width': rgba.shape[1], 'height': rgba.shape[0], 'format': 'webp-lossless',
                 'colorSpace': 'data', 'sha256': sha256_file(out), 'bytes': os.path.getsize(out)})
    with open(out + '.json', 'w') as fh:
        json.dump(meta, fh, indent=1)
    print(json.dumps({'out': out, 'bytes': meta['bytes']}))


# --- tileable noise ---------------------------------------------------------

def fbm(n, beta, rng, lo=1.0, hi=None):
    """Periodic fractal noise: random phases, amplitude ~ f^-beta."""
    fy = np.fft.fftfreq(n)[:, None] * n
    fx = np.fft.rfftfreq(n)[None, :] * n
    f = np.sqrt(fx * fx + fy * fy)
    amp = np.where(f >= lo, (np.maximum(f, 1e-9)) ** -beta, 0.0)
    if hi:
        amp *= np.exp(-(f / hi) ** 2)
    spec = amp * np.exp(2j * np.pi * rng.random(amp.shape))
    out = np.fft.irfft2(spec, s=(n, n))
    out -= out.min()
    return out / out.max()


def worley(n, count, rng, stretch=(1.0, 1.0)):
    """Periodic F1/F2 cell distances (in pixels) on the torus."""
    pts = rng.random((count, 2)) * n
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    f1 = np.full((n, n), np.inf, np.float32)
    f2 = np.full((n, n), np.inf, np.float32)
    for px, py in pts:
        dx = np.abs(xx - px); dx = np.minimum(dx, n - dx) * stretch[0]
        dy = np.abs(yy - py); dy = np.minimum(dy, n - dy) * stretch[1]
        d = np.sqrt(dx * dx + dy * dy)
        closer = d < f1
        f2 = np.where(closer, f1, np.minimum(f2, d))
        f1 = np.where(closer, d, f1)
    return f1, f2


def proc_cliff(rng):
    """Weathered crystalline cliff: large rounded buttresses, sparse
    near-vertical joints that fade in and out, patchy bedding that only
    shows where the rock is exposed, and fine grit. Deliberately irregular:
    a regular mosaic reads as stamps at terrain scale."""
    big = fbm(SIZE, 2.3, rng, lo=1)
    mid = fbm(SIZE, 1.8, rng, lo=3)
    ridged = 1 - np.abs(fbm(SIZE, 1.7, rng, lo=5) * 2 - 1)
    # Joints: tall thin cells (stretched across x), thin fading cracks.
    f1, f2 = worley(SIZE, 46, rng, stretch=(2.6, 0.8))
    crack = np.clip(1 - (f2 - f1) / 4.0, 0, 1) ** 2
    crack *= np.clip(fbm(SIZE, 2.0, rng, lo=2) * 2.2 - 0.6, 0, 1)  # joints come and go
    # Secondary fracture set at a different scale and angle.
    g1, g2 = worley(SIZE, 110, rng, stretch=(0.9, 1.7))
    crack2 = np.clip(1 - (g2 - g1) / 3.0, 0, 1) ** 2 * np.clip(fbm(SIZE, 2.0, rng, lo=2) * 2 - 0.8, 0, 1)
    # Bedding: warped, varying spacing, visible only in patches.
    yy = np.mgrid[0:SIZE, 0:SIZE][0] / SIZE
    warp = fbm(SIZE, 2.4, rng, lo=1)
    phase = yy * 17 + warp * 6 + fbm(SIZE, 2.0, rng, lo=2) * 3
    beds = np.abs(np.sin(np.pi * phase)) ** 3
    beds *= np.clip(fbm(SIZE, 2.2, rng, lo=1) * 2.4 - 1.1, 0, 1)
    fine = fbm(SIZE, 1.0, rng, lo=48)
    h = 0.42 * big + 0.22 * mid + 0.14 * ridged - 0.16 * crack - 0.07 * crack2 - 0.05 * beds + 0.05 * fine
    h = (h - h.min()) / (h.max() - h.min())
    n = normal_from_height(h, 70.0)
    rough = np.clip(0.8 + 0.15 * crack - 0.12 * fine + 0.05 * beds, 0, 1)
    return pack(n, rough, h)


def proc_canopy(rng):
    # Jittered crown centres on the torus, conical crowns of varied size.
    cells = 34
    h = np.zeros((SIZE, SIZE), np.float32)
    cover = np.zeros((SIZE, SIZE), np.float32)
    yy, xx = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)
    step = SIZE / cells
    clump = fbm(SIZE, 2.4, rng, lo=1)
    for j in range(cells):
        for i in range(cells):
            cx = (i + rng.random()) * step
            cy = (j + rng.random()) * step
            if clump[int(cy) % SIZE, int(cx) % SIZE] < 0.28 and rng.random() < 0.7:
                continue  # a gap in the stand
            r = step * (0.45 + 0.5 * rng.random())
            dx = np.abs(xx - cx); dx = np.minimum(dx, SIZE - dx)
            dy = np.abs(yy - cy); dy = np.minimum(dy, SIZE - dy)
            d = np.sqrt(dx * dx + dy * dy) / r
            cone = np.clip(1 - d, 0, 1) ** 0.8 * (0.7 + 0.3 * rng.random())
            h = np.maximum(h, cone)
            cover = np.maximum(cover, (d < 1).astype(np.float32))
    h = h + 0.05 * fbm(SIZE, 1.0, rng, lo=40)
    n = normal_from_height(h, 60.0)
    return pack(n, cover, np.clip(h, 0, 1))


def proc_snow(rng):
    soft = fbm(SIZE, 2.2, rng, lo=2)
    yy, xx = np.mgrid[0:SIZE, 0:SIZE] / SIZE
    warp = fbm(SIZE, 2.0, rng, lo=1) * 0.3
    ripples = 0.5 + 0.5 * np.sin(2 * np.pi * ((xx * 0.4 + yy) * 38 + warp * 12))
    h = 0.75 * soft + 0.25 * ripples * fbm(SIZE, 1.5, rng, lo=3)
    h = (h - h.min()) / (h.max() - h.min())
    n = normal_from_height(h, 18.0)
    rough = np.clip(0.55 + 0.25 * soft, 0, 1)
    return pack(n, rough, h)


def cc0(zip_path, rng=None):
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        pick = lambda key: next(n for n in names if n.endswith(f'_{key}.png'))
        normal = read_png_any(z.read(pick('NormalGL')))[..., :3]
        rough = read_png_any(z.read(pick('Roughness')))
        disp = read_png_any(z.read(pick('Displacement')))
    if rough.ndim == 3:
        rough = rough[..., 0]
    if disp.ndim == 3:
        disp = disp[..., 0]
    nvec = normal * 2 - 1
    nvec = resample_to(nvec)
    rough = resample_to(rough)
    disp = resample_to(disp)
    disp = (disp - disp.min()) / max(1e-6, disp.max() - disp.min())
    return pack(nvec, rough, disp)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('mode', choices=['cc0', 'proc'])
    ap.add_argument('source')
    ap.add_argument('out')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--meta', default='{}', help='JSON merged into the sidecar (provenance, licence)')
    ap.add_argument('--size', type=int, default=512, help='runtime size (the 1024 master is downsampled)')
    args = ap.parse_args(argv)
    rng = np.random.default_rng(args.seed)
    meta = json.loads(args.meta)
    if args.mode == 'cc0':
        rgba = cc0(args.source)
        meta.setdefault('channels', ['normalX', 'normalY', 'roughness', 'height'])
        meta['sourceSha256'] = sha256_file(args.source)
    else:
        gen = {'cliff': proc_cliff, 'canopy': proc_canopy, 'snow': proc_snow}[args.source]
        rgba = gen(rng)
        meta.setdefault('channels', ['normalX', 'normalY', 'coverage' if args.source == 'canopy' else 'roughness', 'height'])
        meta['generator'] = {'script': 'tools/terrain/make-materials.py', 'kind': args.source, 'seed': args.seed,
                             'numpy': np.__version__}
    meta['masterSize'] = SIZE
    write(args.out, rgba, meta, args.size)


if __name__ == '__main__':
    main()
