import assert from 'node:assert/strict';

// These checks establish content/geometry, not an artistic quality verdict.
export function assertMeaningfulFrame(frame, {requireOpaque=true}={}) {
  const {colors,litFraction,mean,opaque}=frame;
  assert.ok((!requireOpaque || frame.opaque) && frame.colors >= 8 && frame.litFraction > .12 && frame.mean > 8,
    `blank or insufficient scene content: ${JSON.stringify({colors,litFraction,mean,opaque})}`);
}
export function assertTemporalChange(thumbnails) {
  assert.ok(thumbnails.length >= 2, 'need a controlled temporal sequence');
  const first = thumbnails[0];
  assert.ok(thumbnails.slice(1).some(next => next.length === first.length && next.some((v,i) => Math.abs(v-first[i]) > 8)),
    'frozen controlled temporal sequence');
}

// Self-contained for page.evaluate. Exact palette membership is tested only
// on opaque pre-encode buffers, never on lossy decoded RGB.
export async function inspectPixelFrame({ paletteId = 'none' } = {}) {
  if(!window.__SMW?.renderer?.getCaptureSource())throw new Error('pixel evidence requires a completed capture');
  const [{fitPixelRect},{PALETTES,resolvePaletteId}]=await Promise.all([import('/src/render/PixelPresentation.js'),import('/src/render/PaletteCatalog.js')]);
  // No await from capture acquisition through the final raster/metadata snapshot.
  const smw = window.__SMW;
  const capture = smw.renderer?.getCaptureSource();
  if (!capture) throw new Error('pixel evidence requires a completed capture');
  const expectedPalette = paletteId;
  paletteId = capture.paletteId ?? smw.presentationDiagnostics?.effectivePalette ?? resolvePaletteId(paletteId, smw.sim?.biomes?.world?.kind);
  if (expectedPalette !== 'none' && paletteId !== resolvePaletteId(expectedPalette, capture.worldKind ?? smw.sim?.biomes?.world?.kind)) throw new Error('completed frame does not use the expected palette');
  const canvas = document.querySelector('#stage');
  const px = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  const colors = new Set(); let lit = 0, sum = 0, opaque = true;
  for (let i=0;i<px.length;i+=4) {
    colors.add(`${px[i]},${px[i+1]},${px[i+2]}`);
    const brightness = px[i]+px[i+1]+px[i+2]; sum += brightness;
    if (brightness > 24) lit++; if (px[i+3] !== 255) opaque = false;
  }
  let placement, barErrors=0,barPixels=0;
  {
    const sim=smw.sim;
    placement=capture.pixelated ? fitPixelRect(capture.width,capture.height,canvas.width,canvas.height,capture.scaling)
      : fitPixelRect(sim.stageW||sim.canvasWidth||1280,sim.stageH||sim.canvasHeight||720,canvas.width,canvas.height,'fit');
    for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) {
      // Exclude only the fractional boundary pixel in Fit/sub-grid mode.
      if(x+1<=placement.x || x>=Math.ceil(placement.x+placement.width) || y+1<=placement.y || y>=Math.ceil(placement.y+placement.height)) {
        barPixels++;const i=(y*canvas.width+x)*4;
        if(px[i]||px[i+1]||px[i+2]||px[i+3]!==255)barErrors++;
      }
    }
  }
  const thumb = document.createElement('canvas'); thumb.width=64;thumb.height=36;
  const ctx=thumb.getContext('2d');ctx.drawImage(canvas,0,0,64,36);
  let paletteErrors=0, palettePixels=0;
  if (paletteId !== 'none') {
    const colors = PALETTES[paletteId]?.colors;
    if (!colors && paletteId !== 'rgb332') throw new Error('unknown completed palette');
    const allowed = colors ? new Set(colors.map(hex=>[1,3,5].map(start=>parseInt(hex.slice(start,start+2),16)).join(','))) : null;
    const source = capture.pixelCanvas || capture.canvas, raw=source.getContext('2d').getImageData(0,0,source.width,source.height).data;
    palettePixels=0;
    for(let i=0;i<raw.length;i+=4) {
      // The sky experiment is deliberately full-colour and smooth. Only
      // fully covered terrain cells have an exact palette membership.
      if (capture.hybridSky && raw[i+3] !== 255) continue;
      palettePixels++;
      if (raw[i+3] !== 255) { paletteErrors++; continue; }
      if (allowed) { if(!allowed.has(`${raw[i]},${raw[i+1]},${raw[i+2]}`))paletteErrors++; }
      else if (![0,36,73,109,146,182,219,255].includes(raw[i]) || ![0,36,73,109,146,182,219,255].includes(raw[i+1]) || ![0,85,170,255].includes(raw[i+2])) paletteErrors++;
    }
    if (!palettePixels) throw new Error('palette evidence requires nonempty covered terrain');
  }
  return { width:canvas.width,height:canvas.height,colors:colors.size,litFraction:lit/(px.length/4),mean:sum/(px.length/4*3),opaque,
    captureReady:true,grid:capture.grid,paletteId,placement,barPixels,barErrors,palettePixels,paletteErrors,thumbnail:[...ctx.getImageData(0,0,64,36).data],presentation:smw.presentationDiagnostics,backend:smw.rangeState,
    timeMs:smw.sim.timeMs,seed:smw.songSeed,dpr:devicePixelRatio,requested:smw.displayPrefs,
    fps:{requested:Number(document.querySelector('#stageFps')?.value),measured:smw.frameRates},png:canvas.toDataURL('image/png').split(',')[1] };
}
