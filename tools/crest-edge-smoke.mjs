#!/usr/bin/env node
// GPU check of the crest probe's fine passes (CrestProbe.js) in headless
// Chromium: the fine crest rows and the edge cells, from a synthetic fine
// render (distance-coded like FINE_FRAG) of a near ridge in front of a far
// one, a smooth grazing slope and sky. Node tests cannot compile GLSL.
//
//   node tools/serve.js 8080 &
//   node tools/crest-edge-smoke.mjs [http://localhost:8080/]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/';
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
let failed = false;
const W_MIN_SHORE = 8; // about half the 24 columns cross the line above their wet cell's centre
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  // Any same-origin document will do for the module imports.
  await page.goto(new URL('/src/vendor/range/runtime.json', url).href);
  const result = await page.evaluate(async () => {
    const THREE = await import('/src/vendor/range/three-range.module.js');
    const { CrestProbe, PROBE_FINE_K: K, PROBE_FINE_ROWS, PROBE_EDGE_ROW, PROBE_LOG_RANGE, EDGE_NEIGHBOURS, edgeCell } = await import('/src/world/alpine/CrestProbe.js');
    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas });
    const shaderErrors = [];
    renderer.debug.onShaderError = (gl, program, vs, fs) => shaderErrors.push(gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || 'shader error');
    const W = 24, H = 16, FW = W * K, FH = H * K;
    // Fine scene, top-down fine rows: sky above row 12; a far ridge (20 km)
    // down to the near ridge's crest, the line fy = 24 + 0.3·fx; the near
    // ridge (3 km) below it; from row 48 a grazing slope whose distance
    // falls smoothly by 3% a fine row (12% a grid row, far more than the
    // jump threshold).
    const code = (m) => Math.round(Math.log2(m) / PROBE_LOG_RANGE * 65535);
    const sky = (fx, fy) => fy < 12;
    const nearTop = (fx) => 24 + fx * 0.3;
    const slopeTop = 48;
    const data = new Uint8Array(FW * FH * 4);
    const truth = [];
    for (let fy = 0; fy < FH; fy++) for (let fx = 0; fx < FW; fx++) {
      const o = ((FH - 1 - fy) * FW + fx) * 4; // GL rows bottom-up
      if (sky(fx, fy)) { truth.push(0); continue; }
      const band = fy >= slopeTop ? 3 : fy + 0.5 >= nearTop(fx + 0.5) ? 2 : 1;
      const m = band === 3 ? 1500 * Math.pow(0.97, fy - slopeTop) : band === 2 ? 3000 : 20000;
      truth.push(m);
      const v = code(m);
      data[o] = v & 255; data[o + 1] = v >> 8; data[o + 2] = Math.round(band / 3 * 255); data[o + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, FW, FH, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true;
    const probe = new CrestProbe(THREE, renderer);
    probe.begin(1, W, H);
    probe.rows = 1; // as if a band pass ran
    probe.fine({ texture: tex, width: FW, height: FH });
    const read = probe.read(1, { sync: true });
    // Expected per cell: fine pixels on the other side of the near ridge's
    // crest from the cell's own centre surface, shown as the neighbour above
    // or below (the slope must give none).
    const cells = [];
    let wrong = 0, slopeEdges = 0, ridgeEdges = 0, missed = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const cell = edgeCell(read.data, ((PROBE_EDGE_ROW + H - 1 - y) * W + x) * 4);
      const fy0 = y * K;
      if (fy0 >= slopeTop - K) { if (cell && fy0 >= slopeTop) slopeEdges++; continue; }
      let near = 0, far = 0;
      for (let sy = 0; sy < K; sy++) for (let sx = 0; sx < K; sx++) {
        const m = truth[(fy0 + sy) * FW + x * K + sx];
        if (m === 3000) near++; else if (m === 20000) far++;
      }
      const mixed = near && far;
      if (cell) {
        ridgeEdges++;
        let bad = 0;
        for (let sy = 0; sy < K; sy++) for (let sx = 0; sx < K; sx++) {
          if (!(cell.mask >> (sy * K + sx) & 1)) continue;
          // A masked pixel shows the neighbour's surface (its centre's).
          const [dx, dy] = EDGE_NEIGHBOURS[cell.neighbour];
          const theirs = truth[((y + dy) * K + K / 2) * FW + (x + dx) * K + K / 2];
          if (truth[(fy0 + sy) * FW + x * K + sx] !== theirs) bad++;
        }
        if (bad) wrong++;
        cells.push([x, y, cell.mask.toString(2).padStart(16, '0'), cell.neighbour]);
      } else if (mixed && near >= 2 && far >= 2) missed++;
    }
    // Fine crest rows: the first terrain row of band 1 (far) per sub-column
    // is the sky line (fine row 12).
    const fineFar = [];
    const row = PROBE_FINE_ROWS.far;
    for (let j = 0; j < 4; j++) for (let sub = 0; sub < K; sub++) {
      const o = ((row + (sub >> 1)) * W + j) * 4 + (sub & 1) * 2;
      fineFar.push(read.data[o] + read.data[o + 1] * 256 - 1);
    }
    // Water edge cells from an output-resolution water render at 4.5× the
    // target (not a whole multiple): wet below the line y = 6 + 0.35·x
    // (target pixels). Masked pixels must be dry, in cells whose centre is wet.
    const S = 4.5, WW = Math.round(W * S), WH = Math.round(H * S);
    const wet = (tx, ty) => ty >= 6 + 0.35 * tx;
    // As the probe sees it: the render's texel under the point.
    const seen = (tx, ty) => wet((Math.floor(tx * S) + 0.5) / S, (Math.floor(ty * S) + 0.5) / S);
    const wdata = new Uint8Array(WW * WH * 4);
    for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) {
      if (wet((x + 0.5) / S, (y + 0.5) / S)) wdata[((WH - 1 - y) * WW + x) * 4 + 3] = 255;
    }
    const wtex = new THREE.DataTexture(wdata, WW, WH, THREE.RGBAFormat, THREE.UnsignedByteType);
    wtex.minFilter = wtex.magFilter = THREE.NearestFilter; wtex.needsUpdate = true;
    probe.begin(2, W, H);
    probe.rows = 1;
    probe.waterEdges({ texture: wtex, width: WW, height: WH });
    const wread = probe.read(2, { sync: true });
    let shoreCells = 0, wetPixelsMasked = 0, dryCentres = 0, terrainBlock = 0, unmaskedDry = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (edgeCell(wread.data, ((PROBE_EDGE_ROW + H - 1 - y) * W + x) * 4)) terrainBlock++;
      const cell = edgeCell(wread.data, ((PROBE_EDGE_ROW + 2 * H - 1 - y) * W + x) * 4);
      const centreWet = seen(x + 0.5, y + 0.5);
      if (!cell) {
        if (!centreWet) continue;
        for (let sy = 0; sy < K; sy++) for (let sx = 0; sx < K; sx++) if (!seen(x + (sx + 0.5) / K, y + (sy + 0.5) / K)) unmaskedDry++;
        continue;
      }
      shoreCells++;
      if (!centreWet) dryCentres++;
      for (let sy = 0; sy < K; sy++) for (let sx = 0; sx < K; sx++) {
        if (cell.mask >> (sy * K + sx) & 1 && seen(x + (sx + 0.5) / K, y + (sy + 0.5) / K)) wetPixelsMasked++;
      }
    }
    probe.dispose(); tex.dispose(); wtex.dispose(); renderer.dispose();
    return { shaderErrors, edges: read.edges, wrong, missed, slopeEdges, ridgeEdges, fineFar, sample: cells.slice(0, 6),
      water: { edges: wread.edges, shoreCells, wetPixelsMasked, dryCentres, terrainBlock, unmaskedDry } };
  });
  console.log(JSON.stringify(result, null, 1));
  const checks = [
    ['no shader errors', !result.shaderErrors.length && !errors.some(e => /shader|WebGL/i.test(e))],
    ['edge rows read back', result.edges === 1],
    ['ridge border cells found', result.ridgeEdges >= 12],
    ['every masked pixel shows its neighbour\'s surface', result.wrong === 0],
    ['no mixed cell missed', result.missed === 0],
    ['a smooth grazing slope has no edges', result.slopeEdges === 0],
    ['fine crest of the far band is the sky line', result.fineFar.every(r => r === 12)],
    ['water edge rows read back (and an unwritten terrain block reads empty)', result.water.edges === 2 && result.water.terrainBlock === 0],
    ['shore cells found along the waterline', result.water.shoreCells >= W_MIN_SHORE],
    ['only dry pixels of wet cells are marked', result.water.wetPixelsMasked === 0 && result.water.dryCentres === 0],
    ['no dry pixel of a wet cell is missed', result.water.unmaskedDry === 0],
  ];
  for (const [name, ok] of checks) { console.log(`${ok ? 'ok' : 'FAIL'} ${name}`); if (!ok) failed = true; }
  const shown = errors.filter(e => !/Failed to load resource/.test(e));
  if (shown.length) console.log('page errors', shown.slice(0, 5));
} finally { await browser.close(); }
process.exit(failed ? 1 : 0);
