#!/usr/bin/env node
// Preview a view's ridge/drainage hierarchy (src/world/alpine/TerrainHierarchy.js)
// from its baked terrain package, as PNG panels and printed stats:
//
//   node tools/terrain-hierarchy-preview.mjs [viewId ...] [--out dir] [--max 384]
//
// Panels per view: hillshade with drainage (blue, width by Strahler order)
// and ridges (orange, by order); relief01 (R); spine01 (G); and the
// downstream wave sin(k d + phase) at four phases a quarter bar apart.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { hierarchyLattice, buildTerrainHierarchy, sampleHierarchy, danceDisplacement } from '../src/world/alpine/TerrainHierarchy.js';

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
    let r = 170 * shade, g = 165 * shade, b = 150 * shade;
    const ro = f.ridgeOrder[i], dr = f.drainOrder[i];
    if (ro >= 2 && f.hand[i] >= .12 * stats.handRefM) { const a = ro / stats.maxRidgeOrder; r = 255; g = 120 + 80 * (1 - a); b = 30; }
    if (dr >= 2) { const a = dr / stats.maxDrainOrder; r = 40; g = 120 + 60 * (1 - a); b = 255; }
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
  console.log(JSON.stringify({ id, file, latticeMs: Math.round(t1 - t0), hierarchyMs: Math.round(t2 - t1), ...stats,
    cellXM: +stats.cellXM.toFixed(1), handRefM: +stats.handRefM.toFixed(1), curvaturePerM2: stats.curvaturePerM2.map(v => +v.toExponential(2)) }));
}
