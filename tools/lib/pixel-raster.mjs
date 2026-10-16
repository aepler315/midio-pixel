// Chromium raster checks using the actual production layout function and CSS.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function verifyPixelRaster(browser, { url, out, enforce = true }) {
  const main = await fs.readFile('src/main.js', 'utf8');
  const layout = main.slice(main.indexOf('function fitPixelLayout()'), main.indexOf('/** `?bulkExport=1'));
  const rows = [];
  for (const gridId of ['classic', 'detailed']) for (const dpr of [1, 1.25, 1.5, 2]) {
    const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1100, height: 800 } });
    const page = await context.newPage();
    // No app/audio here: the diagnostic uses production CSS, the exact live
    // layout function, the fit module and hit testing on a checkerboard.
    await page.route('**/raster-fixture', route => route.fulfill({ contentType: 'text/html', body:
      '<link rel="stylesheet" href="/src/ui/style.css"><div id="app"><canvas id="stage"></canvas></div>' }));
    try {
      await page.goto(`${url}/raster-fixture`);
      for (const [width, height] of [[801,481],[800,480],[1000,700],[853,481],[720,720],[540,960],[1920,1080],[160,100]]) {
        await page.setViewportSize({ width: width + 32, height: height + 32 });
        const row = await page.evaluate(async ({ width, height, layout, gridId }) => {
          const { fitPixelRect } = await import('/src/render/PixelPresentation.js');
          const { clientToStageCoords } = await import('/src/ui/StageCoords.js');
          const { pixelGrid } = await import('/src/render/PixelRenderPolicy.js');
          const grid = pixelGrid(gridId);
          const canvas = document.querySelector('#stage'), app = canvas.parentElement;
          canvas.width = grid.width; canvas.height = grid.height;
          app.style.cssText = `position:absolute;left:11.3px;top:7.7px;width:${width}px;height:${height}px;min-width:0;min-height:0;padding:0;border:0;`;
          canvas.classList.add('retro');
          const ctx = canvas.getContext('2d');
          for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
            ctx.fillStyle = x===grid.width-1||y===grid.height-1 ? '#fff' : (x + y) % 2 ? '#000' : '#fff'; ctx.fillRect(x, y, 1, 1);
          }
          const p = { pixelated: true, grid: { width: canvas.width, height: canvas.height }, scaling: 'integer' };
          new Function('canvas', 'effectivePresentation', 'bulkExportSize', 'fitPixelRect', `${layout};fitPixelLayout();`)(canvas, () => p, null, fitPixelRect);
          const rect = canvas.getBoundingClientRect(), parent = app.getBoundingClientRect();
          const center = clientToStageCoords(rect.left + rect.width / 2, rect.top + rect.height / 2, rect, 1280, 720);
          const barTap = clientToStageCoords(rect.left - 1, rect.top + rect.height / 2, rect, 1280, 720);
          const fit = fitPixelRect(grid.width,grid.height,parent.width*devicePixelRatio,parent.height*devicePixelRatio,'integer', { x: parent.left*devicePixelRatio, y: parent.top*devicePixelRatio });
          return { gridId, grid, width, height, dpr: devicePixelRatio, scale: fit.scale,
            rect: { x: rect.left*devicePixelRatio, y:rect.top*devicePixelRatio, width:rect.width*devicePixelRatio, height:rect.height*devicePixelRatio }, center, barTap };
        }, { width, height, layout, gridId });
        const bytes = await page.screenshot();
        const raster = await page.evaluate(async ({ png, row }) => {
          const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
          const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
          const px = ctx.getImageData(0,0,c.width,c.height).data;
          const color = (x,y) => px[(y*c.width+x)*4];
          let mismatches = 0;
          if (row.scale >= 1) {
            const ox = Math.round(row.rect.x), oy = Math.round(row.rect.y), s = row.scale;
            for (let k = 0; k < 60*s; k++) {
              const expected = Math.floor(k/s)%2 ? 0 : 255;
              if (color(ox+k,oy) !== expected) mismatches++;
              if (color(ox,oy+k) !== expected) mismatches++;
            }
            // Opposite boundaries and bars must remain sharply separate.
            if (color(ox-1,oy) > 16 || color(ox,oy-1) > 16) mismatches++;
            const rw=Math.round(row.rect.width),rh=Math.round(row.rect.height);
            if(color(ox+rw-1,oy)!==255||color(ox,oy+rh-1)!==255)mismatches++;
            if(color(ox+rw,oy)>16||color(ox,oy+rh)>16)mismatches++;
          }
          return { mismatches, rasterWidth: c.width, rasterHeight: c.height };
        }, { png: bytes.toString('base64'), row });
        Object.assign(row, raster);
        row.aligned = row.scale < 1 || [row.rect.x,row.rect.y].every(v => Math.abs(v - Math.round(v)) <= .025);
        rows.push(row);
        await fs.mkdir(out, { recursive: true });
        await fs.writeFile(path.join(out, `checker-${gridId}-${width}x${height}-dpr${dpr}.png`), bytes);
        assert.deepEqual(row.center, { x: 640, y: 360 }); assert.equal(row.barTap, null);
      }
    } finally { await context.close(); }
  }
  await fs.writeFile(path.join(out, 'raster-manifest.json'), JSON.stringify({ rows }, null, 2));
  if (enforce) for (const row of rows) {
    assert.ok(row.aligned, `fractional Integer origin: ${JSON.stringify(row)}`);
    assert.equal(row.mismatches, 0, `checker grid/boundary: ${JSON.stringify(row)}`);
  }
  return rows;
}
