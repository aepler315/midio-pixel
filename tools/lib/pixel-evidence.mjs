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

// Self-contained for page.evaluate. (Palette membership checks went with the
// Palette look.)
// on opaque pre-encode buffers, never on lossy decoded RGB.
export async function inspectPixelFrame() {
  if(!window.__SMW?.renderer?.getCaptureSource())throw new Error('pixel evidence requires a completed capture');
  const {fitPixelRect}=await import('/src/render/PixelPresentation.js');
  // No await from capture acquisition through the final raster/metadata snapshot.
  const smw = window.__SMW;
  const capture = smw.renderer?.getCaptureSource();
  if (!capture) throw new Error('pixel evidence requires a completed capture');
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
  return { width:canvas.width,height:canvas.height,colors:colors.size,litFraction:lit/(px.length/4),mean:sum/(px.length/4*3),opaque,
    captureReady:true,grid:capture.grid,placement,barPixels,barErrors,thumbnail:[...ctx.getImageData(0,0,64,36).data],presentation:smw.presentationDiagnostics,backend:smw.rangeState,
    timeMs:smw.sim.timeMs,seed:smw.songSeed,dpr:devicePixelRatio,requested:smw.displayPrefs,
    fps:{requested:Number(document.querySelector('#stageFps')?.value),measured:smw.frameRates},png:canvas.toDataURL('image/png').split(',')[1] };
}
