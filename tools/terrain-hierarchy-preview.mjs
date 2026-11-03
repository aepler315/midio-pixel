#!/usr/bin/env node
// Preview a view's ridge/drainage hierarchy (src/world/alpine/TerrainHierarchy.js)
// from its baked terrain package, as PNG panels and printed stats:
//
//   node tools/terrain-hierarchy-preview.mjs [viewId ...] [--out dir] [--max 384]
//
// Panels per view: hillshade; relief01 (R); spine01 (G); the downstream
// wave at three phases. `<id>-network.png`: drainage (blue) and ridges
// (orange), width by Strahler order, as smoothed polylines at 3x.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { hierarchyLattice, buildTerrainHierarchy, sampleHierarchy, danceDisplacement, networkPolylines } from '../src/world/alpine/TerrainHierarchy.js';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
const outDir = flag('--out', 'tmp/terrain-hierarchy');
const maxSamples = Number(flag('--max', 384));
const ids = args.length ? args : ['teton-jackson-lake', 'denali-wonder-lake', 'sawtooth-redfish-north'];
const root = 'src/assets/range/v2/terrain';

function png(w, h, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(outDir, { recursive: true });
for (const id of ids) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, `${id}.terrain.json`), 'utf8'));
  const bytes = new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(root, `${id}.terrain.bin.gz`))));
  const data = decodeTerrain(manifest, bytes);
  const t0 = performance.now();
  const lattice = hierarchyLattice(data, { maxSamples });
  const t1 = performance.now();
  const h = buildTerrainHierarchy(lattice);
  const t2 = performance.now();
  const { width: W, height: H, fields: f, stats } = h;
  const panels = 6, out = new Uint8Array(W * panels * H * 4);
  const put = (p, x, z, r, g, b) => { const o = (z * W * panels + p * W + x) * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255; };
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const i = z * W + x, hv = f.heights[i];
    if (!Number.isFinite(hv)) { for (let p = 0; p < panels; p++) put(p, x, z, 0, 0, 0); continue; }
    const at = (xx, zz) => f.heights[Math.min(H - 1, Math.max(0, zz)) * W + Math.min(W - 1, Math.max(0, xx))];
    const dx = ((at(x + 1, z) - at(x - 1, z)) || 0) / (2 * stats.cellXM), dz = ((at(x, z + 1) - at(x, z - 1)) || 0) / (2 * stats.cellZM);
    const shade = Math.max(0, Math.min(1, .55 + (-dx * .7 - dz * .7) / Math.hypot(dx, dz, 1) * .6));
    const r = 170 * shade, g = 165 * shade, b = 150 * shade;
    put(0, x, z, r, g, b);
    const s = sampleHierarchy(h, data.grid, data.grid.originM[0] + x / (W - 1) * (data.grid.width - 1) * data.grid.cellSizeM,
      data.grid.originM[1] + z / (H - 1) * (data.grid.height - 1) * data.grid.cellSizeM);
    put(1, x, z, 255 * s.relief, 255 * s.relief, 255 * s.relief);
    put(2, x, z, 255 * s.spine, 180 * s.spine, 60 * s.spine);
    for (let q = 0; q < 3; q++) {
      const d = danceDisplacement({ drainM: 1, spineM: 0, drainPhaseRad: q * Math.PI / 2 }, s);
      put(3 + q, x, z, d > 0 ? 255 * d : 0, 40, d < 0 ? -255 * d : 0);
    }
  }
  const file = path.join(outDir, `${id}.png`);
  fs.writeFileSync(file, png(W * panels, H, out));
  // Network drawn as smoothed polylines over a 3x hillshade (no lattice steps).
  const S = 3, NW = W * S, NH = H * S, net = new Uint8Array(NW * NH * 4);
  for (let y = 0; y < NH; y++) for (let x = 0; x < NW; x++) {
    const src = ((y / S | 0) * W * panels + (x / S | 0)) * 4, o = (y * NW + x) * 4;
    const g = f.heights[(y / S | 0) * W + (x / S | 0)];
    const v = Number.isFinite(g) ? out[src] : 0;
    net[o] = v; net[o + 1] = Number.isFinite(g) ? out[src + 1] : 0; net[o + 2] = Number.isFinite(g) ? out[src + 2] : 0; net[o + 3] = 255;
  }
  const stamp = (px, pz, rad, col) => {
    for (let y = Math.floor(pz - rad - 1); y <= pz + rad + 1; y++) for (let x = Math.floor(px - rad - 1); x <= px + rad + 1; x++) {
      if (x < 0 || y < 0 || x >= NW || y >= NH) continue;
      const a = Math.max(0, Math.min(1, rad + .5 - Math.hypot(x + .5 - px, y + .5 - pz)));
      if (!a) continue;
      const o = (y * NW + x) * 4;
      for (let c = 0; c < 3; c++) net[o + c] = Math.max(net[o + c] * (1 - a), net[o + c] * (1 - a) + col[c] * a);
    }
  };
  const draw = (lines, maxOrder, col) => {
    for (const { order, points } of lines) {
      const rad = .5 + 1.2 * order / maxOrder;
      for (let k = 0; k < points.length - 1; k++) {
        const [ax, az] = points[k], [bx, bz] = points[k + 1], n = Math.ceil(Math.hypot(bx - ax, bz - az) * S * 3) + 1;
        for (let t = 0; t <= n; t++) stamp((ax + (bx - ax) * t / n + .5) * S, (az + (bz - az) * t / n + .5) * S, rad, col);
      }
    }
  };
  const ridgeShown = f.ridgeOrder.map((o, i) => f.hand[i] >= .12 * stats.handRefM ? o : 0);
  draw(networkPolylines(h, f.down, f.drainOrder, { minOrder: 2 }), stats.maxDrainOrder, [40, 140, 255]);
  draw(networkPolylines(h, f.up, ridgeShown, { minOrder: 2 }), stats.maxRidgeOrder, [255, 150, 30]);
  fs.writeFileSync(path.join(outDir, `${id}-network.png`), png(NW, NH, net));
  console.log(JSON.stringify({ id, file, latticeMs: Math.round(t1 - t0), hierarchyMs: Math.round(t2 - t1), ...stats,
    cellXM: +stats.cellXM.toFixed(1), handRefM: +stats.handRefM.toFixed(1), curvaturePerM2: stats.curvaturePerM2.map(v => +v.toExponential(2)) }));
}
